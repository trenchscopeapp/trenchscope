# AI SCAN MODE (task-1324) — design note

**Goal.** One key (`Z`), a flag (`--scan`) or a command (`/scan on|off|stop|resume`) turns on a watcher that
scores coins from data the app ALREADY has, pulls the most exciting one up, runs the analyst on it in
1323's short bold style, and keeps refreshing that read while data moves — until the user cancels.

**Inputs (no new requests).** `observe.ts` builds one `ScanObservation` per coin from: the screener feed
rows already in memory (price, chg, vol5m/1h/6h/24h, liq, holders, age, authorities); the DexScreener pair
`Store.enrich` already cached under `ds:token` (txns m5/h1 buys/sells — the same read `flow.ts` does);
the open token's view (fast-lane price, candles already loaded); `larpByMint` (verdicts that already exist).
It only calls `Cache.get` (SQLite read). Nothing in `scan/` touches the HTTP client or the limiter.

**Triggers** (pure, `engine.ts`; each returns fired + strength 0..1 + a reason string with the numbers):
| id | fires when (defaults, all `--scan-*` / `ScanConfig`) | weight |
|---|---|---|
| `vol` | vol5m ≥ 3× the coin's OWN 6h average 5-min pace (vol6h/72; else vol1h/12, vol24/288), vol5m ≥ $2k; full at 10× | 30 |
| `flow` | buy/sell flip (`flow.ts buyShare`): m5 buy share ≥ 62% while h1 ≤ 52%, ≥ 20 m5 txns; full at 85% | 25 |
| `fresh` | age ≤ 60 min, ≥ 40 m5 txns, m5 buy share ≥ 58%, vol5m ≥ $5k; full at 150 txns | 20 |
| `breakout` | last close > max high of the prior 20 cached candles by ≥ 2%; full at +10% | 20 |
| `liq` | liquidity ≥ +20% vs the coin's own min over the last 10 min (engine ring); full at +60% | 15 |
| `holders` | holders ≥ +5% and ≥ +25 vs the oldest sample in 10 min (engine ring); full at +25% | 15 |

Points = weight × (0.5 + 0.5 × strength) per fired trigger; score = min(100, Σ). A coin is EXCITING when
score ≥ `minScore` (45) AND ≥ `minTriggers` (2) fired. Gates: liq ≥ $10k. **Vetoes** (score forced to 0,
reason shown): an existing LARP verdict `LARP` (never invokes larp-check), mint or freeze authority enabled.

**States.** `off` → `scanning` (warm-up 30 s builds the rings; ticker of the top 5 scores + reasons) →
`locked` (one coin; analyst started; refreshes) → `paused` (analysis cancelled; holds the coin, no turns)
→ `scanning` again only on RESUME. **No-hop rule:** in `locked`/`paused`, `tick()` never returns a lock
decision for any coin — the ticker keeps scoring for display only. Stop (`Z` / `/scan off|stop`, or Esc on
the screener while scanning) → `off` from any state and cancels the scan's in-flight turn.

**Keys.** `Z` toggle scan on/off · `R` resume scanning (after a lock) · Esc while LOCKED = cancel analysis
(interrupts the running turn via the analyst's existing `interrupt()`, stops refreshes, state `paused`);
a second Esc navigates back as usual. `/scan …` works from the screener `/` line and the chat input.

**Cost control (OFF by default).** Every analyst turn the scan starts (lock or refresh) is an invocation:
≤ `maxAiPerHour` (8) rolling, ≤ `maxAiPerCoin` (4) per coin per hour; a lock needs budget for one turn.
Refresh while locked: ≥ `refreshS` (90 s) after the last read, analyst idle, AND the data materially moved
(price ≥ 3%, m5 buy share ≥ 10 pts, vol5m ×/÷ 1.5, or a new trigger fired). After a lock ends the same
coin is barred `coinCooldownS` (15 min) and no new lock for `postLockS` (60 s). The header shows
`◉ SCAN <STATE>` while on; `LiveContext.scanMeter` puts `ai used/cap` into the credit-meter status.

**Analyst path.** A lock opens the token screen (`live.openToken`) and starts an `AnalystSession` chat
turn (no paid structured skill) asking for the short read with the WHY reasons (numbers only — no token
text in the prompt; the CONTEXT block still wraps token text as untrusted). Refresh = `ask()` on the same
warm session ("SCAN REFRESH … updated short read, say what changed"). `longForm: false` always.

**Safety (structural).** Scan sessions run with `actionTypes: []`: (1) `ActionAllow.types` gates
`validateAnalystAction` (absent = the 1313 five); (2) the screen state the MCP server sees carries
`actions.types = []`, so `open_ticket` etc. fail in the server; (3) argv adds
`--disallowedTools mcp__dexterm__open_ticket,…`; (4) the app's scan `onAction` re-validates with the same
empty list and toasts "blocked". Scan code imports nothing from trade/paper/executor/bridge/wallet
(static test). It can never open a ticket, sign, confirm or trade.

**UI.** Row 1 (the blank band under the header, no layout change) carries the SCANNING ticker on list
screens and the `WHY IT TRIGGERED` strip (reasons · score · time · next read) on the locked coin's token
screen. The live read is the analyst panel (1323's short style). Calm mode: the scan adds no draws; the
2 Hz data tick paints whatever changed. The scan tick runs every 2 s and recomputes only when the feed rows,
the open token's data or the verdict map changed (else every 10 s for cooldown expiry).
