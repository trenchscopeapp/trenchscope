// trenchscope — live NEW PAIRS binding (task-1298). Rows arrive by push from PumpPortal's free create stream
// (one connection, reconnect with backoff, recordable and replayable) and are enriched by polling:
//   Jupiter `recent` (15 s)       holders, organic, stats for mints Jupiter already indexed; also the fallback
//                                 row source while PumpPortal is down (health registry)
//   RugCheck `new_tokens` (30 s)  creator + authority cross-check per fresh mint
//   DexScreener + Jupiter search (10 s) for the visible rows: price, liquidity, deltas, buys/sells
// Every create carries receive → row → (drawn) timestamps so the event-to-row latency is measured, not guessed.
import type { Create, DataLayer, Launchpad, PumpEvent, PumpPortalClient, PumpStatus, RugNewToken, SourceId, StreamRecording } from '@dexterm/data';
import { SOL_MINT } from '../state.ts';
import { cleanText, deriveFlags, impliedSpark, type RiskFlag } from '../screener/rows.ts';

export const RECENT_POLL_MS = 15_000;
export const NEW_TOKENS_POLL_MS = 30_000;
export const ENRICH_POLL_MS = 10_000;
export const MAX_ROWS = 200;
/** pump.fun graduates at ~$69K market cap (SPEC §4.4). */
export const PUMP_GRADUATION_USD = 69_000;

export interface NewPairRow {
  mint: string;
  symbol: string;
  name: string;
  launchpad: Launchpad;
  creator: string | null;
  /** Epoch ms when the launch was first seen (PumpPortal receive time, or the source's creation time). */
  createdAt: number;
  /** Local ms when the row entered the table; `latencyMs` = rowAt − receivedAt for pushed rows. */
  rowAt: number;
  receivedAt: number | null;
  latencyMs: number | null;
  /** Set by the UI loop when the frame carrying this row was flushed. */
  drawnAt: number | null;
  bonding: number | null;
  migrated: boolean;
  marketCapSol: number | null;
  mcap: number | null;
  price: number | null;
  liq: number | null;
  vol: number | null;
  chg: { m5: number | null; h1: number | null };
  holders: number | null;
  buys: number | null;
  sells: number | null;
  dev: number | null;
  org: number | null;
  mintAuth: boolean | null;
  freezeAuth: boolean | null;
  initialBuySol: number | null;
  spark: number[] | undefined;
  flags: RiskFlag[];
  socials: { x: boolean; tg: boolean; web: boolean };
  /** Coin image URL from Jupiter / DexScreener once a poll has seen the mint (task-1326); null before. */
  image: string | null;
  /** Sources that contributed, in arrival order. */
  via: SourceId[];
}

export interface LatencyStats {
  n: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface NewPairsStatus {
  stream: PumpStatus | null;
  mode: 'live' | 'replay' | 'off';
  /** Caption for the table box, e.g. `ws: pumpportal 14/min · jup recent · rugcheck`. */
  caption: string;
  /** Header status override when the push feed is down. */
  headerStatus?: string;
  createsPerMin: number | null;
  latency: LatencyStats;
  renderLatency: LatencyStats;
  errors: Partial<Record<SourceId, string>>;
}

export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

export function latencyStats(xs: number[]): LatencyStats {
  return { n: xs.length, p50: percentile(xs, 50), p95: percentile(xs, 95), max: xs.length ? Math.max(...xs) : null };
}

export interface NewPairsLiveOptions {
  now?: () => number;
  /** Fires after any row change (the interactive loop redraws immediately). */
  onChange?: (reason: 'create' | 'migrate' | 'poll' | 'status') => void;
  limit?: number;
  /** Which polls to run (tests switch some off). */
  polls?: { recent?: boolean; newTokens?: boolean; enrich?: boolean };
}

export class NewPairsLive {
  readonly dl: DataLayer;
  private readonly now: () => number;
  private readonly onChange?: NewPairsLiveOptions['onChange'];
  /** 0.1.5 dev history: called once per row when its creator becomes known (the recorder stores the link). */
  onCreator?: (mint: string, creator: string, source: 'pumpportal' | 'rugcheck', createdAt: number | null) => void;
  private readonly limit: number;
  private readonly polls: Required<NonNullable<NewPairsLiveOptions['polls']>>;
  readonly rows = new Map<string, NewPairRow>();
  private client: PumpPortalClient | null = null;
  private mode: NewPairsStatus['mode'] = 'off';
  private lastRecent = 0;
  private lastNewTokens = 0;
  private lastEnrich = 0;
  private createTimes: number[] = [];
  private latencies: number[] = [];
  private renderLatencies: number[] = [];
  private solPrice: number | null = null;
  errors: Partial<Record<SourceId, string>> = {};
  refreshing = false;
  /** Creator / authority facts from RugCheck by mint (kept even for mints not yet in `rows`). */
  private readonly fresh = new Map<string, RugNewToken>();

  constructor(dl: DataLayer, opts: NewPairsLiveOptions = {}) {
    this.dl = dl;
    this.now = opts.now ?? (() => Date.now());
    this.onChange = opts.onChange;
    this.limit = opts.limit ?? MAX_ROWS;
    this.polls = { recent: true, newTokens: true, enrich: true, ...opts.polls };
  }

  /** Seed the SOL price (e.g. from the screener feed) so SOL-denominated market caps show before the first poll. */
  setSolPrice(price: number | null | undefined): void {
    if (price && price > 0) {
      this.solPrice = price;
      for (const row of this.rows.values()) if (row.mcap === null && row.marketCapSol !== null) row.mcap = row.marketCapSol * price;
    }
  }

  /** Attach a PumpPortal client (live or for replay). The client is started by start(). */
  attach(client: PumpPortalClient, mode: 'live' | 'replay' = 'live'): void {
    this.client = client;
    this.mode = mode;
  }

  /** Route one stream event (the client's onEvent). */
  handleEvent(ev: PumpEvent): void {
    if (ev.kind === 'create') this.addCreate(ev.create);
    else if (ev.kind === 'migrate' && ev.mint) {
      const row = this.rows.get(ev.mint);
      if (row) { row.migrated = true; row.bonding = 100; this.onChange?.('migrate'); }
    }
  }

  start(): void {
    if (this.mode === 'live') this.client?.start();
  }

  stop(): void {
    this.client?.stop();
  }

  /** Replay a recorded stream through the same path (tests / --replay). */
  replay(rec: StreamRecording, speed = 0): Promise<number> {
    if (!this.client) throw new Error('no client attached for replay');
    this.mode = 'replay';
    return this.client.replay(rec, speed);
  }

  private tellCreator(mint: string, creator: string, source: 'pumpportal' | 'rugcheck', createdAt: number | null): void {
    try { this.onCreator?.(mint, creator, source, createdAt); } catch { /* the recorder must never break the feed */ }
  }

  private addCreate(c: Create): void {
    const rowAt = this.now();
    const existing = this.rows.get(c.mint);
    const fresh = this.fresh.get(c.mint);
    const mcap = c.marketCapSol !== null && this.solPrice ? c.marketCapSol * this.solPrice : existing?.mcap ?? null;
    const row: NewPairRow = existing ?? {
      mint: c.mint, symbol: cleanText(c.symbol, 12) || '?', name: cleanText(c.name, 40), launchpad: c.launchpad, creator: c.creator || fresh?.creator || null,
      createdAt: c.receivedAt, rowAt, receivedAt: c.receivedAt, latencyMs: Math.max(0, rowAt - c.receivedAt), drawnAt: null,
      bonding: c.bondingPct, migrated: false, marketCapSol: c.marketCapSol, mcap, price: null, liq: null, vol: null, chg: { m5: null, h1: null },
      holders: null, buys: null, sells: null, dev: null, org: null,
      mintAuth: fresh?.mintAuthority ?? null, freezeAuth: fresh?.freezeAuthority ?? null,
      initialBuySol: c.initialBuySol, spark: undefined, flags: [], socials: { x: false, tg: false, web: false }, image: null, via: ['pumpportal'],
    };
    if (existing) {
      existing.bonding = c.bondingPct ?? existing.bonding;
      existing.marketCapSol = c.marketCapSol ?? existing.marketCapSol;
      if (!existing.via.includes('pumpportal')) existing.via.push('pumpportal');
    } else {
      this.rows.set(c.mint, row);
      if (row.creator) this.tellCreator(c.mint, row.creator, c.creator ? 'pumpportal' : 'rugcheck', row.createdAt);
      this.latencies.push(row.latencyMs!);
      if (this.latencies.length > 500) this.latencies.shift();
    }
    this.createTimes.push(rowAt);
    this.createTimes = this.createTimes.filter((t) => t > rowAt - 60_000);
    this.trim();
    this.onChange?.('create');
  }

  private trim(): void {
    if (this.rows.size <= this.limit) return;
    const sorted = this.list();
    for (const r of sorted.slice(this.limit)) this.rows.delete(r.mint);
  }

  /** Newest first. */
  list(): NewPairRow[] {
    return [...this.rows.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Mark rows as drawn (called by the UI after a flush) and record receive→draw latency once per row. */
  markDrawn(at: number = this.now()): void {
    for (const r of this.rows.values()) {
      if (r.drawnAt === null && r.receivedAt !== null) {
        r.drawnAt = at;
        this.renderLatencies.push(Math.max(0, at - r.receivedAt));
        if (this.renderLatencies.length > 500) this.renderLatencies.shift();
      }
    }
  }

  /** Run whichever polls are due. Never throws; errors land in `errors`. */
  async refresh(force = false): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const now = this.now();
      const jobs: Promise<void>[] = [];
      const pushDown = !this.dl.health.isAvailable('pumpportal') || (this.mode === 'live' && this.client?.getStatus().state !== 'open');
      if (this.polls.recent && (force || now - this.lastRecent >= RECENT_POLL_MS || (pushDown && now - this.lastRecent >= RECENT_POLL_MS / 3))) {
        this.lastRecent = now;
        jobs.push(this.pollRecent(pushDown));
      }
      if (this.polls.newTokens && (force || now - this.lastNewTokens >= NEW_TOKENS_POLL_MS)) {
        this.lastNewTokens = now;
        jobs.push(this.pollNewTokens());
      }
      if (this.polls.enrich && (force || now - this.lastEnrich >= ENRICH_POLL_MS)) {
        this.lastEnrich = now;
        jobs.push(this.pollEnrich());
      }
      await Promise.all(jobs);
      if (jobs.length) this.onChange?.('poll');
    } finally {
      this.refreshing = false;
    }
  }

  private async pollRecent(addRows: boolean): Promise<void> {
    try {
      const views = await this.dl.jupiter.recent();
      delete this.errors['jupiter-tokens'];
      const now = this.now();
      for (const v of views) {
        let row = this.rows.get(v.token.mint);
        if (!row) {
          if (!addRows) continue;
          const created = v.token.createdAt ?? now;
          row = {
            mint: v.token.mint, symbol: cleanText(v.token.symbol, 12) || '?', name: cleanText(v.token.name, 40), launchpad: v.token.launchpad, creator: null,
            createdAt: created, rowAt: now, receivedAt: null, latencyMs: null, drawnAt: null, bonding: null, migrated: false, marketCapSol: null,
            mcap: null, price: null, liq: null, vol: null, chg: { m5: null, h1: null }, holders: null, buys: null, sells: null, dev: null, org: null,
            mintAuth: null, freezeAuth: null, initialBuySol: null, spark: undefined, flags: [], socials: { x: false, tg: false, web: false }, image: null, via: [],
          };
          this.rows.set(row.mint, row);
        }
        this.applyJup(row, v);
      }
      this.trim();
    } catch (err) {
      this.errors['jupiter-tokens'] = msg(err);
    }
  }

  private applyJup(row: NewPairRow, v: { token: { launchpad: Launchpad; createdAt: number | null; image?: string | null; socials: { x: string | null; tg: string | null; web: string | null } }; stats: { holderCount: number | null; organicScore: number | null }; audit: { mintAuthority: boolean | null; freezeAuthority: boolean | null; devPct: number | null; top10Pct: number | null }; pair: { priceUsd: number; mcap: number | null; fdv: number | null; liquidityUsd: number | null; volume: { h24: number | null }; txns: { m5: { buys: number; sells: number } }; priceChange: { m5: number | null; h1: number | null } } }): void {
    if (row.launchpad === 'unknown') row.launchpad = v.token.launchpad;
    row.holders = v.stats.holderCount ?? row.holders;
    row.org = v.stats.organicScore ?? row.org;
    row.dev = v.audit.devPct ?? row.dev;
    if (row.mintAuth === null) row.mintAuth = v.audit.mintAuthority;
    if (row.freezeAuth === null) row.freezeAuth = v.audit.freezeAuthority;
    if (v.pair.priceUsd > 0) row.price = v.pair.priceUsd;
    row.mcap = v.pair.mcap ?? v.pair.fdv ?? row.mcap;
    row.liq = v.pair.liquidityUsd ?? row.liq;
    row.vol = v.pair.volume.h24 ?? row.vol;
    row.buys = v.pair.txns.m5.buys;
    row.sells = v.pair.txns.m5.sells;
    row.chg = { m5: v.pair.priceChange.m5 ?? row.chg.m5, h1: v.pair.priceChange.h1 ?? row.chg.h1 };
    row.socials = { x: !!v.token.socials.x, tg: !!v.token.socials.tg, web: !!v.token.socials.web };
    if (row.image === null && typeof v.token.image === 'string' && /^https?:\/\//i.test(v.token.image)) row.image = v.token.image;
    row.spark = impliedSpark(row.price, { m5: row.chg.m5, h1: row.chg.h1, h6: null, h24: null }, 12);
    if (!row.via.includes('jupiter-tokens')) row.via.push('jupiter-tokens');
    row.flags = deriveFlags({ mintAuth: row.mintAuth, freezeAuth: row.freezeAuth, top10: v.audit.top10Pct, dev: row.dev, bundled: null, lpLocked: row.launchpad === 'pump.fun' ? 100 : null });
  }

  private async pollNewTokens(): Promise<void> {
    try {
      const list = await this.dl.rugcheck.newTokens();
      delete this.errors.rugcheck;
      for (const t of list) {
        this.fresh.set(t.mint, t);
        const row = this.rows.get(t.mint);
        if (!row) continue;
        if (!row.creator && t.creator) this.tellCreator(t.mint, t.creator, 'rugcheck', row.createdAt);
        row.creator = row.creator ?? t.creator;
        if (t.mintAuthority !== null) row.mintAuth = t.mintAuthority;
        if (t.freezeAuthority !== null) row.freezeAuth = t.freezeAuthority;
        if (!row.via.includes('rugcheck')) row.via.push('rugcheck');
        row.flags = deriveFlags({ mintAuth: row.mintAuth, freezeAuth: row.freezeAuth, top10: null, dev: row.dev, bundled: null, lpLocked: row.launchpad === 'pump.fun' ? 100 : null });
      }
      if (this.fresh.size > 500) for (const k of [...this.fresh.keys()].slice(0, this.fresh.size - 500)) this.fresh.delete(k);
    } catch (err) {
      this.errors.rugcheck = msg(err);
    }
  }

  private async pollEnrich(): Promise<void> {
    const visible = this.list().slice(0, 29).map((r) => r.mint);
    try {
      const res = await this.dl.store.enrich([...visible, SOL_MINT], { price: false });
      delete this.errors.dexscreener;
      for (const r of res.rows) {
        if (r.mint === SOL_MINT) {
          if (r.pair.priceUsd > 0) this.solPrice = r.pair.priceUsd;
          continue;
        }
        const row = this.rows.get(r.mint);
        if (!row) continue;
        const p = r.pair;
        if (p.priceUsd > 0) row.price = p.priceUsd;
        row.liq = p.liquidityUsd ?? row.liq;
        row.mcap = r.mcap?.value ?? p.mcap ?? p.fdv ?? row.mcap;
        row.vol = p.volume.h24 ?? row.vol;
        row.chg = { m5: p.priceChange.m5 ?? row.chg.m5, h1: p.priceChange.h1 ?? row.chg.h1 };
        row.buys = p.txns.m5.buys;
        row.sells = p.txns.m5.sells;
        if (r.stats) { row.holders = r.stats.holderCount ?? row.holders; row.org = r.stats.organicScore ?? row.org; }
        if (r.audit) { row.dev = r.audit.devPct ?? row.dev; if (row.mintAuth === null) row.mintAuth = r.audit.mintAuthority; if (row.freezeAuth === null) row.freezeAuth = r.audit.freezeAuthority; }
        if (row.image === null && typeof r.token.image === 'string' && /^https?:\/\//i.test(r.token.image)) row.image = r.token.image;
        row.spark = impliedSpark(row.price, { m5: row.chg.m5, h1: row.chg.h1, h6: p.priceChange.h6, h24: p.priceChange.h24 }, 12);
        for (const s of r.sources) if (!row.via.includes(s)) row.via.push(s);
        row.flags = deriveFlags({ mintAuth: row.mintAuth, freezeAuth: row.freezeAuth, top10: r.audit?.top10Pct ?? null, dev: row.dev, bundled: null, lpLocked: row.launchpad === 'pump.fun' ? 100 : null });
      }
      Object.assign(this.errors, res.errors);
      // SOL price arrived: convert the SOL-denominated market caps of rows nobody else priced yet
      if (this.solPrice) for (const row of this.rows.values()) if (row.mcap === null && row.marketCapSol !== null) row.mcap = row.marketCapSol * this.solPrice;
    } catch (err) {
      this.errors.dexscreener = msg(err);
    }
  }

  status(): NewPairsStatus {
    const stream = this.client?.getStatus() ?? null;
    const h = this.dl.health;
    const perMin = this.createTimes.filter((t) => t > this.now() - 60_000).length;
    const parts: string[] = [];
    let headerStatus: string | undefined;
    if (this.mode === 'off') parts.push('push off');
    else if (this.mode === 'replay') parts.push(`replay: pumpportal ${stream?.creates ?? 0} creates`);
    else if (stream?.state === 'open') parts.push(`ws: pumpportal ${perMin}/min`);
    else {
      const wait = stream?.nextRetryMs ? ` in ${Math.round(stream.nextRetryMs / 1000)}s` : '';
      parts.push(`pumpportal ${stream?.state ?? 'off'}${wait} · polling jup recent`);
      headerStatus = '◐ degraded: pumpportal';
    }
    if (this.polls.recent) parts.push(h.isAvailable('jupiter-tokens') ? 'jup recent' : 'jup degraded');
    if (this.polls.newTokens) parts.push(h.isAvailable('rugcheck') ? 'rugcheck' : 'rugcheck degraded');
    if (this.polls.enrich && !h.isAvailable('dexscreener')) parts.push('dexscreener degraded');
    const degraded = (['jupiter-tokens', 'rugcheck', 'dexscreener'] as SourceId[]).filter((s) => !h.isAvailable(s));
    if (!headerStatus && degraded.length) headerStatus = `◐ degraded: ${degraded.map((s) => (s === 'jupiter-tokens' ? 'jup' : s)).join(', ')}`;
    return {
      stream, mode: this.mode, caption: parts.join(' · '), headerStatus, createsPerMin: this.mode === 'live' ? perMin : null,
      latency: latencyStats(this.latencies), renderLatency: latencyStats(this.renderLatencies), errors: this.errors,
    };
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
