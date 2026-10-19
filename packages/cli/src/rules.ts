// trenchscope — the rules engine's app adapter (task-1358 Tier 3). Pure helpers over @dexterm/custom's RulesEngine
// that the key handler, the interactive loop and the Rules screen call: load `config.rules` into an engine on
// `state.rulesUi`, feed it the screener rows every few seconds (`rulesTick`), turn its outputs into things the
// app can show (toasts, the screen's log, PROPOSAL cards, pending UI actions the loop performs), and persist edits
// through the config journal (so `trenchscope config undo` / the journal cover rules too).
//
// SAFETY: a rule's outputs are alerts, annotations (watch/tag on the user's own watchlist), UI actions (popup /
// terminal bell) and PROPOSALS. Acting on a ticket proposal opens the PAPER ticket in its editing phase (the user
// sizes and confirms there, signer caps apply); acting on an ask proposal sends a question to the analyst. Nothing
// in this module can arm, sign, confirm, open a live ticket or touch a mandate — there is no code path for it.
import type { AppState } from './state.ts';
import { devBookOf } from './live/dev-history.ts';
import type { CustomUi } from './custom.ts';
import type { ScreenerRow } from './screener/rows.ts';
import {
  RulesEngine, ruleToJson, ruleToText, slug, applyAndJournal, describeActions,
  type RuleJson, type RuleRow, type DryRunResult, type AlertLevel, type CompiledRule, type EvalResult,
} from '@dexterm/custom';
import { alertToDelivery, proposalToDelivery } from './alerts/format.ts';
import type { AlertDelivery } from './alerts/types.ts';

export const RULE_INPUT_MAX = 400;
/** The engine observes/evaluates at most this often (the feed itself moves every 10 s; fixtures drift every tick). */
export const RULES_TICK_MS = 2_000;
export const MAX_LOG = 60;
export const MAX_PROPOSALS = 20;

export interface RuleLogEntry { at: number; rule: string; name: string; source: string; mint: string; symbol: string; kind: 'alert' | 'proposal' | 'annotation' | 'ui' | 'acted' | 'dismissed'; level: AlertLevel; text: string }

/** A ticket/ask PROPOSAL card. Inert: `status` can only ever be 'proposal'; nothing here arms. */
export interface RuleProposalCard {
  id: number; at: number; rule: string; name: string; source: string; mint: string; symbol: string;
  type: 'ticket' | 'ask';
  side?: 'buy' | 'sell'; size?: number; unit?: 'sol' | 'usd' | 'pct'; skill?: string;
  why: string;
  status: 'proposal'; requiresKeypress: true; armedBy: null;
}

/** UI work the loop performs after a tick / a key (applyAction cannot open windows or talk to the analyst). */
export interface RulesPending {
  popups: Array<{ kind: 'chart' | 'token' | 'bubbles' | 'narrative' | 'plans' | 'feeds'; mint: string; symbol: string; rule: string }>;
  /** Terminal bells to ring (only when sound is on). */
  bells: number;
  /** A question for the analyst (from an accepted ask proposal). */
  ask: string | null;
  /** A PAPER ticket to open in its editing phase (from an accepted ticket proposal). The size is a hint in the notice, never pre-confirmed. */
  ticket: { mint: string; symbol: string; name: string; side: 'buy' | 'sell'; size: number; unit: 'sol' | 'usd' | 'pct' } | null;
}

export interface RulesUi {
  engine: RulesEngine;
  /** Rules in config that did not load (id: why). Shown on the screen and by `trenchscope rules list`. */
  errors: string[];
  pane: 'rules' | 'proposals';
  selected: number;
  selectedProposal: number;
  /** The rule text being typed (null = not typing). */
  input: string | null;
  /** When editing an existing rule: its id (the save replaces it). */
  editingId: string | null;
  /** The live dry-run of `input` against the current rows ("would match N rows"). */
  dry: DryRunResult | null;
  notice: string | null;
  log: RuleLogEntry[];
  proposals: RuleProposalCard[];
  pending: RulesPending;
  lastTickAt: number;
  nextId: number;
  /** Fires seen this session (all rules). */
  fires: number;
  /** task-1398: alerts/proposal summaries queued for PUSH delivery (the loop drains them through the Notifier when a push channel is enabled). */
  pendingDeliveries: AlertDelivery[];
}

export function newRulesUi(engine = new RulesEngine()): RulesUi {
  return {
    engine, errors: [], pane: 'rules', selected: 0, selectedProposal: 0, input: null, editingId: null, dry: null, notice: null,
    log: [], proposals: [], pending: { popups: [], bells: 0, ask: null, ticket: null }, lastTickAt: 0, nextId: 1, fires: 0,
    pendingDeliveries: [],
  };
}

/** Cap on the push-delivery backlog (a long run with no notifier should never grow unbounded). */
const MAX_DELIVERIES = 100;

/**
 * Build the engine from `config.rules` plus the rules of installed packs (task-1358 Tier 4: a pack rule whose id the
 * user already has in config.rules is shadowed by the user's copy). Bad rules are reported, good ones run. Never throws.
 */
export function initRules(custom: CustomUi | null | undefined, now = Date.now()): RulesUi {
  const own = custom?.config.rules ?? [];
  const ids = new Set(own.map((r) => r.id));
  const rules = [...own, ...(custom?.packRules ?? []).filter((r) => !ids.has(r.id))];
  const engine = new RulesEngine({ rules, now });
  const ui = newRulesUi(engine);
  ui.errors = engine.errors.map((e) => `rule ${e.id}: ${e.msg}`);
  if (custom) for (const e of ui.errors) if (!custom.configErrors.includes(e)) custom.configErrors.push(e);
  return ui;
}

/** The rules state for this run, created from the loaded config on first use. */
export function rulesUiOf(state: AppState): RulesUi {
  if (!state.rulesUi) state.rulesUi = initRules(state.custom, state.now.getTime());
  return state.rulesUi;
}

/**
 * task-1398: LARP-detector grade as a number so a grade change is a rule (`larp.delta`). Higher = more real.
 * NO_PRODUCT_CLAIMED (a meme that claims no product) sits with UNVERIFIABLE: honest, but never "real".
 * The string verdict is only known here (cli); the engine sees the number. `null` for no verdict (clause false).
 */
export const LARP_GRADES: Record<string, number> = { REAL_PRODUCT: 3, EARLY_BUT_REAL: 2, NO_PRODUCT_CLAIMED: 1, UNVERIFIABLE: 1, LARP: 0 };
export function larpGrade(verdict: string | null | undefined): number | null {
  if (!verdict) return null;
  const g = LARP_GRADES[verdict];
  return g === undefined ? null : g;
}

/**
 * The rows a rule can see: the screener feed (no skeletons) with the wallet-intel top-cluster share and the LARP
 * grade attached. task-1404: the OPEN token also carries its LIVE holder/rug signal fields (top10 / dev / bundled /
 * snipers / fresh / cluster / lpLocked / bonding / mintable / freezable), so a rule like `dev.delta < 0` or
 * `mintable > 0` fires on the real streaming values, not the on-open snapshot. A token opened by `--mint` that is
 * not in the screener feed is appended as its own row so rules still see it.
 */
export function ruleRowsOf(state: AppState): RuleRow[] {
  const out: RuleRow[] = [];
  const seen = new Set<string>();
  const clusterOf = (mint: string): number | null => {
    const res = state.live?.intel.entry(mint)?.result;
    if (!res || res.state !== 'ok') return null;
    const c = res.analysis.clusters[0];
    return c ? c.pct : null;
  };
  const openMint = state.live?.token?.view.mint ?? null;
  // 0.1.5 dev history: the creator's recorded rugs as the `devrugs` field (local recorder only; null = unknown).
  const book = devBookOf(state);
  const devRugsOf = (mint: string): number | null => book ? book.rugsFor(mint) : null;
  for (const r of state.screener.rows as ScreenerRow[]) {
    if (!r.mint || r.skeleton || seen.has(r.mint)) continue;
    seen.add(r.mint);
    const row = Object.assign(Object.create(null), r, { cluster: clusterOf(r.mint), larp: larpGrade(state.larpByMint?.get(r.mint)?.verdict), devRugs: devRugsOf(r.mint) }) as RuleRow;
    if (r.mint === openMint) overlaySignalFields(row, state, r.mint);
    out.push(row);
  }
  // A token opened by mint (not in the screener feed): synthesize a row from its live view so rules see it too.
  if (openMint && !seen.has(openMint) && state.live?.token) {
    const v = state.live.token.view;
    const row = Object.assign(Object.create(null), {
      mint: v.mint, symbol: v.symbol, price: v.price, mcap: v.mcap, fdv: v.fdv, liq: v.liq, vol24: v.vol24,
      holders: v.holders, org: v.org, top10: v.top10, dev: v.dev, lpLocked: v.lpLocked,
      cluster: clusterOf(v.mint), larp: larpGrade(state.larpByMint?.get(v.mint)?.verdict), devRugs: devRugsOf(v.mint),
      ageMin: v.ageMin, chg: v.chg, launchpad: v.launchpad, flags: v.flags, verified: v.verified, sus: v.sus,
    }) as RuleRow;
    overlaySignalFields(row, state, v.mint);
    out.push(row);
  }
  // 0.1.5 dev history: a brand-new pair (PumpPortal / RugCheck) whose creator has a labelled record becomes a rule
  // row too, so `devrugs >= N scope newpairs` can alert on a new coin from a wallet that rugged before. Only pairs
  // with a known record are added (no flood of unknowns); every other field is what the new-pairs feed knows.
  const np = state.live?.newpairs;
  if (book && np) {
    const now = Date.now();
    for (const p of np.rows.values()) {
      if (seen.has(p.mint) || !p.creator) continue;
      const devRugs = devRugsOf(p.mint);
      if (devRugs === null) continue;
      seen.add(p.mint);
      out.push(Object.assign(Object.create(null), {
        mint: p.mint, symbol: p.symbol, mcap: p.mcap, liq: p.liq, holders: p.holders, launchpad: p.launchpad,
        ageMin: p.createdAt ? Math.max(0, (now - p.createdAt) / 60_000) : null, bonding: p.bonding, devRugs,
      }) as RuleRow);
    }
  }
  return out;
}

/** Overlay the live-signals engine's latest values (non-null wins) onto a rule row (task-1404). */
function overlaySignalFields(row: RuleRow, state: AppState, mint: string): void {
  const f = state.live?.signals?.fields(mint);
  if (!f) return;
  if (f.top10 !== null) row.top10 = f.top10;
  if (f.dev !== null) row.dev = f.dev;
  if (f.bundled !== null) row.bundled = f.bundled;
  if (f.snipers !== null) row.snipers = f.snipers;
  if (f.cluster !== null) row.cluster = f.cluster;
  if (f.lpLocked !== null) row.lpLocked = f.lpLocked;
  if (f.bonding !== null) row.bonding = f.bonding;
  if (f.fresh !== null) row.fresh = f.fresh;
  if (f.mintable !== null) row.mintable = f.mintable;
  if (f.freezable !== null) row.freezable = f.freezable;
}

export interface RuleTickSummary { fired: number; alerts: string[]; proposals: number; suppressed: number }

/**
 * One engine tick: observe the rows, evaluate, and turn the outputs into app state. Self-throttled to RULES_TICK_MS.
 * Alerts become the first pending toast + log lines; ticket/ask become PROPOSAL cards; watch/tag touch the user's
 * own watchlist (live mode) or just the log; popup/sound queue UI work for the loop. Returns null when throttled.
 */
export function rulesTick(state: AppState, now: number): RuleTickSummary | null {
  const ui = state.rulesUi;
  if (!ui || !ui.engine.rules.some((r) => r.enabled)) return null;
  if (now - ui.lastTickAt < RULES_TICK_MS) return null;
  ui.lastTickAt = now;
  const rows = ruleRowsOf(state);
  if (!rows.length) return null;
  ui.engine.observe(rows, now);
  const watch = state.live?.watch.store ?? null;
  const positions = state.live?.positions ?? null;
  const res = ui.engine.evaluate(rows, now, {
    watchlist: watch ? { has: (m) => watch.has(m) } : undefined,
    positions: positions ? { has: (m) => positions.held(m) !== null } : undefined,
  });
  const summary = applyOutputs(state, ui, res, rows, now);
  if (ui.input !== null) ui.dry = ui.engine.dryRun(ui.input, rows, now);
  return summary;
}

function applyOutputs(state: AppState, ui: RulesUi, res: EvalResult, rows: RuleRow[], now: number): RuleTickSummary {
  const summary: RuleTickSummary = { fired: res.fired.length, alerts: [], proposals: 0, suppressed: res.suppressed.length };
  const rowOf = (mint: string): RuleRow | undefined => rows.find((r) => r.mint === mint);
  const push = (e: RuleLogEntry): void => { ui.log.unshift(e); if (ui.log.length > MAX_LOG) ui.log.length = MAX_LOG; };
  ui.fires += res.fired.length;
  for (const f of res.fired) {
    for (const a of f.actions) {
      const base = { at: now, rule: f.rule, name: f.name, source: f.source, mint: f.mint, symbol: f.symbol };
      if (a.kind === 'alert') {
        push({ ...base, kind: 'alert', level: a.level, text: a.text });
        summary.alerts.push(`${f.symbol}: ${a.text}`);
        if (ui.pendingDeliveries.length < MAX_DELIVERIES) ui.pendingDeliveries.push(alertToDelivery(a));
      } else if (a.kind === 'proposal') {
        const card: RuleProposalCard = a.type === 'ticket'
          ? { id: ui.nextId++, ...base, type: 'ticket', side: a.side, size: a.size, unit: a.unit, why: a.why, status: 'proposal', requiresKeypress: true, armedBy: null }
          : { id: ui.nextId++, ...base, type: 'ask', skill: a.skill, why: a.why, status: 'proposal', requiresKeypress: true, armedBy: null };
        ui.proposals.unshift(card);
        if (ui.proposals.length > MAX_PROPOSALS) ui.proposals.length = MAX_PROPOSALS;
        if (ui.pendingDeliveries.length < MAX_DELIVERIES) ui.pendingDeliveries.push(proposalToDelivery(a));
        summary.proposals += 1;
        push({ ...base, kind: 'proposal', level: 'info', text: `PROPOSAL ${describeCard(card)} — ctrl+r, tab, ⏎ to act (you confirm there)` });
      } else if (a.kind === 'annotation') {
        const store = state.live?.watch.store ?? null;
        const row = rowOf(f.mint);
        if (a.type === 'watch') {
          if (store && !store.has(f.mint) && row) {
            const r = row as unknown as ScreenerRow;
            store.add({ mint: r.mint, symbol: r.symbol, name: r.name ?? r.symbol, launchpad: r.launchpad ?? 'unknown', entryPrice: r.price ?? null, note: `rule:${f.rule}` });
            push({ ...base, kind: 'annotation', level: 'info', text: `watch: added ${f.symbol} to the watchlist (rule ${f.rule})` });
          } else push({ ...base, kind: 'annotation', level: 'info', text: store ? `watch: ${f.symbol} already on the watchlist` : `watch: ${f.symbol} (watchlist needs live mode)` });
        } else {
          if (store && store.has(f.mint)) { store.setNote(f.mint, `rule:${f.rule} ${a.label}`.slice(0, 80)); push({ ...base, kind: 'annotation', level: 'info', text: `tag "${a.label}" on ${f.symbol} (watchlist note)` }); }
          else push({ ...base, kind: 'annotation', level: 'info', text: `tag "${a.label}" on ${f.symbol}` });
        }
      } else if (a.kind === 'ui') {
        if (a.type === 'popup') { ui.pending.popups.push({ kind: a.popup, mint: f.mint, symbol: f.symbol, rule: f.rule }); push({ ...base, kind: 'ui', level: 'info', text: `popup ${a.popup} for ${f.symbol}` }); }
        else { ui.pending.bells += 1; push({ ...base, kind: 'ui', level: 'info', text: `sound ${a.name}` }); }
      }
    }
  }
  if (summary.alerts.length) state.pendingToast = summary.alerts.length === 1 ? `⚑ ${summary.alerts[0]}` : `⚑ ${summary.alerts[0]} (+${summary.alerts.length - 1} more · ctrl+r)`;
  else if (summary.proposals) state.pendingToast = `⚑ ${summary.proposals} rule proposal${summary.proposals > 1 ? 's' : ''} · ctrl+r then tab to review (nothing armed)`;
  return summary;
}

export function describeCard(c: RuleProposalCard): string {
  return c.type === 'ticket' ? `ticket ${c.side!.toUpperCase()} ${c.size} ${c.unit} on ${c.symbol}` : `ask ${c.skill} about ${c.symbol}`;
}

// ------------------------------------------------------------------ editing + persistence
export function selectedRule(ui: RulesUi): CompiledRule | null {
  const rules = ui.engine.rules;
  if (!rules.length) return null;
  return rules[Math.max(0, Math.min(rules.length - 1, ui.selected))] ?? null;
}
export function selectedProposal(ui: RulesUi): RuleProposalCard | null {
  if (!ui.proposals.length) return null;
  return ui.proposals[Math.max(0, Math.min(ui.proposals.length - 1, ui.selectedProposal))] ?? null;
}

/** Re-run the dry-run of the text being typed against the current rows. */
export function dryRunNow(state: AppState): void {
  const ui = state.rulesUi;
  if (!ui || ui.input === null) return;
  const text = ui.input.trim();
  if (!text) { ui.dry = null; return; }
  ui.dry = ui.engine.dryRun(text, ruleRowsOf(state), state.now.getTime());
}

/** Begin typing: a new rule, or the selected rule's text when `edit` is set. */
export function beginRuleInput(ui: RulesUi, edit: boolean): void {
  if (edit) {
    const r = selectedRule(ui);
    if (!r) { ui.notice = 'no rule selected'; return; }
    ui.editingId = r.id;
    ui.input = ruleToText(compiledToJson(r));
  } else { ui.editingId = null; ui.input = ''; }
  ui.dry = null;
  ui.notice = null;
}

function compiledToJson(r: CompiledRule): RuleJson {
  const json: RuleJson = { id: r.id, name: r.name, enabled: r.enabled, when: r.whenText, then: r.then.map((a) => ({ action: a.action, args: { ...a.args } })), scope: r.scope, cooldown: msToDur(r.cooldownMs), maxPerHour: r.maxPerHour, window: msToDur(r.windowMs), source: r.source };
  if (r.for) json.for = 'ticks' in r.for ? `${r.for.ticks} ticks` : msToDur(r.for.ms);
  return json;
}
function msToDur(ms: number): string { return ms % 3_600_000 === 0 && ms > 0 ? `${ms / 3_600_000}h` : ms % 60_000 === 0 && ms > 0 ? `${ms / 60_000}m` : `${Math.round(ms / 1000)}s`; }

/** Persist one change to `config.rules` through the journal (actor: user). Throws with a reason when it cannot. */
function persist(state: AppState, ops: Parameters<typeof applyAndJournal>[1], why: string): void {
  const custom = state.custom;
  if (!custom) throw new Error('no config loaded (one-shot frame)');
  const { config } = applyAndJournal(custom.home, ops, { actor: 'user', why, now: state.now.getTime() });
  custom.config = config;
}
function ruleIndex(state: AppState, id: string): number { return (state.custom?.config.rules ?? []).findIndex((r) => r.id === id); }

/** Save the text being typed: parse → JSON → config (add or replace) → engine. Returns the notice. */
export function saveRuleInput(state: AppState): string {
  const ui = rulesUiOf(state);
  const text = (ui.input ?? '').trim();
  const editingId = ui.editingId;
  ui.input = null; ui.editingId = null; ui.dry = null;
  if (!text) return 'nothing saved (empty rule)';
  let json: RuleJson;
  try {
    const existing = editingId ? ui.engine.get(editingId) : null;
    json = ruleToJson(text, { id: editingId ?? undefined, source: existing?.source ?? 'user', enabled: existing ? existing.enabled : true });
    if (!editingId) {
      // a new rule never overwrites another one: bump the slug until it is free
      const taken = new Set([...ui.engine.rules.map((r) => r.id), ...(state.custom?.config.rules ?? []).map((r) => r.id)]);
      let id = json.id; let n = 2;
      while (taken.has(id)) id = slug(`${json.id}-${n++}`);
      json.id = id;
    }
    if (json.source !== 'user') json.source = 'user'; // an edited pack/jarvis rule becomes the user's own (it no longer matches the pack)
    const probe = new RulesEngine();
    probe.load(json);
  } catch (e) { return `not saved: ${(e as Error).message}`; }
  try {
    if (editingId) {
      const i = ruleIndex(state, editingId);
      persist(state, i >= 0 ? [{ op: 'replace', path: `/rules/${i}`, value: json }] : [{ op: 'add', path: '/rules/-', value: json }], `edit rule ${json.id}`);
    } else persist(state, [{ op: 'add', path: '/rules/-', value: json }], `add rule ${json.id}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (!/no config loaded/.test(msg)) return `not saved: ${msg}`;
    ui.engine.load(json);
    return `rule ${json.id} loaded for this run only (${msg})`;
  }
  ui.engine.load(json);
  ui.selected = Math.max(0, ui.engine.rules.findIndex((r) => r.id === json.id));
  return `${editingId ? 'updated' : 'saved'} rule ${json.id}: ${describeActions(ui.engine.get(json.id)!)}`;
}

export function removeSelectedRule(state: AppState): string {
  const ui = rulesUiOf(state);
  const r = selectedRule(ui);
  if (!r) return 'no rule selected';
  try {
    const i = ruleIndex(state, r.id);
    if (i >= 0) persist(state, [{ op: 'remove', path: `/rules/${i}` }], `remove rule ${r.id}`);
  } catch (e) { if (!/no config loaded/.test((e as Error).message)) return `not removed: ${(e as Error).message}`; }
  ui.engine.remove(r.id);
  ui.selected = Math.max(0, Math.min(ui.engine.rules.length - 1, ui.selected));
  return `removed rule ${r.id}`;
}

export function toggleSelectedRule(state: AppState): string {
  const ui = rulesUiOf(state);
  const r = selectedRule(ui);
  if (!r) return 'no rule selected';
  const on = !r.enabled;
  let copied = false;
  try {
    const i = ruleIndex(state, r.id);
    if (i >= 0) persist(state, [{ op: 'replace', path: `/rules/${i}/enabled`, value: on }], `${on ? 'enable' : 'disable'} rule ${r.id}`);
    else if (r.source.startsWith('pack:')) {
      // task-1358 Tier 4: a pack rule is read-only inside its pack; enabling it makes the USER's copy in config.rules
      // (same id, same source label, the user's enabled flag). The pack's version stays shadowed from then on.
      const packRule = state.custom?.packRules.find((p) => p.id === r.id);
      persist(state, [{ op: 'add', path: '/rules/-', value: { ...(packRule ?? compiledToJson(r)), enabled: on } }], `${on ? 'enable' : 'disable'} pack rule ${r.id} (copied to config.rules)`);
      copied = true;
    }
  } catch (e) { if (!/no config loaded/.test((e as Error).message)) return `not changed: ${(e as Error).message}`; }
  ui.engine.setEnabled(r.id, on);
  return `rule ${r.id} ${on ? 'enabled' : 'disabled'}${copied ? ' (your copy of the pack rule; trenchscope rules remove to drop it)' : ''}`;
}

/** Dismiss the selected proposal (nothing else happens: it was inert). */
export function dismissSelectedProposal(state: AppState): string {
  const ui = rulesUiOf(state);
  const c = selectedProposal(ui);
  if (!c) return 'no proposal selected';
  ui.proposals = ui.proposals.filter((p) => p.id !== c.id);
  ui.selectedProposal = Math.max(0, Math.min(ui.proposals.length - 1, ui.selectedProposal));
  ui.log.unshift({ at: state.now.getTime(), rule: c.rule, name: c.name, source: c.source, mint: c.mint, symbol: c.symbol, kind: 'dismissed', level: 'info', text: `dismissed ${describeCard(c)}` });
  return `dismissed ${describeCard(c)}`;
}

/**
 * Act on the selected proposal: queue the PAPER ticket editor (the user sizes + confirms there) or the analyst
 * question for the loop. The card is consumed either way; nothing is armed, confirmed or sent here.
 */
export function actOnSelectedProposal(state: AppState): string {
  const ui = rulesUiOf(state);
  const c = selectedProposal(ui);
  if (!c) return 'no proposal selected';
  const row = (state.screener.rows as ScreenerRow[]).find((r) => r.mint === c.mint);
  if (c.type === 'ticket') {
    ui.pending.ticket = { mint: c.mint, symbol: c.symbol, name: row?.name ?? c.symbol, side: c.side!, size: c.size!, unit: c.unit! };
  } else {
    ui.pending.ask = `${c.skill!.replace(/-/g, ' ')} for ${c.symbol} (${c.mint}) — rule "${c.name}" fired: ${c.why}`.slice(0, 400);
  }
  ui.proposals = ui.proposals.filter((p) => p.id !== c.id);
  ui.selectedProposal = Math.max(0, Math.min(ui.proposals.length - 1, ui.selectedProposal));
  ui.log.unshift({ at: state.now.getTime(), rule: c.rule, name: c.name, source: c.source, mint: c.mint, symbol: c.symbol, kind: 'acted', level: 'info', text: c.type === 'ticket' ? `opening the PAPER ticket editor for ${c.symbol} (${c.side} ${c.size} ${c.unit} proposed; you size + confirm)` : `asking the analyst: ${c.skill} for ${c.symbol}` });
  return c.type === 'ticket' ? `PAPER ticket editor for ${c.symbol} — proposed ${c.side} ${c.size} ${c.unit}; nothing is confirmed until you do` : `asking the analyst (${c.skill}) about ${c.symbol}`;
}

/** Move the cursor on whichever pane is active. */
export function rulesMove(ui: RulesUi, delta: number): void {
  if (ui.input !== null) return;
  if (ui.pane === 'proposals') ui.selectedProposal = Math.max(0, Math.min(Math.max(0, ui.proposals.length - 1), ui.selectedProposal + delta));
  else ui.selected = Math.max(0, Math.min(Math.max(0, ui.engine.rules.length - 1), ui.selected + delta));
}
