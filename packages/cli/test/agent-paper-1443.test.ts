// task-1443 — the app half of agent PAPER trading: `--agent-paper` needs `--spectate-mcp`, the switch only
// enables an ARMED, alive mandate from the plans journal, the rendezvous it writes never carries caps, the
// follow controls (pause / take-over / resume / kill) drive the agent's control file with a sticky stop, and
// quitting turns it off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { parseArgs, terminalGuard, type GuardProcess } from '../src/main.ts';
import { AgentPaperSwitch } from '../src/agent-paper.ts';
import { McpFollowSession } from '../src/mcp-follow.ts';
import { readDeskControl, readPaperAgentRendezvous, systemClock } from '@dexterm/data';
import { PlanService } from '@dexterm/data/plans';

test('--agent-paper parses a mandate id and requires --spectate-mcp and an on-disk db', () => {
  assert.equal(parseArgs(['--spectate-mcp', '--agent-paper', 'm_abc-1']).agentPaper, 'm_abc-1');
  assert.equal(parseArgs([]).agentPaper, null, 'off by default');
  assert.throws(() => parseArgs(['--agent-paper', 'm_1']), /needs --spectate-mcp/);
  assert.throws(() => parseArgs(['--spectate-mcp', '--agent-paper', 'm_1', '--db', ':memory:']), /on-disk --db/);
  assert.throws(() => parseArgs(['--spectate-mcp', '--agent-paper', '../etc']), /mandate id/);
});

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-paper-cli-'));
  const env = { DEXTERM_HOME: dir } as NodeJS.ProcessEnv;
  const svc = new PlanService({ journalPath: join(dir, 'plans.journal'), clock: systemClock });
  return { dir, env, svc };
}

test('the switch refuses a draft or unknown mandate, and enables an armed one without writing caps', () => {
  const { dir, env, svc } = home();
  const m = svc.draftMandate({ perTradeUsd: 20, totalUsd: 100 });
  const db = join(dir, 'dexterm.db');
  assert.match(new AgentPaperSwitch({ env, mandateId: 'm_missing', db }).start(), /OFF/);
  const draft = new AgentPaperSwitch({ env, mandateId: m.id, db });
  assert.match(draft.start(), /OFF: .*mandate-not-armed/);
  assert.equal(readPaperAgentRendezvous(env), null);

  svc.armMandateByKeypress(m.id, 'keypress');
  const sw = new AgentPaperSwitch({ env, mandateId: m.id, db });
  const line = sw.start();
  assert.match(line, /agent PAPER trading ON \(experimental, simulated only\)/);
  assert.match(line, /agent cap \$5\.00\/trade/);
  assert.deepEqual(readPaperAgentRendezvous(env), { v: 2, db, mandateId: m.id });
  assert.doesNotMatch(readFileSync(join(dir, 'paper-agent.json'), 'utf8'), /perTradeUsd|budget|totalUsd/, 'never carries caps');
  assert.equal(readDeskControl(env).state, 'running');
  sw.stop();
  assert.equal(readPaperAgentRendezvous(env), null, 'quitting turns it off');
  assert.ok(!existsSync(join(dir, 'paper-agent.control')));
  rmSync(dir, { recursive: true, force: true });
});

test('SIGTERM / SIGHUP (a closed terminal) run the teardown, so agent paper trading never outlives the terminal', () => {
  // Found in the task-1443 capture: the guard only restored the screen on a signal, so a killed or closed
  // terminal left paper-agent.json + a `running` control file behind and an external agent could keep booking.
  for (const [sig, code] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    const { dir, env, svc } = home();
    const m = svc.draftMandate({});
    svc.armMandateByKeypress(m.id, 'keypress');
    const sw = new AgentPaperSwitch({ env, mandateId: m.id, db: join(dir, 'dexterm.db') });
    sw.start();
    assert.equal(readDeskControl(env).state, 'running');
    const em = new EventEmitter();
    const exits: number[] = [];
    const proc = Object.assign(em, { exit: (c?: number) => { exits.push(c ?? 0); } }) as unknown as GuardProcess;
    const stdout = Object.assign(new Writable({ write(_c, _e, cb) { cb(); } }), { isTTY: false });
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    const io = { stdout, stderr: stdout, stdin } as unknown as Parameters<typeof terminalGuard>[0];
    const g = terminalGuard(io, () => {}, proc, { onSignal: () => { throw new Error('a throwing cleanup still exits'); } });
    const g2 = terminalGuard(io, () => {}, proc, { onSignal: () => sw.stop() });
    g.install(); g2.install();
    em.emit(sig);
    assert.equal(readPaperAgentRendezvous(env), null, `${sig}: rendezvous removed`);
    assert.ok(!existsSync(join(dir, 'paper-agent.control')), `${sig}: control file removed`);
    assert.deepEqual(exits, [code, code], `${sig}: both guards still exit`);
    g.uninstall(); g2.uninstall();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the follow controls drive the agent paper control file; a stop is sticky', async () => {
  const { dir, env, svc } = home();
  const m = svc.draftMandate({});
  svc.armMandateByKeypress(m.id, 'keypress');
  const sw = new AgentPaperSwitch({ env, mandateId: m.id, db: join(dir, 'dexterm.db') });
  sw.start();
  const session = new McpFollowSession({ env, agentLabel: 'bot', onControl: (s) => sw.control(s) });
  await session.start();
  session.pause();
  assert.equal(readDeskControl(env).state, 'paused');
  session.resume();
  assert.equal(readDeskControl(env).state, 'running');
  session.userKey(); // any key while the agent drives = take over
  assert.equal(readDeskControl(env).state, 'takeover');
  session.resume();
  assert.equal(readDeskControl(env).state, 'running');
  session.kill();
  assert.equal(readDeskControl(env).state, 'stopped');
  session.resume();
  assert.equal(readDeskControl(env).state, 'stopped', 'a stop stays stopped for the rest of the run');
  await session.stop();
  sw.stop();
  rmSync(dir, { recursive: true, force: true });
});
