import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPublicMcp, PUBLIC_TOOLS } from '../src/http.ts';
import { APP_URI, APP_MIME } from '../src/app-resource.ts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpTools, resourceRead, getPrompt } from '../src/server.ts';

test('public HTTP MCP handshake, app resources, tools and failure semantics', async (t) => {
  const calls: string[] = [];
  const server = createPublicMcp({ call: async (name) => { calls.push(name); if (name === 'rugcheck') throw new Error('provider unavailable'); return { rows: [], now: 1 }; }, revision: 'test-sha' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const rpc = async (method: string, params: object = {}) => {
    const r = await fetch(url + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    assert.equal(r.status, 200); return r.json() as Promise<{ result: Record<string, any>; error: { code: number } }>;
  };
  assert.equal(((await (await fetch(url + '/health')).json()) as { revision: string }).revision, 'test-sha');
  const init = (await rpc('initialize', { protocolVersion: '2025-06-18' })).result;
  assert.equal(init.serverInfo.name, 'trenchscope'); assert.equal(init.protocolVersion, '2025-06-18');
  const tools = (await rpc('tools/list')).result.tools;
  assert.equal(tools.length, PUBLIC_TOOLS.length);
  for (const name of ['open_token', 'paper_confirm', 'paper_positions', 'screen_state', 'app_state', 'export_recorded', 'dev_history']) {
    assert.ok(!tools.some((x: { name: string }) => x.name === name), name);
    assert.equal((await rpc('tools/call', { name })).error.code, -32602);
  }
  for (const name of ['screener_query', 'get_token', 'get_dossier']) assert.equal(tools.find((x: { name: string }) => x.name === name)._meta.ui.resourceUri, APP_URI);
  const resource = (await rpc('resources/read', { uri: APP_URI })).result.contents[0];
  assert.equal(resource.mimeType, APP_MIME); assert.match(resource.text, /ui\/initialize/);
  assert.deepEqual(resource._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  const valid = (await rpc('tools/call', { name: 'screener_query', arguments: { limit: 2 } })).result;
  assert.equal(valid.isError, false); assert.deepEqual(JSON.parse(valid.content[0].text), valid.structuredContent);
  const badArgs = [{ limit: 0 }, { limit: 51 }, { limit: '2' }, { preset: 'nope' }, { surprise: true }, { limit: 1.5 }];
  for (const args of badArgs) assert.equal((await rpc('tools/call', { name: 'screener_query', arguments: args })).result.isError, true);
  assert.equal(calls.length, 1, 'invalid inputs never reach providers');
  const thrown = (await rpc('tools/call', { name: 'rugcheck', arguments: { mint: '11111111111111111111111111111111' } })).result;
  assert.equal(thrown.isError, true); assert.match(thrown.structuredContent.error, /provider unavailable/);
  assert.ok((await rpc('prompts/list')).result.prompts.length);
  assert.equal((await rpc('resources/read', { uri: 'file:///etc/passwd' })).error.code, -32602);
  const notification = await fetch(url + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(notification.status, 202); assert.equal(await notification.text(), '');
  for (const method of ['GET', 'DELETE']) assert.equal((await fetch(url + '/mcp', { method })).status, 405);
  assert.equal((await fetch(url + '/mcp', { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' }, body: '{}' })).status, 403);
  assert.equal((await fetch(url + '/mcp', { method: 'POST', headers: { ...headers, 'MCP-Protocol-Version': 'bad' }, body: '{}' })).status, 400);
  assert.equal((await fetch(url + '/mcp', { method: 'POST', headers, body: 'invalid' })).status, 400);
  assert.equal((await fetch(url + '/mcp', { method: 'POST', headers, body: '[]' })).status, 400);
  assert.equal((await fetch(url + '/mcp', { method: 'POST', headers, body: ' '.repeat(40000) })).status, 413);
});

test('public MCP bounds concurrency and rate without trusting forwarded IP headers', async (t) => {
  const server = createPublicMcp({ call: async () => ({}), requestsPerMinute: 1 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' };
  assert.equal((await fetch(url, init)).status, 200);
  const blocked = await fetch(url, { ...init, headers: { ...init.headers, 'X-Forwarded-For': '127.0.0.2' } });
  assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('Retry-After'), '30');
});

test('public content excludes private local KB and skill overlays while local MCP keeps them', async () => {
  const home = mkdtempSync(join(tmpdir(), 'trenchscope-public-'));
  const previous = process.env.DEXTERM_HOME; process.env.DEXTERM_HOME = home;
  try {
    mkdirSync(join(home, 'kb', 'entries'), { recursive: true }); mkdirSync(join(home, 'skills'), { recursive: true });
    writeFileSync(join(home, 'kb', 'entries', 'private-note.md'), '---\nid: private-note\ntitle: Private note\nconfidence: high\n---\nPRIVATE_OVERLAY_MARKER');
    writeFileSync(join(home, 'skills', 'private-skill.md'), '---\nname: private-skill\ndescription: Private skill\n---\nPRIVATE_SKILL_MARKER');
    const local = new McpTools({} as never, () => ({}));
    const publicTools = new McpTools({} as never, () => ({}), null, null, null, true);
    assert.match(JSON.stringify(await local.call('kb_lookup', { id: 'private-note' })), /PRIVATE_OVERLAY_MARKER/);
    assert.ok((await publicTools.call('kb_lookup', { id: 'private-note' })).error);
    assert.ok(!JSON.stringify((await publicTools.call('kb_search', { query: 'PRIVATE_OVERLAY_MARKER' })).results).includes('PRIVATE_OVERLAY_MARKER'));
    assert.ok('contents' in resourceRead('dexterm://kb/private-note'));
    assert.ok('error' in resourceRead('dexterm://kb/private-note', true));
    assert.ok('messages' in getPrompt('private-skill'));
    assert.ok('error' in getPrompt('private-skill', {}, true));
  } finally { if (previous === undefined) delete process.env.DEXTERM_HOME; else process.env.DEXTERM_HOME = previous; rmSync(home, { recursive: true, force: true }); }
});

test('dossier memo evicts old mints and expires stale results', async (t) => {
  let now = 100000; t.mock.method(Date, 'now', () => now);
  class OfflineTools extends McpTools {
    override async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      return name === 'get_dossier' ? super.call(name, args) : { error: 'unavailable offline' };
    }
  }
  const tools = new OfflineTools({} as never, () => ({}));
  const mint = '11111111111111111111111111111111';
  const first = await tools.call('get_dossier', { mint });
  assert.equal(await tools.call('get_dossier', { mint }), first);
  for (let i = 1; i <= 129; i++) await tools.call('get_dossier', { mint: i.toString(16).replaceAll('0', 'z').padStart(3, 'z').padStart(32, '1') });
  const evicted = await tools.call('get_dossier', { mint }); assert.notEqual(evicted, first);
  now += 30001;
  assert.notEqual(await tools.call('get_dossier', { mint }), evicted);
});

test('eight concurrent tool requests hold the public boundary and capacity recovers', async (t) => {
  const releases: Array<() => void> = [];
  const server = createPublicMcp({ call: async () => { await new Promise<void>((resolve) => releases.push(resolve)); return {}; } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => { releases.forEach((release) => release()); server.closeAllConnections(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kb_search","arguments":{"query":"x"}}}' };
  const requests = Array.from({ length: 8 }, () => fetch(url, opts));
  for (let i = 0; releases.length < 8 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(releases.length, 8); assert.equal((await fetch(url, opts)).status, 429);
  releases.forEach((release) => release()); await Promise.all(requests);
  const ping = await fetch(url, { ...opts, body: '{"jsonrpc":"2.0","id":2,"method":"ping"}' }); assert.equal(ping.status, 200);
});
