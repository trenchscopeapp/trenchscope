// @dexterm/custom — the rules engine (task-1358 Tier 3, ported from the task-1288 prototype `rules/engine.mjs`).
//
//   rule := [when] cond [for <n> ticks|<n>s|<n>m] then action+ [cooldown <dur>] [max <n>/h] [scope <s>] [window <dur>] [name "<s>"]
//
// The condition grammar extends the screener filter grammar (clauses, tags, K/M/B, %, durations) with and / or /
// not, parentheses and two derived signals over a per-mint ring of observations: `<field>.velocity` (current ÷
// the mean of the earlier samples in the window) and `<field>.delta` (current − the oldest sample). Text is
// PARSED into a small AST and never eval'd. The engine is pure: the app feeds observe()/evaluate() rows and a
// clock; the outputs are events the app surfaces (toasts, the Rules screen log, proposal cards).
//
// MONEY-SAFETY INVARIANT (asserted by the compromised-rule suite): a rule can only produce alerts, annotations
// (watch/tag), UI actions (popup/sound) and PROPOSALS. A `ticket` or `ask` action yields
// { status: 'proposal', requiresKeypress: true, armedBy: null }; there is no action that arms, signs, raises a cap,
// touches a mandate or opens a live ticket, and action args cannot smuggle one in (`normalizeAction` drops
// everything the grammar does not name and refuses money-shaped keys by name). Rate limits are mandatory: every
// rule has a cooldown per (rule, mint) and a max/h per rule, the latter capped at MAX_PER_HOUR_CAP.
import type { RuleJson } from './schema.ts';

/** The row fields a rule can read. @dexterm/cli's ScreenerRow is structurally compatible; `cluster` is the top linked-cluster share from wallet intel (null = unknown → clauses on it are false). */
export interface RuleRow {
  mint: string;
  symbol: string;
  skeleton?: boolean;
  price?: number | null; mcap?: number | null; fdv?: number | null; liq?: number | null;
  vol5m?: number | null; vol1h?: number | null; vol24?: number | null;
  holders?: number | null; org?: number | null; top10?: number | null; dev?: number | null;
  lpLocked?: number | null; bundled?: number | null; snipers?: number | null;
  cluster?: number | null;
  /**
   * task-1404 LIVE holder/rug signals as alert triggers. These come from the live-signals engine for the open
   * token (and watched coins): `fresh` = fresh-at-buy wallets % of the top sample; `mintable` / `freezable` are
   * 1 when a mint / freeze authority is present (new supply can be minted / transfers can be frozen), 0 when
   * revoked, null when unknown. A change is caught with `.delta` (e.g. `dev.delta < 0` = dev sold, `top10.delta`,
   * `lplocked.delta < 0`, `mintable.delta > 0` = authority re-enabled). The engine's per-mint ring gives these
   * fields the same `.delta` / `.velocity` as any other field, so no new engine machinery is needed.
   */
  fresh?: number | null; mintable?: number | null; freezable?: number | null;
  /** LARP-detector grade (task-1398): higher = more real (REAL_PRODUCT 3 · EARLY_BUT_REAL 2 · NO_PRODUCT_CLAIMED 1 · UNVERIFIABLE 1 · LARP 0); null = no verdict yet. `larp.delta` detects a grade change. */
  larp?: number | null;
  /**
   * 0.1.5 dev history (task-1425): how many of this coin's creator's prior launches trenchscope recorded as `rug`
   * (keyless-proxy labels, local history). null = unknown (no creator link or nothing labelled) → clauses are false.
   * e.g. `when devrugs >= 2 then alert(warn, "new coin from a wallet that rugged before") scope newpairs`.
   */
  devRugs?: number | null;
  ageMin?: number | null;
  chg?: { m5?: number | null; h1?: number | null; h6?: number | null; h24?: number | null } | null;
  buys?: number | null; sells?: number | null; bonding?: number | null;
  launchpad?: string | null;
  flags?: readonly string[] | null;
  verified?: boolean | null;
  sus?: boolean | null;
}

type FieldFn = (r: RuleRow) => number | null | undefined;
export const FIELDS: Record<string, FieldFn> = {
  price: (r) => r.price, mcap: (r) => r.mcap, fdv: (r) => r.fdv, liq: (r) => r.liq,
  vol5m: (r) => r.vol5m, vol1h: (r) => r.vol1h, vol24: (r) => r.vol24,
  holders: (r) => r.holders, org: (r) => r.org, top10: (r) => r.top10, dev: (r) => r.dev,
  lplocked: (r) => r.lpLocked, bundled: (r) => r.bundled, snipers: (r) => r.snipers,
  cluster: (r) => r.cluster, larp: (r) => r.larp, devrugs: (r) => r.devRugs,
  fresh: (r) => r.fresh, mintable: (r) => r.mintable, freezable: (r) => r.freezable,
  age: (r) => r.ageMin, m5: (r) => r.chg?.m5, h1: (r) => r.chg?.h1, h6: (r) => r.chg?.h6, h24: (r) => r.chg?.h24,
  buys: (r) => r.buys, sells: (r) => r.sells, bonding: (r) => r.bonding,
};
export const FIELD_NAMES = Object.keys(FIELDS);
const ALIASES: Record<string, string> = { vol: 'vol24', volume: 'vol24', liquidity: 'liq', cap: 'mcap', mc: 'mcap', holder: 'holders', organic: 'org', top: 'top10', locked: 'lplocked', 'cluster%': 'cluster', clusterpct: 'cluster', freshwallets: 'fresh', mintauth: 'mintable', freezeauth: 'freezable', devrug: 'devrugs', serialrugger: 'devrugs' };
type Op = '>' | '>=' | '<' | '<=' | '=' | '==' | '!=';
const OPS: Record<Op, (a: number, b: number) => boolean> = { '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b, '=': (a, b) => a === b, '==': (a, b) => a === b, '!=': (a, b) => a !== b };
const TAGS: Record<string, (r: RuleRow, v: string) => boolean> = {
  launchpad: (r, v) => (r.launchpad ?? '').toLowerCase().replace('.fun', '') === v.toLowerCase().replace('.fun', ''),
  flag: (r, v) => (v === 'clean' ? (r.flags ?? []).length === 0 : (r.flags ?? []).map((f) => f.toLowerCase()).includes(v.toLowerCase())),
  verified: (r, v) => (v === 'yes') === !!r.verified,
  sus: (r, v) => (v === 'yes') === !!r.sus,
};
export const TAG_NAMES = Object.keys(TAGS);
export const ACTIONS = ['alert', 'ticket', 'ask', 'popup', 'tag', 'sound', 'watch'] as const;
export type ActionName = (typeof ACTIONS)[number];
export const SCOPES = ['screener', 'watchlist', 'newpairs', 'positions'] as const;
export const ALERT_LEVELS = ['up', 'down', 'info', 'warn'] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];
export const RULE_POPUP_KINDS = ['chart', 'token', 'bubbles', 'narrative', 'plans', 'feeds'] as const;
/** The hard ceiling on fires per hour per rule (the schema says the same); the default is 12. */
export const MAX_PER_HOUR_CAP = 120;
export const DEFAULT_MAX_PER_HOUR = 12;
export const DEFAULT_COOLDOWN = '10m';
export const DEFAULT_WINDOW = '10m';
/** The biggest ticket size a rule may PROPOSE, in its own unit; the real amount is capped signer-side anyway. */
export const TICKET_SIZE_CAP = 50;
const MONEY_KEYS = ['arm', 'armed', 'auto', 'autoarm', 'confirm', 'execute', 'sign', 'send', 'live', 'mandate', 'caps', 'cap', 'gate'];

export type Duration = { ticks: number } | { ms: number };
export function parseDuration(s: string): Duration {
  const m = /^(\d+)\s*(s|m|h|d|ticks?)$/.exec(String(s).trim());
  if (!m) throw new Error(`bad duration "${s}" (n s|m|h|d|ticks)`);
  const n = Number(m[1]);
  if (m[2].startsWith('tick')) return { ticks: n };
  return { ms: n * ({ s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as Record<string, number>)[m[2]] };
}
export function parseNumber(s: string): number | null {
  const m = /^\$?(-?\d+(?:\.\d+)?)\s*(k|m|b|%|s|h|d|w|mo)?$/i.exec(s);
  if (!m) return null;
  let n = Number(m[1]);
  const suf = (m[2] ?? '').toLowerCase();
  if (suf === 'k') n *= 1e3; else if (suf === 'm') n *= 1e6; else if (suf === 'b') n *= 1e9;
  else if (suf === 'h') n *= 60; else if (suf === 'd') n *= 1440; else if (suf === 'w') n *= 10080; else if (suf === 'mo') n *= 43200;
  return n;
}

// ------------------------------------------------------------------ AST
export type Expr =
  | { kind: 'cmp'; field: string; deriv: 'velocity' | 'delta' | null; op: Op; value: number; raw: string }
  | { kind: 'tag'; tag: string; value: string; not: boolean }
  | { kind: 'not'; expr: Expr }
  | { kind: 'and'; left: Expr; right: Expr }
  | { kind: 'or'; left: Expr; right: Expr };

export type RuleAction =
  | { action: 'alert'; args: { level: AlertLevel; text: string } }
  | { action: 'ticket'; args: { side: 'buy' | 'sell'; size: number; unit: 'sol' | 'usd' | 'pct' } }
  | { action: 'ask'; args: { skill: string } }
  | { action: 'popup'; args: { kind: (typeof RULE_POPUP_KINDS)[number] } }
  | { action: 'tag'; args: { label: string } }
  | { action: 'sound'; args: { name: string } }
  | { action: 'watch'; args: Record<string, never> };

export interface ParsedRule {
  when: Expr;
  for: string | null;
  then: RuleAction[];
  cooldown: string;
  maxPerHour: number;
  scope: string;
  window: string;
  name: string | null;
}

// ------------------------------------------------------------------ tokenizer + parser
interface Tok { k: 'str' | 'op' | 'word' | '(' | ')' | ',' | ':' | '!'; v: string; at: number }
function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  // words: fields, keywords, numbers with units ($1.5M, 20%, 2h), base58 mints, skill names. Anything else
  // (backticks, braces, semicolons, pipes…) is refused by position so a rule can never look like shell or code.
  const re = /\s+|("(?:[^"\\]|\\.)*")|(>=|<=|!=|==|>|<|=)|([(),:!])|([A-Za-z0-9_.$%/+-]+)/gy;
  let m: RegExpExecArray | null;
  let pos = 0;
  while ((m = re.exec(src)) !== null) {
    if (!m[0].length) break;
    const at = m.index;
    pos = at + m[0].length;
    if (m[1]) {
      let v: string;
      try { v = JSON.parse(m[1]) as string; } catch { throw new Error(`bad string literal at ${at} (control characters are not allowed)`); }
      if (/[\u0000-\u001f\u007f]/.test(v)) throw new Error(`bad string literal at ${at} (control characters are not allowed)`);
      out.push({ k: 'str', v, at });
    }
    else if (m[2]) out.push({ k: 'op', v: m[2], at });
    else if (m[3]) out.push({ k: m[3] as Tok['k'], v: m[3], at });
    else if (m[4]) out.push({ k: 'word', v: m[4], at });
  }
  if (pos < src.length) throw new Error(`unexpected character "${src[pos]}" at ${pos}`);
  return out;
}

const KEYWORDS = new Set(['and', 'or', 'not', 'then', 'for', 'cooldown', 'max', 'scope', 'window', 'name', 'when']);

/** Parse just a condition (the JSON form stores `when` as text). */
export function parseExpr(text: string): Expr { return parseRule(`when ${text} then watch`).when; }

export function parseRule(text: string): ParsedRule {
  if (typeof text !== 'string') throw new Error('rule text must be a string');
  if (text.length > 400) throw new Error('rule text is longer than 400 characters');
  const toks = tokenize(text);
  let i = 0;
  const peek = (): Tok | undefined => toks[i];
  const next = (): Tok | undefined => toks[i++];
  const isWord = (w: string): boolean => peek()?.k === 'word' && peek()!.v.toLowerCase() === w;

  const parseClause = (): Expr => {
    const t = next();
    if (!t) throw new Error('unexpected end of rule');
    if (t.k === '(') { const e = parseOr(); if (next()?.k !== ')') throw new Error('expected )'); return e; }
    if (t.k === 'word' && t.v.toLowerCase() === 'not') return { kind: 'not', expr: parseClause() };
    let not = false;
    let w: Tok | undefined = t;
    if (t.k === '!') { not = true; w = next(); }
    if (!w || w.k !== 'word') throw new Error(`expected a field at ${t.at}`);
    if (peek()?.k === ':') {
      next();
      const v = next();
      if (!v || v.k !== 'word') throw new Error(`expected a tag value at ${w.at}`);
      const tag = w.v.toLowerCase();
      // r4: an OWN-property lookup — `__proto__:x` / `constructor:x` used to resolve to Object.prototype members (an
      // always-true "tag" that persisted enabled, then a TypeError in evaluate() that took the whole rules tick down)
      if (!Object.hasOwn(TAGS, tag)) throw new Error(`unknown tag "${tag}" (${TAG_NAMES.join(' | ')})`);
      if (!/^[a-z0-9.-]{1,24}$/i.test(v.v)) throw new Error(`bad tag value "${v.v}"`);
      return { kind: 'tag', tag, value: v.v, not };
    }
    const op = next();
    if (!op || op.k !== 'op') throw new Error(`expected an operator after "${w.v}" at ${w.at}`);
    const val = next();
    if (!val || val.k !== 'word') throw new Error(`expected a value after "${op.v}"`);
    const n = parseNumber(val.v);
    if (n === null || !Number.isFinite(n)) throw new Error(`bad number "${val.v}"`);
    const [base, deriv, extra] = w.v.toLowerCase().split('.');
    // r4: own properties only — `__proto__ > 1` used to parse (inherited lookup) and crash the evaluator at run time
    const field = Object.hasOwn(FIELDS, base) ? base : Object.hasOwn(ALIASES, base) ? ALIASES[base] : undefined;
    if (!field || !Object.hasOwn(FIELDS, field)) throw new Error(`unknown field "${base}"`);
    if (extra !== undefined) throw new Error(`unknown signal "${deriv}.${extra}"`);
    if (deriv && deriv !== 'velocity' && deriv !== 'delta') throw new Error(`unknown signal "${deriv}" (velocity | delta)`);
    const c: Expr = { kind: 'cmp', field, deriv: (deriv as 'velocity' | 'delta' | undefined) ?? null, op: op.v as Op, value: n, raw: `${w.v} ${op.v} ${val.v}` };
    return not ? { kind: 'not', expr: c } : c;
  };
  const parseAnd = (): Expr => { let l = parseClause(); while (isWord('and')) { next(); l = { kind: 'and', left: l, right: parseClause() }; } return l; };
  const parseOr = (): Expr => { let l = parseAnd(); while (isWord('or')) { next(); l = { kind: 'or', left: l, right: parseAnd() }; } return l; };

  const rule: ParsedRule = { when: { kind: 'tag', tag: 'flag', value: 'clean', not: false }, for: null, then: [], cooldown: DEFAULT_COOLDOWN, maxPerHour: DEFAULT_MAX_PER_HOUR, scope: 'screener', window: DEFAULT_WINDOW, name: null };
  if (isWord('when')) next();
  rule.when = parseOr();
  while (peek()) {
    const t = next()!;
    if (t.k !== 'word') throw new Error(`unexpected "${t.v}" at ${t.at}`);
    const kw = t.v.toLowerCase();
    if (kw === 'for') {
      const n = next(); if (!n) throw new Error('for needs a duration');
      let s = n.v;
      const u = peek();
      if (u?.k === 'word' && /^(s|m|h|ticks?)$/.test(u.v)) { s += ' ' + u.v; next(); }
      parseDuration(s);
      rule.for = s.replace(/^(\d+)\s*(\D+)$/, '$1 $2');
    } else if (kw === 'then') {
      do {
        const a = next();
        if (!a || a.k !== 'word' || !(ACTIONS as readonly string[]).includes(a.v.toLowerCase())) throw new Error(`unknown action "${a?.v ?? ''}" (${ACTIONS.join(' | ')})`);
        const args: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        if (peek()?.k === '(') {
          next();
          let pos = 0;
          while (peek() && peek()!.k !== ')') {
            const v = next()!;
            if (v.k === ',') continue;
            let key = String(pos++);
            let value: unknown = v.v;
            if (v.k === 'word' && peek()?.k === 'op' && peek()!.v === '=') { next(); key = v.v; const vv = next(); if (!vv) throw new Error(`${key}= needs a value`); value = vv.v; if (vv.k !== 'str' && parseNumber(vv.v) !== null && /\d/.test(vv.v)) value = parseNumber(vv.v); }
            else if (v.k === 'word' && parseNumber(v.v) !== null && /\d/.test(v.v)) value = parseNumber(v.v);
            args[key] = value;
          }
          if (next()?.k !== ')') throw new Error(`expected ) after ${a.v}(`);
        }
        rule.then.push(normalizeAction(a.v.toLowerCase(), args));
        if (rule.then.length > 6) throw new Error('a rule may have at most 6 actions');
      } while (peek()?.k === 'word' && (ACTIONS as readonly string[]).includes(peek()!.v.toLowerCase()));
    } else if (kw === 'cooldown') { const d = next(); if (!d) throw new Error('cooldown needs a duration'); const p = parseDuration(d.v); if ('ticks' in p) throw new Error('cooldown is a time (s|m|h)'); rule.cooldown = d.v; }
    else if (kw === 'window') { const d = next(); if (!d) throw new Error('window needs a duration'); const p = parseDuration(d.v); if ('ticks' in p) throw new Error('window is a time (s|m|h)'); rule.window = d.v; }
    else if (kw === 'max') { const d = next(); const m = /^(\d+)\/h$/.exec(d?.v ?? ''); if (!m) throw new Error('max needs n/h'); const n = Number(m[1]); if (n < 1 || n > MAX_PER_HOUR_CAP) throw new Error(`max n/h must be 1..${MAX_PER_HOUR_CAP}`); rule.maxPerHour = n; }
    else if (kw === 'scope') {
      const s = next(); if (!s || s.k !== 'word') throw new Error('scope needs a value');
      let v = s.v;
      if (peek()?.k === ':') { next(); const m = next(); if (!m || m.k !== 'word') throw new Error('scope mint: needs an address'); v += ':' + m.v; }
      rule.scope = checkScope(v);
    } else if (kw === 'name') { const s = next(); if (!s) throw new Error('name needs text'); rule.name = s.v.slice(0, 80); }
    else if (KEYWORDS.has(kw)) throw new Error(`misplaced "${kw}"`);
    else throw new Error(`unexpected "${t.v}" at ${t.at}`);
  }
  if (!rule.then.length) throw new Error('a rule needs "then <action>"');
  return rule;
}

export function checkScope(v: string): string {
  if ((SCOPES as readonly string[]).includes(v)) return v;
  if (/^mint:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return v;
  throw new Error(`scope must be ${SCOPES.join(' | ')} | mint:<address>`);
}

/** Canonical action args; positional args get names; nothing money-shaped survives (unknown keys are dropped, named money keys refused). */
export function normalizeAction(action: string, args: Record<string, unknown> | null | undefined): RuleAction {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  for (const k of Object.keys(a)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') throw new Error(`action args cannot carry "${k}"`);
    if (MONEY_KEYS.includes(k.toLowerCase())) throw new Error(`${action} cannot carry "${k}"`);
  }
  const pos = (i: number): unknown => a[String(i)];
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  switch (action) {
    case 'alert': {
      const lv = str(a.level ?? pos(0));
      const level: AlertLevel = (ALERT_LEVELS as readonly string[]).includes(lv ?? '') ? (lv as AlertLevel) : 'info';
      const text = str(a.text) ?? str(pos(1)) ?? (lv && !(ALERT_LEVELS as readonly string[]).includes(lv) ? lv : '') ?? '';
      return { action, args: { level, text: text.slice(0, 120) } };
    }
    case 'ticket': {
      const side = String(a.side ?? pos(0) ?? '').toLowerCase();
      if (side !== 'buy' && side !== 'sell') throw new Error('ticket(side, size): side must be buy or sell');
      const size = a.size ?? pos(1);
      const unit = String(a.unit ?? pos(2) ?? 'sol').toLowerCase();
      if (typeof size !== 'number' || !Number.isFinite(size) || !(size > 0) || size > TICKET_SIZE_CAP) throw new Error(`ticket size must be a number 0 < n ≤ ${TICKET_SIZE_CAP} (the signer caps the real amount)`);
      if (unit !== 'sol' && unit !== 'usd' && unit !== 'pct') throw new Error('ticket unit must be sol, usd or pct');
      return { action, args: { side, size, unit } };
    }
    case 'ask': { const skill = String(a.skill ?? pos(0) ?? 'token-dossier'); if (!/^[a-z][a-z0-9-]{1,40}$/.test(skill)) throw new Error('ask(skill) needs a skill name (lowercase, dashes)'); return { action, args: { skill } }; }
    case 'popup': { const kind = String(a.kind ?? pos(0) ?? 'chart'); if (!(RULE_POPUP_KINDS as readonly string[]).includes(kind)) throw new Error(`popup(kind): ${RULE_POPUP_KINDS.join(' | ')}`); return { action, args: { kind: kind as (typeof RULE_POPUP_KINDS)[number] } }; }
    case 'tag': { const label = String(a.label ?? pos(0) ?? ''); if (!label || label.length > 24 || /[\u0000-\u001f\u007f‮]/.test(label)) throw new Error('tag("label") needs 1–24 printable characters'); return { action, args: { label } }; }
    case 'sound': { const name = String(a.name ?? pos(0) ?? 'ping'); if (!/^[a-z-]{2,16}$/.test(name)) throw new Error('sound(name)'); return { action, args: { name } }; }
    case 'watch': return { action, args: {} };
    default: throw new Error(`unknown action "${action}" (${ACTIONS.join(' | ')})`);
  }
}

/** Text → the JSON rule the config stores (schema `ruleJson`). */
export function ruleToJson(text: string, opts: { id?: string; source?: string; enabled?: boolean } = {}): RuleJson {
  const r = parseRule(text);
  const json: RuleJson = {
    id: opts.id ?? slug(r.name ?? text), name: r.name ?? text.slice(0, 80), enabled: opts.enabled ?? true,
    when: exprToText(r.when), then: r.then.map((a) => ({ action: a.action, args: { ...a.args } })), scope: r.scope, cooldown: r.cooldown, maxPerHour: r.maxPerHour, window: r.window, source: opts.source ?? 'user',
  };
  if (r.for) json.for = r.for;
  return json;
}
export function slug(s: string): string { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^[^a-z]+/, '').slice(0, 40) || 'rule'; }

/** The JSON rule back to one line of rule text (what the editor shows). */
export function ruleToText(r: RuleJson): string {
  const parts = [`when ${r.when}`];
  if (r.for) parts.push(`for ${r.for}`);
  parts.push('then ' + r.then.map((a) => actionToText(a.action, a.args ?? {})).join(' '));
  if (r.cooldown && r.cooldown !== DEFAULT_COOLDOWN) parts.push(`cooldown ${r.cooldown}`);
  if (r.maxPerHour !== undefined && r.maxPerHour !== DEFAULT_MAX_PER_HOUR) parts.push(`max ${r.maxPerHour}/h`);
  if (r.scope && r.scope !== 'screener') parts.push(`scope ${r.scope}`);
  if (r.window && r.window !== DEFAULT_WINDOW) parts.push(`window ${r.window}`);
  if (r.name && r.name !== r.when && !r.name.startsWith('when ')) parts.push(`name ${JSON.stringify(r.name)}`);
  return parts.join(' ');
}
function actionToText(action: string, args: Record<string, unknown>): string {
  switch (action) {
    case 'alert': return `alert(${args.level ?? 'info'}${args.text ? `, ${JSON.stringify(args.text)}` : ''})`;
    case 'ticket': return `ticket(${args.side}, ${args.size}, ${args.unit ?? 'sol'})`;
    case 'ask': return `ask(${args.skill})`;
    case 'popup': return `popup(${args.kind})`;
    case 'tag': return `tag(${JSON.stringify(args.label)})`;
    case 'sound': return `sound(${args.name})`;
    default: return action;
  }
}

export function exprToText(e: Expr): string {
  switch (e.kind) {
    case 'cmp': return `${e.field}${e.deriv ? '.' + e.deriv : ''} ${e.op} ${fmtNum(e.value)}`;
    case 'tag': return `${e.not ? '!' : ''}${e.tag}:${e.value}`;
    case 'not': return `not (${exprToText(e.expr)})`;
    case 'and': return `${exprToText(e.left)} and ${exprToText(e.right)}`;
    case 'or': return `(${exprToText(e.left)} or ${exprToText(e.right)})`;
  }
}
function fmtNum(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9 && Number.isInteger(n / 1e9)) return `${n / 1e9}B`;
  if (a >= 1e6 && Number.isInteger(n / 1e6)) return `${n / 1e6}M`;
  if (a >= 1e3 && Number.isInteger(n / 1e3)) return `${n / 1e3}K`;
  return String(n);
}

/** A `.rules` file: one rule per line, `#` comments, blank lines ignored. Bad lines are reported with their line number; good ones load. */
export function parseRulesFile(text: string, opts: { source?: string; idPrefix?: string } = {}): { rules: RuleJson[]; errors: Array<{ line: number; msg: string }> } {
  const rules: RuleJson[] = [];
  const errors: Array<{ line: number; msg: string }> = [];
  const seen = new Set<string>();
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    try {
      const r = ruleToJson(line, { source: opts.source });
      if (opts.idPrefix) r.id = slug(`${opts.idPrefix}-${r.id}`);
      if (seen.has(r.id)) throw new Error(`duplicate rule id "${r.id}" (give it a different name "...")`);
      seen.add(r.id);
      rules.push(r);
    } catch (e) { errors.push({ line: i + 1, msg: (e as Error).message }); }
  });
  return { rules, errors };
}

// ------------------------------------------------------------------ engine
export interface CompiledRule {
  id: string; name: string; enabled: boolean; when: Expr; whenText: string;
  for: Duration | null; then: RuleAction[]; scope: string; cooldownMs: number; maxPerHour: number; windowMs: number; source: string;
}
export interface Reason { clause: string; value: number }
interface Base { rule: string; source: string; mint: string; symbol: string; at: number }
export interface RuleAlert extends Base { kind: 'alert'; level: AlertLevel; text: string }
export type RuleProposal = Base & { kind: 'proposal'; status: 'proposal'; requiresKeypress: true; armedBy: null; why: string } & (
  | { type: 'ticket'; side: 'buy' | 'sell'; size: number; unit: 'sol' | 'usd' | 'pct' }
  | { type: 'ask'; skill: string });
export type RuleUiAction = Base & ({ kind: 'ui'; type: 'popup'; popup: (typeof RULE_POPUP_KINDS)[number] } | { kind: 'ui'; type: 'sound'; name: string });
export type RuleAnnotation = Base & ({ kind: 'annotation'; type: 'watch' } | { kind: 'annotation'; type: 'tag'; label: string });
export type RuleOutput = RuleAlert | RuleProposal | RuleUiAction | RuleAnnotation;
export interface RuleFire { rule: string; name: string; source: string; mint: string; symbol: string; at: number; tick: number; reasons: Reason[]; actions: RuleOutput[] }
export interface Suppressed { rule: string; mint: string; symbol: string; why: 'holding' | 'cooldown' | 'max/h' }
export interface EvalResult { fired: RuleFire[]; alerts: RuleAlert[]; proposals: RuleProposal[]; ui: RuleUiAction[]; annotations: RuleAnnotation[]; suppressed: Suppressed[] }
export interface EvalCtx { watchlist?: ReadonlySet<string> | { has(mint: string): boolean }; positions?: ReadonlySet<string> | { has(mint: string): boolean } }
export interface DryRunResult {
  /** Rows the condition holds for right now (cooldown / max/h / `for` ignored: this is "what would match"). */
  matches: Array<{ mint: string; symbol: string; reasons: Reason[] }>;
  /** Rows considered (in scope, not skeletons). */
  considered: number;
  /** Rows where a derived signal had no history yet (velocity/delta need two earlier samples in the window). */
  noHistory: number;
  /** The compiled rule (for display) or null with an error. */
  rule: CompiledRule | null;
  error: string | null;
}

type Sample = { t: number } & Record<string, number | null | undefined>;

export class RulesEngine {
  rules: CompiledRule[] = [];
  /** mint → samples (one per observe) kept for the largest rule window (≥ 60 s). */
  readonly ring = new Map<string, Sample[]>();
  private held = new Map<string, { since: number; ticks: number }>();
  private lastFired = new Map<string, number>();
  private fires = new Map<string, number[]>();
  tick = 0;
  maxWindowMs = 60_000;
  now = 0;
  /** Problems with rules that did not load (id → message); the others run. */
  readonly errors: Array<{ id: string; msg: string }> = [];

  constructor(opts: { rules?: Array<RuleJson | string>; now?: number } = {}) {
    for (const r of opts.rules ?? []) {
      try { this.load(r); } catch (e) { this.errors.push({ id: typeof r === 'string' ? r.slice(0, 40) : String((r as RuleJson)?.id ?? '?'), msg: (e as Error).message }); }
    }
    this.now = opts.now ?? 0;
  }

  /** Accepts rule text or the JSON form; returns the compiled rule. Throws on bad text / bad JSON (nothing is loaded then). */
  load(r: RuleJson | string): CompiledRule {
    const json = typeof r === 'string' ? ruleToJson(r) : r;
    if (!json || typeof json !== 'object' || typeof json.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(json.id)) throw new Error('rule id must be a slug (lowercase letters, digits, dashes)');
    if (typeof json.when !== 'string') throw new Error(`${json.id}: "when" must be rule text`);
    if (!Array.isArray(json.then) || !json.then.length || json.then.length > 6) throw new Error(`${json.id}: "then" needs 1–6 actions`);
    const cooldown = parseDuration(json.cooldown ?? DEFAULT_COOLDOWN);
    const window = parseDuration(json.window ?? DEFAULT_WINDOW);
    if ('ticks' in cooldown || 'ticks' in window) throw new Error(`${json.id}: cooldown and window are times`);
    const maxPerHour = json.maxPerHour ?? DEFAULT_MAX_PER_HOUR;
    if (!Number.isInteger(maxPerHour) || maxPerHour < 1 || maxPerHour > MAX_PER_HOUR_CAP) throw new Error(`${json.id}: maxPerHour must be 1..${MAX_PER_HOUR_CAP}`);
    const source = json.source ?? 'user';
    if (!/^(user|pack:[a-z][a-z0-9-]*|jarvis|plugin:[a-z][a-z0-9-]*)$/.test(source)) throw new Error(`${json.id}: bad source "${source}"`);
    const compiled: CompiledRule = {
      id: json.id, name: typeof json.name === 'string' && json.name ? json.name.slice(0, 80) : json.id, enabled: json.enabled !== false,
      when: parseExpr(json.when), whenText: json.when,
      for: json.for ? parseDuration(json.for) : null,
      then: json.then.map((a) => normalizeAction(a.action, a.args ?? {})),
      scope: checkScope(json.scope ?? 'screener'), cooldownMs: cooldown.ms, maxPerHour, windowMs: Math.max(1_000, window.ms), source,
    };
    this.maxWindowMs = Math.max(this.maxWindowMs, compiled.windowMs);
    this.rules = this.rules.filter((x) => x.id !== compiled.id).concat(compiled);
    return compiled;
  }
  remove(id: string): void { this.rules = this.rules.filter((x) => x.id !== id); }
  setEnabled(id: string, on: boolean): boolean { const r = this.rules.find((x) => x.id === id); if (!r) return false; r.enabled = on; return true; }
  get(id: string): CompiledRule | undefined { return this.rules.find((x) => x.id === id); }

  /** Record one tick of rows (all scopes) so derived signals have history. Rows without a mint / skeletons are skipped. */
  observe(rows: readonly RuleRow[], now: number): void {
    this.now = now; this.tick += 1;
    const keep = now - this.maxWindowMs - 1;
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.mint || r.skeleton || seen.has(r.mint)) continue;
      seen.add(r.mint);
      const arr = this.ring.get(r.mint) ?? [];
      const sample: Sample = { t: now };
      for (const f of FIELD_NAMES) sample[f] = FIELDS[f](r);
      arr.push(sample);
      while (arr.length && arr[0].t < keep) arr.shift();
      this.ring.set(r.mint, arr);
    }
    // forget mints that stopped appearing a long time ago (ring hygiene for a long session)
    if (this.tick % 50 === 0) for (const [mint, arr] of this.ring) if (!arr.length || arr[arr.length - 1].t < keep) this.ring.delete(mint);
  }

  /** The derived signal for (mint, field): null until two earlier samples exist in the window. */
  signal(mint: string, field: string, deriv: 'velocity' | 'delta', windowMs: number, now: number, current: number): number | null {
    const arr = this.ring.get(mint) ?? [];
    const prior = arr.filter((s) => s.t >= now - windowMs && s.t < now && s[field] !== null && s[field] !== undefined) as Array<Sample & Record<string, number>>;
    if (prior.length < 2) return null;
    if (deriv === 'velocity') { const mean = prior.reduce((a, s) => a + s[field], 0) / prior.length; return mean > 0 ? current / mean : null; }
    return current - prior[0][field];
  }

  private test(expr: Expr, row: RuleRow, rule: CompiledRule, now: number, reasons: Reason[], stats?: { noHistory: number }): boolean {
    switch (expr.kind) {
      case 'and': return this.test(expr.left, row, rule, now, reasons, stats) && this.test(expr.right, row, rule, now, reasons, stats);
      case 'or': return this.test(expr.left, row, rule, now, reasons, stats) || this.test(expr.right, row, rule, now, reasons, stats);
      case 'not': return !this.test(expr.expr, row, rule, now, [], stats);
      case 'tag': { const ok = TAGS[expr.tag](row, expr.value); return expr.not ? !ok : ok; }
      case 'cmp': {
        const cur = FIELDS[expr.field](row);
        if (cur === null || cur === undefined || !Number.isFinite(cur)) return false; // missing data is false, never true (same as the filter grammar)
        let v: number | null = cur;
        if (expr.deriv) { v = this.signal(row.mint, expr.field, expr.deriv, rule.windowMs, now, cur); if (v === null) { if (stats) stats.noHistory += 1; return false; } }
        const ok = OPS[expr.op](v, expr.value);
        if (ok) reasons.push({ clause: expr.raw, value: Math.round(v * 100) / 100 });
        return ok;
      }
    }
  }

  inScope(rule: CompiledRule, row: RuleRow, ctx: EvalCtx): boolean {
    if (rule.scope.startsWith('mint:')) return rule.scope.slice(5) === row.mint;
    if (rule.scope === 'watchlist') return !!ctx.watchlist?.has(row.mint);
    if (rule.scope === 'positions') return !!ctx.positions?.has(row.mint);
    if (rule.scope === 'newpairs') return (row.ageMin ?? Infinity) <= 120;
    return true;
  }

  /** Evaluate every enabled rule against rows at `now`. Call observe() first. Pure apart from the engine's own counters. */
  evaluate(rows: readonly RuleRow[], now: number, ctx: EvalCtx = {}): EvalResult {
    this.now = now;
    const out: EvalResult = { fired: [], alerts: [], proposals: [], ui: [], annotations: [], suppressed: [] };
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      const recent = (this.fires.get(rule.id) ?? []).filter((t) => t > now - 3_600_000);
      this.fires.set(rule.id, recent);
      const seen = new Set<string>();
      for (const row of rows) {
        if (!row.mint || row.skeleton || seen.has(row.mint)) continue;
        seen.add(row.mint);
        if (!this.inScope(rule, row, ctx)) continue;
        const key = `${rule.id}|${row.mint}`;
        const reasons: Reason[] = [];
        const ok = this.test(rule.when, row, rule, now, reasons);
        if (!ok) { this.held.delete(key); continue; }
        let h = this.held.get(key);
        if (!h) { h = { since: now, ticks: 0 }; this.held.set(key, h); }
        h.ticks += 1;
        if (rule.for) {
          const enough = 'ticks' in rule.for ? h.ticks >= rule.for.ticks : now - h.since >= rule.for.ms;
          if (!enough) { out.suppressed.push({ rule: rule.id, mint: row.mint, symbol: row.symbol, why: 'holding' }); continue; }
        }
        const last = this.lastFired.get(key);
        if (last !== undefined && now - last < rule.cooldownMs) { out.suppressed.push({ rule: rule.id, mint: row.mint, symbol: row.symbol, why: 'cooldown' }); continue; }
        if (recent.length >= rule.maxPerHour) { out.suppressed.push({ rule: rule.id, mint: row.mint, symbol: row.symbol, why: 'max/h' }); continue; }
        this.lastFired.set(key, now); recent.push(now);
        const ev: RuleFire = { rule: rule.id, name: rule.name, source: rule.source, mint: row.mint, symbol: row.symbol, at: now, tick: this.tick, reasons, actions: [] };
        for (const a of rule.then) {
          const o = this.perform(a, row, ev, now);
          ev.actions.push(o);
          if (o.kind === 'alert') out.alerts.push(o); else if (o.kind === 'proposal') out.proposals.push(o); else if (o.kind === 'ui') out.ui.push(o); else out.annotations.push(o);
        }
        out.fired.push(ev);
      }
    }
    return out;
  }

  /**
   * "Would fire on N rows right now": test a rule's condition against rows without firing, counting, cooling
   * down or holding. Uses the engine's ring for derived signals (so velocity/delta reflect real history) and
   * never mutates it. Accepts rule text or JSON; a parse error comes back as `error`, never thrown.
   */
  dryRun(rule: string | RuleJson, rows: readonly RuleRow[], now: number, ctx: EvalCtx = {}): DryRunResult {
    let compiled: CompiledRule;
    try {
      const json = typeof rule === 'string' ? ruleToJson(rule, { id: 'dry-run' }) : rule;
      const probe = new RulesEngine();
      compiled = probe.load(json);
    } catch (e) { return { matches: [], considered: 0, noHistory: 0, rule: null, error: (e as Error).message }; }
    const res: DryRunResult = { matches: [], considered: 0, noHistory: 0, rule: compiled, error: null };
    const stats = { noHistory: 0 };
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.mint || row.skeleton || seen.has(row.mint)) continue;
      seen.add(row.mint);
      if (!this.inScope(compiled, row, ctx)) continue;
      res.considered += 1;
      const reasons: Reason[] = [];
      const before = stats.noHistory;
      if (this.test(compiled.when, row, compiled, now, reasons, stats)) res.matches.push({ mint: row.mint, symbol: row.symbol, reasons });
      else if (stats.noHistory > before) res.noHistory += 1;
    }
    return res;
  }

  /** Fires in the last hour per rule (the Rules screen's "fires/h"). */
  firesLastHour(id: string, now = this.now): number { return (this.fires.get(id) ?? []).filter((t) => t > now - 3_600_000).length; }
  lastFiredAt(id: string): number | null { let m: number | null = null; for (const [k, t] of this.lastFired) if (k.startsWith(`${id}|`) && (m === null || t > m)) m = t; return m; }

  private perform(a: RuleAction, row: RuleRow, ev: RuleFire, now: number): RuleOutput {
    const why = ev.reasons.map((r) => `${r.clause} (${r.value})`).join(', ');
    const base: Base = { rule: ev.rule, source: ev.source, mint: row.mint, symbol: row.symbol, at: now };
    switch (a.action) {
      case 'alert': return { kind: 'alert', level: a.args.level, text: `${a.args.text || ev.name}: ${why}`, ...base };
      case 'ticket': return { kind: 'proposal', type: 'ticket', side: a.args.side, size: a.args.size, unit: a.args.unit, status: 'proposal', requiresKeypress: true, armedBy: null, why, ...base };
      case 'ask': return { kind: 'proposal', type: 'ask', skill: a.args.skill, status: 'proposal', requiresKeypress: true, armedBy: null, why, ...base };
      case 'watch': return { kind: 'annotation', type: 'watch', ...base };
      case 'tag': return { kind: 'annotation', type: 'tag', label: a.args.label, ...base };
      case 'popup': return { kind: 'ui', type: 'popup', popup: a.args.kind, ...base };
      case 'sound': return { kind: 'ui', type: 'sound', name: a.args.name, ...base };
    }
  }
}

/** One-line description of a compiled rule's actions for lists ("alert·ticket buy 0.5 sol·ask token-dossier"). */
export function describeActions(r: { then: readonly RuleAction[] }): string {
  return r.then.map((a) => {
    switch (a.action) {
      case 'alert': return `alert ${a.args.level}`;
      case 'ticket': return `ticket ${a.args.side} ${a.args.size} ${a.args.unit}`;
      case 'ask': return `ask ${a.args.skill}`;
      case 'popup': return `popup ${a.args.kind}`;
      case 'tag': return `tag "${a.args.label}"`;
      case 'sound': return `sound ${a.args.name}`;
      case 'watch': return 'watch';
    }
  }).join(' · ');
}
