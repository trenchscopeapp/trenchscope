# WALLET TRACKER — gap analysis (task-1399, dexterm 0.1.3)

The task card (2026-10-16) says the follow feature **already exists on app main** and
must not be rebuilt. This note is the gap analysis the card requires: what the card's
spec asks for, what already ships, and the (small) set that was actually missing and
built under task-1399.

## The spec (card)

> Follow a wallet (paste address or pick from a token's holder list), see its recent
> trades, realised PnL, win rate, hold time, early-entry score; alert when it buys
> (feeds the alerts lane). Use only sources already in the health registry; label every
> number with its source and data age; no wallet labelling claims about real people;
> local storage only.

## Already on app main (NOT rebuilt)

`dexterm follow add|remove|list|stats|trades|purge|auto` (task-1360, copy-trading Tier 1):

- **Follow store** — `FollowStore`, local `~/.dexterm/follows.json`, user-typed labels
  only (firewalled, never inferred, never exported). `dexterm follow add <addr> --name`.
- **Wallet tracker** — `WalletTracker` polls Helius `getTransactionsForAddress` (10
  credits/call, through the data layer's limiter + credit meter), decodes swaps, keeps
  per-wallet trades, and raises a `CopyAlert` for every new buy/sell (first page is a
  silent backfill — history is not news).
- **Stats** — `walletStats()` already computes FIFO realised PnL (SOL exact + a USD view
  at a named rate), **win rate** (hidden under n=10 closed positions, with the sample),
  **early-entry score** (median 1−rank/buyers over scanned launch windows; `—` with a
  reason when no ranks), open positions, per-mint positions, sample caption.
- **Screen** — FOLLOWED WALLETS (key `U`): a table of every followed wallet with those
  metrics + a cross-wallet ALERTS tape; plus the Tier-2 mirror-ticket preview and Tier-3
  auto-mirror modal (both proposal-only, gated).
- **Alerts engine** (task-1398, merged 6946bc5): `Notifier` + adapters
  (toast/desktop/telegram/discord), pure routing, `dexterm alerts`, `dexterm watch`
  (headless **rules** engine → delivery). Its DESIGN.md §Extensibility explicitly
  reserves task-1399: "a tracker event becomes an `AlertDelivery` (new source) and reuses
  the same Notifier/adapters/routing unchanged."

So of the card's named items, **win rate and early-entry score are not missing** — they
already ship. The card's "what is missing" list was a guess; this is the measured result.

## Gaps actually built under task-1399

1. **Hold time** — not computed anywhere. Added to `WalletStats` as
   `holdMedianMs` / `holdNote` (+ per-position `holdMs`), the median time from a closed
   position's first buy to its last sell, counted **only** for closed positions whose
   first and last trade both carried a real block time (`tKnown`). Null with its reason
   otherwise. Shown in `dexterm follow stats`, the follows row, and the new detail view.

2. **Buy/sell alerts through the task-1398 alerts engine.** On main a `CopyAlert` only
   produced an in-app toast (`say`) + the alerts tape; it never reached a push channel,
   so a followed wallet's buy could not notify you on desktop / Telegram / Discord.
   Added `copyAlertToDelivery()` (firewalled, `source: 'follow'`, level up=buy/down=sell)
   and wired the TUI loop's copy-alert drain to push each new alert through the existing
   `Notifier` when the user has enabled a push channel. The delivery layer still imports
   nothing from trade/signer/wallet — a follow alert is read-only, exactly like a rule
   alert.

3. **Per-wallet detail view in the TUI.** The follows screen was a list only; there was
   no way to see **one** wallet's own recent trades + positions in the app (only the CLI
   `follow trades`/`stats` did). Added a detail overlay (open with `enter` on the selected
   wallet, `esc` closes) rendering that wallet's metrics (each labelled with its source =
   Helius history and data age = time since the last poll), its recent decoded trades, and
   its open/closed positions. Read-only.

## Noted but NOT built (out of scope / separate card)

- **Follow from a token's holder list.** The bubbles/holder screen shows holders + the
  funder but has no "follow this holder" action; the paste path (`i` / `follow add`)
  covers the spec's first clause. Left as a documented follow-up (small, contained) to
  keep this card's diff focused.
- **Mirror ticket** — this is task-1400 (which task-1399 blocks). The Tier-2 mirror
  preview already exists; the full mirror-as-proposal lane is that card's job.
- **Auto-populating early-entry ranks** in the live tracker — the score is computed, but
  ranks still come only from a token's launch-window scan (`M`); wiring the tracker to
  scan automatically is a data-budget decision for a later card.

## Invariants honoured

- Sources: only Helius history (already in the health registry); the Helius key / RPC URL
  never prints. USD only shown with its rate; every metric carries its sample + age.
- No performance-claim wording: "win rate" / "hold time" appear only as measured columns
  with their sample size n, never as a promise; "not a recommendation" stays on the view.
- Local storage only; labels are the user's own words, never inferred for a real person.
- Nothing here trades, signs, arms or proposes.
