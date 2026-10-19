// trenchscope — the screener's view row. One shape for both data paths:
//   fromFixture()  maps the seeded FixtureToken (demo / snapshot parity with the prototype)
//   fromSnapshot() maps @dexterm/data's EnrichedRow (the real store, D-02/D-04)
// Live rows carry null where the keyless sources do not say (snipers, bundled, LP locked until
// RugCheck lands in D-06); the screen renders those as a dim dash instead of a fake number.
import type { EnrichedRow, Launchpad, SourceId } from '@dexterm/data';
import type { FixtureToken } from '../fixtures.ts';

export type RiskFlag = 'MINT' | 'FREEZE' | 'TOP10' | 'DEV' | 'BUNDLE' | 'LP' | 'DEAD';

/**
 * How much of the safety audit actually came back for a row. `clean` is only ever earned: authorities, top-10
 * share and dev holding all known and none flagged. A missing field is "partial", never a pass.
 */
export type AuditState = 'clean' | 'partial' | 'unaudited';

export function auditState(r: { flags: readonly string[]; mintAuth: boolean | null; freezeAuth: boolean | null; top10?: number | null; dev?: number | null }): AuditState | null {
  if (r.flags.length) return null; // flagged rows show their flags instead
  if (r.mintAuth === null && r.freezeAuth === null) return 'unaudited';
  const known = r.mintAuth !== null && r.freezeAuth !== null && r.top10 != null && r.dev != null;
  return known ? 'clean' : 'partial';
}

/** Collapsed: under $1K of liquidity, or under $15K cap after falling 70 %+ in 24 h. Shown as a DEAD flag. */
export function isDead(r: { liq?: number | null; mcap?: number | null; h24?: number | null }): boolean {
  if (r.liq != null && r.liq < 1_000) return true;
  return r.mcap != null && r.mcap < 15_000 && r.h24 != null && r.h24 <= -70;
}

export interface ScreenerRow {
  mint: string;
  symbol: string;
  name: string;
  launchpad: Launchpad;
  price: number | null;
  mcap: number | null;
  /** DexScreener and Jupiter disagree on market cap by more than 5x (D-06 rule): shown with a marker. */
  mcapFlagged: boolean;
  fdv: number | null;
  liq: number | null;
  vol24: number | null;
  vol6h: number | null;
  vol1h: number | null;
  vol5m: number | null;
  /** Minutes since launch; null when no source reported a creation time. */
  ageMin: number | null;
  holders: number | null;
  /** Holder count change over 24h (fixtures); live sources only give a percentage, see holdersChgPct. */
  holders24: number | null;
  /** Holder count change over 24h in percent (Jupiter `holderChange`); null when unknown. */
  holdersChgPct: number | null;
  chg: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  /** Prices oldest → newest for the 24h trend column; undefined draws nothing. */
  spark: number[] | undefined;
  buys: number | null;
  sells: number | null;
  org: number | null;
  top10: number | null;
  dev: number | null;
  lpLocked: number | null;
  mintAuth: boolean | null;
  freezeAuth: boolean | null;
  snipers: number | null;
  bundled: number | null;
  flags: RiskFlag[];
  verified: boolean;
  sus: boolean;
  bonding: number | null;
  /** DexScreener dex id of the row's pair (`pumpfun` = still on the bonding curve, `pumpswap` = graduated). */
  dex?: string | null;
  /** Pool / pair address of the best pair (DexScreener), used to chart and tape the token; null for fixtures. */
  pair: string | null;
  sources: SourceId[];
  stale: boolean;
  fetchedAt: number | null;
  /** Fixture-only heuristic one-liner for the spotlight; null until the analyst lane (D-15) fills it. */
  aiNote: string | null;
  /** Coin image URL as the sources advertise it (DexScreener info.imageUrl / Jupiter icon); null = none (task-1326). */
  image: string | null;
  /** The fixture token behind a demo row (the token screen still consumes FixtureToken until D-05). */
  fixture?: FixtureToken;
  /**
   * Placeholder row shown while the very first live fetch lands and nothing is cached (task-1323).
   * Carries no data (every number null → dim dashes) and an empty mint; never opened, watched or sent
   * to the analyst.
   */
  skeleton?: true;
}

/** How many placeholder rows the screener shows while the first live fetch is in flight (task-1323). */
export const SKELETON_ROWS = 12;

/** Placeholder rows for the empty-feed first paint (task-1323): shimmer bars, no data, no mint. */
export function skeletonRows(n = SKELETON_ROWS): ScreenerRow[] {
  const bars = ['░░░░░', '░░░░', '░░░░░░', '░░░'];
  return Array.from({ length: n }, (_, i): ScreenerRow => ({
    mint: '', symbol: bars[i % bars.length], name: i === 0 ? 'loading feed…' : '', launchpad: 'unknown',
    price: null, mcap: null, mcapFlagged: false, fdv: null, liq: null, vol24: null, vol6h: null, vol1h: null, vol5m: null,
    ageMin: null, holders: null, holders24: null, holdersChgPct: null, chg: { m5: null, h1: null, h6: null, h24: null },
    spark: undefined, buys: null, sells: null, org: null, top10: null, dev: null, lpLocked: null, mintAuth: null, freezeAuth: null,
    snipers: null, bundled: null, flags: [], verified: false, sus: false, bonding: null, pair: null, sources: [], stale: true,
    fetchedAt: null, aiNote: null, image: null, skeleton: true,
  }));
}

/** Risk flags from the audit fields, same thresholds as the prototype fixtures. */
export function deriveFlags(r: Pick<ScreenerRow, 'mintAuth' | 'freezeAuth' | 'top10' | 'dev' | 'bundled' | 'lpLocked'> & { liq?: number | null; mcap?: number | null; h24?: number | null }): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (isDead(r)) flags.push('DEAD');
  if (r.mintAuth) flags.push('MINT');
  if (r.freezeAuth) flags.push('FREEZE');
  if (r.top10 !== null && r.top10 > 35) flags.push('TOP10');
  if (r.dev !== null && r.dev > 5) flags.push('DEV');
  if (r.bundled !== null && r.bundled > 15) flags.push('BUNDLE');
  if (r.lpLocked !== null && r.lpLocked < 50) flags.push('LP');
  return flags;
}

export function fromFixture(tk: FixtureToken): ScreenerRow {
  const verdict = tk.flags.length >= 2 ? 'avoid: holder structure fragile' : tk.org >= 60 ? 'watch: organic flow, decent spread' : 'speculative: thin, mostly bots';
  return {
    mint: tk.mint, symbol: tk.symbol, name: tk.name, launchpad: tk.launchpad,
    price: tk.price, mcap: tk.mcap, mcapFlagged: false, fdv: tk.fdv, liq: tk.liq,
    vol24: tk.vol24, vol6h: tk.vol24 * 0.3, vol1h: tk.vol24 * 0.06, vol5m: tk.vol24 * 0.005,
    ageMin: tk.ageMin, holders: tk.holders, holders24: tk.holders24, holdersChgPct: null,
    chg: { ...tk.chg }, spark: tk.spark, buys: tk.buys, sells: tk.sells, org: tk.org,
    top10: tk.top10, dev: tk.dev, lpLocked: tk.lpLocked, mintAuth: tk.mintAuth, freezeAuth: tk.freezeAuth,
    snipers: tk.snipers, bundled: tk.bundled, flags: tk.flags, verified: false, sus: false, bonding: tk.bonding, pair: null,
    sources: ['fixture'], stale: false, fetchedAt: null, aiNote: verdict, image: null, fixture: tk,
  };
}

/**
 * Terminal safety only (CL-06 firewalling is D-12): drop control, bidi and zero-width characters,
 * replace glyphs the cell canvas cannot place in one column (East Asian wide, emoji) with ▯, cap length.
 */
export function cleanText(s: string | null | undefined, max = 48): string {
  if (!s) return '';
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue;
    if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff) continue; // zero-width
    if ((cp >= 0x200e && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) continue; // bidi
    if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x1f3fb && cp <= 0x1f3ff)) continue; // combining / variation / skin tone
    out += isWide(cp) ? '▯' : ch;
    if (out.length >= max) break;
  }
  return out;
}

/** Code points that terminals render two columns wide (EAW W/F ranges) or as emoji. */
export function isWide(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f000 && cp <= 0x1faff)
    || (cp >= 0x20000 && cp <= 0x3fffd);
}

/**
 * The 24h trend implied by the window deltas: the price 24h/6h/1h/5m ago and now, interpolated
 * on a linear time axis. Not a tick history (that is D-17's history table); it is the path the
 * reported changes describe, which is what the 24H TREND column claims.
 */
export function impliedSpark(price: number | null, chg: ScreenerRow['chg'], cells = 16): number[] | undefined {
  if (price === null || !(price > 0)) return undefined;
  const anchors: Array<[minAgo: number, price: number]> = [];
  const at = (min: number, c: number | null) => { if (c !== null && c > -100) anchors.push([min, price / (1 + c / 100)]); };
  at(1440, chg.h24); at(360, chg.h6); at(60, chg.h1); at(5, chg.m5);
  anchors.push([0, price]);
  if (anchors.length < 2) return undefined;
  const span = anchors[0][0];
  const out: number[] = [];
  for (let i = 0; i < cells; i++) {
    const t = span - (i / (cells - 1)) * span; // minutes ago
    let k = 0;
    while (k < anchors.length - 2 && anchors[k + 1][0] >= t) k++;
    const [t0, p0] = anchors[k], [t1, p1] = anchors[k + 1];
    const f = t0 === t1 ? 1 : (t0 - t) / (t0 - t1);
    out.push(p0 + (p1 - p0) * Math.min(1, Math.max(0, f)));
  }
  return out;
}

export function fromSnapshot(r: EnrichedRow, nowMs: number): ScreenerRow {
  const { token, pair, stats, audit } = r;
  const createdAt = token.createdAt ?? pair.createdAt;
  const chg = { m5: pair.priceChange.m5, h1: pair.priceChange.h1, h6: pair.priceChange.h6, h24: pair.priceChange.h24 };
  const price = pair.priceUsd > 0 ? pair.priceUsd : r.price?.usdPrice ?? null;
  const launchpad = token.launchpad;
  // PumpSwap pools (graduated pump.fun coins) burn LP by design; a coin still on the bonding curve has no LP at
  // all, so it gets no number (not a made-up 100 %). RugCheck (D-06) fills the rest.
  // RugCheck also reports 100 % for curve coins, so the curve rule wins over every source.
  const lpLocked = pair.dex === 'pumpfun' ? null : audit?.lpLockedPct ?? (pair.dex === 'pumpswap' ? 100 : null);
  const base = {
    mintAuth: audit?.mintAuthority ?? null,
    freezeAuth: audit?.freezeAuthority ?? null,
    top10: audit?.top10Pct ?? null,
    dev: audit?.devPct ?? null,
    bundled: audit?.bundledPct ?? null,
    lpLocked,
  };
  const fetchedAt = Math.max(pair.fetchedAt, token.fetchedAt, stats?.fetchedAt ?? 0);
  // MCAP: the D-06 cross-source rule (larger of DexScreener/Jupiter when they agree within 5x, else
  // DexScreener's number flagged); FDV as the last fallback.
  const mcap = r.mcap ? r.mcap.value : pair.mcap ?? pair.fdv;
  return {
    mint: r.mint, symbol: cleanText(token.symbol, 12) || '?', name: cleanText(token.name, 40), launchpad,
    price,
    mcap, mcapFlagged: r.mcap?.flagged ?? false, fdv: pair.fdv, liq: pair.liquidityUsd,
    vol24: pair.volume.h24, vol6h: pair.volume.h6, vol1h: pair.volume.h1, vol5m: pair.volume.m5,
    ageMin: createdAt ? Math.max(0, (nowMs - createdAt) / 60000) : null,
    // Jupiter's holderChange is a percentage, not a count: keep the two apart so the UI never shows "+-1.02".
    holders: stats?.holderCount ?? null, holders24: null, holdersChgPct: stats?.holders24hDelta ?? null,
    chg, spark: r.sparkline ?? impliedSpark(price, chg),
    buys: pair.txns.h24?.buys ?? null, sells: pair.txns.h24?.sells ?? null,
    org: stats?.organicScore ?? null,
    ...base,
    snipers: audit?.sniperCount ?? null,
    flags: deriveFlags({ ...base, liq: pair.liquidityUsd, mcap, h24: chg.h24 }),
    dex: pair.dex || null,
    verified: token.verified, sus: token.sus, bonding: null, pair: pair.pairAddress || null,
    sources: r.sources, stale: r.stale, fetchedAt: fetchedAt || null, aiNote: null,
    image: typeof token.image === 'string' && /^https?:\/\//i.test(token.image) ? token.image : null,
  };
}
