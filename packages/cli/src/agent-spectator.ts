// task-1406 "watch the agent cook": bridge the follow-mode controller to the spectator popup VM, and map
// the popup's spectator.* UI events onto the controller's user-side controls. Nothing here can arm, sign
// or raise a cap — the controls are exactly the bus's pause/resume/kick, the same as the roster popup.

import { redactSpectatorEvent, maskAddress, type FollowController, type SpectatorEvent } from '@dexterm/agents';
import type { SpectatorPopupVM, SpectatorActivityVM } from '@dexterm/popup';

function activityVM(ev: SpectatorEvent): SpectatorActivityVM {
  return {
    seq: ev.seq, t: ev.t, phase: ev.phase, agent: ev.agent, tier: ev.tier ?? null,
    tool: ev.tool ?? null, summary: ev.summary ?? '', ms: ev.ms ?? null, dataAgeSec: ev.dataAgeSec ?? null,
    ok: ev.ok, refusal: ev.refusal ?? null,
  };
}

/** Build the spectator popup VM from the follow controller. Redacts addresses/keys unless redact:false. */
export function buildSpectatorVM(follow: FollowController, opts: { redact?: boolean; title?: string } = {}): SpectatorPopupVM {
  const redact = opts.redact ?? true;
  const v = follow.view();
  const s = v.screen;
  const mask = (x: string | null): string | null => (x && redact ? maskAddress(x) : x);
  return {
    title: opts.title ?? 'watch the agent cook',
    now: Date.now(),
    redacted: redact,
    control: v.control,
    screen: { screen: s.screen, selectedMint: mask(s.selectedMint), feed: s.feed, filter: s.filter, highlight: mask(s.highlight) },
    agents: v.agents.map((a) => ({ name: a.name, tier: a.tier, status: a.status, lastAt: a.lastAt })),
    activity: v.activity.map((ev) => activityVM(redact ? redactSpectatorEvent(ev) : ev)),
  };
}

/** Apply a validated spectator popup event to the follow controller. Returns a short log line. */
export function applySpectatorEvent(follow: FollowController, name: string, agent: string): string {
  switch (name) {
    case 'spectator.pause': return follow.pause(agent);
    case 'spectator.resume': return follow.resume(agent);
    case 'spectator.takeover': return follow.takeOver(agent);
    case 'spectator.kill': return follow.kill(agent);
    default: return `ignored ${name}`;
  }
}
