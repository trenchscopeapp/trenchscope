// @dexterm/agents — the loopback agent bus (task-1345, tier 2). A WebSocket + JSON-RPC 2.0 server on
// 127.0.0.1 that external agents connect to. Every connection authenticates once with a registered name
// + token (identity.ts); every call passes the gate (gate.ts) before any execution; every connect, call,
// refusal, proposal and disconnect is one audit row. Agents can subscribe to live topics (new pairs,
// trades, alerts, screen) and create proposals the user must confirm. No bus path can arm, sign, send,
// raise a cap, change the gate, or touch a wallet/mandate/signer — the gate's never-list sees to that.

import { writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createWsServer, type WsConn, type WsServer } from './ws.ts';
import { AgentGate, type AgentSession } from './gate.ts';
import { AgentRegistry, dextermHome, looksLikeToken, AGENT_NAME_RE } from './identity.ts';
import { lowerTier, isTier, toolsForTier, type Tier } from './tiers.ts';
import { toolSchema, agentTool, toolsForTierList } from './tools.ts';
import { isTopic, scrubStrings, type AgentExecutor, type BusFeed, type AgentEvent, type Topic } from './executor.ts';
import { TOOL_TO_KIND, type ProposalStore } from './proposals.ts';
import { NAVIGATION_TOOLS } from './tiers.ts';
import { maxDataAgeSec, type SpectatorHub, type SpectatorNav } from './spectator.ts';
import { firewallText } from '@dexterm/data';
import type { AuditLog } from './audit.ts';

export const BUS_PROTOCOL = 'dexterm-agent-bus/1';
/** A connection that does not authenticate within this window is closed. */
export const HELLO_TIMEOUT_MS = 10_000;
/** Hard cap on simultaneous un-authenticated sockets (a connect flood cannot exhaust memory). */
export const MAX_PENDING = 16;

type Rpc = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };

interface Conn {
  ws: WsConn;
  session: AgentSession | null; // null until hello succeeds
  helloTimer: ReturnType<typeof setTimeout> | null;
}

export interface AgentBusOptions {
  registry: AgentRegistry;
  audit: AuditLog;
  executor: AgentExecutor;
  proposals: ProposalStore;
  feed?: BusFeed;
  /** task-1406: when set, every observable action is emitted as a spectator event (follow mode + stream). */
  spectator?: SpectatorHub;
  port?: number;
  now?: () => number;
  /** Where to write the discovery file so `trenchscope agent connect` finds the port. Default <home>/agent-bus.json. */
  discoveryPath?: string | null;
  env?: NodeJS.ProcessEnv;
}

export class AgentBus {
  private server: WsServer | null = null;
  private readonly conns = new Set<Conn>();
  private readonly registry: AgentRegistry;
  private readonly audit: AuditLog;
  private readonly executor: AgentExecutor;
  private readonly proposals: ProposalStore;
  private readonly feed: BusFeed | null;
  private readonly spectator: SpectatorHub | null;
  private readonly gate: AgentGate;
  private readonly now: () => number;
  private readonly paused = new Set<string>();
  private readonly discoveryPath: string | null;
  private feedOff: (() => void) | null = null;
  private sessionSeq = 0;

  constructor(opts: AgentBusOptions) {
    this.registry = opts.registry;
    this.audit = opts.audit;
    this.executor = opts.executor;
    this.proposals = opts.proposals;
    this.feed = opts.feed ?? null;
    this.spectator = opts.spectator ?? null;
    this.now = opts.now ?? (() => Date.now());
    this.discoveryPath = opts.discoveryPath === undefined ? join(dextermHome(opts.env), 'agent-bus.json') : opts.discoveryPath;
    this.gate = new AgentGate({
      audit: this.audit,
      now: this.now,
      isPaused: (id) => this.paused.has(id),
      onFlood: (id, name) => { this.audit.append({ agentId: id, agentName: name, session: null, kind: 'pause', tool: '-', detail: 'auto-paused by the flood breaker', ok: false }); },
    });
  }

  get port(): number { return this.server?.port ?? 0; }
  get connectionCount(): number { return this.conns.size; }

  async start(): Promise<number> {
    this.server = await createWsServer({ port: undefined, onConnection: (ws) => this.onConnection(ws) });
    if (this.feed) this.feedOff = this.feed.on((ev) => this.fanout(ev));
    this.writeDiscovery();
    return this.server.port;
  }

  async close(): Promise<void> {
    this.feedOff?.(); this.feedOff = null;
    for (const c of [...this.conns]) { try { c.ws.close(1001); } catch { /* ignore */ } }
    this.conns.clear();
    if (this.discoveryPath) { try { rmSync(this.discoveryPath); } catch { /* ignore */ } }
    if (this.server) { await this.server.close(); this.server = null; }
  }

  // ----- roster/CLI actions (user side; never reachable from an agent path) -----
  pauseAgent(name: string): boolean {
    const a = this.registry.get(name); if (!a) return false;
    this.paused.add(a.id); this.registry.setPaused(name, true);
    this.audit.append({ agentId: a.id, agentName: name, session: null, kind: 'pause', tool: '-', detail: 'paused by the user', ok: false });
    this.spectator?.emit({ phase: 'control', agent: name, tool: 'pause', summary: 'paused by the user', ok: true });
    return true;
  }
  resumeAgent(name: string): boolean {
    const a = this.registry.get(name); if (!a) return false;
    this.paused.delete(a.id); this.registry.setPaused(name, false); this.gate.clearFlood(a.id);
    this.audit.append({ agentId: a.id, agentName: name, session: null, kind: 'resume', tool: '-', detail: 'resumed by the user', ok: true });
    this.spectator?.emit({ phase: 'control', agent: name, tool: 'resume', summary: 'resumed by the user', ok: true });
    return true;
  }
  /** Kick: close every live session for an agent now (the token keeps working — use `rotate`/`remove` to revoke it). */
  kickAgent(name: string): number {
    const a = this.registry.get(name); if (!a) return 0;
    let n = 0;
    for (const c of [...this.conns]) if (c.session && c.session.agentId === a.id) { c.session.closed = true; c.session.closedReason = 'kicked'; try { c.ws.close(4003); } catch { /* ignore */ } n++; }
    this.audit.append({ agentId: a.id, agentName: name, session: null, kind: 'kick', tool: '-', detail: `kicked ${n} session(s)`, ok: true });
    this.spectator?.emit({ phase: 'control', agent: name, tool: 'kick', summary: `killed — ${n} session(s) closed`, ok: true });
    return n;
  }

  /** For the roster (tier 4): live sessions + usage per connected agent. */
  roster(): Array<{ agentId: string; name: string; tier: Tier; sessions: number; client: string; lastActivity: number; topics: string[]; usage: ReturnType<AgentGate['usage']>; counts: ReturnType<AuditLog['counts']>; paused: boolean }> {
    const byAgent = new Map<string, { name: string; tier: Tier; sessions: number; client: string; lastActivity: number; topics: Set<string> }>();
    for (const c of this.conns) {
      const s = c.session; if (!s) continue;
      const cur = byAgent.get(s.agentId) ?? { name: s.agentName, tier: s.tier, sessions: 0, client: s.client, lastActivity: 0, topics: new Set<string>() };
      cur.sessions++; cur.lastActivity = Math.max(cur.lastActivity, s.lastActivity); for (const t of s.topics) cur.topics.add(t);
      byAgent.set(s.agentId, cur);
    }
    return [...byAgent].map(([agentId, v]) => ({ agentId, name: v.name, tier: v.tier, sessions: v.sessions, client: v.client, lastActivity: v.lastActivity, topics: [...v.topics], usage: this.gate.usage(agentId), counts: this.audit.counts(agentId), paused: this.paused.has(agentId) }));
  }

  // ----- connection lifecycle -----
  private onConnection(ws: WsConn): void {
    if (this.conns.size >= MAX_PENDING + 64) { ws.close(1013); return; } // overall cap (pending + authed)
    const conn: Conn = { ws, session: null, helloTimer: null };
    this.conns.add(conn);
    conn.helloTimer = setTimeout(() => { if (!conn.session) { try { ws.close(4001); } catch { /* ignore */ } } }, HELLO_TIMEOUT_MS);
    (conn.helloTimer as { unref?: () => void }).unref?.();
    ws.onMessage = (text) => this.onMessage(conn, text);
    ws.onClose = () => this.onClose(conn);
  }

  private onClose(conn: Conn): void {
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    if (conn.session) {
      this.audit.append({ agentId: conn.session.agentId, agentName: conn.session.agentName, session: conn.session.id, kind: 'disconnect', tool: '-', detail: 'socket closed', ok: true });
      this.spectator?.emit({ phase: 'disconnect', agent: conn.session.agentName, tier: conn.session.tier, transport: 'bus', summary: conn.session.closedReason ? `disconnected (${conn.session.closedReason})` : 'disconnected', ok: true });
    }
    this.conns.delete(conn);
  }

  private reply(conn: Conn, id: unknown, result: Record<string, unknown>): void { conn.ws.send({ jsonrpc: '2.0', id, result }); }
  private fail(conn: Conn, id: unknown, code: number, message: string, data?: Record<string, unknown>): void { conn.ws.send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }); }

  private onMessage(conn: Conn, text: string): void {
    if (text.length > 256 * 1024) { conn.ws.close(1009); return; }
    let msg: Rpc;
    try { msg = JSON.parse(text) as Rpc; } catch { this.fail(conn, null, -32700, 'parse error'); return; }
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') { this.fail(conn, msg?.id ?? null, -32600, 'invalid request'); return; }
    const id = msg.id ?? null;
    const params = (msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)) ? msg.params as Record<string, unknown> : {};
    if (msg.method === 'hello') { void this.onHello(conn, id, params); return; }
    if (msg.method === 'ping') { this.reply(conn, id, { pong: true, t: this.now() }); return; }
    if (!conn.session) { this.fail(conn, id, -32001, 'say hello first (authenticate with your agent name + token)'); return; }
    if (msg.method === 'tools/list') { this.reply(conn, id, { tools: this.visibleToolDefs(conn.session) }); return; }
    if (msg.method === 'tools/call') { void this.onCall(conn, id, params); return; }
    this.fail(conn, id, -32601, `method not found: ${String(msg.method).slice(0, 40)}`);
  }

  private async onHello(conn: Conn, id: unknown, params: Record<string, unknown>): Promise<void> {
    if (conn.session) { this.fail(conn, id, -32002, 'already authenticated on this connection'); return; }
    const name = params.name;
    const token = params.token;
    if (typeof name !== 'string' || !AGENT_NAME_RE.test(name) || !looksLikeToken(token)) {
      this.audit.append({ agentId: null, agentName: typeof name === 'string' ? name.slice(0, 24) : '?', session: null, kind: 'refused', tool: 'hello', detail: 'bad credentials', ok: false });
      this.fail(conn, id, -32010, 'authentication failed'); try { conn.ws.close(4002); } catch { /* ignore */ } return;
    }
    const rec = this.registry.verify(name, token);
    if (!rec) {
      this.audit.append({ agentId: null, agentName: name.slice(0, 24), session: null, kind: 'refused', tool: 'hello', detail: 'unknown agent or wrong token', ok: false });
      this.fail(conn, id, -32010, 'authentication failed'); try { conn.ws.close(4002); } catch { /* ignore */ } return;
    }
    // connection cap per agent
    const limits = this.gate.limitsFor(rec.id);
    const live = [...this.conns].filter((c) => c.session && c.session.agentId === rec.id).length;
    if (live >= limits.connections) { this.fail(conn, id, -32011, `too many connections for this agent (max ${limits.connections})`); try { conn.ws.close(4009); } catch { /* ignore */ } return; }
    // requested tier can only LOWER the granted one; a bogus request is ignored
    const reqTier = isTier(params.tier) ? params.tier : rec.tier;
    const tier = lowerTier(rec.tier, reqTier);
    const client = firewallText(params.client, { max: 40 }).text.replace(/\s+/g, ' ').trim() || 'unknown';
    if (rec.paused) this.paused.add(rec.id);
    this.gate.setAgentLimits(rec.id, rec.limits);
    const scope = rec.scope && rec.scope.length ? new Set(rec.scope) : null;
    const session: AgentSession = { id: `sess_${(++this.sessionSeq).toString(36)}`, agentId: rec.id, agentName: rec.name, tier, transport: 'bus', openedAt: this.now(), lastActivity: this.now(), closed: false, closedReason: null, client, topics: new Set(), scope };
    conn.session = session;
    if (conn.helloTimer) { clearTimeout(conn.helloTimer); conn.helloTimer = null; }
    this.audit.append({ agentId: rec.id, agentName: rec.name, session: session.id, kind: 'connect', tool: '-', detail: `tier ${tier}${scope ? ` · mandate[${[...scope].join(',')}]` : ''} · ${client} · ${conn.ws.remote}`, ok: true });
    this.spectator?.emit({ phase: 'connect', agent: rec.name, tier, transport: 'bus', summary: `connected · ${client}${scope ? ` · mandate[${[...scope].join(',')}]` : ''}`, ok: true });
    this.reply(conn, id, { protocol: BUS_PROTOCOL, agent: rec.name, tier, grantedTier: rec.tier, tools: this.visibleTools(session), mandate: scope ? [...scope] : null, paused: rec.paused });
  }

  private async onCall(conn: Conn, id: unknown, params: Record<string, unknown>): Promise<void> {
    const session = conn.session;
    if (!session) { this.fail(conn, id, -32001, 'say hello first'); return; }
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)) ? params.arguments as Record<string, unknown> : {};
    const g = this.gate.check(session, { tool: name, args, schema: toolSchema(name) });
    if (!g.ok) {
      // The tool name is agent-supplied; cap it (redactSpectatorEvent still masks any address/key in it).
      this.spectator?.emit({ phase: 'refused', agent: session.agentName, tier: session.tier, transport: 'bus', tool: (name || '?').slice(0, 64), summary: `refused: ${g.error}`, refusal: g.code, ok: false });
      this.fail(conn, id, -32020, g.error, { code: g.code }); return;
    }
    const t0 = this.now();
    try {
      // bus-native observe
      if (name === 'agent_whoami') { this.reply(conn, id, this.whoami(session)); return; }
      if (name === 'subscribe') { this.reply(conn, id, this.subscribe(conn, args)); return; }
      if (name === 'unsubscribe') { this.reply(conn, id, this.unsubscribe(session, args)); return; }
      if (name === 'list_proposals') {
        const limit = Math.min(Number(args.limit ?? 50), 100);
        this.gate.record(session, name, `listed proposals`, 'call');
        this.spectator?.emit({ phase: 'result', agent: session.agentName, tier: session.tier, transport: 'bus', tool: name, summary: 'listed proposals', ms: this.now() - t0, ok: true });
        this.reply(conn, id, { proposals: this.proposals.list({ agentId: session.agentId, limit }) }); return;
      }
      // proposals
      if (TOOL_TO_KIND[name]) {
        const { proposal, duplicate } = this.proposals.create(session, name, args);
        if (duplicate) this.gate.refundProposal(session.agentId);
        this.audit.append({ agentId: session.agentId, agentName: session.agentName, session: session.id, kind: 'proposal', tool: name, detail: `${duplicate ? 'duplicate ' : ''}${proposal.summary}`, ok: true });
        this.spectator?.emit({ phase: 'proposal', agent: session.agentName, tier: session.tier, transport: 'bus', tool: name, summary: `${duplicate ? 'duplicate ' : ''}${proposal.summary}`, ms: this.now() - t0, nav: navFor(name, args), ok: true });
        this.reply(conn, id, { proposal, duplicate, note: 'This is a PROPOSAL. The user confirms it with a keypress; you can never arm, confirm or send it.' }); return;
      }
      // read / navigation / note → executor. Scrub every string leaf of the result before it reaches the
      // agent (belt-and-braces over the source firewall): no escape/bidi/zero-width can pass through.
      const result = scrubStrings(await this.executor.exec(session, name, args));
      const isErr = typeof result.error === 'string';
      this.gate.record(session, name, isErr ? `error: ${String(result.error).slice(0, 80)}` : summarise(name, args), name === 'agent_note' ? 'note' : 'call');
      const nav = navFor(name, args);
      const phase: 'nav' | 'note' | 'result' = nav ? 'nav' : name === 'agent_note' ? 'note' : 'result';
      this.spectator?.emit({ phase, agent: session.agentName, tier: session.tier, transport: 'bus', tool: name, summary: isErr ? `error: ${String(result.error).slice(0, 80)}` : summarise(name, args), ms: this.now() - t0, dataAgeSec: isErr ? null : maxDataAgeSec(result), nav, ok: !isErr });
      this.reply(conn, id, result); return;
    } catch (e) {
      this.fail(conn, id, -32000, 'internal error', { detail: (e as Error).message.slice(0, 80) });
    }
  }

  private whoami(session: AgentSession): Record<string, unknown> {
    return { agent: session.agentName, tier: session.tier, mandate: session.scope ? [...session.scope] : null, tools: this.visibleTools(session).map((t) => ({ name: t, tier: agentTool(t)?.tier })), usage: this.gate.usage(session.agentId), subscriptions: [...session.topics], note: 'Your identity, tier and mandate come from the server. You cannot change them.' };
  }

  /** Tool names this session may call: its tier surface, narrowed by a mandate (+ agent_whoami, always). */
  private visibleTools(session: AgentSession): string[] {
    const all = toolsForTier(session.tier);
    if (!session.scope) return all;
    return all.filter((t) => t === 'agent_whoami' || session.scope!.has(t));
  }

  /** The advertised tool DEFINITIONS for tools/list, narrowed the same way. */
  private visibleToolDefs(session: AgentSession): ReturnType<typeof toolsForTierList> {
    const defs = toolsForTierList(session.tier);
    if (!session.scope) return defs;
    return defs.filter((t) => t.name === 'agent_whoami' || session.scope!.has(t.name));
  }

  private subscribe(conn: Conn, args: Record<string, unknown>): Record<string, unknown> {
    const session = conn.session!;
    const topics = Array.isArray(args.topics) ? args.topics.filter(isTopic) : [];
    const limit = this.gate.limitsFor(session.agentId).maxTopics;
    const added: Topic[] = [];
    for (const t of topics) { if (session.topics.size >= limit) break; if (!session.topics.has(t)) { session.topics.add(t); added.push(t); } }
    this.audit.append({ agentId: session.agentId, agentName: session.agentName, session: session.id, kind: 'subscribe', tool: 'subscribe', detail: `+[${added.join(',')}]`, ok: true });
    this.spectator?.emit({ phase: 'subscribe', agent: session.agentName, tier: session.tier, transport: 'bus', tool: 'subscribe', summary: `subscribed +[${added.join(',')}]`, ok: true });
    // push an immediate snapshot per newly-added topic, if the feed offers one
    if (this.feed?.snapshot) for (const t of added) { const snap = this.feed.snapshot(t); if (snap) conn.ws.send({ jsonrpc: '2.0', method: 'event', params: scrubStrings({ topic: t, seq: 0, t: this.now(), data: snap, snapshot: true }) }); }
    return { subscribed: [...session.topics] };
  }

  private unsubscribe(session: AgentSession, args: Record<string, unknown>): Record<string, unknown> {
    const topics = Array.isArray(args.topics) ? args.topics.filter(isTopic) : null;
    if (topics === null) session.topics.clear(); else for (const t of topics) session.topics.delete(t);
    return { subscribed: [...session.topics] };
  }

  /** Fan a feed event out to every session subscribed to its topic. */
  private fanout(ev: AgentEvent): void {
    for (const c of this.conns) {
      const s = c.session;
      if (!s || s.closed || this.paused.has(s.agentId)) continue;
      if (s.topics.has(ev.topic)) c.ws.send({ jsonrpc: '2.0', method: 'event', params: scrubStrings(ev) });
    }
  }

  private writeDiscovery(): void {
    if (!this.discoveryPath) return;
    try {
      mkdirSync(dirname(this.discoveryPath), { recursive: true, mode: 0o700 });
      writeFileSync(this.discoveryPath, JSON.stringify({ protocol: BUS_PROTOCOL, port: this.port, pid: process.pid, startedAt: this.now() }, null, 2) + '\n', { mode: 0o600 });
      try { chmodSync(this.discoveryPath, 0o600); } catch { /* ignore */ }
    } catch { /* discovery is best-effort; the port can also be passed explicitly */ }
  }
}

/** The screen move a navigation / watchlist / ticket tool asks for (task-1406, for follow mode). */
function navFor(tool: string, args: Record<string, unknown>): SpectatorNav | null {
  const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  if (tool === 'open_token') return { screen: 'token', mint: s(args.mint) };
  if (tool === 'switch_feed') return { screen: 'screener', feed: s(args.feed) };
  if (tool === 'show_in_screener') return { screen: 'screener', filter: s(args.filter), highlight: s(args.highlight) };
  if (tool === 'add_to_watchlist') return { screen: 'watchlist', mint: s(args.mint) };
  if (tool === 'open_ticket') return { screen: 'ticket', mint: s(args.mint), side: s(args.side) };
  if (NAVIGATION_TOOLS.has(tool)) return { screen: 'screener' };
  return null;
}

function summarise(name: string, args: Record<string, unknown>): string {
  const mint = typeof args.mint === 'string' ? args.mint.slice(0, 6) + '…' : '';
  if (mint) return `${name} ${mint}`;
  if (typeof args.query === 'string') return `${name} "${args.query.slice(0, 24)}"`;
  if (typeof args.preset === 'string') return `${name} ${args.preset}`;
  return name;
}
