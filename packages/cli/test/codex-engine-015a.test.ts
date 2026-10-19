// trenchscope 0.1.5: the analyst on the user's own Codex CLI. Offline: a fake `codex` (an injected child, and a real
// fake binary on PATH like the fake-claude harness). The real CLI is never called here; the real-binary proof
// against a local mock model is test/measure/codex-015a (manual).
import { posixPermissions } from '../../../scripts/test-support.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ANALYST_ACTION_TYPES } from '@dexterm/data';
import { READ_ONLY_TOOLS } from '@dexterm/mcp';
import { runAnalyst, buildArgv, type AnalystHandlers } from '../src/analyst/backend.ts';
import { AnalystSession } from '../src/analyst/session.ts';
import {
  applyCodexEvent, buildCodexArgv, codexAllowedTools, codexFailure, expandSkillPrompt, newCodexTurn, parseEngineChoice,
  resolveEngine, strictSchema, versionAtLeast, CODEX_HARD_DISABLE, CODEX_MCP_ENV,
} from '../src/analyst/codex.ts';
import { ASSETS, PLUGIN_DIR, materializeUserSkill } from '../src/analyst/backend.ts';

const MINT = 'So11111111111111111111111111111111111111112';

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { data: string; end(s?: string): void; on(): void }; kill: () => boolean; killed: boolean; unref(): void };
function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  c.stdin = { data: '', end(s?: string) { this.data += s ?? ''; }, on() {} };
  c.killed = false; c.kill = () => { c.killed = true; return true; }; c.unref = () => {};
  return c;
}
const line = (c: FakeChild, o: unknown): void => { c.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n')); };
function spawnCapture(child: FakeChild) {
  const calls: Array<{ cmd: string; args: string[]; opts: { env: Record<string, string>; cwd: string } }> = [];
  const spawn = ((cmd: string, args: string[], opts: { env: Record<string, string>; cwd: string }) => { calls.push({ cmd, args, opts }); return child; }) as never;
  return { calls, spawn };
}
const flagValues = (argv: string[], f: string): string[] => argv.flatMap((a, i) => a === f ? [argv[i + 1]] : []);
const cfg = (argv: string[], key: string): string | undefined => flagValues(argv, '-c').find((v) => v.startsWith(key + '='))?.slice(key.length + 1);

test('engine choice: explicit wins, auto prefers claude then codex, unknown values are refused', () => {
  assert.equal(resolveEngine('codex', () => false), 'codex');
  assert.equal(resolveEngine('claude', () => false), 'claude');
  assert.equal(resolveEngine('auto', (b) => b === 'codex'), 'codex', 'auto picks codex when only codex is installed');
  assert.equal(resolveEngine('auto', () => true), 'claude', 'auto keeps claude when both are installed');
  assert.equal(resolveEngine(undefined, () => false), 'claude', 'neither installed: claude, whose error explains the install');
  assert.equal(parseEngineChoice(' Codex '), 'codex');
  assert.equal(parseEngineChoice('gpt'), null);
  assert.equal(parseEngineChoice(42), null);
});

test('the codex allowlist is read tools + permitted actions, never a paper/trade tool; scan mode gets no actions', () => {
  const all = codexAllowedTools(undefined);
  for (const t of ANALYST_ACTION_TYPES) assert.ok(all.includes(t), `${t} allowed in a normal session`);
  assert.ok(all.includes('get_dossier') && all.includes('screen_state'));
  assert.ok(!all.some((t) => /^paper_|confirm|sign|send|arm/.test(t)), 'no paper/confirm/sign/send/arm tool');
  const scan = codexAllowedTools([]);
  for (const t of ANALYST_ACTION_TYPES) assert.ok(!scan.includes(t), `${t} excluded in observe-only scan`);
  assert.deepEqual([...scan].sort(), READ_ONLY_TOOLS.filter((t) => !/^paper_/.test(t)).sort());
  assert.deepEqual(codexAllowedTools(['open_token']).filter((t) => (ANALYST_ACTION_TYPES as readonly string[]).includes(t)), ['open_token']);
});

test('the codex argv locks shell/exec/apps/plugins/hooks/agents off, read-only sandbox, approvals never, one allowlisted MCP server', () => {
  const argv = buildCodexArgv({ actionTypes: [] }, { nodePath: '/n/node', mcpBin: '/m/dexterm-mcp.mjs', developerInstructions: 'RULES "quoted"\nline' });
  assert.equal(argv[0], 'exec');
  assert.ok(argv.includes('--json') && argv.includes('--ignore-user-config') && argv.includes('--ignore-rules') && argv.includes('--skip-git-repo-check'));
  assert.deepEqual(flagValues(argv, '--disable').sort(), [...CODEX_HARD_DISABLE].sort());
  for (const f of ['shell_tool', 'unified_exec']) assert.ok(flagValues(argv, '--disable').includes(f), `${f} hard-disabled (fails closed if renamed)`);
  assert.ok(!argv.includes('--dangerously-bypass-approvals-and-sandbox') && !argv.includes('--approve-for-me') && !argv.includes('--add-dir'));
  assert.equal(cfg(argv, 'sandbox_mode'), '"read-only"');
  assert.equal(cfg(argv, 'approval_policy'), '"never"');
  assert.equal(cfg(argv, 'web_search'), '"disabled"');
  assert.equal(cfg(argv, 'agents.enabled'), 'false');
  assert.equal(cfg(argv, 'developer_instructions'), JSON.stringify('RULES "quoted"\nline'));
  assert.equal(cfg(argv, 'mcp_servers.dexterm.command'), '"/n/node"');
  assert.deepEqual(JSON.parse(cfg(argv, 'mcp_servers.dexterm.enabled_tools')!), codexAllowedTools([]));
  assert.deepEqual(JSON.parse(cfg(argv, 'mcp_servers.dexterm.env_vars')!), [...CODEX_MCP_ENV]);
  assert.equal(cfg(argv, 'mcp_servers.dexterm.required'), 'true', 'a dead MCP server fails the run, never a tool-less turn');
  // only the trenchscope server is configured
  assert.deepEqual([...new Set(flagValues(argv, '-c').filter((v) => v.startsWith('mcp_servers.')).map((v) => v.split('.')[1]))], ['dexterm']);
  assert.equal(argv[argv.length - 1], '-', 'the prompt is read from stdin');
  assert.ok(!argv.some((a) => /DEXTERM_ACTION_TOKEN=|DEXTERM_SCREEN_STATE=/.test(a)), 'no env values on argv');
});

test('a resumed codex turn repeats every lock AFTER `resume` (codex ignores exec-level -c ahead of it)', () => {
  const fresh = buildCodexArgv({}, { nodePath: 'node', mcpBin: 'm', developerInstructions: 'x' });
  const res = buildCodexArgv({ resume: 'thread-1' }, { nodePath: 'node', mcpBin: 'm', developerInstructions: 'x' });
  assert.deepEqual(res.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(res.slice(-2), ['thread-1', '-']);
  assert.deepEqual(res.slice(2, -2), fresh.slice(1, -1), 'identical lock flags, all after the subcommand');
});

test('strictSchema: every object closed + fully required, optional fields nullable, meta/unsupported keywords stripped', () => {
  for (const f of ['verdict.schema.json', 'trench-scan.schema.json', 'larp.schema.json']) {
    const s = strictSchema(JSON.parse(fs.readFileSync(path.join(ASSETS, 'schemas', f), 'utf8')));
    const walk = (n: unknown, at: string): void => {
      if (Array.isArray(n)) { n.forEach((x, i) => walk(x, `${at}[${i}]`)); return; }
      if (!n || typeof n !== 'object') return;
      const o = n as Record<string, unknown>;
      for (const k of Object.keys(o)) assert.ok(!k.startsWith('$') && !['minLength', 'maxLength', 'oneOf', 'allOf', 'uniqueItems', 'format'].includes(k), `${f}${at}: ${k} stripped`);
      if (o.properties) {
        assert.equal(o.additionalProperties, false, `${f}${at} closed`);
        assert.deepEqual([...(o.required as string[])].sort(), Object.keys(o.properties as object).sort(), `${f}${at} all required`);
      }
      for (const [k, v] of Object.entries(o)) walk(v, `${at}.${k}`);
    };
    walk(s, '');
  }
  const v = strictSchema(JSON.parse(fs.readFileSync(path.join(ASSETS, 'schemas', 'verdict.schema.json'), 'utf8'))) as { properties: Record<string, { type: unknown; enum?: unknown[] }> };
  assert.deepEqual(v.properties.bias.type, ['string', 'null'], 'optional bias becomes nullable');
  assert.ok(v.properties.bias.enum!.includes(null));
  assert.equal(v.properties.verdict.type, 'string', 'required verdict stays non-null');
});

test('a /dexterm:<skill> prompt expands to the bundled playbook with $ARGUMENTS substituted; plain prose is untouched', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex015a-home-'));
  const env = { ...process.env, DEXTERM_HOME: home };
  const out = expandSkillPrompt(`/dexterm:rug-check ${MINT}\n\nCTX`, PLUGIN_DIR, materializeUserSkill, env);
  assert.match(out, /=== DEXTERM SKILL rug-check/);
  assert.ok(out.includes(`Target: \`${MINT}\``), 'argument substituted');
  assert.ok(!out.includes('$ARGUMENTS') && !/^---\nname:/m.test(out), 'no placeholder or frontmatter left');
  assert.ok(out.endsWith('\n\nCTX'), 'the context block still follows');
  assert.equal(expandSkillPrompt('is this a rug?', PLUGIN_DIR, materializeUserSkill, env), 'is this a rug?');
  assert.equal(expandSkillPrompt('/dexterm:no-such-skill x', PLUGIN_DIR, materializeUserSkill, env), '/dexterm:no-such-skill x');
});

test('a user skill overlay reaches codex firewalled behind the first-party preamble', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex015a-skill-'));
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'rug-check.md'), '---\nname: rug-check\ndescription: my rug check\nversion: 1.0.0\n---\nCall get_dossier for $ARGUMENTS and weigh the LP first.\n');
  const out = expandSkillPrompt(`/dexterm:rug-check ${MINT}`, PLUGIN_DIR, materializeUserSkill, { ...process.env, DEXTERM_HOME: home });
  assert.match(out, /edited by the user/);
  assert.match(out, /<untrusted kind="skill"/);
  assert.match(out, /weigh the LP first/);
});

test('event parser: thread id, allowed tool calls, messages, usage; tripwire on shell / file change / web search / other servers', () => {
  const allowed = codexAllowedTools(undefined);
  const st = newCodexTurn();
  const seen: string[] = [];
  const h = { onSession: (id: string) => seen.push('session:' + id), onToolCall: (n: string) => seen.push('tool:' + n), onMessage: (t: string) => seen.push('msg:' + t) };
  applyCodexEvent(st, { type: 'thread.started', thread_id: 'T1' }, allowed, h);
  applyCodexEvent(st, { type: 'item.completed', item: { type: 'error', message: 'Model metadata for `x` not found' } }, allowed, h);
  applyCodexEvent(st, { type: 'item.started', item: { type: 'mcp_tool_call', server: 'dexterm', tool: 'get_dossier', arguments: { mint: MINT } } }, allowed, h);
  applyCodexEvent(st, { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'dexterm', tool: 'get_dossier', arguments: { mint: MINT }, status: 'completed' } }, allowed, h);
  applyCodexEvent(st, { type: 'item.completed', item: { type: 'reasoning', text: 'hmm' } }, allowed, h);
  applyCodexEvent(st, { type: 'item.completed', item: { type: 'agent_message', text: 'the read' } }, allowed, h);
  applyCodexEvent(st, { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } }, allowed, h);
  assert.deepEqual(seen, ['session:T1', 'tool:get_dossier', 'msg:the read']);
  assert.equal(st.done, true); assert.equal(st.violation, null); assert.deepEqual(st.usage, { input: 10, cachedInput: 2, output: 3 });
  for (const item of [
    { type: 'command_execution', command: 'touch x' },
    { type: 'file_change', changes: [] },
    { type: 'web_search', query: 'x' },
    { type: 'collab_tool_call' },
    { type: 'mcp_tool_call', server: 'other', tool: 'screen_state' },
    { type: 'mcp_tool_call', server: 'dexterm', tool: 'paper_confirm' },
    { type: 'mcp_tool_call', server: 'dexterm', tool: 'open_ticket' },
  ]) {
    const s2 = newCodexTurn();
    applyCodexEvent(s2, { type: 'item.started', item }, codexAllowedTools([]), {});
    assert.ok(s2.violation, `${JSON.stringify(item)} trips the wire`);
  }
});

test('runAnalyst engine:codex spawns `codex` with the lock, the prompt (skill + context) on stdin, the token only in env', async (t) => {
  const child = fakeChild();
  const { calls, spawn } = spawnCapture(child);
  const res: unknown[] = [];
  runAnalyst({ prompt: `/dexterm:rug-check ${MINT}`, schema: 'verdict.schema.json', screenState: { screen: 'token', selected: { mint: MINT, symbol: 'ABC' } }, engine: 'codex' }, { onResult: (r) => res.push(r) }, { spawn });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'codex');
  const argv = calls[0].args;
  const schemaPath = flagValues(argv, '--output-schema')[0];
  assert.ok(schemaPath && fs.existsSync(schemaPath), 'strict schema written to the 0600 temp dir');
  await posixPermissions(t, () => { assert.equal(fs.statSync(schemaPath).mode & 0o777, 0o600); });
  assert.equal(JSON.parse(fs.readFileSync(schemaPath, 'utf8')).additionalProperties, false);
  assert.match(child.stdin.data, /=== DEXTERM SKILL rug-check/);
  assert.match(child.stdin.data, /=== DEXTERM LIVE CONTEXT/);
  assert.match(child.stdin.data, /<untrusted kind="symbol">ABC<\/untrusted>/, 'token text firewalled');
  assert.ok(calls[0].opts.env.DEXTERM_ACTION_TOKEN && calls[0].opts.env.DEXTERM_ACTION_FILE, 'channel env present');
  assert.ok(!argv.join(' ').includes(calls[0].opts.env.DEXTERM_ACTION_TOKEN), 'token never in argv');
  assert.match(cfg(argv, 'developer_instructions')!, /READ-ONLY market analyst/);
  // a structured result
  line(child, { type: 'thread.started', thread_id: 'T-9' });
  line(child, { type: 'turn.started' });
  line(child, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ verdict: 'AVOID', summary: 'a\nb' }) } });
  line(child, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  assert.equal(res.length, 1);
  const r = res[0] as { structured: { verdict: string }; sessionId: string; costUsd: null; isError: boolean };
  assert.equal(r.structured.verdict, 'AVOID'); assert.equal(r.sessionId, 'T-9'); assert.equal(r.costUsd, null); assert.equal(r.isError, false);
  assert.ok(child.killed, 'process released after the turn');
  assert.ok(!fs.existsSync(schemaPath), 'temp dir cleaned');
});

test('runAnalyst engine:codex prose turn streams whole messages; the tripwire kills a shell attempt mid-turn', () => {
  const child = fakeChild();
  const { spawn } = spawnCapture(child);
  const text: string[] = []; const errs: string[] = []; const tools: string[] = [];
  const h: AnalystHandlers = { onText: (t) => text.push(t), onError: (m, d) => errs.push(`${m}|${d}`), onToolCall: (e) => tools.push(e.name) };
  runAnalyst({ prompt: 'why?', screenState: {}, engine: 'codex' }, h, { spawn });
  line(child, { type: 'thread.started', thread_id: 'T' });
  line(child, { type: 'item.started', item: { type: 'mcp_tool_call', server: 'dexterm', tool: 'get_token', arguments: {} } });
  line(child, { type: 'item.completed', item: { type: 'agent_message', text: 'first' } });
  line(child, { type: 'item.started', item: { type: 'command_execution', command: 'rm -rf x' } });
  line(child, { type: 'item.completed', item: { type: 'agent_message', text: 'never seen' } });
  assert.deepEqual(tools, ['get_token']);
  assert.deepEqual(text, ['first']);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /outside the read-only analyst.*command_execution/);
  assert.ok(child.killed);
});

test('runAnalyst engine:codex errors: not installed, not logged in, old codex, turn.failed', () => {
  const cases: Array<[(c: FakeChild) => void, RegExp]> = [
    [(c) => c.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })), /codex not installed\|npm i -g @openai\/codex && codex login/],
    [(c) => { c.stderr.emit('data', Buffer.from('Error: 401 Unauthorized: not logged in\n')); c.emit('close', 1); }, /codex is not logged in\|run `codex login`/],
    [(c) => { c.stderr.emit('data', Buffer.from('Error: Unknown feature flag: shell_tool\n')); c.emit('close', 1); }, /codex version not supported\|update codex/],
    [(c) => { line(c, { type: 'thread.started', thread_id: 'T' }); line(c, { type: 'turn.failed', error: { message: 'model is not supported when using Codex with a ChatGPT account' } }); }, /codex returned an error\|model is not supported/],
  ];
  for (const [drive, re] of cases) {
    const child = fakeChild();
    const { spawn } = spawnCapture(child);
    const errs: string[] = [];
    runAnalyst({ prompt: 'q', screenState: {}, engine: 'codex' }, { onError: (m, d) => errs.push(`${m}|${d}`) }, { spawn });
    drive(child);
    assert.equal(errs.length, 1, String(re));
    assert.match(errs[0], re);
  }
  assert.equal(codexFailure('Reading additional input from stdin...\nboom', 3).message, 'codex exited (3)');
  assert.ok(versionAtLeast('codex-cli 0.163.0', '0.163.0') && versionAtLeast('codex-cli 1.0.2', '0.163.0') && !versionAtLeast('codex-cli 0.98.1', '0.163.0'));
});

test('the claude path is unchanged when no engine (or engine claude) is given', () => {
  for (const engine of [undefined, 'claude'] as const) {
    const child = fakeChild();
    const { calls, spawn } = spawnCapture(child);
    runAnalyst({ prompt: 'q', screenState: {}, ...(engine ? { engine } : {}) }, {}, { spawn });
    assert.equal(calls[0].cmd, 'claude');
    assert.deepEqual(calls[0].args.slice(0, 2), ['-p', 'q']);
    assert.ok(calls[0].args.includes('--strict-mcp-config'));
  }
  assert.deepEqual(buildArgv({ prompt: 'q', screenState: {} }, '/m.json').slice(0, 2), ['-p', 'q']);
});

test('AnalystSession on codex: footer says codex, the follow-up resumes the codex thread, observe-only scan is enforced', () => {
  const children: FakeChild[] = [];
  const argvs: string[][] = [];
  const spawn = ((cmd: string, args: string[]) => { assert.equal(cmd, 'codex'); argvs.push(args); const c = fakeChild(); children.push(c); return c; }) as never;
  const s = new AnalystSession({ skill: 'rug-check', mint: MINT, symbol: 'ABC', screenState: {}, engine: 'codex', actionTypes: [], scan: true }, () => {}, { spawn });
  assert.match(s.footer, /^codex exec/);
  s.start();
  line(children[0], { type: 'thread.started', thread_id: 'TH' });
  line(children[0], { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ verdict: 'WATCH', summary: 'one', flags: null, proposals: null, candidates: null, key_levels: null }) } });
  line(children[0], { type: 'turn.completed' });
  assert.equal(s.status, 'done'); assert.equal(s.verdict, 'WATCH'); assert.deepEqual(s.flags, []); assert.deepEqual(s.proposals, []);
  assert.match(s.footer, /^codex plan · /);
  assert.equal(s.sessionId, 'TH');
  s.ask('and the LP?');
  assert.deepEqual(argvs[1].slice(0, 2), ['exec', 'resume']);
  assert.equal(argvs[1][argvs[1].length - 2], 'TH');
  for (const a of argvs) {
    const tools = JSON.parse(cfg(a, 'mcp_servers.dexterm.enabled_tools')!);
    for (const t of ANALYST_ACTION_TYPES) assert.ok(!tools.includes(t), `scan turn never offers ${t}`);
  }
});

// ---- a real fake `codex` process (like the fake-claude harnesses): the action channel round-trips. The script runs
// through Node because Windows does not execute a Unix shebang; argv, pipes, env and exit still go through a real spawn.
test('fake codex binary: real spawn, argv + stdin captured, an allowed UI action reaches the app over the channel', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex015a-fakebin-'));
  const log = path.join(dir, 'log.json');
  const script = path.join(dir, 'codex.cjs');
  fs.writeFileSync(script, `const fs = require('fs');
let stdin = '';
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const ss = JSON.parse(process.env.DEXTERM_SCREEN_STATE || '{}');
  const mint = ss.selected && ss.selected.mint;
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin, hasToken: !!process.env.DEXTERM_ACTION_TOKEN }));
  const file = process.env.DEXTERM_ACTION_FILE, token = process.env.DEXTERM_ACTION_TOKEN;
  if (file && token && mint) fs.appendFileSync(file, JSON.stringify({ v: 1, token, seq: 1, ts: Date.now(), action: { type: 'open_token', mint } }) + '\\n');
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  say({ type: 'thread.started', thread_id: 'fake-thread' });
  say({ type: 'turn.started' });
  say({ type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'dexterm', tool: 'open_token', arguments: { mint }, status: 'in_progress' } });
  say({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'putting it on your screen' } });
  say({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 2 } });
});
`);
  const viaNode = ((cmd: string, args: readonly string[], opts: childProcess.SpawnOptions) =>
    childProcess.spawn(cmd === 'codex' ? process.execPath : cmd, cmd === 'codex' ? [script, ...args] : [...args], opts)) as typeof childProcess.spawn;
  {
    const actions: Record<string, unknown>[] = [];
    const result = await new Promise<{ text: string; tools: string[] }>((resolve, reject) => {
      let text = ''; const tools: string[] = [];
      const t = setTimeout(() => reject(new Error('timeout')), 15000);
      runAnalyst({ prompt: 'put it on my screen', screenState: { screen: 'screener', selected: { mint: MINT, symbol: 'ABC' }, actions: { mints: [MINT] } }, engine: 'codex' }, {
        onText: (d) => { text += d; }, onToolCall: (e) => tools.push(e.name), onAction: (e) => actions.push(e.action),
        onResult: () => { clearTimeout(t); resolve({ text, tools }); }, onError: (m, d) => { clearTimeout(t); reject(new Error(`${m}: ${d}`)); },
      }, { spawn: viaNode });
    });
    assert.equal(result.text, 'putting it on your screen');
    assert.deepEqual(result.tools, ['open_token']);
    assert.deepEqual(actions, [{ type: 'open_token', mint: MINT }], 'the authenticated channel line was dispatched');
    const seen = JSON.parse(fs.readFileSync(log, 'utf8')) as { argv: string[]; stdin: string; hasToken: boolean };
    assert.equal(seen.argv[0], 'exec');
    assert.ok(seen.hasToken);
    assert.match(seen.stdin, /put it on my screen/);
    assert.match(seen.stdin, /ANSWER LENGTH: SHORT/);
  }
});

// ---- wiring: flag, env/config order, /engine, doctor, config policy
test('--analyst-engine parses auto|claude|codex and rejects anything else', async () => {
  const { parseArgs } = await import('../src/main.ts');
  assert.equal(parseArgs(['--analyst-engine', 'codex']).analystEngine, 'codex');
  assert.equal(parseArgs([]).analystEngine, null);
  assert.throws(() => parseArgs(['--analyst-engine', 'gpt']), /unknown analyst engine gpt/);
});

test('analystEngineFor: flag > DEXTERM_ANALYST_ENGINE > config analyst.engine > auto', async () => {
  const { analystEngineFor } = await import('../src/main.ts');
  const both = () => true;
  assert.equal(analystEngineFor('codex', { DEXTERM_ANALYST_ENGINE: 'claude' }, 'claude', both), 'codex');
  assert.equal(analystEngineFor(null, { DEXTERM_ANALYST_ENGINE: 'codex' }, 'claude', both), 'codex');
  assert.equal(analystEngineFor(null, {}, 'codex', both), 'codex');
  assert.equal(analystEngineFor(null, {}, null, both), 'claude');
  assert.equal(analystEngineFor(null, { DEXTERM_ANALYST_ENGINE: 'nonsense' }, null, (b) => b === 'codex'), 'codex', 'bad env value falls through to auto');
});

test('/engine shows and switches the engine for new conversations; refuses a missing CLI; never reaches a model', async () => {
  const { parseEngineCommand, engineCommand } = await import('../src/main.ts');
  assert.equal(parseEngineCommand('what is /engine'), null);
  assert.deepEqual(parseEngineCommand('/engine'), { show: true });
  assert.deepEqual(parseEngineCommand('/engine CODEX'), { choice: 'codex' });
  assert.ok('error' in (parseEngineCommand('/engine gpt') as object));
  const idle = new AnalystSession({ skill: 'rug-check', mint: MINT, screenState: {} }, () => {});
  idle.status = 'done';
  const state = { analystEngine: 'claude', analyst: idle, analystByMint: new Map([[MINT, idle]]) } as never as Parameters<typeof engineCommand>[0];
  assert.match(engineCommand(state, { show: true }, {}, () => true), /analyst engine: claude · installed: claude \+ codex/);
  assert.match(engineCommand(state, { choice: 'codex' }, {}, (b) => b === 'claude'), /codex is not installed.*npm i -g @openai\/codex/);
  assert.equal(state.analystEngine, 'claude');
  assert.match(engineCommand(state, { choice: 'codex' }, {}, () => true), /analyst engine: codex \(your own codex CLI and login\)/);
  assert.equal(state.analystEngine, 'codex');
  assert.equal(state.analystByMint!.size, 0, 'idle cached claude chats dropped');
  assert.equal(state.analyst, null);
});

test('createScanSession uses the run engine and stays observe-only on codex', async () => {
  const { createScanSession } = await import('../src/main.ts');
  const { makeFixtureState } = await import('../src/index.ts');
  const st = makeFixtureState({ screen: 'screener' });
  st.analystEngine = 'codex';
  const argvs: Array<{ cmd: string; args: string[] }> = [];
  const s = createScanSession(st, MINT, 'ABC', {}, { spawn: ((cmd: string, args: string[]) => { argvs.push({ cmd, args }); return fakeChild(); }) as never });
  assert.equal(s.engine, 'codex');
  s.ask('quick read');
  assert.equal(argvs[0].cmd, 'codex');
  const tools = JSON.parse(cfg(argvs[0].args, 'mcp_servers.dexterm.enabled_tools')!);
  assert.ok(!tools.some((t: string) => (ANALYST_ACTION_TYPES as readonly string[]).includes(t)));
});

test('doctor: codex row (missing / old / logged out / ready) and claude is optional when codex can run the analyst', async () => {
  const { runDoctor } = await import('../src/index.ts');
  const base = {
    env: { COLORTERM: 'truecolor', TERM: 'xterm-256color', DEXTERM_RPC_URL: 'https://mainnet.helius-rpc.com/' } as NodeJS.ProcessEnv,
    isTTY: true, nodeVersion: '22.18.0', platform: 'darwin' as const, claude: async () => 'ok' as const,
    probe: async () => ({ reachable: true, status: 200, ms: 1 }), checkWritable: () => null, offline: true,
  };
  const row = async (over: object, name = 'Codex CLI') => (await runDoctor({ ...base, ...over } as never)).checks.find((c) => c.name === name);
  assert.equal(await row({}), undefined, 'no probe injected: no row (older callers unchanged)');
  assert.equal((await row({ codex: async () => ({ state: 'missing' }) }))!.status, 'pass');
  const old = (await row({ codex: async () => ({ state: 'present', version: '0.98.0', loggedIn: true }) }))!;
  assert.equal(old.status, 'warn'); assert.match(old.detail, /older than 0\.163\.0/);
  const out = (await row({ codex: async () => ({ state: 'present', version: '0.163.0', loggedIn: false }) }))!;
  assert.equal(out.status, 'warn'); assert.equal(out.fix, 'codex login');
  const ok = (await row({ codex: async () => ({ state: 'present', version: '0.163.0', loggedIn: true }), analystEngine: 'codex' }))!;
  assert.equal(ok.status, 'pass'); assert.match(ok.detail, /analyst engine: codex/);
  const claudeRow = (await row({ claude: async () => 'missing', codex: async () => ({ state: 'present', version: '0.163.0', loggedIn: true }) }, 'Claude CLI'))!;
  assert.equal(claudeRow.status, 'pass'); assert.match(claudeRow.detail, /runs on your codex CLI/);
  const noneRow = (await row({ claude: async () => 'missing', codex: async () => ({ state: 'missing' }) }, 'Claude CLI'))!;
  assert.equal(noneRow.status, 'warn'); assert.match(noneRow.fix!, /codex login/);
});

test('config: analyst.engine validates, and a model can never change /analyst (only the user)', async () => {
  const { validateConfig, policyCheck } = await import('@dexterm/custom');
  assert.deepEqual(validateConfig({ version: 4, analyst: { engine: 'codex' } }), []);
  assert.ok(validateConfig({ version: 4, analyst: { engine: 'gpt' } }).length > 0);
  for (const actor of ['claude', 'jarvis', 'agent:x'] as const) {
    assert.ok(policyCheck([{ op: 'replace', path: '/analyst/engine', value: 'codex' }], actor).some((e) => /only the user/.test(e.msg)), `${actor} refused`);
  }
  assert.deepEqual(policyCheck([{ op: 'replace', path: '/analyst/engine', value: 'codex' }], 'user'), []);
});

test('analystCliOnPath: Windows counts only a spawnable .exe/.com, never an npm .cmd shim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex015a-path-'));
  fs.writeFileSync(path.join(dir, 'codex.cmd'), '');
  return import('../src/analyst/codex.ts').then(({ analystCliOnPath }) => {
    assert.equal(analystCliOnPath('codex', { PATH: dir }, 'win32'), false);
    fs.writeFileSync(path.join(dir, 'codex.exe'), '');
    assert.equal(analystCliOnPath('codex', { PATH: dir }, 'win32'), true);
    fs.writeFileSync(path.join(dir, 'codex'), '');
    // a Windows host's temp dir has a drive-letter colon, which a simulated POSIX ':' split cannot carry
    if (process.platform !== 'win32') assert.equal(analystCliOnPath('codex', { PATH: dir }, 'darwin'), true);
  });
});
