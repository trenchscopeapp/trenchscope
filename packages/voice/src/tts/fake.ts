// A TTS engine that produces no audio — it records what would have been spoken and resolves at once.
// Used by the headless tests and the latency harness so speech-out is deterministic and silent.

import type { SpeakHandle, SpeakOptions, TtsEngine } from '../types.ts';

export class FakeTts implements TtsEngine {
  readonly name = 'fake';
  readonly label = 'fake (silent, for tests)';
  /** Every text passed to speak(), in order, for assertions. */
  readonly spoken: string[] = [];
  /** How many times stop() interrupted a live utterance. */
  stops = 0;
  private voices: string[];

  constructor(voices: string[] = ['Samantha', 'Alex', 'Daniel']) { this.voices = voices; }

  async available(): Promise<boolean> { return true; }
  async listVoices(): Promise<string[]> { return this.voices.slice(); }

  speak(text: string, opts: SpeakOptions = {}): SpeakHandle {
    this.spoken.push(text);
    let stopped = false;
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    // Fire first-audio on the next tick so latency timing sees a realistic (tiny) gap, then finish.
    const t = setTimeout(() => { if (!stopped) { opts.onFirstAudio?.(); resolve(); } }, 0);
    return {
      done,
      stop: () => { if (stopped) return; stopped = true; clearTimeout(t); this.stops++; resolve(); },
    };
  }
}
