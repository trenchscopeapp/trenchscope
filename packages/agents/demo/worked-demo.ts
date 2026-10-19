// Tier 6 (task-1345): the WORKED DEMO on fixtures — capture-ready for the agents film (task-1344).
//
// Three actors share one running dexterm (fixture data, offline, no wallets, no mainnet, no network for the
// bus parts):
//
//   1. claude-code OVER MCP — spawns the real `dexterm mcp` stdio server (the exact transport a Claude Code
//      client uses), does the MCP handshake, lists the agent-pack PROMPTS, fetches the `trench-scan` skill
//      playbook and reads a case-file RESOURCE. It then runs that trench-scan playbook over the agent bus's
//      fixture dataset and prints a grounded verdict (every number tagged to the tool + field it came from).
//
//   2. scanbot — a CUSTOM agent on the loopback bus (the shipped TS SDK). It subscribes to the live stream,
//      and when an alert arrives it creates a propose_alert PROPOSAL, labelled "scanbot", that the user must
//      confirm with a keypress. It can never arm, size, sign or send anything.
//
//   3. redteam — a simulated MALICIOUS agent that tries to escalate, exfiltrate and run financial actions.
//      Every attempt is refused by the gate, with the refusal code shown.
//
// Finally the demo prints the agent ROSTER (who is connected, their tier, reads/proposals), the PROPOSALS
// (labelled with the agent that made each), and the tail of the AUDIT log.
//
// Run it:  node packages/agents/demo/worked-demo.ts            (full demo incl. the live MCP child)
//          node packages/agents/demo/worked-demo.ts --no-mcp   (bus-only; what the test runs)
// Running directly writes a normalised, capture-ready transcript + evidence JSON next to this file.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  AgentBus, AgentRegistry, MemoryAuditLog, FixtureExecutor, FixtureFeed, MemoryProposalStore,
} from '../src/index.ts';
import { DextermAgent } from '../src/sdk.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..', '..', '..');
const MINTS = {
  TROLL: 'FixtMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  MOONER: 'FixtMintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  RUGME: 'FixtMintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
  GIGA: 'FixtMintDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
};

/** A tiny line sink so the demo both prints live and captures a transcript to save. */
export class Transcript {
  readonly lines: string[] = [];
  private readonly echo: boolean;
  constructor(echo: boolean) { this.echo = echo; }
  log(s = ''): void { this.lines.push(s); if (this.echo) process.stdout.write(s + '\n'); }
  section(title: string): void { this.log(''); this.log(`${'─'.repeat(78)}`); this.log(title); this.log(`${'─'.repeat(78)}`); }
  /** Normalise volatile tokens (ports, timestamps, random ids) so the saved transcript is stable. */
  normalised(): string {
    return this.lines.join('\n')
      .replace(/ws:\/\/127\.0\.0\.1:\d+/g, 'ws://127.0.0.1:<port>')
      .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, '<ts>')
      .replace(/prop_[a-z0-9_]+/g, 'prop_<id>')
      .replace(/sess_[a-z0-9]+/g, 'sess_<id>')
      .replace(/"t":\d+/g, '"t":<t>')
      .replace(/"(createdAt|openedAt|lastActivity|now)":\d+/g, '"$1":<t>') + '\n';
  }
}

// ---------------------------------------------------------------------------------------------------
// Actor 1 (part A): the MCP agent-pack showcase over the REAL stdio server a Claude Code client uses.
interface McpShowcase { serverInfo: string; prompts: string[]; trenchScan: string; resources: number; sampleCase: string }

export async function mcpPackShowcase(replayFixture: string): Promise<McpShowcase> {
  const child = spawn('node', [join(APP_ROOT, 'packages/mcp/bin/dexterm-mcp.mjs'), '--replay', replayFixture], { stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map<number, Record<string, unknown>>();
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { const m = JSON.parse(l) as { id?: number } & Record<string, unknown>; if (typeof m.id === 'number') replies.set(m.id, m); } } });
  const send = (o: Record<string, unknown>) => child.stdin.write(JSON.stringify(o) + '\n');
  const waitFor = async (id: number, ms = 4000): Promise<Record<string, unknown>> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (replies.has(id)) return replies.get(id)!.result as Record<string, unknown> ?? replies.get(id)!; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error(`MCP child did not answer id ${id}`);
  };
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const init = await waitFor(1);
    send({ jsonrpc: '2.0', id: 2, method: 'prompts/list' });
    const promptsR = await waitFor(2);
    send({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'trench-scan', arguments: { limit: '8' } } });
    const trench = await waitFor(3);
    send({ jsonrpc: '2.0', id: 4, method: 'resources/list' });
    const resR = await waitFor(4);
    const firstCase = (resR.resources as Array<{ uri: string }>).find((r) => r.uri.startsWith('dexterm://case/'));
    let sampleCase = '(no case resource)';
    if (firstCase) { send({ jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: firstCase.uri } }); const r = await waitFor(5); sampleCase = firstCase.uri; void r; }
    const promptText = ((trench.messages as Array<{ content?: { text?: string } }>)?.[0]?.content?.text) ?? '';
    return {
      serverInfo: `${(init.serverInfo as { name?: string })?.name}@${(init.serverInfo as { version?: string })?.version}`,
      prompts: (promptsR.prompts as Array<{ name: string }>).map((p) => p.name),
      trenchScan: promptText,
      resources: (resR.resources as unknown[]).length,
      sampleCase,
    };
  } finally {
    child.stdin.end(); child.kill();
  }
}

// ---------------------------------------------------------------------------------------------------
// Actor 1 (part B): run the trench-scan playbook over the bus fixtures and produce a grounded verdict.
interface Candidate { mint: string; symbol: string; verdict: string; strongest: string }
interface ScanResult { skill: string; scanned: number; skipped: Array<{ mint: string; reason: string }>; candidates: Candidate[]; proposal?: Record<string, unknown> }

export async function runTrenchScan(url: string, token: string, t: Transcript): Promise<ScanResult> {
  const cc = await DextermAgent.connect({ name: 'claude-code', token, url, client: 'claude-code 2.1 (MCP)' });
  t.log('claude-code connected over the bus — tier ' + cc.hello?.tier + ' (runs the trench-scan skill it received over MCP).');
  const q = await cc.call('screener_query', { preset: 'new', limit: 8 });
  const rows = (q.rows as Array<Record<string, unknown>>) ?? [];
  t.log(`[tool] screener_query{preset:new} -> ${rows.length} rows (source: screener_query.rows)`);
  const skipped: ScanResult['skipped'] = [];
  const keep: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const a = (r.audit as Record<string, unknown>) ?? {};
    if (a.freezeAuthority === true || a.mintAuthority === true) { skipped.push({ mint: String(r.mint), reason: `mint/freeze authority live (rugcheck/audit)` }); continue; }
    if (Number(a.lpLockedPct) < 100 && r.launchpad !== 'pump.fun') { skipped.push({ mint: String(r.mint), reason: 'LP not fully locked off pump.fun' }); continue; }
    if (Number(r.liquidityUsd) < 5000) { skipped.push({ mint: String(r.mint), reason: 'liquidity under $5k' }); continue; }
    keep.push(r);
  }
  const candidates: Candidate[] = [];
  for (const r of keep.slice(0, 4)) {
    const rc = await cc.call('rugcheck', { mint: r.mint });
    const flags = ((rc.risks as unknown[]) ?? []).length;
    const ageSec = Number((r as { tokenAgeSec?: number }).tokenAgeSec ?? 99999);
    const organic = Number(r.organicScore ?? 0);
    const verdict = ageSec < 600 ? 'INSUFFICIENT_DATA' : flags === 0 && organic >= 70 ? 'WATCH' : flags <= 1 ? 'SPECULATIVE' : 'AVOID';
    candidates.push({ mint: String(r.mint), symbol: String(r.symbol), verdict, strongest: `organicScore ${organic} (screener_query.organicScore), rugScore ${(rc.scoreNormalised as number)} (rugcheck.scoreNormalised), ${flags} risk flags` });
    t.log(`[tool] rugcheck{${String(r.mint).slice(0, 6)}…} -> score ${rc.scoreNormalised}, ${flags} risks -> ${verdict}`);
  }
  // rank: fewest flags, then organic score
  candidates.sort((a, b) => (a.verdict === 'WATCH' ? -1 : 1) - (b.verdict === 'WATCH' ? -1 : 1));
  const result: ScanResult = { skill: 'trench-scan', scanned: rows.length, skipped, candidates };
  // claude-code proposes a WATCH alert on the best candidate — a PROPOSAL the user confirms, never armed.
  const best = candidates.find((c) => c.verdict === 'WATCH');
  if (best) {
    const p = await cc.propose('propose_alert', { mint: best.mint, when: 'mcap crosses 10M', note: `trench-scan WATCH: ${best.strongest}`, idempotency_key: 'trench-watch-best' });
    result.proposal = p.proposal as Record<string, unknown>;
    t.log(`[propose] claude-code -> propose_alert ${best.symbol} (armed=${(p.proposal as { armed: boolean }).armed}) — a DRAFT the user confirms with a keypress`);
  }
  cc.close();
  return result;
}

// ---------------------------------------------------------------------------------------------------
// Actor 2: a custom bring-your-own agent subscribes to the stream and proposes an alert on a signal.
export async function runCustomAgent(url: string, token: string, feed: FixtureFeed, t: Transcript): Promise<Record<string, unknown>> {
  const bot = await DextermAgent.connect({ name: 'scanbot', token, url, client: 'my-ts-bot 1.0' });
  t.log('scanbot connected — tier ' + bot.hello?.tier + ' (custom TS SDK agent).');
  const alerts: Array<Record<string, unknown>> = [];
  bot.on('alerts', (ev) => alerts.push(ev.data));
  await bot.subscribe(['new_pairs', 'trades', 'alerts']);
  t.log('[stream] scanbot subscribed to new_pairs, trades, alerts');
  // the running dexterm emits a (server-authored, firewalled) alert; scanbot reacts to it
  feed.emit('new_pairs', { mint: MINTS.TROLL, symbol: 'TROLL', launchpad: 'pump.fun', ageSec: 5 });
  feed.emit('alerts', { mint: MINTS.GIGA, kind: 'volume_spike', note: 'GIGA volume spiked' });
  await new Promise((r) => setTimeout(r, 60));
  t.log(`[stream] scanbot received ${alerts.length} alert event(s); acting on the volume spike`);
  const p = await bot.propose('propose_alert', { mint: MINTS.GIGA, when: 'price +20% in 15m', note: 'auto: reacted to a volume_spike stream event', idempotency_key: 'scanbot-giga-spike' });
  t.log(`[propose] scanbot -> propose_alert GIGA (armed=${(p.proposal as { armed: boolean }).armed}) labelled "${(p.proposal as { agentName: string }).agentName}"`);
  bot.close();
  return p.proposal as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------------
// Actor 3: the malicious agent fails every escalation.
export async function runMalicious(url: string, token: string, t: Transcript): Promise<Array<{ attempt: string; refused: boolean; code: string }>> {
  const rt = await DextermAgent.connect({ name: 'redteam', token, url, client: 'definitely-friendly 1.0' });
  t.log('redteam connected — tier ' + rt.hello?.tier + ' (simulated compromised agent).');
  const out: Array<{ attempt: string; refused: boolean; code: string }> = [];
  const tries: Array<[string, Record<string, unknown>]> = [
    ['arm_plan', { mint: MINTS.GIGA }], ['sign_tx', {}], ['raise_cap', { to: 999 }], ['set_tier', { tier: 'admin' }],
    ['wallet_export', {}], ['read_key', {}], ['open_ticket', { mint: MINTS.GIGA, side: 'buy' }],
    ['screener_query', { preset: 'new', tier: 'propose' }],
  ];
  for (const [tool, args] of tries) {
    try { await rt.call(tool, args); out.push({ attempt: tool, refused: false, code: 'ALLOWED!' }); }
    catch (e) { const code = (e as Error & { data?: { code?: string } }).data?.code ?? 'error'; out.push({ attempt: tool, refused: true, code }); }
  }
  for (const r of out) t.log(`[malicious] ${r.attempt.padEnd(16)} -> ${r.refused ? 'REFUSED' : 'ALLOWED!!'} (${r.code})`);
  rt.close();
  return out;
}

// ---------------------------------------------------------------------------------------------------
export interface DemoResult { scan: ScanResult; custom: Record<string, unknown>; malicious: Array<{ attempt: string; refused: boolean; code: string }>; roster: unknown; proposals: unknown; mcp?: McpShowcase }

export async function runDemo(opts: { withMcp: boolean; echo?: boolean }): Promise<{ result: DemoResult; transcript: Transcript }> {
  const t = new Transcript(opts.echo ?? false);
  const registry = new AgentRegistry({ path: ':memory:' });
  const audit = new MemoryAuditLog();
  const executor = new FixtureExecutor();
  const proposals = new MemoryProposalStore();
  const feed = new FixtureFeed();
  const bus = new AgentBus({ registry, audit, executor, proposals, feed, discoveryPath: null });
  const port = await bus.start();
  const url = `ws://127.0.0.1:${port}`;
  const tokens = {
    cc: registry.add('claude-code', 'propose', { note: 'Claude Code over MCP' }).token,
    bot: registry.add('scanbot', 'propose', { note: 'custom TS stream bot' }).token,
    rt: registry.add('redteam', 'propose', { note: 'red-team / simulated compromise' }).token,
  };

  t.log('dexterm bring-your-own-agent — worked demo (fixtures, offline). No wallets, no mainnet.');
  t.log(`agent bus listening on ${url} · ${registry.list().length} registered agents`);

  let mcp: McpShowcase | undefined;
  if (opts.withMcp) {
    t.section('ACTOR 1a — Claude Code connects OVER MCP and receives the agent packs');
    mcp = await mcpPackShowcase(join(APP_ROOT, 'packages/data/fixtures/task-1298-sample.json'));
    t.log(`MCP server: ${mcp.serverInfo}`);
    t.log(`skills offered as MCP prompts (agent packs): ${mcp.prompts.join(', ')}`);
    t.log(`MCP resources (KB + cases + skills): ${mcp.resources}; read case resource: ${mcp.sampleCase}`);
    t.log('trench-scan skill playbook received over MCP (first lines):');
    for (const line of mcp.trenchScan.split('\n').slice(0, 6)) t.log('  | ' + line);
    t.log('  | …');
  }

  t.section('ACTOR 1b — claude-code runs the trench-scan skill on the fixture dataset');
  const scan = await runTrenchScan(url, tokens.cc, t);
  t.log('verdict JSON:');
  t.log('  ' + JSON.stringify({ skill: scan.skill, scanned: scan.scanned, skipped: scan.skipped.length, candidates: scan.candidates }));

  t.section('ACTOR 2 — a custom TS agent subscribes to the stream and proposes an alert');
  const custom = await runCustomAgent(url, tokens.bot, feed, t);

  t.section('ACTOR 3 — a malicious agent fails every escalation / exfiltration / financial attempt');
  const malicious = await runMalicious(url, tokens.rt, t);
  t.log(`all ${malicious.length} malicious attempts refused: ${malicious.every((m) => m.refused)}`);

  t.section('ROSTER — who is connected, their tier, and what they did');
  // reconnect the three so the roster snapshot shows live sessions
  const live = await Promise.all([
    DextermAgent.connect({ name: 'claude-code', token: tokens.cc, url, client: 'claude-code 2.1 (MCP)' }),
    DextermAgent.connect({ name: 'scanbot', token: tokens.bot, url, client: 'my-ts-bot 1.0' }),
  ]);
  const roster = bus.roster().map((r) => ({ name: r.name, tier: r.tier, sessions: r.sessions, client: r.client, reads: r.usage.readsPerMin, proposals: r.counts.proposals, refused: r.counts.refused }));
  for (const r of roster) t.log(`  ${r.name.padEnd(12)} tier=${r.tier.padEnd(8)} sessions=${r.sessions} reads/min=${r.reads} proposals=${r.proposals} refused=${r.refused}  (${r.client})`);
  for (const a of live) a.close();

  t.section('PROPOSALS — every one labelled with the agent that made it, none armed');
  const propList = proposals.list({ limit: 20 });
  for (const p of propList) t.log(`  [${p.agentName}] ${p.kind.padEnd(10)} ${p.summary}  (armed=${p.armed}, status=${p.status})`);
  t.log(`proposals are DRAFTS; an agent can never confirm or arm one — the user confirms with a keypress.`);

  t.section('AUDIT — tail of the shared audit log (every connect / call / refusal / proposal)');
  for (const r of audit.recent(14).reverse()) t.log(`  ${r.agentName.padEnd(12)} ${r.kind.padEnd(10)} ${r.tool.slice(0, 16).padEnd(16)} ${r.ok ? 'ok ' : 'no '} ${r.detail.slice(0, 60)}`);

  await bus.close();
  const result: DemoResult = { scan, custom, malicious, roster, proposals: propList, mcp };
  return { result, transcript: t };
}

// ---------------------------------------------------------------------------------------------------
const INVOKED_DIRECTLY = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED_DIRECTLY) {
  const withMcp = !process.argv.includes('--no-mcp');
  runDemo({ withMcp, echo: true }).then(({ result, transcript }) => {
    const txt = join(HERE, 'transcript.txt');
    const ev = join(HERE, 'evidence.json');
    writeFileSync(txt, transcript.normalised());
    writeFileSync(ev, JSON.stringify({
      generatedBy: 'packages/agents/demo/worked-demo.ts',
      note: 'capture-ready fixtures for the agents film (task-1344); offline, no wallets, no mainnet',
      scan: result.scan, custom: result.custom, malicious: result.malicious, roster: result.roster, mcp: result.mcp ? { serverInfo: result.mcp.serverInfo, prompts: result.mcp.prompts, resources: result.mcp.resources } : null,
    }, null, 2) + '\n');
    process.stdout.write(`\nwrote ${txt}\nwrote ${ev}\n`);
    process.exit(0);
  }).catch((e) => { process.stderr.write(`demo failed: ${(e as Error).stack}\n`); process.exit(1); });
}
