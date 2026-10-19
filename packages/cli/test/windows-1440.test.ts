import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after } from 'node:test';
import { useNodeScripts } from '../../../scripts/test-support.ts';
import { runDoctor } from '../src/doctor.ts';
import { XTokenStore } from '@dexterm/data';

const dir = mkdtempSync(join(tmpdir(), 'dx1440-process-'));
const script = join(dir, 'fake script with spaces.cjs');
writeFileSync(script, "let text='';process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>console.log(JSON.stringify({argv:process.argv.slice(2),text})));\n");
useNodeScripts({ '1440-fake-command': script });
after(() => rmSync(dir, { recursive: true, force: true }));

test('portable fake process preserves exact argv/stdin and leaves unrelated commands real', async () => {
  const args = ['two words', '& echo injected', '$(not-a-command)', 'quote"value'];
  const child = spawn('1440-fake-command', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', b => { out += b; });
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { try { assert.equal(code, 0); resolve(); } catch (e) { reject(e); } });
  });
  child.stdin.end('untrusted input on stdin');
  await done;
  assert.deepEqual(JSON.parse(out), { argv: args, text: 'untrusted input on stdin' });
  const missing = spawn('1440-intentionally-missing-command', [], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    missing.once('error', e => { try { assert.equal((e as NodeJS.ErrnoException).code, 'ENOENT'); resolve(); } catch (err) { reject(err); } });
    missing.once('spawn', () => reject(new Error('unrelated command was incorrectly replaced')));
  });
});

test('Windows doctor never equates successful token login with verified private ACLs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dx1440-acl-'));
  try {
    const store = new XTokenStore({ dir: join(home, 'x') });
    store.setClientId('fixture-client-1440');
    store.setTokens({ access_token: 'fixture-access-1440', scope: 'tweet.read', expires_in: 7200 }, { id: '1', username: 'fixture' });
    const report = await runDoctor({ env: { HOME: home, DEXTERM_HOME: home, DEXTERM_OFFLINE: '1' }, isTTY: false,
      nodeVersion: '24.20.0', platform: 'win32', claude: async () => 'missing',
      probe: async () => ({ reachable: false, error: 'offline' }), checkWritable: () => null, offline: true });
    const check = report.checks.find(c => c.name === 'Login with X')!;
    assert.equal(check.status, 'warn');
    assert.match(check.detail, /logged in as @fixture.*Windows ACL isolation is not verified/);
    assert.match(check.fix!, /Security permissions in Windows/);
    assert.doesNotMatch(JSON.stringify(report), /fixture-access-1440/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
