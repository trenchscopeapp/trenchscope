// @dexterm/tui — sound cues (task-1340, ported from prototype-v2/src/sound.mjs, task-1291). Synthesized locally
// into tiny 16-bit mono WAV files on first use (~/.dexterm/sounds, DEXTERM_HOME overrides) and played with the
// OS player (`afplay` on macOS, `paplay`/`aplay` on Linux) in a DETACHED child: never blocks the render loop,
// never waits. MUTED by default; `--sound` (or DEXTERM_SOUND=1) turns the cues on. Cues only ever follow a
// SETTLED outcome (playMoment is called with the same moment fireMoment produced): nothing chirps on a quote.
//
// Cues (all short, all quiet, none mocking):
//   buy      up-chirp         sine sweep 440→880 Hz, 140 ms
//   sell     down-sweep       sine sweep 880→440 Hz, 160 ms
//   profit   chime            E5 + B5 with a soft 2nd harmonic, 420 ms
//   loss     thud             low sine 110→50 Hz + brief noise, 200 ms
//   error    buzz             120 Hz square-ish with 25 Hz amplitude modulation, 220 ms
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MomentKind, Milestone } from './fx-trade.ts';

const RATE = 22050;
export type CueName = 'buy' | 'sell' | 'profit' | 'loss' | 'error';
export const CUES: CueName[] = ['buy', 'sell', 'profit', 'loss', 'error'];

export interface SoundState { on: boolean }

/** Where the cue files live: `$DEXTERM_HOME/sounds`, default `~/.dexterm/sounds`. */
export function soundDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.DEXTERM_HOME && env.DEXTERM_HOME.trim() ? env.DEXTERM_HOME : join(homedir(), '.dexterm'), 'sounds');
}

/** `--sound` or DEXTERM_SOUND=1 turns cues on; everything else is muted. */
export function soundOn(flag: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (flag) return true;
  const e = (env.DEXTERM_SOUND ?? '').trim().toLowerCase();
  return e === '1' || e === 'true' || e === 'on';
}

function env(i: number, n: number, attack = 0.01, release = 0.4): number {
  const t = i / n;
  const a = Math.min(1, (i / RATE) / attack);
  const r = t > 1 - release ? (1 - t) / release : 1;
  return a * r;
}

/** Synthesize one cue as float samples in [-1, 1], peak-normalised to −6 dBFS. */
export function synth(name: CueName): Float32Array {
  const dur = { buy: 0.14, sell: 0.16, profit: 0.42, loss: 0.2, error: 0.22 }[name];
  const n = Math.floor(RATE * dur);
  const out = new Float32Array(n);
  let ph = 0, ph2 = 0;
  let seed = 12345;
  const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  for (let i = 0; i < n; i++) {
    const t = i / RATE, u = i / n;
    let s = 0;
    if (name === 'buy') { const f = 440 * Math.pow(2, u); ph += 2 * Math.PI * f / RATE; s = Math.sin(ph) * 0.8 + Math.sin(2 * ph) * 0.15; s *= env(i, n, 0.005, 0.5); }
    else if (name === 'sell') { const f = 880 * Math.pow(0.5, u); ph += 2 * Math.PI * f / RATE; s = Math.sin(ph) * 0.8 + Math.sin(2 * ph) * 0.1; s *= env(i, n, 0.005, 0.5); }
    else if (name === 'profit') {
      ph += 2 * Math.PI * 659.25 / RATE; ph2 += 2 * Math.PI * 987.77 / RATE;
      const second = t > 0.09 ? 1 : 0;
      s = (Math.sin(ph) * 0.6 + Math.sin(2 * ph) * 0.12) * Math.exp(-t * 6) + second * (Math.sin(ph2) * 0.6 + Math.sin(2 * ph2) * 0.1) * Math.exp(-(t - 0.09) * 5);
      s *= env(i, n, 0.004, 0.25);
    }
    else if (name === 'loss') { const f = 110 * Math.pow(50 / 110, u); ph += 2 * Math.PI * f / RATE; s = Math.sin(ph) * 0.9 * Math.exp(-t * 9) + noise() * 0.12 * Math.exp(-t * 40); s *= env(i, n, 0.003, 0.3); }
    else { ph += 2 * Math.PI * 120 / RATE; const sq = Math.tanh(Math.sin(ph) * 3) * 0.5; const am = 0.55 + 0.45 * Math.sin(2 * Math.PI * 25 * t); s = sq * am * env(i, n, 0.004, 0.2); }
    out[i] = s;
  }
  let peak = 0;
  for (const x of out) peak = Math.max(peak, Math.abs(x));
  const g = peak > 0 ? 0.5 / peak : 1;
  return out.map((x) => x * g);
}

/** 16-bit mono PCM WAV container. */
export function wav(samples: Float32Array): Buffer {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}

/** Write every cue to `dir` (created). Idempotent; ~30 KB total. Returns the paths. */
export function writeCues(dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  for (const name of CUES) { const p = join(dir, `${name}.wav`); if (!existsSync(p)) writeFileSync(p, wav(synth(name))); out.push(p); }
  return out;
}

/** The OS player for this platform (null = no known player → cues are silently skipped). */
export function defaultPlayer(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'darwin') return 'afplay';
  if (platform === 'linux') return 'paplay';
  return null;
}

export interface PlayOptions {
  player?: string | null;
  dir?: string;
  /** Test seam: records dispatched cues instead of spawning. */
  log?: Array<{ name: CueName; at: number }>;
  spawnFn?: typeof spawn;
}

/** Non-blocking playback. Returns true when a cue was dispatched (false when muted / no player / no file). */
export function play(name: CueName, sound: SoundState | null | undefined, opts: PlayOptions = {}): boolean {
  if (!sound || !sound.on) return false;
  const dir = opts.dir ?? soundDir();
  const player = opts.player === undefined ? defaultPlayer() : opts.player;
  if (opts.log) { opts.log.push({ name, at: Date.now() }); return true; }
  if (!player) return false;
  try {
    writeCues(dir);
    const file = join(dir, `${name}.wav`);
    const child = (opts.spawnFn ?? spawn)(player, [file], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

/** Which cues a settled moment plays (sell sweep, then the verdict cue 150 ms later). Inflight plays nothing. */
export function cuesFor(kind: MomentKind, milestone: Milestone = null): Array<[CueName, number]> {
  if (kind === 'buy') return milestone === 'first' ? [['buy', 0], ['profit', 180]] : [['buy', 0]];
  if (kind === 'profit') return [['sell', 0], ['profit', 150]];
  if (kind === 'loss') return [['sell', 0], ['loss', 150]];
  if (kind === 'failed') return [['error', 0]];
  if (kind === 'runner') return [['profit', 0]];
  return [];
}

export function playMoment(kind: MomentKind, milestone: Milestone, sound: SoundState | null | undefined, opts: PlayOptions = {}): number {
  let n = 0;
  for (const [name, delay] of cuesFor(kind, milestone)) {
    n += 1;
    if (delay) { const tm = setTimeout(() => play(name, sound, opts), delay); (tm as { unref?: () => void }).unref?.(); }
    else play(name, sound, opts);
  }
  return n;
}
