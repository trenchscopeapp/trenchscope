// `trenchscope agent …` — bring-your-own-agent registry + loopback bus CLI (task-1345, tier 2).
//
//   trenchscope agent add <name> --tier observe|annotate|propose [--note T] [--reads N] [--proposals N] [--connections N]
//   trenchscope agent list
//   trenchscope agent rotate <name>            # new one-time token; the old one stops working
//   trenchscope agent remove <name>
//   trenchscope agent tier <name> <tier>
//   trenchscope agent pause|resume <name>
//   trenchscope agent audit [--agent NAME] [--limit N]
//   trenchscope agent packs                    # the skills/KB an external agent gets over MCP (agent packs)
//   trenchscope agent serve [--fixtures|--live] [--port N] [--db PATH]   # run a standalone loopback bus
//   trenchscope agent connect --name NAME [--port N] [--url ws://…] [--watch SECONDS]  # token from $DEXTERM_AGENT_TOKEN
//
// A one-time token is printed to stdout by `add`/`rotate` so the user can paste it into THEIR agent's
// config; it is never stored in plaintext and never echoed again. The token for `serve`/`connect` auth is
// read ONLY from the $DEXTERM_AGENT_TOKEN environment variable — never a command-line flag — so it cannot
// leak through a process list. No agent path can arm, sign, send, raise a cap or touch a wallet/mandate.

import {
  AgentRegistry, SqliteAuditLog, MemoryProposalStore, SqliteProposalStore, AgentBus, FixtureExecutor, FixtureFeed,
  SpectatorHub, SpectatorServer, SpectatorRecorder, FollowController,
  TIERS, isTier, type AgentExecutor, type AgentSession, type ProposalStatus, type Tier,
} from '@dexterm/agents';
import { connectAgent } from '@dexterm/agents/sdk';
import { defaultDbPath } from '@dexterm/data';

import type { Io } from './main.ts';

function flag(rest: string[], name: string): string | undefined { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; }
function has(rest: string[], name: string): boolean { return rest.includes(name); }
function intFlag(rest: string[], name: string): number | undefined { const v = flag(rest, name); const n = v === undefined ? undefined : Number(v); return typeof n === 'number' && Number.isFinite(n) ? n : undefined; }

const USAGE = `trenchscope agent <command>
  add <name> --tier observe|annotate|propose [--note T] [--reads N] [--proposals N] [--connections N]
  list | rotate <name> | remove <name> | tier <name> <tier> | pause <name> | resume <name>
  mandate <name> --tools a,b,c | mandate <name> --clear   (narrow an agent to a named set of tools)
  audit [--agent NAME] [--limit N]
  proposals [--agent NAME] [--status pending|confirmed|dismissed] [--limit N] [--db PATH]
  packs
  serve [--fixtures|--live] [--roster] [--spectate] [--spectator-popup] [--record FILE] [--port N] [--db PATH]
  connect --name NAME [--port N] [--url ws://127.0.0.1:PORT] [--watch SECONDS]   (token via $DEXTERM_AGENT_TOKEN)`;

export async function runAgent(rest: string[], io: Io): Promise<number> {
  const cmd = rest[0];
  const out = (s: string) => io.stdout.write(s + '\n');
  const errOut = (s: string) => io.stderr.write(s + '\n');
  const registry = new AgentRegistry({ env: io.env });

  switch (cmd) {
    case 'add': {
      const name = rest[1];
      const tier = flag(rest, '--tier');
      if (!name || !tier || !isTier(tier)) { errOut(`usage: trenchscope agent add <name> --tier ${TIERS.join('|')}`); return 2; }
      const limits = { readsPerMin: intFlag(rest, '--reads'), proposalsPerHour: intFlag(rest, '--proposals'), connections: intFlag(rest, '--connections') };
      try {
        const { agent, token } = registry.add(name, tier as Tier, { note: flag(rest, '--note'), limits });
        out(`registered "${agent.name}" (tier ${agent.tier}, id ${agent.id}).`);
        out('');
        out('  one-time token (shown once — paste it into your agent, do not commit it):');
        out(`  ${token}`);
        out('');
        out(`  your agent authenticates with name="${agent.name}" + this token over the loopback bus or a bridged MCP child.`);
        return 0;
      } catch (e) { errOut(`trenchscope agent add: ${(e as Error).message}`); return 1; }
    }
    case 'list': {
      const list = registry.list();
      if (!list.length) { out('no agents registered. Add one: trenchscope agent add <name> --tier observe'); return 0; }
      out('name                     tier      paused  created              mandate / note');
      for (const a of list) {
        const mandate = a.scope && a.scope.length ? `mandate: ${a.scope.join(',')}` : '';
        const tail = [mandate, a.note ?? ''].filter(Boolean).join(' · ');
        out(`${a.name.padEnd(24)} ${a.tier.padEnd(9)} ${(a.paused ? 'yes' : 'no').padEnd(7)} ${new Date(a.createdAt).toISOString().slice(0, 19)}  ${tail}`);
      }
      return 0;
    }
    case 'rotate': {
      const name = rest[1]; if (!name) { errOut('usage: trenchscope agent rotate <name>'); return 2; }
      try { const token = registry.rotate(name); out(`rotated "${name}". the previous token no longer works.`); out(''); out('  new one-time token (shown once):'); out(`  ${token}`); return 0; }
      catch (e) { errOut(`trenchscope agent rotate: ${(e as Error).message}`); return 1; }
    }
    case 'remove': {
      const name = rest[1]; if (!name) { errOut('usage: trenchscope agent remove <name>'); return 2; }
      out(registry.remove(name) ? `removed "${name}" (its token is now invalid).` : `no agent "${name}".`);
      return 0;
    }
    case 'tier': {
      const name = rest[1]; const tier = rest[2];
      if (!name || !tier || !isTier(tier)) { errOut(`usage: trenchscope agent tier <name> ${TIERS.join('|')}`); return 2; }
      try { registry.setTier(name, tier as Tier); out(`"${name}" is now tier ${tier}.`); return 0; }
      catch (e) { errOut(`trenchscope agent tier: ${(e as Error).message}`); return 1; }
    }
    case 'pause': case 'resume': {
      const name = rest[1]; if (!name) { errOut(`usage: trenchscope agent ${cmd} <name>`); return 2; }
      try { registry.setPaused(name, cmd === 'pause'); out(`"${name}" ${cmd === 'pause' ? 'paused' : 'resumed'} (persisted; a running trenchscope applies it on the agent's next connection).`); return 0; }
      catch (e) { errOut(`trenchscope agent ${cmd}: ${(e as Error).message}`); return 1; }
    }
    case 'mandate': {
      const name = rest[1];
      if (!name) { errOut('usage: trenchscope agent mandate <name> --tools a,b,c | --clear'); return 2; }
      try {
        if (has(rest, '--clear')) { registry.setScope(name, null); out(`cleared the mandate for "${name}" (it may now use its full tier surface).`); return 0; }
        const tools = flag(rest, '--tools');
        if (!tools) { errOut('usage: trenchscope agent mandate <name> --tools a,b,c | --clear'); return 2; }
        const list = tools.split(',').map((t) => t.trim()).filter(Boolean);
        registry.setScope(name, list);
        const rec = registry.get(name)!;
        out(`"${name}" is now mandated to: ${rec.scope!.join(', ')}.`);
        out('the agent can call only these tools (plus agent_whoami); a mandate only narrows the tier, never widens it.');
        return 0;
      } catch (e) { errOut(`trenchscope agent mandate: ${(e as Error).message}`); return 1; }
    }
    case 'audit': {
      const dbPath = flag(rest, '--db') || defaultDbPath(io.env);
      const log = new SqliteAuditLog(dbPath);
      try {
        const agentName = flag(rest, '--agent');
        const rows = log.recent(intFlag(rest, '--limit') ?? 50, agentName ? { agentName } : {});
        if (!rows.length) { out('no audit rows yet.'); return 0; }
        out('time                 agent             kind        tool              ok  detail');
        for (const r of rows.reverse()) out(`${new Date(r.t).toISOString().slice(0, 19)}  ${r.agentName.padEnd(16)} ${r.kind.padEnd(10)} ${r.tool.slice(0, 16).padEnd(16)} ${r.ok ? ' y' : ' n'}  ${r.detail}`);
        return 0;
      } finally { log.close(); }
    }
    case 'packs': {
      const { selfTest } = await import('@dexterm/mcp');
      const st = selfTest();
      out('agent packs served over MCP (`trenchscope mcp`): skills as prompts, KB + cases + skills as resources.');
      out(`  skills   : ${(st.skills as string[]).join(', ')}`);
      out(`  kb       : ${st.kbEntries} entries`);
      // task-1377: the user's overlay (~/.dexterm/kb/entries, ~/.dexterm/skills) is merged into what MCP serves.
      const ov = st.overlay as { kb: { user: number; overridden: number; added: number }; skills: { user: number; overridden: number; added: number } } | undefined;
      if (ov && (ov.kb.user || ov.skills.user)) out(`  yours    : kb +${ov.kb.user} (${ov.kb.overridden} override, ${ov.kb.added} new), skills +${ov.skills.user} (${ov.skills.overridden} override, ${ov.skills.added} new) — \`trenchscope kb|skill list\``);
      out(`  cases    : ${st.cases}`);
      out(`  resources: ${st.resources}`);
      out('connect your agent: `claude mcp add trenchscope -- trenchscope mcp`, then run a skill, e.g. /dexterm:trench-scan 8');
      return 0;
    }
    case 'proposals': {
      const store = new SqliteProposalStore(flag(rest, '--db') || defaultDbPath(io.env));
      try {
        const status = flag(rest, '--status');
        const rows = store.list({ agentId: undefined, status: (status as ProposalStatus) || undefined, limit: intFlag(rest, '--limit') ?? 50 });
        const agent = flag(rest, '--agent');
        const shown = agent ? rows.filter((p) => p.agentName === agent) : rows;
        if (!shown.length) { out('no proposals.'); return 0; }
        out('created              agent             kind        status     summary');
        for (const p of shown) out(`${new Date(p.createdAt).toISOString().slice(0, 19)}  ${p.agentName.padEnd(16)} ${p.kind.padEnd(10)} ${p.status.padEnd(9)}  ${p.summary}`);
        out('');
        out('proposals are DRAFTS. An agent can never confirm or arm one; the user confirms with a keypress.');
        return 0;
      } finally { store.close(); }
    }
    case 'serve': return serve(rest, io, registry);
    case 'connect': return connect(rest, io);
    default:
      (cmd ? errOut(`unknown subcommand: ${cmd}`) : out(USAGE));
      if (!cmd) return 0;
      errOut(USAGE);
      return 2;
  }
}

async function serve(rest: string[], io: Io, registry: AgentRegistry): Promise<number> {
  const live = has(rest, '--live');
  const port = intFlag(rest, '--port');
  const dbPath = flag(rest, '--db');
  const audit = new SqliteAuditLog(dbPath || ':memory:');
  const proposals = dbPath ? new SqliteProposalStore(dbPath) : new MemoryProposalStore();
  const feed = new FixtureFeed();
  let executor: AgentExecutor;
  let dataClose: (() => void) | null = null;
  if (live) {
    // Live reads over the real keyless data layer via the MCP tools; the gate still bounds every call.
    const { McpTools } = await import('@dexterm/mcp');
    const { createDataLayer, resolveRpcUrl, defaultDbPath: ddp } = await import('@dexterm/data');
    const rpc = resolveRpcUrl({ env: io.env });
    const data = createDataLayer({ dbPath: ddp(io.env), rpcUrl: rpc.url, rpcFallbackUrl: rpc.fallbackUrl });
    dataClose = () => data.close();
    const mcp = new McpTools(data, () => ({ screen: 'agent-bus', actions: { mints: [], feeds: [], sortKeys: [] } }));
    executor = { async exec(_s: AgentSession, tool: string, args: Record<string, unknown>) { try { return await mcp.call(tool, args); } catch (e) { return { error: (e as Error).message }; } } };
  } else {
    executor = new FixtureExecutor();
  }
  // task-1406: the spectator hub observes every agent action; it feeds follow mode, the read-only stream
  // and the save file. Created whenever any spectator surface is asked for (cheap; off otherwise).
  const wantSpectate = has(rest, '--spectate');
  const wantRecord = flag(rest, '--record');
  const wantSpectatorPopup = has(rest, '--spectator-popup');
  const hub = (wantSpectate || wantRecord || wantSpectatorPopup) ? new SpectatorHub() : undefined;
  const bus = new AgentBus({ registry, audit, executor, proposals, feed, spectator: hub, port, env: io.env });
  const boundPort = await bus.start();
  feed.start(1500);
  io.stdout.write(`trenchscope agent bus listening on ws://127.0.0.1:${boundPort} (${live ? 'live keyless reads' : 'fixtures'})\n`);
  io.stdout.write(`discovery: ${process.env.DEXTERM_HOME ?? '~/.dexterm'}/agent-bus.json · ${registry.list().length} registered agent(s)\n`);
  io.stdout.write('agents connect with their name + $DEXTERM_AGENT_TOKEN. Ctrl-C to stop.\n');

  // --record FILE: save the session (redacted) for demos / bug reports; replay with `trenchscope spectate --replay`.
  let recorder: SpectatorRecorder | null = null;
  if (hub && wantRecord) {
    try { recorder = new SpectatorRecorder({ path: wantRecord, note: 'trenchscope agent serve' }).attach(hub); io.stdout.write(`recording the session to ${wantRecord} (redacted).\n`); }
    catch (e) { io.stderr.write(`could not record: ${(e as Error).message}\n`); }
  }
  // --spectate: start the read-only, loopback, token-gated spectator stream (SPECTATOR.md).
  let stream: SpectatorServer | null = null;
  if (hub && wantSpectate) {
    stream = new SpectatorServer({ hub, env: io.env });
    const sp = await stream.start();
    io.stdout.write(`spectator stream (read-only) on ws://127.0.0.1:${sp} · token in ${process.env.DEXTERM_HOME ?? '~/.dexterm'}/spectator.json (0600) · redacts addresses/keys\n`);
  }

  // --roster: open the agent roster popup and keep it live. The popup can only send pause/resume/kick.
  let roster: { shutdown: () => Promise<void>; timer: ReturnType<typeof setInterval> } | null = null;
  if (has(rest, '--roster')) {
    try {
      const { createPopupManager } = await import('@dexterm/popup');
      const { buildRosterVM, applyRosterEvent } = await import('./agent-roster.ts');
      const { THEMES, DEFAULT_THEME } = await import('@dexterm/tui');
      const { popupThemeFrom } = await import('./popup.ts');
      const mgr = createPopupManager({ theme: popupThemeFrom(THEMES[DEFAULT_THEME]), env: io.env, onWarn: (m) => io.stderr.write(`roster popup: ${m}\n`),
        onEvent: (ev) => { if (ev.ev === 'popup.event' && ev.name.startsWith('roster.')) io.stdout.write(`roster: ${applyRosterEvent(bus, ev.name, String((ev.payload as { agent?: string }).agent))}\n`); } });
      const handle = await mgr.open({ kind: 'roster', title: 'agents', data: buildRosterVM(bus, audit) });
      const timer = setInterval(() => { try { mgr.setData(handle.id, buildRosterVM(bus, audit)); } catch { /* popup closed */ } }, 1000);
      (timer as { unref?: () => void }).unref?.();
      roster = { shutdown: () => mgr.shutdown(), timer };
      io.stdout.write(`roster popup open (${mgr.native ? 'native window' : 'browser fallback'}).\n`);
    } catch (e) { io.stderr.write(`roster popup unavailable: ${(e as Error).message}\n`); }
  }

  // --spectator-popup: open the spectator popup ("watch the agent cook"), fed by a follow controller that
  // folds the hub's events into the screen model + activity. It sends only spectator.* (pause/takeover/kill).
  let spectatorPopup: { shutdown: () => Promise<void>; timer: ReturnType<typeof setInterval>; off: () => void } | null = null;
  if (hub && wantSpectatorPopup) {
    try {
      const { createPopupManager } = await import('@dexterm/popup');
      const { buildSpectatorVM, applySpectatorEvent } = await import('./agent-spectator.ts');
      const { THEMES, DEFAULT_THEME } = await import('@dexterm/tui');
      const { popupThemeFrom } = await import('./popup.ts');
      const follow = new FollowController({ controls: bus, activityCap: 200 });
      const off = hub.on((ev) => follow.apply(ev));
      const mgr = createPopupManager({ theme: popupThemeFrom(THEMES[DEFAULT_THEME]), env: io.env, onWarn: (m) => io.stderr.write(`spectator popup: ${m}\n`),
        onEvent: (ev) => { if (ev.ev === 'popup.event' && ev.name.startsWith('spectator.')) io.stdout.write(`spectator: ${applySpectatorEvent(follow, ev.name, String((ev.payload as { agent?: string }).agent))}\n`); } });
      const handle = await mgr.open({ kind: 'spectator', title: 'watch the agent cook', data: buildSpectatorVM(follow) });
      const timer = setInterval(() => { try { mgr.setData(handle.id, buildSpectatorVM(follow)); } catch { /* popup closed */ } }, 1000);
      (timer as { unref?: () => void }).unref?.();
      spectatorPopup = { shutdown: () => mgr.shutdown(), timer, off };
      io.stdout.write(`spectator popup open (${mgr.native ? 'native window' : 'browser fallback'}).\n`);
    } catch (e) { io.stderr.write(`spectator popup unavailable: ${(e as Error).message}\n`); }
  }

  await new Promise<void>((resolve) => {
    const stop = () => {
      if (roster) { clearInterval(roster.timer); void roster.shutdown(); }
      if (spectatorPopup) { clearInterval(spectatorPopup.timer); spectatorPopup.off(); void spectatorPopup.shutdown(); }
      recorder?.stop();
      feed.stop(); audit.close(); proposals.close(); dataClose?.();
      void (stream ? stream.close() : Promise.resolve()).then(() => bus.close().then(resolve));
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  });
  return 0;
}

async function connect(rest: string[], io: Io): Promise<number> {
  const name = flag(rest, '--name');
  const token = io.env.DEXTERM_AGENT_TOKEN;
  if (!name) { io.stderr.write('usage: trenchscope agent connect --name NAME [--port N]   (token via $DEXTERM_AGENT_TOKEN)\n'); return 2; }
  if (!token) { io.stderr.write('set $DEXTERM_AGENT_TOKEN to the token from `trenchscope agent add` (never pass a token as a CLI flag).\n'); return 2; }
  const port = intFlag(rest, '--port');
  const url = flag(rest, '--url');
  try {
    const agent = await connectAgent({ name, token, port, url, client: 'trenchscope agent connect', home: io.env.DEXTERM_HOME });
    io.stdout.write(`connected as "${agent.hello?.agent}" — tier ${agent.hello?.tier} (granted ${agent.hello?.grantedTier}).\n`);
    const tools = await agent.listTools();
    io.stdout.write(`tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}\n`);
    const who = await agent.whoami();
    io.stdout.write(`whoami: ${JSON.stringify(who)}\n`);
    const watch = intFlag(rest, '--watch');
    if (watch && watch > 0) {
      await agent.subscribe(['new_pairs', 'trades', 'alerts']);
      agent.on('new_pairs', (ev) => io.stdout.write(`event new_pairs ${JSON.stringify(ev.data)}\n`));
      agent.on('trades', (ev) => io.stdout.write(`event trades ${JSON.stringify(ev.data)}\n`));
      agent.on('alerts', (ev) => io.stdout.write(`event alerts ${JSON.stringify(ev.data)}\n`));
      io.stdout.write(`subscribed; watching for ${watch}s…\n`);
      await new Promise((r) => setTimeout(r, watch * 1000));
    }
    agent.close();
    return 0;
  } catch (e) { io.stderr.write(`trenchscope agent connect: ${(e as Error).message}\n`); return 1; }
}
