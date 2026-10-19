// Shared types for @dexterm/voice (task-1282). Everything here is UI- and engine-agnostic so the
// controller can be driven headlessly with fakes in tests and with the real macOS engines in the app.

/** What the push-to-talk machine is doing right now. Drives the always-on on-screen indicator. */
export type VoiceMode =
  | 'off'          // voice mode not enabled
  | 'idle'         // enabled, mic closed, armed for the talk key
  | 'listening'    // mic is LIVE and capturing (indicator must be visible)
  | 'transcribing' // key released; turning captured audio into text
  | 'thinking'     // transcript routed to the analyst; awaiting its answer
  | 'speaking';    // reading an answer aloud

/** A transcription result from an STT engine. `confidence` is 0..1 (1 when the engine gives none). */
export interface SttResult {
  text: string;
  confidence: number;
  /** Surface tokens the engine marked low-confidence (used by the router's read-back guards). */
  lowConfTokens?: string[];
  /** ms from listen() start to the first partial transcript (streaming engines only; null for batch). */
  firstPartialMs?: number | null;
  /** How many distinct speakers the capture layer detected, when it can tell (default 1). */
  speakerCount?: number;
  /** True when the capture layer flagged the audio as TV/echo/loopback rather than a live speaker. */
  echoFlagged?: boolean;
}

/** A live capture session returned by SttEngine.listen(). Mic is open until stop() is called. */
export interface SttSession {
  /** Stop capturing and resolve the final transcript. Idempotent; a second call resolves the same value. */
  stop(): Promise<SttResult>;
  /** Abandon the capture without transcribing (e.g. the user cancelled). Never rejects. */
  cancel(): void;
}

export interface SttEngine {
  /** Stable id, e.g. 'apple' | 'whisper' | 'fake'. */
  readonly name: string;
  /** Human label for the doctor / status line, e.g. 'Apple Speech (on-device)'. */
  readonly label: string;
  /** True when this engine can run on this machine right now (binaries/models present). */
  available(): Promise<boolean>;
  /** Open the mic and start capturing. The indicator is the caller's responsibility. */
  listen(): Promise<SttSession>;
}

export interface SpeakHandle {
  /** Resolves when playback finishes (or is stopped). Never rejects for a normal stop. */
  readonly done: Promise<void>;
  /** Interrupt playback immediately. Idempotent. */
  stop(): void;
}

export interface SpeakOptions {
  voice?: string;
  /** Words per minute-ish rate passed to the engine (macOS `say -r`). */
  rate?: number;
  /**
   * Pitch baseline for a deeper/higher voice (macOS `say` `[[pbas N]]`, ~0-100, lower = deeper). This is
   * a TRUSTED, app-supplied setting applied as a prefix AFTER the untrusted text is sanitised, so it can
   * never be injected by token names or analyst output. Omitted = the voice's own default pitch.
   */
  pitch?: number;
  /** Fired as close to the first audible sample as the engine allows (used for latency timing). */
  onFirstAudio?: () => void;
}

export interface TtsEngine {
  readonly name: string;
  readonly label: string;
  available(): Promise<boolean>;
  /** List selectable voice names (macOS voices); [] when the engine has none. */
  listVoices(): Promise<string[]>;
  speak(text: string, opts?: SpeakOptions): SpeakHandle;
  /**
   * Optional: pre-load/initialise the engine so the first reply starts quickly (Piper loads its model
   * into a standby process). Safe to call repeatedly; a no-op for engines that stream from spawn (`say`).
   * `rate` is the words-per-minute the first reply will likely use, so the standby is primed for it.
   */
  warmup?(rate?: number): void;
  /** Optional: release any long-lived resources (warm processes) when voice is disabled. */
  dispose?(): void;
}

/** The screen context the router needs. Mirrors the subset of buildScreenState() the router reads. */
export interface VoiceScreenState {
  screen?: string;
  /** The selected/hovered coin, if any: the referent for "this one" / "it". */
  selected?: { mint: string; symbol: string } | null;
  /** Symbols currently visible, so the router can tell a known ticker from noise without resolving mints. */
  visibleSymbols?: string[];
}

/** Provenance/safety facts about the capture, gating the router before any NLU runs. */
export interface VoiceProvenance {
  /** True while the push-to-talk key was held/toggled on for this utterance. */
  pttActive: boolean;
  speakerCount: number;
  echoFlagged: boolean;
  sttConfidence: number;
  lowConfTokens: string[];
}
