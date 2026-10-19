// @dexterm/agents — the tool executor and the live feed (task-1345, tier 2).
//
// The bus gates every call (identity, tier, closed schema, rate/quota) and ONLY THEN hands a read or
// navigation call to an AgentExecutor. Keeping execution behind an interface means the running TUI can
// back it with the real @dexterm/data layer (via the MCP tools) while tests and the fixture demo back it
// with deterministic data and never touch the network. The executor never sees a token, never signs, and
// cannot widen a capability — it only runs the name the gate already approved.

import { firewallText } from '@dexterm/data';
import type { AgentSession } from './gate.ts';

/** Topics an agent may subscribe to. Each pushed event is server-authored and firewalled. */
export const TOPICS = ['new_pairs', 'trades', 'alerts', 'screen'] as const;
export type Topic = (typeof TOPICS)[number];
export function isTopic(x: unknown): x is Topic { return typeof x === 'string' && (TOPICS as readonly string[]).includes(x); }

export interface AgentEvent { topic: Topic; seq: number; t: number; data: Record<string, unknown> }

// ---------------------------------------------------------------------------------------------------
// Outbound scrub (task-1345, tier 3): a belt-and-braces net over EVERY string an agent receives. The
// executor/source already firewalls untrusted token text (symbols, names, risk strings) into <untrusted>
// blocks, but the bus strips terminal-escape / C0-C1 / bidi / zero-width characters from every string
// leaf of a tool result and a pushed event too, so a buggy or compromised source can never carry an ANSI
// clear-screen, a right-to-left override, or a zero-width-join obfuscation into the agent (or, if the
// agent echoes it, into a terminal). Strip-only: it never truncates or re-wraps legitimate data.
// First remove whole ANSI escape sequences (CSI `ESC [ … letter` and OSC `ESC ] … BEL/ST`), so no printable
// payload like `[2J` is left behind, then strip any remaining C0/C1 control, bidi-override and zero-width.
const ANSI_SEQ = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
export function stripControl(s: string): string { return s.replace(ANSI_SEQ, '').replace(UNSAFE_CHARS, ''); }
export function scrubStrings<T>(v: T, depth = 0): T {
  if (depth > 8) return v;
  if (typeof v === 'string') return stripControl(v) as unknown as T;
  if (Array.isArray(v)) return v.map((x) => scrubStrings(x, depth + 1)) as unknown as T;
  if (v && typeof v === 'object') { const out: Record<string, unknown> = {}; for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[stripControl(k).slice(0, 128)] = scrubStrings(val, depth + 1); return out as unknown as T; }
  return v;
}

/** Runs a read/navigation/note call the gate already approved. Must be total: it returns `{ error }`, never throws. */
export interface AgentExecutor {
  exec(session: AgentSession, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** The live event source the bus fans out to subscribers. The TUI implements this over its LiveContext. */
export interface BusFeed {
  /** Register a listener; returns an unsubscribe fn. Emitted events are already firewalled. */
  on(listener: (ev: AgentEvent) => void): () => void;
  /** Optional current value for a topic, pushed once on subscribe (e.g. current screen state). */
  snapshot?(topic: Topic): Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------------------------------
// Fixtures: deterministic, offline, used by the bus tests, `trenchscope agent serve --fixtures` and the
// worked demo. Numbers are seeded and stable; symbols/names go through the firewall like live data.

const FIXTURE_ROWS = [
  { mint: 'FixtMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', symbol: 'TROLL', name: 'Troll Cat', launchpad: 'pump.fun', ageSec: 240, priceUsd: 0.00042, mcap: 420_000, liquidityUsd: 38_000, volH1: 120_000, holderCount: 410, organicScore: 62, freeze: false, mintAuth: false, lpLockedPct: 100, top10Pct: 18, rugScore: 12 },
  { mint: 'FixtMintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', symbol: 'MOONER', name: 'Mooner', launchpad: 'raydium', ageSec: 5400, priceUsd: 0.0131, mcap: 2_100_000, liquidityUsd: 190_000, volH1: 540_000, holderCount: 1900, organicScore: 71, freeze: false, mintAuth: false, lpLockedPct: 100, top10Pct: 22, rugScore: 8 },
  { mint: 'FixtMintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', symbol: 'RUGME', name: 'Totally Safe Inu 🚀', launchpad: 'pump.fun', ageSec: 90, priceUsd: 0.0000008, mcap: 15_000, liquidityUsd: 3200, volH1: 60_000, holderCount: 42, organicScore: 9, freeze: true, mintAuth: true, lpLockedPct: 0, top10Pct: 71, rugScore: 86 },
  { mint: 'FixtMintDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', symbol: 'GIGA', name: 'Gigabrain', launchpad: 'meteora', ageSec: 12_600, priceUsd: 0.21, mcap: 8_800_000, liquidityUsd: 760_000, volH1: 1_200_000, holderCount: 6100, organicScore: 80, freeze: false, mintAuth: false, lpLockedPct: 100, top10Pct: 14, rugScore: 5 },
] as const;

function fw(s: string): string { return firewallText(s, { max: 48 }).text; }
const now = (): number => Date.now();

export class FixtureExecutor implements AgentExecutor {
  /** agent_note writes land here so the fixture demo / tests can read them back. */
  readonly notes: Array<{ agent: string; mint: string; text: string; tag: string | null; t: number }> = [];
  /** navigation requests land here (the "app" would apply them). */
  readonly navigation: Array<{ agent: string; tool: string; args: Record<string, unknown> }> = [];

  async exec(session: AgentSession, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const byMint = (m: unknown) => FIXTURE_ROWS.find((r) => r.mint === m);
    switch (tool) {
      case 'screen_state':
        return { screen: 'screener', filter: '', sort: 'vol24:desc', selected: { mint: FIXTURE_ROWS[0].mint, symbol: FIXTURE_ROWS[0].symbol }, visibleMints: FIXTURE_ROWS.map((r) => r.mint), watchlist: [], actions: { enabled: true, mints: FIXTURE_ROWS.map((r) => r.mint), feeds: ['new', 'trending', 'all'], sortKeys: ['vol24', 'mcap', 'age', 'liq'] }, now: now() };
      case 'screener_query': {
        const preset = (args.preset as string) ?? 'trending';
        const rows = preset === 'new' ? [...FIXTURE_ROWS].sort((a, b) => a.ageSec - b.ageSec) : [...FIXTURE_ROWS].sort((a, b) => b.volH1 - a.volH1);
        const limit = Math.min(Number(args.limit ?? 20), 50);
        return { preset, now: now(), rows: rows.slice(0, limit).map((r) => ({ mint: r.mint, symbol: fw(r.symbol), launchpad: r.launchpad, tokenAgeSec: r.ageSec, priceUsd: r.priceUsd, mcap: r.mcap, liquidityUsd: r.liquidityUsd, volH1: r.volH1, holderCount: r.holderCount, organicScore: r.organicScore, audit: { mintAuthority: r.mintAuth, freezeAuthority: r.freeze, top10Pct: r.top10Pct, lpLockedPct: r.lpLockedPct, rugScore: r.rugScore }, source: 'fixtures', ageSec: 3 })) };
      }
      case 'get_token': {
        const r = byMint(args.mint) ?? FIXTURE_ROWS.find((x) => x.symbol.toUpperCase() === String(args.symbol ?? '').replace(/^\$/, '').toUpperCase());
        if (!r) return { error: 'unknown token (fixtures)' };
        return { token: { mint: r.mint, symbol: fw(r.symbol), name: fw(r.name), launchpad: r.launchpad }, pair: { priceUsd: r.priceUsd, mcap: r.mcap, liquidityUsd: r.liquidityUsd, source: 'fixtures', ageSec: 3 }, stats: { holderCount: r.holderCount, organicScore: r.organicScore }, audit: { mintAuthority: r.mintAuth, freezeAuthority: r.freeze, top10Pct: r.top10Pct, lpLockedPct: r.lpLockedPct, rugScore: r.rugScore }, now: now() };
      }
      case 'rugcheck': {
        const r = byMint(args.mint); if (!r) return { error: 'unknown token (fixtures)' };
        const risks: Array<{ name: string; level: string }> = [];
        if (r.freeze) risks.push({ name: 'freeze authority enabled', level: 'danger' });
        if (r.mintAuth) risks.push({ name: 'mint authority enabled', level: 'danger' });
        if (r.lpLockedPct < 100) risks.push({ name: 'LP not fully locked', level: 'warn' });
        if (r.top10Pct > 40) risks.push({ name: 'top-10 holders concentrated', level: 'warn' });
        return { mint: r.mint, scoreNormalised: r.rugScore, lpLockedPct: r.lpLockedPct, tokenProgram: 'Tokenkeg', risks, source: 'fixtures', ageSec: 3 };
      }
      case 'get_dev_history': {
        const r = byMint(args.mint); if (!r) return { error: 'unknown token (fixtures)' };
        return { mint: r.mint, creator: 'FixtDev1111111111111111111111111111111111111', creators: ['FixtDev1111111111111111111111111111111111111'], devHistory: null, snipers: null, bundledPct: null, tier: 'needs-key', note: 'prior-launch forensics need a key; keyless tier (fixtures)' };
      }
      case 'get_holders': {
        const r = byMint(args.mint); if (!r) return { error: 'unknown token (fixtures)' };
        return { mint: r.mint, top10PctExLp: r.top10Pct, holderCount: r.holderCount, holders: [], supply: 1e9, decimals: 6, source: 'fixtures', ageSec: 3 };
      }
      case 'get_trades': {
        const r = byMint(args.mint); if (!r) return { error: 'unknown token (fixtures)' };
        const washy = r.rugScore > 50;
        return { mint: r.mint, window: (args.window as string) ?? 'h1', count: 180, buys: 100, sells: 80, buyUsd: Math.round(r.volH1 * 0.55), sellUsd: Math.round(r.volH1 * 0.45), distinctWallets: washy ? 6 : 140, top2WalletVolumeSharePct: washy ? 68 : 9, source: 'fixtures', ageSec: 3 };
      }
      case 'get_candles': {
        const r = byMint(args.mint); if (!r) return { error: 'unknown token (fixtures)' };
        return { mint: r.mint, interval: (args.interval as string) ?? '1h', bars: 24, summary: { first: r.priceUsd * 0.8, last: r.priceUsd, high: r.priceUsd * 1.2, low: r.priceUsd * 0.7, changePct: 25, drawdownFromHighPct: -16.7, vwap: r.priceUsd * 0.95 }, source: 'fixtures', ageSec: 3 };
      }
      case 'get_dossier': {
        const r = byMint(args.mint) ?? FIXTURE_ROWS.find((x) => x.symbol.toUpperCase() === String(args.symbol ?? '').replace(/^\$/, '').toUpperCase());
        if (!r) return { error: 'unknown token (fixtures)' };
        const [token, rug, trades] = await Promise.all([this.exec(session, 'get_token', { mint: r.mint }), this.exec(session, 'rugcheck', { mint: r.mint }), this.exec(session, 'get_trades', { mint: r.mint, window: 'h1' })]);
        return { mint: r.mint, interval: (args.interval as string) ?? '1h', token, rugcheck: rug, trades, availability: { market: true, security: true, tape: true, canVerdict: true } };
      }
      case 'analyze_token': {
        const r = byMint(args.mint) ?? FIXTURE_ROWS.find((x) => x.symbol.toUpperCase() === String(args.symbol ?? '').replace(/^\$/, '').toUpperCase());
        if (!r) return { error: 'unknown token (fixtures)' };
        // A deterministic verdict from the fixture row's audit (mirrors the real pack's rule flags).
        const flags: string[] = [];
        if (r.freeze) flags.push('freeze_authority');
        if (r.mintAuth) flags.push('mint_authority');
        if (r.lpLockedPct < 100) flags.push('lp_unlocked');
        if (r.top10Pct > 40) flags.push('top10_concentrated');
        if (r.organicScore < 40) flags.push('organic_below_40');
        if (r.ageSec < 600) flags.push('under_10_minutes');
        const verdict = r.rugScore >= 60 ? 'AVOID' : r.rugScore >= 25 ? 'SPECULATIVE' : 'WATCH';
        return { pack: 'token-dossier', pack_version: 'fixtures', model_output: false, mint: r.mint, symbol: fw(r.symbol), deterministic_verdict: verdict, rug_probability: r.rugScore / 100, rug_model: 'H1-v0.1', flags, injection_suspected: false, note: 'Deterministic code stage (no model) on fixtures.', source: 'fixtures' };
      }
      case 'narrative_board':
        return { pack: 'narrative-board', model_output: false, narratives: [], note: 'No recorded history on fixtures (the board needs a running recorder).' };
      case 'rug_backtest':
        return { pack: 'rug-backtest', model_output: false, note: 'No recorded history on fixtures (a backtest needs recorded t0 snapshots with labelled outcomes).' };
      case 'open_token': case 'show_in_screener': case 'switch_feed':
        this.navigation.push({ agent: session.agentName, tool, args });
        return { ok: true, note: 'The app applies this and shows "<agent> did X". You cannot confirm, size, or send a trade.' };
      case 'agent_note': {
        const text = fw(String(args.text ?? ''));
        const tag = args.tag ? fw(String(args.tag)) : null;
        this.notes.push({ agent: session.agentName, mint: String(args.mint), text, tag, t: now() });
        return { ok: true, note: 'note attached and labelled with your agent name', text, tag };
      }
      default:
        return { error: `fixture executor has no handler for ${tool}` };
    }
  }
}

/** A feed that tests/the demo drive by calling emit(); an optional timer makes it tick on its own. */
export class FixtureFeed implements BusFeed {
  private listeners = new Set<(ev: AgentEvent) => void>();
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  on(listener: (ev: AgentEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  snapshot(topic: Topic): Record<string, unknown> | null {
    if (topic === 'screen') return { screen: 'screener', filter: '', selected: FIXTURE_ROWS[0].mint };
    return null;
  }
  emit(topic: Topic, data: Record<string, unknown>): AgentEvent {
    const ev: AgentEvent = { topic, seq: ++this.seq, t: now(), data };
    for (const l of this.listeners) { try { l(ev); } catch { /* one bad listener never stops the fan-out */ } }
    return ev;
  }
  /** Start a deterministic cycle of events (for the demo). Unref'd so it never keeps the process alive. */
  start(intervalMs = 1500): void {
    if (this.timer) return;
    let i = 0;
    this.timer = setInterval(() => {
      const r = FIXTURE_ROWS[i % FIXTURE_ROWS.length]; i++;
      if (i % 3 === 0) this.emit('new_pairs', { mint: r.mint, symbol: fw(r.symbol), launchpad: r.launchpad, ageSec: 5 });
      else if (i % 3 === 1) this.emit('trades', { mint: r.mint, side: i % 2 ? 'buy' : 'sell', usd: 1200 + i * 10, priceUsd: r.priceUsd });
      else this.emit('alerts', { mint: r.mint, kind: 'volume_spike', note: fw(`${r.symbol} volume spiked`) });
    }, intervalMs);
    (this.timer as { unref?: () => void }).unref?.();
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
