// `trenchscope --spectate-mcp --agent-paper <mandate-id>` — the app half of agent PAPER trading (task-1443).
//
// The user arms a mandate by keypress (plans screen / `trenchscope mandate arm`), then starts the terminal with the
// spectator view and names that mandate. This switch checks the mandate is armed and alive in the hash-chained
// plans journal, then writes the ~/.dexterm rendezvous (wallet DB + mandate ID, never the caps) and a `running`
// control state. The external `trenchscope mcp` server replays the caps from the journal itself on every call, so
// nothing written here can raise a cap. The follow controls map onto the control file: Ctrl+P pause/resume,
// Ctrl+K stop (sticky for the rest of the run), any key while the agent drives = take over. Quitting removes
// both files, so agent paper trading never outlives the terminal that enabled it. Paper only: nothing here can
// reach a wallet, a key, the signer or a send path.

import {
  writePaperAgentRendezvous, clearPaperAgentRendezvous, writeDeskControl, loadMandateFromJournal, plansJournalPathFor,
  systemClock, AGENT_TIER, type DeskControlState,
} from '@dexterm/data';
import { mandateAlive, TIERS } from '@dexterm/data/plans';

export interface AgentPaperOptions {
  env: NodeJS.ProcessEnv;
  mandateId: string;
  /** The paper wallet DB this terminal uses (the agent books into the same simulated ledger). */
  db: string;
  now?: () => number;
}

export class AgentPaperSwitch {
  private readonly opts: AgentPaperOptions;
  private enabled = false;
  private stopped = false;

  constructor(opts: AgentPaperOptions) { this.opts = opts; }

  /** Enable agent paper trading if the mandate is armed and alive. Returns a one-line status for the toast. */
  start(): string {
    const { env, mandateId } = this.opts;
    const r = loadMandateFromJournal(plansJournalPathFor(env), mandateId, systemClock);
    if (!r.mandate) return `agent paper trading OFF: ${'reason' in r ? r.reason : 'no mandate'}`;
    const alive = mandateAlive(r.mandate, (this.opts.now ?? Date.now)());
    if (!alive.ok) return `agent paper trading OFF: mandate ${mandateId} is not usable (${alive.reason}) — arm it first`;
    try {
      writePaperAgentRendezvous({ db: this.opts.db, mandateId }, env);
      this.enabled = true;
    } catch (e) {
      return `agent paper trading OFF: could not write the rendezvous (${e instanceof Error ? e.message : String(e)})`;
    }
    const b = r.mandate.budget;
    const agentPerTrade = b.perTradeUsd * TIERS[AGENT_TIER].perTradeMultiplier;
    return `agent PAPER trading ON (experimental, simulated only) · mandate ${mandateId} · agent cap $${agentPerTrade.toFixed(2)}/trade, $${b.totalUsd} total · ctrl+p pause · ctrl+k stop`;
  }

  /** Map a follow control onto the agent's paper desk. A stop is sticky: only a restart re-enables it. */
  control(state: DeskControlState): void {
    if (!this.enabled) return;
    if (state === 'stopped') this.stopped = true;
    try { writeDeskControl({ state: this.stopped ? 'stopped' : state, reason: 'user' }, this.opts.env); } catch { /* best-effort; the desk fails closed on a missing file */ }
  }

  get isEnabled(): boolean { return this.enabled; }

  /** Disable on quit: remove the rendezvous + control file (the MCP tools then refuse). Idempotent. */
  stop(): void {
    if (!this.enabled) return;
    this.enabled = false;
    try { clearPaperAgentRendezvous(this.opts.env); } catch { /* ignore */ }
  }
}
