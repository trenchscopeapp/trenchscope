// @dexterm/agents — capability tiers (task-1345, design task-1295 §2).
//
// Three tiers, strictly ordered, enforced SERVER-SIDE per agent identity by the gate (gate.ts). The
// tier an agent has comes from the user's registry (identity.ts), never from anything the agent sends:
// a client may only ask to run BELOW its granted tier.
//
//   observe   read tools and live streams
//   annotate  + non-financial UI navigation on the user's screen, agent-owned notes/tags on coins
//   propose   + proposals: alerts, order plans, watchlist adds — they appear labelled with the agent and
//               need the user's keypress; nothing an agent proposes is ever applied by itself
//
// NEVER, for any agent at any tier (ROADMAP hard rule, SPEC §6.0): arm, sign, confirm, send, raise or
// change a cap, change the confirmation gate, touch the wallet, a mandate or the signer. No such tool
// exists in the table below, and `neverAllowed()` refuses the *shape* of such a request before any
// lookup, so a future tool with a dangerous name cannot be added by accident.

export const TIERS = ['observe', 'annotate', 'propose'] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_RANK: Record<Tier, number> = { observe: 0, annotate: 1, propose: 2 };

export function isTier(x: unknown): x is Tier {
  return typeof x === 'string' && (TIERS as readonly string[]).includes(x);
}

/** True when `have` is at least `need`. */
export function tierAtLeast(have: Tier, need: Tier): boolean {
  return TIER_RANK[have] >= TIER_RANK[need];
}

/** The lower of two tiers (a client may request to run below its grant, never above). */
export function lowerTier(a: Tier, b: Tier): Tier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

/**
 * Every tool or bus method an agent may call, with the minimum tier. Anything absent is refused as
 * `unknown-tool`. The TUI's own analyst keeps its separate task-1313 channel; this table governs
 * external agents only (bus and bridged MCP).
 */
export const TOOL_TIERS: Readonly<Record<string, Tier>> = Object.freeze({
  // ---- observe: read tools (the task-1302/1314/1315 MCP surface) + bus reads
  screen_state: 'observe',
  screener_query: 'observe',
  get_token: 'observe',
  get_dossier: 'observe',
  get_holders: 'observe',
  get_trades: 'observe',
  get_candles: 'observe',
  rugcheck: 'observe',
  get_dev_history: 'observe',
  // deterministic analysis packs (task-1356): read-only, no model, no token cost. Exposed to external
  // agents in task-1405 so a bring-your-own-agent gets the same code-stage analysis the built-in analyst does.
  analyze_token: 'observe',
  narrative_board: 'observe',
  rug_backtest: 'observe',
  kb_lookup: 'observe',
  kb_search: 'observe',
  case_lookup: 'observe',
  get_links: 'observe',
  fetch_page: 'observe',
  check_domain: 'observe',
  check_github: 'observe',
  agent_whoami: 'observe',
  list_proposals: 'observe',
  subscribe: 'observe',
  unsubscribe: 'observe',
  // ---- annotate: non-financial navigation + agent-owned annotations
  open_token: 'annotate',
  show_in_screener: 'annotate',
  switch_feed: 'annotate',
  agent_note: 'annotate',
  // ---- propose: proposals the user must confirm with a keypress
  propose_alert: 'propose',
  propose_order_plan: 'propose',
  add_to_watchlist: 'propose',
});

/** Tools that are proposals (write-shaped): they need an idempotency key and count against the proposal quota. */
export const PROPOSAL_TOOLS: ReadonlySet<string> = new Set(['propose_alert', 'propose_order_plan', 'add_to_watchlist']);

/** UI-navigation tools (count against the shared ACTION_RATE window like the analyst's). */
export const NAVIGATION_TOOLS: ReadonlySet<string> = new Set(['open_token', 'show_in_screener', 'switch_feed']);

/**
 * Names and name-shapes no agent may ever reach, whatever the table says. Checked FIRST. Deliberately
 * broad: a false positive costs an agent one odd tool name; a false negative is money.
 */
export const NEVER_PATTERNS: readonly RegExp[] = [
  /\barm\b|arm_|_arm|arming/i,
  /\bsign\b|sign_|_sign|signer|signature/i,
  /\bconfirm\b|confirm_|_confirm/i,
  /\bsend\b|send_|_send|submit|broadcast/i,
  /\bswap\b|swap_|_swap|transfer|withdraw|deposit|approve/i,
  /\bcap\b|caps?_|_caps?|raise|limit_set|set_limit|budget_set|set_budget|ceiling/i,
  /\bgate\b|gate_|_gate|keypress|opt_?out|less_?safe/i,
  /mandate|wallet|panic|resume_live|go_?live|set_?mode|live_mode|mainnet/i,
  /\bkey\b|keys?_|_keys?|secret|seed|mnemonic|private|credential|token_?file|helius/i,
  /\bexec\b|exec_|shell|spawn|eval|file|path|read_?dir|env|process/i,
  /\bticket\b|ticket_|_ticket|execute|trade_now|buy_now|sell_now|\bfill\b/i,
  /set_tier|grant|escalate|promote|admin|sudo|root|kick|pause_agent|unpause/i,
];

/** True when a requested tool/method name is on the never-list (refused before any lookup). */
export function neverAllowed(name: string): boolean {
  if (typeof name !== 'string') return true;
  if (name.length > 64) return true;
  if (!/^[a-z][a-z0-9_./-]*$/i.test(name)) return true; // odd shapes are refused, never parsed
  if (name in TOOL_TIERS) return false; // table names are vetted by hand and tested below the never-list
  return NEVER_PATTERNS.some((re) => re.test(name));
}

/** The minimum tier for a tool, or null when it is not a tool an agent may call at all. */
export function tierFor(name: string): Tier | null {
  if (neverAllowed(name)) return null;
  return Object.hasOwn(TOOL_TIERS, name) ? TOOL_TIERS[name] : null;
}

/** Tools a tier may call (for `tools/list` filtering and the roster's tier legend). */
export function toolsForTier(tier: Tier): string[] {
  return Object.keys(TOOL_TIERS).filter((t) => tierAtLeast(tier, TOOL_TIERS[t]));
}

export const TIER_LEGEND: Record<Tier, string> = {
  observe: 'read tools + streams',
  annotate: 'navigation, notes, tags',
  propose: 'alerts, order plans, watch adds — as proposals',
};
