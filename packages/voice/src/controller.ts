// VoiceController (task-1282): the push-to-talk state machine that ties speech-in, the safe router,
// and speech-out together, measures latency, and stays entirely UI-agnostic so it runs headless in
// tests (fake engines) and in the app (real macOS engines). It emits a decision the app performs; it
// NEVER performs a trade itself. The mic is open only in the 'listening' mode — the single place
// listen() is called — so the on-screen indicator and the real mic state can never disagree.

import type { SttEngine, TtsEngine, SttSession, SpeakHandle, VoiceMode, VoiceProvenance, VoiceScreenState } from './types.ts';
import { route, isSafe, type VoiceDecision } from './router.ts';
import { spokenSummary, type SpokenSource } from './summary.ts';
import { speakable } from './speakable.ts';
import { isBannedVoice } from './tts/voices.ts';
import { DEFAULT_RATE } from './tts/say.ts';

/** Live rate-nudge bounds and step (task-1411, the < / > keys). Clamped so a voice stays intelligible. */
export const RATE_MIN = 120;
export const RATE_MAX = 320;
export const RATE_STEP = 15;

/** A measured key-release → first-spoken-word latency sample. */
export interface LatencySample {
  /** Which path: 'instant' (navigate/open/filter/clarify) or 'analyst' (Claude answer). */
  path: 'instant' | 'analyst';
  ms: number;
  /** The transcript that produced it, for the report. */
  transcript: string;
}

/** The snapshot the UI renders as the indicator / status line. */
export interface VoiceStatus {
  enabled: boolean;
  mode: VoiceMode;
  /** The mic is being opened (listen() in flight): treat like 'listening' for cancellation. */
  starting: boolean;
  muted: boolean;
  voice: string | null;
  sttLabel: string | null;
  ttsLabel: string | null;
  lastTranscript: string | null;
  /** The last line spoken or the last clarify question (what the user heard). */
  lastSay: string | null;
  /** A transient status / error (e.g. "voice-in unavailable — type instead"). */
  message: string | null;
}

export interface VoiceControllerOpts {
  stt: SttEngine | null;
  tts: TtsEngine | null;
  voice?: string;
  rate?: number;
  /** Trusted pitch baseline (say `[[pbas N]]`, lower = deeper) applied to every spoken reply. */
  pitch?: number;
  muted?: boolean;
  /** Called whenever the status/indicator changes, so the UI can redraw. */
  onState?: (s: VoiceStatus) => void;
  /**
   * The app performs the safe decision (navigate / open / filter / watchlist / open-ticket / popup / ask
   * analyst). Return `false` when the app answered the user itself (it spoke a clarify such as "I see 2
   * tokens called X"): the controller then does NOT read the decision's own `say` line over it
   * (task-1339, re-verify N1). Any other return value (undefined/true) = the controller speaks `say`.
   */
  onDecision?: (d: VoiceDecision) => unknown;
  /** Current screen context for the router (selected coin, visible symbols). */
  getScreenState?: () => VoiceScreenState;
  /** Injectable clock (ms) for deterministic latency tests. */
  now?: () => number;
  /**
   * Persist the user's voice choice when they cycle it with the `,` key (task-1393). The controller
   * never writes config itself; the app wires this to the config journal (actor 'user').
   */
  onVoiceChange?: (voice: string) => void;
  /**
   * Persist the user's speaking rate when they nudge it with the < / > keys (task-1411). The controller
   * never writes config itself; the app wires this to the config journal (actor 'user').
   */
  onRateChange?: (rate: number) => void;
  /**
   * Hard cap on how long the mic may stay live before it auto-stops (task-1282 rework D2). The mic is
   * only ever live in 'listening'; if the user walks away or forgets, this closes it. 0 disables it.
   */
  maxListenMs?: number;
  /** Injectable timer, so the listen-timeout is deterministic in tests. Defaults to unref'd setTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class VoiceController {
  private readonly stt: SttEngine | null;
  private readonly tts: TtsEngine | null;
  private readonly opts: VoiceControllerOpts;
  private readonly now: () => number;

  private enabled = false;
  private mode: VoiceMode = 'off';
  private muted: boolean;
  private voice: string | null;
  private rate: number;
  private pitch: number | undefined;
  private voices: string[] = [];
  private lastTranscript: string | null = null;
  private lastSay: string | null = null;
  private message: string | null = null;

  private session: SttSession | null = null;
  private speaking: SpeakHandle | null = null;
  /** Key-release timestamp awaiting its first-spoken-word, and the path it will be attributed to. */
  private pendingLatency: { at: number; path: 'instant' | 'analyst'; transcript: string } | null = null;

  private readonly maxListenMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  /** The live mic's auto-stop handle; non-null only while listening. */
  private listenTimer: unknown = null;
  /**
   * True from the talk key until stt.listen() has resolved (task-1339, re-verify N3). A second talk key
   * in that window is ignored instead of opening a second, orphaned mic session; a cancel in that
   * window closes the session the moment it arrives.
   */
  private starting = false;
  private startCancelled = false;

  readonly samples: LatencySample[] = [];

  constructor(opts: VoiceControllerOpts) {
    this.opts = opts;
    this.stt = opts.stt;
    this.tts = opts.tts;
    this.muted = opts.muted ?? false;
    this.voice = opts.voice ?? null;
    this.rate = opts.rate ?? DEFAULT_RATE;
    this.pitch = opts.pitch;
    this.now = opts.now ?? (() => Date.now());
    this.maxListenMs = opts.maxListenMs ?? 15_000;
    this.setTimer = opts.setTimer ?? ((fn, ms) => { const h = setTimeout(fn, ms); (h as { unref?: () => void }).unref?.(); return h; });
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  status(): VoiceStatus {
    return {
      enabled: this.enabled,
      mode: this.mode,
      starting: this.starting,
      muted: this.muted,
      voice: this.voice,
      sttLabel: this.stt?.label ?? null,
      ttsLabel: this.tts?.label ?? null,
      lastTranscript: this.lastTranscript,
      lastSay: this.lastSay,
      message: this.message,
    };
  }

  private notify(): void { try { this.opts.onState?.(this.status()); } catch { /* UI handler must not break us */ } }
  private setMode(m: VoiceMode): void { this.mode = m; this.notify(); }

  get isEnabled(): boolean { return this.enabled; }
  get isListening(): boolean { return this.mode === 'listening'; }
  /** The mic is live OR about to be (listen() in flight): the states a key must cancel. */
  get micEngaged(): boolean { return this.mode === 'listening' || this.starting; }

  /**
   * Load the voice list lazily (used by cycleVoice and the status line). Novelty voices on the ban-list
   * are filtered OUT so the user can never cycle into "Zarvox" / "Bad News" and so a null starting voice
   * is seeded to a safe one, never the machine's (possibly novelty) system voice (task-1393).
   */
  async loadVoices(): Promise<void> {
    if (!this.tts) return;
    try {
      this.voices = (await this.tts.listVoices()).filter((n) => !isBannedVoice(n));
      if (!this.voice && this.voices.length) this.voice = this.voices[0];
    } catch { this.voices = []; }
  }

  /** Turn voice mode on/off. Enabling with no STT engine still works for spoken replies to typed Qs. */
  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.message = this.stt ? null : 'voice-in unavailable on this machine — type questions; replies are still spoken';
    this.setMode('idle');
    void this.loadVoices();
    // task-1416: pre-load the TTS engine (Piper loads its model into a standby process) so the first
    // reply starts speaking quickly. A no-op for engines that stream from spawn (`say`).
    try { this.tts?.warmup?.(this.rate); } catch { /* warm-up is best-effort; never break enabling voice */ }
  }

  disable(): void {
    if (!this.enabled) return;
    this.cancelListen();
    this.stopSpeaking();
    this.enabled = false;
    this.pendingLatency = null;
    try { this.tts?.dispose?.(); } catch { /* best-effort cleanup */ }
    this.setMode('off');
  }

  toggle(): void { this.enabled ? this.disable() : this.enable(); }

  /**
   * The push-to-talk key. Terminals deliver no key-up, so this toggles: first press opens the mic
   * (mode 'listening' — the only place the mic is live), second press closes it, transcribes, and
   * routes. Starting to talk also interrupts any reply in progress. Returns when the decision (if any)
   * has been emitted, so tests can await it.
   */
  async toggleTalk(): Promise<void> {
    if (!this.enabled) this.enable();
    if (this.mode === 'listening') return this.stopTalkAndRoute();
    if (this.mode === 'transcribing' || this.mode === 'thinking') return; // busy; ignore re-press
    if (this.starting) return; // a second press while the mic is opening: never a second session (N3)
    return this.startTalk();
  }

  private async startTalk(): Promise<void> {
    if (!this.stt) { this.message = 'voice-in unavailable — type your question instead'; this.notify(); return; }
    this.stopSpeaking(); // starting to talk cuts off any reply
    this.starting = true;
    this.startCancelled = false;
    this.notify();
    let session: SttSession | null = null;
    try {
      session = await this.stt.listen();
    } catch (e) {
      this.starting = false;
      this.session = null;
      this.message = `mic/STT could not start: ${describe(e)}`;
      this.setMode('idle');
      return;
    }
    this.starting = false;
    // The user moved on (a key, esc, disable) while the mic was opening: close it at once (N3/N8).
    if (this.startCancelled || !this.enabled) {
      try { session.cancel(); } catch { /* ignore */ }
      this.session = null;
      this.setMode(this.enabled ? 'idle' : 'off');
      return;
    }
    this.session = session;
    this.setMode('listening');
    this.armListenTimeout(); // the mic can never stay live indefinitely (task-1282 rework D2)
  }

  /** Start the hard cap that auto-stops a live mic. Cleared whenever we leave 'listening'. */
  private armListenTimeout(): void {
    this.clearListenTimeout();
    if (this.maxListenMs <= 0) return;
    this.listenTimer = this.setTimer(() => {
      this.listenTimer = null;
      if (this.mode === 'listening') {
        this.cancelListen();
        this.message = 'mic timed out — press v to talk again';
        this.notify();
      }
    }, this.maxListenMs);
  }

  private clearListenTimeout(): void {
    if (this.listenTimer !== null) { try { this.clearTimer(this.listenTimer); } catch { /* ignore */ } this.listenTimer = null; }
  }

  private async stopTalkAndRoute(): Promise<void> {
    this.clearListenTimeout(); // leaving 'listening': the mic is no longer live
    const session = this.session;
    this.session = null;
    this.setMode('transcribing');
    // "Key release": the clock for key-release → first-spoken-word starts now.
    const releaseAt = this.now();
    let result;
    try {
      result = session ? await session.stop() : { text: '', confidence: 0 };
    } catch (e) {
      // Always release the capture on a transcription error so the mic can never be left open.
      try { session?.cancel(); } catch { /* ignore */ }
      this.message = `transcription failed: ${describe(e)}`;
      this.setMode('idle');
      return;
    }
    this.lastTranscript = result.text || null;
    // An empty capture used to route to a silent 'ignore': the user saw the badge vanish and nothing else.
    if (!result.text.trim()) { this.message = "didn't hear anything — press v, wait for the red LISTENING badge, speak, then press v"; this.setMode('idle'); return; }
    const ss = this.opts.getScreenState?.() ?? {};
    const prov: VoiceProvenance = {
      pttActive: true, // this transcript came from a real PTT session, by construction
      speakerCount: result.speakerCount ?? 1,
      echoFlagged: result.echoFlagged ?? false,
      sttConfidence: result.confidence,
      lowConfTokens: result.lowConfTokens ?? [],
    };
    const decision = route(result.text, prov, ss);
    // Hard safety gate: never act on a decision that is not in the safe set (defence in depth).
    if (!isSafe(decision)) { this.message = 'blocked an unsafe voice decision'; this.setMode('idle'); return; }
    this.dispatch(decision, releaseAt);
  }

  /** Emit the decision for the app, speak any immediate confirmation, and arm latency timing. */
  private dispatch(d: VoiceDecision, releaseAt: number): void {
    if (d.kind === 'analyst') {
      // The spoken output is the analyst's answer; the app calls speakAnswer() when it lands. Time the
      // key-release → first word of that answer.
      this.pendingLatency = { at: releaseAt, path: 'analyst', transcript: this.lastTranscript ?? '' };
      this.setMode('thinking');
      try { this.opts.onDecision?.(d); } catch { /* app handler */ }
      return;
    }
    // Instant paths (navigate/open/filter/watchlist/open-ticket/popup/clarify) speak their own one-liner —
    // unless the app answered itself (returned false): then its reply stands and `say` is NOT read over
    // it, so a clarify such as "I see 2 tokens called X" is what the user actually hears (N1).
    this.pendingLatency = { at: releaseAt, path: 'instant', transcript: this.lastTranscript ?? '' };
    let appAnswered = false;
    try { appAnswered = this.opts.onDecision?.(d) === false; } catch { /* app handler */ }
    if (appAnswered) { if (this.mode !== 'speaking') this.setMode('idle'); return; }
    const line = d.kind === 'clarify' ? d.question : ('say' in d ? d.say : null);
    if (line) this.speak(line);
    else { this.setMode('idle'); }
  }

  /**
   * Speak the analyst's answer (first ~2 sentences). Called by the app when a turn settles. Honours
   * mute, is interruptible, and records the pending analyst-path latency on the first audio sample.
   */
  speakAnswer(src: SpokenSource): void {
    const line = spokenSummary(src);
    if (!line) { this.setMode('idle'); return; }
    this.speak(line);
  }

  /** Low-level speak: stops any current reply, then reads `text`. Muted → skip audio but update state. */
  speak(text: string): void {
    // Speak like a trader (task-1411): no digit-by-digit tiny prices, big numbers in human words,
    // natural percents. Applied to EVERY spoken line so an ack or an analyst answer never reads raw.
    text = speakable(text);
    this.lastSay = text;
    if (!this.tts || this.muted) {
      // Still resolve the latency sample (the "spoken word" is just suppressed) so the table is complete.
      this.recordFirstAudio();
      this.setMode('idle');
      this.notify();
      return;
    }
    this.stopSpeaking();
    this.setMode('speaking');
    const handle = this.tts.speak(text, {
      voice: this.voice ?? undefined,
      rate: this.rate,
      pitch: this.pitch,
      onFirstAudio: () => this.recordFirstAudio(),
    });
    this.speaking = handle;
    handle.done.then(() => {
      if (this.speaking === handle) { this.speaking = null; if (this.mode === 'speaking') this.setMode('idle'); }
    });
  }

  private recordFirstAudio(): void {
    const p = this.pendingLatency;
    if (!p) return;
    this.pendingLatency = null;
    this.samples.push({ path: p.path, ms: this.now() - p.at, transcript: p.transcript });
  }

  /** Interrupt a spoken reply (a key, or the user starting to talk). */
  stopSpeaking(): void {
    if (this.speaking) { try { this.speaking.stop(); } catch { /* ignore */ } this.speaking = null; }
    if (this.mode === 'speaking') this.setMode('idle');
  }

  /** Abandon a live capture without transcribing. Always closes the mic and the auto-stop timer. */
  cancelListen(): void {
    this.clearListenTimeout();
    if (this.starting) this.startCancelled = true; // the session is closed the moment listen() resolves
    if (this.session) { try { this.session.cancel(); } catch { /* ignore */ } this.session = null; }
    if (this.mode === 'listening') this.setMode('idle');
  }

  /**
   * Interrupt whatever voice is doing and return to idle — a mic capture, a spoken reply, OR a pending
   * analyst turn ('thinking') / in-flight 'transcribing'. Resetting 'thinking' is the task-1282 rework
   * D3 fix: an analyst error used to leave the mode stuck in 'thinking', where toggleTalk ignores every
   * press, so voice was dead until restart. Now any key (esc) or an error cleanly returns to idle.
   */
  interrupt(): void {
    this.stopSpeaking();
    this.cancelListen();
    this.pendingLatency = null;
    if (this.enabled && this.mode !== 'idle' && this.mode !== 'off') this.setMode('idle');
  }

  /**
   * Abort the current turn because the analyst run failed/was cancelled, and surface a clear error both
   * on screen (the HUD message) and aloud. Always leaves voice in idle so the next `v` works
   * (task-1282 rework D3).
   */
  abortTurn(message = "Sorry — I couldn't get an answer. Try again."): void {
    this.interrupt();
    if (!this.enabled) { this.setMode('off'); return; }
    this.message = message;
    this.mode = 'idle'; // speak()'s done handler returns to idle from 'speaking'
    this.speak(message);
  }

  setMuted(m: boolean): void { this.muted = m; if (m) this.stopSpeaking(); this.notify(); }
  toggleMute(): void { this.setMuted(!this.muted); }
  get isMuted(): boolean { return this.muted; }

  /** Cycle to the next installed (safe) voice and persist the choice. No-op when there are none. */
  cycleVoice(): void {
    if (!this.voices.length) { this.notify(); return; }
    const i = this.voice ? this.voices.indexOf(this.voice) : -1;
    this.voice = this.voices[(i + 1) % this.voices.length];
    try { this.opts.onVoiceChange?.(this.voice); } catch { /* persistence is best-effort; never break the UI */ }
    this.notify();
  }

  currentVoice(): string | null { return this.voice; }
  availableVoices(): string[] { return this.voices.slice(); }

  /** The current speaking rate (words-per-minute-ish), for the status line / help. */
  currentRate(): number { return this.rate; }

  /**
   * Nudge the speaking rate by `steps` × RATE_STEP (— for slower, + for faster), clamp it, persist it,
   * and surface it on the status line (task-1411: the < / > keys). Takes effect on the next reply; it
   * does not restart a line already in flight. A no-op when the rate is already at the clamp.
   */
  nudgeRate(steps: number): void {
    const next = Math.max(RATE_MIN, Math.min(RATE_MAX, this.rate + steps * RATE_STEP));
    if (next === this.rate) { this.message = `voice rate ${this.rate} wpm (${next <= RATE_MIN ? 'slowest' : 'fastest'})`; this.notify(); return; }
    this.rate = next;
    this.message = `voice rate ${this.rate} wpm`;
    try { this.opts.onRateChange?.(this.rate); } catch { /* persistence is best-effort; never break the UI */ }
    this.notify();
  }

  /** A compact latency report for the handoff / `--latency` demo. */
  report(): { path: string; n: number; p50: number | null; min: number | null; max: number | null }[] {
    const paths: Array<'instant' | 'analyst'> = ['instant', 'analyst'];
    return paths.map((path) => {
      const xs = this.samples.filter((s) => s.path === path).map((s) => s.ms).sort((a, b) => a - b);
      return { path, n: xs.length, p50: pct(xs, 0.5), min: xs[0] ?? null, max: xs[xs.length - 1] ?? null };
    });
  }
}

function pct(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[i];
}

function describe(e: unknown): string {
  const m = (e as { message?: unknown })?.message;
  return typeof m === 'string' ? m : String(e);
}
