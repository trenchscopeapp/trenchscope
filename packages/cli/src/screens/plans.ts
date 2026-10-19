// trenchscope — ORDER PLANS & STANDING MANDATES screen (key O, task-1355; SPEC §6.13). Lists the conditional
// order plans and standing mandates held in the signer trust domain, and lets the user arm (hold-to-confirm,
// physical keypress only), cancel/revoke, and panic. The screen NEVER signs, holds a key, raises a cap, or
// arms by anything but a captured physical keypress — voice and agents can only PROPOSE, never reach here.
// Default runs are PAPER (no key, no wallet, no mainnet); the on-disk journal is the audit log + recovery.
import { Canvas, header, footer, breakpoint, fmtUsd, type Hex } from '@dexterm/tui';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import { planStatusLabel, type PlanRow, type MandateRow } from '@dexterm/data/plans';
import { planLevels, priceModeOf } from '../display.ts';

function fmtTtl(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'expired';
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

export function renderPlans(c: Canvas, state: AppState): void {
  const t = c.theme;
  const bp = breakpoint(c.w);
  header(c, headerModel(state));
  const ui = state.plansUi ?? null;
  const svc = state.plansSvc ?? null;
  const tab = ui?.tab ?? 'plans';
  const plans: PlanRow[] = svc ? svc.listPlans() : [];
  const mandates: MandateRow[] = svc ? svc.listMandates() : [];
  const top = 2, bottom = c.h - 1;
  const risk = svc ? svc.riskStatus() : { gateOff: false, acceptedAt: null, expiresAt: null, active: false };
  const gateLabel = risk.active ? 'HANDS-FREE' : 'GATE ON';
  // task-1363: the fire path. Anything not provably paper renders LIVE (fail-safe).
  const liveFire = svc ? svc.mode() === 'live' : false;
  const fireLabel = liveFire ? '◉ LIVE · DEVNET · FAST WALLET' : 'PAPER';
  const title = `ORDER PLANS & MANDATES · ${tab === 'plans' ? `${plans.length} plans` : `${mandates.length} mandates`} · ${fireLabel} · ${gateLabel}`;
  const caption = bp === 'compact' ? undefined : 'voice/agents PROPOSE only · arming needs a physical keypress hold · caps are signer-side · panic revokes all';
  const box = c.box(0, top, c.w, bottom - top, { title, caption, focus: true });
  const bg: Hex = box.bg;
  const now = state.now.getTime();

  // Tab strip
  let cy = box.y;
  const tabPlans = `PLANS (${plans.length})`;
  const tabMand = `MANDATES (${mandates.length})`;
  c.text(box.x + 1, cy, tabPlans, { fg: tab === 'plans' ? t.accent : t.dim, bg, b: tab === 'plans' });
  c.text(box.x + 2 + tabPlans.length + 2, cy, tabMand, { fg: tab === 'mandates' ? t.accent : t.dim, bg, b: tab === 'mandates' });
  cy += 1;
  c.hline(box.x, cy, box.w, { fg: t.border, bg }); cy += 1;

  const rows: readonly (PlanRow | MandateRow)[] = tab === 'plans' ? plans : mandates;
  if (!rows.length) {
    c.textC(box.x, box.y + 3, box.w, tab === 'plans' ? 'no order plans — propose one with `trenchscope plan propose`, or by voice ("buy this if it dips to 300k")' : 'no standing mandates — draft one with `trenchscope mandate draft`', { fg: t.muted, bg, i: true });
    c.textC(box.x, box.y + 5, box.w, 'a proposal is INERT until you arm it here with a physical keypress hold; nothing arms by voice or agent', { fg: t.dim, bg });
    footer(c, [['tab', 'plans/mandates'], ['esc', 'back'], ['q', 'quit']], t.name);
    return;
  }

  const sel = Math.max(0, Math.min(rows.length - 1, ui?.selected ?? 0));
  const scroll = Math.max(0, sel - (box.h - 6));
  for (let i = scroll; i < rows.length; i++) {
    if (cy >= box.y + box.h - 2) break;
    const selected = i === sel;
    const rb = selected ? t.selBg : bg;
    c.fill(box.x, cy, box.w, 1, ' ', { bg: rb });
    if (selected) c.put(box.x, cy, '▎', { fg: t.accent, bg: rb, soft: true });
    if (tab === 'plans') {
      const r = rows[i] as PlanRow;
      // status colour: armed=up, proposed=muted, terminal/refused=down
      const armed = r.status === 'armed' || r.status.startsWith('filled');
      const dead = r.status === 'cancelled' || r.status === 'failed' || r.status === 'expired' || r.status === 'done';
      const sfg = r.paused ? t.down : armed ? t.up : dead ? t.dim : t.muted;
      c.text(box.x + 1, cy, r.id, { fg: selected ? t.borderFocus : t.text, bg: rb }, 20);
      c.text(box.x + 22, cy, planStatusLabel(r), { fg: sfg, bg: rb }, box.w - 24);
    } else {
      const r = rows[i] as MandateRow;
      const armed = r.status === 'armed';
      const sfg = armed ? t.up : r.status === 'revoked' || r.status === 'expired' ? t.dim : t.muted;
      c.text(box.x + 1, cy, r.id, { fg: selected ? t.borderFocus : t.text, bg: rb }, 22);
      c.text(box.x + 24, cy, r.status.toUpperCase(), { fg: sfg, bg: rb }, 8);
      const detail = `${fmtUsd(r.totalUsd)} tot · ${fmtUsd(r.reservedUsd)} rsv · ${fmtUsd(r.spentUsd)} spent · ${r.maxTier} · ${fmtTtl(r.expiresAt, now)}`;
      c.text(box.x + 33, cy, detail, { fg: t.muted, bg: rb }, box.w - 35);
    }
    cy += 1;
  }

  // The hold-to-arm modal (captured by the loop; this just paints the prompt).
  if (ui?.arming) {
    const a = ui.arming;
    const mw = Math.min(box.w - 4, 72), mh = 7;
    const mx = box.x + Math.floor((box.w - mw) / 2), my = box.y + Math.floor((box.h - mh) / 2);
    const mbox = c.box(mx, my, mw, mh, { title: '⚠ ARM — physical keypress', focus: true });
    const label = a.kind === 'plan' ? `Arm plan ${a.id} into ${a.mandateId}?` : `Arm standing mandate ${a.id}?`;
    c.textC(mbox.x, mbox.y, mbox.w, label, { fg: t.text, bg: mbox.bg, b: true });
    c.textC(mbox.x, mbox.y + 1, mbox.w, a.kind === 'mandate' ? 'armed plans can fire at machine speed from the capped fast wallet' : 'the signer re-checks caps on every fill; voice/agents can never arm', { fg: t.muted, bg: mbox.bg });
    c.textC(mbox.x, mbox.y + 3, mbox.w, 'Hold and release [enter] or [y] to confirm · [esc] cancels · a pipe/agent cannot arm', { fg: t.accent, bg: mbox.bg });
  }

  // The "less safe" hands-free opt-in modal (Tier 4): keypress-only, journaled, auto-expires 24h, reversible.
  if (ui?.riskModal) {
    const mw = Math.min(box.w - 4, 74), mh = 8;
    const mx = box.x + Math.floor((box.w - mw) / 2), my = box.y + Math.floor((box.h - mh) / 2);
    const mbox = c.box(mx, my, mw, mh, { title: '⚠ LESS SAFE — turn OFF the keypress gate', focus: true });
    c.textC(mbox.x, mbox.y, mbox.w, risk.active ? 'Hands-free is ON. Restore the keypress gate?' : 'Allow hands-free (spoken) confirmation without a keypress?', { fg: t.text, bg: mbox.bg, b: true });
    c.textC(mbox.x, mbox.y + 2, mbox.w, risk.active ? 'armed plans could then confirm by voice alone — restoring the gate is always safe' : 'armed plans could then fire from a spoken phrase, with NO physical keypress', { fg: risk.active ? t.muted : t.down, bg: mbox.bg });
    c.textC(mbox.x, mbox.y + 3, mbox.w, 'signer caps, allow-lists and panic still apply · this auto-expires in 24h · logged to the journal', { fg: t.muted, bg: mbox.bg });
    c.textC(mbox.x, mbox.y + 5, mbox.w, risk.active ? 'Hold+release [enter]/[y] to restore the gate · [esc] cancels' : 'Hold+release [enter]/[y] to accept (keypress only) · [esc] cancels · a pipe/agent cannot', { fg: t.accent, bg: mbox.bg });
  }

  // task-1363: the FIRE PATH modal (paper ⇄ live). Switched by a captured keypress in the loop; this paints the prompt.
  if (ui?.liveModal) {
    const mw = Math.min(box.w - 4, 78), mh = 9;
    const mx = box.x + Math.floor((box.w - mw) / 2), my = box.y + Math.floor((box.h - mh) / 2);
    const mbox = c.box(mx, my, mw, mh, { title: liveFire ? 'FIRE PATH — back to PAPER' : '⚠ FIRE PATH — go LIVE on DEVNET', focus: true });
    c.textC(mbox.x, mbox.y, mbox.w, liveFire ? 'Switch plan fills back to the paper executor?' : 'Fire armed plans through the SIGNER from the capped fast wallet (devnet)?', { fg: t.text, bg: mbox.bg, b: true });
    c.textC(mbox.x, mbox.y + 2, mbox.w, liveFire ? 'fills are then simulated again at the tick price; nothing on chain' : 'real devnet lamports move (fees of a wrap-and-unwrap sized to the plan); the token leg is modelled — Jupiter has no devnet', { fg: liveFire ? t.muted : t.down, bg: mbox.bg });
    c.textC(mbox.x, mbox.y + 3, mbox.w, 'the signer re-checks policy, simulation, USD per-trade/daily caps and the 0.05 SOL per-fill ceiling on every fill', { fg: t.muted, bg: mbox.bg });
    c.textC(mbox.x, mbox.y + 4, mbox.w, 'needs: a live run with the signer, `trenchscope wallet fast create`, no armed/filled plans · never mainnet · journaled', { fg: t.muted, bg: mbox.bg });
    c.textC(mbox.x, mbox.y + 6, mbox.w, 'Hold+release [enter]/[y] to switch (keypress only) · [esc] cancels · a pipe/agent/voice cannot', { fg: t.accent, bg: mbox.bg });
  }

  // task-1366: the selected plan's levels with BOTH market cap and price (display only; mc first in mcap mode)
  if (tab === 'plans' && svc && !ui?.notice) {
    const r = rows[sel] as PlanRow | undefined;
    const plan = r ? svc.engine.plan(r.id) : null;
    if (plan) c.text(box.x + 1, box.y + box.h - 1, planLevels(plan, priceModeOf(state)), { fg: t.muted, bg }, box.w - 2);
  }
  if (ui?.notice) c.text(box.x + 1, box.y + box.h - 1, ui.notice, { fg: t.accent, bg });
  footer(c, [['↑↓', 'move'], ['tab', 'plans/mandates'], ['a', 'arm (hold)'], tab === 'plans' ? ['c', 'cancel'] : ['r', 'revoke'], ['L', liveFire ? 'paper' : 'live (devnet)'], ['G', risk.active ? 'gate on' : 'hands-free'], ['!', 'PANIC'], ['esc', 'back'], ['q', 'quit']], t.name);
}
