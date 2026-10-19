// task-1358 fixtures (ported from research/task-1288/prototype/fixtures/ticks.mjs): a deterministic synthetic
// universe of screener-shaped rows that evolves tick by tick. No network, no real mints. Three scripted stories:
//   WIF   — ticks 12..16: 5-minute volume runs 4–6× its own pace while the top cluster holds 12 %  → should fire
//   CABAL — ticks 8..11:  volume runs 5× but the top cluster holds 46 %                            → must NOT fire
//   THIN  — tick 5:       volume spike on $8K liquidity                                              → gated out
import type { RuleRow } from '../../src/rules.ts';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fakeMint(rnd: () => number, tag: string): string {
  // Obviously synthetic: a readable tag followed by random base58 up to 44 chars. Never a real address.
  let s = `F1XTURE${tag}`;
  while (s.length < 44) s += B58[Math.floor(rnd() * B58.length)];
  return s;
}

export const T0 = Date.UTC(2026, 9, 9, 14, 0, 0); // 2026-10-09 14:00:00Z
export const TICK_MS = 10_000;

export interface FixtureRow extends RuleRow {
  mint: string; symbol: string; name: string; launchpad: string;
  price: number; mcap: number; fdv: number; liq: number; vol5m: number; vol1h: number; vol24: number;
  holders: number; cluster: number; top10: number; dev: number; lpLocked: number; mintAuth: boolean; freezeAuth: boolean;
  bundled: number; snipers: number; org: number; ageMin: number; chg: { m5: number; h1: number; h6: number; h24: number };
  buys: number; sells: number; pair: string; flags: string[]; verified: boolean; sus: boolean; bonding: null; fetchedAt: number;
}

type Seed = [string, string, string, number, number, number, number, number, number, number, number, number, boolean, boolean];
const SEED_TOKENS: Seed[] = [
  // symbol, name, launchpad, price, mcap, liq, vol5m, holders, cluster%, top10%, dev%, ageMin, mintAuth, freezeAuth
  ['SIGMA', 'sigma grindset', 'pump.fun', 0.1624, 162_400_000, 23_500_000, 420_000, 33_000, 9.1, 31.2, 1.2, 190, false, false],
  ['GOAT', 'Goatseus Maximus', 'pump.fun', 0.1339, 133_900_000, 19_800_000, 310_000, 61_000, 6.4, 28.0, 0.0, 2_900, false, false],
  ['BOME', 'BOOK OF MEME', 'raydium', 0.122, 122_000_000, 15_800_000, 250_000, 80_000, 4.2, 22.1, 0.0, 43_000, false, false],
  ['WIF', 'dogwifhat jr', 'pump.fun', 0.0834, 8_300_000, 1_600_000, 22_000, 4_100, 12.0, 24.5, 2.8, 260, false, false],
  ['ACT', 'Act I: The AI Prophecy', 'pump.fun', 0.0578, 57_800_000, 7_600_000, 190_000, 21_000, 7.7, 19.9, 1.1, 1_320, false, false],
  ['HOUSE', 'housecoin', 'dbc', 0.0468, 4_680_000, 580_000, 15_000, 3_300, 11.3, 33.0, 4.0, 4_400, false, false],
  ['CHILL', 'Just a chill guy', 'bonk', 0.0369, 3_690_000, 180_000, 9_000, 1_900, 15.0, 36.1, 3.3, 100, false, false],
  ['CABAL', 'totally organic', 'pump.fun', 0.0042, 4_200_000, 410_000, 12_000, 2_600, 46.0, 58.7, 6.9, 75, false, false],
  ['NEIRO', 'Neiro', 'raydium', 0.0742, 74_200_000, 9_200_000, 120_000, 44_000, 5.5, 21.0, 0.0, 86_000, false, false],
  ['THIN', 'thin book', 'pump.fun', 0.00011, 110_000, 8_000, 900, 310, 18.0, 41.0, 5.0, 22, false, false],
  ['MINTY', 'mint authority enjoyer', 'dbc', 0.0031, 3_100_000, 240_000, 8_000, 1_200, 10.0, 30.0, 2.0, 140, true, false],
  ['PLONK', 'plonk', 'pump.fun', 0.0191, 1_900_000, 320_000, 6_500, 980, 8.8, 27.5, 1.5, 55, false, false],
];

export function makeUniverse(seed = 7): FixtureRow[] {
  const rnd = mulberry32(seed);
  return SEED_TOKENS.map(([symbol, name, launchpad, price, mcap, liq, vol5m, holders, cluster, top10, dev, ageMin, mintAuth, freezeAuth], i) => ({
    mint: fakeMint(rnd, symbol.padEnd(5, 'x').toUpperCase().replace(/[^1-9A-HJ-NP-Za-km-z]/g, 'x')),
    symbol, name, launchpad,
    price, mcap, fdv: mcap * 1.04, liq,
    vol5m, vol1h: vol5m * 11, vol24: vol5m * 230,
    holders, cluster, top10, dev, lpLocked: launchpad === 'pump.fun' ? 100 : 80 + Math.round(rnd() * 20),
    mintAuth, freezeAuth, bundled: Math.round(rnd() * 8 * 10) / 10, snipers: Math.floor(rnd() * 6),
    org: 40 + Math.floor(rnd() * 55), ageMin,
    chg: { m5: 0, h1: 0, h6: 0, h24: 0 },
    buys: 0, sells: 0, pair: `pair-${i}`, flags: mintAuth ? ['MINT'] : [],
    verified: i < 3, sus: false, bonding: null,
    fetchedAt: T0,
  }));
}

/** Scripted multipliers per symbol per tick (volume factor vs the token's own baseline, cluster override). */
const SCRIPT: Record<string, (tick: number) => { vol: number; cluster: number } | null> = {
  WIF: (tick) => (tick >= 12 && tick <= 16 ? { vol: 4 + (tick - 12) * 0.5, cluster: 12.0 } : null),
  CABAL: (tick) => (tick >= 8 && tick <= 11 ? { vol: 5, cluster: 46.0 } : null),
  THIN: (tick) => (tick === 5 || tick === 6 ? { vol: 7, cluster: 18 } : null),
};

/**
 * Yields { tick, now, rows } for n ticks. Every number drifts a little (±12 % volume random walk,
 * holders creep up, price ±1.5 %) so "velocity" is measured against a noisy baseline, as in the app.
 */
export function* ticks({ seed = 7, n = 24 }: { seed?: number; n?: number } = {}): Generator<{ tick: number; now: number; rows: FixtureRow[] }> {
  const rnd = mulberry32(seed + 1);
  const base = makeUniverse(seed);
  const state = base.map((t) => ({ ...t, chg: { ...t.chg } }));
  for (let tick = 0; tick < n; tick++) {
    const now = T0 + tick * TICK_MS;
    const rows = state.map((row, i) => {
      const b = base[i];
      const drift = 1 + (rnd() - 0.5) * 0.24;
      const s = SCRIPT[row.symbol]?.(tick) ?? null;
      const vol5m = Math.round(b.vol5m * drift * (s?.vol ?? 1));
      const price = row.price * (1 + (rnd() - 0.5) * 0.03 * (s ? 2.5 : 1));
      const holders = row.holders + Math.floor(rnd() * 6) + (s ? Math.floor(rnd() * 40) : 0);
      const next: FixtureRow = {
        ...row, vol5m, price, holders,
        mcap: b.mcap * (price / b.price), fdv: b.fdv * (price / b.price),
        liq: Math.round(b.liq * (1 + (rnd() - 0.5) * 0.04)),
        cluster: s?.cluster ?? b.cluster,
        buys: Math.floor(vol5m / 180), sells: Math.floor(vol5m / 260),
        chg: { ...row.chg, m5: (price / row.price - 1) * 100 },
        fetchedAt: now,
      };
      state[i] = next;
      return next;
    });
    yield { tick, now, rows: rows.map((r) => ({ ...r, chg: { ...r.chg } })) };
  }
}
