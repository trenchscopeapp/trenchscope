# ALERTS + delivery (task-1398, dexterm 0.1.2) — design note

**Goal.** Rules already fire alerts, proposals and UI actions inside the running terminal (task-1358
Tier 3, `@dexterm/custom` `RulesEngine` + `cli/src/rules.ts`). 0.1.2 adds two things on top: (1) a
**delivery** layer that can PUSH an alert out of the app — macOS/Linux desktop notification, the user's own
Telegram bot or Discord webhook — so an alert reaches you when the terminal is closed; and (2) a headless
**`dexterm watch`** that runs the rules engine against the live feed with no TUI and delivers through that
layer. No new trigger *mechanism* is invented: the four headline triggers are expressed in the existing
rule grammar, with one small addition (a numeric `larp` field) so a LARP grade change is a rule.

## The four triggers (all plain rules; `scope`, `cooldown`, `max/h` already apply)

| Trigger | Rule | Notes |
|---|---|---|
| price level | `when price >= 0.002 then alert(up, "WIF hit target")` | any numeric field + op |
| holder concentration change | `when top10.delta >= 5 then alert(warn, "top10 climbing")` · `when cluster >= 60 then alert(warn)` | `.delta` / `.velocity` over the engine's per-mint ring; `cluster` = top linked-cluster share from wallet intel |
| LARP grade change | `when larp.delta < 0 then alert(warn, "LARP downgrade")` · `when larp <= 0 then alert(warn)` | **new** `larp` field, below |
| new-pair match on a screener filter | `when liq > 50K and vol5m > 25K scope newpairs then alert(up)` | `scope newpairs` = age ≤ 120 min (unchanged) |

### New `larp` field
`@dexterm/custom`'s `RuleRow`/`FIELDS` gain `larp` — a numeric grade for the LARP-detector verdict, higher =
more real: `REAL_PRODUCT 3 · EARLY_BUT_REAL 2 · UNVERIFIABLE 1 · LARP 0` (`larpGrade()` in `cli/src/rules.ts`,
the only place the string verdict is known). `null` when no verdict exists yet (clauses on it are false, same
as any missing field). Because it is numeric it inherits `.delta` (grade moved) and `.velocity` for free from
the existing ring, so "grade changed/downgraded" needs no new engine machinery. In the app it is read from
`state.larpByMint`; in `watch` it is read from the recorder's latest verdict per mint when a `--db` is present,
else absent.

## Delivery layer (`cli/src/alerts/`)

A delivered alert is one normalised, firewalled value; adapters are interchangeable; routing is pure.

- **`AlertDelivery`** (`types.ts`): `{ level, title, body, symbol, mint, source, rule, at, spoken }`. `title`/`body`/
  `symbol` are already run through the prompt firewall (`@dexterm/data` `firewallText` — control/bidi/ANSI
  stripped, URLs→`[url]`, foreign addresses→`[addr]`, wide glyphs→▯, injection-flagged text neutralised) and
  `spoken` additionally through `@dexterm/voice` `sanitizeSpeech` (defuses `say` `[[…]]`, shortens addresses) so a
  channel that speaks is safe too. Token names/symbols/bios are untrusted and never reach a channel raw.
- **`DeliveryAdapter`** (`types.ts`): `{ name, available(): boolean, deliver(d): Promise<DeliveryResult> }`.
  `deliver` never throws; a failure is `{ ok:false, reason }`. Adapters: `toast` (writes the one-liner to the
  caller's sink — the TUI toast in-app, stdout in `watch`), `desktop` (macOS `osascript -e 'display notification'`,
  Linux `notify-send`; spawn is injectable), `telegram` (`https://api.telegram.org/bot<token>/sendMessage`,
  `fetch` injectable), `discord` (the user's webhook URL, `fetch` injectable).
- **`Notifier`** (`notifier.ts`): built from `config.alerts` + credentials on disk. `deliver(d)` routes `d` to the
  enabled channels whose `levels` filter admits its level (and the `proposals` gate for proposal-kind), calls each
  adapter, and returns the per-channel results. It never throws and never logs a credential.
- **Routing** (`route.ts`, pure): `config.alerts.channels.<name>.{enabled,levels}` (a `levels` subset of
  up|down|info|warn; absent = every level) + a global `proposals` flag. Default when `config.alerts` is absent:
  toast only (in-app behaviour is unchanged).

### Credentials (local, never logged, never on argv)
Bot tokens / webhook URLs are **never** in `config.json` (the schema has no key-shaped fields, by rule). They
live in `~/.dexterm/telegram.json` and `~/.dexterm/discord.json` (mode 0600, outside every repo), read only by
the adapters (`creds.ts`). `config.alerts` holds only enable flags, the per-channel `levels` filter, and the
Telegram `chatId` (an identifier, not a secret). `dexterm alerts set-telegram|set-discord` takes the secret from a prompt
on stdin or an env var — never a command-line argument — and writes the 0600 file; it echoes only
`set (nn chars)`. Any error/log path runs values through `redactCreds()`. Tests use fake adapters only; no test
makes a real network call to Telegram or Discord.

## `dexterm watch` (headless)

`watch-cmd.ts`. Builds the live feed + a `RulesEngine` from `config.rules`, then loops: refresh the feed →
build rule rows → `observe()` → `evaluate()` → deliver every fired alert (and, when `alerts.route.proposals` is
on, a one-line summary of each ticket/ask proposal — never the ticket itself) through the `Notifier`. `--replay
FILE` drives it from a recording and exits at end of file (used by the tests); `--interval S`, `--once`,
`--ticks N` bound a run; `--db` enables recorder-sourced `larp`. The row source is injectable (`WatchSource`) so
the suite drives a scripted sequence deterministically with fake adapters and a fake clock, no feed and no net.

## Safety (structural, unchanged invariant + a new proof)

A rule's outputs are alerts, annotations, UI actions and PROPOSALS only (`RulesEngine`'s money-safety invariant;
`normalizeAction` drops unknown args and refuses money-shaped keys). The delivery layer only *reads* an
`AlertDelivery` and a proposal's text summary; it imports nothing from trade/paper/executor/signer/wallet/mandate
and has no arm/sign/confirm/cap path. `dexterm watch` constructs no signer and passes no `trade` option to
`LiveContext`. A dedicated test (`alerts-1398.test.ts`) asserts: (1) no module under `alerts/` or `watch-cmd.ts`
imports a trading module; (2) driving every action kind through the notifier produces only deliveries, never a
trade/arm/sign call. This is the test the card requires ("no path from a rule to signing or arming").

## Extensibility for the chained cards
- **task-1404** (live holder/rug signals as triggers): add fields to `RuleRow`/`FIELDS` exactly as `larp` was
  added — no delivery change. The notifier already carries `source`/`rule` for provenance.
- **task-1399** (wallet tracker): a tracker event becomes an `AlertDelivery` (new `source`) and reuses the same
  `Notifier`/adapters/routing unchanged.
- **task-1400** (copy-trade mirror ticket): the mirror is a *proposal* (same inert `ticket` proposal path); the
  notifier delivers its summary, the user confirms in the app. No new signing surface.
