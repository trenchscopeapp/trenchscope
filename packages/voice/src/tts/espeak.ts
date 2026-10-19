// Portable (Linux/Windows) TTS via espeak-ng (task-1393 Part 2). espeak-ng is free, local, ships in or
// installs trivially on every Linux distro, and runs on Windows too. It is the "works everywhere" baseline
// off macOS; a Piper neural voice is a higher-quality upgrade that needs a downloaded model (see doctor).
//
// It carries the SAME contract as the macOS engine: text is SANITISED and delivered on STDIN (espeak-ng
// treats `[[…]]` as phoneme input, so stripping it is a safety requirement, not a nicety), a new speak()
// cleanly interrupts the current one (single queue), and the default voice is an explicit deep British
// male (`en-gb+m3`) — never a surprise.
//
// VERIFICATION NOTE: the logic is unit-tested against a fake binary; it was NOT run against real
// espeak-ng audio because the Linux (WSL) box was unreachable during this task. See the handoff.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SpeakHandle, SpeakOptions, TtsEngine } from '../types.ts';
import { sanitizeSpeech } from './voices.ts';

/** espeak-ng first (actively maintained), then the older espeak. Overridable for tests. */
export const ESPEAK_BIN = process.env.DEXTERM_ESPEAK_BIN || '';
/** The default portable voice: a British male. `+m3` is a deeper male variant. */
export const DEFAULT_ESPEAK_VOICE = 'en-gb+m3';
/** espeak words-per-minute default (close to the macOS 190 feel). */
export const DEFAULT_ESPEAK_RATE = 175;

function which(bin: string): string | null {
  if (!bin) return null;
  if (bin.includes('/') || bin.includes('\\')) return existsSync(bin) ? bin : null;
  for (const p of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (!p) continue;
    if (existsSync(join(p, bin))) return join(p, bin);
    if (process.platform === 'win32' && existsSync(join(p, `${bin}.exe`))) return join(p, `${bin}.exe`);
  }
  return null;
}

/** Resolve the espeak binary path: an explicit override, else espeak-ng, else espeak. */
export function resolveEspeakBin(): string | null {
  return which(ESPEAK_BIN) || which('espeak-ng') || which('espeak');
}

/**
 * espeak voice names are language codes, optionally with a variant: `en`, `en-gb`, `en-us+m3`, `de+f2`.
 * A macOS voice name like "Eddy (English (UK))" or "Daniel" is NOT one and must never be passed to
 * espeak verbatim (task-1408 residual) — it would be an invalid `-v` argument. This matches only the
 * espeak form, so a Mac voice name is rejected and the engine default is used instead.
 */
const ESPEAK_VOICE_RE = /^[a-z]{2,3}(-[a-z0-9]+)*(\+[a-z0-9]+)?$/i;

/** A valid espeak voice token, or null when `configured` is empty or is a macOS voice name. */
export function espeakVoiceFor(configured?: string | null): string | null {
  const v = configured?.trim();
  if (!v) return null;
  return ESPEAK_VOICE_RE.test(v) ? v : null;
}

export class EspeakTts implements TtsEngine {
  readonly name = 'espeak';
  readonly label = 'espeak-ng (local, no key)';
  private defaultVoice: string;
  private current: SpeakHandle | null = null;

  constructor(defaultVoice: string = DEFAULT_ESPEAK_VOICE) { this.defaultVoice = defaultVoice; }

  get voiceName(): string { return this.defaultVoice; }

  async available(): Promise<boolean> { return resolveEspeakBin() !== null; }

  /** espeak-ng has no per-machine "installed voices" list the user cycles; the default covers it. */
  async listVoices(): Promise<string[]> { return [this.defaultVoice]; }

  speak(text: string, opts: SpeakOptions = {}): SpeakHandle {
    this.stopCurrent(); // single queue: never two speakers at once

    const bin = resolveEspeakBin();
    const voice = opts.voice ?? this.defaultVoice;
    const rate = opts.rate ?? DEFAULT_ESPEAK_RATE;
    const safe = sanitizeSpeech(text);

    const args = ['-v', voice, '-s', String(rate)];
    if (typeof opts.pitch === 'number' && Number.isFinite(opts.pitch)) {
      args.push('-p', String(Math.max(0, Math.min(99, Math.round(opts.pitch))))); // 0-99, lower = deeper
    }
    args.push('--stdin'); // read the utterance from stdin — never an argv word

    let child: ChildProcess | null = null;
    let stopped = false;
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    const finish = (): void => { if (!stopped) { stopped = true; if (this.current === handle) this.current = null; resolve(); } };

    try {
      if (!bin) throw new Error('espeak not found');
      child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.stdin?.on('error', () => { /* EPIPE if the child died — handled by close/error */ });
      try { child.stdin?.end(safe); } catch { /* child gone */ }
      child.on('spawn', () => { if (!stopped) opts.onFirstAudio?.(); });
      child.on('error', finish);
      child.on('close', finish);
    } catch {
      queueMicrotask(finish); // no espeak → degrade to text
    }

    const handle: SpeakHandle = {
      done,
      stop: () => {
        if (stopped) return;
        stopped = true;
        if (this.current === handle) this.current = null;
        try { child?.kill('SIGTERM'); } catch { /* already gone */ }
        resolve();
      },
    };
    this.current = handle;
    return handle;
  }

  private stopCurrent(): void {
    const h = this.current;
    if (h) { this.current = null; try { h.stop(); } catch { /* ignore */ } }
  }
}
