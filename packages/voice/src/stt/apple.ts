// Apple Speech STT engine (task-1282). On-device SFSpeechRecognizer via a tiny Swift helper compiled
// on the fly with `swiftc` — no key, no network, streaming partials (the spike's recommended primary
// engine). The compiled helper is cached under ~/.dexterm/voice-helper; it is rebuilt only when the
// source hash changes.
//
// LIVE CAVEAT (disclosed in the handoff): this path needs macOS Speech + Microphone authorization,
// which can only be granted at the Mac by a person the first time it runs. available() reports whether
// swiftc is present and the helper compiles; it cannot assert that TCC authorization will be granted.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SttEngine, SttResult, SttSession } from '../types.ts';
import { APPLE_HELPER_SWIFT } from './apple-helper.swift.ts';

const CACHE_DIR = process.env.DEXTERM_VOICE_HELPER_DIR || join(homedir(), '.dexterm', 'voice-helper');
const SRC = join(CACHE_DIR, 'recognize.swift');
const BIN = join(CACHE_DIR, 'recognize');
const SWIFTC = process.env.DEXTERM_SWIFTC || 'swiftc';

function which(bin: string): boolean {
  if (bin.includes('/')) return existsSync(bin);
  for (const p of (process.env.PATH ?? '').split(':')) if (p && existsSync(join(p, bin))) return true;
  return false;
}

/** Compile the helper if the cached binary is missing or older than the current source. Returns BIN or null. */
export function ensureHelper(): string | null {
  if (!which(SWIFTC)) return null;
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const hash = createHash('sha256').update(APPLE_HELPER_SWIFT).digest('hex');
    const stamp = join(CACHE_DIR, '.srchash');
    const fresh = existsSync(BIN) && existsSync(stamp) && readFileSync(stamp, 'utf8') === hash && statSync(BIN).size > 0;
    if (fresh) return BIN;
    writeFileSync(SRC, APPLE_HELPER_SWIFT);
    const r = compileSync(SRC, BIN);
    if (!r) return null;
    writeFileSync(stamp, hash);
    return BIN;
  } catch { return null; }
}

function compileSync(src: string, out: string): boolean {
  // The compile is a one-time cost (cached by source hash); doing it synchronously keeps ensureHelper
  // simple. It is only reached from available() / listen(), both already async from the caller's view.
  try {
    execFileSync(SWIFTC, ['-O', '-o', out, src], { timeout: 60_000, stdio: 'ignore' });
    return existsSync(out);
  } catch { return false; }
}

export class AppleStt implements SttEngine {
  readonly name = 'apple';
  readonly label = 'Apple Speech (on-device, no key)';

  async available(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    if (!which(SWIFTC)) return false;
    return ensureHelper() !== null;
  }

  async listen(): Promise<SttSession> {
    const bin = ensureHelper();
    if (!bin) throw new Error('Apple Speech helper unavailable (need swiftc)');
    const t0 = Date.now();
    const child: ChildProcess = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let partial = '';
    let firstPartialMs: number | null = null;
    let finalText: string | null = null;
    let finalConfidence = 1;
    let err = '';
    let buf = '';
    let readySeen = false;
    let readyResolve: (() => void) | null = null;
    const ready = new Promise<void>((r) => { readyResolve = r; });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'partial' && typeof ev.text === 'string') { partial = ev.text; if (firstPartialMs === null && ev.text) firstPartialMs = Date.now() - t0; }
        else if (ev.type === 'final') { finalText = String(ev.text ?? partial); if (typeof ev.confidence === 'number') finalConfidence = ev.confidence; }
        else if (ev.type === 'ready') { readySeen = true; readyResolve?.(); }
        else if (ev.type === 'error') { err = String(ev.message ?? 'speech error'); readyResolve?.(); }
      }
    });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });

    let closed = false;
    let spawnError: Error | null = null;
    const settled = new Promise<void>((resolve) => {
      child.on('close', () => { closed = true; readyResolve?.(); resolve(); });
      // A failed spawn (EACCES / ENOENT / EAGAIN) must never become an uncaughtException that takes the
      // whole terminal down (task-1339, re-verify N5): record it so stop() rejects cleanly instead.
      child.on('error', (e: Error) => { spawnError = e; closed = true; if (!err) err = `mic helper failed to start: ${e.message}`; readyResolve?.(); resolve(); });
    });
    // Spawn failures surface on the next tick: give them one turn so listen() rejects (the controller
    // then says "mic/STT could not start") rather than reporting a mic that was never open.
    await new Promise<void>((r) => setImmediate(r));
    if (spawnError) throw new Error(err || `mic helper failed to start: ${(spawnError as Error).message}`);

    // Force-terminate the helper so the mic process can never outlive the session (task-1282 rework D5).
    const kill = (): void => {
      if (closed) return;
      try { child.kill('SIGINT'); } catch { /* ignore */ }
      // If SIGINT did not land promptly, escalate so the OS mic indicator can never be left on.
      setTimeout(() => { if (!closed) { try { child.kill('SIGKILL'); } catch { /* ignore */ } } }, 500).unref?.();
    };

    // The helper authorizes, loads the on-device model and opens the audio engine before it emits
    // `ready`. Reporting "listening" earlier let the user talk (and press stop) into a mic that was not
    // open yet: an empty transcript and a silent no-op. Wait for it (bounded; first run after a
    // permission prompt can take a few seconds).
    await Promise.race([ready, new Promise<void>((r) => setTimeout(r, 10_000))]);
    if (closed || !readySeen) {
      kill();
      throw new Error(err || (closed ? 'mic helper exited before it was ready' : 'mic helper did not become ready in 10 s (check System Settings > Privacy > Microphone / Speech Recognition for your terminal)'));
    }

    return {
      stop: async (): Promise<SttResult> => {
        try { child.stdin?.write('stop\n'); child.stdin?.end(); } catch { /* ignore */ }
        await Promise.race([settled, new Promise<void>((r) => setTimeout(r, 5000))]);
        if (!closed) kill(); // the helper ignored `stop` within 3 s: kill it rather than orphan the mic
        const text = (finalText ?? partial).trim();
        if (!text && err) throw new Error(err);
        return { text, confidence: text ? finalConfidence : 0, firstPartialMs, speakerCount: 1 };
      },
      cancel: () => { kill(); },
    };
  }
}
