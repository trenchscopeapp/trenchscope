// @dexterm/data — on-disk coin-image cache (task-1326). Lives under the app data dir (next to dexterm.db):
// `<dir>/images/<sha256(url)[0..31]>.png` holds OUR re-encoded thumbnail (never the bytes the host sent),
// so nothing downstream — the popup page, a future export — ever parses third-party image data. A
// `.fail` marker remembers a refused/undecodable URL for a while so a dead IPFS link is not retried on
// every launch. LRU by file mtime: a hit touches the file; when the directory grows past `maxBytes` the
// oldest files go. Every filesystem failure is swallowed (a cache must never break the app).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, utimesSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export interface ImageCacheOptions {
  dir: string;
  /** Total bytes kept on disk (default 32 MiB). */
  maxBytes?: number;
  /** How long a failure marker suppresses refetching (default 6 h). */
  failTtlMs?: number;
  now?: () => number;
}

export interface CacheStats { files: number; bytes: number; hits: number; misses: number; writes: number; evictions: number }

export function imageCacheKey(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

export class ImageDiskCache {
  readonly dir: string;
  private readonly maxBytes: number;
  private readonly failTtlMs: number;
  private readonly now: () => number;
  private ready = false;
  private lastTouch = new Map<string, number>();
  readonly stats: CacheStats = { files: 0, bytes: 0, hits: 0, misses: 0, writes: 0, evictions: 0 };

  constructor(opts: ImageCacheOptions) {
    this.dir = opts.dir;
    this.maxBytes = opts.maxBytes ?? 32 * 1024 * 1024;
    this.failTtlMs = opts.failTtlMs ?? 6 * 3_600_000;
    this.now = opts.now ?? (() => Date.now());
  }

  private ensure(): boolean {
    if (this.ready) return true;
    try { mkdirSync(this.dir, { recursive: true, mode: 0o700 }); this.ready = true; } catch { /* unwritable: cache off */ }
    return this.ready;
  }

  private pathFor(key: string, ext: 'png' | 'fail'): string { return join(this.dir, `${key}.${ext}`); }

  /** Our stored thumbnail PNG for a URL key, or null. Touches the file (LRU). */
  get(key: string): Buffer | null {
    if (!this.ensure()) return null;
    try {
      const p = this.pathFor(key, 'png');
      const buf = readFileSync(p);
      this.stats.hits += 1;
      const t = this.now();
      if ((this.lastTouch.get(key) ?? 0) + 600_000 < t) {
        this.lastTouch.set(key, t);
        try { utimesSync(p, new Date(t), new Date(t)); } catch { /* read-only fs: LRU just degrades */ }
      }
      return buf;
    } catch {
      this.stats.misses += 1;
      return null;
    }
  }

  /** True when a failure marker younger than failTtl exists for this key (the marker carries its own timestamp). */
  failed(key: string): boolean {
    if (!this.ensure()) return false;
    try {
      const text = readFileSync(this.pathFor(key, 'fail'), 'utf8');
      const at = Number(text.split('\n')[0]);
      return Number.isFinite(at) && this.now() - at < this.failTtlMs;
    } catch { return false; }
  }

  markFailed(key: string, reason: string): void {
    if (!this.ensure()) return;
    try { writeFileSync(this.pathFor(key, 'fail'), `${this.now()}\n${reason.slice(0, 200)}`, { mode: 0o600 }); } catch { /* ignore */ }
  }

  /** Store our PNG thumbnail (atomic rename), then evict the oldest files past the byte cap. */
  put(key: string, png: Uint8Array): void {
    if (!this.ensure()) return;
    try {
      const p = this.pathFor(key, 'png');
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, png, { mode: 0o600 });
      renameSync(tmp, p);
      try { const t = new Date(this.now()); utimesSync(p, t, t); } catch { /* LRU just degrades */ }
      try { unlinkSync(this.pathFor(key, 'fail')); } catch { /* no marker */ }
      this.stats.writes += 1;
      this.lastTouch.set(key, this.now());
      this.evict();
    } catch { /* ignore */ }
  }

  /** Drop oldest files until the directory is under the cap. Also measures the directory. */
  evict(): void {
    let entries: Array<{ name: string; size: number; mtime: number }> = [];
    try {
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.png') && !name.endsWith('.fail')) continue;
        try { const st = statSync(join(this.dir, name)); entries.push({ name, size: st.size, mtime: st.mtimeMs }); } catch { /* vanished */ }
      }
    } catch { return; }
    let total = entries.reduce((s, e) => s + e.size, 0);
    this.stats.files = entries.length;
    if (total > this.maxBytes) {
      entries = entries.sort((a, b) => a.mtime - b.mtime);
      for (const e of entries) {
        if (total <= this.maxBytes * 0.9) break;
        try { unlinkSync(join(this.dir, e.name)); total -= e.size; this.stats.evictions += 1; this.stats.files -= 1; } catch { /* ignore */ }
      }
    }
    this.stats.bytes = total;
  }
}
