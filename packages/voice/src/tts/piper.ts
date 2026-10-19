// Piper neural TTS engine (task-1408, task-1416). Piper is a free, local, no-key neural text-to-speech
// engine (rhasspy/piper, MIT) that sounds markedly better than espeak-ng or the built-in macOS voices.
// It is the PREFERRED speech-out engine EVERYWHERE it is installed — on macOS (via the managed Python
// runtime, `trenchscope voice setup`) as well as off macOS (via the prebuilt binary) — with `say`/espeak-ng
// kept as the fallback chain (see engines.ts). Verified in Docker on Linux (task-1397/task-1408) and via
// the managed venv on an Intel Mac (task-1416): the en_GB-alan-medium voice writes a valid, non-silent
// 22.05 kHz WAV that whisper.cpp transcribes almost word-for-word.
//
// Two runtimes, one engine:
//   - macOS (managed): a private virtualenv at `~/.dexterm/piper/venv` with `pip install piper-tts`. The
//     prebuilt macOS tarball from rhasspy is broken (it needs a libespeak-ng dylib it does not bundle),
//     so we run `<venv>/bin/python -m piper` instead. Built by `trenchscope voice setup`.
//   - Linux/Windows: the prebuilt `piper` binary extracted into `~/.dexterm/piper/` (or on PATH).
//
// It carries the SAME contract as the macOS `say` and espeak engines:
//   - text is SANITISED (sanitizeSpeech strips `[[…]]`, control chars, a leading `-`, caps length)
//   - text is delivered on STDIN, never as an argv word
//   - a new speak() cleanly INTERRUPTS the current one — one queue, never two voices at once
//   - the voice is fixed by the downloaded MODEL, never by a macOS voice name (so config.voice.name,
//     which on a Mac is e.g. "Eddy (English (UK))", is NEVER passed verbatim to Piper)
//
// Latency (task-1416): loading the 63 MB model into onnxruntime dominates first-audio (~1.4–4 s cold,
// load-dependent), so we keep a pre-warmed STANDBY process that has already loaded the model and primed
// onnxruntime. speak() ADOPTS the standby, feeds it the reply SENTENCE BY SENTENCE (each line is a
// separate utterance → a separate WAV), plays those WAVs in order as they land, and spawns a fresh
// standby in the background for the next reply. So the first word starts ~0.3–0.5 s after an answer lands
// instead of waiting on a cold model load. stop() kills the adopted synth process AND the player.
//
// Piper has no audio output of its own: it synthesises WAVs, which we play through the platform player
// (afplay on macOS; aplay / paplay / ffplay off macOS — detected and reported by the doctor). Containers
// have no audio device, so real playback is unverified there; synthesis-to-file IS verified (synthToFile
// + whisper), and macOS playback via afplay is verified on a real Mac (task-1416).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpeakHandle, SpeakOptions, TtsEngine } from '../types.ts';
import { sanitizeSpeech } from './voices.ts';
import { splitSentences } from '../summary.ts';

/** The Piper voice trenchscope defaults to: a British male, medium quality (local, no key). */
export const DEFAULT_PIPER_VOICE = 'en_GB-alan-medium';

/** `~/.dexterm`, honouring the DEXTERM_HOME override (tests point it at a temp dir) — matches @dexterm/custom. */
function dextermHomeDir(): string {
  const h = process.env.DEXTERM_HOME;
  return h && h.trim() ? h : join(homedir(), '.dexterm');
}

/** Where the downloaded Piper voice model lives (see `trenchscope voice download piper-voice`). */
export const PIPER_MODEL = process.env.DEXTERM_PIPER_MODEL
  || join(dextermHomeDir(), 'models', `${DEFAULT_PIPER_VOICE}.onnx`);

/** The managed Python interpreter built by `trenchscope voice setup` (macOS). */
export function managedVenvPython(home: string = dextermHomeDir()): string {
  const bin = process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python');
  return join(home, 'piper', 'venv', bin);
}

/** Audio players we can hand a WAV to, best-first. afplay ships with macOS; the rest are the Linux/Windows set. */
export const PIPER_PLAYERS: readonly string[] = process.platform === 'darwin'
  ? ['afplay', 'ffplay']
  : ['aplay', 'paplay', 'ffplay'];

function which(bin: string): string | null {
  if (!bin) return null;
  if (bin.includes('/') || bin.includes('\\')) return existsSync(bin) ? bin : null;
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const p of (process.env.PATH ?? '').split(sep)) {
    if (!p) continue;
    if (existsSync(join(p, bin))) return join(p, bin);
    if (process.platform === 'win32' && existsSync(join(p, `${bin}.exe`))) return join(p, `${bin}.exe`);
  }
  return null;
}

/** How Piper is invoked here: a native binary, or `python -m piper` from the managed venv. */
export interface PiperRuntime {
  /** The executable to spawn (the piper binary, or the venv python). */
  cmd: string;
  /** Args BEFORE the piper flags (`['-m', 'piper']` for the Python runtime, `[]` for the binary). */
  prefix: string[];
  kind: 'binary' | 'python';
}

/**
 * Resolve the Piper binary (native-binary runtime only). Kept for the off-macOS doctor/status that only
 * ever ship the prebuilt binary. Looks at an explicit override, the dexterm-local install, then PATH.
 * NOTE: Debian's `apt install piper` is an UNRELATED gaming-mouse tool, so the doctor steers users to the
 * rhasspy prebuilt release rather than apt; a wrong `piper` on PATH simply fails to synth and voice
 * degrades to text (it never crashes).
 */
export function resolvePiperBin(): string | null {
  return which(process.env.DEXTERM_PIPER_BIN || '')
    || which(join(dextermHomeDir(), 'piper', 'piper'))
    || which('piper');
}

/**
 * Resolve the Piper RUNTIME for this machine, best-first:
 *   1. DEXTERM_PIPER_BIN — an explicit binary (also the test seam).
 *   2. DEXTERM_PIPER_PYTHON — an explicit `python` to run `-m piper` (test seam for the managed path).
 *   3. the managed venv python (`~/.dexterm/piper/venv/bin/python`) — built by `trenchscope voice setup`.
 *   4. the dexterm-local prebuilt binary (`~/.dexterm/piper/piper`) or `piper` on PATH.
 * Returns null when none is installed (voice degrades to the next engine, never crashes).
 */
export function resolvePiperRuntime(): PiperRuntime | null {
  const binOverride = which(process.env.DEXTERM_PIPER_BIN || '');
  if (binOverride) return { cmd: binOverride, prefix: [], kind: 'binary' };
  const pyOverride = process.env.DEXTERM_PIPER_PYTHON;
  if (pyOverride && existsSync(pyOverride)) return { cmd: pyOverride, prefix: ['-m', 'piper'], kind: 'python' };
  const venv = managedVenvPython();
  if (existsSync(venv)) return { cmd: venv, prefix: ['-m', 'piper'], kind: 'python' };
  const localBin = which(join(dextermHomeDir(), 'piper', 'piper'));
  if (localBin) return { cmd: localBin, prefix: [], kind: 'binary' };
  const pathBin = which('piper');
  if (pathBin) return { cmd: pathBin, prefix: [], kind: 'binary' };
  return null;
}

/** The player that will play Piper's WAV, or null when none is installed. */
export function pickPlayer(): string | null {
  const override = process.env.DEXTERM_AUDIO_PLAYER;
  if (override) return which(override) ? override : null;
  for (const p of PIPER_PLAYERS) if (which(p)) return p;
  return null;
}

/** Argv to play a finished WAV through the given player (quiet, exits on end, no window). */
function playerArgs(player: string, wav: string): string[] {
  const base = player.replace(/\.exe$/i, '').split(/[\\/]/).pop() ?? player;
  switch (base) {
    case 'afplay': return [wav];
    case 'ffplay': return ['-nodisp', '-autoexit', '-loglevel', 'quiet', wav];
    case 'paplay': return [wav];
    case 'aplay': default: return ['-q', wav];
  }
}

/** Map a words-per-minute rate to Piper's --length_scale (lower rate → slower → larger scale). */
function lengthScaleFor(rate: number | undefined): number | undefined {
  if (typeof rate !== 'number' || !(rate > 0)) return undefined;
  return Math.max(0.5, Math.min(2, 190 / rate));
}

/** WAV basenames in a dir, oldest-first (Piper names them by an increasing timestamp). */
function listWavs(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.wav')); } catch { return []; }
  return names.sort((a, b) => {
    try { return statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs || a.localeCompare(b); }
    catch { return a.localeCompare(b); }
  });
}

/** Sanitise, then split into one line per sentence for sentence-by-sentence streaming (never empty lines). */
function splitForSpeech(text: string): string[] {
  const safe = sanitizeSpeech(text);
  if (!safe) return [];
  const parts = splitSentences(safe).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [safe];
}

/** A pre-warmed Piper process: the model is loaded and onnxruntime primed, ready to synth on stdin. */
interface WarmProc {
  child: ChildProcess;
  dir: string;
  /** WAV basenames already accounted for (the priming utterance), so speak() never plays them. */
  seen: Set<string>;
  /** Resolves once the model has loaded (the priming WAV appeared); rejects if the process died first. */
  ready: Promise<void>;
  /** The --length_scale this process was spawned with (so a rate change respawns it). */
  scale: number | undefined;
  disposed: boolean;
  dispose(): void;
}

export class PiperTts implements TtsEngine {
  readonly name = 'piper';
  readonly label = 'Piper (neural, local, no key)';
  private model: string;

  /** The utterance currently playing. A new speak() stops it first, so there is only ever one. */
  private current: SpeakHandle | null = null;
  /** A pre-warmed process waiting to be adopted by the next speak() (task-1416 latency). */
  private standby: WarmProc | null = null;
  /** Every live warm process, so dispose() can never leak one. */
  private readonly live = new Set<WarmProc>();

  constructor(model: string = PIPER_MODEL) { this.model = model; }

  /** The voice id this engine speaks with (the model basename), for the status line. */
  get voiceName(): string { return DEFAULT_PIPER_VOICE; }

  /** True when Piper can speak ALOUD here: a runtime, the voice model and a player are all present. */
  async available(): Promise<boolean> {
    return resolvePiperRuntime() !== null && existsSync(this.model) && pickPlayer() !== null;
  }

  /** True when Piper can SYNTHESISE here (runtime + model) even with no audio device (used for the proof). */
  canSynth(): boolean {
    return resolvePiperRuntime() !== null && existsSync(this.model);
  }

  /** Piper's voice is the model; there is no per-machine installed-voice list to cycle. */
  async listVoices(): Promise<string[]> { return [DEFAULT_PIPER_VOICE]; }

  /**
   * Synthesise `text` to a WAV at `outPath`. Resolves on success, rejects on a missing runtime/model or a
   * non-zero exit. This is the engine's testable, audio-device-free core — the Docker proof and the unit
   * tests drive it directly. The text is sanitised and delivered on stdin, exactly as speak() does.
   */
  synthToFile(text: string, outPath: string, opts: { lengthScale?: number } = {}): Promise<void> {
    const runtime = resolvePiperRuntime();
    const safe = sanitizeSpeech(text);
    return new Promise((resolve, reject) => {
      if (!runtime) { reject(new Error('piper runtime not found')); return; }
      const args = [...runtime.prefix, '--model', this.model, '--output_file', outPath];
      if (typeof opts.lengthScale === 'number' && Number.isFinite(opts.lengthScale)) {
        args.push('--length_scale', String(opts.lengthScale)); // >1 = slower speech
      }
      let child: ChildProcess;
      try { child = spawn(runtime.cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] }); }
      catch (e) { reject(e as Error); return; }
      let err = '';
      child.stderr?.on('data', (d) => { err += d; });
      child.stdin?.on('error', () => { /* EPIPE if the child died — handled by close/error */ });
      // Piper reads one line of text from stdin; the sanitiser already collapsed newlines to one line.
      try { child.stdin?.end(safe + '\n'); } catch { /* child gone */ }
      child.on('error', reject);
      child.on('close', (code) => code === 0
        ? resolve()
        : reject(new Error(`piper exit ${code}: ${err.slice(-200)}`)));
    });
  }

  /**
   * Pre-load the model into a standby process so the first reply starts speaking quickly. Safe to call
   * repeatedly and before anything is spoken (the controller calls it when voice is enabled). No-op when
   * Piper is not installed here or a standby for this rate already exists.
   */
  warmup(rate?: number): void {
    const scale = lengthScaleFor(rate);
    if (this.standby && !this.standby.disposed && this.standby.scale === scale) return;
    if (this.standby) { this.standby.dispose(); this.standby = null; }
    this.standby = this.spawnWarm(scale);
  }

  /** Spawn a warm process in output-dir mode and prime the model with one discarded utterance. */
  private spawnWarm(scale: number | undefined): WarmProc | null {
    const runtime = resolvePiperRuntime();
    if (!runtime || !existsSync(this.model)) return null;
    const dir = mkdtempSync(join(tmpdir(), 'dexterm-piper-'));
    const args = [...runtime.prefix, '--model', this.model, '--output_dir', dir];
    if (scale !== undefined) args.push('--length_scale', String(scale));
    let child: ChildProcess;
    try { child = spawn(runtime.cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] }); }
    catch { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } return null; }

    const seen = new Set<string>();
    const warm: WarmProc = {
      child, dir, seen, scale, disposed: false,
      ready: new Promise<void>((resolve, reject) => {
        const poll = setInterval(() => {
          if (warm.disposed) { clearInterval(poll); return; }
          for (const f of listWavs(dir)) if (!seen.has(f)) { seen.add(f); clearInterval(poll); resolve(); return; }
        }, 20);
        child.on('error', () => { clearInterval(poll); reject(new Error('piper warm process error')); });
        child.on('close', () => { clearInterval(poll); reject(new Error('piper warm process exited')); });
      }),
      dispose: () => {
        if (warm.disposed) return;
        warm.disposed = true;
        this.live.delete(warm);
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      },
    };
    this.live.add(warm);
    // Swallow the rejection so a dead warm process never becomes an unhandled rejection; adopters await it.
    warm.ready.catch(() => { /* handled when adopted/awaited */ });
    // A short priming utterance makes onnxruntime load the model now; its WAV lands in `seen` and is never
    // played. stdin stays OPEN so speak() can adopt this process and feed the real sentences.
    try { child.stdin?.on('error', () => {}); child.stdin?.write('ready\n'); } catch { /* child gone */ }
    return warm;
  }

  /** Take the standby if it matches the rate; otherwise discard it and spawn a fresh warm process. */
  private takeWarm(scale: number | undefined): WarmProc | null {
    if (this.standby && !this.standby.disposed && this.standby.scale === scale) {
      const w = this.standby; this.standby = null; return w;
    }
    if (this.standby) { this.standby.dispose(); this.standby = null; }
    return this.spawnWarm(scale);
  }

  speak(text: string, opts: SpeakOptions = {}): SpeakHandle {
    this.stopCurrent(); // single queue: never two speakers at once

    const player = pickPlayer();
    const scale = lengthScaleFor(opts.rate);
    const sentences = splitForSpeech(text);

    let stopped = false;
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    let warm: WarmProc | null = null;
    let playing: ChildProcess | null = null;

    const cleanup = (): void => { if (warm) { warm.dispose(); warm = null; } };
    const settle = (): void => {
      if (stopped) return;
      stopped = true;
      if (this.current === handle) this.current = null;
      try { playing?.kill('SIGTERM'); } catch { /* ignore */ }
      cleanup();
      resolve();
    };
    const handle: SpeakHandle = { done, stop: settle };
    this.current = handle;

    // Nothing to say, or we cannot play aloud → degrade to text (resolve, never throw).
    if (!player || sentences.length === 0 || !this.canSynth()) { queueMicrotask(settle); return handle; }

    // Adopt a warm process for the right rate (respawn if the rate changed), then refill the standby.
    warm = this.takeWarm(scale);
    if (!warm) { queueMicrotask(settle); return handle; } // no runtime/model → text
    this.standby = this.spawnWarm(scale); // keep one warm for the NEXT reply

    const queue: string[] = [];
    let synthClosed = false;
    let firstFired = false;
    const adopted = warm;

    const startPlayback = (): void => {
      const poll = setInterval(() => {
        if (stopped) { clearInterval(poll); return; }
        for (const f of listWavs(adopted.dir)) if (!adopted.seen.has(f)) { adopted.seen.add(f); queue.push(join(adopted.dir, f)); }
      }, 20);
      adopted.child.on('close', () => { synthClosed = true; });
      const playNext = (): void => {
        if (stopped) { clearInterval(poll); return; }
        // A WAV is safe to play once a LATER one exists or the synth has exited (so it is fully written).
        const ready = queue.length > 1 || (queue.length === 1 && synthClosed);
        if (!ready) {
          if (synthClosed && queue.length === 0) { clearInterval(poll); settle(); return; }
          setTimeout(playNext, 20);
          return;
        }
        const wav = queue.shift()!;
        try {
          playing = spawn(player, playerArgs(player, wav), { stdio: 'ignore' });
          playing.on('spawn', () => { if (!stopped && !firstFired) { firstFired = true; opts.onFirstAudio?.(); } });
          playing.on('error', () => { if (!stopped) setTimeout(playNext, 0); });
          playing.on('close', () => { if (!stopped) setTimeout(playNext, 0); });
        } catch { if (!stopped) setTimeout(playNext, 0); }
      };
      playNext();
    };

    adopted.ready.then(() => {
      if (stopped) return;
      // Feed the reply one sentence per line; end stdin so the process exits after the last WAV.
      try { for (const s of sentences) adopted.child.stdin?.write(s + '\n'); adopted.child.stdin?.end(); }
      catch { settle(); return; }
      startPlayback();
    }).catch(settle); // the warm process died before it was ready → degrade to text

    return handle;
  }

  private stopCurrent(): void {
    const h = this.current;
    if (h) { this.current = null; try { h.stop(); } catch { /* ignore */ } }
  }

  /** Release the standby and any live warm processes (called when voice is disabled). */
  dispose(): void {
    this.stopCurrent();
    for (const w of [...this.live]) w.dispose();
    this.standby = null;
  }
}
