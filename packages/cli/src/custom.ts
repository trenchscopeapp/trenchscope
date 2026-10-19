// trenchscope — the customization layer's app adapter (task-1358 Tier 1: workspaces). Pure helpers over
// @dexterm/custom that the key handler, the interactive loop and the screens call: load config + workspaces
// into `state.custom`, turn a workspace into a plan the loop applies (theme, intensity, screener preset /
// filter / sort, token panel toggles, start screen, HUD popups), decide which popups to open, and hand the
// renderers the solved layout numbers for the active workspace.
//
// A workspace switch is a UI action and nothing more: it can navigate, re-theme and open READ-ONLY popups
// (the same popups the keys open). It never opens a ticket, never confirms, never arms, never signs.
import { THEMES, THEME_NAMES, isThemeName, DEFAULT_KEYMAP, Keymap, type Theme, type Intensity, type ScreenKey, type AppAction } from '@dexterm/tui';
import {
  loadConfig, listWorkspaces, writeWorkspace, captureWorkspace, layoutNumbers, dextermHome, DEFAULT_WORKSPACE, MORNING_HUD,
  listUserThemes, resolveTheme, applyOverrides, applyKeymapConfig, loadPacks,
  type DextermConfig, type Workspace, type WorkspaceFile, type PopupSpec, type PopupKind, type LayoutNumbers, type WorkspaceSnapshot,
  type ThemeFile, type ThemeDoc, type KeymapResult, type LoadedPackContent, type RuleJson, type PriceMode,
} from '@dexterm/custom';
import { parseSortArg } from './screener/sort.ts';
import { presetSpec } from './screener/presets.ts';

/** Customization state on AppState (absent on runs that never loaded a config, e.g. one-shot fixture frames). */
export interface CustomUi {
  home: string;
  config: DextermConfig;
  /** Loader problems (the defaults are in use when non-empty). Shown once as a toast and by `trenchscope doctor`. */
  configErrors: string[];
  configNotes: string[];
  workspaces: WorkspaceFile[];
  /** Name of the active workspace ('default' until switched). */
  active: string;
  /** A pending chord prefix ('ctrl+w') and when it was pressed; the loop clears it after CHORD_TTL_MS. */
  chord: string | null;
  chordAt: number;
  /** The workspace name being typed for "save as" (null = not typing). */
  nameInput: string | null;
  /** HUD popups the loop must open for the workspace that was just activated (applyAction cannot open windows). */
  pendingPopups: PopupSpec[] | null;
  /** One-line reply shown as a toast by the loop. */
  notice: string | null;
  /** Cursor in the workspaces overlay. */
  listCursor: number;
  /** Cached solved layout numbers for (workspace, w, h). */
  layoutCache?: { key: string; numbers: LayoutNumbers };
  // ---- Tier 2: themes + keymap
  /** User themes (~/.dexterm/themes/*.json + config.theme.user), bad ones carrying their error. */
  themes: ThemeFile[];
  /** Problems with the theme layer (a refused override, a theme that fails the contrast floor) — toast + doctor. */
  themeErrors: string[];
  /** The effective keymap (defaults + config.keymap). On any keymap error this IS the defaults. */
  keymap: Keymap<AppAction>;
  keymapResult: KeymapResult<AppAction>;
  // ---- Tier 4: packs
  /** Content of every INSTALLED pack (config.packs records whose directory still hashes to the recorded hash); null when none. */
  packs: LoadedPackContent | null;
  /**
   * Rules contributed by packs (namespaced `<pack>-<rule>`, source `pack:<pack>`), `enabled` only when the pack is
   * reviewed/signed. A `config.rules` entry with the same id is the user's copy and wins (that is how a pack rule
   * gets enabled on the Rules screen: the toggle copies it).
   */
  packRules: RuleJson[];
}

export const CHORD_TTL_MS = 1500;
export const MAX_WORKSPACE_NAME = 40;

/** Load config.json + the workspaces directory into `state.custom`. Never throws (problems land in configErrors). */
export function initCustom(env: NodeJS.ProcessEnv = process.env, now = Date.now()): CustomUi {
  const home = dextermHome(env);
  const loaded = loadConfig(home);
  const keymapResult = applyKeymapConfig<AppAction>(DEFAULT_KEYMAP.bindings, loaded.config.keymap);
  const ui: CustomUi = {
    home, config: loaded.config, configErrors: loaded.errors, configNotes: loaded.notes,
    workspaces: listWorkspaces(home), active: DEFAULT_WORKSPACE,
    chord: null, chordAt: now, nameInput: null, pendingPopups: null, notice: null, listCursor: 0,
    themes: listUserThemes(home, loaded.config), themeErrors: [],
    keymap: keymapResult.errors.length ? DEFAULT_KEYMAP : new Keymap<AppAction>(keymapResult.bindings as Keymap<AppAction>['bindings']),
    keymapResult,
    packs: null, packRules: [],
  };
  // task-1358 Tier 4: installed packs contribute namespaced workspaces (`<pack>/<name>`), themes (`<pack>-<name>`)
  // and rules. Widgets stay registered DISABLED until `trenchscope pack widget … --enable`; a pack keymap is never
  // merged here (only `trenchscope pack keymap <name> --merge` does, through the same validation as config.keymap).
  if (loaded.config.packs?.length) {
    const packs = loadPacks(home, loaded.config);
    ui.packs = packs;
    for (const w of packs.workspaces) if (!ui.workspaces.some((x) => x.name === w.name)) ui.workspaces.push({ name: w.name, path: w.path, workspace: w.workspace, builtin: false, pack: w.pack });
    for (const t of packs.themes) if (!ui.themes.some((x) => x.name === t.name)) ui.themes.push({ name: t.name, path: t.path, doc: t.doc, pack: t.pack });
    ui.packRules = packs.rules;
    for (const e of packs.errors) ui.configErrors.push(e);
    for (const n of packs.notes) ui.configNotes.push(n);
  }
  for (const t of ui.themes) if (t.error) ui.themeErrors.push(`theme ${t.name}: ${t.error}`);
  for (const e of keymapResult.errors) ui.configErrors.push(`keymap ${e.path}: ${e.msg} (the default keys are in use)`);
  const configured = loaded.config.layout?.workspace;
  if (configured && ui.workspaces.some((w) => w.name === configured && !w.error)) ui.active = configured;
  return ui;
}

// ------------------------------------------------------------------ themes
/** Built-in names first (the `t` cycle order), then the user themes that load. */
export function themeNames(ui: CustomUi | null | undefined): string[] {
  return [...THEME_NAMES, ...(ui?.themes ?? []).filter((t) => !t.error).map((t) => t.name)];
}

/**
 * Resolve a theme by name: a built-in or a user theme merged over its base, with `config.theme.overrides`
 * applied on top. A theme that fails the contrast / hue guard is null (the caller keeps the current one) and the
 * reason lands in `ui.themeErrors` once.
 */
export function themeByName(ui: CustomUi | null | undefined, name: string): Theme | null {
  const overrides = ui?.config.theme?.overrides;
  const note = (msg: string): void => { if (ui && !ui.themeErrors.includes(msg)) ui.themeErrors.push(msg); };
  let base: ThemeDoc | null = null;
  if (isThemeName(name)) base = THEMES[name] as unknown as ThemeDoc;
  else {
    const t = ui?.themes.find((x) => x.name === name && !x.error);
    if (!t) return null;
    const r = resolveTheme(t.doc, THEMES as unknown as Record<string, ThemeDoc>);
    if (!r.theme) { note(`theme ${name}: ${r.errors[0].path} ${r.errors[0].msg}`); return null; }
    base = r.theme;
  }
  const o = applyOverrides(base, overrides);
  if (o.errors.length) note(`theme overrides: ${o.errors[0].path} ${o.errors[0].msg} (ignored)`);
  return o.theme as unknown as Theme;
}

/** The next theme in the cycle after `current` (built-ins, then user themes); skips themes that fail to resolve. */
export function cycleTheme(ui: CustomUi | null | undefined, current: Theme): Theme {
  const names = themeNames(ui);
  let i = names.indexOf(current.name);
  for (let n = 0; n < names.length; n++) {
    i = (i + 1) % names.length;
    const t = themeByName(ui, names[i]);
    if (t) return t;
  }
  return current;
}

export function findWorkspace(ui: CustomUi, name: string): Workspace | null {
  return ui.workspaces.find((w) => w.name === name && !w.error)?.workspace ?? null;
}
export function activeWorkspace(ui: CustomUi | null | undefined): Workspace | null {
  return ui ? findWorkspace(ui, ui.active) : null;
}
/** Workspace names in list order (built-ins first), bad files excluded; the 1-9 slots of the overlay and `ctrl+w <digit>`. */
export function workspaceSlots(ui: CustomUi): string[] { return ui.workspaces.filter((w) => !w.error).map((w) => w.name); }

export function nextWorkspaceName(ui: CustomUi, step: 1 | -1): string {
  const names = workspaceSlots(ui);
  if (!names.length) return DEFAULT_WORKSPACE;
  const i = Math.max(0, names.indexOf(ui.active));
  return names[(i + step + names.length) % names.length];
}

// ------------------------------------------------------------------ the switch plan
/** What a workspace switch changes. Built pure; `applyWorkspacePlan` in main.ts performs it on the state. */
export interface WorkspacePlan {
  name: string;
  theme: string | null;
  intensity: Intensity | null;
  /** task-1366: the workspace's price display mode (null = keep the current one). */
  priceMode: PriceMode | null;
  screener: { preset: string | null; filter: string | null; sort: { key: string; dir: 'asc' | 'desc' } | null };
  token: { tape?: boolean; social?: boolean; analyst?: boolean };
  /** The navigation action for the start screen (null = stay). */
  start: AppAction | null;
  startScreen: ScreenKey | null;
  popups: PopupSpec[];
  /** Why a part of the workspace was ignored (unknown theme / preset); surfaced as a toast. */
  warnings: string[];
}

const START_ACTION: Record<string, AppAction> = {
  screener: 'screen.screener', newpairs: 'screen.newpairs', watchlist: 'screen.watchlist', analyst: 'screen.analyst',
  positions: 'screen.positions', narrative: 'screen.narrative', plans: 'screen.plans', trending: 'screen.trending',
};

export function planWorkspace(ws: Workspace, opts: { themeKnown?: (name: string) => boolean } = {}): WorkspacePlan {
  const warnings: string[] = [];
  const themeKnown = opts.themeKnown ?? ((n) => isThemeName(n));
  let theme: string | null = null;
  if (ws.theme) { if (themeKnown(ws.theme)) theme = ws.theme; else warnings.push(`theme "${ws.theme}" is not installed (kept the current one)`); }
  let preset: string | null = null;
  if (ws.screener?.preset) { if (presetSpec(ws.screener.preset)) preset = presetSpec(ws.screener.preset)!.id; else warnings.push(`unknown preset "${ws.screener.preset}"`); }
  let sort: WorkspacePlan['screener']['sort'] = null;
  if (ws.screener?.sort) { try { sort = parseSortArg(ws.screener.sort); } catch (e) { warnings.push(`bad sort "${ws.screener.sort}": ${(e as Error).message}`); } }
  const start = ws.start ?? null;
  const startAction = start && start !== 'token' ? START_ACTION[start] ?? null : null;
  return {
    name: ws.name, theme, intensity: ws.intensity ?? null, priceMode: ws.priceMode ?? null,
    screener: { preset, filter: ws.screener?.filter ?? null, sort },
    token: { ...(ws.token ?? {}) },
    start: startAction, startScreen: (start as ScreenKey | null),
    popups: [...(ws.popups ?? [])], warnings,
  };
}

/** Apply the theme part of a plan (the loop and tests both use it): built-in or user theme. */
export function themeFor(name: string, ui?: CustomUi | null): Theme | null { return themeByName(ui, name); }

// ------------------------------------------------------------------ popups
export interface PopupStatus {
  chartOpen: boolean; bubblesOpen: boolean; narrativeOpen: boolean; plansOpen: boolean; tokenOpen?: boolean; feedsOpen?: boolean; hasToken: boolean;
  /** task-1358 Tier 5: pack widgets — is `<pack>/<widget>` enabled (consented) / already open. Absent = no widget support on this run. */
  widgetEnabled?: (ref: string) => boolean;
  widgetOpen?: (ref: string) => boolean;
}
export interface PopupPlan { open: PopupKind[]; /** task-1358 Tier 5: pack widget refs to open (enabled, not yet open). */ widgets: string[]; skipped: Array<{ kind: PopupKind; why: string }> }

/**
 * Which of a workspace's popups the loop should open now. Chart/bubbles/token need an open token (the
 * workspace says `mint: selected`); the roster window has no workspace binding yet and is reported, not
 * guessed. Already-open popups are left alone (never toggled closed). A `widget` popup opens only when the
 * user enabled that pack widget (`trenchscope pack widget <pack> <w> --enable`): a workspace can never consent for them.
 */
export function planPopupOpens(specs: readonly PopupSpec[], st: PopupStatus): PopupPlan {
  const out: PopupPlan = { open: [], widgets: [], skipped: [] };
  const seen = new Set<string>();
  for (const s of specs) {
    const id = s.kind === 'widget' ? `widget:${s.widget ?? ''}` : s.kind;
    if (seen.has(id)) continue;
    seen.add(id);
    if (s.kind === 'widget') {
      const ref = s.widget ?? '';
      if (!ref) out.skipped.push({ kind: 'widget', why: 'no widget named' });
      else if (!st.widgetEnabled) out.skipped.push({ kind: 'widget', why: `${ref}: widgets need live or replay mode` });
      else if (!st.widgetEnabled(ref)) out.skipped.push({ kind: 'widget', why: `${ref} is not enabled (trenchscope pack widget ${ref.split('/').slice(0, 2).join(' ')} --enable)` });
      else if (!st.widgetOpen?.(ref)) out.widgets.push(ref);
      continue;
    }
    switch (s.kind) {
      case 'chart': if (!st.hasToken) out.skipped.push({ kind: 'chart', why: 'no token open' }); else if (!st.chartOpen) out.open.push('chart'); break;
      case 'bubbles': if (!st.hasToken) out.skipped.push({ kind: 'bubbles', why: 'no token open' }); else if (!st.bubblesOpen) out.open.push('bubbles'); break;
      case 'token': if (!st.hasToken) out.skipped.push({ kind: 'token', why: 'no token open' }); else if (!st.tokenOpen) out.open.push('token'); break;
      case 'narrative': if (!st.narrativeOpen) out.open.push('narrative'); break;
      case 'plans': if (!st.plansOpen) out.open.push('plans'); break;
      case 'feeds': if (!st.feedsOpen) out.open.push('feeds'); break;
      default: out.skipped.push({ kind: s.kind, why: 'not wired to workspaces yet' });
    }
  }
  return out;
}

// ------------------------------------------------------------------ save
export interface SaveInput extends WorkspaceSnapshot { name: string }

/** Validate a typed name and persist the current layout as a workspace file; returns the new file entry. */
export function saveWorkspace(ui: CustomUi, input: SaveInput): WorkspaceFile {
  const name = input.name.trim();
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new Error('name: lowercase letters, digits and dashes, starting with a letter (max 40)');
  if (name === MORNING_HUD || name === DEFAULT_WORKSPACE) throw new Error(`"${name}" is a built-in workspace; pick another name`);
  const ws = captureWorkspace(name, { ...input, screens: activeWorkspace(ui)?.screens });
  const path = writeWorkspace(ui.home, ws);
  const entry: WorkspaceFile = { name, path, workspace: ws, builtin: false };
  const i = ui.workspaces.findIndex((w) => w.name === name);
  if (i >= 0) ui.workspaces[i] = entry; else ui.workspaces.push(entry);
  return entry;
}

// ------------------------------------------------------------------ layout numbers for the renderers
/** The solved layout numbers for the active workspace at this frame size (cached per workspace × size). */
export function layoutFor(ui: CustomUi | null | undefined, w: number, h: number): LayoutNumbers {
  if (!ui) return layoutNumbers(null, w, h);
  const key = `${ui.active}|${w}x${h}`;
  if (ui.layoutCache?.key === key) return ui.layoutCache.numbers;
  const numbers = layoutNumbers(activeWorkspace(ui), w, h);
  ui.layoutCache = { key, numbers };
  return numbers;
}

/** Footer/band badge text for the workspace state, or null when there is nothing to show (default, idle). */
export function workspaceBadge(ui: CustomUi | null | undefined, now = Date.now()): { text: string; kind: 'chord' | 'input' | 'name' } | null {
  if (!ui) return null;
  if (ui.nameInput !== null) return { text: ` save workspace as: ${ui.nameInput}▏ (⏎ save · esc cancel) `, kind: 'input' };
  if (ui.chord && now - ui.chordAt <= CHORD_TTL_MS) return { text: ' ^W  w list · n/N next/prev · s save · m morning HUD · o popups · d default · 1-9 pick ', kind: 'chord' };
  if (ui.active !== DEFAULT_WORKSPACE) return { text: ` ⌗ ${ui.active} `, kind: 'name' };
  return null;
}
