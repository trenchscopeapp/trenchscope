// @dexterm/agents — per-agent identity (task-1345).
//
// The user registers each agent once (`trenchscope agent add NAME --tier T`); the agent gets a bearer token
// that is shown exactly once and stored only as a salted SHA-256 hash in `<trenchscope home>/agents.json`
// (mode 0600). Every connection (bus `hello`, or a bridged `trenchscope mcp` child) presents the name and the
// token; the registry verifies the hash with a constant-time compare and hands back the GRANTED tier.
// The agent never states its own tier. Tokens are rotated with `trenchscope agent rotate NAME`; a rotated or
// removed token fails verification at once, so a kicked agent cannot reconnect with the old secret.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { isTier, TOOL_TIERS, type Tier } from './tiers.ts';

export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;
export const TOKEN_PREFIX = 'dxa_';
/** Hard cap on registered agents (a flood of `agent add` is still bounded). */
export const MAX_AGENTS = 32;

/** Per-agent limits the user may override in agents.json; defaults in gate.ts DEFAULT_LIMITS. */
export interface AgentLimits {
  /** Read calls per minute. */
  readsPerMin?: number;
  /** Proposals per hour. */
  proposalsPerHour?: number;
  /** Concurrent connections (bus sockets + bridged MCP children). */
  connections?: number;
}

export interface AgentRecord {
  id: string;
  name: string;
  tier: Tier;
  /** sha256(salt + token), hex. */
  tokenHash: string;
  salt: string;
  createdAt: number;
  /** A paused agent authenticates but every call is refused until resumed. */
  paused: boolean;
  /** Set by a rotate; the previous token stops working immediately. */
  rotatedAt: number | null;
  limits?: AgentLimits;
  /**
   * Optional per-agent MANDATE (task-1405): an allow-list of tool names this agent may call, on top of its
   * tier. When set, the agent sees and may call ONLY these tools (plus `agent_whoami` to introspect); it can
   * only NARROW the tier, never widen it, and never reaches a tool outside TOOL_TIERS (the never-list still
   * runs first). Absent/empty = the full tier surface.
   */
  scope?: string[];
  /** Free text from the user (`--note`), shown in the roster. Never from the agent. */
  note?: string;
}

/** Validate + normalise a mandate scope: known tool names only, deduped; agent_whoami is implicit. Throws on an unknown tool. */
export function sanitizeScope(tools: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tools) {
    const t = String(raw).trim();
    if (!t || t === 'agent_whoami') continue;
    if (!Object.hasOwn(TOOL_TIERS, t)) throw new Error(`unknown tool "${t.slice(0, 40)}" — a mandate may only list agent tools (${Object.keys(TOOL_TIERS).join(', ')})`);
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  if (!out.length) throw new Error('a mandate needs at least one tool (use --clear to remove a mandate)');
  return out;
}

interface RegistryFile { version: 1; agents: AgentRecord[] }

export function dextermHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEXTERM_HOME && env.DEXTERM_HOME.trim() ? env.DEXTERM_HOME : join(homedir(), '.dexterm');
}

export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dextermHome(env), 'agents.json');
}

export function hashToken(salt: string, token: string): string {
  return createHash('sha256').update(salt + ':' + token, 'utf8').digest('hex');
}

function newToken(): string { return TOKEN_PREFIX + randomBytes(32).toString('base64url'); }
function newId(): string { return randomBytes(6).toString('hex'); }

/** Fail-closed token shape check before any hashing (also what the bus/MCP use to reject junk early). */
export function looksLikeToken(t: unknown): t is string {
  return typeof t === 'string' && t.startsWith(TOKEN_PREFIX) && t.length >= 20 && t.length <= 128 && /^[A-Za-z0-9_-]+$/.test(t.slice(TOKEN_PREFIX.length));
}

export class AgentRegistry {
  private readonly path: string;
  private readonly now: () => number;
  private agents: AgentRecord[] = [];

  constructor(opts: { path?: string; env?: NodeJS.ProcessEnv; now?: () => number } = {}) {
    this.path = opts.path ?? registryPath(opts.env);
    this.now = opts.now ?? (() => Date.now());
    this.load();
  }

  get file(): string { return this.path; }

  private load(): void {
    // An in-memory registry keeps whatever add()/rotate() built: re-reading would wipe it (there is no file).
    if (this.path === ':memory:') return;
    if (!existsSync(this.path)) { this.agents = []; return; }
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.path, 'utf8')); } catch { this.agents = []; return; }
    const f = parsed as Partial<RegistryFile>;
    const list = Array.isArray(f?.agents) ? f.agents : [];
    // Defensive re-validation: a hand-edited file cannot grant a tier outside the three or a bad name.
    this.agents = list.filter((a): a is AgentRecord => !!a && typeof a === 'object' && typeof a.id === 'string' && typeof a.name === 'string' && AGENT_NAME_RE.test(a.name)
      && isTier(a.tier) && typeof a.tokenHash === 'string' && typeof a.salt === 'string').map((a) => {
        // A hand-edited scope is re-validated: keep only known tool names; an empty result drops the mandate.
        const scope = Array.isArray(a.scope) ? a.scope.filter((t): t is string => typeof t === 'string' && Object.hasOwn(TOOL_TIERS, t)) : undefined;
        const rec: AgentRecord = { ...a, paused: a.paused === true, rotatedAt: typeof a.rotatedAt === 'number' ? a.rotatedAt : null };
        if (scope && scope.length) rec.scope = [...new Set(scope)]; else delete rec.scope;
        return rec;
      });
  }

  private save(): void {
    if (this.path === ':memory:') return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const body: RegistryFile = { version: 1, agents: this.agents };
    writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* best effort on odd filesystems */ }
    renameSync(tmp, this.path);
  }

  list(): AgentRecord[] { return this.agents.map((a) => ({ ...a })); }

  get(name: string): AgentRecord | undefined { return this.agents.find((a) => a.name === name); }
  byId(id: string): AgentRecord | undefined { return this.agents.find((a) => a.id === id); }

  /** Register an agent. Returns the record and the ONE-TIME plaintext token (never stored). */
  add(name: string, tier: Tier, opts: { note?: string; limits?: AgentLimits } = {}): { agent: AgentRecord; token: string } {
    if (!AGENT_NAME_RE.test(name)) throw new Error(`agent name must match ${AGENT_NAME_RE} (lowercase letters, digits, dashes; ≤ 24 chars)`);
    if (!isTier(tier)) throw new Error('tier must be observe, annotate or propose');
    if (this.get(name)) throw new Error(`agent "${name}" already exists (rotate its token with: trenchscope agent rotate ${name})`);
    if (this.agents.length >= MAX_AGENTS) throw new Error(`at most ${MAX_AGENTS} agents can be registered`);
    const token = newToken();
    const salt = randomBytes(12).toString('hex');
    const agent: AgentRecord = { id: newId(), name, tier, tokenHash: hashToken(salt, token), salt, createdAt: this.now(), paused: false, rotatedAt: null };
    if (opts.note) agent.note = String(opts.note).slice(0, 80);
    if (opts.limits) agent.limits = sanitizeLimits(opts.limits);
    this.agents.push(agent);
    this.save();
    return { agent: { ...agent }, token };
  }

  remove(name: string): boolean {
    const n = this.agents.length;
    this.agents = this.agents.filter((a) => a.name !== name);
    if (this.agents.length === n) return false;
    this.save();
    return true;
  }

  /** Replace the token; the old one fails from this moment. Returns the new one-time token. */
  rotate(name: string): string {
    const a = this.get(name);
    if (!a) throw new Error(`no agent "${name}"`);
    const token = newToken();
    a.salt = randomBytes(12).toString('hex');
    a.tokenHash = hashToken(a.salt, token);
    a.rotatedAt = this.now();
    this.save();
    return token;
  }

  setTier(name: string, tier: Tier): void {
    const a = this.get(name);
    if (!a) throw new Error(`no agent "${name}"`);
    if (!isTier(tier)) throw new Error('tier must be observe, annotate or propose');
    a.tier = tier;
    this.save();
  }

  setPaused(name: string, paused: boolean): void {
    const a = this.get(name);
    if (!a) throw new Error(`no agent "${name}"`);
    a.paused = paused;
    this.save();
  }

  setLimits(name: string, limits: AgentLimits): void {
    const a = this.get(name);
    if (!a) throw new Error(`no agent "${name}"`);
    a.limits = sanitizeLimits(limits);
    this.save();
  }

  /** Set (or clear, with null) the per-agent tool mandate. Throws on an unknown tool name. */
  setScope(name: string, tools: string[] | null): void {
    const a = this.get(name);
    if (!a) throw new Error(`no agent "${name}"`);
    if (tools === null) delete a.scope; else a.scope = sanitizeScope(tools);
    this.save();
  }

  /**
   * Verify a presented name + token. Constant-time on the hash; the same `null` for an unknown name,
   * a bad token shape and a wrong token (no oracle). Re-reads the file first so a rotate / remove from
   * another process (the CLI) takes effect on the next connection.
   */
  verify(name: unknown, token: unknown): AgentRecord | null {
    this.load();
    if (typeof name !== 'string' || !AGENT_NAME_RE.test(name) || !looksLikeToken(token)) return null;
    const a = this.get(name);
    if (!a) return null;
    const got = Buffer.from(hashToken(a.salt, token), 'hex');
    const want = Buffer.from(a.tokenHash, 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    return { ...a };
  }

  /** Re-read from disk (the TUI calls this before rendering the roster so CLI edits show up). */
  reload(): void { this.load(); }
}

function sanitizeLimits(l: AgentLimits): AgentLimits {
  const out: AgentLimits = {};
  const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.floor(v) : undefined);
  const r = num(l.readsPerMin, 1, 600); if (r !== undefined) out.readsPerMin = r;
  const p = num(l.proposalsPerHour, 0, 200); if (p !== undefined) out.proposalsPerHour = p;
  const c = num(l.connections, 1, 8); if (c !== undefined) out.connections = c;
  return out;
}
