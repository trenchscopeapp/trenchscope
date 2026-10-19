// `dexterm` TUI — follow an agent that is driving over MCP (task-1421, "see what your agent is doing").
//
// The running terminal can WATCH and visibly FOLLOW an agent connected through `trenchscope mcp` (Claude Code,
// Cursor, Codex, Claude Desktop, …). That MCP server is a separate process the external client spawned, so
// the app cannot set its env; instead this session, while it is open, writes the ~/.dexterm rendezvous the
// server reads (packages/mcp spectator-sink) and tails the JSONL channel the server appends to. Each record
// is folded into a SpectatorHub → a FollowController (the AGENT ACTIVITY panel + a SCREEN model) and, for
// navigation calls, moved into the REAL terminal through the caller's onNav hook (open a token, switch
// screen/feed/filter, highlight). Owner's own machine → follow mode is unredacted; the optional read-only
// stream (SpectatorServer) redacts every copy that leaves the hub, exactly as in task-1406.
//
// It adds NO power. A record only DESCRIBES a read/navigation call the gate already allowed; there is no
// inbound path from here to anything that can arm, sign, confirm, send or raise a cap. "pause / take over /
// kill" are local follow controls: pause/take-over stop the terminal mirroring the agent (the external agent
// keeps running — we simply stop moving the screen), and kill removes the rendezvous so the server stops
// emitting. Any user keypress during an agent move takes control, so the human and the agent never fight.

import { writeFileSync, readFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  SpectatorHub, FollowController, SpectatorServer,
  type AgentControls, type SpectatorEvent, type SpectatorNav, type FollowView,
} from '@dexterm/agents';
import { rendezvousPath, writeFollowScreen, clearFollowScreen } from '@dexterm/mcp';

/** One record the MCP server appends (mirrors @dexterm/mcp McpSpectatorRecord; the hub re-seqs on ingest). */
interface IngestRecord {
  phase?: string;
  agent?: string;
  tool?: string | null;
  summary?: string;
  ms?: number | null;
  dataAgeSec?: number | null;
  nav?: SpectatorNav | null;
  ok?: boolean;
  t?: number;
  token?: string;
}

export interface McpFollowOptions {
  env: NodeJS.ProcessEnv;
  /** Human label for the connected MCP agent (names are firewalled upstream; default "mcp-agent"). */
  agentLabel?: string;
  activityCap?: number;
  /** Tail poll interval; the timer is unref'd so it never holds the process open (task-1303). */
  pollMs?: number;
  /** Move the REAL terminal for a navigation call. Called ONLY while the agent has control (user wins). */
  onNav?: (nav: SpectatorNav, label: string) => void;
  /** A short status line, e.g. `agent claude-code: opened BONK`. */
  onStatus?: (line: string) => void;
  /** Called after any folded event so the caller can redraw. */
  onEvent?: () => void;
  /**
   * task-1443: called with the owner's control after every pause / take-over / resume / kill, so agent paper
   * trading (when the user enabled it) halts with the follow controls. Never called for a follow-only session.
   */
  onControl?: (state: 'running' | 'paused' | 'takeover' | 'stopped') => void;
  /**
   * task-1443: a reduced snapshot of what this terminal shows (screen, visible rows, selection, the nav allow-list;
   * never wallet, positions, tickets or settings). Published about once a second so an EXTERNAL `trenchscope mcp`
   * server can answer screen_state and validate view-only nav calls against it. Omitted → nothing is published.
   */
  snapshot?: () => Record<string, unknown>;
  /** Also start the read-only, loopback, token-gated spectator stream (redacted). Default off. */
  stream?: boolean;
  now?: () => number;
}

function navLabel(agent: string, nav: SpectatorNav): string {
  const coin = nav.mint ? ` ${nav.mint.length > 10 ? nav.mint.slice(0, 4) + '…' + nav.mint.slice(-4) : nav.mint}` : '';
  if (nav.screen === 'token') return `agent ${agent}: opened${coin}`;
  if (nav.screen === 'ticket') return `agent ${agent}: opened the ${nav.side ?? ''} ticket${coin}`;
  if (nav.screen === 'watchlist') return `agent ${agent}: watchlisted${coin}`;
  if (nav.feed) return `agent ${agent}: switched the feed to ${nav.feed}`;
  if (nav.filter) return `agent ${agent}: filtered ${nav.filter}`;
  if (nav.highlight) return `agent ${agent}: highlighted ${nav.highlight.length > 10 ? nav.highlight.slice(0, 4) + '…' + nav.highlight.slice(-4) : nav.highlight}`;
  if (nav.screen) return `agent ${agent}: switched to ${nav.screen}`;
  return `agent ${agent}: navigated`;
}

/**
 * A follow session for one running terminal. Call start() to arm the rendezvous and begin tailing, pump()
 * to process new records (the timer does this for you), the controls to pause/take-over/kill, userKey() when
 * the human presses any key, and stop() to tear everything down. Never throws into the key loop.
 */
export class McpFollowSession {
  readonly hub: SpectatorHub;
  readonly follow: FollowController;
  private readonly opts: McpFollowOptions;
  private readonly rvPath: string;
  private readonly channelPath: string;
  private readonly token: string;
  private readonly agentLabel: string;
  private currentAgent: string;
  private offset = 0;
  private timer: NodeJS.Timeout | null = null;
  private stream: SpectatorServer | null = null;
  private armed = false;
  private paused = false;
  private lastSnapshot = 0;

  constructor(opts: McpFollowOptions) {
    this.opts = opts;
    this.agentLabel = opts.agentLabel || 'mcp-agent';
    this.currentAgent = this.agentLabel;
    this.rvPath = rendezvousPath(opts.env);
    this.channelPath = this.rvPath.replace(/\.json$/, '.jsonl');
    this.token = randomBytes(24).toString('hex');
    this.hub = new SpectatorHub({ cap: Math.max(1, opts.activityCap ?? 200) });
    const controls: AgentControls = {
      pauseAgent: () => true,
      resumeAgent: () => { this.rearm(); return true; },
      kickAgent: () => { this.disarm(); return 1; },
    };
    this.follow = new FollowController({ controls, activityCap: Math.max(1, opts.activityCap ?? 200) });
    this.hub.on((ev) => this.follow.apply(ev));
  }

  /** Arm the rendezvous (so a `trenchscope mcp` server starts emitting) and begin tailing. Idempotent. */
  async start(): Promise<void> {
    this.rearm();
    if (this.opts.stream) {
      try { this.stream = new SpectatorServer({ hub: this.hub, env: this.opts.env }); await this.stream.start(); }
      catch { this.stream = null; }
    }
    if (!this.timer) {
      this.timer = setInterval(() => { this.pump(); this.publish(); }, Math.max(30, this.opts.pollMs ?? 150));
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Publish the follow-mode screen snapshot (throttled to ~1/s; only while armed). Never throws. */
  publish(force = false): void {
    if (!this.opts.snapshot || !this.armed) return;
    const now = (this.opts.now ?? Date.now)();
    if (!force && now - this.lastSnapshot < 1000) return;
    this.lastSnapshot = now;
    try { writeFollowScreen(this.opts.env, this.opts.snapshot()); } catch { /* fail closed: stale → nav refused */ }
  }

  /** Write (or re-write) the channel + rendezvous so the server emits here. */
  private rearm(): void {
    try {
      mkdirSync(dirname(this.rvPath), { recursive: true });
      if (!this.armed) { writeFileSync(this.channelPath, '', { mode: 0o600 }); this.offset = 0; }
      writeFileSync(this.rvPath, JSON.stringify({ file: this.channelPath, token: this.token, agent: this.agentLabel }) + '\n', { mode: 0o600 });
      this.armed = true;
    } catch { /* best-effort local channel */ }
  }

  /** Remove the rendezvous so the server stops emitting (the external agent keeps running; we stop seeing it). */
  private disarm(): void {
    try {
      // A second follow surface may have replaced the rendezvous after this session started.  Never remove
      // another surface's live handle when this one pauses, is killed, or exits.
      const current = JSON.parse(readFileSync(this.rvPath, 'utf8')) as { token?: unknown };
      if (current.token === this.token) { rmSync(this.rvPath, { force: true }); if (this.opts.snapshot) clearFollowScreen(this.opts.env); }
    } catch { /* absent/malformed/another surface owns it */ }
    this.armed = false;
  }

  /** Read and fold any records appended since the last pump. Public so tests can drive it without timers. */
  pump(): void {
    let text: string;
    try {
      const st = statSync(this.channelPath);
      if (st.size <= this.offset) { if (st.size < this.offset) this.offset = 0; else return; }
      text = readFileSync(this.channelPath, 'utf8');
    } catch { return; }
    const slice = text.slice(this.offset);
    const nl = slice.lastIndexOf('\n');
    if (nl < 0) return; // no complete line yet
    this.offset += nl + 1;
    for (const line of slice.slice(0, nl).split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let rec: IngestRecord;
      try { rec = JSON.parse(t) as IngestRecord; } catch { continue; }
      this.ingest(rec);
    }
  }

  /** Fold one record: verify its token, strip it, emit into the hub, and move the terminal for a nav call. */
  private ingest(rec: IngestRecord): void {
    if (typeof rec.phase !== 'string') return;
    // Only accept records written by the server we handed our token to (local 0600 file; defence in depth).
    if (rec.token !== this.token) return;
    this.currentAgent = typeof rec.agent === 'string' && rec.agent ? rec.agent : this.agentLabel;
    // The token NEVER enters the hub / activity / stream — fold only the observable fields.
    const ev = this.hub.emit({
      phase: rec.phase as SpectatorEvent['phase'],
      agent: this.currentAgent,
      transport: 'mcp',
      tool: rec.tool ?? null,
      summary: rec.summary,
      ms: rec.ms ?? null,
      dataAgeSec: rec.dataAgeSec ?? null,
      nav: rec.nav ?? null,
      ok: rec.ok ?? true,
      t: typeof rec.t === 'number' ? rec.t : undefined,
    });
    // Move the real terminal ONLY while the agent has control (a user keypress / take-over / kill flips this).
    if (ev.phase === 'nav' && ev.ok !== false && ev.nav && this.canFollow()) {
      const label = navLabel(this.currentAgent, ev.nav);
      try { this.opts.onNav?.(ev.nav, label); } catch { /* a bad hook never breaks the tail */ }
      try { this.opts.onStatus?.(label); } catch { /* ignore */ }
    }
    // task-1443: every agent PAPER write (fill, close, size, or a refusal) is toasted in the terminal, whatever the
    // follow state, so the watcher always sees what the agent did to the simulated ledger.
    if (typeof ev.tool === 'string' && /^paper_(open_ticket|size_ticket|confirm|close)$/.test(ev.tool)) {
      const what = ev.ok === false ? `PAPER ${ev.tool.slice(6).replace('_', ' ')} refused · ${String(ev.summary ?? '').replace(/^error: /, '').slice(0, 70)}` : String(ev.summary ?? ev.tool);
      try { this.opts.onStatus?.(`agent ${this.currentAgent}: ${what}`); } catch { /* ignore */ }
    }
    try { this.opts.onEvent?.(); } catch { /* ignore */ }
  }

  /** True when the terminal should mirror the agent: the agent still has control and is active. */
  canFollow(): boolean {
    if (this.follow.controlState !== 'agent') return false;
    const st = this.follow.view().agents.find((a) => a.name === this.currentAgent);
    return !st || st.status === 'active';
  }

  // ----- the owner's controls. Each returns a short line to toast. -----
  pause(): string { const l = this.follow.pause(this.currentAgent); this.paused = l.startsWith('paused '); this.control('paused'); this.opts.onStatus?.(l); return l; }
  takeOver(): string { const l = this.follow.takeOver(this.currentAgent); this.paused = false; this.control('takeover'); this.opts.onStatus?.(l); return l; }
  resume(): string { const l = this.follow.resume(this.currentAgent); this.paused = false; this.control('running'); this.opts.onStatus?.(l); return l; }
  kill(): string { const l = this.follow.kill(this.currentAgent); this.paused = false; this.control('stopped'); this.opts.onStatus?.(l); return l; }
  private control(state: 'running' | 'paused' | 'takeover' | 'stopped'): void { try { this.opts.onControl?.(state); } catch { /* never breaks the key loop */ } }

  /** Any physical keypress while the agent is driving: the human takes over (no fight over the screen). */
  userKey(): void { if (this.follow.controlState === 'agent') this.takeOver(); }

  get controlState() { return this.follow.controlState; }
  get isPaused() { return this.paused; }
  get screenModel() { return this.follow.screenModel; }
  get streamPort(): number { return this.stream?.port ?? 0; }
  view(): FollowView { return this.follow.view(); }

  /** Tear down: stop the timer, remove the rendezvous, close the stream. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.disarm();
    if (this.stream) { try { await this.stream.close(); } catch { /* ignore */ } this.stream = null; }
  }
}
