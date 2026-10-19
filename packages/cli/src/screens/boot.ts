// trenchscope — boot sequence: full-screen rain, glitching DEXTERM logo, "jacking in" status lines.
// state.boot.t ∈ [0,1] drives it. The logo and the status box clear their own rain zone so the
// rain never crosses them (VISUAL-V2 §3 "Boot").
import { Canvas, bootLogo, decryptText, spinnerGlyph, mix } from '@dexterm/tui';
import type { AppState } from '../state.ts';

type Step = readonly [name: string, what: string, result: string];

// task-1311 (QA M13): the result column is the boot's intro texture, not a health report — it must
// not fabricate latencies / rpm before a single request has gone out. Honest status words only.
const LIVE_STEPS: Step[] = [
  ['dexscreener', 'GET /latest/dex/search?q=solana', 'link'],
  ['jupiter', 'lite-api tokens/v2 + price/v3', 'link'],
  ['geckoterminal', 'ohlcv/hour · 60 candles', 'link'],
  ['rugcheck', 'summary · mint/freeze/LP', 'link'],
  ['pumpportal', 'ws newToken · migration', 'link'],
  ['claude -p', '--output-format stream-json · tools', 'local'],
  ['data store', 'sqlite cache · limiter · health registry', 'init'],
];

const FIXTURE_STEPS: Step[] = [
  ...LIVE_STEPS.slice(0, 6),
  ['fixtures', '34 tokens · 20 pairs · 6 watch · seed 7', 'loaded'],
];

export function renderBoot(c: Canvas, state: AppState): void {
  const t = c.theme;
  const v = state.vfx;
  const p = state.boot ? state.boot.t : 1;
  const steps = state.screener.source === 'fixtures' ? FIXTURE_STEPS : LIVE_STEPS;
  c.fill(0, 0, c.w, c.h, ' ', { bg: t.bg });
  c.rainZone(0, 0, c.w, c.h, 1);
  const cx = Math.floor(c.w / 2);
  const logoY = Math.max(2, Math.floor(c.h * 0.22));
  // logo settles as p grows; it glitches hard at first, then only on sporadic frames
  const intensity = p < 0.35 ? 0.9 - p : p < 0.85 ? 0.25 : 0.12;
  const logo = bootLogo(c, cx, logoY, v, intensity);
  const tag = 'terminal dex screener · claude inside';
  c.textC(0, logoY + 6, c.w, tag, { fg: t.muted, bg: t.bg });
  c.heading(cx - Math.floor(tag.length / 2), logoY + 6, tag.length);
  // keep the logo column clear of rain so it reads
  c.noRain(logo.x - 2, logo.y - 1, logo.w + 4, 9);
  // jacking-in lines reveal one by one between p=0.2 and p=0.85
  const boxW = Math.min(c.w - 8, 76);
  const bx = cx - Math.floor(boxW / 2);
  let y = logoY + 9;
  const frame = v.frame;
  const per = 0.65 / steps.length;
  const title = ' JACKING IN ';
  c.text(bx, y, title, { fg: '#000000', bg: t.borderFocus, b: true });
  c.text(bx + title.length + 1, y, `${c.w}×${c.h} · ${state.colorDepth} · ${state.theme.name}`, { fg: t.dim, bg: t.bg });
  c.noRain(bx - 1, y, boxW + 2, 2 + steps.length + 3);
  y += 2;
  for (let i = 0; i < steps.length; i++) {
    const [name, what, result] = steps[i];
    const start = 0.2 + i * per;
    if (p < start) break;
    const local = Math.min(1, (p - start) / per);
    const line = `${name.padEnd(14)} ${what}`;
    const revealed = Math.floor(local * 1.6 * line.length);
    const claude = name === 'claude -p';
    c.text(bx, y, '▸', { fg: claude ? t.ai : t.accent, bg: t.bg, b: true });
    decryptText(c, bx + 2, y, line, revealed, frame, { fg: claude ? t.ai : t.text, bg: t.bg }, boxW - 20, v.code);
    if (local >= 0.7) {
      const ok = result.startsWith('ok') || result === 'connected' || result === 'loaded' || result.startsWith('warm');
      c.textR(bx, y, boxW, result, { fg: t.mono ? (ok ? t.text : t.muted) : ok ? t.up : t.warn, bg: t.bg, b: true });
    } else {
      c.textR(bx, y, boxW, spinnerGlyph(frame) + ' ', { fg: t.ai, bg: t.bg, b: true });
    }
    y += 1;
  }
  if (p >= 0.9) {
    y += 1;
    const msg = '◉ JACKED IN · press any key';
    c.text(bx, y, msg, { fg: t.borderFocus, bg: mix(t.bg, t.borderFocus, 0.12), b: true });
    c.heading(bx, y, msg.length);
  }
}
