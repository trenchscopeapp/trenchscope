// task-1405: `trenchscope mcp install <client>` and `trenchscope mcp doctor`. install is idempotent, shows the
// change, asks first (writes nothing on a non-TTY without --yes), and backs the file up before editing;
// it is only ever exercised against a temp --config file, never the real ~/.claude / Cursor / Codex config.
// doctor spawns the real stdio server and lists the tools the agent sees.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMcp, planJson, planToml, serverEntryJson, serverEntryToml, clientById, CLIENTS } from '../src/mcp-cmd.ts';
import type { Io } from '../src/main.ts';

function fakeIo(env: Record<string, string> = {}): { io: Io; out: () => string; err: () => string } {
  const out: string[] = []; const err: string[] = [];
  const io = {
    stdout: { write: (s: string) => { out.push(s); return true; } },
    stderr: { write: (s: string) => { err.push(s); return true; } },
    stdin: { isTTY: false },
    env: { ...process.env, ...env },
  } as unknown as Io;
  return { io, out: () => out.join(''), err: () => err.join('') };
}

const CMD = { command: 'dexterm', args: ['mcp'] };

test('planJson: adds, is idempotent, updates, and preserves every other key', () => {
  const entry = serverEntryJson(CMD);
  const add = planJson(null, 'mcpServers', entry);
  assert.equal(add.was, 'absent'); assert.ok(add.changed);
  const same = planJson(add.text, 'mcpServers', entry);
  assert.equal(same.was, 'same'); assert.ok(!same.changed, 're-running changes nothing');
  const existing = JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } }, theme: 'dark' });
  const merged = planJson(existing, 'mcpServers', entry);
  const obj = JSON.parse(merged.text) as { mcpServers: Record<string, unknown>; theme: string };
  assert.ok(obj.mcpServers.other, 'other servers are preserved'); assert.equal(obj.theme, 'dark', 'other keys are preserved');
  assert.deepEqual(obj.mcpServers.dexterm, entry);
  const diff = planJson(JSON.stringify({ mcpServers: { dexterm: { command: 'old', args: [] } } }), 'mcpServers', entry);
  assert.equal(diff.was, 'different'); assert.ok(diff.changed);
  assert.throws(() => planJson('{not valid json', 'mcpServers', entry), /not valid JSON/);
});

test('planToml: appends when absent, no-op when present, never clobbers a different block', () => {
  const block = serverEntryToml(CMD);
  const add = planToml(null, block);
  assert.ok(add.changed && add.text.includes('[mcp_servers.dexterm]'));
  const same = planToml(add.text, block);
  assert.ok(!same.changed && same.was === 'same');
  const conflict = planToml('[mcp_servers.dexterm]\ncommand = "other"\nargs = []\n', block);
  assert.ok(!conflict.changed && conflict.conflict, 'a differing block is left untouched');
});

test('every client has a stable id and either a default path or is print-only', () => {
  const ids = CLIENTS.map((c) => c.id);
  assert.deepEqual(ids, ['claude-code', 'claude-desktop', 'cursor', 'codex', 'generic'], 'the public client list names no maintainer-specific tool (task-1415)');
  const desktop = clientById('claude-desktop')!.path({ HOME: '/home/u' } as NodeJS.ProcessEnv, process.platform);
  assert.ok(desktop && desktop.endsWith('claude_desktop_config.json'));
});

test('install writes a JSON client config, is idempotent, and backs up before changing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-mcp-'));
  const file = join(dir, '.mcp.json');

  const a = fakeIo();
  assert.equal(await runMcp(['install', 'claude-code', '--config', file, '--yes'], a.io), 0, a.err());
  assert.ok(existsSync(file));
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: { dexterm: { command: string; args: string[] } } };
  assert.deepEqual(cfg.mcpServers.dexterm, serverEntryJson(CMD));

  const b = fakeIo();
  assert.equal(await runMcp(['install', 'claude-code', '--config', file, '--yes'], b.io), 0);
  assert.match(b.out(), /already configured/i);
  assert.equal(readdirSync(dir).filter((f) => f.includes('.bak-')).length, 0, 'an idempotent re-run makes no backup');

  // a changed entry is updated AND the old file is backed up first.
  writeFileSync(file, JSON.stringify({ mcpServers: { dexterm: { command: 'old', args: [] } } }));
  const c = fakeIo();
  assert.equal(await runMcp(['install', 'claude-code', '--config', file, '--yes'], c.io), 0);
  assert.match(c.out(), /backed up/);
  assert.ok(readdirSync(dir).some((f) => f.startsWith('.mcp.json.bak-')), 'a backup file was written');
});

test('install on a non-TTY without --yes writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-mcp-'));
  const file = join(dir, 'mcp.json');
  const a = fakeIo();
  await runMcp(['install', 'cursor', '--config', file], a.io);
  assert.equal(existsSync(file), false, 'no file written without consent');
  assert.match(a.out(), /nothing written|--yes/);
});

test('install --print prints the snippet and writes nothing', async () => {
  const a = fakeIo();
  assert.equal(await runMcp(['install', 'codex', '--print'], a.io), 0);
  assert.match(a.out(), /\[mcp_servers\.dexterm\]/);
});

test('install writes codex TOML idempotently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-mcp-'));
  const file = join(dir, 'config.toml');
  await runMcp(['install', 'codex', '--config', file, '--yes'], fakeIo().io);
  assert.ok(readFileSync(file, 'utf8').includes('[mcp_servers.dexterm]'));
  const b = fakeIo();
  await runMcp(['install', 'codex', '--config', file, '--yes'], b.io);
  assert.match(b.out(), /already configured/i);
});

test('install rejects an unknown client', async () => {
  const a = fakeIo();
  assert.equal(await runMcp(['install', 'emacs'], a.io), 2);
  assert.match(a.err(), /unknown client/);
});

test('doctor spawns the server and lists the tools the agent sees (incl. larp_check)', async () => {
  const a = fakeIo();
  const rc = await runMcp(['doctor', '--node'], a.io);
  assert.equal(rc, 0, a.err());
  const text = a.out();
  assert.match(text, /connected to dexterm/);
  assert.match(text, /larp_check/, 'the widened LARP tool is advertised');
  const m = /tools \((\d+)\)/.exec(text);
  assert.ok(m && Number(m[1]) >= 25, `doctor should list at least 25 tools (saw ${m?.[1]})`);
});
