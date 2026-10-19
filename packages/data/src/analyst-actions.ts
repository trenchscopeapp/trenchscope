// @dexterm/data — analyst UI-action channel (task-1313 part C).
//
// The analyst (a local `claude -p` run) can drive non-financial app navigation through a small,
// strictly-validated action set. The MCP server (the only thing claude can call) validates an action
// against the screen context it was given and, on success, appends one line to a local, token-
// authenticated channel file. The running TUI tails that file and RE-validates every action against
// its *current* state before applying it, then shows "analyst did X".
//
// Trust model: all token-derived text (symbols, names, descriptions) is untrusted. An injected
// instruction that convinces the model to call `open_token EVILMINT` cannot act, because a mint is
// only accepted when it is already in the caller-supplied allow-list (what is on screen / watched).
// Nothing here can sign, send, size, or confirm a trade: `open_ticket` only *opens* the PAPER ticket.
//
// This module is pure and zero-dependency so both the MCP server and the CLI import the same
// validator and the same channel format.

export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Env var the MCP server reads for the channel file path; set by the CLI when it spawns claude. */
export const ACTION_FILE_ENV = 'DEXTERM_ACTION_FILE';
/** Env var carrying the per-run random token that authenticates channel lines. */
export const ACTION_TOKEN_ENV = 'DEXTERM_ACTION_TOKEN';

/**
 * The non-financial UI actions the analyst may request (task-1313, extended in task-1413).
 *
 * Two tiers (see `ACTION_TIER`):
 *  - `view`   — local, reversible runtime changes applied immediately with an "analyst did X" note.
 *  - `config` — a persisted change to `config.json`. It is NOT applied by the model; the consumer turns
 *               it into a one-line PROPOSAL the user accepts with a keypress, then writes it through the
 *               journaled config path (`applyAndJournal`, actor `analyst`, so `ctrl+z` undoes it).
 *
 * FORBIDDEN forever (task-1413 tier c): there is deliberately NO action kind that touches wallets, keys,
 * credentials, alert-channel secrets, signing/arming/caps/mandates, trade tickets beyond the existing
 * PAPER `open_ticket`, network/RPC settings, or software install/update. Such a request fails here as an
 * "unknown action type". The journaled config paths a `config` action may write are a closed list
 * (`CONFIG_ACTION_PATHS`), AND the consumer re-runs `policyCheck(..., non-user actor)` on the journal op, so
 * no `config` action may ever write a `DENIED_FOR_MODELS` path — none of the paths below is denied or a
 * money/secret path.
 *
 * NOTE (task-1413 r2): voice rate / voice name are NOT analyst actions. `/voice` is `DENIED_FOR_MODELS`
 * ("only the keyboard sets it", schema.ts), and the gate stays the gate: a model may never write it, even
 * behind a keypress proposal. The analyst still EXPLAINS how to change the voice (app-help: edit config.json
 * or the `,` key); it just cannot write it. Re-enabling it would need a maintainer-approved DENIED_FOR_MODELS carve-out.
 */
export const ANALYST_ACTION_TYPES = [
  // task-1313 (unchanged):
  'open_token', 'show_in_screener', 'add_to_watchlist', 'switch_feed', 'open_ticket',
  // task-1413 view-only:
  'switch_screen', 'switch_workspace', 'chart_popup', 'toggle_calm', 'set_scan', 'export_view',
  // task-1413 persisted config (user-confirmed, journaled; non-denied display paths only):
  'set_theme', 'set_price_mode', 'set_intensity',
] as const;
export type AnalystActionType = (typeof ANALYST_ACTION_TYPES)[number];

/** Tier of each action: `view` = immediate runtime, `config` = persisted via a user-confirmed journal write. */
export const ACTION_TIER: Record<AnalystActionType, 'view' | 'config'> = {
  open_token: 'view', show_in_screener: 'view', add_to_watchlist: 'view', switch_feed: 'view', open_ticket: 'view',
  switch_screen: 'view', switch_workspace: 'view', chart_popup: 'view', toggle_calm: 'view', set_scan: 'view', export_view: 'view',
  set_theme: 'config', set_price_mode: 'config', set_intensity: 'config',
};

/**
 * The exact `config.json` JSON-Pointer each `config` action writes — a closed allow-list. Every path here
 * is a local, reversible, non-financial DISPLAY setting and NONE is a `DENIED_FOR_MODELS` path (the journal
 * write re-checks that with `policyCheck`). NOTHING here is matched by `DENIED_VALUE_KEYS` / the money-safety
 * sections; the consumer additionally confirms each with a keypress.
 */
export const CONFIG_ACTION_PATHS: Record<string, string> = {
  set_theme: '/theme/name',
  set_price_mode: '/display/priceMode',
  set_intensity: '/fx/intensity',
};

export type SortDir = 'asc' | 'desc';
export type PriceMode = 'price' | 'mcap';
export type Intensity = 'off' | 'normal' | 'fever';

export type AnalystAction =
  | { type: 'open_token'; mint: string }
  | { type: 'show_in_screener'; filter?: string; sort?: { key: string; dir: SortDir }; highlight?: string; preset?: string }
  | { type: 'add_to_watchlist'; mint: string }
  | { type: 'switch_feed'; feed: string }
  | { type: 'open_ticket'; mint: string; side: 'buy' | 'sell' }
  | { type: 'switch_screen'; screen: string }
  | { type: 'switch_workspace'; name: string }
  | { type: 'chart_popup'; open: boolean }
  | { type: 'toggle_calm'; on: boolean }
  | { type: 'set_scan'; on: boolean }
  | { type: 'export_view' }
  | { type: 'set_theme'; name: string }
  | { type: 'set_price_mode'; mode: PriceMode }
  | { type: 'set_intensity'; intensity: Intensity };

/** What the caller currently permits: the only mints/feeds/sorts/screens/etc. an action may reference. */
export interface ActionAllow {
  /** Mints already on screen / watched / selected — the only mints an action may point at. */
  mints: readonly string[];
  /** Feed ids `switch_feed` / `show_in_screener`'s preset may select (the presets available right now). */
  feeds: readonly string[];
  /** Sort keys `show_in_screener` may use. */
  sortKeys: readonly string[];
  /** Screen keys `switch_screen` may select. */
  screens?: readonly string[];
  /** Workspace names `switch_workspace` may select. */
  workspaces?: readonly string[];
  /** Theme names `set_theme` may select (built-ins + the user's own). */
  themes?: readonly string[];
  /**
   * Action types this session may request (task-1324). Absent = every type above (the task-1313
   * behaviour). AI scan mode passes `[]`: an observe-only session can request NO UI action at all —
   * above all never `open_ticket` — whatever the model emits.
   */
  types?: readonly AnalystActionType[];
}

export type ActionResult = { ok: true; action: AnalystAction; label: string } | { ok: false; error: string };

/** Max actions the consumer should apply per rolling window, and the window length. Advisory shared constants. */
export const ACTION_RATE = { max: 6, windowMs: 10_000 } as const;

const FILTER_MAX = 120;
// A conservative charset for a screener filter string; the consumer re-parses it with the real grammar.
// `!` is included so tag negation (`!flag:mint`, `!launchpad:pump`) — a documented part of the grammar —
// survives the boundary instead of being rejected as malformed (task-1313 part E).
const FILTER_SAFE_RE = /^[\w\s<>=:.%$,+!\-|()]*$/;

// task-1413 value shapes. The consumer re-validates against config schema (`validateConfig`) too.
const THEME_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/; // mirrors schema.ts NAME
const PRICE_MODES: readonly string[] = ['price', 'mcap'];
const INTENSITIES: readonly string[] = ['off', 'normal', 'fever'];

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Validate one requested action against `allow`. Strict: unknown types/fields, out-of-allow-list
 * mints/feeds/sorts, and malformed values are all rejected. Pure — no I/O, no state.
 */
export function validateAnalystAction(raw: unknown, allow: ActionAllow): ActionResult {
  if (!isObj(raw)) return { ok: false, error: 'action must be an object' };
  const type = raw.type;
  if (typeof type !== 'string' || !(ANALYST_ACTION_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: `unknown action type ${JSON.stringify(type)}` };
  }
  if (allow.types && !allow.types.includes(type as AnalystActionType)) {
    return { ok: false, error: `${type}: not allowed in this session (allowed: ${allow.types.join(', ') || 'none — observe-only'})` };
  }
  const mintOk = (m: unknown): m is string => typeof m === 'string' && BASE58_RE.test(m) && allow.mints.includes(m);
  const short = (m: string): string => m.slice(0, 4) + '…' + m.slice(-4);

  switch (type) {
    case 'open_token': {
      if (!mintOk(raw.mint)) return { ok: false, error: 'open_token: mint not among the tokens currently on screen' };
      return { ok: true, action: { type, mint: raw.mint }, label: `opened ${short(raw.mint)}` };
    }
    case 'add_to_watchlist': {
      if (!mintOk(raw.mint)) return { ok: false, error: 'add_to_watchlist: mint not among the tokens currently on screen' };
      return { ok: true, action: { type, mint: raw.mint }, label: `watchlisted ${short(raw.mint)}` };
    }
    case 'open_ticket': {
      if (!mintOk(raw.mint)) return { ok: false, error: 'open_ticket: mint not among the tokens currently on screen' };
      if (raw.side !== 'buy' && raw.side !== 'sell') return { ok: false, error: 'open_ticket: side must be "buy" or "sell"' };
      return { ok: true, action: { type, mint: raw.mint, side: raw.side }, label: `opened a PAPER ${raw.side} ticket for ${short(raw.mint)}` };
    }
    case 'switch_feed': {
      if (typeof raw.feed !== 'string' || !allow.feeds.includes(raw.feed)) {
        return { ok: false, error: `switch_feed: feed must be one of ${allow.feeds.join(', ') || '(none)'}` };
      }
      return { ok: true, action: { type, feed: raw.feed }, label: `switched the screener to "${raw.feed}"` };
    }
    case 'show_in_screener': {
      const out: Extract<AnalystAction, { type: 'show_in_screener' }> = { type };
      const bits: string[] = [];
      if (raw.filter !== undefined && raw.filter !== null && raw.filter !== '') {
        if (typeof raw.filter !== 'string' || raw.filter.length > FILTER_MAX || !FILTER_SAFE_RE.test(raw.filter)) {
          return { ok: false, error: 'show_in_screener: filter is malformed or too long' };
        }
        out.filter = raw.filter.trim();
        bits.push(`filter ${out.filter}`);
      }
      if (raw.sort !== undefined && raw.sort !== null) {
        if (!isObj(raw.sort) || typeof raw.sort.key !== 'string' || !allow.sortKeys.includes(raw.sort.key)) {
          return { ok: false, error: `show_in_screener: sort.key must be one of ${allow.sortKeys.join(', ')}` };
        }
        const dir: SortDir = raw.sort.dir === 'asc' ? 'asc' : 'desc';
        out.sort = { key: raw.sort.key, dir };
        bits.push(`sort ${out.sort.key} ${dir}`);
      }
      if (raw.highlight !== undefined && raw.highlight !== null && raw.highlight !== '') {
        if (!mintOk(raw.highlight)) return { ok: false, error: 'show_in_screener: highlight mint not among the tokens currently on screen' };
        out.highlight = raw.highlight;
        bits.push(`highlight ${short(raw.highlight)}`);
      }
      if (raw.preset !== undefined && raw.preset !== null && raw.preset !== '') {
        if (typeof raw.preset !== 'string' || !allow.feeds.includes(raw.preset)) {
          return { ok: false, error: `show_in_screener: preset must be one of ${allow.feeds.join(', ') || '(none)'}` };
        }
        out.preset = raw.preset;
        bits.push(`preset ${out.preset}`);
      }
      if (!bits.length) return { ok: false, error: 'show_in_screener: nothing to do (give filter, sort, preset, or highlight)' };
      return { ok: true, action: out, label: `showed the screener (${bits.join(', ')})` };
    }
    case 'switch_screen': {
      const screens = allow.screens ?? [];
      if (typeof raw.screen !== 'string' || !screens.includes(raw.screen)) {
        return { ok: false, error: `switch_screen: screen must be one of ${screens.join(', ') || '(none)'}` };
      }
      return { ok: true, action: { type, screen: raw.screen }, label: `switched to the ${raw.screen} screen` };
    }
    case 'switch_workspace': {
      const workspaces = allow.workspaces ?? [];
      if (typeof raw.name !== 'string' || !workspaces.includes(raw.name)) {
        return { ok: false, error: `switch_workspace: name must be one of ${workspaces.join(', ') || '(none)'}` };
      }
      return { ok: true, action: { type, name: raw.name }, label: `opened the "${raw.name}" workspace` };
    }
    case 'chart_popup': {
      if (typeof raw.open !== 'boolean') return { ok: false, error: 'chart_popup: open must be true or false' };
      return { ok: true, action: { type, open: raw.open }, label: raw.open ? 'opened the chart popup' : 'closed the chart popup' };
    }
    case 'toggle_calm': {
      if (typeof raw.on !== 'boolean') return { ok: false, error: 'toggle_calm: on must be true or false' };
      return { ok: true, action: { type, on: raw.on }, label: raw.on ? 'turned on calm mode' : 'turned off calm mode' };
    }
    case 'set_scan': {
      if (typeof raw.on !== 'boolean') return { ok: false, error: 'set_scan: on must be true or false' };
      return { ok: true, action: { type, on: raw.on }, label: raw.on ? 'turned scan mode on' : 'turned scan mode off' };
    }
    case 'export_view': {
      return { ok: true, action: { type }, label: 'exported the current view' };
    }
    case 'set_theme': {
      if (typeof raw.name !== 'string' || !THEME_NAME_RE.test(raw.name)) return { ok: false, error: 'set_theme: invalid theme name' };
      const themes = allow.themes ?? [];
      if (!themes.includes(raw.name)) return { ok: false, error: `set_theme: theme must be one of ${themes.join(', ') || '(none)'}` };
      return { ok: true, action: { type, name: raw.name }, label: `set the theme to ${raw.name}` };
    }
    case 'set_price_mode': {
      if (raw.mode !== 'price' && raw.mode !== 'mcap') return { ok: false, error: `set_price_mode: mode must be one of ${PRICE_MODES.join(', ')}` };
      return { ok: true, action: { type, mode: raw.mode }, label: `set the price display to ${raw.mode === 'mcap' ? 'market cap' : 'price'}` };
    }
    case 'set_intensity': {
      if (typeof raw.intensity !== 'string' || !INTENSITIES.includes(raw.intensity)) {
        return { ok: false, error: `set_intensity: intensity must be one of ${INTENSITIES.join(', ')}` };
      }
      return { ok: true, action: { type, intensity: raw.intensity as Intensity }, label: `set the visual intensity to ${raw.intensity}` };
    }
    default:
      return { ok: false, error: `unknown action type ${type}` };
  }
}

/**
 * Map a validated `config`-tier action to a `{section, key, value}` descriptor of the `config.json`
 * change it requests. Returns `null` for a `view`-tier action (nothing to persist). Pure and
 * dependency-free: the consumer builds the actual `PatchOp` (creating the parent section when it is
 * absent, exactly like the `trenchscope display` / `,` voice handlers), runs the config schema validator,
 * and writes through `applyAndJournal` (actor `analyst`). `section`/`key` are fixed, never taken from
 * model input — only `value` comes from the (already-validated) action.
 */
export function configChangeForAction(action: AnalystAction): { section: string; key: string; value: unknown; path: string } | null {
  const at = (path: string, value: unknown) => {
    const [, section, key] = path.split('/');
    return { section, key, value, path };
  };
  switch (action.type) {
    case 'set_theme': return at(CONFIG_ACTION_PATHS.set_theme, action.name);
    case 'set_price_mode': return at(CONFIG_ACTION_PATHS.set_price_mode, action.mode);
    case 'set_intensity': return at(CONFIG_ACTION_PATHS.set_intensity, action.intensity);
    default: return null;
  }
}

/** One line on the channel: version + auth token + monotonic seq + the requested (unvalidated) action. */
export interface ActionLine { v: 1; token: string; seq: number; ts: number; action: Record<string, unknown> }

/** Serialize a channel line (newline-terminated). */
export function serializeActionLine(token: string, seq: number, action: Record<string, unknown>): string {
  const line: ActionLine = { v: 1, token, seq, ts: Date.now(), action };
  return JSON.stringify(line) + '\n';
}

/**
 * Parse and authenticate one channel line. Returns the (still unvalidated) requested action only when
 * the line is well-formed and its token matches `expectedToken`; otherwise null. Validation against an
 * allow-list is a separate step (`validateAnalystAction`) the consumer must still run.
 */
export function parseActionLine(line: string, expectedToken: string): { seq: number; action: Record<string, unknown> } | null {
  const s = line.trim();
  if (!s) return null;
  let msg: unknown;
  try { msg = JSON.parse(s); } catch { return null; }
  if (!isObj(msg) || msg.v !== 1) return null;
  if (typeof msg.token !== 'string' || msg.token !== expectedToken) return null;
  if (typeof msg.seq !== 'number' || !isObj(msg.action)) return null;
  return { seq: msg.seq, action: msg.action };
}
