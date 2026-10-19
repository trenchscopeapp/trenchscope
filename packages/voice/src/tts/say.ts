// macOS `say` TTS engine (task-1282, hardened task-1393). `say` ships with macOS, needs no key and no
// network, so it is the free/portable default (SPEC: macOS say first). It streams to the audio device,
// so time-to-first-audio is close to process spawn. speak() is interruptible via stop() (SIGTERM to the
// child), which is how a key or the user starting to talk cuts a reply short.
//
// task-1393 hardening:
//   - text is SANITISED (no `[[…]]` embedded commands, no leading-`-` flag, addresses shortened, capped)
//   - text is delivered on STDIN (`say -f -`), never as the last argv word
//   - a new speak() cleanly INTERRUPTS the current one, so two `say` processes never overlap (one queue)
//   - the voice is always EXPLICIT (resolved to a deep British male upstream); it never falls back to the
//     machine's system voice

import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import type { SpeakHandle, SpeakOptions, TtsEngine } from '../types.ts';
import { parseSayVoices, sanitizeSpeech, type VoiceInfo } from './voices.ts';

export const SAY_BIN = process.env.DEXTERM_SAY_BIN || 'say';
/** Consistent speaking rate (words-per-minute-ish) for every reply path. Brisk by default (task-1411:
 * the old delivery was reported "way too slow"); the user can nudge it live with < / > or set voice.rate. */
export const DEFAULT_RATE = 205;

export class SayTts implements TtsEngine {
  readonly name = 'say';
  readonly label = 'macOS say (built-in, no key)';
  private defaultVoice: string | undefined;
  /** The utterance currently playing. A new speak() stops it first, so there is only ever one. */
  private current: SpeakHandle | null = null;

  constructor(defaultVoice?: string) { this.defaultVoice = defaultVoice; }

  /** The resolved default voice this engine speaks with — used to seed the controller / status line. */
  get voiceName(): string | undefined { return this.defaultVoice; }

  async available(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    return new Promise((resolve) => {
      try {
        const child = execFile(SAY_BIN, ['-v', '?'], { timeout: 4000 }, (err) => resolve(!err || (err as NodeJS.ErrnoException).code !== 'ENOENT'));
        child.on('error', () => resolve(false));
      } catch { resolve(false); }
    });
  }

  /** Installed voices with their locale. Robust against the single-space padding on long voice names. */
  async listVoicesDetailed(): Promise<VoiceInfo[]> {
    return new Promise((resolve) => {
      try {
        execFile(SAY_BIN, ['-v', '?'], { timeout: 5000, maxBuffer: 1 << 20 }, (err, stdout) => {
          resolve(err || !stdout ? [] : parseSayVoices(stdout));
        });
      } catch { resolve([]); }
    });
  }

  /** Selectable voice names (the TtsEngine contract). */
  async listVoices(): Promise<string[]> {
    return (await this.listVoicesDetailed()).map((v) => v.name);
  }

  speak(text: string, opts: SpeakOptions = {}): SpeakHandle {
    // One queue: cut off whatever is playing so two `say` processes never overlap (clean interrupt).
    this.stopCurrent();

    const voice = opts.voice ?? this.defaultVoice;
    const rate = opts.rate ?? DEFAULT_RATE;
    // Sanitise the UNTRUSTED text first, then prepend our own TRUSTED pitch command. Order matters: the
    // sanitiser strips any `[[…]]` the text tried to smuggle, so only our validated `[[pbas N]]` survives.
    let safe = sanitizeSpeech(text);
    if (typeof opts.pitch === 'number' && Number.isFinite(opts.pitch)) {
      const pbas = Math.max(0, Math.min(100, Math.round(opts.pitch)));
      safe = `[[pbas ${pbas}]] ${safe}`;
    }

    const args: string[] = [];
    if (voice) args.push('-v', voice);
    args.push('-r', String(rate));
    args.push('-f', '-'); // read the utterance from stdin — the text is NEVER an argv word

    let child: ChildProcess | null = null;
    let stopped = false;
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    const finish = (): void => { if (!stopped) { stopped = true; if (this.current === handle) this.current = null; resolve(); } };

    try {
      child = spawn(SAY_BIN, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      // Nothing is spoken until stdin is closed; write the sanitised text and end it.
      child.stdin?.on('error', () => { /* EPIPE if the child already died — handled by close/error */ });
      try { child.stdin?.end(safe); } catch { /* child gone */ }
      // `say` has no first-sample hook; the spawn event is the closest honest lower bound and is what the
      // latency table reports as "first spoken word" for this engine.
      child.on('spawn', () => { if (!stopped) opts.onFirstAudio?.(); });
      child.on('error', finish);
      child.on('close', finish);
    } catch {
      // No `say` on this machine: resolve immediately so the caller degrades to text.
      queueMicrotask(finish);
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

  /** Stop the currently-playing utterance, if any. */
  private stopCurrent(): void {
    const h = this.current;
    if (h) { this.current = null; try { h.stop(); } catch { /* ignore */ } }
  }
}
