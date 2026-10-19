// @dexterm/custom — named workspaces (task-1358 Tier 1). A workspace is a JSON document: where to land
// (screen), the theme / intensity to use, the screener preset/filter/sort, token-panel toggles, per-screen
// pane trees for the layout solver, and the HUD popups to open together (task-1290 windows). The shipped
// `default` reproduces today's screens byte for byte; `morning-hud` is the north-star "show me everything".
//
// Workspaces hold NO keys, NO trading settings and NO code: the schema is additional:false and a pack or a
// Jarvis proposal that tries to smuggle anything else is refused by name (schema.ts). Switching a workspace
// is a UI action: it can navigate, re-theme and open read-only popups; it can never arm, sign or confirm.
import { validate, type SchemaError, POPUP_KINDS, WORKSPACE_SCREENS, type Intensity, type PriceMode, type WidgetSpec } from './schema.ts';
import { breakpoint, solve, treeFor, widgetsIn, widgetSpec, type ScreenLayout, type Rect, type Solved, type Tree } from './layout.ts';

export type PopupKind = (typeof POPUP_KINDS)[number];
export type WorkspaceScreen = (typeof WORKSPACE_SCREENS)[number];

export interface PopupSpec { kind: PopupKind; /** task-1358 Tier 5: `<pack>/<widget>[/<id>]` when kind is `widget`. */ widget?: string; mint?: string; x?: number; y?: number; w?: number; h?: number; ontop?: boolean; clickthrough?: boolean }

export interface Workspace {
  name: string;
  description?: string;
  screens?: Record<string, ScreenLayout>;
  popups?: PopupSpec[];
  start?: WorkspaceScreen;
  screener?: { preset?: string; filter?: string; sort?: string };
  theme?: string;
  intensity?: Intensity;
  /** task-1366: price display mode while this workspace is active (absent = keep config.display.priceMode). */
  priceMode?: PriceMode;
  token?: { tape?: boolean; social?: boolean; analyst?: boolean };
}

export const DEFAULT_WORKSPACE = 'default';
export const MORNING_HUD = 'morning-hud';

/**
 * The shipped layout. It carries NO `screens` trees: a workspace without trees means "the renderers' own
 * numbers" (spotlight 44 at ≥ 140 cols, chart 46 %, analyst max(46, 34 %)), which keeps every snapshot golden
 * byte-identical. `builtinScreens()` is the editable tree form of the same layout (`trenchscope workspace init`).
 */
export function defaultWorkspace(): Workspace {
  return { name: DEFAULT_WORKSPACE, description: 'The shipped layout (SPEC §4)', popups: [], start: 'screener' };
}

/**
 * The north-star morning HUD (ROADMAP): "yo jarvis, show me everything" → the narrative board on the
 * terminal, with the narrative board, the social/news feeds, the order plans and the chart of the highlighted
 * coin as HUD windows. (Popup kinds are the host's: there is no separate positions/alerts window; plans
 * carries the PAPER plan rows, the chart carries the held position, feeds carries KOL/news + alerts-worthy posts.)
 */
export function morningHudWorkspace(): Workspace {
  return {
    name: MORNING_HUD,
    description: 'Morning HUD: narrative board + feeds + order plans + chart popups, trenches feed on the screener',
    start: 'narrative',
    screener: { preset: 'trench' },
    popups: [
      { kind: 'narrative', x: 0.62, y: 0.04, w: 0.36, h: 0.46 },
      { kind: 'feeds', x: 0.62, y: 0.52, w: 0.36, h: 0.44 },
      { kind: 'plans', x: 0.02, y: 0.56, w: 0.28, h: 0.4 },
      { kind: 'chart', mint: 'selected', x: 0.32, y: 0.56, w: 0.28, h: 0.4 },
    ],
  };
}

export function builtinWorkspaces(): Workspace[] { return [defaultWorkspace(), morningHudWorkspace()]; }

/**
 * Schema + semantics: every widget a tree names must exist (built-in, or a `plugin:` id present in `registry`),
 * so a shared workspace cannot name `shell.exec` and hope a renderer picks it up.
 */
export function validateWorkspace(ws: unknown, registry: Record<string, WidgetSpec> = {}): SchemaError[] {
  const errors = validate('workspace', ws);
  if (errors.length) return errors;
  const screens = (ws as Workspace).screens ?? {};
  for (const [screen, layout] of Object.entries(screens)) {
    const trees: Tree[] = 'kind' in layout ? [layout] : (['wide', 'standard', 'compact'] as const).map((b) => layout[b]).filter((t): t is Tree => !!t);
    for (const t of trees) for (const id of widgetsIn(t)) if (!widgetSpec(id, registry)) errors.push({ path: `/screens/${screen}`, msg: `unknown widget "${id}"` });
  }
  // task-1358 Tier 5: a `widget` popup must name the pack widget; other kinds must not carry one
  ((ws as Workspace).popups ?? []).forEach((p, i) => {
    if (p.kind === 'widget' && !p.widget) errors.push({ path: `/popups/${i}`, msg: 'a widget popup needs "widget": "<pack>/<widget>"' });
    if (p.kind !== 'widget' && p.widget !== undefined) errors.push({ path: `/popups/${i}/widget`, msg: `only kind "widget" takes a widget ref` });
  });
  return errors;
}

/** Parse + validate a workspace document; throws a one-line error naming the first problem. */
export function parseWorkspace(text: string, source = 'workspace'): Workspace {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`${source}: not valid JSON (${(e as Error).message})`); }
  const errors = validateWorkspace(raw);
  if (errors.length) throw new Error(`${source}: ${errors[0].path || '/'} ${errors[0].msg}`);
  return raw as Workspace;
}

/** The screen the workspace lands on (start, else the screener). */
export function workspaceStart(ws: Workspace): WorkspaceScreen { return ws.start ?? 'screener'; }

// ------------------------------------------------------------------ the numbers the renderers read
/**
 * The few layout numbers today's screens compute by hand, now solved from the workspace's trees. The default
 * workspace yields exactly the renderers' historical values (spotlight 44 wide only at ≥ 140 cols; chart 46 %
 * of the token body; analyst panel 46 at wide / 40 at standard) so the snapshot goldens are unchanged.
 */
export interface LayoutNumbers {
  /** Screener spotlight width in cells (0 = hidden). */
  spotlightW: number;
  /** New-pairs spotlight width (0 = hidden). */
  pairSpotlightW: number;
  /** Token chart height as a fraction of the body under the title strip. */
  chartFrac: number;
  /** Token analyst panel width (0 = hidden). */
  analystW: number;
}

const DEFAULT_NUMBERS = (w: number, h: number): LayoutNumbers => {
  const bp = breakpoint(w);
  return { spotlightW: bp === 'wide' ? 44 : 0, pairSpotlightW: bp === 'wide' ? 46 : 0, chartFrac: 0.46, analystW: bp === 'compact' ? 0 : bp === 'wide' ? Math.max(46, Math.floor(w * 0.34)) : 40 };
};

export function solveScreen(ws: Workspace | null | undefined, screen: string, rect: Rect): Solved | null {
  const tree = treeFor(ws?.screens?.[screen], breakpoint(rect.w));
  return tree ? solve(tree, rect) : null;
}

/** Solve the workspace for a terminal size and read the renderer numbers off the panes (defaults when a tree is absent). */
export function layoutNumbers(ws: Workspace | null | undefined, w: number, h: number): LayoutNumbers {
  const base = DEFAULT_NUMBERS(w, h);
  if (!ws?.screens) return base;
  const body: Rect = { x: 0, y: 2, w, h: Math.max(1, h - 3) };
  const out = { ...base };
  const scr = solveScreen(ws, 'screener', body);
  if (scr) out.spotlightW = scr.panes.find((p) => p.widget === 'screener.spotlight')?.rect.w ?? 0;
  const np = solveScreen(ws, 'newpairs', body);
  if (np) out.pairSpotlightW = np.panes.find((p) => p.widget === 'newpairs.spotlight')?.rect.w ?? 0;
  const tk = solveScreen(ws, 'token', body);
  if (tk) {
    const chart = tk.panes.find((p) => p.widget === 'token.chart');
    if (chart) out.chartFrac = Math.max(0.2, Math.min(0.85, chart.rect.h / body.h));
    out.analystW = tk.panes.find((p) => p.widget === 'analyst.panel')?.rect.w ?? 0;
    // the analyst panel is a tree choice; the renderer still hides it under --no-ai (state.aiOpen === false)
  }
  return out;
}

/** Build a workspace from what is on screen right now ("save the current layout as …"). */
export interface WorkspaceSnapshot {
  screen: string;
  theme: string;
  intensity: Intensity;
  /** task-1366: the price display mode on screen (saved only when it is not the default `price`). */
  priceMode?: PriceMode;
  screener?: { preset?: string | null; filter?: string | null; sort?: string | null };
  token?: { tape?: boolean; social?: boolean; analyst?: boolean };
  /** Popups open right now. */
  popups?: PopupKind[];
  /** task-1358 Tier 5: pack widget popups open right now (`<pack>/<widget>[/<id>]`). */
  widgets?: string[];
  /** The trees of the workspace that was active (kept so a saved copy of `default` is editable). */
  screens?: Record<string, ScreenLayout>;
}

export function captureWorkspace(name: string, snap: WorkspaceSnapshot): Workspace {
  const start = (WORKSPACE_SCREENS as readonly string[]).includes(snap.screen) ? (snap.screen as WorkspaceScreen) : 'screener';
  const ws: Workspace = { name, description: `saved from the ${snap.screen} screen`, start, theme: snap.theme, intensity: snap.intensity };
  if (snap.priceMode && snap.priceMode !== 'price') ws.priceMode = snap.priceMode;
  if (snap.screens) ws.screens = structuredClone(snap.screens);
  const sc: NonNullable<Workspace['screener']> = {};
  if (snap.screener?.preset) sc.preset = snap.screener.preset;
  if (snap.screener?.filter) sc.filter = snap.screener.filter.slice(0, 200);
  if (snap.screener?.sort) sc.sort = snap.screener.sort;
  if (Object.keys(sc).length) ws.screener = sc;
  if (snap.token && Object.keys(snap.token).length) ws.token = { ...snap.token };
  if (snap.popups?.length || snap.widgets?.length) ws.popups = [
    ...(snap.popups ?? []).filter((k) => k !== 'widget').map((kind) => ({ kind, ...(kind === 'chart' || kind === 'bubbles' || kind === 'token' ? { mint: 'selected' } : {}) })),
    ...(snap.widgets ?? []).map((widget) => ({ kind: 'widget' as const, widget })),
  ];
  const errors = validateWorkspace(ws);
  if (errors.length) throw new Error(`${errors[0].path || '/'} ${errors[0].msg}`);
  return ws;
}
