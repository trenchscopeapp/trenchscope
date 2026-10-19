// task-1406 "watch the agent cook": the spectator event model + redaction, the follow-mode controller
// (screen model + pause/take-over/kill), save/replay to a file, and the READ-ONLY loopback stream (which
// must be token-gated, redact addresses/keys, and have NO path to send a command back to the bus).
// Replay-based and deterministic; the stream tests run a real loopback socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SpectatorHub, SpectatorRecorder, SpectatorServer, FollowController,
  redactString, redactDeep, redactSpectatorEvent, maskAddress, maxDataAgeSec,
  parseSpectatorRecording, loadSpectatorRecording, replaySpectator,
  type SpectatorEvent,
} from '../src/index.ts';
import { AgentBus } from '../src/bus.ts';
import { AgentRegistry } from '../src/identity.ts';
import { MemoryAuditLog } from '../src/audit.ts';
import { FixtureExecutor, FixtureFeed } from '../src/executor.ts';
import { MemoryProposalStore } from '../src/proposals.ts';
import { DextermAgent } from '../src/sdk.ts';

const MINT = 'FixtMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // 44 base58 chars (a Solana pubkey shape)
const HEXKEY = 'a'.repeat(64);                                 // a 32-byte key / signature in hex
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ redaction

test('redaction masks addresses, removes keys, blanks sensitive fields', () => {
  assert.equal(maskAddress(MINT), 'Fixt…AAAA');
  const red = redactString(`open ${MINT} now`);
  assert.ok(!red.includes(MINT), 'the full address must not survive');
  assert.ok(red.includes('Fixt…AAAA'), 'the masked form is kept so the stream stays watchable');
  // a private-key-shaped run is removed entirely, not truncated
  assert.equal(redactString(`sig ${HEXKEY}`), 'sig [key]');
  const longB58 = 'z'.repeat(60);
  assert.equal(redactString(longB58), '[key]');
  // sensitive-named fields are blanked wholesale
  const deep = redactDeep({ secret: 'hunter2', privateKey: HEXKEY, note: `look at ${MINT}`, ageSec: 3 }) as Record<string, unknown>;
  assert.equal(deep.secret, '[redacted]');
  assert.equal(deep.privateKey, '[redacted]');
  assert.equal(deep.note, 'look at Fixt…AAAA');
  assert.equal(deep.ageSec, 3, 'non-sensitive numbers pass through');
});

test('redactSpectatorEvent redacts a copy and never mutates the original', () => {
  const ev: SpectatorEvent = { v: 1, seq: 1, t: 1, phase: 'nav', agent: 'scanbot', ok: true, summary: `open ${MINT}`, nav: { screen: 'token', mint: MINT } };
  const r = redactSpectatorEvent(ev);
  assert.equal(ev.summary, `open ${MINT}`, 'original untouched');
  assert.equal(ev.nav!.mint, MINT, 'original nav untouched');
  assert.ok(!JSON.stringify(r).includes(MINT), 'the redacted copy has no full address anywhere');
  assert.equal(r.nav!.mint, 'Fixt…AAAA');
  assert.equal(r.redacted, true);
  const sens = redactSpectatorEvent({ v: 1, seq: 2, t: 1, phase: 'result', agent: 'a', ok: true, sensitive: true, summary: `holder ${MINT}` });
  assert.equal(sens.summary, '[sensitive]');

  // every string field is scrubbed, not just the summary/nav.mint — a refused call can carry an
  // address/key in its agent-supplied tool name (and refusal/agent/nav strings are redacted too).
  const leaky = redactSpectatorEvent({
    v: 1, seq: 3, t: 1, phase: 'refused', agent: MINT, ok: false,
    tool: MINT, refusal: HEXKEY, summary: `refused ${MINT}`,
    nav: { screen: `go ${MINT}`, mint: MINT, feed: MINT, filter: HEXKEY, highlight: MINT, side: MINT },
  });
  assert.ok(!JSON.stringify(leaky).includes(MINT), 'no full address anywhere in a refused event');
  assert.ok(!JSON.stringify(leaky).includes(HEXKEY), 'no full key anywhere in a refused event');
  assert.equal(leaky.tool, 'Fixt…AAAA', 'the tool name is masked');
  assert.equal(leaky.refusal, '[key]', 'a key in the refusal reason is removed');
  assert.equal(leaky.agent, 'Fixt…AAAA', 'the agent label is masked');
});

test('maxDataAgeSec finds the oldest ageSec in a nested result', () => {
  assert.equal(maxDataAgeSec({ pair: { ageSec: 3 }, stats: { ageSec: 12 }, nested: { x: { ageSec: 7 } } }), 12);
  assert.equal(maxDataAgeSec({ nothing: 1 }), null);
});

// ------------------------------------------------------------------ hub + save/replay

test('the hub assigns seq/t and keeps a bounded ring', () => {
  let clock = 100;
  const hub = new SpectatorHub({ now: () => clock++, cap: 3 });
  const got: SpectatorEvent[] = [];
  const off = hub.on((e) => got.push(e));
  for (let i = 0; i < 5; i++) hub.emit({ phase: 'result', agent: 'a', tool: 't' + i });
  assert.equal(got.length, 5, 'every listener call fires');
  assert.deepEqual(got.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(hub.size, 3, 'the ring is capped');
  assert.deepEqual(hub.recent().map((e) => e.tool), ['t2', 't3', 't4'], 'recent keeps the newest');
  off();
});

test('save → load → replay is deterministic and redacts by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-'));
  const file = join(dir, 'session.jsonl');
  const hub = new SpectatorHub();
  const rec = new SpectatorRecorder({ path: file, now: () => 1 }).attach(hub);
  hub.emit({ phase: 'connect', agent: 'scanbot', tier: 'observe' });
  hub.emit({ phase: 'nav', agent: 'scanbot', tool: 'open_token', summary: `open ${MINT}`, nav: { screen: 'token', mint: MINT } });
  hub.emit({ phase: 'result', agent: 'scanbot', tool: 'rugcheck', summary: 'rugcheck', ms: 4, dataAgeSec: 3 });
  assert.equal(rec.stop(), 3);
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes(MINT), 'a saved (shared) file is redacted: no full address');

  const recording = loadSpectatorRecording(file);
  assert.equal(recording.meta.redacted, true);
  assert.equal(recording.events.length, 3);
  const follow = new FollowController();
  const n = replaySpectator(recording, (ev) => follow.apply(ev));
  assert.equal(n, 3);
  const view = follow.view();
  assert.equal(view.screen.screen, 'token');
  assert.equal(view.screen.selectedMint, 'Fixt…AAAA', 'the replayed screen reflects the (redacted) nav');
  assert.equal(view.agents[0].name, 'scanbot');
  assert.equal(view.activity.length, 3);
});

test('an unredacted (local) recording keeps full addresses', () => {
  const lines: string[] = [];
  const hub = new SpectatorHub();
  const rec = new SpectatorRecorder({ write: (l) => lines.push(l), redact: false }).attach(hub);
  hub.emit({ phase: 'nav', agent: 'a', tool: 'open_token', nav: { screen: 'token', mint: MINT } });
  rec.stop();
  const parsed = parseSpectatorRecording(lines.join('\n'));
  assert.equal(parsed.meta.redacted, false);
  assert.equal(parsed.events[0].nav!.mint, MINT);
});

// ------------------------------------------------------------------ follow mode: screen model + controls

test('follow mode folds agent navigation into the screen model', () => {
  const f = new FollowController();
  f.apply({ v: 1, seq: 1, t: 1, phase: 'connect', agent: 'bot', tier: 'annotate', ok: true });
  f.apply({ v: 1, seq: 2, t: 2, phase: 'nav', agent: 'bot', tool: 'switch_feed', ok: true, nav: { screen: 'screener', feed: 'new' } });
  f.apply({ v: 1, seq: 3, t: 3, phase: 'nav', agent: 'bot', tool: 'open_token', ok: true, nav: { screen: 'token', mint: MINT } });
  f.apply({ v: 1, seq: 4, t: 4, phase: 'result', agent: 'bot', tool: 'rugcheck', ok: true, ms: 5, dataAgeSec: 3 });
  const v = f.view();
  assert.equal(v.screen.screen, 'token');
  assert.equal(v.screen.feed, 'new');
  assert.equal(v.screen.selectedMint, MINT);
  assert.equal(v.agents[0].tier, 'annotate');
  assert.equal(v.activity.length, 4);
});

test('follow mode controls delegate to the bus (pause / take over / kill)', () => {
  const calls: string[] = [];
  const controls = {
    pauseAgent: (n: string) => { calls.push('pause:' + n); return true; },
    resumeAgent: (n: string) => { calls.push('resume:' + n); return true; },
    kickAgent: (n: string) => { calls.push('kick:' + n); return 2; },
  };
  const f = new FollowController({ controls });
  f.apply({ v: 1, seq: 1, t: 1, phase: 'connect', agent: 'bot', ok: true });

  assert.match(f.pause('bot'), /paused bot/);
  assert.equal(f.view().agents[0].status, 'paused');

  assert.match(f.takeOver('bot'), /took over/);
  assert.equal(f.controlState, 'user', 'taking over means the human is driving');

  assert.match(f.kill('bot'), /killed bot \(2 sessions/);
  assert.equal(f.view().agents[0].status, 'killed');

  assert.deepEqual(calls, ['pause:bot', 'pause:bot', 'kick:bot', 'pause:bot'], 'kill kicks then pauses');
});

// ------------------------------------------------------------------ real bus → hub → follow (replay-based end to end)

async function busHarness() {
  const registry = new AgentRegistry({ path: ':memory:' });
  const audit = new MemoryAuditLog();
  const hub = new SpectatorHub();
  const bus = new AgentBus({ registry, audit, executor: new FixtureExecutor(), proposals: new MemoryProposalStore(), feed: new FixtureFeed(), spectator: hub, discoveryPath: null });
  const port = await bus.start();
  const token = registry.add('scanbot', 'annotate').token;
  return { registry, audit, hub, bus, url: `ws://127.0.0.1:${port}`, token };
}

test('the bus emits spectator events that drive follow mode, and pause/kill flow through', async () => {
  const h = await busHarness();
  const follow = new FollowController({ controls: h.bus });
  const off = h.hub.on((ev) => follow.apply(ev));
  try {
    const a = await DextermAgent.connect({ name: 'scanbot', token: h.token, url: h.url, client: 'test' });
    await a.call('open_token', { mint: MINT });   // navigation → a nav event drives the screen
    await a.call('rugcheck', { mint: MINT });      // a read → a result event with timing + data age
    await sleep(20);

    const v = follow.view();
    assert.equal(v.screen.screen, 'token', 'open_token moved the screen');
    assert.equal(v.screen.selectedMint, MINT);
    const rug = v.activity.find((e) => e.tool === 'rugcheck');
    assert.ok(rug && rug.phase === 'result', 'rugcheck is a result');
    assert.equal(rug!.dataAgeSec, 3, 'the data age is captured from the fixture ageSec');
    assert.ok(typeof rug!.ms === 'number', 'timing is captured');

    // pause via follow mode → the gate refuses the next call, and a refused spectator event is emitted.
    follow.pause('scanbot');
    await assert.rejects(a.call('open_token', { mint: MINT }), /paused/i);
    await sleep(20);
    assert.ok(follow.view().activity.some((e) => e.phase === 'refused'), 'the refusal shows in the activity');

    // kill → every live session is closed.
    follow.kill('scanbot');
    await sleep(20);
    assert.equal(h.bus.connectionCount, 0, 'kill closed the session');
    a.close();
  } finally { off(); await h.bus.close(); }
});

// ------------------------------------------------------------------ the read-only spectator STREAM

function streamClient(url: string): { ws: WebSocket; msgs: Record<string, unknown>[]; opened: Promise<void>; closed: Promise<void> } {
  const ws = new WebSocket(url);
  const msgs: Record<string, unknown>[] = [];
  ws.onmessage = (e) => { try { msgs.push(JSON.parse(String(e.data))); } catch { /* ignore */ } };
  return { ws, msgs, opened: new Promise((r) => { ws.onopen = () => r(); }), closed: new Promise((r) => { ws.onclose = () => r(); }) };
}

test('the spectator stream is loopback, token-gated, and redacts; a wrong token is refused', async () => {
  const hub = new SpectatorHub();
  const server = new SpectatorServer({ hub, token: 'good-token-123', discoveryPath: null });
  const port = await server.start();
  // a raw event with a full address in the ring (replayed to a viewer on connect)
  hub.emit({ phase: 'nav', agent: 'scanbot', tool: 'open_token', summary: `open ${MINT}`, nav: { screen: 'token', mint: MINT } });
  try {
    // wrong token: closed, no welcome
    const bad = streamClient(`ws://127.0.0.1:${port}`);
    await bad.opened;
    bad.ws.send(JSON.stringify({ method: 'hello', token: 'nope' }));
    await bad.closed;
    assert.ok(!bad.msgs.some((m) => m.type === 'welcome'), 'a wrong token gets no welcome');

    // correct token: welcome + a redacted snapshot
    const good = streamClient(`ws://127.0.0.1:${port}`);
    await good.opened;
    good.ws.send(JSON.stringify({ method: 'hello', token: 'good-token-123' }));
    await sleep(30);
    assert.ok(good.msgs.some((m) => m.type === 'welcome' && m.redacted === true), 'welcome says redacted');
    const evMsgs = good.msgs.filter((m) => m.type === 'event');
    assert.ok(evMsgs.length >= 1, 'the snapshot was replayed');
    const text = JSON.stringify(good.msgs);
    assert.ok(!text.includes(MINT), 'the stream never carries a full address');
    assert.ok(text.includes('Fixt…AAAA'), 'the masked address is shown instead');

    // a live event after connect is also redacted
    hub.emit({ phase: 'result', agent: 'scanbot', tool: 'get_holders', summary: `holder ${MINT}` });
    await sleep(20);
    assert.ok(!JSON.stringify(good.msgs).includes(MINT), 'live events are redacted too');
    good.ws.close();
  } finally { await server.close(); }
});

test('a refused call whose tool NAME is an address/key never leaks it to the stream or a saved file', async () => {
  // Regression (task-1406 R2): an untrusted/prompt-injected agent can put a wallet address or key in
  // the tool name of an unknown-tool call. bus.ts copies that name into the refused event's `tool`,
  // and the old redactSpectatorEvent left `tool`/`refusal`/`agent` untouched → the viewer saw it raw.
  const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'; // 44 base58 chars (a real wallet shape)
  const KEY = 'ab'.repeat(32);                                   // a 64-hex key / signature
  const dir = mkdtempSync(join(tmpdir(), 'spec-'));
  const file = join(dir, 'leak.jsonl');
  const h = await busHarness();
  const server = new SpectatorServer({ hub: h.hub, token: 'tok', discoveryPath: null });
  const rec = new SpectatorRecorder({ path: file, now: () => 1 }).attach(h.hub); // redacted by default (shared file)
  const port = await server.start();
  try {
    const a = await DextermAgent.connect({ name: 'scanbot', token: h.token, url: h.url, client: 'test' });
    const v = streamClient(`ws://127.0.0.1:${port}`);
    await v.opened;
    v.ws.send(JSON.stringify({ method: 'hello', token: 'tok' }));
    await sleep(20);

    // unknown tool names carrying secret material → each refused by the gate, each emitted as a refused event
    await assert.rejects(a.call(WALLET, {}));
    await assert.rejects(a.call(KEY, {}));
    await sleep(30);

    const streamText = JSON.stringify(v.msgs);
    assert.ok(!streamText.includes(WALLET), 'the full wallet address must not reach the stream via the tool name');
    assert.ok(!streamText.includes(KEY), 'the full key must not reach the stream via the tool name');
    assert.ok(streamText.includes('7xKX…gAsU'), 'the masked wallet is shown instead (still watchable)');
    assert.ok(streamText.includes('[key]'), 'the key is removed, not truncated');
    // the refused events really did arrive (so the asserts above are meaningful, not vacuous)
    const refusals = v.msgs.filter((m) => m.type === 'event' && (m.event as { phase?: string } | undefined)?.phase === 'refused');
    assert.ok(refusals.length >= 2, 'both refusals streamed');

    rec.stop();
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.includes(WALLET), 'the saved (shared) file must not contain the full wallet either');
    assert.ok(!raw.includes(KEY), 'the saved (shared) file must not contain the full key either');
    v.ws.close();
    a.close();
  } finally { await server.close(); await h.bus.close(); }
});

test('the spectator stream CANNOT send a command back — it has no path to the bus', async () => {
  // Wire a real bus with a connected, active agent, and a stream watching the same hub.
  const h = await busHarness();
  const server = new SpectatorServer({ hub: h.hub, token: 'tok', discoveryPath: null });
  const port = await server.start();
  try {
    const a = await DextermAgent.connect({ name: 'scanbot', token: h.token, url: h.url, client: 'test' });
    await a.call('screener_query', { preset: 'new', limit: 2 });
    await sleep(10);
    assert.equal(h.bus.connectionCount, 1, 'the agent is connected');

    const v = streamClient(`ws://127.0.0.1:${port}`);
    await v.opened;
    v.ws.send(JSON.stringify({ method: 'hello', token: 'tok' }));
    await sleep(20);

    // fire every "command" shape a hostile viewer might try: none has a handler, none reaches the bus.
    v.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'open_ticket', arguments: { mint: MINT, side: 'buy' } } }));
    v.ws.send(JSON.stringify({ method: 'pause', agent: 'scanbot' }));
    v.ws.send(JSON.stringify({ type: 'event', name: 'roster.kick', payload: { agent: 'scanbot' } }));
    v.ws.send(JSON.stringify({ method: 'kick', name: 'scanbot' }));
    await sleep(30);

    assert.ok(server.dropped >= 4, 'every inbound command was ignored (dropped)');
    assert.equal(h.bus.connectionCount, 1, 'the agent was NOT kicked by the stream');
    // the agent is still able to act (it was never paused/kicked through the stream)
    const rows = await a.call('screener_query', { preset: 'new', limit: 1 });
    assert.ok(Array.isArray(rows.rows), 'the agent still works: the stream changed nothing');
    v.ws.close();
    a.close();
  } finally { await server.close(); await h.bus.close(); }
});
