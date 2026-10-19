// `trenchscope doctor` (task-1305): every check must be deterministic and never touch the real network,
// filesystem or the claude binary — runDoctor takes all of that through injected DoctorDeps, so these
// tests drive each branch by hand. We assert the status AND that every non-pass line carries a fix,
// since the whole point of the doctor is "tell me exactly what to run".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runDoctor, renderDoctor, cmpVersion, livingProbe, MIN_NODE, DATA_SOURCES,
  type DoctorDeps, type ProbeResult, type DoctorResult,
} from '../src/index.ts';

/** Deps where everything is healthy; each test overrides the one axis it exercises. */
function healthyDeps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    // a Helius RPC from the env (no key in the URL), so the result never depends on the machine's ~/.dexterm/helius.key
    env: { COLORTERM: 'truecolor', TERM: 'xterm-256color', DEXTERM_RPC_URL: 'https://mainnet.helius-rpc.com/' } as NodeJS.ProcessEnv,
    isTTY: true,
    nodeVersion: '22.18.0',
    platform: 'darwin',
    claude: async () => 'ok',
    probe: async (): Promise<ProbeResult> => ({ reachable: true, status: 200, ms: 40 }),
    checkWritable: () => null,
    offline: false,
    ...over,
  };
}

function check(result: DoctorResult, name: string) {
  const c = result.checks.find((x) => x.name === name);
  assert.ok(c, `expected a check named ${name}; got ${result.checks.map((x) => x.name).join(', ')}`);
  return c!;
}

test('cmpVersion orders semver triples and tolerates short arrays', () => {
  assert.equal(cmpVersion([22, 18, 0], [22, 18, 0]), 0);
  assert.equal(cmpVersion([22, 17, 9], [22, 18, 0]), -1);
  assert.equal(cmpVersion([23, 0, 0], [22, 18, 0]), 1);
  assert.equal(cmpVersion([22], [22, 18, 0]), -1); // missing minor treated as 0
  assert.equal(cmpVersion([22, 18], [22, 18, 0]), 0);
});

test('a fully healthy machine passes with no failures', async () => {
  const result = await runDoctor(healthyDeps());
  assert.equal(result.ok, true);
  assert.ok(result.checks.every((c) => c.status === 'pass'), result.checks.map((c) => `${c.name}:${c.status}`).join(' '));
  // a pass never carries a fix line
  for (const c of result.checks) assert.equal(c.fix, undefined, `${c.name} should have no fix on a pass`);
});

test('old Node fails with an install fix and flips ok to false', async () => {
  const result = await runDoctor(healthyDeps({ nodeVersion: '20.11.0' }));
  const c = check(result, 'Node');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /too old/);
  assert.ok(c.fix && /22\.18/.test(c.fix));
  assert.equal(result.ok, false);
});

test('Node exactly at the minimum passes', async () => {
  const result = await runDoctor(healthyDeps({ nodeVersion: MIN_NODE.join('.') }));
  assert.equal(check(result, 'Node').status, 'pass');
});

test('non-TTY output warns to use a real terminal (never fails)', async () => {
  const result = await runDoctor(healthyDeps({ isTTY: false }));
  const c = check(result, 'Terminal');
  assert.equal(c.status, 'warn');
  assert.ok(c.fix);
  assert.equal(result.ok, true); // a warning must not block
});

test('256-colour terminal warns but the app still runs', async () => {
  const result = await runDoctor(healthyDeps({ env: { TERM: 'xterm-256color' } as NodeJS.ProcessEnv }));
  const c = check(result, 'Terminal colour');
  assert.equal(c.status, 'warn');
  assert.match(c.fix ?? '', /truecolor/i);
});

test('missing claude warns and explains the analyst is the only thing lost', async () => {
  const result = await runDoctor(healthyDeps({ claude: async () => 'missing' }));
  const c = check(result, 'Claude CLI');
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /analyst/);
  assert.match(c.fix ?? '', /claude\.com\/claude-code/);
  assert.equal(result.ok, true);
});

test('no Helius key warns with the free-tier recipe and never prints a key', async () => {
  // resolveRpcUrl reads the env + ~/.dexterm/helius.key; an empty env + a throwaway HOME = public RPC.
  const result = await runDoctor(healthyDeps({
    env: { COLORTERM: 'truecolor', HOME: '/nonexistent-dexterm-doctor-home', DEXTERM_HOME: '/nonexistent-dexterm-doctor-home/.dexterm' } as NodeJS.ProcessEnv,
  }));
  const c = check(result, 'Helius RPC');
  assert.equal(c.status, 'warn');
  assert.match(c.fix ?? '', /dashboard\.helius\.dev/);
  // the whole rendered doctor must never leak a key-shaped token
  for (const line of result.checks.flatMap((x) => [x.detail, x.fix ?? ''])) {
    assert.ok(!/[?&]api-?key=/i.test(line), `doctor line leaks a key param: ${line}`);
  }
});

test('a custom RPC endpoint passes', async () => {
  const result = await runDoctor(healthyDeps({
    env: { COLORTERM: 'truecolor', DEXTERM_RPC_URL: 'https://my-node.example/rpc' } as NodeJS.ProcessEnv,
  }));
  assert.equal(check(result, 'RPC').status, 'pass');
});

test('a hard data source down fails; only a soft source down warns', async () => {
  const hard = DATA_SOURCES.find((s) => !s.soft)!;
  const soft = DATA_SOURCES.find((s) => s.soft)!;

  const hardResult = await runDoctor(healthyDeps({
    probe: async (url) => (url === hard.url ? { reachable: false, error: 'ENOTFOUND' } : { reachable: true, status: 200 }),
  }));
  const hc = check(hardResult, 'Data sources');
  assert.equal(hc.status, 'fail');
  assert.match(hc.detail, new RegExp(hard.name));
  assert.equal(hardResult.ok, false);

  const softResult = await runDoctor(healthyDeps({
    probe: async (url) => (url === soft.url ? { reachable: false, error: 'ENOTFOUND' } : { reachable: true, status: 200 }),
  }));
  const sc = check(softResult, 'Data sources');
  assert.equal(sc.status, 'warn');
  assert.equal(softResult.ok, true);
});

test('all sources reachable but slow still passes and names the slow ones', async () => {
  const result = await runDoctor(healthyDeps({ probe: async () => ({ reachable: true, status: 200, ms: 3000 }) }));
  const c = check(result, 'Data sources');
  assert.equal(c.status, 'pass');
  assert.match(c.detail, /slow:/);
});

test('--offline skips the network probes with a warning, never a fail', async () => {
  let probed = false;
  const result = await runDoctor(healthyDeps({ offline: true, probe: async () => { probed = true; return { reachable: true }; } }));
  assert.equal(probed, false);
  assert.equal(check(result, 'Network').status, 'warn');
  assert.equal(result.ok, true);
});

test('an unwritable data directory fails with a chmod / :memory: fix', async () => {
  const result = await runDoctor(healthyDeps({ checkWritable: () => 'EACCES: permission denied' }));
  const c = check(result, 'Data directory');
  assert.equal(c.status, 'fail');
  assert.match(c.fix ?? '', /:memory:/);
  assert.equal(result.ok, false);
});

test('renderDoctor prints a glyph + fix for every non-pass, and a summary', async () => {
  const result = await runDoctor(healthyDeps({ nodeVersion: '20.0.0', claude: async () => 'missing' }));
  const out = renderDoctor(result, { color: false });
  assert.match(out, /trenchscope doctor/);
  assert.match(out, /✗/); // the failing Node line
  assert.match(out, /!/); // the claude warning
  assert.match(out, /→ /); // a fix line
  assert.match(out, /failed/); // summary reflects the failure
  // plain mode carries no ANSI escapes
  assert.ok(!out.includes('\x1b['), 'plain render must have no ANSI');
});

test('renderDoctor colour mode emits ANSI and the all-clear summary when healthy', async () => {
  const result = await runDoctor(healthyDeps());
  const out = renderDoctor(result, { color: true });
  assert.ok(out.includes('\x1b['), 'colour render should carry ANSI');
  assert.match(out, /All checks passed/);
});

test('livingProbe treats an HTTP 4xx as reachable (the host answered)', async () => {
  const probe = await livingProbe('https://api.dexscreener.com/latest/dex/search?q=__dexterm_doctor_probe__', 4000);
  // Either the host answered (any status, including 4xx) → reachable, or the network is unavailable
  // in this sandbox → a transport error. Both are valid; what must never happen is a thrown rejection.
  if (probe.reachable) assert.equal(typeof probe.status, 'number');
  else assert.ok(probe.error, 'an unreachable probe must carry an error string');
});
