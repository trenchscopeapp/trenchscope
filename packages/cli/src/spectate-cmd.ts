// `trenchscope spectate …` — watch an agent drive trenchscope (task-1406, "watch the agent cook").
//
//   trenchscope spectate --replay FILE [--json]   replay a saved session file (demos + bug reports): fold the
//                                             recorded agent actions into the screen model + activity panel
//   trenchscope spectate --info [--json]          show the live spectator stream endpoint (loopback + token)
//                                             from ~/.dexterm/spectator.json, if a session is streaming
//
// Replay is deterministic and offline. The live stream itself is started by `trenchscope agent serve --spectate`;
// it is read-only, loopback-only and token-gated, and redacts wallet addresses/keys (see SPECTATOR.md).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FollowController, loadSpectatorRecording, type FollowView, type SpectatorEvent } from '@dexterm/agents';
import type { Io } from './main.ts';

function flag(rest: string[], name: string): string | undefined { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; }
function has(rest: string[], name: string): boolean { return rest.includes(name); }

const USAGE = `trenchscope spectate <command>
  --replay FILE [--json]   replay a saved session (fold agent actions into the screen + activity panel)
  --info [--json]          show the live stream endpoint from ~/.dexterm/spectator.json (if streaming)
read-only · redacts wallet addresses/keys · the live stream is started by \`trenchscope agent serve --spectate\`
or by a running app in follow mode (\`trenchscope --spectate-mcp\`, for an agent connected over MCP)
Full docs: https://dexterm.xyz/docs/spectator/`;

/**
 * Where `agent serve --spectate` writes its discovery file: the same rule as the writer (@dexterm/agents
 * `dextermHome`), so a blank DEXTERM_HOME falls back and a missing HOME (Windows) does not turn into a
 * relative `.dexterm` under the current directory.
 */
export function spectatorInfoPath(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const dir = env.DEXTERM_HOME && env.DEXTERM_HOME.trim() ? env.DEXTERM_HOME : join(home, '.dexterm');
  return join(dir, 'spectator.json');
}

function ago(t: number): string { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; }
function age(s: number | null | undefined): string { if (s == null) return ''; return s < 60 ? ` · ${Math.round(s)}s old` : s < 3600 ? ` · ${Math.floor(s / 60)}m old` : ` · ${Math.floor(s / 3600)}h old`; }

function renderView(view: FollowView, meta: { redacted: boolean }, out: (s: string) => void): void {
  const s = view.screen;
  out('SCREEN');
  const bits = [`screen ${s.screen}`];
  if (s.selectedMint) bits.push(`token ${s.selectedMint}`);
  if (s.feed) bits.push(`feed ${s.feed}`);
  if (s.filter) bits.push(`filter ${s.filter}`);
  if (s.highlight) bits.push(`★ ${s.highlight}`);
  if (s.watchlist.length) bits.push(`watchlist ${s.watchlist.length}`);
  out(`  ${bits.join(' · ')}`);
  if (view.control === 'user') out('  YOU HAVE TAKEN OVER (agent frozen)');
  out('');
  out('AGENTS');
  if (!view.agents.length) out('  (none)');
  for (const a of view.agents) out(`  [agent] ${a.name}  ${a.tier ?? '—'}  ${a.status}  · ${ago(a.lastAt)}`);
  out('');
  out(`ACTIVITY (${view.activity.length}${meta.redacted ? ' · redacted' : ' · full'})`);
  for (const ev of view.activity) {
    const ms = ev.ms != null ? ` ${Math.round(ev.ms)}ms` : '';
    out(`  ${ago(ev.t).padStart(4)}  [agent] ${ev.agent}  ${ev.phase.padEnd(8)} ${(ev.tool ?? '').padEnd(16)} ${ev.summary ?? ''}${ms}${age(ev.dataAgeSec)}`);
  }
}

export async function runSpectate(rest: string[], io: Io): Promise<number> {
  const out = (s: string) => io.stdout.write(s + '\n');
  const errOut = (s: string) => io.stderr.write(s + '\n');

  const replayFile = flag(rest, '--replay');
  if (replayFile) {
    let recording;
    try { recording = loadSpectatorRecording(replayFile); }
    catch (e) { errOut(`trenchscope spectate: cannot read ${replayFile}: ${(e as Error).message}`); return 1; }
    const follow = new FollowController({ activityCap: 500 });
    for (const ev of recording.events) follow.apply(ev as SpectatorEvent);
    if (has(rest, '--json')) { out(JSON.stringify({ meta: recording.meta, view: follow.view() })); return 0; }
    out(`replaying ${recording.events.length} event(s) from ${replayFile}${recording.meta.redacted ? ' (redacted)' : ''}`);
    out('');
    renderView(follow.view(), recording.meta, out);
    return 0;
  }

  if (has(rest, '--info')) {
    const path = spectatorInfoPath(io.env);
    let info: Record<string, unknown>;
    try { info = JSON.parse(readFileSync(path, 'utf8')); }
    catch { errOut('no live spectator stream (start one with `trenchscope agent serve --spectate`).'); return 1; }
    if (has(rest, '--json')) { out(JSON.stringify(info)); return 0; }
    out(`live spectator stream on ws://127.0.0.1:${info.port} (loopback only).`);
    out(`token is in ${path} (mode 0600) — pass it in the viewer's hello; never on a command line.`);
    out('the stream is read-only and redacts wallet addresses/keys.');
    return 0;
  }

  if (rest.length && !rest[0].startsWith('--')) { errOut(`trenchscope spectate: unknown subcommand ${JSON.stringify(rest[0])}`); errOut(USAGE); return 2; }
  out(USAGE);
  return rest.length ? 2 : 0;
}
