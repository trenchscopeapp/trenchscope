// trenchscope — live TOKEN screen (task-1298). Same layout as screens/token.ts (the fixture/parity renderer)
// over a TokenView: every number comes from a source named in the panel caption; nulls draw as `—`;
// a panel whose source failed says so instead of showing anything. The analyst panel is a labelled
// placeholder until the Claude lane wires `claude -p` (task-1293 skills are ready).
import {
  Canvas, candleChart, statGrid, bar, badge, launchpadBadge, pctStyle, tradeTape, flowPanel,
  fmtUsd, fmtPrice, fmtMcap, fmtAge, fmtNum, fmtPct, shortAddr, wrap, header, footer, breakpoint, mix, isCalm,
  type Hex, type Style,
} from '@dexterm/tui';
import type { AppState } from '../../state.ts';
import { headerModel } from '../../state.ts';
import { panelCaption, INTERVALS, type TokenView } from '../token.ts';
import { FlowTracker } from '../flow.ts';
import { positionRow, type HeldRow } from '../trade.ts';
import { renderAnalystSession } from '../../screens/analyst-session.ts';
import { larpBadge } from '../../screens/screener.ts';
import { signedUsd, signedPctOf, fmtUsdFine, sol as fmtSol, signedSol } from '../../screens/positions.ts';
import { renderScanWhy, renderScanTicker } from '../../scan/ui.ts';
import { drawCoin, imagesOn } from '../../screens/coin.ts';
import { COIN_HERO_W, COIN_HERO_H } from '@dexterm/tui';
import { renderSocialPanel } from '../../screens/social-panel.ts';
import { launchIntelCells, holderTags } from '../intel.ts';
import { devBookOf, devRows } from '../dev-history.ts';
import { EX_POOL_TAGS } from '@dexterm/data';
import { layoutFor } from '../../custom.ts';
import { chartMode, priceModeOf, mcapAt, positionPriceCells, type PriceMode } from '../../display.ts';

type Level = 'ok' | 'warn' | 'bad' | 'na';

const dash = '—';
const EX_POOL_TAG_SET: ReadonlySet<string> = EX_POOL_TAGS;

/** task-1367 holder-class badge colours: venues/escrows accent, the creator/linked warn, the rest muted. */
function tagColor(t: Canvas['theme'], tag: string): Hex {
  if (tag === 'POOL' || tag === 'CURVE' || tag === 'VAULT' || tag === 'LOCK' || tag === 'LP') return t.accent;
  if (tag === 'DEV' || tag === 'LINKED') return t.warn;
  if (tag === 'SNIPER') return t.down;
  return t.muted;
}

export function renderTokenLive(c: Canvas, state: AppState, v: TokenView): void {
  const t = c.theme;
  const bp = breakpoint(c.w);
  header(c, headerModel(state));
  const now = state.now.getTime();
  // task-1324: AI scan mode's one-line strip on row 1 (the band under the header — no panel moves):
  // WHY IT TRIGGERED on the coin the scan locked, the SCANNING ticker on any other coin.
  if (state.scan?.engine.on) {
    const ai = state.live?.scanMeterLabel() ?? '';
    if (state.scan.engine.lock?.mint === v.mint) renderScanWhy(c, state.scan, ai, now, state.timeZone);
    else renderScanTicker(c, state.scan, ai);
  }
  const top = 2, bottom = c.h - 1;
  const lay = layoutFor(state.custom, c.w, c.h); // task-1358: analyst width + chart share from the workspace layout
  const showAi = state.aiOpen !== false && bp !== 'compact' && lay.analystW > 0;
  const aiW = showAi ? lay.analystW : 0;
  const mainW = c.w - aiW;

  // ---- title strip. task-1326: with images on, an 8×4 coin image sits at the left of the four header rows
  // (title · price · CA · a blank row) and the text starts after it; off, the layout is the pre-1326 three rows.
  let y = top;
  const hero = imagesOn(state);
  const heroW = hero ? COIN_HERO_W : 0;
  const x0 = 1 + (hero ? heroW + 1 : 0);
  c.fill(0, y, mainW, hero ? COIN_HERO_H : 2, ' ', { bg: t.bg });
  if (hero) drawCoin(c, state, { x: 1, y, w: heroW, h: COIN_HERO_H, url: v.image, symbol: v.symbol, bg: t.bg, prio: 2 });
  let x = c.text(x0, y, '‹ ', { fg: t.muted, bg: t.bg });
  x = c.text(x, y, `$${v.symbol}`, { fg: t.text, bg: t.bg, b: true });
  x = c.text(x + 1, y, v.name, { fg: t.muted, bg: t.bg });
  if (v.launchpad !== 'unknown') x = launchpadBadge(c, x + 2, y, v.launchpad, { on: t.bg });
  if (v.verified) x = badge(c, x + 1, y, 'VERIFIED', t.up, { on: t.bg });
  if (v.sus) x = badge(c, x + 1, y, 'SUS', t.down, { on: t.bg });
  // task-1315: LARP-detector verdict badge, only once larp-check has actually run for this mint.
  const lb = larpBadge(state.larpByMint?.get(v.mint)?.verdict, t);
  if (lb) x = badge(c, x + 1, y, lb.text, lb.fg, { on: t.bg });
  x = c.text(x + 2, y, shortAddr(v.mint, 6), { fg: t.dim, bg: t.bg });
  x = c.text(x + 2, y, v.ageMin === null ? `age ${dash}` : `age ${fmtAge(v.ageMin)}`, { fg: t.dim, bg: t.bg });
  const socials = [v.socials.x && 'X', v.socials.tg && 'TG', v.socials.web && 'WEB'].filter((s): s is string => !!s);
  let sx = mainW - 2 - socials.reduce((s, k) => s + k.length + 3, 0);
  if (sx > x + 2) for (const s of socials) sx = badge(c, sx, y, s, t.muted, { on: t.bg }) + 1;
  y += 1;
  // Fast lane (task-1312): when the open token is streaming on-chain, show the push price + a LIVE badge;
  // otherwise the polled price + POLL. The badge is honest — POLL whenever the stream is not delivering.
  const liveBadge = state.live?.badgeFor(v.mint) ?? 'POLL';
  const livePx = liveBadge === 'LIVE' ? state.live?.livePrice(v.mint) ?? null : null;
  const shownPx = livePx ?? v.price;
  // task-1366: mcap mode leads with the market cap (the live price × the polled supply ratio) and keeps the price beside it;
  // without a supply it shows the price and says so.
  const cm = chartMode(priceModeOf(state), v.price, v.mcap);
  if (cm.kind === 'mcap' && shownPx !== null) {
    x = c.text(x0, y, fmtMcap(mcapAt(shownPx, cm.scale)), { fg: t.text, bg: t.bg, b: true });
    x = c.text(x + 1, y, `(${fmtPrice(shownPx)})`, { fg: t.dim, bg: t.bg });
  } else x = c.text(x0, y, shownPx === null ? dash : fmtPrice(shownPx), { fg: cm.label && shownPx !== null ? t.warn : t.text, bg: t.bg, b: true });
  if (state.live?.fastLane) x = badge(c, x + 1, y, liveBadge, liveBadge === 'LIVE' ? t.up : t.muted, { on: t.bg });
  const deltas: Array<[string, number | null]> = [['5m', v.chg.m5], ['1h', v.chg.h1], ['6h', v.chg.h6], ['24h', v.chg.h24]];
  x += 2;
  for (const [k, d] of deltas) {
    x = c.text(x, y, k, { fg: t.dim, bg: t.bg });
    x = c.text(x + 1, y, d === null ? dash : fmtPct(d), d === null ? { fg: t.dim, bg: t.bg } : { ...pctStyle(c, d, t.bg), b: k === '24h' });
    x += 2;
  }
  const mk = clip(panelCaption(v.panels.market, now, 'market data unavailable'), 48);
  if (mk && x + mk.length + 2 < mainW) c.text(x + 1, y, mk, { fg: v.panels.market.state === 'error' ? t.warn : t.dim, bg: t.bg, i: true }, mainW - x - 3);
  y += 1;

  // ---- contract address (task-1311, QA B5/M9): the full mint is always on screen, even before a
  // pool exists, with the key that copies it. A read-only screener is only useful if you can act on
  // the mint in a wallet or bot. Rain must not overdraw it.
  c.noRain(0, y, mainW, 1);
  let cax = c.text(x0, y, 'CA ', { fg: t.dim, bg: t.bg });
  cax = c.text(cax, y, v.mint, { fg: t.muted, bg: t.bg }, Math.max(0, mainW - cax - 12));
  if (cax + 10 < mainW) c.text(cax + 1, y, '· y copy', { fg: t.dim, bg: t.bg, i: true });
  y += 1;
  if (hero) { c.rainZone(x0, y, Math.max(0, mainW - x0 - 1), 1, 1); y += 1; } // the hero's fourth row: a quiet band

  // ---- position (task-1323 item 5): only when the coin on screen is HELD. Priced at the same tick the
  // header shows (`shownPx`), so it moves with the header price. Flat / never held: nothing is drawn.
  const src = state.live?.positionSource ?? state.live?.positions ?? null;
  const held = src ? src.held(v.mint) : null;
  const solUsd = state.sol?.price ?? src?.solUsd() ?? null;
  const prow = held ? positionRow(held, shownPx, solUsd) : null;
  const posH = prow ? POSITION_PANEL_H : 0;

  // ---- chart
  const chartH = Math.max(10, Math.floor((bottom - y - posH) * lay.chartFrac));
  const cp = v.panels.candles;
  const chartCap = clip(cp.state === 'ok' || cp.fetchedAt !== null ? `ohlcv: ${cp.via ?? 'geckoterminal'}${cp.stale || cp.state === 'error' ? ' · stale' : ''}` : panelCaption(cp, now, 'ohlcv unavailable'), 40);
  const cb = c.box(0, y, mainW, chartH, { title: cm.label ? (cm.kind === 'mcap' ? `${v.symbol} ${cm.label} · ${v.interval}` : `${v.symbol}/USD · ${cm.label} · ${v.interval}`) : `${v.symbol}/USD · ${v.interval}`, caption: chartCap, captionFg: cp.state === 'error' && cp.fetchedAt === null ? t.warn : undefined });
  // timeframe tabs sit on the top border, left of the caption (same spot as the fixture screen)
  let tx = cb.x + cb.w - 2 - (chartCap.length + 4) - INTERVALS.reduce((s, f) => s + f.length + 1, 0);
  for (const f of INTERVALS) tx = c.text(tx, cb.y - 1, f, f === v.interval ? { fg: t.accent, bg: cb.bg, b: true } : { fg: t.dim, bg: cb.bg }) + 1;
  if (v.candles.length) candleChart(c, cb.x + 1, cb.y, cb.w - 2, cb.h, v.candles, { bg: cb.bg, interval: v.interval, scale: cm.scale ?? undefined, axisFmt: cm.axisFmt });
  else c.textC(cb.x, cb.y + Math.floor(cb.h / 2), cb.w, cp.state === 'loading' ? 'loading candles…' : `no candles · ${cp.reason ?? 'source did not answer'}`, { fg: t.muted, bg: cb.bg, i: true });
  y += chartH;
  if (prow && src) {
    positionPanel(c, 0, y, mainW, prow, held?.kind ?? src.kind, priceModeOf(state), cm.scale);
    y += posH;
  }

  // ---- task-1330: the SOCIAL panel (`s`) replaces the ON-CHAIN / HOLDERS band; the chart + position stay.
  if (state.tokenSocial) {
    renderSocialPanel(c, 0, y, mainW, bottom - y, state, { mint: v.mint, symbol: v.symbol, now });
  } else {
  // ---- stats + holders/tape split
  const lower = bottom - y;
  const statsW = bp === 'compact' ? mainW : Math.min(44, Math.floor(mainW * 0.4));
  const sb = c.box(0, y, statsW, lower, { title: 'ON-CHAIN', caption: onChainCaption(v, now) });
  let sy = sb.y;
  const liqSub = v.liq !== null && v.mcap !== null && v.mcap > 0 ? `${(v.liq / v.mcap * 100).toFixed(1)}% of mcap` : undefined;
  const holdersSub = v.holdersChgPct !== null ? `${v.holdersChgPct >= 0 ? '+' : ''}${v.holdersChgPct.toFixed(1)}% 24h` : undefined;
  sy += statGrid(c, sb.x + 1, sy, sb.w - 2, [
    { label: 'mcap', value: v.mcap === null ? dash : fmtUsd(v.mcap, { digits: 1 }) + (v.mcapFlagged ? '?' : ''), style: v.mcapFlagged ? { fg: t.warn } : undefined },
    { label: 'fdv', value: v.fdv === null ? dash : fmtUsd(v.fdv, { digits: 1 }) },
    { label: 'liquidity', value: v.liq === null ? dash : fmtUsd(v.liq, { digits: 1 }), sub: liqSub },
    { label: 'vol 24h', value: v.vol24 === null ? dash : fmtUsd(v.vol24, { digits: 1 }) },
    { label: 'holders', value: v.holders === null ? dash : fmtNum(v.holders), sub: holdersSub },
    { label: 'organic', value: v.org === null ? dash : `${Math.round(v.org)}/100`, style: v.org === null ? { fg: t.dim } : { fg: v.org >= 70 ? t.up : v.org >= 40 ? t.warn : t.down, b: true } },
  ], { bg: sb.bg, cols: 2 });
  sy += 1;
  const na = (why: string): [string, Level] => [why, 'na'];
  // task-1340: snipers / bundled come from the wallet-intel scan (light tier on open; M opens the bubble map).
  // task-1359: the cells are shared with the live NEW PAIRS list (launchIntelCells, one source of the thresholds).
  const cells = launchIntelCells(state.live?.intel, v.mint, 'M bubble map');
  // task-1367: the dev-mint count comes from Jupiter's audit, not Helius: once the launch window was read a missing
  // count is Jupiter not reporting it (it used to say "needs Helius key" with a key configured)
  const needsHistory = na(cells.measured ? 'not reported (jup)' : cells.snipers.text);
  // task-1367: holder classes + top-10 raw / ex-pool from the same scan; the colour reads the ex-pool figure
  const tags = holderTags(state.live?.intel, v.mint);
  const t10lvl = (p: number): Level => (p < 25 ? 'ok' : p < 35 ? 'warn' : 'bad');
  const top10Rows: Array<[string, string, Level]> = tags.top10
    ? [['Top 10 ex-pool', `${tags.top10.exPool.toFixed(1)}%`, t10lvl(tags.top10.exPool)], ['Top 10 raw', `${tags.top10.raw.toFixed(1)}%`, 'na']]
    : [['Top 10 holders', ...(v.top10 === null ? na(v.panels.holders.state === 'needs-key' ? 'needs key' : dash) : [`${v.top10.toFixed(1)}%${v.panels.holders.state === 'ok' ? '' : ' (jup)'}`, t10lvl(v.top10)] as [string, Level])]];
  // 0.1.5 dev history (task-1425): the creator's recorded track record from the local recorder (keyless). The rugs
  // row sits with the other rug signals; launches / bag-exit / linked wallets follow the safety list.
  const book = devBookOf(state);
  const devAll = book ? devRows(book.forMint(v.mint, v.devAddress ?? null, state.live?.intel?.analysis(v.mint) ?? null)) : [];
  const devHead = devAll.slice(0, 1) as Array<[string, string, Level]>;
  const devTail = devAll.slice(1) as Array<[string, string, Level]>;
  // The on-chain scan wins when it ran; otherwise Solana Tracker's numbers (keyed) fill the two rows.
  const tk = v.trackerState === 'ok' ? v.tracker : null;
  const sniperRow: [string, Level] = !cells.measured && tk && tk.sniperCount !== null
    ? [`${tk.sniperCount}${tk.sniperPct !== null ? ` · ${tk.sniperPct.toFixed(1)}%` : ''} (tracker)`, (tk.sniperPct ?? 0) >= 20 ? 'bad' : (tk.sniperPct ?? 0) >= 10 || tk.sniperCount > 3 ? 'warn' : 'ok']
    : [cells.snipers.text, cells.snipers.level];
  const bundleRow: [string, Level] = !cells.measured && tk && tk.bundlerPct !== null
    ? [`${tk.bundlerPct.toFixed(1)}%${tk.bundlerCount !== null ? ` · ${tk.bundlerCount} wallets` : ''} (tracker)`, tk.bundlerPct >= 25 ? 'bad' : tk.bundlerPct >= 15 ? 'warn' : 'ok']
    : [cells.bundle.text, cells.bundle.level];
  const trackerRows: Array<[string, string, Level]> = v.trackerState === 'off' ? []
    : v.trackerState === 'error' ? [['Solana Tracker', 'unavailable', 'na']]
    : v.trackerState === 'loading' || !tk ? [['Solana Tracker', '…', 'na']]
    : [
      ...(tk.insiderCount !== null ? [['Insiders', `${tk.insiderCount}${tk.insiderPct !== null ? ` · ${tk.insiderPct.toFixed(1)}%` : ''}`, (tk.insiderPct ?? 0) >= 20 ? 'bad' : (tk.insiderPct ?? 0) >= 10 ? 'warn' : 'ok'] as [string, string, Level]] : []),
      ['Solana Tracker', `risk ${tk.score ?? '?'}/10${tk.rugged ? ' · RUGGED' : ''}`, tk.rugged || (tk.score ?? 0) >= 7 ? 'bad' : (tk.score ?? 0) >= 4 ? 'warn' : 'ok'],
    ];
  // A coin still on the pump.fun bonding curve has no LP to lock: say so instead of a dash or a made-up 100 %.
  const lpRow: [string, Level] = v.lpLocked !== null
    ? [`${Math.round(v.lpLocked)}%`, v.lpLocked >= 90 ? 'ok' : 'bad']
    : v.dex === 'pumpfun' ? ['on curve, no LP yet', 'na'] : na(dash);
  // Token-2022 extensions that let an authority take, freeze or tax funds (decoded by the authorities read).
  const extRows: Array<[string, string, Level]> = v.riskyExtensions.length ? [['Token-2022', v.riskyExtensions.join(', '), 'bad']] : [];
  const rows: Array<[string, string, Level]> = [
    ...top10Rows,
    ['Dev wallet', ...(v.dev === null ? na(dash) : [`${v.dev.toFixed(2)}%`, v.dev < 3 ? 'ok' : v.dev < 10 ? 'warn' : 'bad'] as [string, Level])],
    ['Bundled supply', ...bundleRow],
    ['Snipers (first 3 slots)', ...sniperRow],
    ['LP locked / burned', ...lpRow],
    ...extRows,
    ['Mint authority', ...(v.mintAuth === null ? na(dash) : [v.mintAuth ? 'ENABLED' : 'revoked', v.mintAuth ? 'bad' : 'ok'] as [string, Level])],
    ['Freeze authority', ...(v.freezeAuth === null ? na(dash) : [v.freezeAuth ? 'ENABLED' : 'revoked', v.freezeAuth ? 'bad' : 'ok'] as [string, Level])],
    ['Dev history', ...(v.devMints === null ? needsHistory : [`${v.devMints} mints by dev (jup)`, v.devMints > 3 ? 'warn' : 'ok'] as [string, Level])],
    ...devHead,
    ['RugCheck score', ...(v.rug === null || v.rug.score === null ? na(v.panels.rugcheck.state === 'error' ? `unavailable: ${v.panels.rugcheck.reason ?? ''}`.trim() : dash) : [`${Math.round(v.rug.score)}/100`, v.rug.score < 30 ? 'ok' : v.rug.score < 60 ? 'warn' : 'bad'] as [string, Level])],
    ['GoPlus', ...goplusRow(v)],
    ...trackerRows,
    ...devTail,
  ];
  for (const [label, val0, lvl] of rows) {
    if (sy >= sb.y + sb.h) break;
    const color = lvl === 'ok' ? t.up : lvl === 'warn' ? t.warn : lvl === 'bad' ? t.down : t.dim;
    c.text(sb.x + 1, sy, lvl === 'ok' ? '●' : lvl === 'warn' ? '◐' : lvl === 'bad' ? '○' : '·', { fg: color, bg: sb.bg });
    // label and value share the row: the value keeps at most half, the label takes what is left
    const inner = sb.w - 4;
    const val = clip(val0, Math.max(8, inner - 8));
    c.text(sb.x + 3, sy, label, { fg: t.muted, bg: sb.bg }, Math.max(4, inner - val.length - 1));
    c.textR(sb.x + 1, sy, sb.w - 2, val, { fg: lvl === 'ok' ? t.text : lvl === 'na' ? t.dim : color, bg: sb.bg, b: lvl === 'bad', i: lvl === 'na' });
    sy += 1;
  }
  if (v.rug && v.rug.risks.length && sy < sb.y + sb.h) {
    sy += sy + 1 < sb.y + sb.h ? 1 : 0;
    for (const r of v.rug.risks.slice(0, 4)) {
      if (sy >= sb.y + sb.h) break;
      const color = r.level === 'danger' ? t.down : r.level === 'warn' ? t.warn : t.muted;
      c.text(sb.x + 1, sy, `${r.level === 'danger' ? '○' : r.level === 'warn' ? '◐' : '·'} ${r.name}`, { fg: color, bg: sb.bg }, sb.w - 2);
      sy += 1;
    }
  }
  // task-1404: LIVE holder/rug signals — the changes seen since the token was opened (dev sell, concentration
  // shift, LP unlock, authority flip, new bundle/sniper, fresh inflow, bonding, migration). Each is a risk flag,
  // not a verdict, and carries its SOURCE and the AGE of the data it read; the `stale` mark shows honestly.
  const sigs = state.live?.signals?.recent(v.mint, 4) ?? [];
  if (sigs.length && sy < sb.y + sb.h) {
    sy += sy + 1 < sb.y + sb.h ? 1 : 0;
    if (sy < sb.y + sb.h) { c.text(sb.x + 1, sy, 'LIVE SIGNALS', { fg: t.dim, bg: sb.bg }); sy += 1; }
    const staleAfter = 60_000;
    for (const s of sigs) {
      if (sy >= sb.y + sb.h) break;
      const color = s.level === 'warn' ? t.warn : s.level === 'down' ? t.down : s.level === 'up' ? t.up : t.muted;
      const ageMs = Math.max(0, now - s.at);
      const stale = ageMs > staleAfter;
      const meta = `${s.source} · ${ageMs >= 1000 ? `${Math.round(ageMs / 1000)}s` : 'now'}${stale ? ' · stale' : ''}`;
      const metaClip = clip(meta, Math.max(8, Math.floor((sb.w - 2) / 2)));
      c.text(sb.x + 1, sy, `⚑ ${s.title}`, { fg: color, bg: sb.bg, b: s.level === 'warn' || s.level === 'down' }, sb.w - 2 - metaClip.length - 1);
      c.textR(sb.x + 1, sy, sb.w - 2, metaClip, { fg: stale ? t.warn : t.dim, bg: sb.bg, i: true });
      sy += 1;
    }
  }

  if (bp !== 'compact') {
    const hx = statsW;
    const hw = mainW - statsW;
    const hp = v.panels.holders;
    // task-1305 (M10): a keyless user on the public RPC gets throttled holders with a raw "rate limited
    // (429)". Point them at the fix instead — a free Helius key, which `trenchscope doctor` walks through.
    const keyless = state.live?.rpc.provider === 'public';
    const keyHint = 'needs a free Helius key — run `trenchscope doctor`';
    const holdersNeedsKey = hp.state === 'needs-key' || (keyless && hp.state === 'error');
    const hcap = hp.state === 'ok' || hp.fetchedAt !== null ? `${v.holdersSample ?? 'holders'} · via ${hp.via ?? '?'}${hp.stale || hp.state === 'error' ? ' · stale' : ''}` : holdersNeedsKey ? `holders: ${keyHint}` : hp.state === 'loading' ? 'holders: loading…' : `holders unavailable: ${hp.reason ?? 'rpc failed'}`;
    const hb = c.box(hx, y, hw, lower, { title: 'HOLDERS', caption: hcap, captionFg: hp.state === 'error' && hp.fetchedAt === null ? t.warn : undefined });
    let hy = hb.y;
    c.text(hb.x + 1, hy, 'WALLET', { fg: t.dim, bg: hb.bg });
    c.textR(hb.x + 1, hy, hb.w - 2, '%   AMOUNT', { fg: t.dim, bg: hb.bg });
    hy += 1;
    // task-1367: the main-risk line (an unlabelled / creator / linked owner > 30 %) or why the biggest holder is not one
    if (tags.note && hy < hb.y + hb.h) {
      c.text(hb.x + 1, hy, `${tags.note.level === 'bad' ? '⚠ ' : '· '}${tags.note.text}`, { fg: tags.note.level === 'bad' ? t.down : t.muted, bg: hb.bg, b: tags.note.level === 'bad' }, hb.w - 2);
      hy += 1;
    }
    // task-1323 item 6: the panel under the holders is BUY/SELL FLOW by default; `F` swaps in the raw
    // tape (state.tokenTape). Flow reads only data already fetched: the tape (1m) and the DexScreener
    // pair Store.enrich cached on the market refresh (5m..24h) — no request of its own.
    const tapeOn = state.tokenTape === true;
    let flowRows: ReturnType<FlowTracker['rows']> = [];
    let flow: FlowTracker | null = null;
    if (!tapeOn) {
      flow = state.tokenFlow ??= new FlowTracker();
      const dl = state.live?.token?.dl ?? state.live?.dl;
      if (dl) flow.syncFromCache(dl.cache, v.mint);
      flowRows = flow.rows(v.mint, { trades: v.trades, panel: v.panels.trades }, now);
    }
    const reserve = tapeOn ? (v.trades.length ? Math.min(8, v.trades.length) + 3 : 0) : flowRows.length + 3;
    const shown = v.holdersTop.slice(0, Math.max(0, Math.min(v.holdersTop.length, hb.h - (hy - hb.y) - reserve)));
    if (!shown.length) {
      c.textC(hb.x, hy + 1, hb.w, hp.state === 'loading' ? 'loading holders…' : holdersNeedsKey ? keyHint : `unavailable: ${hp.reason ?? 'no holder source answered'}`, { fg: holdersNeedsKey ? t.warn : t.muted, bg: hb.bg, i: true });
      hy += 3;
    }
    const maxPct = Math.max(1e-9, ...shown.map((h) => h.pct));
    // task-1367: a class badge (up to " UNLABELLED ") needs two more columns than the old static labels
    const tagged = tags.byOwner.size > 0;
    const barW = Math.max(6, hb.w - (tagged ? 40 : 38));
    for (const h of shown) {
      if (hy >= hb.y + hb.h) break;
      const cx = c.text(hb.x + 1, hy, shortAddr(h.address, 4), { fg: h.tokenAccountOnly ? t.muted : t.text, bg: hb.bg });
      // task-1367: the scan's class wins (POOL / CURVE / … / UNLABELLED); before it lands the static label, if any
      const cls = tags.byOwner.get(h.address) ?? null;
      const tag = cls ? cls.tag : h.label ? h.label.toUpperCase() : null;
      const notPerson = cls ? EX_POOL_TAG_SET.has(cls.tag) : h.label === 'LP';
      if (tag) badge(c, cx + 1, hy, tag, tagColor(t, tag), { on: hb.bg });
      const bx = hb.x + (tagged ? 24 : 22);
      bar(c, bx, hy, barW, (h.pct / maxPct) * 100, { bg: hb.bg, color: notPerson ? t.accent : h.pct > 5 ? t.warn : mix(hb.bg, t.accent, 0.6) });
      c.textR(hb.x + 1, hy, hb.w - 2, `${h.pct.toFixed(2).padStart(5)}  ${fmtAmt(h.amount).padStart(7)}`, { fg: h.pct > 5 ? t.warn : t.muted, bg: hb.bg });
      hy += 1;
    }
    // tape (toggled) or buy/sell flow (default) under holders if room
    if (hy + 3 < hb.y + hb.h) {
      hy += 1;
      c.hline(hb.x, hy - 1, hb.w, { fg: t.border, bg: hb.bg });
      const tp = v.panels.trades;
      if (tapeOn) {
        c.text(hb.x + 1, hy, 'TAPE', { fg: t.dim, bg: hb.bg });
        c.textR(hb.x + 1, hy, hb.w - 2, tp.state === 'ok' || tp.fetchedAt !== null ? `geckoterminal · 20s poll${tp.stale || tp.state === 'error' ? ' · stale' : ''}` : panelCaption(tp, now, 'tape unavailable'), { fg: tp.state === 'error' && tp.fetchedAt === null ? t.warn : t.dim, bg: hb.bg });
        hy += 1;
        hy += tradeTape(c, hb.x + 1, hy, hb.w - 2, hb.y + hb.h - hy, v.trades, now, { bg: hb.bg });
      } else if (flow) {
        c.text(hb.x + 1, hy, 'BUY/SELL FLOW', { fg: t.dim, bg: hb.bg });
        c.textR(hb.x + 15, hy, hb.w - 16, flow.caption(v.mint, now), { fg: t.dim, bg: hb.bg });
        hy += 1;
        hy += flowPanel(c, hb.x + 1, hy, hb.w - 2, hb.y + hb.h - hy, flowRows, { bg: hb.bg });
        if (hy < hb.y + hb.h) c.text(hb.x + 1, hy, 'trend = buy share vs the previous window', { fg: t.dim, bg: hb.bg, i: true }, hb.w - 2);
      }
    }
  }

  }
  if (showAi) analystPlaceholder(c, mainW, top, aiW, bottom - top, v, state);
  const watched = state.live?.watch?.has(v.mint) ? 'unwatch' : 'watch';
  // task-1311: `i` asks claude about this token (chat), `a` runs the paid dossier on demand, `y`
  // copies the full contract address.
  const aLabel = state.analyst ? (showAi ? 'hide' : 'show') : 'dossier';
  // task-1315: surface the open-links keys only when the coin actually advertises a link.
  const hasLinks = !!(v.socialLinks.web || v.socialLinks.x || v.socialLinks.tg);
  const keys: Array<[string, string]> = state.tokenSocial
    ? [['esc', 'back'], ['s', 'on-chain'], ['f', 'filter'], ['x', state.socialShowSpam ? 'hide spam' : 'show hidden'], ['K', 'KOL lists'], ['i', 'ask'], ['a', aLabel], ['B/S', 'paper trade'], ['y', 'copy CA']]
    : [['esc', 'back'], ['i', 'ask'], ['a', aLabel], ['s', 'social'], ['M', 'bubble map'], ['V', 'vet product'], ['B/S', 'paper trade'], ['1-6', 'timeframe'], ['F', state.tokenTape ? 'flow' : 'tape'], ['y', 'copy CA']];
  if (hasLinks) keys.push(['W/X/T', 'open site/x/tg'], ['L', 'all links']);
  keys.push(['w', watched], ['P', 'positions'], ['q', 'quit']);
  footer(c, keys, state.theme.name);
}

/** Height of the POSITION panel (border, labels, values, border). */
export const POSITION_PANEL_H = 4;

/** `$0.0₄123` for USD, `0.0₄123 SOL` when only the SOL ledger price is known. */
function pxText(usd: number | null, solPx: number | null): string {
  if (usd !== null) return fmtPrice(usd);
  if (solPx !== null) return `${fmtPrice(solPx).replace('$', '')} SOL`;
  return dash;
}

/**
 * One-row table of the held position under the chart (task-1323 item 5): side, size in tokens and USD,
 * average entry, current price, unrealized $ and %, realized (only when there is some), and the distance
 * to a stop/target (only when set). Falls back to SOL units when SOL/USD is unknown. Columns drop by
 * priority when the panel is narrow (target/stop first, then realized).
 */
function positionPanel(c: Canvas, x: number, y: number, w: number, r: HeldRow, kind: 'paper' | 'live', mode: PriceMode = 'price', supply: number | null = null): void {
  const t = c.theme;
  const usd = r.solUsd !== null;
  const cap = r.basis === 'none' ? 'no price yet' : usd ? `${kind} ledger · SOL $${r.solUsd!.toFixed(2)}` : `${kind} ledger · SOL units (no SOL/USD yet)`;
  const box = c.box(x, y, w, POSITION_PANEL_H, { title: kind === 'paper' ? '◈ POSITION · PAPER' : '◈ POSITION', titleFg: kind === 'paper' ? t.warn : t.text, caption: cap });
  const bg = box.bg;
  const pnlColor = (n: number | null) => (n === null ? t.muted : n > 0 ? t.up : n < 0 ? t.down : t.muted);
  type Col = { label: string; value: string; st: Style; prio: number };
  const cols: Col[] = [];
  cols.push({ label: 'SIDE', value: r.side.toUpperCase(), st: { fg: r.side === 'long' ? t.up : t.down, bg, b: true }, prio: 0 });
  cols.push({ label: 'SIZE', value: `${fmtAmt(r.tokens)} ${r.symbol}`, st: { fg: t.text, bg }, prio: 0 });
  cols.push({ label: 'VALUE', value: r.valueUsd !== null ? fmtUsdFine(r.valueUsd) : r.valueSol !== null ? `${fmtSol(r.valueSol)} SOL` : dash, st: { fg: t.text, bg, b: true }, prio: 0 });
  // task-1366: in mcap mode (supply known) AVG / PRICE read market cap; PnL stays USD
  const pc = positionPriceCells(mode, supply, r.avgEntryUsd, r.priceUsd, pxText(r.avgEntryUsd, r.avgEntrySol), pxText(r.priceUsd, r.priceSol));
  cols.push({ label: pc.avg.label, value: pc.avg.value, st: { fg: t.muted, bg }, prio: 1 });
  cols.push({ label: pc.price.label, value: pc.price.value, st: { fg: t.text, bg }, prio: 1 });
  const uAmt = usd ? (r.unrealizedUsd !== null ? signedUsd(r.unrealizedUsd) : null) : (r.unrealizedSol !== null ? `${signedSol(r.unrealizedSol)} SOL` : null);
  cols.push({ label: 'UNREALIZED', value: uAmt === null ? dash : `${uAmt}${r.unrealizedPct !== null ? ` ${signedPctOf(r.unrealizedPct)}` : ''}`, st: { fg: pnlColor(r.unrealizedSol), bg, b: true }, prio: 0 });
  if (r.realizedSol !== 0) cols.push({ label: 'REALIZED', value: usd && r.realizedUsd !== null ? signedUsd(r.realizedUsd) : `${signedSol(r.realizedSol)} SOL`, st: { fg: pnlColor(r.realizedSol), bg }, prio: 2 });
  if (r.stopUsd !== null) cols.push({ label: 'STOP', value: `${fmtPrice(r.stopUsd)}${r.stopDistPct !== null ? ` ${signedPctOf(r.stopDistPct)}` : ''}`, st: { fg: t.down, bg }, prio: 3 });
  if (r.targetUsd !== null) cols.push({ label: 'TARGET', value: `${fmtPrice(r.targetUsd)}${r.targetDistPct !== null ? ` ${signedPctOf(r.targetDistPct)}` : ''}`, st: { fg: t.up, bg }, prio: 3 });
  const gap = 3;
  const widthOf = (list: Col[]) => list.reduce((s, k) => s + Math.max(k.label.length, k.value.length) + gap, -gap);
  const inner = box.w - 2;
  let keep = cols.slice();
  while (keep.length > 1 && widthOf(keep) > inner) {
    const worst = Math.max(...keep.map((k) => k.prio));
    const i = keep.map((k) => k.prio).lastIndexOf(worst);
    keep = keep.filter((_, j) => j !== i);
  }
  let cx = box.x + 1;
  for (const k of keep) {
    const cw = Math.max(k.label.length, k.value.length);
    c.text(cx, box.y, k.label, { fg: t.dim, bg }, Math.max(0, box.x + box.w - 1 - cx));
    c.text(cx, box.y + 1, k.value, k.st, Math.max(0, box.x + box.w - 1 - cx));
    cx += cw + gap;
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s;
}

/** Token amounts up to trillions (fmtNum stops at B). */
function fmtAmt(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  return fmtNum(n);
}

function onChainCaption(v: TokenView, now: number): string {
  const a = v.panels.authorities;
  if (a.state === 'ok' || a.fetchedAt !== null) return `via ${a.via ?? '?'}${v.tokenProgram ? ` · ${v.tokenProgram}` : ''}${a.stale || a.state === 'error' ? ' · stale' : ''}`;
  if (a.state === 'loading') return 'authorities: loading…';
  if (a.state === 'needs-key') return 'authorities: needs key';
  return `authorities: ${v.mintAuth !== null ? 'jup/goplus' : 'unavailable'}${a.reason ? ` (${a.reason})` : ''}${panelCaption(a, now) ? '' : ''}`;
}

function goplusRow(v: TokenView): [string, Level] {
  const p = v.panels.goplus;
  if (!v.goplus) return [p.state === 'loading' ? 'loading…' : p.state === 'error' ? `unavailable: ${p.reason ?? ''}`.trim() : '—', 'na'];
  const g = v.goplus;
  if (g.flags.length) return [g.flags.map((f) => f.replace(/^goplus:/, '')).join(', '), g.flags.some((f) => /mintable|freezable|malicious|transfer-hook|balance-mutable/.test(f)) ? 'bad' : 'warn'];
  const extra = g.lpHolders.length ? ` · ${g.lpHolders.length} LP holders` : '';
  return [`clean${extra}`, 'ok'];
}

// ---------------- labelled analyst placeholder (Claude wiring is a later card) ----------------
function analystPlaceholder(c: Canvas, x: number, y: number, w: number, h: number, v: TokenView, state: AppState): void {
  if (state.analyst) {
    const focused = state.aiFocused === true;
    renderAnalystSession(c, x, y, w, h, state.analyst, {
      frame: state.vfx.frame, code: state.vfx.code, calm: isCalm(state.vfx),
      input: state.aiInput ?? '', inputFocused: focused,
      scroll: state.aiScroll, revealAll: state.aiRevealAll,
      chips: [`$${v.symbol}`, v.panels.holders.state === 'ok' ? `holders:${v.holdersTop.length}` : 'holders:—', v.panels.trades.state === 'ok' ? `trades:${v.trades.length}` : 'trades:—', v.rug ? 'rugcheck' : 'rugcheck:—', 'candles'],
      inputHint: focused ? `ask about $${v.symbol}…  ⏎ send · esc blur` : `press i to ask about $${v.symbol} · read-only`,
    });
    return;
  }
  // task-1311 (QA M5): the pre-run state. Opening a token no longer spends a paid dossier; this panel
  // waits until you ask for one with `a` (dossier) or type a question with `i`. No fake verdicts.
  const t = c.theme;
  const eng = state.analystEngine ?? 'claude'; // 0.1.5: the user's own CLI that will answer
  const box = c.box(x, y, w, h, { title: `✦ ANALYST · ${eng}`, titleFg: t.ai, caption: `read-only · local ${eng} · on demand`, captionFg: t.dim, border: mix(t.border, t.ai, 0.35) });
  const bg: Hex = box.bg;
  const inner = box.w - 2;
  let cy = box.y;
  let cx = box.x + 1;
  const chips = [`$${v.symbol}`, v.panels.holders.state === 'ok' ? `holders:${v.holdersTop.length}` : 'holders:—', v.panels.trades.state === 'ok' ? `trades:${v.trades.length}` : 'trades:—', v.rug ? 'rugcheck' : 'rugcheck:—', v.goplus ? 'goplus' : 'goplus:—'];
  for (const chip of chips) {
    if (cx + chip.length + 3 > box.x + box.w - 1) break;
    cx = badge(c, cx, cy, chip, t.ai, { on: bg }) + 1;
  }
  cy += 2;
  const lines = [
    'Press  a  to run a full dossier on this token (one paid claude run), or  i  to ask a free-text question.',
    '',
    'The chips above are the live context claude gets: holders, tape, RugCheck, GoPlus and candles, each with its source and age.',
    '',
    'Opening a token is free — the analyst only runs when you ask, and keeps a separate conversation per token.',
  ];
  const inputY = box.y + box.h - 2;
  for (const ln of lines) {
    if (cy >= inputY - 1) break;
    if (!ln) { cy += 1; continue; }
    for (const w2 of wrap(ln, inner - 2)) { if (cy >= inputY - 1) break; c.text(box.x + 2, cy, w2, { fg: t.muted, bg }); cy += 1; }
  }
  const bc = mix(t.border, t.ai, 0.35);
  const focused = state.aiFocused === true;
  const typed = state.aiInput ?? '';
  c.hline(box.x, inputY - 1, box.w, { fg: bc, bg });
  c.put(box.x, inputY - 1, '├', { fg: bc, bg });
  c.put(box.x + box.w - 1, inputY - 1, '┤', { fg: bc, bg });
  c.text(box.x + 1, inputY, '▌', { fg: focused ? t.ai : t.dim, bg, b: true });
  if (typed) c.text(box.x + 2, inputY, typed + (focused ? '█' : ''), { fg: t.text, bg }, inner - 2);
  else c.text(box.x + 2, inputY, focused ? `█ ask about $${v.symbol}…  ⏎ send` : `press i to ask · a for a dossier`, { fg: t.dim, bg, i: true }, inner - 2);
}
