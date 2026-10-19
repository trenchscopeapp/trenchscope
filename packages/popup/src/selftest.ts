// trenchscope popup host — `trenchscope popup --self-test` (task-1290).
//
// the tester may be on another machine with the Mac screen locked, so this does NOT block on a live
// 60 fps display or a live hotkey press. It reports what it CAN measure headlessly — the shell choice, whether
// the global hotkey registered, and the frame rate the popup actually renders at — and clearly labels the one
// thing that needs an unlocked display (confirming 60 fps and pressing the chord). It never claims 60 fps; it
// reports the measured number and whether the environment looked able to produce it.
import { createPopupManager } from './open.ts';
import { loadConfig, type PopupConfig } from './config.ts';
import { createPopupHost, displayAvailable } from './host.ts';
import type { ChartVM, RosterVM, NarrativeBoardVM, SpectatorPopupVM, ServerEvent, ThemeTokens } from './protocol.ts';

export interface SelfTestResult {
  shell: 'wry' | 'browser';
  reason: string;
  hotkey: string;
  hotkeyRegistered: boolean;
  /** Mean fps across the measurement window, or null when no native popup rendered (browser fallback). */
  fps: number | null;
  fpsP95FrameMs: number | null;
  openToReadyMs: number | null;
  /** `typeof window.__pwned` reported by the page — must be "undefined" (hostile-name canary). */
  pwned: string | null;
  samples: number;
  /** True when a GUI display looked reachable; false means fps could not be measured meaningfully. */
  displayReachable: boolean;
  /** What still needs a human at an unlocked Mac. */
  needsHuman: string[];
  errors: string[];
}

/** A deterministic, network-free candle series for the self-test popup (not real market data). */
export function fixtureChartVM(): ChartVM {
  const now = Date.now();
  const candles = [];
  let price = 0.0021;
  let seed = 1337;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 120; i > 0; i--) {
    const o = price;
    const drift = (rnd() - 0.48) * 0.06;
    const c = Math.max(1e-6, o * (1 + drift));
    const h = Math.max(o, c) * (1 + rnd() * 0.02);
    const l = Math.min(o, c) * (1 - rnd() * 0.02);
    candles.push({ t: now - i * 3_600_000, o, h, l, c, v: 1000 + rnd() * 50000 });
    price = c;
  }
  return {
    symbol: 'SELFTEST', name: 'popup self-test', mint: 'Se1fTeStMintAddr1111111111111111111111111', interval: '1h',
    price, chg: { m5: 1, h1: 3, h6: -2, h24: 12 }, liq: 250_000, vol24: 1_800_000, mcap: 4_200_000,
    candles, openBarT: candles[candles.length - 1].t, updatedAt: now,
  };
}

/** A deterministic, network-free roster for the roster popup self-test / demo (task-1345). Not real agents. */
export function fixtureRosterVM(): RosterVM {
  const now = Date.now();
  return {
    now, busPort: 48916,
    agents: [
      { id: 'a1', name: 'claude-code', tier: 'propose', sessions: 1, client: 'claude-code 2.1', lastActivity: now - 4000, topics: ['new_pairs', 'alerts'], reads: 12, readsLimit: 120, proposals: 2, proposalsLimit: 20, refused: 0, paused: false, floodPausedUntil: null },
      { id: 'a2', name: 'scanbot', tier: 'observe', sessions: 1, client: 'python-sdk', lastActivity: now - 1200, topics: ['trades'], reads: 44, readsLimit: 120, proposals: 0, proposalsLimit: 20, refused: 0, paused: false, floodPausedUntil: null },
      { id: 'a3', name: 'rogue', tier: 'observe', sessions: 1, client: 'unknown', lastActivity: now - 800, topics: [], reads: 3, readsLimit: 120, proposals: 0, proposalsLimit: 20, refused: 27, paused: true, floodPausedUntil: now + 240000 },
    ],
    audit: [
      { t: now - 800, agent: 'rogue', kind: 'refused', tool: 'arm_plan', ok: false, detail: 'never: no agent may do that at any tier' },
      { t: now - 1200, agent: 'scanbot', kind: 'call', tool: 'get_trades', ok: true, detail: 'get_trades Fixt…' },
      { t: now - 4000, agent: 'claude-code', kind: 'proposal', tool: 'propose_alert', ok: true, detail: 'alert Fixt… when mcap crosses 1M' },
      { t: now - 6000, agent: 'claude-code', kind: 'connect', tool: '-', ok: true, detail: 'tier propose · claude-code 2.1' },
    ],
  };
}

/** A deterministic, network-free narrative board for the popup self-test / demo (task-1356). Not real tokens. */
export function fixtureNarrativeVM(): NarrativeBoardVM {
  return {
    title: 'narrative board', window: '1h', tokens_total: 42, unclassified_pct: 14, copycats: 6,
    data_age: '5s', lexicon_version: '0.1.0',
    rows: [
      { narrative: 'dogs', rank: 1, score: 74, tokens: 8, new_1h: 1, new_24h: 5, vol: 250000, pace: 1.4, med_chg: 10, runner: { symbol: 'WIF', chg: 40, mcap: 2_000_000 } },
      { narrative: 'ai-agents', rank: 2, score: 70, tokens: 6, new_1h: 2, new_24h: 7, vol: 190000, pace: 1.1, med_chg: 6, runner: { symbol: 'GPT', chg: 22, mcap: 1_100_000 } },
      { narrative: 'cats', rank: 3, score: 60, tokens: 5, new_1h: 0, new_24h: 3, vol: 130000, pace: null, med_chg: -3, runner: null },
      { narrative: 'unclassified', rank: null, score: null, tokens: 6, new_1h: 1, new_24h: 2, vol: 0, pace: null, med_chg: null, runner: null },
    ],
    limits: 'model output: none (deterministic lexicon v0.1.0). Name-based: X/Telegram-only narratives are missed; 6 copycat symbols.',
  };
}

/** A deterministic, network-free spectator view for the popup self-test / demo (task-1406). Not real agents. */
export function fixtureSpectatorVM(): SpectatorPopupVM {
  const now = Date.now();
  return {
    title: 'watch the agent cook', now, redacted: true, control: 'agent',
    screen: { screen: 'token', selectedMint: 'Fixt…AAAA', feed: 'new', filter: null, highlight: null },
    agents: [
      { name: 'claude-code', tier: 'propose', status: 'active', lastAt: now - 1200 },
      { name: 'scanbot', tier: 'observe', status: 'paused', lastAt: now - 8000 },
    ],
    activity: [
      { seq: 1, t: now - 8000, phase: 'connect', agent: 'claude-code', tier: 'propose', tool: null, summary: 'connected · claude-code 2.1', ms: null, dataAgeSec: null, ok: true, refusal: null },
      { seq: 2, t: now - 5000, phase: 'nav', agent: 'claude-code', tier: 'propose', tool: 'open_token', summary: 'open Fixt…AAAA', ms: 6, dataAgeSec: null, ok: true, refusal: null },
      { seq: 3, t: now - 4200, phase: 'result', agent: 'claude-code', tier: 'propose', tool: 'rugcheck', summary: 'rugcheck Fixt…', ms: 42, dataAgeSec: 3, ok: true, refusal: null },
      { seq: 4, t: now - 2000, phase: 'proposal', agent: 'claude-code', tier: 'propose', tool: 'propose_alert', summary: 'alert when mcap crosses 1M', ms: 2, dataAgeSec: null, ok: true, refusal: null },
      { seq: 5, t: now - 1000, phase: 'refused', agent: 'scanbot', tier: 'observe', tool: 'arm_plan', summary: 'refused: no agent may do that at any tier', ms: null, dataAgeSec: null, ok: false, refusal: 'never' },
    ],
  };
}

export interface SelfTestOptions {
  seconds?: number;
  forceBrowser?: boolean;
  theme?: ThemeTokens;
  env?: NodeJS.ProcessEnv;
  /** Override the platform (tests exercise the browser fallback without launching a real browser). */
  platform?: NodeJS.Platform;
}

/** Run the self-test and resolve with the measured result. Always cleans up the window host and server. */
export async function runSelfTest(opts: SelfTestOptions = {}): Promise<SelfTestResult> {
  const seconds = Math.max(2, Math.min(30, opts.seconds ?? 6));
  const env = opts.env ?? process.env;
  const cfg: PopupConfig = loadConfig(env);
  const decision = createPopupHost({ hotkey: cfg.hotkey, forceBrowser: opts.forceBrowser, env, platform: opts.platform });
  const displayReachable = displayAvailable(env, opts.platform);
  const result: SelfTestResult = {
    shell: decision.native ? 'wry' : 'browser',
    reason: decision.reason,
    hotkey: cfg.hotkey || '(disabled)',
    hotkeyRegistered: false,
    fps: null, fpsP95FrameMs: null, openToReadyMs: null, pwned: null, samples: 0,
    displayReachable,
    needsHuman: [], errors: [],
  };

  const perfFps: number[] = [];
  const perfP95: number[] = [];
  const mgr = createPopupManager({
    theme: opts.theme, hotkey: cfg.hotkey, rain: cfg.rain, forceBrowser: opts.forceBrowser, env, platform: opts.platform,
    onWarn: (m) => result.errors.push(m),
    onEvent: (ev: ServerEvent) => {
      if (ev.ev === 'popup.ready') result.openToReadyMs = ev.openToReadyMs;
      else if (ev.ev === 'popup.perf') { perfFps.push(ev.fps); perfP95.push(ev.p95Ms); result.pwned = ev.pwned; result.samples++; }
      else if (ev.ev === 'popup.log') result.errors.push(`page: ${ev.msg}`);
      else if (ev.ev === 'probe.rejected') result.errors.push(`probe rejected: ${ev.reason}`);
    },
  });

  try {
    await mgr.open({ kind: 'chart', title: 'self-test', data: fixtureChartVM() });
    result.shell = mgr.native ? 'wry' : 'browser';
    result.reason = mgr.reason;
    result.hotkeyRegistered = mgr.hotkeyRegistered;
    if (mgr.native) {
      await new Promise<void>((r) => setTimeout(r, seconds * 1000));
      if (perfFps.length) {
        result.fps = +(perfFps.reduce((s, v) => s + v, 0) / perfFps.length).toFixed(1);
        result.fpsP95FrameMs = +(perfP95.reduce((s, v) => s + v, 0) / perfP95.length).toFixed(2);
      }
    }
  } catch (err) {
    result.errors.push((err as Error).message);
  } finally {
    await mgr.shutdown();
  }

  // Honest labelling of what a headless / locked run cannot settle.
  if (result.shell === 'browser') {
    result.needsHuman.push('Native frameless shell not exercised (browser fallback). Build it: `npm run build:shell` in packages/popup, then re-run on the Mac.');
  } else {
    if (!result.samples) result.needsHuman.push('No frame samples arrived — the page may not have rendered (locked/occluded display). Re-run at an unlocked Mac.');
    if (result.fps != null && result.fps < 55) result.needsHuman.push(`Measured ${result.fps} fps. WebKit throttles rAF behind a locked/occluded screen; confirm 60 fps at an UNLOCKED, unloaded Mac before claiming it.`);
    result.needsHuman.push(`Hotkey ${result.hotkey} ${result.hotkeyRegistered ? 'registered' : 'NOT registered'}; a live press can only be confirmed by a human at the Mac (press the chord from any app and watch a popup toggle).`);
  }
  return result;
}

/** Render a SelfTestResult as a short terminal report. `color` adds ANSI (default: plain). */
export function renderSelfTest(r: SelfTestResult, color = false): string {
  const c = (code: string, s: string): string => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const ok = (b: boolean): string => (b ? c('32', 'yes') : c('31', 'no'));
  const lines: string[] = [];
  lines.push(c('1', 'trenchscope popup — self-test'));
  lines.push(`  window shell      ${r.shell === 'wry' ? c('32', 'wry (frameless HUD)') : c('33', 'browser fallback')}  — ${r.reason}`);
  lines.push(`  display reachable ${ok(r.displayReachable)}`);
  lines.push(`  global hotkey     ${r.hotkey}  registered: ${ok(r.hotkeyRegistered)}`);
  lines.push(`  open → ready      ${r.openToReadyMs != null ? r.openToReadyMs + ' ms' : '—'}`);
  lines.push(`  fps (measured)    ${r.fps != null ? `${r.fps} fps · p95 frame ${r.fpsP95FrameMs} ms · ${r.samples} samples` : '— (no native render)'}`);
  lines.push(`  page canary       window.__pwned = ${r.pwned ?? '—'} ${r.pwned === 'undefined' ? c('32', '(inert ✓)') : ''}`);
  if (r.errors.length) { lines.push(c('33', '  notes:')); for (const e of r.errors.slice(0, 8)) lines.push(`    · ${e}`); }
  if (r.needsHuman.length) { lines.push(c('1', '  needs a human at an unlocked Mac:')); for (const h of r.needsHuman) lines.push(`    → ${h}`); }
  return lines.join('\n');
}
