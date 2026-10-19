// Voice-mode on-screen indicator (task-1282). Drawn on the band under the header (row 1) after the
// effects pass, so it is always crisp and ALWAYS VISIBLE while the mic could be live — the hard rule
// is that the user can never be unsure whether they are being heard. The 'listening' state is the
// loudest (a red ●); every other state is quieter. Nothing here captures audio; it only reflects the
// controller's state.
import type { Canvas, Theme } from '@dexterm/tui';

export type VoiceHudMode = 'off' | 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

/** The minimal snapshot the renderer needs; the VoiceController pushes this into AppState.voice. */
export interface VoiceHud {
  enabled: boolean;
  mode: VoiceHudMode;
  muted: boolean;
  voice: string | null;
  /** The last transcript heard (shown briefly for confidence). */
  transcript: string | null;
  /** The last line spoken / clarify question. */
  say: string | null;
  /** A transient status or error (e.g. voice-in unavailable). */
  message: string | null;
}

// Transcripts and model text are UNTRUSTED input (task-1282): strip C0/C1 control characters and DEL
// before they are drawn, so an injected escape sequence in a transcript can never reach the terminal.
const sanitize = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

/** Render the one-line voice badge at (1,1). Clipped to the width; never wraps. */
export function renderVoiceHud(c: Canvas, v: VoiceHud, t: Theme): void {
  if (!v.enabled) return;
  const bg = t.bg;
  let x = 1;
  const y = 1;
  const mute = v.muted ? ' ⌀muted' : '';
  const voiceName = v.voice ? ` · ${v.voice}` : '';

  if (v.mode === 'listening') {
    // The loud, unmistakable mic-live state.
    x = c.text(x, y, ' ● LISTENING ', { fg: t.bg, bg: t.down, b: true });
    x = c.text(x, y, ' speak — v to send, esc to cancel', { fg: t.down, bg, b: true });
  } else if (v.mode === 'transcribing') {
    x = c.text(x, y, ' ◍ transcribing… ', { fg: t.warn, bg, b: true });
  } else if (v.mode === 'thinking') {
    x = c.text(x, y, ' ◌ asking the analyst… ', { fg: t.borderFocus, bg, b: true });
  } else if (v.mode === 'speaking') {
    x = c.text(x, y, ' ▸ speaking ', { fg: t.up, bg, b: true });
    x = c.text(x, y, '(v/esc stop)', { fg: t.muted, bg });
  } else {
    // idle but enabled: a quiet "ready" badge with the key hints.
    x = c.text(x, y, ' ◎ voice ', { fg: t.borderFocus, bg, b: true });
    x = c.text(x, y, `v talk · m ${v.muted ? 'unmute' : 'mute'} · , voice · < > rate${voiceName}`, { fg: t.muted, bg });
  }
  if (mute && v.mode !== 'off') x = c.text(x, y, mute, { fg: t.warn, bg, b: true });

  // A short echo of what was heard / said, to the right, when there is room.
  const echo = v.message ? `⚠ ${sanitize(v.message)}` : v.transcript ? `“${sanitize(v.transcript)}”` : v.say ? `▸ ${sanitize(v.say)}` : '';
  if (echo && x + 3 < c.w) {
    const room = c.w - x - 2;
    const shown = echo.length > room ? echo.slice(0, Math.max(0, room - 1)) + '…' : echo;
    c.text(x + 1, y, shown, { fg: v.message ? t.warn : t.dim, bg });
  }
}
