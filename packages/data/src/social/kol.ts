// @dexterm/data — KOL lists (task-1330; design §5.4): the user's own lists (lane I-02 will fill
// `own-x-list` from `list.read`), manual handles, and signed packs. A pack carries HANDLES (and optional
// wallet addresses with evidence links), never posts; it grants membership, never credibility. Lists
// persist in the shared SQLite cache (one --db controls everything) under the `social:kol` namespace.
//
// Pack format (task-1288 pack conventions, narrowed to one content kind):
//   <dir>/pack.json      { name, version, publisher, kind: "kol-list", handles: [{ handle, wallet?, evidence? }] }
//   <dir>/pack.lock      { files: { "pack.json": "<sha256 hex>" }, hash: "<sha256 hex of the files listing>" }
//   <dir>/pack.lock.sig  optional `ssh-keygen -Y sign -n dexterm-pack` signature over pack.lock
// Trust: `signed.verified` is true only when the signature verifies against the user's pinned
// ~/.dexterm/allowed_signers; a tampered hash is refused outright (never imported as "unsigned").

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Cache } from '../cache.ts';
import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import type { KolList, KolListSource } from './model.ts';

export const KOL_NS = 'social:kol';
const FOREVER_MS = 10 * 365 * 86_400_000;
export const PACK_MAX_HANDLES = 500;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface PackHandle { handle: string; wallet?: string; evidence?: string }
export interface PackManifest { name: string; version: string; publisher: string; kind: 'kol-list'; handles: PackHandle[]; note?: string }
export interface PackLock { files: Record<string, string>; hash: string }

export type SignatureVerifier = (lockBytes: Buffer, signature: string, publisher: string) => boolean;

export interface KolStoreOptions {
  cache: Cache;
  clock?: Clock;
  /** Signature verifier for packs; default shells out to `ssh-keygen -Y verify` when `allowedSigners` exists. */
  verify?: SignatureVerifier;
  /** Path of the pinned allowed_signers file (default: none → packs are at most `unsigned`). */
  allowedSigners?: string | null;
}

export function normalizeHandle(h: string): string {
  return h.trim().replace(/^@/, '').toLowerCase();
}

export function isValidHandle(h: string): boolean {
  return HANDLE_RE.test(normalizeHandle(h));
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The lock's `hash` is the sha256 of the sorted `name=sha\n` listing. */
export function packHash(files: Record<string, string>): string {
  const listing = Object.keys(files).sort().map((k) => `${k}=${files[k]}\n`).join('');
  return sha256Hex(listing);
}

/** `ssh-keygen -Y verify` against a pinned allowed_signers file. False on any failure, never throws. */
export function sshKeygenVerifier(allowedSigners: string): SignatureVerifier {
  return (lockBytes, signature, publisher) => {
    try {
      if (!existsSync(allowedSigners)) return false;
      const sigPath = join(process.env.TMPDIR ?? '/tmp', `dexterm-pack-${process.pid}-${Date.now()}.sig`);
      // ssh-keygen wants the signature in a file; the message goes on stdin.
      writeFileSync(sigPath, signature);
      try {
        const r = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', allowedSigners, '-I', publisher, '-n', 'dexterm-pack', '-s', sigPath], { input: lockBytes, timeout: 5000 });
        return r.status === 0;
      } finally {
        try { unlinkSync(sigPath); } catch { /* ignore */ }
      }
    } catch {
      return false;
    }
  };
}

export class PackError extends Error {
  constructor(message: string) { super(message); this.name = 'PackError'; }
}

/** Parse + validate a pack directory. Throws PackError on any shape/hash problem; never imports a tampered pack. */
export function readPack(dir: string, verify?: SignatureVerifier): { manifest: PackManifest; lock: PackLock; signed: boolean; verified: boolean } {
  const manifestPath = join(dir, 'pack.json');
  const lockPath = join(dir, 'pack.lock');
  if (!existsSync(manifestPath)) throw new PackError('pack.json missing');
  if (!existsSync(lockPath)) throw new PackError('pack.lock missing (unlocked packs are refused)');
  const manifestBytes = readFileSync(manifestPath);
  const lockBytes = readFileSync(lockPath);
  let lock: PackLock;
  try { lock = JSON.parse(lockBytes.toString('utf8')) as PackLock; } catch { throw new PackError('pack.lock is not JSON'); }
  if (!lock || typeof lock !== 'object' || !lock.files || typeof lock.files !== 'object' || typeof lock.hash !== 'string') throw new PackError('pack.lock shape');
  for (const k of Object.keys(lock.files)) if (PROTO_KEYS.has(k) || k.includes('/') || k.includes('\\') || k.startsWith('.')) throw new PackError(`pack.lock lists a forbidden path: ${k}`);
  const want = lock.files['pack.json'];
  if (!want || sha256Hex(manifestBytes) !== want.toLowerCase()) throw new PackError('pack.json does not match pack.lock (tampered or stale)');
  if (packHash(lock.files) !== lock.hash.toLowerCase()) throw new PackError('pack.lock hash does not match its file listing');
  let manifest: PackManifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')) as PackManifest; } catch { throw new PackError('pack.json is not JSON'); }
  if (!manifest || typeof manifest !== 'object') throw new PackError('pack.json shape');
  if (manifest.kind !== 'kol-list') throw new PackError(`pack kind ${JSON.stringify(manifest.kind)} is not kol-list`);
  for (const k of ['name', 'version', 'publisher'] as const) if (typeof manifest[k] !== 'string' || !manifest[k].trim() || manifest[k].length > 80) throw new PackError(`pack.json ${k}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(manifest.name)) throw new PackError('pack name');
  if (!Array.isArray(manifest.handles)) throw new PackError('pack.json handles must be an array');
  if (manifest.handles.length === 0) throw new PackError('pack has no handles');
  if (manifest.handles.length > PACK_MAX_HANDLES) throw new PackError(`pack has ${manifest.handles.length} handles (max ${PACK_MAX_HANDLES})`);
  for (const h of manifest.handles) {
    if (!h || typeof h !== 'object' || typeof h.handle !== 'string' || !isValidHandle(h.handle)) throw new PackError(`bad handle entry ${JSON.stringify(h?.handle ?? h).slice(0, 40)}`);
    if (h.wallet !== undefined && (typeof h.wallet !== 'string' || !BASE58_RE.test(h.wallet))) throw new PackError(`bad wallet for @${h.handle}`);
    if (h.evidence !== undefined && (typeof h.evidence !== 'string' || !/^https?:\/\//.test(h.evidence) || h.evidence.length > 300)) throw new PackError(`bad evidence link for @${h.handle}`);
  }
  const sigPath = join(dir, 'pack.lock.sig');
  const signed = existsSync(sigPath);
  const verified = signed && !!verify && verify(lockBytes, readFileSync(sigPath, 'utf8'), manifest.publisher);
  return { manifest, lock, signed, verified };
}

export class KolStore {
  private readonly cache: Cache;
  private readonly clock: Clock;
  private readonly verify: SignatureVerifier | undefined;
  private lists: KolList[];
  private mutedSet: Set<string>;

  constructor(opts: KolStoreOptions) {
    this.cache = opts.cache;
    this.clock = opts.clock ?? systemClock;
    this.verify = opts.verify ?? (opts.allowedSigners ? sshKeygenVerifier(opts.allowedSigners) : undefined);
    this.lists = this.cache.get<KolList[]>(KOL_NS, 'lists')?.value ?? [];
    this.mutedSet = new Set(this.cache.get<string[]>(KOL_NS, 'muted')?.value ?? []);
  }

  private save(): void {
    this.cache.set(KOL_NS, 'lists', this.lists, { ttlMs: FOREVER_MS });
    this.cache.set(KOL_NS, 'muted', [...this.mutedSet], { ttlMs: FOREVER_MS });
  }

  all(): KolList[] { return this.lists.map((l) => ({ ...l, handles: [...l.handles], wallets: [...l.wallets] })); }
  get(id: string): KolList | undefined { return this.lists.find((l) => l.id === id); }
  muted(): string[] { return [...this.mutedSet].sort(); }
  isMuted(handle: string): boolean { return this.mutedSet.has(normalizeHandle(handle)); }

  /** Create a manual list (or return the existing one by name). */
  create(name: string, source: KolListSource = 'manual'): KolList {
    const id = `${source}:${name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 64)}`;
    const existing = this.lists.find((l) => l.id === id);
    if (existing) return existing;
    const list: KolList = { id, name: name.trim().slice(0, 80), source, handles: [], wallets: [], signed: null, since: this.clock.now(), enabled: true, tier: source === 'pack' ? 'kol-b' : 'kol-a' };
    this.lists.push(list);
    this.save();
    return list;
  }

  remove(id: string): boolean {
    const n = this.lists.length;
    this.lists = this.lists.filter((l) => l.id !== id);
    if (this.lists.length !== n) this.save();
    return this.lists.length !== n;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const l = this.get(id);
    if (!l) return false;
    l.enabled = enabled;
    this.save();
    return true;
  }

  addHandle(id: string, handle: string): { ok: boolean; reason?: string } {
    const l = this.get(id);
    if (!l) return { ok: false, reason: 'no such list' };
    if (l.source === 'pack') return { ok: false, reason: 'packs are read-only (edit the pack and re-import)' };
    const h = normalizeHandle(handle);
    if (!isValidHandle(h)) return { ok: false, reason: 'handle must be 1-15 letters, digits or _' };
    if (l.handles.includes(h)) return { ok: false, reason: `@${h} already in ${l.name}` };
    if (l.handles.length >= PACK_MAX_HANDLES) return { ok: false, reason: `list is full (${PACK_MAX_HANDLES})` };
    l.handles.push(h);
    this.save();
    return { ok: true };
  }

  removeHandle(id: string, handle: string): boolean {
    const l = this.get(id);
    if (!l) return false;
    const h = normalizeHandle(handle);
    const n = l.handles.length;
    l.handles = l.handles.filter((x) => x !== h);
    if (l.handles.length !== n) this.save();
    return l.handles.length !== n;
  }

  mute(handle: string): void { const h = normalizeHandle(handle); if (isValidHandle(h)) { this.mutedSet.add(h); this.save(); } }
  unmute(handle: string): void { this.mutedSet.delete(normalizeHandle(handle)); this.save(); }

  /** Seed a fully-formed list (fixtures/demos and tests only; the app path is create()/importPack()). */
  seed(list: KolList): void {
    this.lists = this.lists.filter((l) => l.id !== list.id);
    this.lists.push({ ...list, handles: list.handles.map(normalizeHandle), wallets: [...list.wallets] });
    this.save();
  }

  /** Import a pack directory as a `pack` list (replacing a previous import of the same pack name). */
  importPack(dir: string): KolList {
    const { manifest, lock, signed, verified } = readPack(dir, this.verify);
    const id = `pack:${manifest.name.toLowerCase()}`;
    const handles = [...new Set(manifest.handles.map((h) => normalizeHandle(h.handle)))];
    const wallets = [...new Set(manifest.handles.map((h) => h.wallet).filter((w): w is string => !!w))];
    const list: KolList = {
      id, name: `${manifest.name}@${manifest.version}`, source: 'pack', handles, wallets,
      signed: { publisher: manifest.publisher, hash: lock.hash.toLowerCase(), verified },
      since: this.clock.now(), enabled: true,
      // A verified signature from a pinned publisher counts like the user's own list; unsigned packs stay kol-b.
      tier: signed && verified ? 'kol-a' : 'kol-b',
    };
    this.lists = this.lists.filter((l) => l.id !== id);
    this.lists.push(list);
    this.save();
    return list;
  }

  /** `kol-a` / `kol-b` for a handle on an enabled, unmuted list (own lists and verified packs win), else null. */
  tierOf(handle: string): 'kol-a' | 'kol-b' | null {
    const h = normalizeHandle(handle);
    if (this.mutedSet.has(h)) return null;
    let best: 'kol-a' | 'kol-b' | null = null;
    for (const l of this.lists) {
      if (!l.enabled || !l.handles.includes(h)) continue;
      if (l.tier === 'kol-a') return 'kol-a';
      best = 'kol-b';
    }
    return best;
  }

  /** Every handle that counts for the trending feed (enabled lists, muted removed), lower-cased. */
  kolHandles(): Set<string> {
    const out = new Set<string>();
    for (const l of this.lists) if (l.enabled) for (const h of l.handles) if (!this.mutedSet.has(h)) out.add(h);
    return out;
  }

  /** `own(3) · pack "sol-alpha" (41, signed)` style footer summary. */
  summary(): string {
    const own = this.lists.filter((l) => l.source !== 'pack');
    const packs = this.lists.filter((l) => l.source === 'pack');
    const parts: string[] = [];
    if (own.length) parts.push(`own(${own.reduce((s, l) => s + l.handles.length, 0)})`);
    for (const p of packs) parts.push(`pack "${p.name}" (${p.handles.length}, ${p.signed?.verified ? 'signed' : 'unsigned'}${p.enabled ? '' : ', off'})`);
    if (this.mutedSet.size) parts.push(`muted ${this.mutedSet.size}`);
    return parts.length ? parts.join(' · ') : 'no KOL lists';
  }
}
