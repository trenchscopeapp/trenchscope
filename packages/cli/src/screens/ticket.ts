// trenchscope — trade ticket screen (task-1310 T0 PAPER; task-1328 T2 LIVE). PAPER: a simulated buy/sell
// priced from a live keyless Jupiter quote, every frame labelled PAPER. LIVE: the same ticket in LIVE
// mode — ⏎ asks the SIGNER PROCESS to quote → build → decode → simulate and shows the PLAN (what will be
// signed, in/out, impact as a percent, fee, route, the signer's caps verdict); Y is the keypress; the
// signer then opens Phantom. The banner's network comes from the signer's own status (classified from
// the RPC it talks to) — never from a flag the UI holds, so the label cannot disagree with the
// connection. Pure renderer: the state machine + bindings live elsewhere; nothing here signs.
import {
  Canvas, badge, header, footer, breakpoint, mix, isCalm, fmtPrice, fmtPriceBare, fmtAmount, fmtPct,
} from '@dexterm/tui';
import { lamportsToSol, rawToTokens } from '@dexterm/data';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import { slippageBps, simFailureHint, type LiveTicketView, type TicketView } from '../trade.ts';

function fmtSol(sol: number, digits = 4): string {
  const a = Math.abs(sol);
  return `${a.toFixed(digits)} SOL`;
}

/**
 * task-1368 item e: a token quantity for the ticket. `fmtAmount` keeps small amounts (0.0144 AVGOx, never "0");
 * when the token's decimals are still unknown the number would be a guess, so say that and show the raw units.
 */
function tokenAmount(raw: bigint, decimals: number, symbol: string, decimalsKnown: boolean): string {
  if (!decimalsKnown) return `${symbol}: decimals unknown yet (raw ${raw.toString()})`;
  return `${fmtAmount(rawToTokens(raw, decimals))} ${symbol}`;
}

/** Word-wrap `text` into at most `maxLines` lines of `width` columns; the last line is cut with an ellipsis. */
function wrapLines(text: string, width: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= width) { cur = next; continue; }
    if (cur) lines.push(cur);
    cur = w.length > width ? `${w.slice(0, Math.max(1, width - 1))}…` : w;
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length > maxLines) lines.length = maxLines;
  const joined = lines.join(' ');
  if (joined.length < text.length && lines.length === maxLines) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.length >= width - 1 ? `${last.slice(0, Math.max(1, width - 1))}…` : `${last}…`;
  }
  return lines;
}

export function renderTicket(c: Canvas, state: AppState): void {
  const t = c.theme;
  header(c, headerModel(state));
  const bp = breakpoint(c.w);
  // Live binding is the source of truth; the seeded demo view backs fixture/one-shot frames.
  const view = (state.live?.ticket ? state.live.ticket.view() : state.ticket) ?? null;
  const live = view?.live ?? null;
  const isLive = !!live;

  // Always-on banner strip (never hidden, any state). PAPER = warn tint; LIVE = the signer's network.
  const bannerY = 2;
  const net = live?.signer?.network ?? null; // the SIGNER's classified network, or unknown
  const mainnet = net === 'mainnet';
  const bannerColor = !isLive ? t.warn : mainnet ? t.down : t.up;
  c.fill(0, bannerY, c.w, 1, ' ', { bg: mix(t.bg, bannerColor, mainnet ? 0.3 : 0.16) });
  const banner = !isLive
    ? ' ◈ PAPER TRADING — simulated · no real orders · no keys · no signing '
    : net === null
      ? ' ◉ LIVE — signer not reachable · nothing can be signed '
      : mainnet
        ? ` ⚠ LIVE · MAINNET — REAL FUNDS · caps $${live?.signer?.caps.perTradeUsd ?? '?'}/trade $${live?.signer?.caps.dailyUsd ?? '?'}/day · Phantom signs · trenchscope holds no key `
        : ` ◉ LIVE · DEVNET — real signing via Phantom · devnet funds only · trenchscope holds no key `;
  c.text(2, bannerY, banner, { fg: bannerColor, bg: mix(t.bg, bannerColor, mainnet ? 0.3 : 0.16), b: true });
  const linked = state.live?.linkedWallet;
  if (linked) c.textR(2, bannerY, c.w - 3, `linked: ${linked.publicKey.slice(0, 4)}…${linked.publicKey.slice(-4)} `, { fg: t.muted, bg: mix(t.bg, bannerColor, mainnet ? 0.3 : 0.16) });
  c.noRain(0, bannerY, c.w, 1);
  if (live && (live.signer?.panic || live.signer?.ledgerLocked)) {
    c.fill(0, bannerY + 1, c.w, 1, ' ', { bg: mix(t.bg, t.down, 0.3) });
    c.text(2, bannerY + 1, ' ⛔ PANIC — live signing is disabled · re-enable only from a shell: trenchscope wallet resume ', { fg: t.down, bg: mix(t.bg, t.down, 0.3), b: true });
    c.noRain(0, bannerY + 1, c.w, 1);
  }

  if (!view) {
    c.text(2, 4, 'Open a trade ticket from a token screen:  B buy · S sell   (L on the ticket flips PAPER ⇄ LIVE)', { fg: t.muted, bg: t.bg });
    footer(c, [['esc', 'back'], ['P', 'positions'], ['q', 'quit']], t.name, isCalm(state.vfx));
    return;
  }

  const ts = view.ticket;
  const buy = ts.side === 'buy';
  const sideColor = buy ? t.up : t.down;
  const top = 4;
  const w = Math.min(bp === 'compact' ? c.w - 2 : 78, c.w - 2);
  const x0 = 1;
  const h = c.h - top - 1;
  const title = isLive ? `◉ LIVE ${live?.probe ? 'DEVNET PROBE' : `${ts.side.toUpperCase()} TICKET`}` : `◈ PAPER ${ts.side.toUpperCase()} TICKET`;
  const caption = isLive ? `signer process · jupiter quote · phantom signs${net ? ` · ${net}` : ''}` : 'jupiter keyless quote · paper fill';
  // task-1340: the ticket is PLAIN by construction — no heading (no chromatic split on its title) and every cell of
  // its rect is shielded below, so no effect pass (rain, mosh, shake, scanlines, trade moments) can write a glyph, a
  // colour or a background into it in any phase. The banner rows above it are shielded too.
  const box = c.box(x0, top, w, h, { title, titleFg: isLive && mainnet ? t.down : sideColor, caption, captionFg: t.dim, border: mix(t.border, isLive && mainnet ? t.down : sideColor, 0.5), plain: true });
  c.shieldRect(x0, top, w, h);
  c.shieldRect(0, bannerY, c.w, 2);
  const bg = box.bg;
  const ix = box.x + 2;
  const iw = box.w - 4;
  let y = box.y + 1;

  // identity + side toggle
  let x = c.text(ix, y, `$${ts.symbol}`, { fg: t.borderFocus, bg, b: true });
  x = c.text(x + 1, y, `${ts.mint.slice(0, 4)}…${ts.mint.slice(-4)}`, { fg: t.dim, bg });
  x = badge(c, x + 2, y, buy ? '▲ BUY' : '▼ SELL', sideColor, { on: bg, bold: true }) + 1;
  x = badge(c, x + 1, y, isLive ? 'LIVE' : 'PAPER', isLive ? (mainnet ? t.down : t.up) : t.warn, { on: bg, bold: true }) + 1;
  c.textR(ix, y, iw, ts.phase === 'editing' ? '← → flip side · L paper⇄live' : '', { fg: t.dim, bg });
  y += 2;

  // size field
  if (!live?.probe) {
    const sizeUnit = buy ? (ts.sizeUnit === 'sol' ? 'SOL' : '% of balance') : '% of position';
    field(c, ix, y, iw, bg, 'Size', `${ts.sizeInput || '—'} ${sizeUnit}`, ts.field === 'size' && ts.phase === 'editing', t);
    y += 1;
    field(c, ix, y, iw, bg, 'Slippage', `${slippageBps(ts)} bps`, ts.field === 'slippage' && ts.phase === 'editing', t);
    y += 2;
  }

  const showPlan = isLive && live && live.plan && (ts.phase === 'plan' || ts.phase === 'signing' || ts.phase === 'filled' || ts.phase === 'refused' || ts.phase === 'error');
  if (showPlan && live?.plan) {
    y = renderPlan(c, ix, y, iw, bg, live, ts.decimals, ts.symbol, buy, state.now.getTime());
  } else {
    // quote block (paper warm quote; LIVE editing shows the same keyless quote as a preview)
    c.text(ix, y, isLive ? 'PREVIEW QUOTE (keyless; the signer re-quotes on ⏎)' : 'QUOTE', { fg: t.dim, bg });
    c.textR(ix, y, iw, view.loading ? '· fetching…' : view.quote ? `· ${Math.max(0, Math.round((view.quoteAgeMs ?? 0) / 1000))}s ago` : view.error ? '· unavailable' : '', { fg: view.error ? t.down : t.dim, bg });
    c.hline(box.x + 1, y + 1, box.w - 2, { fg: t.border, bg, soft: true });
    y += 2;
    const q = view.quote;
    const preview = view.preview;
    const decimalsKnown = view.decimalsKnown !== false;
    if (q && preview) {
      const tokenAbs = buy ? preview.tokenDelta : -preview.tokenDelta;
      const spend = buy ? `${fmtSol(lamportsToSol(-preview.solDelta))}` : tokenAmount(tokenAbs, ts.decimals, ts.symbol, decimalsKnown);
      const recv = buy ? tokenAmount(tokenAbs, ts.decimals, ts.symbol, decimalsKnown) : `${fmtSol(lamportsToSol(preview.solDelta))}`;
      kv(c, ix, y++, iw, bg, 'You pay', spend, t, buy ? t.down : t.text);
      kv(c, ix, y++, iw, bg, 'You receive', recv, t, buy && !decimalsKnown ? t.warn : t.up);
      kv(c, ix, y++, iw, bg, 'Price', decimalsKnown ? `${fmtPriceBare(preview.priceSol)} SOL${preview.priceUsd !== null ? `  ·  ${fmtPrice(preview.priceUsd)}` : ''}` : 'per-token price needs the decimals', t, decimalsKnown ? t.text : t.warn);
      const impact = preview.priceImpactPct;
      kv(c, ix, y++, iw, bg, 'Price impact', impact === null ? '—' : fmtPct(impact, { sign: false }), t, impact !== null && impact > 5 ? t.down : impact !== null && impact > 1 ? t.warn : t.muted);
      kv(c, ix, y++, iw, bg, 'Min received', buy ? tokenAmount(q.otherAmountThreshold, ts.decimals, ts.symbol, decimalsKnown) : fmtSol(lamportsToSol(q.otherAmountThreshold)), t, t.muted);
      kv(c, ix, y++, iw, bg, isLive ? 'Est. fee' : 'Sim fee', fmtSol(lamportsToSol(preview.feeLamports), 6), t, t.muted);
      kv(c, ix, y++, iw, bg, 'Route', q.route.length ? q.route.join(' → ') : 'direct', t, t.accent);
    } else if (view.error) {
      c.text(ix, y++, `⚠ ${view.error}`, { fg: t.down, bg }, iw);
    } else if (live?.probe) {
      c.text(ix, y++, 'wrap 0.001 SOL into your own WSOL account, sync, memo, close it back — fees only', { fg: t.dim, bg }, iw);
    } else {
      c.text(ix, y++, view.loading ? 'fetching a live quote…' : 'enter a size to see a quote', { fg: t.dim, bg }, iw);
    }
    // task-1368 items b + c: BEFORE ⏎ on a LIVE ticket — the size in USD against the signer's caps (red when the
    // signer would refuse it, with the size that fits), and the devnet-cannot-fill-mainnet-tokens line.
    if (isLive && live && !live.probe && ts.phase === 'editing') {
      const pf = live.preflight ?? null;
      if (pf) {
        const color = pf.over ? t.down : pf.sizeUsd === null && pf.sizeSol > 0 ? t.warn : t.muted;
        for (const line of wrapLines(`${pf.over ? '✗ ' : ''}${pf.line}`, iw, 2)) c.text(ix, y++, line, { fg: color, bg, b: pf.over }, iw);
      }
      if (live.devnetWarning) for (const line of wrapLines(`⚠ ${live.devnetWarning}`, iw, 2)) c.text(ix, y++, line, { fg: t.warn, bg, b: true }, iw);
    }
    y += 1;
  }

  // wallet line
  c.hline(box.x + 1, y, box.w - 2, { fg: t.border, bg, soft: true });
  y += 1;
  if (isLive) {
    kv(c, ix, y++, iw, bg, 'Signer', live?.signer ? `${live.signer.network.toUpperCase()} · ${live.signer.rpcHost} · pid ${live.signer.pid}` : (live?.error ?? 'not reachable'), t, live?.signer ? t.text : t.down);
    if (live?.signer) kv(c, ix, y++, iw, bg, 'Caps', `$${live.signer.caps.perTradeUsd}/trade · $${live.signer.caps.dailyUsd}/day · spent $${live.signer.spentTodayUsd.toFixed(2)} · impact ≤ ${live.signer.caps.maxPriceImpactPct}% · ≤ ${live.signer.caps.maxSolOut} SOL out`, t, t.muted);
    kv(c, ix, y++, iw, bg, 'Wallet', live?.linked ? `${live.linked} (Phantom signs; trenchscope holds no key)` : 'none linked', t, live?.linked ? t.text : t.down);
  } else {
    kv(c, ix, y++, iw, bg, 'Paper balance', fmtSol(view.balanceSol), t, t.text);
  }
  if (!buy || view.positionTokens > 0) kv(c, ix, y++, iw, bg, `Position`, `${fmtAmount(view.positionTokens)} ${ts.symbol}${isLive ? ' (live ledger)' : ''}`, t, t.muted);
  y += 1;

  // gate / receipt region
  const gy = box.y + box.h - 3;
  c.hline(box.x, gy - 1, box.w, { fg: mix(t.border, sideColor, 0.5), bg, soft: true });
  const tint = mix(bg, sideColor, 0.18);
  if (ts.phase === 'confirm') {
    c.fill(box.x + 1, gy, box.w - 2, 2, ' ', { bg: tint });
    if (ts.typebackRequired) {
      c.text(ix, gy, `⚠ large order — type the size (${ts.sizeInput}) then press Y:`, { fg: t.warn, bg: tint, b: true }, iw);
      c.text(ix, gy + 1, `▌ ${ts.typeback || ''}`, { fg: t.text, bg: tint, b: true });
    } else {
      c.text(ix, gy, `CONFIRM PAPER ${ts.side.toUpperCase()} — press Y   (esc cancels)`, { fg: sideColor, bg: tint, b: true }, iw);
    }
    if (ts.message) c.text(ix, gy + 1, ts.message, { fg: t.warn, bg: tint }, iw);
  } else if (ts.phase === 'planning' && live?.retryAt) {
    // task-1368: rate limited by Jupiter — the plan is NOT dropped; countdown + r / esc.
    const left = Math.max(0, Math.ceil((live.retryAt - state.now.getTime()) / 1000));
    const what = (live.retryMessage ?? 'Jupiter is rate limiting this IP').replace(/; retry in \d+s$/, '');
    c.fill(box.x + 1, gy, box.w - 2, 2, ' ', { bg: mix(bg, t.warn, 0.18) });
    c.text(ix, gy, `⚠ ${what}, retrying in ${left}s`, { fg: t.warn, bg: mix(bg, t.warn, 0.18), b: true }, iw);
    c.text(ix, gy + 1, 'r = retry now · esc = cancel · the plan is kept (nothing was built or signed)', { fg: t.muted, bg: mix(bg, t.warn, 0.18) }, iw);
  } else if (ts.phase === 'planning') {
    c.text(ix, gy, 'signer: quote → build → decode → policy → simulate…   (esc cancels)', { fg: t.ai, bg, b: true }, iw);
  } else if (ts.phase === 'plan' && live?.plan) {
    const refused = !live.plan.policy.ok || !live.plan.precheck.ok;
    c.fill(box.x + 1, gy, box.w - 2, 2, ' ', { bg: tint });
    if (refused) {
      const v = !live.plan.policy.ok ? live.plan.policy : live.plan.precheck;
      c.text(ix, gy, `✗ the signer WILL REFUSE this plan: ${v.reason ?? ''} — ${v.message ?? ''}`, { fg: t.down, bg: tint, b: true }, iw);
      c.text(ix, gy + 1, 'esc back to editing (Y asks anyway and gets the signer\'s refusal)', { fg: t.muted, bg: tint }, iw);
    } else if (ts.typebackRequired) {
      c.text(ix, gy, `⚠ large order — type the size (${ts.sizeInput}) then press Y to sign in Phantom:`, { fg: t.warn, bg: tint, b: true }, iw);
      c.text(ix, gy + 1, `▌ ${ts.typeback || ''}`, { fg: t.text, bg: tint, b: true });
    } else {
      c.text(ix, gy, `${mainnet ? '⚠ REAL FUNDS · ' : ''}Y = sign this exact plan in Phantom   (esc cancels · any other key cancels)`, { fg: mainnet ? t.down : sideColor, bg: tint, b: true }, iw);
      c.text(ix, gy + 1, `the signer re-checks caps, verifies the signed bytes and re-simulates before it submits`, { fg: t.muted, bg: tint }, iw);
    }
    if (ts.message) c.text(ix, gy + 1, ts.message, { fg: t.warn, bg: tint }, iw);
  } else if (ts.phase === 'signing') {
    c.text(ix, gy, 'approve in Phantom (browser) — the signer verifies, re-simulates and submits…', { fg: t.ai, bg, b: true }, iw);
    c.text(ix, gy + 1, 'nothing is sent until the signed bytes match the plan', { fg: t.muted, bg }, iw);
  } else if (ts.phase === 'filling') {
    const line = view.rateLimited
      ? '⚠ rate limited by Jupiter — retrying…   (esc cancels)'
      : 'booking paper fill from a fresh quote…   (esc cancels)';
    c.text(ix, gy, line, { fg: view.rateLimited ? t.warn : t.ai, bg, b: true }, iw);
  } else if (ts.phase === 'filled' && isLive && live?.outcome?.kind === 'filled') {
    const o = live.outcome;
    const got = live.probe ? `wrap-and-unwrap confirmed · fee ${fmtSol(lamportsToSol(BigInt(o.fill.feeLamports)), 6)}` : `${fmtAmount(rawToTokens(o.fill.side === 'buy' ? BigInt(o.fill.tokenDelta) : -BigInt(o.fill.tokenDelta), o.fill.decimals))} ${o.fill.symbol} @ ${fmtPriceBare(o.fill.priceSol)} SOL`;
    c.text(ix, gy, `✓ LIVE ${o.network.toUpperCase()} ${live.probe ? 'PROBE' : o.fill.side.toUpperCase()} confirmed — ${got}${o.lighthouseTail ? ` · +${o.lighthouseTail} Lighthouse` : ''}`, { fg: t.up, bg, b: true }, iw);
    c.text(ix, gy + 1, `sig ${o.signature.slice(0, 12)}…${o.signature.slice(-6)} · esc=back · P=positions`, { fg: t.muted, bg }, iw);
  } else if (ts.phase === 'filled' && view.receipt) {
    const r = view.receipt;
    const got = r.side === 'buy' ? `${fmtAmount(rawToTokens(r.tokenDelta, r.decimals))} ${r.symbol}` : fmtSol(lamportsToSol(r.solDelta));
    c.text(ix, gy, `✓ PAPER ${r.side.toUpperCase()} filled — ${got} @ ${fmtPriceBare(r.priceSol)} SOL`, { fg: t.up, bg, b: true }, iw);
    const extra = r.side === 'sell' ? `realized ${r.realizedLamports >= 0n ? '+' : ''}${fmtSol(lamportsToSol(r.realizedLamports))}` : 'cost booked to position';
    c.text(ix, gy + 1, `${extra} · esc=back to token · P=positions`, { fg: t.muted, bg }, iw);
  } else if (ts.phase === 'refused') {
    c.text(ix, gy, `✗ REFUSED by the signer — ${ts.message ?? 'refused'}`, { fg: t.down, bg, b: true }, iw);
    c.text(ix, gy + 1, 'nothing was signed or sent · esc=back · any key = new ticket', { fg: t.muted, bg }, iw);
  } else if (ts.phase === 'error') {
    const unknown = live?.outcome?.kind === 'send-unknown';
    c.text(ix, gy, `⚠ ${ts.message ?? 'order failed'}`, { fg: t.down, bg, b: true }, iw);
    c.text(ix, gy + 1, unknown && live?.outcome?.kind === 'send-unknown' ? `sig ${live.outcome.signature.slice(0, 12)}… · DO NOT resend · check the explorer · esc=back` : 'esc=back to token · P=positions', { fg: unknown ? t.warn : t.muted, bg }, iw);
  } else {
    c.text(ix, gy, isLive ? `⏎ build the plan in the signer → Y signs in Phantom   ·   gate ${ts.gateOn ? 'ON' : 'off'}` : `⏎ review → Y confirm   ·   gate ${ts.gateOn ? 'ON' : 'off'} (keypress required)`, { fg: t.muted, bg }, iw);
    if (ts.message) c.text(ix, gy + 1, ts.message, { fg: t.warn, bg }, iw);
  }

  const keys: [string, string][] = [['⏎', isLive ? 'plan' : 'review'], ['Y', isLive ? 'sign' : 'confirm'], ['L', isLive ? 'paper' : 'live'], ['tab', 'field'], ['←→', 'side'], ['u', 'unit']];
  if (isLive && buy && ts.phase === 'editing' && !live?.probe) keys.push(['f', 'fit cap']);
  if (ts.phase === 'planning' && live?.retryAt) keys.push(['r', 'retry now']);
  keys.push(['esc', 'cancel'], ['P', 'positions']);
  footer(c, keys, t.name, isCalm(state.vfx));
}

/** The PLAN block: everything the signer will sign, from the signer's own view. */
function renderPlan(c: Canvas, ix: number, y: number, iw: number, bg: string, live: LiveTicketView, decimals: number, symbol: string, buy: boolean, now: number): number {
  const t = c.theme;
  const p = live.plan!;
  const left = Math.max(0, Math.round((p.expiresAt - now) / 1000));
  c.text(ix, y, `PLAN · ${p.network.toUpperCase()} · ${p.kind === 'probe' ? 'devnet probe' : 'jupiter swap'}`, { fg: p.network === 'mainnet' ? t.down : t.up, bg, b: true });
  c.textR(ix, y, iw, `expires in ${left}s · ${p.hash.slice(0, 8)}`, { fg: left < 15 ? t.warn : t.dim, bg });
  c.hline(ix - 1, y + 1, iw + 2, { fg: t.border, bg, soft: true });
  y += 2;
  const inRaw = BigInt(p.amountInRaw), outRaw = BigInt(p.amountOutRaw), minRaw = BigInt(p.minOutRaw);
  if (p.kind === 'probe') {
    kv(c, ix, y++, iw, bg, 'Wraps', `${fmtSol(lamportsToSol(inRaw))} → your own WSOL account → back to you`, t, t.text);
  } else {
    // The plan's decimals are the ones the order was built with (the signer echoes them back).
    const pay = buy ? fmtSol(lamportsToSol(inRaw)) : `${fmtAmount(rawToTokens(inRaw, p.decimals ?? decimals))} ${symbol}`;
    const recv = buy ? `${fmtAmount(rawToTokens(outRaw, p.decimals ?? decimals))} ${symbol}` : fmtSol(lamportsToSol(outRaw));
    const min = buy ? `${fmtAmount(rawToTokens(minRaw, p.decimals ?? decimals))} ${symbol}` : fmtSol(lamportsToSol(minRaw));
    kv(c, ix, y++, iw, bg, 'You pay', pay, t, buy ? t.down : t.text);
    kv(c, ix, y++, iw, bg, 'You receive', recv, t, t.up);
    kv(c, ix, y++, iw, bg, 'Min received', `${min} (${p.slippageBps} bps slippage)`, t, t.muted);
    const impact = p.priceImpactPct;
    kv(c, ix, y++, iw, bg, 'Price impact', impact === null ? 'unknown' : fmtPct(impact, { sign: false }), t, impact !== null && impact > 3 ? t.down : impact !== null && impact > 1 ? t.warn : t.muted);
    kv(c, ix, y++, iw, bg, 'Route', p.route.length ? p.route.join(' → ') : 'direct', t, t.accent);
  }
  kv(c, ix, y++, iw, bg, 'Fee', `${fmtSol(lamportsToSol(BigInt(p.feeLamports)), 6)}${p.prioritizationFeeLamports ? ` (incl. ${p.prioritizationFeeLamports} lamports priority)` : ''}`, t, t.muted);
  kv(c, ix, y++, iw, bg, 'Notional', p.notionalUsd !== null ? `$${p.notionalUsd.toFixed(2)} (SOL $${p.solUsd.price?.toFixed(2) ?? '?'} via ${p.solUsd.sources?.join('+') ?? '?'})` : (p.network === 'mainnet' ? `unpriced — ${p.solUsd.reason ?? ''}` : 'devnet (no USD value)'), t, p.notionalUsd === null && p.network === 'mainnet' ? t.down : t.muted);
  if (!p.sim.ran || p.sim.ok) {
    kv(c, ix, y++, iw, bg, 'Simulation', !p.sim.ran ? 'not run' : `ok · ${p.sim.solOutLamports !== null ? `${fmtSol(lamportsToSol(BigInt(p.sim.solOutLamports)), 6)} leaves the wallet` : 'wallet delta unknown'}`, t, p.sim.ok ? t.up : t.down);
  } else {
    // task-1368 item f: the FULL RPC error, wrapped (it used to be cut to `invalid transaction: Tr…`), then the hint.
    kv(c, ix, y++, iw, bg, 'Simulation', 'FAILED', t, t.down);
    for (const line of wrapLines(p.sim.error ?? 'unknown error', iw - 2, 3)) c.text(ix + 2, y++, line, { fg: t.down, bg }, iw - 2);
    const hint = simFailureHint(p, live.signer ? { perTradeUsd: live.signer.caps.perTradeUsd, dailyUsd: live.signer.caps.dailyUsd } : undefined);
    if (hint) for (const line of wrapLines(`↳ ${hint}`, iw - 2, 4)) c.text(ix + 2, y++, line, { fg: t.warn, bg }, iw - 2);
  }
  const ins = p.instructions.map((i) => `${i.program}${i.op ? `:${i.op}` : ''}`).join(' · ');
  kv(c, ix, y++, iw, bg, 'Will sign', ins || '—', t, t.text);
  kv(c, ix, y++, iw, bg, 'Policy', p.policy.ok ? 'swap shape ok · route bound to this plan · no fee account' : `REFUSE ${p.policy.reason}: ${p.policy.message}`, t, p.policy.ok ? t.up : t.down);
  kv(c, ix, y++, iw, bg, 'Caps', p.precheck.ok ? 'within caps' : `REFUSE ${p.precheck.reason}: ${p.precheck.message}`, t, p.precheck.ok ? t.up : t.down);
  return y + 1;
}

function field(c: Canvas, x: number, y: number, w: number, bg: string, label: string, value: string, active: boolean, t: Canvas['theme']): void {
  const lblW = 10;
  c.text(x, y, label, { fg: t.dim, bg });
  const vx = x + lblW;
  if (active) {
    c.fill(vx - 1, y, w - lblW + 1, 1, ' ', { bg: mix(t.bg, t.accent, 0.16) });
    c.text(vx, y, value, { fg: t.text, bg: mix(t.bg, t.accent, 0.16), b: true });
    c.put(vx - 1, y, '▌', { fg: t.accent, bg });
  } else {
    c.text(vx, y, value, { fg: t.text, bg });
  }
}

function kv(c: Canvas, x: number, y: number, w: number, bg: string, label: string, value: string, t: Canvas['theme'], valColor: string): void {
  const v = value.length > w - 14 ? value.slice(0, Math.max(1, w - 15)) + '…' : value;
  c.text(x, y, label, { fg: t.muted, bg }, Math.max(0, w - v.length - 1));
  c.textR(x, y, w, v, { fg: valColor, bg });
}

export type { TicketView };
