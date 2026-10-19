// An STT engine that captures no audio — listen()/stop() replay a scripted transcript. It powers the
// headless tests and the latency harness, and the `--text`/`--script` demo, so the whole pipeline is
// exercisable with no mic and no model.

import type { SttEngine, SttResult, SttSession } from '../types.ts';

export interface FakeSttScript {
  text: string;
  confidence?: number;
  lowConfTokens?: string[];
  firstPartialMs?: number | null;
  speakerCount?: number;
  echoFlagged?: boolean;
  /** Simulated capture-to-transcript delay in ms (so latency timing is realistic). */
  transcribeMs?: number;
}

export class FakeStt implements SttEngine {
  readonly name = 'fake';
  readonly label = 'fake (scripted, for tests)';
  private queue: FakeSttScript[];
  private deflt: FakeSttScript;

  /** `scripts` are consumed one per listen(); once exhausted, `fallback` is reused. */
  constructor(scripts: FakeSttScript[] = [], fallback: FakeSttScript = { text: '' }) {
    this.queue = scripts.slice();
    this.deflt = fallback;
  }

  async available(): Promise<boolean> { return true; }

  async listen(): Promise<SttSession> {
    const s = this.queue.shift() ?? this.deflt;
    let settled: SttResult | null = null;
    const resolveResult = (): SttResult => (settled ??= {
      text: s.text,
      confidence: s.confidence ?? 1,
      lowConfTokens: s.lowConfTokens ?? [],
      firstPartialMs: s.firstPartialMs ?? null,
      speakerCount: s.speakerCount ?? 1,
      echoFlagged: s.echoFlagged ?? false,
    });
    return {
      stop: () => new Promise<SttResult>((resolve) => {
        const delay = Math.max(0, s.transcribeMs ?? 0);
        setTimeout(() => resolve(resolveResult()), delay);
      }),
      cancel: () => { settled = resolveResult(); },
    };
  }
}
