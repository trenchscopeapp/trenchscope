// trenchscope — offline tests for the analyst wiring (task-1302): the claude launch line, the
// screen_state context the MCP server receives, and the session's degrade/verdict parsing.
// No network and no `claude` spawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArgv, buildScreenState, makeFixtureState, AnalystSession, runAnalyst } from '../src/index.ts';

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'claude');

/** A fake `claude` child: EventEmitter with stdout/stderr pipes and a no-op kill, driven by the test. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter; kill: (sig?: string) => boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => true;
  return child;
}

test('buildArgv is the SPEC §5.1 read-only launch line (no tools, strict mcp, plugin dir, json schema)', () => {
  const argv = buildArgv({ prompt: '/dexterm:token-dossier MINT', schema: 'verdict.schema.json', screenState: {} }, '/tmp/mcp.json');
  const flag = (f: string) => argv[argv.indexOf(f) + 1];
  assert.equal(argv[0], '-p');
  assert.equal(flag('--output-format'), 'stream-json');
  assert.equal(flag('--tools'), ''); // built-ins disabled
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.equal(flag('--mcp-config'), '/tmp/mcp.json');
  assert.equal(flag('--allowedTools'), 'mcp__dexterm__*');
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.ok(argv.includes('--plugin-dir'));
  assert.ok(argv.includes('--append-system-prompt-file'));
  // --json-schema carries the verdict schema with its draft-2020-12 meta keys stripped
  const schema = JSON.parse(flag('--json-schema'));
  assert.ok(!('$schema' in schema) && !('$id' in schema), 'meta keys stripped');
  assert.equal(schema.properties.verdict.enum[0], 'WATCH');
});

test('buildArgv loads the larp-check schema (task-1315)', () => {
  const argv = buildArgv({ prompt: '/dexterm:larp-check MINT', schema: 'larp.schema.json', screenState: {} }, '/tmp/mcp.json');
  const flag = (f: string) => argv[argv.indexOf(f) + 1];
  const schema = JSON.parse(flag('--json-schema'));
  assert.ok(!('$schema' in schema) && !('$id' in schema), 'meta keys stripped');
  assert.deepEqual(schema.properties.verdict.enum, ['REAL_PRODUCT', 'EARLY_BUT_REAL', 'NO_PRODUCT_CLAIMED', 'LARP', 'UNVERIFIABLE', 'AMBIGUOUS']);
  assert.ok(schema.required.includes('claims') && schema.required.includes('missing_data'));
});

test('dossier and larp-check separately retain a structured product assessment', () => {
  for (const skill of ['token-dossier', 'larp-check'] as const) {
    const child = fakeChild();
    let prompt = '';
    const s = new AnalystSession({ skill, mint: 'fixture', screenState: {} }, () => {}, {
      spawn: ((_cmd: unknown, args: string[]) => { prompt = args[1]; return child; }) as never,
    });
    s.start();
    assert.match(prompt, /fetch_page/);
    const product = { verdict: 'UNVERIFIABLE', confidence: 0.2, claims: [], missing_data: ['robots denied'] };
    const structured = skill === 'larp-check' ? { skill, ...product } : { skill, verdict: 'WATCH', product_assessment: product };
    child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', structured_output: structured }) + '\n'));
    assert.equal(s.status, 'done');
    assert.deepEqual(s.productAssessment, { verdict: 'UNVERIFIABLE', confidence: 0.2 });
    if (skill === 'token-dossier') assert.equal(s.verdict, 'WATCH');
  }
});

test('a meme that claims no product settles as NO_PRODUCT_CLAIMED, in both schemas (larp-fixes)', () => {
  for (const file of ['larp.schema.json', 'verdict.schema.json']) {
    const schema = JSON.parse(fs.readFileSync(path.join(ASSETS, 'schemas', file), 'utf8'));
    const verdict = file === 'larp.schema.json' ? schema.properties.verdict : schema.properties.product_assessment.properties.verdict;
    assert.ok(verdict.enum.includes('NO_PRODUCT_CLAIMED'), `${file} allows NO_PRODUCT_CLAIMED`);
  }
  const child = fakeChild();
  const s = new AnalystSession({ skill: 'larp-check', mint: 'fixture', screenState: {} }, () => {}, { spawn: (() => child) as never });
  s.start();
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', structured_output: { skill: 'larp-check', verdict: 'NO_PRODUCT_CLAIMED', confidence: 0.7, claims: [], missing_data: [] } }) + '\n'));
  assert.deepEqual(s.productAssessment, { verdict: 'NO_PRODUCT_CLAIMED', confidence: 0.7 });
  const skill = fs.readFileSync(path.join(ASSETS, 'plugin', 'skills', 'larp-check', 'SKILL.md'), 'utf8');
  assert.match(skill, /`NO_PRODUCT_CLAIMED`: the site and socials present a meme/);
  assert.match(skill, /`LARP` \(hard rule\): a big technical claim .* no checkable artifact .* under 7 days old/, 'the core-claim rule ships');
  assert.match(skill, /Check the core claim against one concrete artifact/);
});

test('every proven skill in REGISTRY has a SKILL.md and an on-disk schema (task-1315)', () => {
  const reg = JSON.parse(fs.readFileSync(path.join(ASSETS, 'plugin', 'skills', 'REGISTRY.json'), 'utf8')) as { skills: Array<{ name: string; status: string; schema: string }> };
  const larp = reg.skills.find((s) => s.name === 'larp-check');
  assert.ok(larp && larp.status === 'proven', 'larp-check registered as proven');
  for (const s of reg.skills.filter((x) => x.status === 'proven')) {
    assert.ok(fs.existsSync(path.join(ASSETS, 'plugin', 'skills', s.name, 'SKILL.md')), `${s.name} SKILL.md exists`);
    assert.ok(fs.existsSync(path.join(ASSETS, s.schema)), `${s.name} schema ${s.schema} exists`);
  }
});

test('buildScreenState reports the selected token and visible mints', () => {
  const s = makeFixtureState({ screen: 'screener' });
  const ctx = buildScreenState(s);
  assert.equal(ctx.screen, 'screener');
  assert.ok(Array.isArray(ctx.visibleMints));
  assert.equal(typeof ctx.sort, 'string');
});

test('AnalystSession frames the question per skill and starts in a thinking state', () => {
  const dossier = new AnalystSession({ skill: 'token-dossier', mint: 'MINT', symbol: 'ABC', screenState: {} }, () => {});
  assert.match(dossier.question, /dossier on \$ABC/);
  assert.equal(dossier.status, 'thinking');
  const scan = new AnalystSession({ skill: 'trench-scan', screenState: {} }, () => {});
  assert.match(scan.question, /scan the trending screener/);
  const rug = new AnalystSession({ skill: 'rug-check', mint: 'MINT', symbol: 'ABC', screenState: {} }, () => {});
  assert.match(rug.question, /rug-check \$ABC/);
});

test('AnalystSession (task-1311 DEFECT 1): the first question on a fresh session starts a turn, never queues', () => {
  const child = fakeChild();
  const s = new AnalystSession({ skill: 'trench-scan', screenState: {} }, () => {}, { spawn: (() => child) as never });
  // The old bug: a brand-new session counted as "busy" (status 'thinking') before any turn, so the
  // first ask() queued behind a turn that never started and spun forever. It must SEND instead.
  s.ask('is this a rug?');
  assert.equal(s.queued, null, 'the first question is not left queued');
  assert.equal(s.question, 'is this a rug?', 'the first question becomes the live turn');
  assert.equal(s.busy, true, 'a turn is now genuinely in flight');
});

test('AnalystSession (task-1303): a follow-up asked while a turn is in flight queues; interrupt stops without navigating', () => {
  let changes = 0;
  const child = fakeChild();
  const s = new AnalystSession({ skill: 'rug-check', mint: 'MINT', symbol: 'ABC', screenState: {} }, () => { changes++; }, { spawn: (() => child) as never });
  s.start(); // spawn the (fake) first turn — now a turn is genuinely in flight
  assert.equal(s.busy, true);
  s.ask('what is the biggest red flag?'); // a turn IS running → this follow-up queues
  assert.equal(s.queued, 'what is the biggest red flag?');
  assert.ok(changes >= 1, 'queuing redraws');
  // Esc during a run interrupts and marks the turn; it does not spawn or navigate.
  assert.equal(s.interrupt(), true);
  assert.equal(s.status, 'interrupted');
  assert.equal(s.busy, false);
  assert.equal(s.queued, null, 'interrupt drops the queued follow-up');
  assert.equal(s.interrupt(), false, 'nothing to interrupt when idle');
});

test('runAnalyst (task-1303): stream-json lines buffered after cancel() never dispatch (race closed)', () => {
  const child = fakeChild();
  const calls: string[] = [];
  const results: unknown[] = [];
  const handle = runAnalyst(
    { prompt: 'what changed?', screenState: {}, resume: 'sess-9' },
    {
      onToolCall: (ev) => calls.push(ev.name),
      onResult: (ev) => results.push(ev),
      onError: () => {},
    },
    { spawn: (() => child) as never },
  );
  // A tool call before cancel is delivered normally.
  child.stdout.emit('data', Buffer.from(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__dexterm__get_holders', input: {} }] } }) + '\n',
  ));
  assert.deepEqual(calls, ['get_holders']);
  // Esc interrupts: cancel() settles the turn and kills the process.
  handle.cancel();
  // The killed process still had buffered lines queued — a tool call and a result. Neither may fire.
  child.stdout.emit('data', Buffer.from(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__dexterm__get_price', input: {} }] } }) + '\n' +
    JSON.stringify({ type: 'result', result: '{}', session_id: 'sess-9', is_error: false }) + '\n',
  ));
  assert.deepEqual(calls, ['get_holders'], 'no tool call dispatched after cancel()');
  assert.equal(results.length, 0, 'no result dispatched after cancel()');
});

test('runAnalyst (task-1303 defect #3): streamed text_delta + the final assistant block emit the answer ONCE', () => {
  const child = fakeChild();
  let text = '';
  runAnalyst(
    { prompt: 'what changed?', screenState: {}, resume: 'sess-9' },
    { onText: (d) => { text += d; }, onError: () => {} },
    { spawn: (() => child) as never },
  );
  // --include-partial-messages streams the answer as text_delta events...
  child.stdout.emit('data', Buffer.from(
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } } }) + '\n' +
    JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } } }) + '\n',
  ));
  // ...then the final assistant message repeats the whole text; it must NOT be emitted again.
  child.stdout.emit('data', Buffer.from(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } }) + '\n',
  ));
  assert.equal(text, 'Hello world', 'the answer is delivered once, not doubled');
});

test('runAnalyst (task-1303 defect #3): a turn with no stream deltas still emits the final assistant text', () => {
  const child = fakeChild();
  let text = '';
  runAnalyst(
    { prompt: 'what changed?', screenState: {} },
    { onText: (d) => { text += d; }, onError: () => {} },
    { spawn: (() => child) as never },
  );
  // No partial deltas arrived (e.g. a short non-streamed reply): the final block is the only source.
  child.stdout.emit('data', Buffer.from(
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }) + '\n',
  ));
  assert.equal(text, 'done', 'the final block is emitted when nothing streamed');
});

test('buildArgv (task-1303): a free-text follow-up resumes the session with no --json-schema', () => {
  const argv = buildArgv({ prompt: 'what changed?', screenState: {}, resume: 'sess-123' }, '/tmp/mcp.json');
  assert.ok(!argv.includes('--json-schema'), 'conversational follow-ups answer in prose');
  assert.equal(argv[argv.indexOf('--resume') + 1], 'sess-123');
  assert.ok(!argv.includes('--no-session-persistence'), 'persistence stays on so follow-ups can resume');
});
