# Development notes

This page is the maintainers' working reference for running, testing and extending dexterm from a checkout. It was carried over from the internal app README at e39d49a and still mentions internal task ids (`task-NNNN`); those are tracking numbers, nothing more. The user-facing guide is the [README](../README.md).

## Layout

npm workspaces, TypeScript (strict, ESM). Node 22.18+ runs the sources directly with
built-in type stripping; no build step is needed for development.

| Package | Role |
|---|---|
| `packages/agents` (`@dexterm/agents`) | bring-your-own-agent layer (task-1345): per-agent identity and session tokens, server-side capability tiers (observe / annotate / propose), the gate every agent call passes, rate limits and quotas, proposals, the audit log, the loopback agent bus and the TS SDK. No agent path can arm, sign, raise a cap or change the gate. |
| `packages/cli` (`dexterm`) | terminal DEX screener with a local Claude CLI analyst |
| `packages/custom` (`@dexterm/custom`) | customization layer (task-1358, from the task-1288 design): versioned config.json (no secrets, ever), the layout solver + named workspaces, user themes, keymap overrides, the rules engine (parsed, never eval'd; alerts + PROPOSALS only), shareable packs (hash lock + ssh signature; never executes pack code) and the popup widget API. Zero runtime dependencies. |
| `packages/data` (`@dexterm/data`) | data layer: normalized model, source adapters, cache, rate limiter, health registry (SPEC §3) |
| `packages/mcp` (`@dexterm/mcp`) | read-only MCP server over stdio (SPEC §5, D-09). |
| `packages/packs` (`@dexterm/packs`) | AI analysis suite (task-1356, AI-SUITE-DESIGN): analysis packs (token/wallet dossier), narrative board, watchlist/new-pair digests, rug-probability model + honest backtest, replay-based backtest harness. Facts come from tools or recorded history, never model memory; every model stage is labelled output with data ages; untrusted text is firewalled. |
| `packages/popup` (`@dexterm/popup`) | popup host: loopback-only server + frameless HUD windows (wry) with graceful browser fallback (task-1290) |
| `packages/recorder` (`@dexterm/recorder`) | history recorder (AI-SUITE-DESIGN §4, lane R-01): snapshot-on-change from the data layer, feed membership, outcome sweeps, code-only labels, retention, export for the eval |
| `packages/tui` (`@dexterm/tui`) | terminal renderer: cell buffer, diff flusher, widgets, themes, breakpoints, keymap (SPEC §2.2, §7) |
| `packages/voice` (`@dexterm/voice`) | JARVIS voice mode (task-1282): push-to-talk, local no-key speech-in, macOS say speech-out, a safe deterministic router. Voice never executes a trade. |

## Run

```sh
npm install                                             # dev tooling only (typescript, @types/node)
npm run dexterm                                         # interactive, live keyless data (TTY); cyberspace look, fever intensity
npm run dexterm -- --fixtures                           # interactive demo on seeded fixtures (demo event keys below)
npm run dexterm -- --calm                               # neon theme, no rain / glitch / blink / scanlines (DEXTERM_CALM=1 too)
npm run dexterm -- --intensity normal                   # 15 fps, sparser rain, no idle aberration
npm run dexterm -- --fps 15 --no-boot                   # cap the frame rate; skip the boot sequence
npm run dexterm -- --screen token --mint <MINT> --width 176 --height 48   # one live token frame (Helius holders when the key is configured)
npm run dexterm -- --screen newpairs --listen 30 --width 176 --height 48  # listen to PumpPortal for 30 s, then render
npm run dexterm -- --screen watchlist --width 176 --height 48             # the persisted watchlist with live prices
npm run dexterm -- --screen screener --width 176 --height 48                       # one live frame (≈5 requests)
npm run dexterm -- --screen screener --filter "vol24 > 250K liq > 50K" --sort liq  # filter grammar + sort
npm run dexterm -- --screen screener --record /tmp/rec.json --max-requests 10      # live frame, saved for replay
npm run dexterm -- --screen screener --replay /tmp/rec.json --width 120 --height 40 # same frame, no network
npm run dexterm -- --screen token --fixtures --width 176 --height 50 --frame 41 --event pump --ai streaming:120 --ansi
npm run dexterm -- --screen boot --fixtures --t 0.78 --frame 30 --plain            # the boot screen at 78 %
npm run dexterm -- --screen newpairs --fixtures --color 256 --ansi        # 256-color fallback
npm run dexterm -- --no-images                                            # coin images off (DEXTERM_IMAGES=0 too; see "Coin images")
npm run dexterm -- --screen screener --color 256 --html /tmp/s.html       # a Terminal.app-faithful (256-colour) HTML frame
NO_COLOR=1 npm run dexterm -- --screen watchlist --fixtures --ansi        # attributes only (and calm by default)
npm run dexterm -- --help
```

Screens: `screener | token | newpairs | watchlist | analyst | boot`. The screener runs on the data
store (`@dexterm/data`: DexScreener + Jupiter, keyless) by default; `--fixtures` keeps the seeded
demo, `--replay FILE` serves a recording made with `--record FILE` (a recording also carries the
PumpPortal session, so new pairs replay too). `DEXTERM_OFFLINE=1` refuses live data (tests, CI).

### What is live and what is still demo (task-1298)

| Screen | Live | Source(s) | Still demo |
|---|---|---|---|
| Screener | yes | DexScreener + Jupiter | – |
| Token (⏎ on any live row, or `--mint`) | yes | market: DexScreener + Jupiter · candles + trades tape: GeckoTerminal · mint/freeze authority + top-20 holders: **Helius** (key) with the public RPC as fallback · RugCheck summary · GoPlus second opinion · **snipers / bundled from the wallet-intel scan** (task-1340, Helius history; keyless says `needs Helius key`) · **ANALYST panel: your local `claude` CLI** (task-1302) | dev history says `needs Helius key` |
| New pairs | yes | push: **PumpPortal** `subscribeNewToken` + `subscribeMigration` (free, one connection, reconnect with backoff) · polls: Jupiter `recent` (15 s), RugCheck `new_tokens` (30 s), DexScreener + Jupiter for the visible rows (10 s) | SNIPE / BUNDLE columns + spotlight rows come from the wallet-intel scan of the row the cursor rests on (~2 s dwell, Helius-keyed only; task-1359); unscanned rows dash, keyless says `needs Helius key`; the `✦ claude` line in the spotlight is labelled demo |
| Watchlist | yes | SQLite (`--db`, default `~/.local/share/dexterm/dexterm.db`), prices via DexScreener + Jupiter every 10 s | the analyst digest (one labelled line) |
| Analyst | yes | **your local `claude` CLI** streaming a dexterm skill over the read-only `dexterm mcp` tools (task-1302) | the demo transcript shown only until you trigger a run (`⏎` on a token, or `a`) |

Every live source goes through the health registry: a panel whose source is down shows `unavailable: <reason>`
or `needs key`, never a number. Bonding progress on new pairs is estimated from the curve's virtual reserves at
create time (pump.fun `Global` config constants) and says so.

#### Two-speed feed: a FAST lane for what you are watching (task-1312)

dexterm runs two lanes into the same model (SPEC §3.9). The **slow lane** is the polling screener above
(DexScreener/Jupiter/GeckoTerminal, ~10 s, hundreds of tokens). The **fast lane** is *push*: the open token
and your watchlist are priced in real time from on-chain state — one shared WebSocket `accountSubscribe`
on each token's pump.fun **bonding-curve account**, price computed on-chain (no aggregator), sub-second.

- **LIVE vs POLL badge** (honest): the token price, each watchlist row (`FEED` column) and the new-pairs
  spotlight show **LIVE** only while a fresh on-chain push is actually flowing for that token; otherwise
  **POLL** — the stream is down, the token is not a pump.fun curve, it has migrated to a DEX pool, or it is
  past the fast-lane cap. A LIVE row shows the on-chain curve price; a POLL row shows the polled price.
- **Cap:** at most **24** simultaneous fast-lane subscriptions (open token + a 5–20 watchlist + a few fresh
  launches). Chosen for the free tier — one connection multiplexes them, each fires only on an account
  change, the Helius credit meter bounds spend, and the keyless public RPC WS has tight limits. Tokens past
  the cap stay on the slow lane (POLL), never dropped.
- **Free-forever:** keyless, the fast lane uses the **public RPC WebSocket**; a free Helius key only makes it
  faster (lower latency, higher limits) and is used first when present. On Helius-credit exhaustion it drops
  to the keyless public RPC automatically; if no stream is available it falls back to the slow polling lane.
- **Idle cost:** the fast lane adds **zero** HTTP requests/min (it is push); price pushes never force a draw
  in `--calm` (the 2 Hz tick picks them up) and are throttled in normal mode, so idle CPU stays bounded.

**LIVE holder/rug signals (task-1404):** on the open token screen the holder and safety reads are no longer a
one-time on-open snapshot — the ON-CHAIN panel streams a LIVE SIGNALS strip of the *changes* (dev sell, top-10
shift, LP unlock, authority flip, new bundle/sniper, fresh inflow, bonding, migration), each with its source and
data age and an honest `stale` mark, and each usable as an alerts-engine trigger (new rule fields `fresh` /
`mintable` / `freezable`). See "Live holder/rug signals" under Customization.

**COMING (labelled in-app, not live yet):** dev-history (`needs Helius key`; snipers / bundled are live from the
task-1340 scan on the token screen and, since task-1359, on the new-pairs row the cursor rests on); the one-line analyst digests on the watchlist and in the
new-pairs spotlight (labelled demo until you run the analyst yourself). Nothing in this list fabricates a
number — each shows a dash, `needs key`, or a *demo* label until the real source lands.

### After-launch analysis suite (task-1356)

Built on the two-stage analysis packs (deterministic ASSEMBLE, 0 tokens; the optional REASON stage may only
*tighten* a verdict, never invent facts):

- **Rug-probability model.** Every token dossier can carry a `rug_probability` with its `rug_model` id and the
  age of the data it read. The shipped default is **`H1-v0.1`** — a *pre-registered additive heuristic*, not a
  learned model. dexterm does not ship a trained model until the recorder has ~2 weeks of labelled outcomes;
  the backtest harness below is how a v1 logistic model would be judged honestly before it replaces H1.
  **First backtest on real history (task-1361, 2026-10-12, this machine's recorder, keyless-proxy labels):**
  at 1 h, n = 401 observed outcomes with 22 positives (rug ∪ dead): AUC 0.78, precision 9 % / recall 27 % at the
  0.5 flag line, Brier 0.152 against a base-rate Brier 0.052. So H1 *ranks* tokens somewhat but its probabilities
  run far too high (rows scored 0.8–1.0 rugged 0 % of the time, n = 25; 0.4–0.6 → 16 %). Two days from one
  machine, mostly the top-trending feed: treat these as the first reading, not a result. Re-run with
  `dexterm backtest` as history grows.
- **P(RUG) screener column** (task-1361): the screener shows H1's p(rug) per row, labelled as a model output —
  the panel caption says `p(rug) = H1-v0.1 heuristic`, the spotlight repeats the value with the model id and the
  age of the scored data, `—` when nothing is scoreable, `rug` is a sort key (safest first). Given the
  calibration above, read it as a ranking, not a probability.
- **One-line digests** (`model_output: false`): a deterministic `VERDICT [p(rug) NN%] · <highlights>` ≤ 90 chars,
  surfaced by `analyze_token` (MCP) and reusable on the watchlist / new-pairs spotlight.
- **`dexterm backtest`** (`--subject heuristic|pack_verdicts  --horizon SEC  --db PATH  --json`) scores a subject
  against the recorder's outcome-labelled snapshots and prints **honest** metrics — precision/recall, Brier vs a
  base-rate Brier, AUC, calibration, per-feed breakdown, and the worst misses / false alarms — with leakage
  checks (features from t0 only, labels strictly after t0). With no labelled outcomes it says so and prints **no**
  metrics rather than fabricating any.
- **LARP eval** (task-1359): every settled LARP-detector verdict (`product_assessment`) is now written to the
  recorder's `verdicts` table (pack `larp-check`), and `dexterm backtest --subject larp` joins those verdicts to the
  outcome labels (latest t0 anchor ≤ 10 % of the horizon before the verdict; later anchors never match) and reports
  counts per verdict class, a LARP-vs-real confusion matrix and, only once ≥ 50 verdicts are matched, P(bad | LARP),
  P(bad | real) and P(LARP | bad) with 95 % Wilson intervals. It measures agreement with a bad price outcome, not
  whether a product is real. **Measured 2026-10-12:** 0 LARP verdicts recorded (the recorder never stored them
  before this change), labelled history n = 149 observed 1 h outcomes in the research DB and n = 0 in this
  machine's app DB, so no accuracy figure exists yet. **Re-measured after the task-1361 recorder fix (same day):**
  the app DB now holds n = 401 observed 1 h outcomes, but still 0 LARP verdicts (a verdict is only written when
  you run the LARP check on a token), so the LARP figure is still n = 0 and `larp-quality` stays in progress.
- **LARP/high-risk follow-up drafts** (task-1433): `dexterm larp-detected --out DIR` (or the cron-ready
  `node scripts/larp-detected.mjs --out DIR`) reads the local recorder without network access, scores only each
  point-in-time t0 row with the named H1 heuristic, and joins it only to a later recorder outcome. It writes a
  timestamped PNG evidence card and review draft for up to three qualifying coins, identified only by short mint,
  with the source, evidence age, follow-up horizon and same-dataset count of flags that did and did not meet the
  outcome condition. Fewer than 50 unique flagged coins is a thin sample and writes nothing. `--live MINT` makes
  a current, read-only graded card from one keyless lookup and says that no later outcome exists yet. These are
  drafts only: dexterm has no posting or scheduling path. A risk flag is not a certificate.
- **Skill backtest + tuning** (task-1401): `dexterm backtest --subject skills` replays the parts of the default
  analyst skills that CAN be replayed on recorded history and reports per-grade precision/recall (95 % Wilson
  intervals) on a train split and a held-out, later TEST split. The eval set (`packages/packs/eval/skills-eval.json`,
  1054 coins from this machine's recorder, 72 h keyless-proxy labels, bad = rug ∪ dead) keeps only point-in-time link
  evidence (a cached DexScreener/Jupiter record fetched within 1 h after t0; later records would leak the outcome)
  and no URL, name or symbol. Tuning is a grid search on the train split only (the code throws on a test row).
  **Held-out results (328 coins, 18.6 % bad):** the LARP check's links-only baseline is weak — MCC 0.039 before
  tuning, 0.054 after; its tuned `LARP` grade caught 4 of 14 coins (too few to rate), `EARLY_BUT_REAL` coins went
  bad 10.3 % of the time, coins with no website 29.2 %. The rug-check verdict rules went from MCC 0.043 to 0.159:
  liquidity under $5k is the one strong signal (`SPECULATIVE` → 54.8 % bad, `WATCH` → 14.4 %); dev %, organic
  score and top-10 % did not predict a worse 72 h outcome and now only lower confidence. The skills changed
  accordingly (`larp-check` 0.2.0 reads the baseline from `get_links` as a weak prior and never calls `LARP` from
  links alone; `rug-check` / `token-dossier` 0.3.0). **Not measured:** the LARP check's model stage (fetched pages,
  RDAP, GitHub) — past pages cannot be re-fetched as they were; it is measured forward by `--subject larp` below.
  Method, every number and the limits: `packages/packs/eval/README.md`. A grade is a risk flag, not a certificate.
- **Recorder maintenance actually runs** (task-1361): the outcome sweeps and labels never fired in two days of
  use (0 `sweeps`, 0 `outcomes` rows) because the first maintenance pass waited 60 s after launch and nothing ran
  at quit, and every real run had been a ≤ 14 s smoke/capture run. Now the first pass runs 5 s after launch
  (`RECORDER_FIRST_TICK_MS`), then every minute, and `Recorder.close()` labels what is due. Regression tests in
  `packages/recorder/test/schedule-1361.test.ts`; `dexterm recorder label` clears an older DB's backlog at once.
- **Screener presets.** **Graduating** now ships as a *keyless approximation* (an mcap-band proxy for a
  bonding-curve launch nearing graduation, labelled `approx` in the preset bar so the UI never implies the keyed
  bonding-% signal; it swaps to the real column when a launch source is keyed). **Smart money** stays gated on a
  top-traders key and says `needs key`, because a "smart money" preset without wallet-PnL data would mislead.

### Export / share a view (task-1401)

`E` on any screen writes the current view to **`~/.dexterm/exports/`** (`DEXTERM_HOME` overrides) as a PNG and a
plain-text report: `dexterm-<screen>-<coin>-<YYYYMMDD-HHMMSS>.png|.txt`. Nothing is uploaded, posted or copied
anywhere else; the toast names the file. The PNG is the frame rendered calm (no rain, glitch or scanlines, no toast,
help card or prompt) with a header band (title) and a footer band (contract, data ages, export time), and both
always carry the data label: **● LIVE DATA**, **◌ SAMPLE DATA · not real prices** (`--fixtures`) or **◌ REPLAY · recorded data**
(`--replay`, ages on the replay clock). The footer and the report list the **age of every data panel** (market,
candles, authorities, holders, rugcheck, goplus, trades on the token screen; `unavailable (reason)` / `needs key` when
a panel has no data). The token report adds the numbers on screen, the authorities, RugCheck, the H1 p(rug) when the screener scored
the coin and any LARP verdict, each labelled as a model output where it is one. One-shot: `--export [DIR]`. The PNG is pure
TypeScript (a 5×9 bitmap font drawn for dexterm, procedural box drawing / blocks / braille, coin images when the
terminal had pixel images); the exporter (`packages/cli/src/export.ts`: `ExportView` → `renderExportPng` /
`renderExportText` / `writeExport`) takes any rendered canvas, so other views (PNL cards) can reuse it.

### PnL cards: share a result to X (task-1407)

`H` on the **token** screen (that coin), the **positions** screen (`P`; every coin you have fills for, newest first)
or the **followed wallets** screen (`U`; the selected wallet's coins) opens a preview of a PnL card. In the preview:
`x` share to X · `t` copy as text · `s` save only · `a` show/hide the wallet · `z` exact size / size band ·
`f` 16:9 ⇄ 1:1 · `←`/`→` another coin · `esc` close. Every action saves `dexterm-pnl-<source>-<coin>-<stamp>-16x9.png`
(1200×675, the X card), `-1x1.png` (1080×1080) and `.txt` to **`~/.dexterm/exports/`** (dir 0700, files 0600).

- **Stamp.** Each card is stamped by where its numbers came from: **PAPER** (the paper wallet: simulated, no real
  funds), **LIVE** (the signer's ledger: wallet-signed transactions confirmed on chain; devnet fills say *DEVNET TEST
  FUNDS*) or **TRACKED WALLET** (a followed wallet's decoded public history, read-only). The stamp is a solid block,
  the frame colour and a repeating strip; there is no option to hide it.
- **Numbers only from records.** PnL is computed from the fills (average cost, the same rule as the paper and live
  ledgers): realized for a closed position, realized + unrealized at the latest price mark for an open one (refused
  until a mark exists). Nothing accepts a typed number. The card prints the time window, the fee basis, what was
  excluded (e.g. a tracked wallet's token-to-token swaps, transfers, airdrops) and the data ages (last fill, mark,
  history fetch).
- **Private by default.** The wallet address and LIVE tx signatures are hidden (`a` shows them; the text card then
  carries the full signatures so they can be checked on an explorer), size is a band (`under 0.1`, `0.1-0.5`, `0.5-1`,
  `1-5`, `5-10`, `10-50`, `50-100`, `100+ SOL`; `z` shows the exact SOL in and the absolute PnL). No balance, key or
  path is ever drawn. Footer: *not financial advice*, *trading in dexterm is experimental*, the dexterm URL.
- **Share to X without automation.** `x` saves the files, copies the 16:9 image to the clipboard where the OS allows
  (macOS `osascript`, Linux `wl-copy` / `xclip`; elsewhere the toast names the file to attach) and opens
  `https://x.com/intent/post?text=…` in your own browser with neutral text (the stamp in words, no coin, ticker, price
  or PnL; it passes the marketing GUARDRAILS scan). You paste the image and post. dexterm stores no X credentials and
  never posts. The only network read is for a TRACKED card: the coin's public decimals and price (the same keyless
  lookup the mirror checks use; no wallet or user data in it).

Code: `packages/cli/src/pnl-card.ts` (ledger adapters, the maths, the renderer on the task-1401 raster + PNG stack,
save/share), `packages/cli/src/pnl-app.ts` (the `H` key, the preview overlay). Fixtures and visual review:
`node packages/cli/tools/pnl-cards.mjs --out DIR` renders the profit / loss / long-hold fixtures at full size.

### Paste a CA or a coin link anywhere (task-1401)

A contract address, or a dexscreener / pump.fun / solscan / birdeye link, works wherever you can type one:
the `g` go-to prompt (screener, new pairs, watchlist, token), **the analyst chat** (a CA or link alone opens that
coin's token view; with a question, e.g. `is <CA> a rug?`, it opens the coin and asks the question about it), the
screener's `/` line (opens the coin, leaves the filter alone), `--mint MINT|LINK`, and the MCP tools (an agent may
pass a link as `mint`). A dexscreener.com/solana/<address> link usually names the **pool**, so it is resolved to its
coin first (one keyless DexScreener call; if that fails the address is tried as the mint). Read-only navigation:
nothing here trades. Parser: `packages/data/src/coin-target.ts`.

### Wallet intel, the bubble map and trade moments (task-1340)

**Holder classes (task-1367).** Every top holder is classed from the chain by `packages/data/src/intel/holder-class.ts`:
POOL / CURVE / VAULT / LOCK / CEX / BURN / DEV / LINKED, or UNLABELLED with what is known (never a guess; an
unknown program is counted, not hidden). Inputs are the token account's owner and the owner account's program, both
already fetched by the scan; the constant pool-authority PDAs are re-derived in `packages/data/test/holders-1367.test.ts`.
The token screen shows the class on each HOLDERS row, `Top 10 ex-pool` (no POOL/CURVE/VAULT/LOCK/BURN owners; the
colour reads it) next to `Top 10 raw`, and a `⚠ main risk` line when a counted owner holds more than 30 %. Lock
unlock schedules are not decoded yet (the escrow and program are shown). Snipers / bundled name the real reason a
launch window is missing (`needs Helius key` only without a key; `Helius paused · r`, `Helius cap today`,
`history failed · r`), and `r` retries.

`M` on a token opens the **BUBBLE MAP** (`packages/cli/src/screens/bubbles.ts` over `packages/tui/src/bubbles.ts`):
the top holders as packed half-row discs, area = share of supply, colour = the RULE that labelled the wallet (dev,
bundle, linked, sniper, pool/LP, exchange, unlinked), rings + tags for linked clusters, a CLUSTERS table,
sample-captioned HOLDER INSIGHTS and a WHY THIS LABEL panel (rule · confidence · evidence). The rules live in
`packages/data/src/intel/rules.ts` (P1 D1 R1 R1b R2 R3 R4 R5 S1 F1 X1 L0, ported from the task-1286 spike and
replay-tested against its three recordings); `intel/helius-history.ts` is the Helius-only `getTransactionsForAddress`
adapter (funders cached forever, launch windows 30 days); `intel/scan.ts` runs the two tiers (light on token open,
deep for watched coins / `D`) through the limiter, health registry and credit meter. Keyless the map still draws
from the public RPC holder list with static labels and says a free Helius key adds funders + the launch window;
no ranked list → `unavailable` with the fix. Exchange labels are a typed seed list and read **unverified**;
cabal-class labels are hidden by default (`HIDDEN_LABELS`). `M` on the bubble screen opens the same graph as real
circles in a loopback-only popup (`packages/popup/src/pages/bubbles.*`): hover = rule, click = select (the
terminal follows), `m` treemap, `z` zoom.

**Trade moments** (`packages/tui/src/fx-trade.ts`, `sound.ts`): buy shockwave, profit gold burst, loss static
collapse, failed lockout flicker, an in-flight scanning sweep. The ONLY producer is `LiveContext.onSettled`, which
the ticket binding calls once per settled outcome (booked paper fill, confirmed live fill, refusal, send failure;
never a quote, a plan or a `send-unknown`); `fireMoment` throws on anything that is not confirmed/failed. The
ticket is **shielded** (`Canvas.shieldRect`): no effect pass can write into it (tested byte-identical vs calm).
`--sound` / `DEXTERM_SOUND=1` adds synthesized cues (WAVs in `~/.dexterm/sounds`, played detached); muted by default.

### FREE-FOREVER: every feature works with zero paid keys (task-1309)

dexterm must be usable indefinitely as your DEX with **no paid data and no shipped keys** — Node, a terminal
and your own `claude` login are enough. Paid or user-supplied free keys only raise speed/limits or unlock depth;
they never gate a feature. Each data need has a keyless path and degrades honestly:

| Data need | Keyless source (no key) | Free-key upgrade (what it adds) | Per-user limit | Without it |
|---|---|---|---|---|
| Screener pool | DexScreener + Jupiter Tokens v2 | Jupiter free key via portal → 1 rps (from 0.5) | your IP's DexScreener 300/min, Jupiter ~30/min | — (fully keyless) |
| Token market | DexScreener + Jupiter | Jupiter free key: higher rate | per-IP | — |
| Candles / chart | GeckoTerminal | — | ~10/min per IP | chart `unavailable` (rare) |
| Trades tape | GeckoTerminal | Helius/Birdeye: richer, labelled flow | ~10/min per IP | tape `unavailable` |
| Mint/freeze authority | public Solana RPC (`getAccountInfo`) + Jupiter + GoPlus | any free RPC: faster, fewer 429s | per-IP RPC throttle | Jupiter/GoPlus still answer |
| **Top holders** | **Jupiter aggregate: holder count + top-10 % concentration** | **any free RPC key** (Helius/Alchemy/QuickNode/Ankr) → the ranked **top-20 list with owners** | per-IP/credits | count + concentration shown; ranked list says "needs a free RPC key" |
| Security checks | RugCheck + GoPlus (both keyless) | — | undocumented, paced | one may be `unavailable`, the other covers |
| New pairs stream | PumpPortal (`subscribeNewToken`/`subscribeMigration`) + Jupiter `recent` poll | Helius `programSubscribe`: live per-curve bonding % | per-connection | rows from the poll; bonding is a create-time estimate |
| Watchlist prices | DexScreener + Jupiter, persisted in SQLite | Jupiter free key: higher rate | per-IP | — |
| Fast-lane live price (open token + watchlist) | public RPC WebSocket `accountSubscribe` on the pump.fun bonding curve, price computed on-chain | free Helius key: lower latency, higher limits (used first) | per-connection; cap 24 subscriptions | falls back to the polled price (POLL badge) |
| Dev history / snipers / bundled | — (keyless cannot see wallet history) | Helius (wallet-intel scan: token open + the selected new-pairs row) | credits | columns dash + `needs Helius` |
| Wallet intel | — | Helius | credits | later card |

**Why a local client scales:** every free source meters by **your** IP/key, so each user has their own quota —
there is no shared server bottleneck.

**The ranked holder list is the one real keyless gap.** `getTokenLargestAccounts` is throttled (official RPC
429s it per-IP) or blocked (PublicNode 403) on every keyless endpoint we probed (2026-10-07), and
Birdeye/Solscan need keys. So keyless the holders panel shows **holder count + top-10 % via Jupiter**; the
per-wallet ranked list needs a free RPC key (2-minute signup, no card). Configure one of:

```sh
# Helius free (1M credits/mo): save the key ONLY here (never a repo, never a command line):
printf %s "<your-key>" > ~/.dexterm/helius.key && chmod 600 ~/.dexterm/helius.key
# …or any read-only RPC URL(s) — the first wins, extras join the rotation pool:
export DEXTERM_RPC_URL="https://<provider>/<path>"        # Alchemy / QuickNode / Ankr free tier
export DEXTERM_RPC_URLS="https://rpc-a/...,https://rpc-b/..."  # extra free endpoints (comma-separated)
```

**RPC pool (`@dexterm/data` `rpc-pool.ts`).** All configured endpoints (your key first, then the keyless public
seed list) go into a pool that rotates by health score, pauses an endpoint on a 429 (honouring `Retry-After`,
else a doubling backoff) and fails over to the next — each endpoint on its own rate bucket, so one endpoint's
pause never stalls the others. **Request budget meter (`budget.ts`)** counts every request per source (this
session and today, persisted in SQLite) so usage is visible; optional soft daily caps bound a source. The
**persistent SQLite cache** (TTLs in `cache.ts`) makes a restart or reopen instant and cheap.

Keyless proof: `DEXTERM_LIVE=1 HOME=$(mktemp -d) node packages/cli/scripts/smoke-1309.ts` runs the screener,
token (authorities + keyless holder aggregate), new pairs and watchlist with no key and prints a PASS per
feature, the pool status and the budget.

### Jarvis voice mode (task-1282, task-1339; macOS)

`v` is push-to-talk: press, speak, press again to send. A red `● LISTENING` badge sits on row 1 the whole time
the mic is live; `m` mutes replies, `,` cycles the macOS voice, `esc` stops a reply or cancels the mic, and any
other key closes the mic first and then does its job (the mic also auto-closes after 15 s). Free and local by
rule: speech-out is the built-in `say`; speech-in is on-device Apple Speech (a helper compiled once with
`swiftc` into `~/.dexterm/voice-helper`) or a local whisper.cpp `base.en` model; the only model in the loop is
your own `claude` login, for analysis questions. No paid speech API, no key, nothing recorded
(`DEXTERM_VOICE_RECORD=1` keeps the whisper WAV). `dexterm doctor` has a warn-only voice section; off macOS
voice is off and every voice action has a key.

- **Instant path (no model):** "show me the runners", "open bonk", "filter liquidity over 50k", "watch this
  one", "show the chart" / "close the chart" (the popup host), "buy bonk" / "sell half of wif" → a **PAPER
  ticket in its editing phase** for the spoken coin. Router + `say` measured under 1 ms after the transcript.
- **Analyst path:** questions ("is this a rug?") go to `claude`; the first two sentences are read back.
- **Clarifies, never guesses:** unknown ticker, copycat ticker (two mints, one symbol), homophone ("cell wif"),
  pronoun on an empty list, screen command + trade in one breath, bare "close"/"exit" → a spoken question.
  A named ticker always beats "it".
- **Proposals only (ROADMAP hard rule):** voice can never confirm, sign, flip a ticket to LIVE, arm a plan,
  raise a cap, panic or run `/wallet …`. The router's output is a closed set of kinds; `isSafe()` rejects any
  decision carrying a mode/live/arm/caps/confirm/sign/send field; the voice keys are off on the ticket screen;
  `packages/cli/test/voice-1339.test.ts` drives the real key loop with the executor, both confirm paths, the
  LIVE flip and the wallet commands booby-trapped (21 hostile utterances in-app, 0 touches; the router
  battery in `packages/voice/test/` adds more). A ticker that collides with a command word ("buy live"),
  more than one ticker in a breath ("buy wif and bonk") and a spoken size/slippage ("buy 10 sol of bonk")
  all clarify rather than open a silent ticket for the highlighted row.
- **Latency:** `node packages/voice/tools/voice-bench.mjs [--real-claude] [--recompile]`.
- **Env:** `DEXTERM_VOICE_STT=auto|apple|whisper|fake|none`, `DEXTERM_VOICE_TTS=auto|say|fake|none`,
  `DEXTERM_WHISPER_MODEL`, `DEXTERM_VOICE_HELPER_DIR`, `DEXTERM_SWIFTC`.
- **Unverified:** a person's first-launch Microphone + Speech prompts and a real spoken end-to-end pass.

### The Claude analyst (task-1302)

The ANALYST panel (and the full `a` screen) spawn **your own `claude` CLI** — no API key is shipped; your
subscription/billing and model default apply. It runs a versioned dexterm skill (`token-dossier`, `rug-check`,
`trench-scan`, built in task-1293) against the **read-only** `dexterm mcp` server, which exposes the same data
adapters the TUI uses plus the 17-entry knowledge base (`kb_lookup`/`kb_search`) and case files (`case_lookup`). Both the skills and the KB
can be overridden or extended from `~/.dexterm` (`dexterm kb|skill …`, see Customization).

- **`⏎` on a live token** → a full `token-dossier`; **`a`** → a `rug-check` on the selected token, or a
  `trench-scan` of the screener when nothing is selected. The verdict and tool-call lines are coral, the answer
  decrypts in, and the caption shows cost · latency · tools · model.
- **Facts come only from tools.** The analyst system prompt forbids token facts from memory; every number is
  grounded in a tool result with its source and age. Token names/descriptions/RugCheck text pass the prompt
  firewall (`<untrusted>`); prompt-injection in token text is flagged, never followed.
- **Read-only, always.** No tool can build, sign or send a transaction. Alerts/notes/watchlist adds are
  *proposals* the panel shows; you confirm them with a keypress (the model never writes).
- **Degrades cleanly.** If `claude` is missing or logged out the panel shows a one-line fix
  (`npm i -g @anthropic-ai/claude-code && claude login`) and the rest of dexterm keeps working.
- **Standalone server.** `dexterm mcp` is a plain stdio MCP server; add it to any Claude Code with
  `claude mcp add dexterm -- node packages/mcp/bin/dexterm-mcp.mjs`. (It runs its own in-memory data layer;
  sharing the TUI's live cache over a socket is a later card.)
- **Or on Codex (0.1.5).** `--analyst-engine codex` (or `DEXTERM_ANALYST_ENGINE`, `analyst.engine` in
  `config.json`, `/engine codex` in the chat; `auto` prefers claude, then codex) runs the same turns on **your own
  `codex exec`** login. The lock lives in the Codex CLI itself: user config and rules ignored, shell/exec, apps,
  plugins, hooks and sub-agents disabled (`--disable` fails closed on an unknown name), sandbox read-only,
  approvals never, web search off, one `dexterm` MCP server with an `enabled_tools` allow-list (read tools + the
  session's UI actions, never a paper/trade tool), and a tripwire that stops a turn on any other item. Proof:
  `packages/cli/test/codex-engine-015a.test.ts` (fake codex) and `packages/cli/test/measure/codex-015a` (the real
  codex-cli against a local mock model). Codex also works as an MCP client: `dexterm mcp install codex`.

**RPC and the Helius key.** `DEXTERM_RPC_URL` wins; else `~/.dexterm/helius.key` (mode 600, outside every repo) is
read *in code* and the Helius URL is built in memory; else the public RPC (holders usually 429 there). The key is
never printed: every URL in an error, a `--verbose` line or a `--record` file goes through `redactSecrets()`,
replay matches with the key redacted, and `FixtureStore.save()` refuses a file that still carries one.

**Credit meter.** Helius Free is 1M credits a month, budgeted as 33,333 a day. Each Helius request is charged
(1 credit for standard RPC methods, 10 for DAS-class); the header shows `◐ helius credits N%` from 50 % of the
day and at 90 % (or the per-run cap, `--max-credits`, default 5000) Helius switches off for the run and the
keyless sources take over. Day totals persist in the SQLite DB, so a restart keeps counting.

Keys on the live screens: `⏎` opens the token detail from any row, `w` watches/unwatches the highlighted token
(screener, new pairs, token screen), `b` proposes a liquidity alert, `y` arms the oldest proposal, `x` dismisses
it, `d` removes a watchlist row, `1`–`6` switch the token chart's timeframe, `r` refreshes. Alerts are proposals
until `y` confirms them; armed rules fire once into the ALERTS log. Nothing here trades.

```sh
DEXTERM_LIVE=1 node packages/cli/scripts/smoke-1298.ts --ws-seconds 45   # live smoke: ≤25 requests, one 45 s PumpPortal session, prints event→row/frame latency
DEXTERM_LIVE=1 node packages/data/scripts/record-1298.ts --ws-seconds 60  # re-record fixtures/task-1298-sample.json (key redacted at capture)
npm run dexterm -- --screen newpairs --replay packages/data/fixtures/task-1298-sample.json --db :memory:   # offline replay of the recorded session
```

Keys: `1`–`4` screens, `tab` cycle, `j`/`k` or arrows move, `⏎` open (the analyst starts thinking,
then its answer decrypts in), `esc` back, `a` analyst, `t` cycle theme (cyberspace → midnight →
ember → paper), `c` toggle calm, `p` pause, `E` export the view (PNG + report), `q` quit. Any key skips the boot sequence or a blink.
Screener keys: `/` filter editor (`vol24 > 250K liq > 50K age < 30d org >= 60 launchpad:pump
!flag:mint cat`; errors show inline with the column), `s` sort menu (enter on the current key
flips direction), `[` `]` presets (Trending, Runners, Organic; Graduating ships keyless as an `approx`
mcap-band proxy, Smart money needs a Tier-1 key and says so), `r` refresh, `g`/`G` top/bottom. The table refreshes every
10 s through the limiter; cells whose source is down show `—` and the panel caption names the
column and the reason (`holders, org: degraded`). Safety checks the keyless sources cannot answer
render `○ … needs key`, never a pass or a fail.
Demo event keys on `--fixtures`: `n` new pair (datamosh + stutter + shake), `u` pump (gold rain,
PUMPING band), `d` dump (red-shifted rain), `x` rug flag (full glitch).

## Paper bot (`trenchscope bot`)

A headless PAPER-trading bot that measures whether the screener's signals make money, with zero risk, before
anyone considers real auto-buys. `trenchscope bot run [--interval S] [--once|--ticks N] [--db PATH] [--verbose]`
loops over the live screener feed (the same keyless feed as `record` and `watch`). Each tick it marks every open
paper position with a real Jupiter sell quote and exits on take-profit, stop-loss, the time stop, or when the coin's
verdict turns AVOID, it gets the DEAD flag, or a mint / freeze authority appears; a coin with no sell route for 5
ticks in a row is written off at zero. Then it enters coins that pass the entry rules, within the caps. Fills use
the paper ledger's fill pricing (`paper.ts` `computeFill`) on the quote's in/out amounts, so route fees, price
impact and the quoted slippage are in the number, plus a simulated 5 000 lamport base fee and the configured
priority fee; never a mid price. PnL is net SOL out minus SOL in, converted at the entry's SOL/USD.

Two books share the feed, the caps and the exit rules: **strategy** (market filters + safety checks) and
**baseline** (market filters only, safety verdict ignored). `trenchscope bot stats [--since 24h|7d|90m|all] [--json]`
prints both and the difference, always with the sample size, labelled "paper, priced from live quotes, not financial
advice", and says the result is not yet meaningful under 20 closed strategy trades. Ledger and journal live in the
same SQLite db as everything else (`bot_positions`, `bot_journal`); a partial unique index allows one open position
per (book, coin), so a crash or restart never double-books. Every entry, exit and skip is journaled with its reason,
the full screener row the decision read, the quote, the fill and the config. Exit alerts (and entry alerts when
enabled) go through the `trenchscope alerts` notifier channels.

Paper only, structurally: `packages/cli/test/bot-paper-guard.test.ts` parses the bot's whole import graph and fails
if the signer, the live executor, the fast wallet, the bridge, the swap build or the rpc send path becomes reachable.
The bot imports the data layer through `@dexterm/data/core` (the trade-free entry) and the bin shims route `bot`
before the app loads.

Strategy knobs, the `bot` section of `~/.dexterm/config.json` (all optional; `trenchscope bot config` prints the
effective values):

| Knob | Default | Meaning |
|---|---|---|
| `sizeUsd` | 50 | fixed paper size per entry, USD |
| `slippageBps` | 300 | slippage tolerance sent with every Jupiter quote, bps |
| `priorityFeeLamports` | 100000 | simulated priority fee per fill on top of the 5 000 lamport base fee |
| `maxEntryImpactPct` | 3 | skip an entry whose buy quote shows more price impact than this, % |
| `takeProfitPct` | 40 | exit when the net sell quote is up this much on cost, % |
| `stopLossPct` | 20 | exit when the net sell quote is down this much on cost, % |
| `timeStopMin` | 360 | exit any position held this long, minutes |
| `maxOpen` | 5 | max open paper positions per book |
| `maxEntriesPerHour` | 4 | max new entries per rolling hour per book |
| `reentryCooldownMin` | 360 | no re-entry into a coin for this long after its exit, minutes |
| `entry.verdict` | `NO RED FLAGS` | worst safety verdict allowed at entry (`NO RED FLAGS` or `CAREFUL`; AVOID never enters) |
| `entry.maxRugP` | 0.2 | max H2 p(rug) risk score at entry |
| `entry.minMcapUsd` / `entry.maxMcapUsd` | 50000 / 5000000 | market cap band at entry, USD |
| `entry.minLiqUsd` | 20000 | minimum pool liquidity at entry, USD |
| `entry.minAgeMin` | 30 | minimum age since launch at entry, minutes |
| `entry.minChg1hPct` / `entry.maxChg1hPct` | 0 / 60 | 1 h price change band at entry, % (skip coins that already ran) |
| `entry.maxTop10Pct` | 30 | top-10 holder share must be known and below this, % |
| `alerts.entries` | false | alert on each paper entry |
| `alerts.exits` | true | alert on each paper exit |

The safety check also requires mint and freeze authority to be known and revoked; an unknown value is a fail, never
a pass.

## Coin images (task-1326)

Every row in the screener, new pairs and watchlist carries the coin's picture as a 2-cell icon (dropped
silently when the frame is too narrow), the token screen shows an 8×4 hero at the left of its header and the
screener's spotlight card a 6×3 one; the chart popup shows a 16 px image in its title strip.

- **Real pixels** in terminals with an inline-image protocol: **kitty graphics** (kitty, Ghostty, WezTerm,
  Konsole), **iTerm2 inline images** (iTerm2), **sixel** where the terminal advertises it. At startup dexterm
  sends one short capability query to the tty (a kitty probe, a cell-size request and DA1; ≤ 150 ms, replies
  parsed off the input) and picks the richest protocol the terminal actually answers.
- **Everywhere else — including Apple Terminal.app, tmux and screen — block art**: the image sampled into
  `▀` half-blocks (hero) or quadrant blocks (row icons), and on a 256-colour terminal dithered into the xterm
  cube so round logos keep their disc. Not a photo, but recognisable at a glance; `dexterm doctor` has a
  **Coin images** line that says which path you get and how to get the real thing (Ghostty or iTerm2).
- **Placeholder, never an error**: while an image loads, when a coin has none, or when a host is down, the
  cell box shows the ticker's initial on a colour hashed from the symbol.
- **Off switch**: `--no-images`, `DEXTERM_IMAGES=0`, or `~/.dexterm/images.json`:

  ```jsonc
  { "enabled": true, "blocks": "half", "protocol": "auto", "thumbMax": 96, "diskMb": 32, "replay": false }
  // blocks: "half" | "quad" (hero fallback) · protocol: "auto" | "kitty" | "iterm" | "sixel" | "blocks" (DEXTERM_IMAGES=<protocol> too)
  ```

  `--replay FILE` / `DEXTERM_OFFLINE` runs have no network, so images there could only come from the cache:
  they stay off unless `"replay": true` or `DEXTERM_IMAGES=1`, and recordings keep rendering exactly as recorded.
- **Images never block a frame.** A screen asks the image service synchronously; unknown URLs are queued
  (the rows on screen and the open token first), fetched by a small pool, decoded in a **worker thread** and
  painted on the next redraw. Kitty placements survive text redraws; iTerm2/sixel images are re-emitted only
  on the rows the diff flusher rewrote; every placement is deleted on a screen change and freed on quit.

### Privacy and safety of coin images

Fetching a coin's picture contacts the host that serves it (DexScreener's image CDN for most coins, otherwise
whatever URL the token's metadata points at — an IPFS gateway, a project's own site). dexterm therefore
**fetches through its own local cache, once per image**, and the chart popup is served the cached copy from
the loopback server — a third-party image host never sees a popup load, and a coin seen before is never
fetched again (`~/.local/share/dexterm/images/`, LRU-capped at 32 MB, our own re-encoded PNGs only). If you
do not want any image host to see your IP, run with `--no-images` (or `"enabled": false`): nothing else
changes. Image bytes are treated as hostile: the format is sniffed by **magic bytes** (never the URL or the
Content-Type), size and dimension caps are enforced before a pixel buffer exists (2 MiB, 2048², 4 MP), and
decoding is pure TypeScript (PNG, baseline + progressive JPEG, GIF first frame; WebP is recognised and
refused) — no native decoder, no system library, nothing executes. The fetch follows the LARP detector's
SSRF rules (http/https only, no credentials, every hostname resolved and private / loopback / link-local /
CGNAT ranges refused, redirects re-validated hop by hop, 8 s budget). DexScreener's CDN is asked for a 128 px
rendition instead of the 800 px original. Failed URLs are remembered for 6 h so a dead IPFS link is not hammered.

## The cyberspace look (task-1297, VISUAL-V2)

- **Theme tokens.** `cyberspace` is the default; midnight / ember / paper keep working with quiet
  effect tokens. Every theme carries `rain` / `rainPump` / `rainDump` ramps, `magenta`, `cyan`,
  `coral`, `acid`, `glow`, `scan` and `logo`.
- **Two masks on the cell buffer.** `put()` marks data glyphs *hard*; effects write through `putFx()`,
  which refuses hard and non-blank cells, so **no effect can overdraw a number by construction**.
  Rain additionally needs a *zone* (header band, gutters, the space under the last table row, the
  blank part of every panel, the footer) that screens and widgets opt into. `tools/contrast.mjs` and
  `test/fx.test.ts` prove it (hard cells byte-identical between calm and effects renders; every
  numeric cell ≥ 4.5:1 with effects on).
- **Passes** (`applyFx`, deterministic per `--frame`): seeded rain made of the user's own tickers,
  mint prefixes and tx tails (plus katakana/hex), phosphor trails, chromatic aberration on headings,
  datamosh blocks, whole-frame shake, CRT scanlines. Events (`pulse`): new pair, rug, pump, dump.
- **Market → rain.** Colour and speed come from the data: on the token screen the selected token's
  candles (gold ramp on a pump, red on a dump), elsewhere the rows on screen (5 m deltas plus volume
  velocity on live rows), EMA'd every data tick.
- **Blink** (≤ 350 ms at any cap) on every screen change, **decrypting analyst** with the Claude Code
  spinner, **boot**: the first launch is the full glitch boot, later launches a one-second boot;
  `~/.dexterm/state.json` remembers (`DEXTERM_HOME` overrides the directory, `--no-boot` skips).
- **Intensity tiers.** `fever` (default, 30 fps), `normal` (15 fps, sparser rain, no idle
  aberration), `off` = calm (`--calm`, `DEXTERM_CALM=1`; `NO_COLOR` implies it). Rendering stays
  row-diff flushed; blink and shake frames are wrapped in DEC 2026 synchronized output.
- **Fallbacks.** `--color 256` approximates the ramps; `NO_COLOR` keeps bold/dim only; a non-UTF-8
  `LANG` (or `--ascii-rain`) swaps the katakana for hex.

Color depth is detected from `NO_COLOR`, `FORCE_COLOR`, `COLORTERM`, `TERM`, `TERM_PROGRAM`
(`--color truecolor|256|none` overrides). Non-TTY stdout prints plain text unless `--ansi`, which
on a pipe means 24-bit colour (`NO_COLOR` still wins, `--color` still overrides).
The fixture clock is pinned to America/New_York so frames are identical on every machine
(`--tz ZONE` or `--tz local` to change); replays pin it to the recording.

## Test

```sh
npm test              # tsc typecheck, then the parallel lane, then test:serial, then test:perf
npm run test:serial   # the serial lane alone: packages/*/test/serial/*.test.ts, one file at a time
npm run test:perf     # the perf lane alone: packages/*/test/perf/*.test.ts, one file at a time
DEXTERM_TEST_NO_RETRY=1 npm run test:serial   # same, with the automatic retry off (reproduce a flake)
```

`npm test` runs three lanes, in order:

1. **parallel**: every `packages/*/test/*.test.ts` file at once (one process each, ~150 of them).
2. **serial** (task-1424): `packages/*/test/serial/*.test.ts`, one file at a time, after the parallel lane
   has finished, so these tests never share the CPU with it.
3. **perf** (task-1410): `packages/*/test/perf/*.test.ts`, one file at a time, last.

The parallel glob does not reach `test/serial/` or `test/perf/`. **Where a test goes:**
- a test that drives a terminal through a pty (`measure/drive.py`, `measure/action-pty.py`,
  `measure/quit-timing.py`, an inline `pty.fork`), runs the interactive loop on real timers, or asserts a
  wall-clock bound (the < 1 s quit, the 50 ms fuzz budget, a server lifetime a request must fit inside)
  goes in `packages/<pkg>/test/serial/`;
- a render or CPU budget goes in `packages/<pkg>/test/perf/`;
- everything else (deterministic, FakeClock, replay, one-shot CLI frames) stays in the parallel glob.
  A loose "doesn't hang" bound (≥ 10× headroom, e.g. "resolves in < 1 s instead of the 60 s pace wait")
  may stay parallel.

Serial and perf tests register with `serialLane(import.meta.url)` from `packages/cli/test/serial/lane.ts`
instead of `test()`. That gives each test **one automatic retry, logged and never hidden**: the first
failure is printed in full on stderr and attached to the test as a TAP diagnostic, and
`scripts/test-lane.mjs` (which runs both lanes) ends with a summary of every test that needed the retry
(`RETRY passed on retry: <file> › <test>` plus the first failure), or `no test needed the automatic retry`.
A test that fails twice fails the run. Assertions are not relaxed for the retry. A test that needs the
retry is load-sensitive: report it in the handoff. `DEXTERM_TEST_NO_RETRY=1` turns the retry off.
`packages/cli/test/lanes-1424.test.ts` (parallel) enforces the layout: no parallel file drives a pty
harness, every serial/perf file uses `serialLane`, `npm test` keeps the lane order, and the retry logs.

No pty test opens the user's cache database: `quit-timing.py` and `action-pty.py` pass the app a
throwaway `--db` (task-1424: with the default `~/.local/share/dexterm/dexterm.db` a run beside another
lane's run, or beside an open dexterm, could exit 2 with `database is locked` before painting, the
quit-1319 / task-1313 pty flakes); the `drive.py` and guard pty tests run `--fixtures` (no database) with
`DEXTERM_HOME` in a temp dir, and the LARP run sets HOME to a temp dir. `quit-timing.py` (the networked
quit check) still reads the real `DEXTERM_HOME`, so it keeps the user's RPC configuration. It starts its
fill clock at the app's first paint, not at spawn, and if the app never paints it says whether it exited
or timed out and prints the tail of the app's stderr.

(task-1410: the 1330 p95 check used to sit in the parallel glob and read ~40 ms of scheduler noise on
every full run, against ~3 ms alone.) `packages/cli/test/perf/render-1330.test.ts` has two guards for
the trending, token + social and KOL screens at 176×48:
- **frame budget**: p95 per tick under 16 ms (one 60 Hz frame), on two clocks (task-1424). The main
  thread's **CPU time** per tick (`process.threadCpuUsage`) is asserted every run: another process on the
  core cannot inflate it, and a slower render always does. **Wall time** per tick (`performance.now`) is
  asserted whenever the p95 tick cannot be a preempted one: at most n − 1 − ⌊0.95·n⌋ ticks lost more than
  1 ms of wall time beyond their CPU time, with no voluntary context switch. Under a full CPU hog the wall
  p95 is scheduler time (p50 ~3 ms, p95 ~60 ms at 2× oversubscription, CPU p95 ~4 ms); the run then prints
  `wall p95 NOT asserted: k/150 ticks lost > 1 ms to other processes, CPU p95 asserted`. If the render ever
  blocks (a voluntary switch), the wall check is asserted regardless.
- **regression guard**: median render time ÷ median of a fixed reference workload, timed interleaved
  frame by frame so machine speed and background load affect both the same way. It must stay under 2×
  the ratio recorded in the test (`RATIO_BASELINE`). An injected 3× render slowdown (p95 ~8–10 ms,
  still inside 16 ms) fails it at ratio ~7.0 against a limit of 4.7. After an intentional render change,
  recalibrate `RATIO_BASELINE` from the printed `ratio` values and say so in the handoff.

The pty tests (`serial/qa-1311-pty`, `serial/task-1313-pty`, `serial/larp-pty`) do not use fixed sleeps.
Each step waits for the screen to show the expected content: `action-pty.py` waits on its own screen model,
and `drive.py` has `WAIT:text[@secs]`, which also shifts the rest of the key script by the time it waited.
A slow boot under load therefore delays the script instead of racing it.

Snapshot goldens live in `packages/cli/test/snapshots/` and are the **calm** render of this
renderer (`npm run snap:update` regenerates them after an intentional change; say so in the pull request).
When the internal v2 prototype is present (maintainers only), token / new pairs / watchlist / analyst are compared byte for
byte against `prototype-v2 --calm --theme midnight` (plain and 24-bit ANSI, allowing only the coral
rule on the analyst's lines); the screener's column set is compared against both prototypes.
The three `screener-live-*` goldens render the screener over the recorded data-store sample
(`packages/data/fixtures/live-sample.json`).

Tests never touch the network: the CLI tests block `fetch` and replay the recorded sample; the
loop tests point `DEXTERM_HOME` at a temp dir so no test touches the real state file.
The coin-image suites (`packages/*/test/images-1326.test.ts`) decode checked-in codec fixtures
(`packages/data/fixtures/images/`, generated once with libjpeg-turbo + ffmpeg), assert the three wire
formats byte for byte against recorded terminal replies, and drive the screens with an offline ImageService.
The filter grammar suite (`packages/cli/test/filter.test.ts`) checks `vol24 > 250K liq > 50K`
against a hand-written predicate on fixture and real rows, plus every error message.
`packages/cli/test/live.test.ts` and `packages/data/test/task-1298.test.ts` replay
`packages/data/fixtures/task-1298-sample.json` (Helius mint + holders with the key redacted, GoPlus,
GeckoTerminal trades, RugCheck `new_tokens`, a 60 s PumpPortal session) through the live bindings and screens.

```sh
node packages/cli/tools/shot.mjs --out DIR                 # 26 cyberspace PNGs: 5 screens × 176/120/90, calm set, boot, pump, glitch, dump, normal, midnight
node packages/cli/tools/shot.mjs --replay FILE --out DIR   # the live app over a recording (screener + the demo-data screens)
node packages/cli/tools/shot.mjs --legacy --out DIR        # the nine SPEC §7.8 v1-theme frames
node packages/cli/tools/contrast.mjs [--json out.json]     # readability report, exit 1 if a numeric cell is below 4.5:1
node packages/cli/tools/demo.mjs --out DIR                 # 21.5 s 1920×1080 30 fps mp4 + contact sheet (headless Chrome → ffmpeg)
python3 -I packages/cli/tools/cpu-measure.py --seconds 60 -- --intensity fever   # idle CPU in a pty
```
(`shot.mjs` and `demo.mjs` need puppeteer in a parent `node_modules` and `demo.mjs` needs ffmpeg; neither is a dependency.)

## Customization (task-1358)

Everything under `~/.dexterm/` (`DEXTERM_HOME`); `config.json` is machine-written (v4, 0600, journaled with inverses: `ctrl+z` undoes),
holds no secrets by construction (the schema has no key field; an old config with a key gets it moved out to `<name>.key`).

- **Workspaces** — `~/.dexterm/workspaces/<name>.json`: start screen, theme, intensity, screener preset/filter/sort, token panels, per-screen pane trees for the layout solver, and the HUD popups to open together. `ctrl+w` then `w` list · `n`/`N` next/prev · `s` save as · `m` morning HUD · `o` popups · `d` default · `1-9`; `--workspace <name>`; `dexterm workspace list|show|remove|init`. A switch is a UI action: it can navigate, re-theme and open read-only windows, never a ticket.
- **Themes + keymaps** — `~/.dexterm/themes/<name>.json` (`extends` a built-in + `tokens`; hex-only, a contrast floor and an up/down hue guard so a shared theme cannot hide a warning or swap buy/sell colours), `config.theme.overrides`; `config.keymap` re-binds actions (reserved keys `ctrl+c esc enter y !` and the confirm/dismiss/panic/quit actions are refused by name; collisions and chord-prefix clashes refuse the whole keymap). `dexterm theme list|show|init|check`, `dexterm keymap [screen]`.
- **Price display mode** (task-1366) — `$` flips USD price ⇄ MARKET CAP on the screener, watchlist, new pairs, token screen, both charts (Y axis in K/M/B; the popup legend shows the price in parentheses), order-plan levels and position rows; saved as `config.display.priceMode` (`dexterm display [price|mcap]`, `--price-mode`, a workspace's `priceMode`). Market cap = price × the supply the sources report (mcap ÷ price at the latest tick); history uses the CURRENT supply and every mcap chart says `mcap (current supply)`; a token without a supply shows its price marked `ᵖ` / `supply unknown · showing price`. Display only: `packages/cli/src/display.ts`; nothing that trades reads it.
- **Rules engine** — `when <cond> [for n ticks] then alert|ticket|ask|popup|tag|sound|watch [cooldown] [max n/h] [scope] [window] [name]`, parsed never eval'd, mandatory cooldown + max/h, a live dry-run while typing (`ctrl+r`, `dexterm rules …`). Rules only alert, annotate your own watchlist, open read-only popups, or PROPOSE: ticket/ask become proposal cards that open the PAPER ticket editor / ask the analyst on your keypress. Money-shaped args (`arm`, `auto`, `sign`, …) are refused at parse time, in text and in JSON.
- **Live holder/rug signals** (task-1404) — while a token is open (or watched) dexterm streams its holder and safety state instead of reading it once on open, and surfaces the *changes*: a dev/creator sell, a top-holder / top-10 concentration shift, LP removal or an unlock change, a mint/freeze authority flip, a new bundle / sniper cluster, a fresh-wallet inflow, bonding-curve progress, a migration. Each is a risk flag (never a verdict) shown on the token screen's ON-CHAIN panel with its **source** and the **age** of the data it read, and degrades visibly to `stale` (never a fabricated number). The cheap on-chain reads refresh with the 10 s token poll and bonding streams sub-second from the fast lane; the credit-metered Helius leg (holders / bundle / sniper / fresh) re-scans on a slow cadence while the token is open. Every signal is also an **alert trigger**: the rules engine gains the fields `fresh`, `mintable` and `freezable` alongside `top10`/`dev`/`bundled`/`snipers`/`lpLocked`/`bonding`/`cluster`, so e.g. `when dev.delta < -2 then alert(down, "dev dumping")`, `when mintable > 0 then alert(warn)`, `when lplocked.delta < 0 then alert(down)` or `when top10.delta >= 5 scope mint:<addr> then alert(warn)` fire on the live values and deliver through the task-1398 alert channels.
- **Packs** — a directory of the above (+ popup widgets) with a sha256 `pack.lock` and an optional `ssh-keygen -Y` signature; trust reviewed > signed > unsigned. `dexterm pack verify|add|remove|export|lock|sign|trust|signers|keymap|widget|list`. A pack never runs code: widgets install DISABLED, unsigned rules load disabled, the keymap merges only with `pack keymap <name> --merge`, and every load re-hashes the installed copy. Malicious-pack suite in `packages/custom/test/packs.test.ts` + `packages/cli/test/pack-1358.test.ts`.
- **Knowledge base + skills** (task-1377) — your own copies live in `~/.dexterm/kb/entries/<id>.md` and `~/.dexterm/skills/<name>.md`, the same frontmatter + markdown as the bundled 17 KB entries and analyst skills. Same id as a bundled one = your file overrides it; a new id = added; the bundled files are never edited. `dexterm kb|skill list|show|new|edit|check|reset|path`: `edit` copies the bundled file into `~/.dexterm` and opens `$VISUAL`/`$EDITOR` (no editor or no TTY: it prints the path to edit), `check` validates frontmatter and size (a KB entry ≤ 16 KB with a body ≤ 4000 chars, a skill ≤ 32 KB / 8000), `reset` moves your file to `<dir>/.reset/` so the bundled one is back. The MCP server (`dexterm mcp`, also for your own agent), the analyst and Jarvis read the MERGED set and re-check the files on every call or turn, so an edit needs no restart; a file that fails `check` is skipped with the reason (MCP stderr, `list`, `dexterm doctor`) and the bundled one stays in effect. Safety: a skill is read-only guidance: its `tools:` may name only read tools, and a skill that names a trade / sign / arm / ticket / send tool anywhere (`open_ticket`, `execute_swap`, `mcp__…`, `/wallet …`) or sets `allowed-tools` / `model` / `hooks` is refused. Your text is untrusted like token text: it reaches a model only through the prompt firewall (`<untrusted source="kb:user:…">`, a user skill behind a dexterm preamble), `kb_lookup` reports `origin: bundled|user`, and an address in a user KB entry shows as `[addr]` (a KB entry never holds facts about a live token; `check` warns). Packs do not carry KB entries or skills. Every new/edit/reset is journaled in `~/.dexterm/kb-skills.journal.jsonl` (hashes, not content). For example: `dexterm kb edit lp-burn-vs-lock` or `dexterm skill edit rug-check`, save, and ask the analyst again.
- **Widget API (beta)** — a pack widget is an html page the popup host serves inside its own wrapper window as a sandboxed iframe: the wrapper (ours, nonce CSP) owns the socket and names exactly one `frame-src`; the pack page runs under a hash-only CSP (every inline `<script>`/`<style>` allow-listed by sha256, no nonce, nothing substituted into the pack html; `<script src>`, `<link>`, frames, `<meta http-equiv>` and `@import` refused at install, open and ticket issue) with no network of its own (`connect-src 'none'`), an opaque origin, Trusted Types where the engine has them, no way to navigate anywhere (the parent's `frame-src` governs the child's every navigation), and — r4/r5 — a **DOM seal**: the SDK runs first and locks the DOM insertion methods, every HTML-parsing entry point (including the static `Document.parseHTMLUnsafe`), `adoptNode`/`importNode`, the element-taking setters and WebRTC on the prototypes, with a MutationObserver belt, and cancels any click on a link that targets another window (r6: WebKit opens a connection to the link's host:port before the sandbox refuses the popup), so none of the three connections no CSP directive covers (runtime preconnect, WebRTC, a targeted click) can be made by any path — without relying on Trusted Types, which the system WKWebView of macOS 14/15 lacks; verified on that WebView in the real shell and in headless Chromium + WebKit with a raw TCP sink. Widgets open only in the native shell (macOS 14+), which also routes every WebView connection through a loopback sink proxy (a backstop for named hosts). It is fed public view models (`rows · token · narrative · positions · alerts · theme`) by `postMessage` through a frozen `dexterm` SDK; it can only receive. `packages/popup/WIDGETS.md`; example `packs/example-widgets/`.

Not built from the task-1288 design: the in-process plugin sandbox (columns/panels, `net.fetch`, `storage.kv`), the Jarvis config assistant's `config_propose` MCP tools, `pack add` from git/zip, and a shipped reviewed-pack list (it is empty until a first-party pack is reviewed).

## Rules

- No runtime dependencies. Dev: `typescript`, `@types/node`.
- Nothing here holds keys, signs, or sends transactions.
- Token-originated strings are untrusted and go through the prompt firewall before any model sees them (D-12).
- Identity hygiene (task-1415): never write a person's name, handle, agency or machine name anywhere in this
  tree: code, comments, test names, fixtures, frontmatter (`owner: maintainers`), evidence/measure files or
  absolute home paths. Say "the maintainers" (or "a tester", "the user"), use neutral fixture names, and write
  paths relative to the repo or under `/tmp`. `packages/cli/test/identity-1415.test.ts` enforces this in
  `npm test` against a term list kept outside the app (maintainer checkouts only; it skips without it).
