// @dexterm/agents — the gate (task-1345). ONE function every agent call passes, on every transport
// (bus method or bridged MCP tool call), before anything is looked up or executed:
//
//   1. the session must be open (not kicked) and its agent not paused;
//   2. the tool name must not be on the never-list (arm / sign / caps / gate / wallet / mandate / keys …)
//      and must exist in the tier table — anything else is `unknown-tool`;
//   3. the agent's GRANTED tier must reach the tool's tier (the tier comes from the registry at hello,
//      never from the request; a request field named `tier`, `agent` or `session` is refused as spoofing);
//   4. the arguments must validate against the tool's closed schema and fit the size cap;
//   5. the per-agent rate limits and quotas must have room (reads/min, navigation per 10 s, proposals/h);
//   6. a proposal must carry an idempotency key.
//
// Every refusal is written to the audit log with a short reason. Sustained refusals trip a per-agent
// breaker (`flood`): the agent is auto-paused for FLOOD_PAUSE_MS and the roster shows why.

import { ACTION_RATE } from '@dexterm/data';
import { tierAtLeast, tierFor, neverAllowed, PROPOSAL_TOOLS, NAVIGATION_TOOLS, type Tier } from './tiers.ts';
import { validateArgs, type JsonSchema } from './schema.ts';
import type { AuditLog } from './audit.ts';
import type { AgentLimits } from './identity.ts';

export interface AgentSession {
  id: string;
  agentId: string;
  agentName: string;
  /** Granted tier (from the registry), possibly lowered by the client's own request at hello. */
  tier: Tier;
  transport: 'bus' | 'mcp' | 'test';
  openedAt: number;
  lastActivity: number;
  /** Set when the user kicked the agent or the socket closed; every further call is refused. */
  closed: boolean;
  closedReason: string | null;
  /** Client-reported label (firewalled, ≤ 40 chars), e.g. "claude-code 2.1.296". Display only. */
  client: string;
  /** Live stream topics this session subscribed to. */
  topics: Set<string>;
  /**
   * Optional per-agent MANDATE (task-1405): when set, this session may call ONLY these tools (plus
   * `agent_whoami`). It comes from the registry at hello, never the request; it only narrows the tier.
   */
  scope?: ReadonlySet<string> | null;
}

export interface GateLimits {
  readsPerMin: number;
  proposalsPerHour: number;
  navPer10s: number;
  maxArgsBytes: number;
  maxTopics: number;
  connections: number;
}

export const DEFAULT_LIMITS: GateLimits = Object.freeze({
  readsPerMin: 120,
  proposalsPerHour: 20,
  navPer10s: ACTION_RATE.max,
  maxArgsBytes: 16 * 1024,
  maxTopics: 8,
  connections: 2,
});

/** Refusals in FLOOD_WINDOW_MS that trip the breaker, and how long the auto-pause lasts. */
export const FLOOD_REFUSALS = 40;
export const FLOOD_WINDOW_MS = 60_000;
export const FLOOD_PAUSE_MS = 5 * 60_000;

export type RefusalCode =
  | 'session-closed' | 'agent-paused' | 'never' | 'unknown-tool' | 'tier' | 'mandate' | 'spoof' | 'bad-args' | 'too-large'
  | 'rate-limited' | 'quota' | 'idempotency-key' | 'flood-paused';

export type GateResult = { ok: true; tool: string; tier: Tier } | { ok: false; code: RefusalCode; error: string };

export interface GateRequest {
  tool: string;
  args?: unknown;
  /** The tool's input schema (from the tool table); absent = the tool takes no arguments. */
  schema?: JsonSchema;
}

/** Fields an agent must never be able to set on a request: identity and capability come from the server. */
const SPOOF_FIELDS = ['agent', 'agent_id', 'agentId', 'agent_name', 'agentName', 'tier', 'session', 'session_id', 'sessionId', 'token', 'as', 'on_behalf_of', 'impersonate'];

interface Window { times: number[] }

export interface GateOptions {
  audit: AuditLog;
  now?: () => number;
  limits?: Partial<GateLimits>;
  /** Called when the breaker trips so the owner (bus) can pause the agent in the registry / roster. */
  onFlood?: (agentId: string, agentName: string, until: number) => void;
  /** Whether an agent is paused right now (registry + roster). */
  isPaused?: (agentId: string) => boolean;
}

export class AgentGate {
  private readonly audit: AuditLog;
  private readonly now: () => number;
  private readonly base: GateLimits;
  private readonly onFlood?: (agentId: string, agentName: string, until: number) => void;
  private readonly isPausedExt: (agentId: string) => boolean;
  private readonly reads = new Map<string, Window>();
  private readonly nav = new Map<string, Window>();
  private readonly proposals = new Map<string, Window>();
  private readonly refusals = new Map<string, Window>();
  private readonly floodUntil = new Map<string, number>();
  private readonly perAgent = new Map<string, Partial<GateLimits>>();

  constructor(opts: GateOptions) {
    this.audit = opts.audit;
    this.now = opts.now ?? (() => Date.now());
    this.base = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
    this.onFlood = opts.onFlood;
    this.isPausedExt = opts.isPaused ?? (() => false);
  }

  /** Per-agent overrides from the registry (`limits` in agents.json). */
  setAgentLimits(agentId: string, l: AgentLimits | undefined): void {
    if (!l) { this.perAgent.delete(agentId); return; }
    const o: Partial<GateLimits> = {};
    if (l.readsPerMin !== undefined) o.readsPerMin = l.readsPerMin;
    if (l.proposalsPerHour !== undefined) o.proposalsPerHour = l.proposalsPerHour;
    if (l.connections !== undefined) o.connections = l.connections;
    this.perAgent.set(agentId, o);
  }

  limitsFor(agentId: string): GateLimits { return { ...this.base, ...(this.perAgent.get(agentId) ?? {}) }; }

  /** Current usage for the roster ("12/min", "3/20 proposals this hour"). */
  usage(agentId: string): { readsPerMin: number; proposalsPerHour: number; navPer10s: number; floodPausedUntil: number | null; limits: GateLimits } {
    const t = this.now();
    const count = (m: Map<string, Window>, win: number): number => { const w = m.get(agentId); if (!w) return 0; return w.times.filter((x) => t - x < win).length; };
    const until = this.floodUntil.get(agentId) ?? null;
    return { readsPerMin: count(this.reads, 60_000), proposalsPerHour: count(this.proposals, 3_600_000), navPer10s: count(this.nav, ACTION_RATE.windowMs), floodPausedUntil: until !== null && until > t ? until : null, limits: this.limitsFor(agentId) };
  }

  /** The gate. Pure apart from the windows and the audit row it writes. */
  check(session: AgentSession, req: GateRequest): GateResult {
    const t = this.now();
    const refuse = (code: RefusalCode, error: string): GateResult => {
      this.audit.append({ agentId: session.agentId, agentName: session.agentName, session: session.id, kind: 'refused', tool: String(req.tool).slice(0, 64), detail: `${code}: ${error}`, ok: false });
      this.noteRefusal(session, t);
      return { ok: false, code, error };
    };
    if (session.closed) return refuse('session-closed', `session closed${session.closedReason ? ` (${session.closedReason})` : ''}`);
    const fu = this.floodUntil.get(session.agentId);
    if (fu !== undefined && fu > t) return refuse('flood-paused', `auto-paused after repeated refusals; resumes in ${Math.ceil((fu - t) / 1000)} s or when the user resumes it`);
    if (this.isPausedExt(session.agentId)) return refuse('agent-paused', 'the user paused this agent');
    const name = req.tool;
    if (typeof name !== 'string' || neverAllowed(name)) return refuse('never', 'no agent may do that at any tier');
    const need = tierFor(name);
    if (need === null) return refuse('unknown-tool', `unknown tool ${JSON.stringify(String(name).slice(0, 40))}`);
    if (!tierAtLeast(session.tier, need)) return refuse('tier', `${name} needs tier ${need}; this agent is ${session.tier}`);
    // Per-agent mandate (task-1405): a scoped agent may call only its listed tools (+ agent_whoami). Narrow-only.
    if (session.scope && name !== 'agent_whoami' && !session.scope.has(name)) return refuse('mandate', `${name} is outside this agent's mandate (allowed: ${[...session.scope].join(', ')})`);
    // spoofing: identity / capability fields in the arguments are never honoured
    const args = req.args === undefined ? {} : req.args;
    if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
      for (const f of SPOOF_FIELDS) if (Object.hasOwn(args as object, f)) return refuse('spoof', `argument "${f}" is not yours to set: identity and tier come from the server`);
    }
    let bytes = 0;
    try { bytes = Buffer.byteLength(JSON.stringify(args)); } catch { return refuse('bad-args', 'arguments are not serialisable'); }
    if (bytes > this.limitsFor(session.agentId).maxArgsBytes) return refuse('too-large', `arguments exceed ${this.limitsFor(session.agentId).maxArgsBytes} bytes`);
    const schemaErr = validateArgs(req.schema, args);
    if (schemaErr) return refuse('bad-args', schemaErr);
    // quotas
    const limits = this.limitsFor(session.agentId);
    if (PROPOSAL_TOOLS.has(name)) {
      const key = (args as Record<string, unknown>).idempotency_key;
      if (typeof key !== 'string' || key.length < 8 || key.length > 64 || !/^[A-Za-z0-9_.:-]+$/.test(key)) return refuse('idempotency-key', 'proposals need idempotency_key (8–64 chars: letters, digits, _ . : -)');
      if (!this.take(this.proposals, session.agentId, 3_600_000, limits.proposalsPerHour, t)) return refuse('quota', `proposal quota reached (${limits.proposalsPerHour}/hour)`);
    } else if (NAVIGATION_TOOLS.has(name)) {
      if (!this.take(this.nav, session.agentId, ACTION_RATE.windowMs, limits.navPer10s, t)) return refuse('rate-limited', `navigation is limited to ${limits.navPer10s} per ${ACTION_RATE.windowMs / 1000} s`);
    } else if (name !== 'subscribe' && name !== 'unsubscribe') {
      if (!this.take(this.reads, session.agentId, 60_000, limits.readsPerMin, t)) return refuse('rate-limited', `read rate limit reached (${limits.readsPerMin}/min)`);
    }
    session.lastActivity = t;
    return { ok: true, tool: name, tier: need };
  }

  /** Record a successful call (the owner calls this after executing so the detail can name the target). */
  record(session: AgentSession, tool: string, detail: string, kind: 'call' | 'proposal' | 'note' | 'subscribe' = 'call'): void {
    this.audit.append({ agentId: session.agentId, agentName: session.agentName, session: session.id, kind, tool, detail, ok: true });
  }

  /** A proposal's quota slot is returned when the proposal turned out to be an idempotent repeat. */
  refundProposal(agentId: string): void { const w = this.proposals.get(agentId); if (w) w.times.pop(); }

  /** Clear the breaker (user resume). */
  clearFlood(agentId: string): void { this.floodUntil.delete(agentId); this.refusals.delete(agentId); }

  private take(m: Map<string, Window>, agentId: string, windowMs: number, max: number, t: number): boolean {
    let w = m.get(agentId);
    if (!w) { w = { times: [] }; m.set(agentId, w); }
    while (w.times.length && t - w.times[0] >= windowMs) w.times.shift();
    if (w.times.length >= max) return false;
    w.times.push(t);
    return true;
  }

  private noteRefusal(session: AgentSession, t: number): void {
    let w = this.refusals.get(session.agentId);
    if (!w) { w = { times: [] }; this.refusals.set(session.agentId, w); }
    while (w.times.length && t - w.times[0] >= FLOOD_WINDOW_MS) w.times.shift();
    w.times.push(t);
    if (w.times.length >= FLOOD_REFUSALS && !(this.floodUntil.get(session.agentId)! > t)) {
      const until = t + FLOOD_PAUSE_MS;
      this.floodUntil.set(session.agentId, until);
      w.times.length = 0;
      this.audit.append({ agentId: session.agentId, agentName: session.agentName, session: session.id, kind: 'flood', tool: '-', detail: `${FLOOD_REFUSALS} refusals in ${FLOOD_WINDOW_MS / 1000} s: auto-paused ${FLOOD_PAUSE_MS / 60_000} min`, ok: false });
      this.onFlood?.(session.agentId, session.agentName, until);
    }
  }
}
