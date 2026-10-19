// task-1345 tier 4: bridge the live agent bus to the roster popup VM, and drive the roster popup window.
// The popup only ever sends roster.pause / roster.resume / roster.kick (by agent name); this module maps
// those UI events onto the bus's user-side controls. Nothing here can arm, sign or change a cap.

import type { AgentBus } from '@dexterm/agents';
import type { AuditLog } from '@dexterm/agents';
import type { RosterVM } from '@dexterm/popup';

/** Build the roster VM the popup renders from the live bus + the audit log. */
export function buildRosterVM(bus: AgentBus, audit: AuditLog, limit = 80): RosterVM {
  const agents = bus.roster().map((a) => ({
    id: a.agentId, name: a.name, tier: a.tier, sessions: a.sessions, client: a.client, lastActivity: a.lastActivity,
    topics: a.topics, reads: a.usage.readsPerMin, readsLimit: a.usage.limits.readsPerMin,
    proposals: a.usage.proposalsPerHour, proposalsLimit: a.usage.limits.proposalsPerHour,
    refused: a.counts.refused, paused: a.paused, floodPausedUntil: a.usage.floodPausedUntil,
  }));
  const log = audit.recent(limit).map((r) => ({ t: r.t, agent: r.agentName, kind: r.kind, tool: r.tool, ok: r.ok, detail: r.detail }));
  return { now: Date.now(), busPort: bus.port, agents, audit: log };
}

/** Apply a validated popup roster event to the bus (user-side control). Returns a short log line. */
export function applyRosterEvent(bus: AgentBus, name: string, agent: string): string {
  if (name === 'roster.pause') return bus.pauseAgent(agent) ? `paused ${agent}` : `no agent ${agent}`;
  if (name === 'roster.resume') return bus.resumeAgent(agent) ? `resumed ${agent}` : `no agent ${agent}`;
  if (name === 'roster.kick') { const n = bus.kickAgent(agent); return `kicked ${agent} (${n} session${n === 1 ? '' : 's'})`; }
  return `ignored ${name}`;
}
