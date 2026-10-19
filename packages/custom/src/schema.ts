// @dexterm/custom — config schema, validation, JSON-patch ops (with inverses for undo), the actor policy
// (which paths a non-user actor may touch) and versioned migrations (task-1358, from the task-1288 design).
//
// Zero dependencies: the validator is a tiny hand-written subset of JSON Schema so the app keeps its
// "no runtime deps" rule. KEYS NEVER APPEAR IN THIS SCHEMA: there is no `keys` / `signer` / `trading`
// section at all (additional:false makes an attempt to add one a precise refusal), and the v1 migration
// demonstrates moving a key OUT of the config file into `~/.dexterm/<name>.key`.

export const CONFIG_VERSION = 4;

export interface SchemaError { path: string; msg: string }

type SchemaNode =
  | string
  | { oneOf: SchemaNode[] }
  | { type: 'object'; additional?: boolean; required?: string[]; props?: Record<string, SchemaNode>; values?: SchemaNode }
  | { type: 'array'; items: SchemaNode; max?: number }
  | { type: 'string'; enum?: readonly string[]; pattern?: string; max?: number }
  | { type: 'number'; int?: boolean; min?: number; max?: number }
  | { type: 'boolean' }
  | { type: 'null' };

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Validate `value` against a schema (a node or the name of one in `refs`); returns the error list. */
export function validate(schema: SchemaNode, value: unknown, path = '', errors: SchemaError[] = [], refs: Record<string, SchemaNode> = SCHEMAS): SchemaError[] {
  let S: SchemaNode | undefined = schema;
  for (let hops = 0; typeof S === 'string' && hops < 8; hops++) S = refs[S];
  if (!S || typeof S === 'string') { errors.push({ path, msg: `unknown schema ${String(schema)}` }); return errors; }
  if ('oneOf' in S) {
    const attempts = S.oneOf.map((s) => validate(s, value, path, [], refs));
    if (!attempts.some((e) => e.length === 0)) errors.push({ path, msg: `matches none of ${S.oneOf.length} shapes: ${attempts.map((e) => e[0]?.msg).join(' | ')}` });
    return errors;
  }
  switch (S.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) { errors.push({ path, msg: 'expected object' }); return errors; }
      const obj = value as Record<string, unknown>;
      for (const k of S.required ?? []) if (!(k in obj)) errors.push({ path: `${path}/${k}`, msg: 'required' });
      for (const [k, v] of Object.entries(obj)) {
        if (FORBIDDEN_KEYS.has(k)) { errors.push({ path: `${path}/${k}`, msg: 'forbidden key' }); continue; }
        const sub = S.props && Object.hasOwn(S.props, k) ? S.props[k] : S.values;
        if (!sub) { if (S.additional === false) errors.push({ path: `${path}/${k}`, msg: 'unknown key' }); continue; }
        validate(sub, v, `${path}/${k}`, errors, refs);
      }
      return errors;
    }
    case 'array': {
      if (!Array.isArray(value)) { errors.push({ path, msg: 'expected array' }); return errors; }
      if (S.max !== undefined && value.length > S.max) errors.push({ path, msg: `more than ${S.max} items` });
      value.forEach((v, i) => validate(S.items, v, `${path}/${i}`, errors, refs));
      return errors;
    }
    case 'string': {
      if (typeof value !== 'string') { errors.push({ path, msg: 'expected string' }); return errors; }
      if (S.enum && !S.enum.includes(value)) errors.push({ path, msg: `expected one of ${S.enum.join(', ')}` });
      if (S.pattern && !new RegExp(S.pattern).test(value)) errors.push({ path, msg: `does not match ${S.pattern}` });
      if (S.max !== undefined && value.length > S.max) errors.push({ path, msg: `longer than ${S.max}` });
      return errors;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push({ path, msg: 'expected finite number' }); return errors; }
      if (S.int && !Number.isInteger(value)) errors.push({ path, msg: 'expected integer' });
      if (S.min !== undefined && value < S.min) errors.push({ path, msg: `below ${S.min}` });
      if (S.max !== undefined && value > S.max) errors.push({ path, msg: `above ${S.max}` });
      return errors;
    }
    case 'boolean': if (typeof value !== 'boolean') errors.push({ path, msg: 'expected boolean' }); return errors;
    case 'null': if (value !== null) errors.push({ path, msg: 'expected null' }); return errors;
  }
  return errors;
}

export const HEX = '^#[0-9a-fA-F]{6}$';
export const NAME = '^[a-z][a-z0-9-]{0,39}$';
export const WS_NAME = '^[a-z][a-z0-9-]{0,39}(/[a-z][a-z0-9-]{0,39})?$';
export const MINT = '^[1-9A-HJ-NP-Za-km-z]{32,44}$';
/** A key id as `Keymap.keyId()` produces it, optionally a two-key chord ("ctrl+w s"). */
export const KEY = '^((ctrl|alt|shift)\\+)*([a-zA-Z0-9]|[-=\\[\\]\\\\;\',./`~!@#$%^&*()_+{}|:"<>?]|enter|esc|tab|backspace|delete|space|up|down|left|right|home|end|pageup|pagedown|f[1-9]|f1[0-2])( ((ctrl|alt|shift)\\+)*([a-zA-Z0-9]|enter|esc|tab|space|up|down|left|right))?$';

/** Theme colour tokens (SPEC §7.1 + VISUAL-V2 §2) and the four ramps. A user theme may override any subset. */
export const THEME_TOKENS = ['bg', 'panel', 'panelAlt', 'border', 'borderFocus', 'text', 'muted', 'dim', 'accent', 'accentSoft', 'up', 'upSoft', 'down', 'downSoft', 'warn', 'warnSoft', 'ai', 'aiSoft', 'pump', 'dbc', 'raydium', 'meteora', 'bonk', 'selBg', 'headBg', 'tabActiveBg', 'sparkUp', 'sparkDown', 'magenta', 'cyan', 'coral', 'acid', 'glow', 'scan'] as const;
export const THEME_RAMPS = ['heat', 'rain', 'rainPump', 'rainDump'] as const;
export const BASE_THEMES = ['mono', 'cyberspace', 'midnight', 'ember', 'paper'] as const;

export interface WidgetSpec { title: string; min: { w: number; h: number } }

/** Built-in widget ids a pane may show. Plugin widgets are `plugin:<pkg>/<id>` and must be declared in a manifest. */
export const BUILTIN_WIDGETS: Record<string, WidgetSpec> = {
  'screener.table': { title: 'SCREENER', min: { w: 60, h: 8 } },
  'screener.spotlight': { title: 'SPOTLIGHT', min: { w: 36, h: 12 } },
  'token.chart': { title: 'CHART', min: { w: 40, h: 8 } },
  'token.onchain': { title: 'ON-CHAIN', min: { w: 28, h: 10 } },
  'token.holders': { title: 'HOLDERS', min: { w: 36, h: 8 } },
  'token.flow': { title: 'BUY/SELL FLOW', min: { w: 36, h: 6 } },
  'token.tape': { title: 'TAPE', min: { w: 36, h: 6 } },
  'analyst.panel': { title: '✦ ANALYST', min: { w: 38, h: 10 } },
  'analyst.context': { title: 'CONTEXT', min: { w: 30, h: 10 } },
  'newpairs.table': { title: 'NEW PAIRS', min: { w: 60, h: 8 } },
  'newpairs.spotlight': { title: 'PAIR SPOTLIGHT', min: { w: 36, h: 10 } },
  'watchlist.table': { title: 'WATCHLIST', min: { w: 60, h: 6 } },
  'alerts.log': { title: 'ALERTS', min: { w: 40, h: 5 } },
  'analyst.digest': { title: '✦ ANALYST DIGEST', min: { w: 40, h: 6 } },
  'narrative.board': { title: 'NARRATIVES', min: { w: 44, h: 8 } },
  'positions.table': { title: 'POSITIONS', min: { w: 50, h: 5 } },
  'kol.feed': { title: 'KOL FEED', min: { w: 40, h: 6 } },
  'rain.zone': { title: '', min: { w: 1, h: 1 } },
};
const WIDGET_ID = '^([a-z]+\\.[a-z-]+|plugin:[a-z][a-z0-9-]*/[a-z][a-z0-9-]*)$';

/** Popup kinds a workspace may open: exactly the popup host's kinds (task-1290/1340/1355/1356). */
export const POPUP_KINDS = ['chart', 'token', 'feeds', 'bubbles', 'roster', 'narrative', 'plans', 'widget'] as const;
/** task-1358 Tier 5: the topics a pack widget may subscribe to (mirrors @dexterm/popup WIDGET_TOPICS; the cli tests assert they match). */
export const WIDGET_TOPICS = ['rows', 'token', 'narrative', 'positions', 'alerts', 'theme'] as const;
/** A workspace popup of kind `widget` names an installed pack widget: `<pack>/<widget>[/<id>]`. */
export const WIDGET_REF = '^[a-z][a-z0-9-]{0,39}/[a-z][a-z0-9-]{0,39}(/[a-z][a-z0-9-]{0,39})?$';
export const WORKSPACE_SCREENS = ['screener', 'token', 'newpairs', 'watchlist', 'analyst', 'positions', 'narrative', 'plans', 'trending'] as const;
export const LAYOUT_SCREENS = ['screener', 'token', 'newpairs', 'watchlist', 'analyst', 'positions'] as const;
/**
 * task-1366: how token prices are DISPLAYED. `price` (default) = USD per token; `mcap` = market cap (price × supply,
 * supply from the data layer). A display mode only: the same data underneath, nothing that trades reads it.
 */
export const PRICE_MODES = ['price', 'mcap'] as const;
export type PriceMode = (typeof PRICE_MODES)[number];
export const DEFAULT_PRICE_MODE: PriceMode = 'price';

const tokenProps = (): Record<string, SchemaNode> => Object.fromEntries([...THEME_TOKENS.map((t) => [t, 'hex'] as const), ...THEME_RAMPS.map((t) => [t, 'ramp'] as const)]);

export const SCHEMAS: Record<string, SchemaNode> = {
  hex: { type: 'string', pattern: HEX },
  ramp: { type: 'array', items: 'hex', max: 4 },
  breakpoint: { type: 'string', enum: ['compact', 'standard', 'wide'] },
  layoutNode: {
    oneOf: [
      { type: 'object', additional: false, required: ['kind', 'widget'], props: {
        kind: { type: 'string', enum: ['pane'] },
        widget: { type: 'string', pattern: WIDGET_ID },
        /** 0 never drops; higher numbers drop first when the rect cannot satisfy minimums (same rule as table columns). */
        priority: { type: 'number', int: true, min: 0, max: 9 },
        collapseBelow: 'breakpoint',
        title: { type: 'string', max: 40 },
        /** Widget-specific settings the widget validates itself; plain JSON only. */
        settings: { type: 'object', additional: true },
      } },
      { type: 'object', additional: false, required: ['kind', 'dir', 'children'], props: {
        kind: { type: 'string', enum: ['split'] },
        dir: { type: 'string', enum: ['row', 'col'] },
        children: { type: 'array', max: 8, items: { type: 'object', additional: false, required: ['node'], props: {
          node: 'layoutNode',
          weight: { type: 'number', min: 0.05, max: 100 },
          fixed: { type: 'number', int: true, min: 1, max: 400 },
        } } },
        gutter: { type: 'boolean' },
      } },
    ],
  },
  popupSpec: { type: 'object', additional: false, required: ['kind'], props: {
    kind: { type: 'string', enum: POPUP_KINDS },
    /** task-1358 Tier 5: for kind `widget`, the installed pack widget to open (`<pack>/<widget>[/<id>]`; must be enabled). */
    widget: { type: 'string', pattern: WIDGET_REF },
    /** 'selected' binds to the row under the cursor at open time; a mint pins the popup. */
    mint: { type: 'string', pattern: '^(selected|[1-9A-HJ-NP-Za-km-z]{32,44})$' },
    x: { type: 'number', min: 0, max: 1 }, y: { type: 'number', min: 0, max: 1 }, w: { type: 'number', min: 0.05, max: 1 }, h: { type: 'number', min: 0.05, max: 1 },
    ontop: { type: 'boolean' }, clickthrough: { type: 'boolean' },
  } },
  workspace: { type: 'object', additional: false, required: ['name'], props: {
    /** Pack workspaces are namespaced `<pack>/<name>`. */
    name: { type: 'string', pattern: WS_NAME },
    description: { type: 'string', max: 200 },
    /** Per screen either one tree (with collapseBelow on panes) or a tree per breakpoint. */
    screens: { type: 'object', additional: false, props: Object.fromEntries(LAYOUT_SCREENS.map((s) => [s, 'screenLayout'])) },
    /** HUD windows this workspace opens (task-1290 popups), e.g. "show me everything". */
    popups: { type: 'array', max: 12, items: 'popupSpec' },
    /** Screen to land on when the workspace is activated. */
    start: { type: 'string', enum: WORKSPACE_SCREENS },
    /** Preset / filter / sort the screener opens with. */
    screener: { type: 'object', additional: false, props: { preset: { type: 'string', pattern: NAME }, filter: { type: 'string', max: 200 }, sort: { type: 'string', pattern: '^[a-z0-9]+(:(asc|desc))?$' } } },
    /** Theme name (built-in or user) and effects intensity the workspace switches to. */
    theme: { type: 'string', pattern: NAME },
    intensity: { type: 'string', enum: ['off', 'normal', 'fever'] },
    /** task-1366: the price display mode the workspace switches to (overrides config.display.priceMode while active). */
    priceMode: { type: 'string', enum: PRICE_MODES },
    /** Token-screen panel toggles. */
    token: { type: 'object', additional: false, props: { tape: { type: 'boolean' }, social: { type: 'boolean' }, analyst: { type: 'boolean' } } },
  } },
  screenLayout: { oneOf: ['layoutNode', { type: 'object', additional: false, props: { wide: 'layoutNode', standard: 'layoutNode', compact: 'layoutNode' } }] },
  /** task-1398: one alert-delivery channel. A `levels` filter (subset of up|down|info|warn); absent = every level. */
  alertLevels: { type: 'array', max: 4, items: { type: 'string', enum: ['up', 'down', 'info', 'warn'] } },
  alertChannel: { type: 'object', additional: false, props: { enabled: { type: 'boolean' }, levels: 'alertLevels' } },
  ruleJson: { type: 'object', additional: false, required: ['id', 'when', 'then'], props: {
    id: { type: 'string', pattern: NAME },
    name: { type: 'string', max: 80 },
    enabled: { type: 'boolean' },
    /** The condition in the rule grammar (parsed, never eval'd). */
    when: { type: 'string', max: 400 },
    for: { type: 'string', pattern: '^[0-9]+ ?(s|m|h|ticks?)$' },
    then: { type: 'array', max: 6, items: { type: 'object', additional: false, required: ['action'], props: {
      action: { type: 'string', enum: ['alert', 'ticket', 'ask', 'popup', 'tag', 'sound', 'watch'] },
      args: { type: 'object', additional: true },
    } } },
    scope: { type: 'string', pattern: '^(screener|watchlist|newpairs|positions|mint:[1-9A-HJ-NP-Za-km-z]{32,44})$' },
    cooldown: { type: 'string', pattern: '^[0-9]+ ?(s|m|h)$' },
    maxPerHour: { type: 'number', int: true, min: 1, max: 120 },
    window: { type: 'string', pattern: '^[0-9]+ ?(s|m|h)$' },
    source: { type: 'string', pattern: '^(user|pack:[a-z][a-z0-9-]*|jarvis|plugin:[a-z][a-z0-9-]*)$' },
  } },
  userTheme: { type: 'object', additional: false, required: ['extends'], props: {
    name: { type: 'string', pattern: NAME },
    extends: { type: 'string', enum: BASE_THEMES },
    tokens: { type: 'object', additional: false, props: { ...tokenProps(), logo: { type: 'array', items: 'hex', max: 3 } } },
  } },
  keymap: { type: 'object', additional: false, props: {
    global: { type: 'object', values: { type: 'array', max: 4, items: { type: 'string', pattern: KEY } } },
    screens: { type: 'object', values: { type: 'object', values: { type: 'array', max: 4, items: { type: 'string', pattern: KEY } } } },
  } },
  config: { type: 'object', additional: false, required: ['version'], props: {
    version: { type: 'number', int: true, min: CONFIG_VERSION, max: CONFIG_VERSION },
    theme: { type: 'object', additional: false, props: {
      name: { type: 'string', pattern: NAME },
      overrides: { type: 'object', additional: false, props: tokenProps() },
      user: { type: 'object', values: 'userTheme' },
    } },
    fx: { type: 'object', additional: false, props: { intensity: { type: 'string', enum: ['off', 'normal', 'fever'] }, sound: { type: 'boolean' } } },
    /** task-1366: display options. `priceMode` price | mcap (the `$` key toggles and persists it). */
    display: { type: 'object', additional: false, props: { priceMode: { type: 'string', enum: PRICE_MODES } } },
    layout: { type: 'object', additional: false, props: {
      workspace: { type: 'string', pattern: WS_NAME },
      workspaces: { type: 'object', values: 'workspace' },
    } },
    keymap: 'keymap',
    rules: { type: 'array', max: 200, items: 'ruleJson' },
    plugins: { type: 'object', values: { type: 'object', additional: false, props: {
      enabled: { type: 'boolean' },
      /** Capabilities the USER granted (⊆ manifest). Only the user may edit this (see DENIED_FOR_MODELS). */
      capabilities: { type: 'array', max: 20, items: 'capability' },
      settings: { type: 'object', additional: true },
    } } },
    packs: { type: 'array', max: 50, items: { type: 'object', additional: false, required: ['name', 'version', 'hash', 'trust'], props: {
      name: { type: 'string', pattern: NAME }, version: { type: 'string', pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$' },
      source: { type: 'string', max: 200 }, hash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
      trust: { type: 'string', enum: ['reviewed', 'signed', 'unsigned'] }, publisher: { type: 'string', max: 80 }, installedAt: { type: 'number' },
    } } },
    jarvis: { type: 'object', additional: false, props: {
      configAssistant: { type: 'boolean' },
      proposalTtlS: { type: 'number', int: true, min: 10, max: 600 },
      /** Reserved: the trading gate is NOT here (signer policy owns it); listed so a proposal that tries gets a precise refusal. */
      gate: { type: 'string', enum: ['keypress'] },
    } },
    /** 0.1.5: which of the user's own CLIs runs the analyst. `/analyst` is user-only (DENIED_FOR_MODELS): a model never picks its own engine. */
    analyst: { type: 'object', additional: false, props: {
      engine: { type: 'string', enum: ['auto', 'claude', 'codex'] },
    } },
    /** task-1393: voice-out preferences. `/voice` is user-only (DENIED_FOR_MODELS), so only the keyboard sets it. */
    voice: { type: 'object', additional: false, props: {
      name: { type: 'string', max: 64 },
      rate: { type: 'number', int: true, min: 80, max: 400 },
      pitch: { type: 'number', int: true, min: 0, max: 100 },
    } },
    /**
     * task-1398: alert delivery routing. Enable flags + a per-channel `levels` filter ONLY; NO credentials here
     * (bot tokens / webhook URLs live in ~/.dexterm/telegram.json and discord.json, 0600, like every other key).
     * `/alerts` is user-only (DENIED_FOR_MODELS) so a model can never redirect your alerts to its own channel.
     */
    alerts: { type: 'object', additional: false, props: {
      channels: { type: 'object', additional: false, props: {
        toast: 'alertChannel', desktop: 'alertChannel',
        telegram: { type: 'object', additional: false, props: { enabled: { type: 'boolean' }, levels: 'alertLevels', chatId: { type: 'string', pattern: '^-?[0-9]{1,19}$' } } },
        discord: 'alertChannel', ntfy: 'alertChannel',
      } },
      /** Deliver a one-line summary of ticket/ask PROPOSALS too (never the ticket itself; off by default). */
      proposals: { type: 'boolean' },
    } },
    scan: { type: 'object', additional: true },
    popups: { type: 'object', additional: false, props: { rain: { type: 'object', additional: false, props: { enabled: { type: 'boolean' }, speedScale: { type: 'number', min: 0, max: 4 }, density: { type: 'number', min: 0, max: 1 } } } } },
    /**
     * The headless PAPER-trading bot (`trenchscope bot`). Strategy knobs only; every field is optional and falls
     * back to the conservative default in packages/cli/src/bot/config.ts. PAPER ONLY: there is no live, arm, key or
     * signer field here, and the bot's module graph cannot reach a signer. `/bot` is user-only (DENIED_FOR_MODELS).
     */
    bot: { type: 'object', additional: false, props: {
      sizeUsd: { type: 'number', min: 1, max: 10_000 },
      slippageBps: { type: 'number', int: true, min: 10, max: 5_000 },
      priorityFeeLamports: { type: 'number', int: true, min: 0, max: 10_000_000 },
      maxEntryImpactPct: { type: 'number', min: 0, max: 100 },
      takeProfitPct: { type: 'number', min: 1, max: 100_000 },
      stopLossPct: { type: 'number', min: 1, max: 100 },
      timeStopMin: { type: 'number', min: 1, max: 10_080 },
      maxOpen: { type: 'number', int: true, min: 1, max: 50 },
      maxEntriesPerHour: { type: 'number', int: true, min: 1, max: 60 },
      reentryCooldownMin: { type: 'number', min: 0, max: 10_080 },
      entry: { type: 'object', additional: false, props: {
        verdict: { type: 'string', enum: ['NO RED FLAGS', 'CAREFUL'] },
        maxRugP: { type: 'number', min: 0, max: 1 },
        minMcapUsd: { type: 'number', min: 0 }, maxMcapUsd: { type: 'number', min: 0 },
        minLiqUsd: { type: 'number', min: 0 },
        minAgeMin: { type: 'number', min: 0 },
        minChg1hPct: { type: 'number', min: -100 }, maxChg1hPct: { type: 'number', min: -100 },
        maxTop10Pct: { type: 'number', min: 0, max: 100 },
      } },
      alerts: { type: 'object', additional: false, props: { entries: { type: 'boolean' }, exits: { type: 'boolean' } } },
    } },
    /** Forward-compat bag: unknown sections from a newer trenchscope survive a downgrade here. */
    'x-unknown': { type: 'object', additional: true },
  } },
  capability: { type: 'string', enum: [
    'rows.read', 'token.read', 'candles.read', 'holders.read', 'watchlist.read', 'alerts.read', 'config.read',
    'watchlist.annotate', 'alerts.propose', 'ticket.propose', 'ask.propose',
    'net.fetch', 'storage.kv', 'ui.column', 'ui.panel', 'ui.toast', 'ui.popup',
  ] },
  widgetManifest: { type: 'object', additional: false, required: ['name', 'version', 'api', 'widgets'], props: {
    name: { type: 'string', pattern: NAME }, version: { type: 'string', pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$' },
    api: { type: 'number', int: true, min: 1, max: 1 },
    description: { type: 'string', max: 200 },
    /** A popup widget is DATA (an html page served by the popup host under its own id) + a view-model contract; never an entry script the terminal runs. */
    widgets: { type: 'array', max: 8, items: { type: 'object', additional: false, required: ['id', 'title', 'page', 'topics'], props: {
      id: { type: 'string', pattern: NAME }, title: { type: 'string', max: 30 },
      page: { type: 'string', pattern: '^[a-z0-9-]+\\.html$' },
      topics: { type: 'array', max: 6, items: { type: 'string', enum: WIDGET_TOPICS } },
      min: { type: 'object', additional: false, props: { w: { type: 'number', int: true, min: 1 }, h: { type: 'number', int: true, min: 1 } } },
    } } },
  } },
  packManifest: { type: 'object', additional: false, required: ['name', 'version', 'publisher', 'contents'], props: {
    name: { type: 'string', pattern: NAME }, version: { type: 'string', pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$' },
    publisher: { type: 'string', max: 80 }, description: { type: 'string', max: 300 },
    requires: { type: 'object', additional: false, props: { dexterm: { type: 'string', max: 20 }, api: { type: 'number', int: true } } },
    contents: { type: 'object', additional: false, props: {
      workspaces: { type: 'array', max: 10, items: { type: 'string', pattern: '^[a-z0-9/_-]+\\.json$' } },
      themes: { type: 'array', max: 10, items: { type: 'string', pattern: '^[a-z0-9/_-]+\\.json$' } },
      rules: { type: 'array', max: 10, items: { type: 'string', pattern: '^[a-z0-9/_-]+\\.(rules|json)$' } },
      keymap: { type: 'string', pattern: '^[a-z0-9/_-]+\\.json$' },
      widgets: { type: 'array', max: 10, items: { type: 'string', pattern: '^[a-z0-9/_-]+$' } },
    } },
  } },
};

// ------------------------------------------------------------------ typed config
export type Intensity = 'off' | 'normal' | 'fever';
export type Hex = string;
export interface UserTheme { name?: string; extends: (typeof BASE_THEMES)[number]; tokens?: Record<string, Hex | Hex[]> }
export interface KeymapConfig { global?: Record<string, string[]>; screens?: Record<string, Record<string, string[]>> }
export interface RuleJson {
  id: string; name?: string; enabled?: boolean; when: string; for?: string;
  then: Array<{ action: 'alert' | 'ticket' | 'ask' | 'popup' | 'tag' | 'sound' | 'watch'; args?: Record<string, unknown> }>;
  scope?: string; cooldown?: string; maxPerHour?: number; window?: string; source?: string;
}
export interface PackRecord { name: string; version: string; source?: string; hash: string; trust: 'reviewed' | 'signed' | 'unsigned'; publisher?: string; installedAt?: number }
export type AlertDeliveryLevel = 'up' | 'down' | 'info' | 'warn';
export interface AlertChannelConfig { enabled?: boolean; levels?: AlertDeliveryLevel[] }
export interface AlertsConfig {
  channels?: {
    toast?: AlertChannelConfig;
    desktop?: AlertChannelConfig;
    telegram?: AlertChannelConfig & { chatId?: string };
    discord?: AlertChannelConfig;
    ntfy?: AlertChannelConfig;
  };
  proposals?: boolean;
}
/** `config.bot`: the paper bot's strategy knobs (all optional; see packages/cli/src/bot/config.ts for defaults). */
export interface BotSettings {
  sizeUsd?: number; slippageBps?: number; priorityFeeLamports?: number; maxEntryImpactPct?: number;
  takeProfitPct?: number; stopLossPct?: number; timeStopMin?: number;
  maxOpen?: number; maxEntriesPerHour?: number; reentryCooldownMin?: number;
  entry?: {
    verdict?: 'NO RED FLAGS' | 'CAREFUL'; maxRugP?: number; minMcapUsd?: number; maxMcapUsd?: number; minLiqUsd?: number;
    minAgeMin?: number; minChg1hPct?: number; maxChg1hPct?: number; maxTop10Pct?: number;
  };
  alerts?: { entries?: boolean; exits?: boolean };
}
export interface DextermConfig {
  version: number;
  theme?: { name?: string; overrides?: Record<string, Hex | Hex[]>; user?: Record<string, UserTheme> };
  fx?: { intensity?: Intensity; sound?: boolean };
  display?: { priceMode?: PriceMode };
  layout?: { workspace?: string; workspaces?: Record<string, unknown> };
  keymap?: KeymapConfig;
  rules?: RuleJson[];
  plugins?: Record<string, { enabled?: boolean; capabilities?: string[]; settings?: Record<string, unknown> }>;
  packs?: PackRecord[];
  jarvis?: { configAssistant?: boolean; proposalTtlS?: number; gate?: 'keypress' };
  /** JARVIS voice-out preferences (task-1393). `name` is a `say` voice; the resolver falls back safely if it is missing. */
  voice?: { name?: string; rate?: number; pitch?: number };
  /** The analyst engine (0.1.5): the user's own `claude` or `codex` CLI, or `auto` (claude if installed, else codex). */
  analyst?: { engine?: 'auto' | 'claude' | 'codex' };
  /** Alert delivery routing (task-1398). Enable flags + per-channel `levels` filter only; credentials live in ~/.dexterm/*.json. */
  alerts?: AlertsConfig;
  scan?: Record<string, unknown>;
  popups?: { rain?: { enabled?: boolean; speedScale?: number; density?: number } };
  /** The headless PAPER-trading bot's strategy (`trenchscope bot`); defaults in packages/cli/src/bot/config.ts. Paper only. */
  bot?: BotSettings;
  'x-unknown'?: Record<string, unknown>;
}

export function validateConfig(cfg: unknown): SchemaError[] { return validate('config', cfg); }

export function defaultConfig(): DextermConfig {
  return {
    version: CONFIG_VERSION,
    // the shipped look (owner, 2026-10-18): the mono theme, calm, same as the app's own defaults and the site
    theme: { name: 'mono', overrides: {}, user: {} },
    fx: { intensity: 'off', sound: false },
    display: { priceMode: DEFAULT_PRICE_MODE },
    layout: { workspace: 'default', workspaces: {} },
    keymap: { global: {}, screens: {} },
    rules: [],
    plugins: {},
    packs: [],
    jarvis: { configAssistant: true, proposalTtlS: 60 },
    popups: { rain: { enabled: true, speedScale: 1, density: 0.6 } },
  };
}

// ------------------------------------------------------------------ JSON pointer + patch (RFC 6901 / 6902 subset)
export interface PatchOp { op: 'add' | 'replace' | 'remove' | 'test'; path: string; value?: unknown }

export function parsePointer(p: string): string[] {
  if (p === '') return [];
  if (!p.startsWith('/')) throw new Error(`bad pointer ${p}`);
  return p.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}
const esc = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

export function getAt(doc: unknown, pointer: string): unknown {
  let cur: unknown = doc;
  for (const seg of parsePointer(pointer)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (FORBIDDEN_KEYS.has(seg)) return undefined;
    cur = Array.isArray(cur) ? cur[Number(seg)] : (Object.hasOwn(cur, seg) ? (cur as Record<string, unknown>)[seg] : undefined);
  }
  return cur;
}

/**
 * Apply ops to a deep copy; returns { doc, inverse } where `inverse` reverts the change (for undo).
 * Supported: add, replace, remove, test. Throws on a bad op; nothing is partially applied.
 */
export function applyOps<T>(doc: T, ops: PatchOp[]): { doc: T; inverse: PatchOp[] } {
  const out = structuredClone(doc);
  const inverse: PatchOp[] = [];
  for (const op of ops) {
    const segs = parsePointer(op.path);
    if (segs.some((s) => FORBIDDEN_KEYS.has(s))) throw new Error(`forbidden segment in ${op.path}`);
    if (op.op === 'test') { if (JSON.stringify(getAt(out, op.path)) !== JSON.stringify(op.value)) throw new Error(`test failed at ${op.path}`); continue; }
    if (segs.length === 0) throw new Error('root ops are not allowed');
    const parentPath = '/' + segs.slice(0, -1).map(esc).join('/');
    const parent = (segs.length === 1 ? out : getAt(out, parentPath)) as unknown;
    const key = segs[segs.length - 1];
    if (parent === undefined || parent === null || typeof parent !== 'object') throw new Error(`no parent for ${op.path}`);
    if (Array.isArray(parent)) {
      const idx = key === '-' ? parent.length : Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) throw new Error(`bad index ${op.path}`);
      if (op.op === 'add') { parent.splice(idx, 0, structuredClone(op.value)); inverse.unshift({ op: 'remove', path: `${parentPath}/${idx}` }); }
      else if (op.op === 'replace') { if (idx >= parent.length) throw new Error(`replace past end ${op.path}`); inverse.unshift({ op: 'replace', path: op.path, value: structuredClone(parent[idx]) }); parent[idx] = structuredClone(op.value); }
      else if (op.op === 'remove') { if (idx >= parent.length) throw new Error(`remove past end ${op.path}`); inverse.unshift({ op: 'add', path: op.path, value: structuredClone(parent[idx]) }); parent.splice(idx, 1); }
      else throw new Error(`unknown op ${String((op as PatchOp).op)}`);
      continue;
    }
    const obj = parent as Record<string, unknown>;
    const had = Object.hasOwn(obj, key);
    if (op.op === 'add' || op.op === 'replace') {
      if (op.op === 'replace' && !had) throw new Error(`replace of missing ${op.path}`);
      inverse.unshift(had ? { op: 'replace', path: op.path, value: structuredClone(obj[key]) } : { op: 'remove', path: op.path });
      obj[key] = structuredClone(op.value);
    } else if (op.op === 'remove') {
      if (!had) throw new Error(`remove of missing ${op.path}`);
      inverse.unshift({ op: 'add', path: op.path, value: structuredClone(obj[key]) });
      delete obj[key];
    } else throw new Error(`unknown op ${String((op as PatchOp).op)}`);
  }
  return { doc: out, inverse };
}

// ------------------------------------------------------------------ actor policy
/**
 * Paths that only the USER (keyboard / editing the file) may change. Jarvis, Claude, plugins, packs and
 * agents get a precise refusal. Money-safety sections are not in the config at all (signer policy file,
 * passphrase-gated); they are listed so an attempt to ADD them is refused by name, not by "unknown key".
 */
export const DENIED_FOR_MODELS: RegExp[] = [
  /^\/signer(\/|$)/, /^\/trading(\/|$)/, /^\/keys(\/|$)/, /^\/caps(\/|$)/, /^\/mandates?(\/|$)/, /^\/wallet(\/|$)/,
  /^\/packs(\/|$)/, /^\/plugins\/[^/]+\/(capabilities|enabled)(\/|$)/, /^\/plugins\/[^/]+$/, /^\/plugins$/,
  /^\/jarvis\/gate(\/|$)/, /^\/jarvis\/configAssistant$/, /^\/voice(\/|$)/, /^\/analyst(\/|$)/, /^\/alerts(\/|$)/, /^\/agents(\/|$)/, /^\/version$/,
  /^\/rules\/(\d+|-)\/then\/(\d+|-)\/args\/(arm|armed|auto|autoArm|confirm|execute|sign|send)(\/|$)/,
  /^\/bot(\/|$)/, // the paper bot's strategy: only the user tunes it
];
/** Keys a model-authored VALUE may never contain at any depth (money/secret-shaped), whatever the path. */
export const DENIED_VALUE_KEYS = /^(arm|armed|auto|autoArm|autoConfirm|execute|sign|send|caps?|mandates?|gate|secret|keys?|apiKey|token|password|passphrase|privateKey|seed)$/i;
export const MAX_OPS_PER_PROPOSAL = 20;

function findDeniedKey(v: unknown, path = ''): string | null {
  if (!v || typeof v !== 'object') return null;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (DENIED_VALUE_KEYS.test(k)) return `${path}/${k}`;
    const hit = findDeniedKey(x, `${path}/${k}`);
    if (hit) return hit;
  }
  return null;
}

export type Actor = 'user' | 'jarvis' | 'claude' | `plugin:${string}` | `pack:${string}` | `agent:${string}`;

/** Policy for a batch of ops from `actor`: non-user actors are refused on denied paths and money-shaped values. */
export function policyCheck(ops: unknown, actor: Actor): SchemaError[] {
  const errors: SchemaError[] = [];
  if (!Array.isArray(ops) || ops.length === 0) { errors.push({ path: '', msg: 'no ops' }); return errors; }
  if (ops.length > MAX_OPS_PER_PROPOSAL) errors.push({ path: '', msg: `more than ${MAX_OPS_PER_PROPOSAL} ops` });
  for (const raw of ops as unknown[]) {
    const op = raw as Partial<PatchOp> | null;
    if (typeof op?.path !== 'string') { errors.push({ path: '', msg: 'op without path' }); continue; }
    if (!['add', 'replace', 'remove', 'test'].includes(String(op.op))) errors.push({ path: op.path, msg: `op ${String(op.op)} not allowed` });
    if (actor !== 'user') {
      if (DENIED_FOR_MODELS.some((re) => re.test(op.path!))) errors.push({ path: op.path, msg: `only the user may change this (${actor} refused)` });
      const hit = findDeniedKey(op.value);
      if (hit) errors.push({ path: op.path + hit, msg: `only the user may change this (${actor} refused: value carries "${hit.split('/').pop()}")` });
    }
    if (JSON.stringify(op.value ?? null).length > 20_000) errors.push({ path: op.path, msg: 'value too large' });
  }
  return errors;
}

// ------------------------------------------------------------------ migrations
export interface MigrationOut { notes: string[]; extractedKeys: Record<string, string>; from: number; to: number }
type Step = (c: Record<string, unknown>, out: MigrationOut) => Record<string, unknown>;

/**
 * Each step takes the previous shape and returns the next. Steps never touch disk; the loader writes the
 * backup and the extracted key files. `notes` tell the user what changed.
 */
export const MIGRATIONS: Record<number, Step> = {
  // v1 (SPEC §2.2 era sketch): { theme: 'midnight', keys: { helius: '…' }, alerts: [...] }
  1: (c, out) => {
    const next: Record<string, unknown> = { version: 2, theme: { name: typeof c.theme === 'string' ? c.theme : 'cyberspace', overrides: (c.themeOverrides as object) ?? {}, user: {} }, alerts: c.alerts ?? [] };
    if (c.keys && typeof c.keys === 'object') {
      // Keys leave the config file for good. The loader writes each to ~/.dexterm/<name>.key (0600).
      for (const [name, value] of Object.entries(c.keys as Record<string, unknown>)) if (typeof value === 'string' && value && /^[a-z][a-z0-9-]{0,30}$/.test(name)) out.extractedKeys[name] = value;
      out.notes.push(`moved ${Object.keys(out.extractedKeys).length} key(s) out of config.json into ~/.dexterm/<name>.key (0600); config.json no longer holds secrets`);
    }
    for (const k of Object.keys(c)) if (!['theme', 'themeOverrides', 'keys', 'alerts', 'version'].includes(k)) ((next['x-unknown'] ??= {}) as Record<string, unknown>)[k] = c[k];
    return next;
  },
  // v2 → v3: flat alert rules {kind, op, value, mint} become rules-engine rules.
  2: (c, out) => {
    const alerts = Array.isArray(c.alerts) ? (c.alerts as Array<Record<string, unknown>>) : [];
    const rules = alerts.map((a, i) => ({
      id: `alert-${i + 1}`, name: `${a.kind} ${a.op} ${a.value}`, enabled: a.status !== 'dismissed',
      when: `${a.kind} ${a.op} ${a.value}`, then: [{ action: 'alert' as const, args: { text: `${a.kind} ${a.op} ${a.value}` } }],
      scope: typeof a.mint === 'string' ? `mint:${a.mint}` : 'watchlist', cooldown: '10m', source: 'user',
    }));
    if (rules.length) out.notes.push(`converted ${rules.length} alert(s) into rules (edit them on the Rules screen)`);
    const next: Record<string, unknown> = { ...defaultConfig(), version: 3, theme: c.theme ?? defaultConfig().theme, rules };
    delete next.display; // added by the v3 → v4 step, like every later section
    if (c['x-unknown']) next['x-unknown'] = c['x-unknown'];
    return next;
  },
  // v3 → v4 (task-1366): a `display` section with the price display mode. Nothing else changes; an existing
  // `display` (hand-written into a v3 file) is kept when it is valid, otherwise the default is used.
  3: (c, out) => {
    const prior = (c.display && typeof c.display === 'object' ? (c.display as Record<string, unknown>).priceMode : undefined);
    const priceMode = (PRICE_MODES as readonly unknown[]).includes(prior) ? (prior as PriceMode) : DEFAULT_PRICE_MODE;
    out.notes.push(`added display.priceMode = ${priceMode} (press $ in the app to show market cap instead of price)`);
    return { ...c, version: 4, display: { priceMode } };
  },
};

export function migrate(raw: unknown): { config: DextermConfig; errors: SchemaError[] } & MigrationOut {
  const out: MigrationOut = { notes: [], extractedKeys: {}, from: Number((raw as { version?: unknown })?.version ?? 1), to: CONFIG_VERSION };
  let cur: Record<string, unknown> = raw && typeof raw === 'object' ? structuredClone(raw as Record<string, unknown>) : {};
  let v = out.from;
  if (!Number.isInteger(v) || v < 1) v = 1;
  if (v > CONFIG_VERSION) throw new Error(`config version ${v} is newer than this trenchscope (${CONFIG_VERSION}); upgrade trenchscope or restore config.json.bak`);
  while (v < CONFIG_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`no migration from v${v}`);
    cur = step(cur, out);
    v = Number(cur.version);
  }
  const errors = validateConfig(cur);
  return { config: cur as unknown as DextermConfig, errors, ...out };
}
