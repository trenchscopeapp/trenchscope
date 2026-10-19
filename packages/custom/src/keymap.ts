// @dexterm/custom — keymap overrides (task-1358 Tier 2). `config.keymap.global[action] = keys[]` and
// `config.keymap.screens[screen][action] = keys[]` re-bind the app's actions (the AppAction ids of
// @dexterm/tui) over the shipped defaults. Validation refuses what a shared config must never do:
//   * RESERVED KEYS cannot be assigned to anything: ctrl+c (quit), esc, enter, y / Y (confirm), ! (panic);
//   * RESERVED ACTIONS keep their default keys: quit, back, alert.confirm / alert.dismiss, plans.arm,
//     plans.panic, plans.gate (the money-adjacent confirms and the panic key);
//   * no two actions on the same key within one scope (global, or one screen); a global key may still be
//     shadowed by a screen binding, as the defaults already do;
//   * a chord prefix (the first key of "ctrl+w s") cannot also be bound on its own;
//   * at most 4 keys per action, every key a valid id (the KEY pattern in schema.ts).
// Pure: takes the default binding table, returns a new one plus the errors. Nothing here reads a file.
import { validate, type KeymapConfig, type SchemaError } from './schema.ts';

export interface BindingLike<A extends string = string> { keys: string[]; action: A; label?: string; screen?: string }

export const RESERVED_KEYS = new Set(['ctrl+c', 'esc', 'enter', 'y', 'Y', '!']);
export const RESERVED_ACTIONS = new Set(['quit', 'back', 'alert.confirm', 'alert.dismiss', 'plans.arm', 'plans.panic', 'plans.gate']);

export interface KeymapResult<A extends string = string> {
  bindings: BindingLike<A>[];
  errors: SchemaError[];
  /** Actions whose keys differ from the defaults (for the `?` overlay's `·` marker and `trenchscope keymap`). */
  overridden: Array<{ action: A; screen: string | null; keys: string[] }>;
}

/**
 * Layer `cfg` over `defaults`. On ANY error the defaults are returned untouched (a half-applied keymap is worse
 * than none) with every problem listed, so the user fixes the file once.
 */
export function applyKeymapConfig<A extends string>(defaults: readonly BindingLike<A>[], cfg: KeymapConfig | undefined): KeymapResult<A> {
  const errors = cfg ? validate('keymap', cfg, '/keymap') : [];
  const overridden: KeymapResult<A>['overridden'] = [];
  if (!cfg || errors.length) return { bindings: defaults.map((b) => ({ ...b, keys: [...b.keys] })), errors, overridden };
  const bindings = defaults.map((b) => ({ ...b, keys: [...b.keys] }));
  const known = new Set(defaults.map((b) => b.action as string));
  const globalLabel = new Map<string, string | undefined>();
  for (const b of defaults) if (!b.screen) globalLabel.set(b.action, b.label);
  const apply = (screen: string | null, action: string, keys: string[]): void => {
    const where = screen ? `/keymap/screens/${screen}/${action}` : `/keymap/global/${action}`;
    if (!known.has(action)) { errors.push({ path: where, msg: `unknown action "${action}"` }); return; }
    if (RESERVED_ACTIONS.has(action)) { errors.push({ path: where, msg: `"${action}" keeps its default keys (reserved: confirm / dismiss / panic / quit / back)` }); return; }
    for (const k of keys) {
      const parts = k.split(' ');
      if (parts.some((p) => RESERVED_KEYS.has(p)) && !(parts.length === 2 && !RESERVED_KEYS.has(parts[0]))) { errors.push({ path: where, msg: `"${k}" is reserved (${[...RESERVED_KEYS].join(' ')})` }); return; }
    }
    const i = bindings.findIndex((b) => b.action === action && (screen ? b.screen === screen : !b.screen));
    if (i >= 0) bindings[i] = { ...bindings[i], keys: [...keys] };
    else bindings.push({ keys: [...keys], action: action as A, label: globalLabel.get(action) ?? defaults.find((b) => b.action === action)?.label, screen: screen ?? undefined });
    overridden.push({ action: action as A, screen, keys: [...keys] });
  };
  for (const [action, keys] of Object.entries(cfg.global ?? {})) apply(null, action, keys);
  for (const [screen, table] of Object.entries(cfg.screens ?? {})) {
    if (!/^[a-z]+$/.test(screen)) { errors.push({ path: `/keymap/screens/${screen}`, msg: 'bad screen name' }); continue; }
    for (const [action, keys] of Object.entries(table)) apply(screen, action, keys);
  }
  if (!errors.length) errors.push(...collisions(bindings));
  if (errors.length) return { bindings: defaults.map((b) => ({ ...b, keys: [...b.keys] })), errors, overridden: [] };
  return { bindings, errors: [], overridden };
}

/** Two actions on one key within the same scope, or a chord prefix bound on its own. */
export function collisions<A extends string>(bindings: readonly BindingLike<A>[]): SchemaError[] {
  const errors: SchemaError[] = [];
  const byScope = new Map<string, Map<string, string>>();
  const prefixes = new Set<string>();
  for (const b of bindings) for (const k of b.keys) { const sp = k.indexOf(' '); if (sp > 0) prefixes.add(k.slice(0, sp)); }
  for (const b of bindings) {
    const scope = b.screen ?? '';
    let m = byScope.get(scope);
    if (!m) { m = new Map(); byScope.set(scope, m); }
    for (const k of b.keys) {
      const other = m.get(k);
      if (other && other !== b.action) errors.push({ path: scope ? `/keymap/screens/${scope}` : '/keymap/global', msg: `"${k}" is bound to both ${other} and ${b.action}` });
      m.set(k, b.action);
      if (prefixes.has(k)) errors.push({ path: scope ? `/keymap/screens/${scope}` : '/keymap/global', msg: `"${k}" starts a chord and cannot also be bound alone (${b.action})` });
    }
  }
  return errors;
}

/** `trenchscope keymap`: one line per binding, user overrides marked with `·`. */
export function renderKeymap<A extends string>(r: KeymapResult<A>, screen?: string): string {
  const ov = new Set(r.overridden.map((o) => `${o.screen ?? ''}|${o.action}`));
  const rows = r.bindings.filter((b) => !screen || !b.screen || b.screen === screen);
  const lines = rows.map((b) => `${ov.has(`${b.screen ?? ''}|${b.action}`) ? '·' : ' '} ${(b.screen ?? 'global').padEnd(10)} ${b.action.padEnd(22)} ${b.keys.join(' / ').padEnd(24)} ${b.label ?? ''}`);
  if (r.errors.length) lines.unshift(...r.errors.map((e) => `✗ ${e.path} ${e.msg}`), '  (keymap config refused: the defaults are in use)');
  return lines.join('\n');
}
