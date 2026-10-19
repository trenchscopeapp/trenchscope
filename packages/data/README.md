# @dexterm/data

Data layer for dexterm (SPEC §3): normalized model, source adapters, SQLite cache,
token-bucket limiter, health registry, recorded-fixture harness. Owned by lane B (D-02).

`src/model.ts` holds the Token/Pair/Stats/Audit/Candle/Holder/Trade/Forensics/Health types
agreed on day 1 with lane A. Changes to it need a note in the handoff of whoever changes it.

Keyless and read-only: GET requests to public endpoints, plus JSON-RPC POSTs to the Solana RPC
restricted to an allow-list of read methods (`READ_METHODS`). No keys, no wallets.

## Pieces

| File | What |
|---|---|
| `src/limiter.ts` | Per-bucket token bucket + hard 60 s sliding-window ceiling (`floor(rpm × 0.7)`), FIFO queue, `pause()` for 429s. `DEFAULT_BUCKETS` lists the documented limits and where they come from. |
| `src/health.ts` | Per-source registry (SPEC §3.5): 3 consecutive failures or 2× 429 in 60 s → `degraded` for 30 s doubling to 10 min, then `probing` (half-open). `needs-key` for Tier 1, `disabled` for flags. `gate()`/`gateAll()` with `COLUMN_SOURCES` and `FEATURE_SOURCES` decide which columns/features are offered. |
| `src/cache.ts` | `node:sqlite` cache, `(ns, key) → json, fetched_at, ttl_ms, source`; `fetch()` adds in-flight coalescing and stale-while-revalidate. `TTL` holds the SPEC §3.4 values. |
| `src/http.ts` | `HttpClient.getJson()` / `postJson()` (JSON-RPC reads): health gate, limiter, timing, health outcome, 429 / `Retry-After` / `x-ratelimit-remaining` handling (the no-`Retry-After` pause doubles per consecutive 429 on a bucket, cap 10 min), optional body check (JSON-RPC errors; rate-limit errors sent with HTTP 200 count as 429s), request coalescing. Pluggable `Transport`. |
| `src/fixtures.ts` | `recordingTransport()` (live + capture, hard request cap) and `replayTransport()` (fixtures only, throws on a miss). POST entries match on method + URL + canonical JSON body. |
| `src/sources/dexscreener.ts` | `tokens/v1` (30 per call), `token-pairs/v1`, `latest/dex/search`, `token-boosts/{top,latest}/v1` → `Pair`/`Token`. |
| `src/sources/jupiter.ts` | Tokens v2 `search` (100 per call), `recent`, `toptrending`/`toporganicscore`/`toptraded`, Price v3 (50 per call) → `Token`/`Stats`/`Audit` (+ a `Pair` view so rows survive a DexScreener outage). `api.jup.ag` first, sticky fallback to `lite-api.jup.ag` on 401/403. |
| `src/sources/geckoterminal.ts` | OHLCV for `1m 5m 15m 1h 4h 1d` (`minute`/`hour`/`day` + `aggregate`), `tokens/{mint}/pools` → `Candle[]` oldest first / `GtPool[]` most liquid first. |
| `src/sources/solana-rpc.ts` | `getAccountInfo` (base64) decoded in-house: SPL / Token-2022 mint, mint + freeze authority, supply (exact u64 string), decimals, Token-2022 extensions with risky ones flagged. `getTokenLargestAccounts` + `getMultipleAccounts` → top-20 holders with owners, bigint-exact shares, Raydium authorities labelled `LP` and excluded from top-10 %. No retries; strict backoff. |
| `src/sources/rugcheck.ts` | `/v1/tokens/{mint}/report/summary` → score, normalised 0–100 score, LP locked %, risks (danger first). |
| `src/candles.ts` | `CandleStore`: closed bars cached 1 h, served view 30 s; refreshes fetch only the missing tail + open bar (usually `limit=2`), coalesced, SWR. |
| `src/detail.ts` | `TokenDetail`: candles, top pool, mint info (10 min), holders (60 s, reuses cached mint info), RugCheck (10 min), GoPlus (10 min), trades tape (20 s). Mint info and holders try the primary RPC (Helius when configured) and fall back to the public RPC. |
| `src/rpc-config.ts` | `resolveRpcUrl()`: `DEXTERM_RPC_URL` → `~/.dexterm/helius.key` → public RPC; `redactSecrets()` / `containsSecret()` keep `api-key=` values out of errors, logs and recordings (task-1298). |
| `src/credits.ts` | `CreditMeter`: Helius credits per request (1 standard / 10 DAS-class), per session and per UTC day (persisted in the cache DB), `warn` at 50 %, `degraded` at 90 % or the per-run cap; the data layer disables `helius` while degraded. |
| `src/sources/goplus.ts` | GoPlus Solana `token_security` (keyless): authorities, Token-2022 hooks/fees, holders + LP holders (fractions → percent), dexes, creators, malicious flags → `GoPlusSecurity`, `auditPatchFromGoPlus()`. |
| `src/sources/pumpportal.ts` | `PumpPortalClient`: `subscribeNewToken` + `subscribeMigration` over the WHATWG WebSocket (free methods only, one connection, backoff 1 s → 30 s, health-reported, recordable, replayable); `parsePumpMessage()`, `bondingProgress()` from the curve's virtual token reserves. |
| `src/watchlist.ts` | `WatchlistStore` (`node:sqlite`): watchlist, alert rules (`proposed` → `armed` by a keypress → `fired` once), alert events. |
| `src/store.ts` | `Store.enrich(mints)` (per-mint cache, sources in parallel, partial rows when a source is down, stale rows flagged) and `Store.discover(preset)`. `resolveMcap()` sets `row.mcap`: the larger of DexScreener and Jupiter when within 5x, otherwise DexScreener, flagged. |
| `src/images/` | task-1326 coin images: pure-TS decoders (`png.ts` all colour types / depths / Adam7 + encoder, `jpeg.ts` baseline + progressive Huffman, `gif.ts` first frame), `decode.ts` (magic-byte sniff, caps, area-average thumbnail), `fetch.ts` (SSRF-safe binary GET: `assertPublicUrl` + pinned DNS, manual re-validated redirects, byte/time caps, DexScreener CDN 128 px rewrite), `cache.ts` (on-disk LRU of our own PNGs + 6 h fail markers), `service.ts` (sync `get()` never blocks; priority queue, worker-thread decode, `onChange`, offline mode). |
| `src/index.ts` | Re-exports plus `createDataLayer()` wiring everything with one clock. |

## Commands

```sh
npm test -w @dexterm/data          # offline: replays fixtures/live-sample.json, network blocked
npm run typecheck -w @dexterm/data # includes scripts/
DEXTERM_LIVE=1 npm run smoke:live -w @dexterm/data   # opt-in: prints 30 enriched tokens (~5 requests)
DEXTERM_LIVE=1 npm run record:live -w @dexterm/data  # opt-in: re-record fixtures (≤15 requests)
DEXTERM_LIVE=1 npm run smoke:d06 -w @dexterm/data    # opt-in: pool, candles, mint, holders, RugCheck (≤8 requests)
DEXTERM_LIVE=1 npm run record:d06 -w @dexterm/data   # opt-in: re-record fixtures/d06-sample.json (≤16 requests; --holders tops up top-20 only, ≤2)
DEXTERM_LIVE=1 node scripts/record-1298.ts --ws-seconds 60   # opt-in: re-record fixtures/task-1298-sample.json (≤12 requests + one PumpPortal session; key redacted)
```

Recordings may contain `mainnet.helius-rpc.com/?api-key=REDACTED` entries: `requestKey()` redacts the key on
both sides, so a replay matches whatever key (or none) the replaying process has. `FixtureStore.save()` throws
if a key value is still present. Fixture files can also carry `streams` (recorded WebSocket sessions).

Tests never touch the network: `test/helpers.ts` replaces `fetch` with a thrower and every
adapter test runs on `replayTransport()` with a fake clock. Re-recording changes the sample
mints; the tests derive mints from the recorded URLs, so they follow the new file.

### Helius (task-1298)

`createDataLayer({ rpcUrl })` with a `mainnet.helius-rpc.com` URL registers the `helius` source (bucket 600 rpm,
key present) and a `CreditMeter`; `detail.mintInfo()` / `detail.holders()` fall back to the public RPC when Helius
fails or is over budget, and the result's `source` says which endpoint answered. Measured 2026-10-06: Helius
`getTokenLargestAccounts` for BONK 36 ms – 9.4 s (the public RPC 429s every time).

### Public Solana RPC and top-20 holders

`api.mainnet-beta.solana.com` answered every keyless `getTokenLargestAccounts` call with
429 (`Retry-After: 10`) on 2026-10-05: 4 of 4 attempts, for BONK and a small pump.fun mint,
while `getAccountInfo` succeeded. The adapter is correct against the documented response
shapes (test/d06.test.ts builds them; the recorded 429s drive the backoff and demotion tests),
but holders will normally be unavailable on the public endpoint. Pass `rpcUrl` to
`createDataLayer()` to use another RPC.
