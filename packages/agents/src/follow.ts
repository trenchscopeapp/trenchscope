// @dexterm/agents — follow mode (task-1406). The in-terminal, local view of an agent driving dexterm:
// it folds the spectator event stream into a SCREEN MODEL (what the terminal should be showing) and an
// ACTIVITY panel (recent calls with agent badge, timing and data ages), and exposes the owner's
// controls: pause / take over / kill (panic). Controls delegate to an AgentControls interface the bus
// implements (pauseAgent / resumeAgent / kickAgent) — this module can never arm, sign or raise a cap;
// it only drives the SAME user-side controls the roster popup already has.

import type { SpectatorEvent } from './spectator.ts';
import type { Tier } from './tiers.ts';

/** The user-side controls follow mode can invoke (the AgentBus implements these). */
export interface AgentControls {
  pauseAgent(name: string): boolean;
  resumeAgent(name: string): boolean;
  kickAgent(name: string): number;
}

/** What the terminal should be showing because the agent asked for it. */
export interface ScreenModel {
  screen: string;              // 'screener' | 'token' | 'ticket' | …
  selectedMint: string | null;
  feed: string | null;
  filter: string | null;
  highlight: string | null;
  ticketSide: string | null;
  watchlist: string[];
  lastNavAt: number | null;
}

export type FollowControl = 'agent' | 'user';

export interface FollowAgentState {
  name: string;
  tier: Tier | null;
  status: 'active' | 'paused' | 'killed';
  lastAt: number;
}

export interface FollowView {
  screen: ScreenModel;
  activity: SpectatorEvent[];
  agents: FollowAgentState[];
  control: FollowControl;
}

function emptyScreen(): ScreenModel {
  return { screen: 'screener', selectedMint: null, feed: null, filter: null, highlight: null, ticketSide: null, watchlist: [], lastNavAt: null };
}

export interface FollowControllerOptions {
  controls?: AgentControls;
  /** How many recent events to keep for the activity panel. Default 50. */
  activityCap?: number;
}

export class FollowController {
  private readonly controls: AgentControls | null;
  private readonly activityCap: number;
  private screen = emptyScreen();
  private readonly activityRing: SpectatorEvent[] = [];
  private readonly agents = new Map<string, FollowAgentState>();
  private control: FollowControl = 'agent';
  private lastSeq = 0;

  constructor(opts: FollowControllerOptions = {}) {
    this.controls = opts.controls ?? null;
    this.activityCap = Math.max(1, opts.activityCap ?? 50);
  }

  /** Fold one spectator event into the screen model + activity + per-agent state. */
  apply(ev: SpectatorEvent): void {
    this.lastSeq = Math.max(this.lastSeq, ev.seq);
    this.activityRing.push(ev);
    if (this.activityRing.length > this.activityCap) this.activityRing.splice(0, this.activityRing.length - this.activityCap);

    const st = this.agents.get(ev.agent) ?? { name: ev.agent, tier: ev.tier ?? null, status: 'active' as const, lastAt: ev.t };
    st.lastAt = ev.t;
    if (ev.tier) st.tier = ev.tier;
    if (ev.phase === 'connect') st.status = 'active';
    if (ev.phase === 'disconnect' && st.status !== 'killed') st.status = st.status === 'paused' ? 'paused' : 'active';
    this.agents.set(ev.agent, st);

    // The agent driving the screen (navigation tools emit a nav block).
    if (ev.phase === 'nav' && ev.nav) {
      const n = ev.nav;
      this.screen.lastNavAt = ev.t;
      if (n.screen) this.screen.screen = n.screen;
      if (n.mint !== undefined) this.screen.selectedMint = n.mint ?? null;
      if (n.feed !== undefined) this.screen.feed = n.feed ?? null;
      if (n.filter !== undefined) this.screen.filter = n.filter ?? null;
      if (n.highlight !== undefined) this.screen.highlight = n.highlight ?? null;
      if (n.side !== undefined) this.screen.ticketSide = n.side ?? null;
      if (n.screen === 'watchlist' && n.mint && !this.screen.watchlist.includes(n.mint)) this.screen.watchlist.push(n.mint);
    }
  }

  // ----- the owner's controls (pause / take over / kill). Each delegates to the bus. -----

  /** Pause the agent: its next call is refused; it stays connected and visible. */
  pause(name: string): string {
    const ok = this.controls?.pauseAgent(name) ?? false;
    if (ok) this.setStatus(name, 'paused');
    return ok ? `paused ${name}` : `no agent ${name}`;
  }

  resume(name: string): string {
    const ok = this.controls?.resumeAgent(name) ?? false;
    if (ok) { this.setStatus(name, 'active'); this.control = 'agent'; }
    return ok ? `resumed ${name}` : `no agent ${name}`;
  }

  /** Take over: pause the agent and mark the human as driving. The agent is frozen but still visible. */
  takeOver(name: string): string {
    const ok = this.controls?.pauseAgent(name) ?? false;
    if (ok) { this.setStatus(name, 'paused'); this.control = 'user'; }
    return ok ? `took over from ${name} — you are driving (agent frozen)` : `no agent ${name}`;
  }

  /** Kill (panic): close every live session for the agent now, and keep it paused so a reconnect is frozen. */
  kill(name: string): string {
    const n = this.controls?.kickAgent(name) ?? 0;
    this.controls?.pauseAgent(name);
    this.setStatus(name, 'killed');
    this.control = 'user';
    return `killed ${name} (${n} session${n === 1 ? '' : 's'} closed; paused)`;
  }

  private setStatus(name: string, status: FollowAgentState['status']): void {
    const st = this.agents.get(name) ?? { name, tier: null, status, lastAt: Date.now() };
    st.status = status;
    this.agents.set(name, st);
  }

  view(): FollowView {
    return {
      screen: { ...this.screen, watchlist: [...this.screen.watchlist] },
      activity: [...this.activityRing],
      agents: [...this.agents.values()].map((a) => ({ ...a })),
      control: this.control,
    };
  }

  get screenModel(): ScreenModel { return { ...this.screen, watchlist: [...this.screen.watchlist] }; }
  get controlState(): FollowControl { return this.control; }
}
