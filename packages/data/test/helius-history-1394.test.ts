// task-1394: a single versioned transaction in a pump.fun launch window (a v1 tx on live mints like the
// DEXTERM CA) made Helius fail the WHOLE getTransactionsForAddress page with rpc -32015
// ("Transaction version (1) is not supported … maxSupportedTransactionVersion"), which surfaced on the
// token screen as "history failed" for Bundled supply / Snipers. The adapter hard-coded
// maxSupportedTransactionVersion: 0; the fix caps it high (MAX_TX_VERSION) because the rules only read
// static account keys and per-balance owners, which are version-independent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeClock } from '../src/clock.ts';
import { HealthRegistry } from '../src/health.ts';
import { HttpClient, type HttpRequest, type HttpResponse, type Transport } from '../src/http.ts';
import { DEFAULT_BUCKETS, RateLimiter } from '../src/limiter.ts';
import { HeliusHistory, MAX_TX_VERSION } from '../src/intel/helius-history.ts';

const MINT = 'So11111111111111111111111111111111111111112';

/** Mimic Helius getTransactionsForAddress: fail the whole page with -32015 when the caller's declared
 *  maxSupportedTransactionVersion is below the version present in the window (here, 1). */
function heliusLike(windowVersion = 1): Transport & { lastMaxVer: number | undefined } {
  const t = (async (req: HttpRequest): Promise<HttpResponse> => {
    const parsed = JSON.parse(req.body ?? '{}') as { params?: unknown[] };
    const params = (parsed.params?.[1] ?? {}) as { maxSupportedTransactionVersion?: number };
    t.lastMaxVer = params.maxSupportedTransactionVersion;
    const cap = params.maxSupportedTransactionVersion ?? 0;
    if (cap < windowVersion) {
      return j(req, { error: { code: -32015, message: `Transaction version (${windowVersion}) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": ${windowVersion}` } });
    }
    return j(req, { result: { data: [oneTx()], paginationToken: null } });
  }) as Transport & { lastMaxVer: number | undefined };
  t.lastMaxVer = undefined;
  return t;
}

function j(req: HttpRequest, body: unknown): HttpResponse {
  const parsed = JSON.parse(req.body ?? '{}') as { id?: number };
  return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: parsed.id ?? 1, ...(body as object) }), latencyMs: 2 };
}

function oneTx() {
  return { slot: 10, blockTime: 1, transactionIndex: 0, transaction: { signatures: ['sig'], message: { accountKeys: [{ pubkey: 'A', signer: true }] } }, meta: { preBalances: [1], postBalances: [1], preTokenBalances: [], postTokenBalances: [] } };
}

function history(transport: Transport) {
  const clock = new FakeClock(0);
  const limiter = new RateLimiter(DEFAULT_BUCKETS, clock);
  const health = new HealthRegistry({ clock, keys: { helius: true } });
  const http = new HttpClient({ transport, limiter, health, clock });
  return new HeliusHistory(http, 'https://mainnet.helius-rpc.com/?api-key=TEST');
}

test('task-1394: a v1 tx in the launch window no longer fails the whole page (maxSupportedTransactionVersion is capped high)', async () => {
  const t = heliusLike(1);
  const page = await history(t).launchWindow(MINT, 100);
  assert.equal(page.data.length, 1, 'launch window returns its txs instead of throwing history-failed');
  assert.ok((t.lastMaxVer ?? 0) >= 1, `the request declares support for versioned txs (got ${t.lastMaxVer})`);
  assert.equal(t.lastMaxVer, MAX_TX_VERSION);
});

test('task-1394: guard — the old cap of 0 would still fail (the fake transport genuinely gates on version)', async () => {
  // A hand-built request at the OLD cap must be rejected by the same transport, proving the test is meaningful.
  const t = heliusLike(1);
  const atCap = (v: number) => t({ method: 'POST', url: 'https://mainnet.helius-rpc.com/?api-key=TEST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransactionsForAddress', params: [MINT, { maxSupportedTransactionVersion: v, limit: 100 }] }) });
  const old = JSON.parse((await atCap(0)).body) as { error?: { code?: number } };
  assert.equal(old.error?.code, -32015, 'cap 0 is rejected with -32015 by Helius');
  const now = JSON.parse((await atCap(MAX_TX_VERSION)).body) as { result?: { data?: unknown[] } };
  assert.equal(now.result?.data?.length, 1, 'the fixed cap returns the page');
});

test('task-1394: MAX_TX_VERSION is forward-compatible (covers versions above the known v1)', () => {
  assert.ok(MAX_TX_VERSION >= 1);
});
