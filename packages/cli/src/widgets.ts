// trenchscope — pack WIDGETS in the app (task-1358 Tier 5). A pack widget is an html page the popup host serves in a
// loopback HUD window under a hash-only CSP (r2: no nonce — every inline block is allow-listed by sha256, nothing is
// substituted into the pack html), fed PUBLIC view models over the host's socket. This adapter is the whole of what a
// widget can see:
//   * which widgets exist and are ENABLED (config.plugins['<pack>/<widget>'].enabled — the user's consent from
//     `trenchscope pack widget … --enable`; a pack cannot flip it);
//   * the page bytes, read from the installed pack directory only after the pack re-hashes to its install record
//     (a page edited after install is refused), never a symlink, never outside the pack, size-capped, and audited
//     once more for loaders (<script src>, <link>, frames, <meta http-equiv>, @import, the __NONCE__ token);
//   * the per-topic view models (rows · token · narrative · positions · alerts · theme) built from what the
//     terminal already shows. No keys, no signer state, no caps, no mandates, no gate, no pair/source ids.
// Widgets receive; they cannot ask for anything (the only events a page may send are the generic close/focus/drag).
import { lstatSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { checkIntegrity, packsDir, packWidgetKey, WIDGET_REF, type LoadedPackContent } from '@dexterm/custom';
import { WIDGET_HTML_MAX, auditWidgetHtml, type WidgetPage, type WidgetTopic, type WidgetPayload, type WidgetRowsVM, type WidgetRowVM, type WidgetPositionsVM, type WidgetAlertsVM, type ThemeTokens, type TokenDetailVM, type NarrativeBoardVM } from '@dexterm/popup';
import type { AppState } from './state.ts';
import type { CustomUi } from './custom.ts';
import type { ScreenerRow } from './screener/rows.ts';
import { popupThemeFrom } from './popup.ts';

export interface InstalledWidget { key: string; pack: string; name: string; dir: string; enabled: boolean; manifest: LoadedPackContent['widgets'][number]['manifest'] }

const REF = new RegExp(WIDGET_REF);

/** Every widget of every installed pack, with its consent flag. */
export function installedWidgets(ui: CustomUi | null | undefined): InstalledWidget[] {
  return (ui?.packs?.widgets ?? []).map((w) => ({ key: packWidgetKey(w.pack, w.name), pack: w.pack, name: w.name, dir: w.dir, enabled: w.enabled, manifest: w.manifest }));
}

/** Split `<pack>/<widget>[/<id>]`; null when malformed. */
export function parseWidgetRef(ref: string): { key: string; pack: string; name: string; id: string | null } | null {
  if (!REF.test(ref)) return null;
  const [pack, name, id] = ref.split('/');
  return { key: `${pack}/${name}`, pack, name, id: id ?? null };
}

export function widgetEnabled(ui: CustomUi | null | undefined, ref: string): boolean {
  const r = parseWidgetRef(ref);
  if (!r) return false;
  return installedWidgets(ui).some((w) => w.key === r.key && w.enabled);
}

/**
 * The page to serve for a widget ref, or a refusal. Consent (enabled), integrity (the installed pack still hashes to
 * its record), containment (the page is a plain file under the widget directory) and size are all re-checked at
 * open time, not trusted from startup.
 */
export function widgetPage(ui: CustomUi | null | undefined, ref: string): { ok: true; page: WidgetPage } | { ok: false; reason: string } {
  const r = parseWidgetRef(ref);
  if (!r) return { ok: false, reason: `bad widget ref "${ref}" (<pack>/<widget>[/<id>])` };
  const w = installedWidgets(ui).find((x) => x.key === r.key);
  if (!w) return { ok: false, reason: `no installed widget ${r.key} (trenchscope pack list)` };
  if (!w.enabled) return { ok: false, reason: `${r.key} is not enabled (trenchscope pack widget ${r.pack} ${r.name} --enable)` };
  const rec = (ui?.config.packs ?? []).find((p) => p.name === r.pack);
  if (!rec || !ui) return { ok: false, reason: `pack ${r.pack} has no install record` };
  const packDir = join(packsDir(ui.home), `${rec.name}@${rec.version}`);
  const integ = checkIntegrity(packDir);
  if (!integ.ok || integ.hash !== rec.hash) return { ok: false, reason: `pack ${r.pack} changed since install (${integ.ok ? 'hash differs' : integ.reason}); re-install it` };
  const spec = r.id ? w.manifest.widgets.find((x) => x.id === r.id) : w.manifest.widgets[0];
  if (!spec) return { ok: false, reason: `${r.key} has no widget "${r.id}" (${w.manifest.widgets.map((x) => x.id).join(', ')})` };
  const path = resolve(w.dir, spec.page);
  let root: string;
  try { root = realpathSync(w.dir); } catch { return { ok: false, reason: `${r.key}: directory missing` }; }
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return { ok: false, reason: `${r.key}: page ${spec.page} is missing or a symlink` };
  const real = realpathSync(path);
  if (!real.startsWith(root + sep) || !lstatSync(real).isFile()) return { ok: false, reason: `${r.key}: page ${spec.page} is outside the widget directory` };
  const html = readFileSync(real, 'utf8');
  if (html.length > WIDGET_HTML_MAX) return { ok: false, reason: `${r.key}: page is ${html.length} chars (max ${WIDGET_HTML_MAX})` };
  // r2: install refused loaders already; a pack installed before that check (or a hash-valid page nobody re-inspected)
  // is refused here too, with the reason, before the host ever sees it
  const problems = auditWidgetHtml(html);
  if (problems.length) return { ok: false, reason: `${r.key}: page ${spec.page} refused: ${problems.join('; ')}` };
  return { ok: true, page: { key: r.id ? `${r.key}/${r.id}` : `${r.key}/${spec.id}`, title: spec.title, topics: [...spec.topics] as WidgetTopic[], html } };
}

// ------------------------------------------------------------------ view models (public columns only)
const FORBIDDEN_KEYS = /^(arm|armed|sign|signer|keys?|caps?|mandates?|gate|secret|token|apiKey|passphrase|seed|privateKey)$/i;

export function widgetRowsVM(state: AppState): WidgetRowsVM {
  const rows: WidgetRowVM[] = [];
  const seen = new Set<string>();
  for (const r of state.screener.rows as ScreenerRow[]) {
    if (!r.mint || r.skeleton || seen.has(r.mint)) continue;
    seen.add(r.mint);
    rows.push({
      symbol: r.symbol, name: r.name, mint: r.mint, launchpad: r.launchpad,
      price: r.price, mcap: r.mcap, liq: r.liq, vol5m: r.vol5m, vol1h: r.vol1h, vol24: r.vol24,
      chg: { ...r.chg }, ageMin: r.ageMin, holders: r.holders, org: r.org, top10: r.top10,
      flags: r.flags.map((f) => String(f)), verified: r.verified,
    });
    if (rows.length >= 200) break;
  }
  return { feed: state.screener.preset, rows, updatedAt: state.now.getTime() };
}

export function widgetPositionsVM(state: AppState): WidgetPositionsVM {
  const rows: WidgetPositionsVM['rows'] = [];
  const live = state.live;
  if (live) {
    try {
      for (const p of live.positions.view().rows) rows.push({ symbol: p.symbol, mint: p.mint, side: 'long', tokens: p.tokens, valueSol: p.valueSol, unrealizedSol: p.unrealizedSol, unrealizedPct: p.unrealizedPct, book: 'paper' });
    } catch { /* no paper book on this run */ }
    const lp = live.livePositions;
    if (lp) {
      try {
        for (const p of lp.positions()) {
          if (p.tokensRaw <= 0n) continue;
          const h = lp.held(p.mint);
          rows.push({ symbol: p.symbol, mint: p.mint, side: 'long', tokens: h?.tokens ?? Number(p.tokensRaw) / 10 ** p.decimals, valueSol: null, unrealizedSol: null, unrealizedPct: null, book: 'live' });
        }
      } catch { /* ledger unreadable */ }
    }
  }
  return { rows, updatedAt: state.now.getTime() };
}

export function widgetAlertsVM(state: AppState, limit = 50): WidgetAlertsVM {
  const items: WidgetAlertsVM['items'] = [];
  const now = state.now.getTime();
  for (const l of state.rulesUi?.log ?? []) if (l.kind === 'alert' || l.kind === 'proposal') items.push({ at: l.at, level: l.level, kind: `rule:${l.kind}`, text: l.text, symbol: l.symbol || null });
  const store = state.live?.watch.store;
  if (store) {
    try {
      const symbolOf = (mint: string | null): string | null => (mint ? (state.screener.rows as ScreenerRow[]).find((r) => r.mint === mint)?.symbol ?? null : null);
      for (const e of store.events(limit)) items.push({ at: e.t, level: e.level, kind: e.kind, text: e.text, symbol: symbolOf(e.mint) });
    } catch { /* store closed */ }
  } else {
    for (const a of state.fx.alerts) items.push({ at: now - a.ago * 1000, level: a.level, kind: a.kind, text: a.text, symbol: null });
  }
  items.sort((a, b) => b.at - a.at);
  return { items: items.slice(0, limit), updatedAt: now };
}

export interface WidgetVMDeps { token?: () => TokenDetailVM | null; narrative?: () => NarrativeBoardVM | null }

/** The payload for one topic right now, or null when that topic has nothing yet (token with no coin open, narrative before the board). */
export function widgetPayload(state: AppState, topic: WidgetTopic, deps: WidgetVMDeps = {}): WidgetPayload | null {
  switch (topic) {
    case 'rows': return widgetRowsVM(state);
    case 'token': return deps.token?.() ?? null;
    case 'narrative': return deps.narrative?.() ?? null;
    case 'positions': return widgetPositionsVM(state);
    case 'alerts': return widgetAlertsVM(state);
    case 'theme': return popupThemeFrom(state.theme) as ThemeTokens;
    default: return null;
  }
}

/** Defence in depth for tests and the sync path: no money-shaped key anywhere in a payload. */
export function payloadKeys(v: unknown, acc: string[] = []): string[] {
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as object)) { acc.push(k); payloadKeys(x, acc); }
  return acc;
}
export function payloadIsPublic(v: unknown): boolean { return !payloadKeys(v).some((k) => FORBIDDEN_KEYS.test(k)); }

/** Minimum spacing between pushes of the same topic to the same widget (rows refresh every 10 s anyway). */
export const WIDGET_SYNC_MS = 1000;

/**
 * Push fresh view models to every open widget (self-throttled per widget+topic). `force` ignores the throttle
 * (first paint after `ready`, a theme change). Pure over the controller: a missing controller is a no-op.
 */
export function syncWidgetPopups(state: AppState, deps: WidgetVMDeps = {}, opts: { force?: boolean; only?: string; topics?: WidgetTopic[] } = {}): number {
  const p = state.popups;
  if (!p?.openWidgets || !p.syncWidget) return 0;
  const open = p.openWidgets();
  if (!open.length) return 0;
  const now = state.now.getTime();
  const stamps = (state.widgetSync ??= new Map<string, number>());
  const cache = new Map<WidgetTopic, WidgetPayload | null>();
  let pushed = 0;
  for (const w of open) {
    if (opts.only && w.key !== opts.only) continue;
    for (const topic of w.topics) {
      if (opts.topics && !opts.topics.includes(topic)) continue;
      const stampKey = `${w.key}|${topic}`;
      if (!opts.force && now - (stamps.get(stampKey) ?? -Infinity) < WIDGET_SYNC_MS) continue;
      if (!cache.has(topic)) cache.set(topic, widgetPayload(state, topic, deps));
      const payload = cache.get(topic) ?? null;
      if (!payload || !payloadIsPublic(payload)) continue;
      p.syncWidget(w.key, topic, payload);
      stamps.set(stampKey, now);
      pushed++;
    }
  }
  return pushed;
}
