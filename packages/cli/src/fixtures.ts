// trenchscope — deterministic fixture data (seeded PRNG, no network). Ported from the prototype so
// `trenchscope --screen <name> --fixtures` renders byte-identical frames. Shapes are the view rows
// the screens consume today; D-03 maps @dexterm/data TokenSnapshot records onto them.
// All names, mints and addresses are fictional.
import type { Candle, Launchpad } from '@dexterm/data';

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fakeMint(rnd: Rng, suffix = 'pump'): string {
  let s = '';
  for (let i = 0; i < 44 - suffix.length; i++) s += B58[Math.floor(rnd() * B58.length)];
  return s + suffix;
}
function fakeAddr(rnd: Rng): string { return fakeMint(rnd, ''); }

type NameRow = readonly [symbol: string, name: string, launchpad: Launchpad];

const NAMES: NameRow[] = [
  ['WIFHAT', 'dogwifhat classic', 'raydium'], ['PUDGY', 'Pudgy Terminal', 'pump.fun'], ['GIGA', 'Gigachad Protocol', 'pump.fun'],
  ['MOODENG', 'Moo Deng Returns', 'meteora'], ['CATWIF', 'cat wif laser', 'pump.fun'], ['RETARDIO', 'retardio cousins', 'raydium'],
  ['SNAIL', 'Snail Season', 'dbc'], ['HOUSE', 'housecoin', 'pump.fun'], ['FARTCOIN', 'Fartcoin', 'raydium'], ['PNUT', 'Peanut the Squirrel', 'raydium'],
  ['ANSEM', 'ansem is back', 'pump.fun'], ['MANEKI', 'Maneki Neko', 'meteora'], ['GOAT', 'Goatseus Maximus', 'raydium'], ['ZEREBRO', 'zerebro', 'raydium'],
  ['TITCOIN', 'titcoin', 'pump.fun'], ['FWOG', 'FWOG', 'raydium'], ['SIGMA', 'sigma grindset', 'pump.fun'], ['MICHI', 'michi', 'raydium'],
  ['ALCH', 'Alchemist AI', 'dbc'], ['BUTTHOLE', 'butthole coin', 'pump.fun'], ['LOCKIN', 'lock in', 'raydium'], ['HARAMBE', 'Harambe on Solana', 'raydium'],
  ['DADDY', 'DADDY TATE', 'raydium'], ['SKBDI', 'Skibidi Toilet', 'pump.fun'], ['CHILLGUY', 'Just a chill guy', 'raydium'], ['BRETT', 'Brett on Sol', 'meteora'],
  ['NEIRO', 'Neiro', 'raydium'], ['SLERF', 'SLERF', 'raydium'], ['BOME', 'BOOK OF MEME', 'raydium'], ['POPCAT', 'Popcat', 'raydium'],
  ['TRUMPCAT', 'Trump Cat', 'pump.fun'], ['MINI', 'mini', 'pump.fun'], ['AI16Z', 'ai16z', 'raydium'], ['ACT', 'Act I: The AI Prophecy', 'raydium'],
];

const NEWPAIR_NAMES: NameRow[] = [
  ['BOOP', 'boop the snoot', 'pump.fun'], ['CLAUDE', 'claude wif terminal', 'pump.fun'], ['GRIDLOCK', 'gridlock', 'dbc'], ['RATTO', 'ratto', 'pump.fun'],
  ['MOONPIE', 'moon pie', 'bonk'], ['WAFFLE', 'waffle house', 'pump.fun'], ['PEBBLE', 'pebble', 'pump.fun'], ['HONK', 'honk honk', 'dbc'],
  ['SIRLOIN', 'sirloin', 'pump.fun'], ['ORB', 'the orb', 'bonk'], ['DRIFTER', 'drifter', 'pump.fun'], ['GLIZZY', 'glizzy gobbler', 'pump.fun'],
  ['NOODLE', 'noodle arms', 'dbc'], ['TUNA', 'tuna melt', 'pump.fun'], ['CRAB', 'crab rave', 'pump.fun'], ['FELIX', 'felix the cat', 'bonk'],
  ['KERNEL', 'kernel panic', 'pump.fun'], ['BAGEL', 'everything bagel', 'pump.fun'], ['YAP', 'yapper', 'dbc'], ['PLONK', 'plonk', 'pump.fun'],
];

function walk(rnd: Rng, n: number, start: number, vol: number, drift = 0): number[] {
  const out = [start];
  let p = start;
  for (let i = 1; i < n; i++) {
    const shock = rnd() < 0.04 ? (rnd() - 0.45) * vol * 6 : 0;
    p = p * (1 + (rnd() - 0.5) * vol + drift + shock);
    p = Math.max(p, start * 0.05);
    out.push(p);
  }
  return out;
}

function candlesFrom(rnd: Rng, series: number[], intervalMs: number, endMs: number, volBase: number): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < series.length - 1; i++) {
    const o = series[i], c = series[i + 1];
    const h = Math.max(o, c) * (1 + rnd() * 0.012);
    const l = Math.min(o, c) * (1 - rnd() * 0.012);
    const v = volBase * (0.3 + rnd() * 1.4) * (1 + Math.abs(c - o) / o * 25);
    out.push({ o, h, l, c, v, t: endMs - (series.length - 1 - i) * intervalMs });
  }
  return out;
}

export type RiskFlag = 'MINT' | 'FREEZE' | 'TOP10' | 'DEV' | 'BUNDLE' | 'LP';
export type HolderKind = '' | 'LP' | 'dev' | 'sniper' | 'cex';

export interface FixtureHolder { addr: string; pct: number; kind: HolderKind; sol: number }
export interface FixtureTrader { addr: string; pnl: number; buys: number; sells: number; smart: boolean; winRate: number }
export interface FixtureTrade { ago: number; side: 'buy' | 'sell'; usd: number; price: number; addr: string; tag: '' | 'smart' | 'dev' }

export interface FixtureToken {
  id: number;
  symbol: string;
  name: string;
  launchpad: Launchpad;
  mint: string;
  price: number;
  mcap: number;
  fdv: number;
  liq: number;
  vol24: number;
  ageMin: number;
  holders: number;
  holders24: number;
  chg: { m5: number; h1: number; h6: number; h24: number };
  spark: number[];
  buys: number;
  sells: number;
  org: number;
  top10: number;
  dev: number;
  lpLocked: number;
  mintAuth: boolean;
  freezeAuth: boolean;
  snipers: number;
  bundled: number;
  flags: RiskFlag[];
  candles: Candle[];
  bonding: number | null;
  supply: number;
  socials: { x: boolean; tg: boolean; web: boolean };
  xFollowers: number;
  devHistory: { launches: number; rugged: number; bestAth: number };
  holdersTop: FixtureHolder[];
  traders: FixtureTrader[];
  trades: FixtureTrade[];
  rug: { score: number; risks: RiskFlag[] };
  migrated: boolean;
}

function makeToken(rnd: Rng, [symbol, name, launchpad]: NameRow, i: number, opts: { fresh?: boolean } = {}): FixtureToken {
  const fresh = !!opts.fresh;
  const mcap = fresh ? 4e3 + rnd() * 90e3 : Math.exp(13 + rnd() * 6); // $440K .. $160M
  const supply = 1e9;
  const price = mcap / supply;
  const liq = fresh ? mcap * (0.25 + rnd() * 0.3) : mcap * (0.04 + rnd() * 0.12);
  const vol24 = fresh ? mcap * (0.5 + rnd() * 4) : mcap * (0.1 + rnd() * 1.6);
  const ageMin = fresh ? rnd() * 90 : Math.exp(4 + rnd() * 7.5);
  const holders = fresh ? Math.floor(20 + rnd() * 900) : Math.floor(Math.sqrt(mcap) * (2 + rnd() * 6));
  const chg = {
    m5: (rnd() - 0.5) * 8,
    h1: (rnd() - 0.48) * 30,
    h6: (rnd() - 0.47) * 70,
    h24: (rnd() - 0.46) * 160,
  };
  if (fresh) { chg.m5 = (rnd() - 0.4) * 40; chg.h1 = (rnd() - 0.35) * 200; chg.h6 = chg.h1; chg.h24 = chg.h1; }
  const spark = walk(rnd, 48, price / (1 + chg.h24 / 100), 0.06);
  spark[spark.length - 1] = price;
  const buys = Math.floor(vol24 / (40 + rnd() * 400));
  const sells = Math.floor(buys * (0.6 + rnd() * 0.7));
  const org = fresh ? Math.floor(rnd() * 40) : Math.floor(20 + rnd() * 80);
  const top10 = fresh ? 20 + rnd() * 50 : 8 + rnd() * 35;
  const dev = fresh ? rnd() * 8 : rnd() * 4;
  const lpLocked = launchpad === 'pump.fun' ? 100 : (rnd() < 0.7 ? 100 : Math.floor(rnd() * 100));
  const mintAuth = rnd() < 0.08;
  const freezeAuth = rnd() < 0.05;
  const snipers = fresh ? Math.floor(rnd() * 30) : Math.floor(rnd() * 8);
  const bundled = fresh ? rnd() * 30 : rnd() * 10;
  const flags: RiskFlag[] = [];
  if (mintAuth) flags.push('MINT');
  if (freezeAuth) flags.push('FREEZE');
  if (top10 > 35) flags.push('TOP10');
  if (dev > 5) flags.push('DEV');
  if (bundled > 15) flags.push('BUNDLE');
  if (lpLocked < 50) flags.push('LP');
  const endMs = Date.UTC(2026, 9, 5, 23, 0, 0);
  // 60 hourly candles; the walk is rescaled so the series ends exactly at the current price
  const rawSeries = walk(rnd, 61, price, 0.05, (rnd() - 0.5) * 0.004);
  const scale = price / rawSeries[rawSeries.length - 1];
  const hourSeries = rawSeries.map((v) => v * scale);
  const candles = candlesFrom(rnd, hourSeries, 3600e3, endMs, vol24 / 24);
  const bonding = launchpad === 'pump.fun' && fresh ? Math.min(100, (mcap / 69e3) * 100) : null;
  const mint = fakeMint(rnd, launchpad === 'pump.fun' ? 'pump' : launchpad === 'bonk' ? 'bonk' : '');
  const holdersTop: FixtureHolder[] = Array.from({ length: 10 }, (_, k) => {
    const pct = (top10 / 10) * (1.9 - k * 0.18) * (0.8 + rnd() * 0.4);
    const kind: HolderKind = k === 0 && launchpad !== 'pump.fun' ? 'LP' : rnd() < 0.15 ? 'dev' : rnd() < 0.12 ? 'sniper' : rnd() < 0.1 ? 'cex' : '';
    return { addr: fakeAddr(rnd), pct, kind, sol: pct / 100 * mcap / 120 };
  });
  const traders: FixtureTrader[] = Array.from({ length: 8 }, () => {
    const pnl = (rnd() - 0.35) * 40000;
    return { addr: fakeAddr(rnd), pnl, buys: Math.floor(rnd() * 40), sells: Math.floor(rnd() * 30), smart: rnd() < 0.3, winRate: 30 + rnd() * 60 };
  }).sort((a, b) => b.pnl - a.pnl);
  const trades: FixtureTrade[] = Array.from({ length: 24 }, (_, k) => {
    const side = rnd() < 0.56 ? 'buy' : 'sell';
    const usd = Math.exp(3 + rnd() * 6);
    // PRNG draw order matters for parity with the prototype: ago, price, addr, then tag.
    const ago = k * (4 + rnd() * 30);
    const tradePrice = price * (1 + (rnd() - 0.5) * 0.02);
    const addr = fakeAddr(rnd);
    const tag: FixtureTrade['tag'] = rnd() < 0.08 ? 'smart' : rnd() < 0.06 ? 'dev' : '';
    return { ago, side, usd, price: tradePrice, addr, tag };
  });
  return {
    id: i, symbol, name, launchpad, mint, price, mcap, fdv: mcap * (1 + rnd() * 0.1), liq, vol24, ageMin, holders,
    holders24: Math.floor((rnd() - 0.3) * holders * 0.2), chg, spark, buys, sells, org, top10, dev, lpLocked, mintAuth, freezeAuth,
    snipers, bundled, flags, candles, bonding, supply,
    socials: { x: rnd() < 0.85, tg: rnd() < 0.7, web: rnd() < 0.6 },
    xFollowers: Math.floor(rnd() * 60000),
    devHistory: { launches: Math.floor(rnd() * 12), rugged: Math.floor(rnd() * 3), bestAth: Math.exp(10 + rnd() * 6) },
    holdersTop, traders, trades,
    rug: { score: Math.floor(rnd() * 100), risks: flags },
    migrated: launchpad === 'pump.fun' ? !fresh : true,
  };
}

export interface WatchRow {
  token: FixtureToken;
  added: number;
  entry: number;
  note: string;
  alerts: unknown[];
}

export type AlertLevel = 'up' | 'down' | 'info' | 'ai';
export interface AlertRow { ago: number; kind: string; text: string; level: AlertLevel }

export interface Fixtures {
  tokens: FixtureToken[];
  newPairs: FixtureToken[];
  watch: WatchRow[];
  alerts: AlertRow[];
  sol: { price: number; chg24: number };
  seed: number;
}

export function makeFixtures(seed = 7): Fixtures {
  const rnd = mulberry32(seed);
  const tokens = NAMES.map((n, i) => makeToken(rnd, n, i));
  tokens.sort((a, b) => b.vol24 - a.vol24);
  const newPairs = NEWPAIR_NAMES.map((n, i) => makeToken(rnd, n, 100 + i, { fresh: true }));
  newPairs.forEach((p, k) => { p.ageMin = (k + 1) * (0.4 + rnd() * 1.6); });
  const NOTES = ['thesis: CT rotation into cats', 'dev doxxed, LP burned', 'wait for retest of 1.2M', 'watch holder growth', 'claude flagged: wash vol', 'ATH breakout candidate'];
  const watch: WatchRow[] = [tokens[1], tokens[4], tokens[7], tokens[12], newPairs[1], tokens[20]].map((t, i) => ({
    token: t,
    added: Math.floor(60 + rnd() * 3000),
    entry: t.price / (1 + (rnd() - 0.35) * 0.8),
    note: NOTES[i % NOTES.length],
    alerts: [],
  }));
  const alerts: AlertRow[] = [
    { ago: 0.3, kind: 'price', text: `${tokens[1].symbol} crossed +25% 1h (now ${fmtPctRaw(tokens[1].chg.h1)})`, level: 'up' },
    { ago: 2.1, kind: 'holders', text: `${tokens[4].symbol} holders +312 in 10m (velocity 3.4x)`, level: 'info' },
    { ago: 5.8, kind: 'risk', text: `${newPairs[1].symbol} dev wallet sold 60% of allocation`, level: 'down' },
    { ago: 9.4, kind: 'migration', text: `${newPairs[3].symbol} graduated pump.fun → PumpSwap`, level: 'info' },
    { ago: 14, kind: 'smart', text: `smart wallet 7xKp…q3Lm bought ${tokens[7].symbol} $12.4K`, level: 'up' },
    { ago: 22, kind: 'ai', text: `claude: ${tokens[12].symbol} thesis invalidated (liq -40%)`, level: 'ai' },
    { ago: 31, kind: 'price', text: `${tokens[20].symbol} -18% 5m, sell wall at $0.0042`, level: 'down' },
  ];
  const sol = { price: 120.73, chg24: -0.67 };
  return { tokens, newPairs, watch, alerts, sol, seed };
}

function fmtPctRaw(n: number): string { return (n > 0 ? '+' : '') + n.toFixed(1) + '%'; }

export type Verdict = 'watch' | 'avoid' | 'speculative';

export type TranscriptLine =
  | { role: 'user'; text: string }
  | { role: 'tool'; text: string }
  | { role: 'ai'; text: string; verdict?: Verdict }
  | { role: 'ai'; bullets: string[] };

/** Fixture analyst transcript for the token detail panel (what `claude -p` would return after tool calls). */
export function aiTranscript(token: FixtureToken): TranscriptLine[] {
  const s = token.symbol;
  const verdict: Verdict = token.org > 60 && token.top10 < 25 && !token.mintAuth ? 'watch' : token.flags.length >= 2 ? 'avoid' : 'speculative';
  const lines: TranscriptLine[] = [];
  lines.push({ role: 'user', text: `is $${s} worth a position here? what would invalidate it?` });
  lines.push({ role: 'tool', text: `get_token(${s}) 84ms · get_holders(top=20) 131ms · get_trades(1h) 97ms · rugcheck 210ms` });
  lines.push({ role: 'ai', verdict, text: verdictLine(verdict, token) });
  lines.push({ role: 'ai', bullets: [
    `${token.org >= 60 ? 'Organic score ' + token.org + '/100, real buyers outnumber bots' : 'Organic score ' + token.org + '/100: most volume looks automated'}`,
    `Top 10 hold ${token.top10.toFixed(1)}% ${token.top10 > 30 ? '(concentrated, one wallet can nuke it)' : '(acceptable spread)'}`,
    `${token.holders24 >= 0 ? '+' : ''}${token.holders24} holders 24h vs ${fmtK(token.vol24)} volume: ${token.holders24 > 0 ? 'accumulation' : 'distribution'} pattern`,
    `Dev: ${token.devHistory.launches} prior launches, ${token.devHistory.rugged} rugged, holds ${token.dev.toFixed(2)}%`,
    token.mintAuth ? 'Mint authority still enabled. Hard no until revoked.' : `Mint/freeze revoked, LP ${token.lpLocked}% locked`,
  ] });
  lines.push({ role: 'ai', text: `Invalidation: liquidity below ${fmtK(token.liq * 0.6)} or top-10 above 35%. I set two alerts for that. I don't trade; say "quote 0.5 SOL" and I'll show the Jupiter route for you to confirm.` });
  lines.push({ role: 'user', text: `compare to the other cat coins in the screener` });
  lines.push({ role: 'tool', text: `screener_query(filter="cat", sort=vol24) 42ms` });
  lines.push({ role: 'ai', text: `3 matches. $${s} has the best organic/volume ratio but the thinnest liquidity of the three; CATWIF has 2.1x the holder growth. Want the comparison table?` });
  return lines;
}

function verdictLine(v: Verdict, t: FixtureToken): string {
  if (v === 'watch') return `Lean watch. Setup is decent: ${t.chg.h24 >= 0 ? 'momentum is positive' : 'pulling back on light volume'} and the on-chain basics check out.`;
  if (v === 'avoid') return `Avoid for now. ${t.flags.length} risk flags (${t.flags.join(', ')}) and the holder structure is fragile.`;
  return `Speculative. Nothing disqualifying on-chain, but the activity is thin and the chart is mostly noise.`;
}

function fmtK(n: number): string { return n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${(n / 1e3).toFixed(0)}K`; }

const SPAWN_NAMES: NameRow[] = [['WAGMI', 'we are all gonna make it', 'pump.fun'], ['JEET', 'jeet detector', 'pump.fun'], ['NGMI', 'ngmi club', 'dbc'], ['COPIUM', 'copium inhaler', 'bonk'], ['REKT', 'rekt capital', 'pump.fun']];

/** Demo event: a brand-new pair lands at the top of the feed (fires the new-pair glitch in the loop). */
export function spawnPair(fx: Fixtures, rnd: Rng): FixtureToken {
  const n = SPAWN_NAMES[Math.floor(rnd() * SPAWN_NAMES.length)];
  const p = makeToken(rnd, n, 200 + fx.newPairs.length, { fresh: true });
  p.ageMin = 0.15;
  p.bonding = 3 + rnd() * 10;
  fx.newPairs.unshift(p);
  fx.newPairs.pop();
  return p;
}

/** Demo event: force a pump (pct > 0) or a dump on a token. Mutates price/changes/candles/tape so every widget reacts. */
export function shock(tk: FixtureToken, pct: number, rnd: Rng): void {
  const j = pct / 100;
  tk.price *= 1 + j; tk.mcap *= 1 + j;
  tk.chg.m5 += pct * 0.8; tk.chg.h1 += pct * 0.6; tk.chg.h24 += pct * 0.4;
  tk.spark.push(tk.price); tk.spark.shift();
  // spread the move over the last three candles so the chart scale survives (one giant candle looks like a bug)
  const n = tk.candles.length;
  const steps = [0.35, 0.7, 1];
  let prevClose = tk.candles[n - 4].c;
  for (let i = 0; i < 3; i++) {
    const k = tk.candles[n - 3 + i];
    const close = prevClose * (1 + j * (steps[i] - (i ? steps[i - 1] : 0)));
    k.o = prevClose; k.c = close; k.h = Math.max(k.o, k.c) * 1.01; k.l = Math.min(k.o, k.c) * 0.99; k.v *= 1.4 + i * 0.3;
    prevClose = close;
  }
  tk.candles[n - 1].c = tk.price; tk.candles[n - 1].h = Math.max(tk.candles[n - 1].h, tk.price); tk.candles[n - 1].l = Math.min(tk.candles[n - 1].l, tk.price);
  const side: FixtureTrade['side'] = pct > 0 ? 'buy' : 'sell';
  for (let i = 0; i < 4; i++) tk.trades.unshift({ ago: i * 2, side, usd: 800 + rnd() * 9000, price: tk.price * (1 + (rnd() - 0.5) * 0.01), addr: tk.trades[i].addr, tag: i === 0 ? 'smart' : '' });
  tk.trades.length = 24;
  if (pct > 0) tk.buys += 4; else tk.sells += 4;
}

/** Advance prices by a small jitter so the interactive demo feels alive. */
export function tick(fx: Fixtures, rnd: Rng): void {
  for (const t of [...fx.tokens, ...fx.newPairs]) {
    const j = (rnd() - 0.5) * (t.bonding != null ? 0.03 : 0.008);
    t.price *= 1 + j;
    t.mcap *= 1 + j;
    t.chg.m5 += j * 100 * 0.5;
    t.chg.h1 += j * 100 * 0.3;
    t.spark.push(t.price); t.spark.shift();
    const last = t.candles[t.candles.length - 1];
    last.c = t.price; last.h = Math.max(last.h, t.price); last.l = Math.min(last.l, t.price);
    if (rnd() < 0.2) { t.buys += 1; t.vol24 += 50 + rnd() * 900; }
    if (rnd() < 0.12) { t.sells += 1; }
    if (t.bonding != null) t.bonding = Math.min(100, t.bonding + j * 50);
  }
  for (const p of fx.newPairs) p.ageMin += 1 / 120;
  for (const a of fx.alerts) a.ago += 1 / 120;
}
