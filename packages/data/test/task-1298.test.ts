// task-1298: Helius RPC config + key hygiene, credit meter, GoPlus, PumpPortal stream client, RugCheck
// new_tokens, GeckoTerminal trades, Helius→public fallback, watchlist store. Offline: fixtures/task-1298-sample.json
// (recorded 2026-10-06 with the key redacted at capture) plus synthetic responses; `helpers.ts` blocks fetch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cache } from '../src/cache.ts';
import { FakeClock } from '../src/clock.ts';
import { CreditMeter, HELIUS_DAILY_BUDGET } from '../src/credits.ts';
import { FixtureStore, replayTransport, requestKey, toEntry, type StreamRecording } from '../src/fixtures.ts';
import { HttpError, type HttpRequest, type HttpResponse, type Transport } from '../src/http.ts';
import { createDataLayer, rpcSourceFor } from '../src/index.ts';
import { containsSecret, isPlausibleKey, redactSecrets, resolveRpcUrl } from '../src/rpc-config.ts';
import { auditPatchFromGoPlus, goplusBodyCheck, normalizeGoPlus, toPercent } from '../src/sources/goplus.ts';
import { bondingProgress, parsePumpMessage, PumpPortalClient, PUMP_INITIAL_VIRTUAL_TOKENS, type WsLike } from '../src/sources/pumpportal.ts';
import { normalizeNewToken } from '../src/sources/rugcheck.ts';
import { parseTrades } from '../src/sources/geckoterminal.ts';
import { SOLANA_PUBLIC_RPC } from '../src/sources/solana-rpc.ts';
import { WatchlistStore } from '../src/watchlist.ts';
import { drive, json } from './helpers.ts';

const SAMPLE = fileURLToPath(new URL('../fixtures/task-1298-sample.json', import.meta.url));
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const BONK_POOL = '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9';
const HELIUS_REDACTED = 'https://mainnet.helius-rpc.com/?api-key=REDACTED';
const FAKE_KEY = 'abcdef12-3456-7890-abcd-ef1234567890';

function sampleLayer(extra: Partial<Parameters<typeof createDataLayer>[0]> = {}) {
  const store = FixtureStore.load(SAMPLE);
  const clock = new FakeClock(Date.parse(store.recordedAt!));
  const dl = createDataLayer({ clock, transport: replayTransport(store), rpcUrl: HELIUS_REDACTED, ...extra });
  return { store, clock, dl };
}

// ---------------------------------------------------------------- RPC config + key hygiene

test('rpc config: DEXTERM_RPC_URL wins, else the key file builds the Helius URL, else the public RPC', () => {
  const env = resolveRpcUrl({ env: { DEXTERM_RPC_URL: 'https://rpc.example/x' }, home: '/nope' });
  assert.equal(env.provider, 'custom');
  assert.equal(env.url, 'https://rpc.example/x');
  assert.equal(env.fallbackUrl, SOLANA_PUBLIC_RPC);
  const keyed = resolveRpcUrl({ env: {}, home: '/home/x', readFile: (p) => { assert.equal(p, join('/home/x', '.dexterm', 'helius.key')); return `${FAKE_KEY}\n`; } });
  assert.equal(keyed.provider, 'helius');
  assert.equal(keyed.basis, '~/.dexterm/helius.key');
  assert.equal(keyed.url, `https://mainnet.helius-rpc.com/?api-key=${FAKE_KEY}`);
  assert.equal(rpcSourceFor(keyed.url), 'helius');
  const none = resolveRpcUrl({ env: {}, home: '/home/x', readFile: () => { throw new Error('ENOENT'); } });
  assert.equal(none.provider, 'public');
  assert.equal(none.url, SOLANA_PUBLIC_RPC);
  assert.equal(none.fallbackUrl, null);
  const junk = resolveRpcUrl({ env: {}, home: '/home/x', readFile: () => 'paste your key here please' });
  assert.equal(junk.provider, 'public', 'a sentence is not a key');
  assert.ok(isPlausibleKey(FAKE_KEY));
  assert.ok(!isPlausibleKey(''));
});

test('key hygiene: redaction covers URLs, error messages, fixture keys and entries; save() never writes a key value', async () => {
  const url = `https://mainnet.helius-rpc.com/?api-key=${FAKE_KEY}&x=1`;
  assert.equal(redactSecrets(url), 'https://mainnet.helius-rpc.com/?api-key=REDACTED&x=1');
  assert.equal(redactSecrets(`HTTP 429 for ${url}`), 'HTTP 429 for https://mainnet.helius-rpc.com/?api-key=REDACTED&x=1');
  assert.ok(containsSecret(url));
  assert.ok(!containsSecret(redactSecrets(url)));
  assert.ok(!containsSecret('https://api.dexscreener.com/tokens/v1/solana/abc'));
  const e = new HttpError(429, url);
  assert.ok(!e.message.includes(FAKE_KEY));
  assert.ok(!e.url.includes(FAKE_KEY));
  assert.equal(requestKey({ method: 'POST', url, body: '{"a":1}' }), requestKey({ method: 'POST', url: HELIUS_REDACTED + '&x=1', body: '{"a":1}' }), 'replay matches with any key');
  const entry = toEntry({ method: 'POST', url, body: '{"jsonrpc":"2.0"}' }, { status: 200, headers: {}, body: '{}', latencyMs: 1 });
  assert.ok(!entry.url.includes(FAKE_KEY));
  const store = new FixtureStore();
  store.add({ ...entry, body: { leaked: url, note: `line\n${url}"quoted"` }, bodyIsJson: true });
  // task-1443: live bodies echo third-party key-shaped params (DexScreener image `&key=`); the save scrubs them
  // instead of throwing the whole recording away, and a scrubbed URL still replays.
  const img = 'https://dd.dexscreener.com/ds-data/tokens/solana/abc.png?size=lg&key=ad6a9a';
  store.add(toEntry({ method: 'GET', url: 'https://api.dexscreener.com/tokens/v1/solana/abc' }, { status: 200, headers: {}, body: JSON.stringify([{ info: { imageUrl: img } }]), latencyMs: 1 }));
  store.add(toEntry({ method: 'GET', url: img }, { status: 200, headers: {}, body: 'png', latencyMs: 1 }));
  store.streams.push({ url: 'wss://pumpportal.fun/api/data', startedAt: 'x', sent: [], messages: [{ tMs: 1, text: `{"uri":"${img}"}` }] });
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-1298-'));
  try {
    const out = join(dir, 'leak.json');
    store.save(out);
    const text = readFileSync(out, 'utf8');
    assert.ok(!text.includes(FAKE_KEY), 'a key echoed in a body is never written');
    assert.ok(!text.includes('ad6a9a'));
    const back = FixtureStore.load(out);
    assert.equal(back.size, 3);
    assert.deepEqual(back.streams[0]!.messages[0], { tMs: 1, text: '{"uri":"https://dd.dexscreener.com/ds-data/tokens/solana/abc.png?size=lg&key=REDACTED"}' });
    const listed = JSON.parse((await replayTransport(back)({ method: 'GET', url: 'https://api.dexscreener.com/tokens/v1/solana/abc' })).body);
    const res = await replayTransport(back)({ method: 'GET', url: listed[0].info.imageUrl });
    assert.equal(res.body, 'png', 'the scrubbed image URL replays');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // the committed sample carries no key value
  assert.ok(!containsSecret(readFileSync(SAMPLE, 'utf8')));
});

// ---------------------------------------------------------------- credit meter

test('credit meter: charges per method, warns at 50 %, degrades at 90 % or the run cap, persists the day total', () => {
  const clock = new FakeClock(Date.UTC(2026, 9, 6, 12, 0, 0));
  const cache = new Cache({ clock });
  const levels: string[] = [];
  const m = new CreditMeter({ clock, cache, dayBudget: 100, runCap: 1000, onLevel: (l) => levels.push(l) });
  assert.equal(CreditMeter.costOf('getAccountInfo'), 1);
  assert.equal(CreditMeter.costOf('getTokenAccounts'), 10);
  assert.equal(CreditMeter.costOf('somethingNew'), 10);
  for (let i = 0; i < 49; i++) m.charge(1);
  assert.equal(m.level(), 'ok');
  m.charge(1);
  assert.equal(m.level(), 'warn');
  assert.deepEqual(levels, ['warn']);
  for (let i = 0; i < 39; i++) m.charge(1);
  assert.equal(m.level(), 'warn');
  m.charge(1);
  assert.equal(m.level(), 'degraded');
  assert.ok(!m.allow());
  assert.deepEqual(levels, ['warn', 'degraded']);
  assert.match(m.label(), /helius 90\/100 \(90%\) · run 90 · off/);
  // a new process the same day picks the total up from the cache
  const again = new CreditMeter({ clock, cache, dayBudget: 100 });
  assert.equal(again.status().day, 90);
  assert.equal(again.status().session, 0);
  assert.equal(again.level(), 'degraded');
  // tomorrow starts clean
  const tomorrow = new CreditMeter({ clock: { now: () => Date.UTC(2026, 9, 7, 1, 0, 0), sleep: async () => {} }, cache, dayBudget: 100 });
  assert.equal(tomorrow.status().day, 0);
  assert.equal(tomorrow.level(), 'ok');
  // the per-run cap trips even with a fresh day
  const capped = new CreditMeter({ clock, dayBudget: HELIUS_DAILY_BUDGET, runCap: 5 });
  for (let i = 0; i < 5; i++) capped.charge(1);
  assert.equal(capped.level(), 'degraded');
  assert.ok(capped.status().runCapHit);
  assert.match(capped.label(), /run cap/);
});

test('data layer: a Helius URL makes `helius` a keyed-present source with its own bucket; the meter charges each call and switches it off at the cap', async () => {
  const { dl, clock } = sampleLayer({ credits: { runCap: 2 } });
  assert.equal(dl.rpc.source, 'helius');
  assert.equal(dl.rpcFallback?.source, 'solana-rpc');
  assert.equal(dl.health.state('helius'), 'ok', 'key present → not needs-key');
  assert.ok(dl.credits);
  const info = await drive(clock, dl.detail.mintInfo(BONK));
  assert.equal(info.value.source, 'helius');
  assert.equal(dl.credits!.status().session, 1);
  const h = await drive(clock, dl.detail.holders(BONK));
  assert.equal(h.value.source, 'helius');
  assert.equal(h.value.holders.length, 20);
  // the cap tripped after getTokenLargestAccounts (credit #2): the owner lookup was refused by the health gate,
  // so the adapter kept the token accounts (shares intact, owners unresolved) instead of failing the panel
  assert.equal(dl.credits!.status().session, 2, 'hard cap: the third Helius call never left the process');
  assert.equal(h.value.holders[0].owner, null);
  assert.equal(h.value.top10Pct, 38.42, 'shares do not depend on owners');
  assert.equal(dl.credits!.level(), 'degraded', 'run cap 2 hit');
  assert.equal(dl.health.state('helius'), 'disabled', 'over budget → the source is off for this run');
  assert.equal(dl.health.snapshot(['helius'])[0].rpmLimit, 600);
});

test('holders: Helius failing (429) falls back to the public RPC; both failing surfaces the last error', async () => {
  const store = FixtureStore.load(SAMPLE);
  const replay = replayTransport(store);
  const clock = new FakeClock(Date.parse(store.recordedAt!));
  const seen: string[] = [];
  const t: Transport = async (req: HttpRequest): Promise<HttpResponse> => {
    const host = new URL(req.url).hostname;
    seen.push(host);
    if (host === 'mainnet.helius-rpc.com') return json(429, { error: 'slow down' }, { 'retry-after': '1' });
    if (host === 'api.mainnet-beta.solana.com') {
      // the public RPC answers with the recorded Helius bodies (same JSON-RPC shapes)
      return replay({ ...req, url: HELIUS_REDACTED });
    }
    return replay(req);
  };
  const dl = createDataLayer({ clock, transport: t, rpcUrl: HELIUS_REDACTED });
  const h = await drive(clock, dl.detail.holders(BONK));
  assert.equal(h.value.source, 'solana-rpc', 'answered by the fallback');
  assert.equal(h.value.holders.length, 20);
  assert.ok(seen.includes('mainnet.helius-rpc.com') && seen.includes('api.mainnet-beta.solana.com'));
  // both down: the error names the fallback's failure and carries no key
  const dead: Transport = async () => json(429, { error: 'nope' }, { 'retry-after': '1' });
  const dl2 = createDataLayer({ clock, transport: dead, rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${FAKE_KEY}` });
  await assert.rejects(drive(clock, dl2.detail.holders(BONK)), (e: Error) => e instanceof HttpError && e.status === 429 && !e.message.includes(FAKE_KEY));
  assert.equal(dl2.health.snapshot(['helius'])[0].lastError, 'HTTP 429');
});

// ---------------------------------------------------------------- GoPlus

test('goplus: recorded BONK security normalizes (fractions → percent, authorities off, 10 dexes), audit patch, body check', async () => {
  const { dl, clock } = sampleLayer();
  const g = await drive(clock, dl.detail.security(BONK));
  const s = g.value;
  assert.equal(s.source, 'goplus');
  assert.equal(s.mintable, false);
  assert.equal(s.freezable, false);
  assert.equal(s.closable, false);
  assert.equal(s.metadataMutable, true);
  assert.equal(s.transferHook, false);
  assert.equal(s.transferFee, false);
  assert.equal(s.nonTransferable, false);
  assert.equal(s.holderCount, 1024386);
  assert.equal(s.holders.length, 10);
  assert.equal(s.holders[0].address, '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
  assert.equal(s.holders[0].pct, 8.83, '"0.0883" is a fraction');
  assert.ok(s.holders.every((h, i) => i === 0 || h.pct <= s.holders[i - 1].pct), 'largest first');
  assert.equal(s.dex.length, 10);
  assert.equal(s.dex[0].name, 'orca');
  assert.equal(s.dex[0].pool, BONK_POOL);
  assert.deepEqual(s.flags, []);
  const patch = auditPatchFromGoPlus(s);
  assert.equal(patch.mintAuthority, false);
  assert.ok(patch.top10Pct! > 30 && patch.top10Pct! < 45);
  assert.equal(toPercent('0.5'), 50);
  assert.equal(toPercent('12.5'), 12.5);
  assert.equal(toPercent(null, 200, '50'), 25);
  // flags light up on enabled authorities / hooks / malicious creators
  const risky = normalizeGoPlus('M', { mintable: { status: '1', authority: [{ address: 'A', malicious_address: 1 }] }, transfer_hook: [{ hook_program: 'H' }], default_account_state: '2', creators: [{ address: 'C', malicious_address: '1' }] }, 1);
  assert.deepEqual(risky.flags, ['goplus:mintable', 'goplus:transfer-hook', 'goplus:default-frozen', 'goplus:malicious-address']);
  assert.deepEqual(risky.maliciousAddresses.sort(), ['A', 'C']);
  assert.equal(goplusBodyCheck({ code: 1 }), null);
  assert.equal(goplusBodyCheck({ code: 4029, message: 'rate limit' })?.status, 429);
  assert.match(goplusBodyCheck({ code: 2004, message: 'bad address' })?.error ?? '', /code 2004/);
});

// ---------------------------------------------------------------- PumpPortal

test('pumpportal: recorded stream parses to 25 creates + 2 migrations + 2 info; bonding estimate from reserves', () => {
  const store = FixtureStore.load(SAMPLE);
  const rec = store.streams[0];
  assert.equal(rec.url, 'wss://pumpportal.fun/api/data');
  assert.deepEqual(rec.sent, ['{"method":"subscribeNewToken"}', '{"method":"subscribeMigration"}']);
  const kinds = { create: 0, migrate: 0, info: 0, other: 0 };
  for (const m of rec.messages) kinds[parsePumpMessage(m.text, 0).kind]++;
  assert.deepEqual(kinds, { create: 25, migrate: 2, info: 2, other: 0 });
  const first = parsePumpMessage(rec.messages.find((m) => m.text.includes('"create"'))!.text, 123);
  assert.equal(first.kind, 'create');
  if (first.kind !== 'create') return;
  const c = first.create;
  assert.equal(c.mint, '415vEt8v6Qm1PZdxF34vKE8763woE4DVPn3VEDG6pump');
  assert.equal(c.launchpad, 'pump.fun');
  assert.equal(c.source, 'pumpportal');
  assert.equal(c.receivedAt, 123);
  assert.ok(c.signature && c.creator && c.marketCapSol! > 27 && c.marketCapSol! < 28);
  assert.equal(c.bondingPct, 0, 'a fresh curve starts at 0 %');
  assert.equal(bondingProgress(PUMP_INITIAL_VIRTUAL_TOKENS), 0);
  assert.equal(bondingProgress(PUMP_INITIAL_VIRTUAL_TOKENS - 793_100_000 / 2), 50);
  assert.equal(bondingProgress(279_900_000), 100);
  assert.equal(bondingProgress(1), 100, 'clamped');
  assert.equal(bondingProgress(null), null);
  assert.equal(parsePumpMessage('not json', 0).kind, 'other');
  assert.equal(parsePumpMessage('{"message":"Successfully subscribed"}', 0).kind, 'info');
  const mig = parsePumpMessage('{"signature":"s","mint":"m","txType":"migrate","pool":"pump-amm"}', 0);
  assert.equal(mig.kind, 'migrate');
});

/** Scripted fake WebSocket: the test decides when it opens, what it says and when it drops. */
class FakeWs implements WsLike {
  readyState = 0;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private handlers: Record<string, ((ev: { data?: unknown; code?: number; reason?: string }) => void)[]> = {};
  readonly url: string;
  constructor(url: string) { this.url = url; }
  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; }
  addEventListener(type: string, fn: (ev: { data?: unknown; code?: number; reason?: string }) => void): void { (this.handlers[type] ??= []).push(fn); }
  fire(type: string, ev: { data?: unknown; code?: number; reason?: string } = {}): void { for (const fn of this.handlers[type] ?? []) fn(ev); }
}

test('pumpportal client: subscribes the free methods on open, reports health, reconnects with doubling backoff, records, stops cleanly', async () => {
  const clock = new FakeClock(1_000_000);
  const sockets: FakeWs[] = [];
  const events: string[] = [];
  const rec: StreamRecording = { url: 'wss://x', startedAt: '', sent: [], messages: [] };
  const dl = createDataLayer({ clock, transport: async () => json(500, {}) });
  const client = new PumpPortalClient({ url: 'wss://x', clock, health: dl.health, record: rec, ws: (url) => { const s = new FakeWs(url); sockets.push(s); return s; }, onEvent: (ev) => events.push(ev.kind) });
  assert.throws(() => new PumpPortalClient({ subscriptions: ['subscribeTokenTrade'] }), /refusing paid/);
  client.start();
  assert.equal(sockets.length, 1);
  assert.equal(client.getStatus().state, 'connecting');
  sockets[0].fire('open');
  assert.equal(client.getStatus().state, 'open');
  assert.deepEqual(sockets[0].sent, ['{"method":"subscribeNewToken"}', '{"method":"subscribeMigration"}']);
  const create = JSON.stringify({ signature: 's1', mint: 'M1pump', traderPublicKey: 'T', txType: 'create', vTokensInBondingCurve: 1_000_000_000, vSolInBondingCurve: 32, marketCapSol: 31, name: 'n', symbol: 'S', uri: 'u', pool: 'pump' });
  sockets[0].fire('message', { data: create });
  sockets[0].fire('message', { data: '{"message":"hi"}' });
  assert.deepEqual(events, ['create', 'info']);
  assert.equal(client.getStatus().creates, 1);
  assert.equal(dl.health.state('pumpportal'), 'ok');
  assert.equal(rec.messages.length, 2);
  assert.equal(rec.sent.length, 2);
  // drop: failure 1 → retry after 1 s; drop again before open → 2 s; then it opens and the counter resets
  sockets[0].fire('close', { code: 1006 });
  assert.equal(client.getStatus().state, 'reconnecting');
  assert.equal(client.getStatus().nextRetryMs, 1_000);
  await clock.advance(999);
  assert.equal(sockets.length, 1, 'not before the backoff');
  await clock.advance(1);
  assert.equal(sockets.length, 2);
  sockets[1].fire('close', { code: 1006 });
  assert.equal(client.getStatus().nextRetryMs, 2_000);
  assert.equal(client.getStatus().failures, 2);
  await clock.advance(2_000);
  assert.equal(sockets.length, 3);
  sockets[2].fire('open');
  assert.equal(client.getStatus().failures, 0);
  assert.equal(client.getStatus().attempts, 3);
  // health saw two failures but a message on the new socket keeps it ok
  sockets[2].fire('message', { data: create });
  assert.equal(dl.health.state('pumpportal'), 'ok');
  client.stop();
  assert.equal(client.getStatus().state, 'stopped');
  assert.equal(sockets[2].closed?.code, 1000);
  sockets[2].fire('close', { code: 1000 });
  await clock.advance(60_000);
  assert.equal(sockets.length, 3, 'no reconnect after stop');
  // replay through the same client delivers the recording with the recorded gaps
  const player = new PumpPortalClient({ clock, ws: () => { throw new Error('never'); }, onEvent: (ev) => events.push(`r:${ev.kind}`) });
  const replayed = player.replay({ ...rec, messages: [{ tMs: 0, text: create }, { tMs: 500, text: '{"message":"x"}' }] }, 1);
  await drive(clock, replayed, 100);
  assert.deepEqual(events.slice(-2), ['r:create', 'r:info']);
  assert.equal(player.getStatus().messages, 2);
});

test('pumpportal client: health degrades after repeated failed connects (3 consecutive) and the status says why', async () => {
  const clock = new FakeClock(5_000_000);
  const dl = createDataLayer({ clock, transport: async () => json(500, {}) });
  const client = new PumpPortalClient({ url: 'wss://x', clock, health: dl.health, ws: () => { throw new Error('ECONNREFUSED'); } });
  client.start();
  await clock.advance(1_000); // retry 1 (1 s)
  await clock.advance(2_000); // retry 2 (2 s)
  assert.equal(client.getStatus().failures, 3);
  assert.equal(client.getStatus().lastError, 'ECONNREFUSED');
  assert.equal(dl.health.state('pumpportal'), 'degraded');
  assert.equal(client.getStatus().nextRetryMs, 4_000);
  client.stop();
});

// ---------------------------------------------------------------- RugCheck new_tokens + GeckoTerminal trades

test('rugcheck new_tokens: recorded rows carry creator and authority state; junk rows dropped', async () => {
  const { dl, clock } = sampleLayer();
  const list = await drive(clock, dl.rugcheck.newTokens());
  assert.equal(list.length, 10);
  const t = list[0];
  assert.equal(t.mint, '7t9vdvJS2bBBBEHSHPDiAgjP6BtRCwvktQHRbVWjpump');
  assert.equal(t.creator, '4LdeLsSZWmQahiLuMxcyXMwAFFHBhB4yJTT6PyNyubyN');
  assert.equal(t.mintAuthority, false, 'empty string = revoked');
  assert.equal(t.freezeAuthority, false);
  assert.equal(t.program, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  assert.ok(t.createdAt! > Date.UTC(2026, 9, 6));
  assert.equal(normalizeNewToken({ symbol: 'x' }, 1), null);
  assert.equal(normalizeNewToken({ mint: 'm', mintAuthority: 'Auth111' }, 1)?.mintAuthority, true);
  assert.equal(normalizeNewToken({ mint: 'm' }, 1)?.mintAuthority, null);
});

test('geckoterminal trades: recorded BONK pool tape, newest first, side from the mint, cached 20 s', async () => {
  const { dl, clock } = sampleLayer();
  const r = await drive(clock, dl.detail.trades(BONK_POOL, BONK));
  assert.equal(r.value.length, 300);
  const first = r.value[0];
  assert.equal(first.side, 'buy');
  assert.equal(first.t, Date.parse('2026-10-06T13:46:21Z'));
  assert.ok(first.usd > 0 && first.price > 0 && first.wallet.length > 30);
  for (let i = 1; i < r.value.length; i++) assert.ok(r.value[i].t <= r.value[i - 1].t, 'newest first');
  assert.ok(r.value.some((x) => x.side === 'sell'));
  const again = await drive(clock, dl.detail.trades(BONK_POOL, BONK));
  assert.ok(again.fromCache);
  // without the mint, GeckoTerminal's kind decides; malformed rows are dropped
  const parsed = parseTrades([{ attributes: { block_timestamp: '2026-01-01T00:00:00Z', kind: 'sell', volume_in_usd: '5', price_from_in_usd: '2', tx_from_address: 'w' } }, { attributes: { kind: 'buy' } }]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].side, 'sell');
  assert.equal(parsed[0].price, 2);
});

// ---------------------------------------------------------------- watchlist store

test('watchlist store: persists across reopen (file DB); proposals need confirm; armed rules fire once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dexterm-1298-wl-'));
  const path = join(dir, 'w.db');
  const clock = new FakeClock(2_000_000);
  try {
    const a = new WatchlistStore({ path, clock });
    assert.equal(a.add({ mint: 'M1', symbol: 'ONE', name: 'one', launchpad: 'pump.fun', entryPrice: 1.5 }), true);
    assert.equal(a.add({ mint: 'M1', symbol: 'ONE', name: 'one', launchpad: 'pump.fun', entryPrice: 9 }), false, 'already there keeps its entry');
    await clock.advance(1000);
    a.add({ mint: 'M2', symbol: 'TWO', name: 'two', launchpad: 'unknown', entryPrice: null });
    const p = a.propose({ mint: 'M1', kind: 'price', op: '>', value: 2 });
    assert.equal(p.status, 'proposed');
    a.setNote('M1', 'thesis');
    a.close();
    const b = new WatchlistStore({ path, clock });
    const list = b.list();
    assert.deepEqual(list.map((e) => e.mint), ['M2', 'M1'], 'newest first');
    assert.equal(b.get('M1')?.entryPrice, 1.5);
    assert.equal(b.get('M1')?.note, 'thesis');
    assert.equal(b.rules('proposed').length, 1);
    // nothing fires while proposed
    assert.deepEqual(b.evaluate(new Map([['M1', { price: 3 }]])), []);
    b.confirm(p.id);
    assert.equal(b.rule(p.id)?.status, 'armed');
    assert.deepEqual(b.evaluate(new Map([['M1', { price: 1.9 }]])), [], 'below threshold');
    const fired = b.evaluate(new Map([['M1', { price: 3 }]]), () => 'ONE');
    assert.equal(fired.length, 1);
    assert.match(fired[0].text, /ONE price > \$2\.00 \(now \$3\.00\)/);
    assert.equal(fired[0].level, 'up');
    assert.equal(b.rule(p.id)?.status, 'fired');
    assert.deepEqual(b.evaluate(new Map([['M1', { price: 4 }]])), [], 'one shot');
    assert.equal(b.events()[0].text, fired[0].text);
    const d = b.propose({ mint: 'M2', kind: 'liq', op: '<', value: 1000 });
    b.dismiss(d.id);
    assert.equal(b.rule(d.id)?.status, 'dismissed');
    assert.equal(b.remove('M1'), true);
    assert.equal(b.has('M1'), false);
    assert.equal(b.remove('M1'), false);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
