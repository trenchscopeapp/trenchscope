---
id: docs-paper-trading-order-plans-and-standing-mandates
title: Paper trading, live trading and the safety model › Order plans and standing mandates
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
heading: Order plans and standing mandates
anchor: order-plans-and-standing-mandates
url: https://dexterm.xyz/docs/paper-trading#order-plans-and-standing-mandates
tags:
  - docs
  - paper-trading
  - order
  - plans
  - standing
  - mandates
  - paper
  - trading
  - live
  - safety
  - model
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/paper-trading.md
date: 2026-10-16
---

Merged 2026-10-11 (`task-1355`) and labelled **in progress**: the engine, the typed and spoken proposal paths, the `O` screen, the popup and the audit journal are on main and every default run is **paper**. Since 2026-10-12 (`task-1363`) a **live fire path on devnet** exists behind a held keypress: fills go through the signer process and a separate capped fast wallet, described in the live fire path (https://dexterm.xyz/docs/paper-trading#the-live-fire-path-devnet-the-fast-wallet) below. No plan has moved mainnet funds; there is no mainnet fast wallet.

An **order plan** is "buy this coin if it dips to 300k market cap, sell half at 600k, keep the rest as a moon bag", written down once: one entry trigger (market cap or price, below or above, or immediate), a ladder of take-profit tranches (each an above-trigger with a fraction; whatever the fractions leave is the moon bag), an optional stop (a below-trigger, below the entry), slippage and impact ceilings and an expiry (4 h by default, 7 days at most). `dexterm plan propose --mint M --size 20 --entry mc-below:300k --tp mc-above:600k:50% --stop mc-below:150k` writes one; so does saying it to Jarvis (https://dexterm.xyz/docs/voice) or an agent's `propose_order_plan` tool. All three produce the same thing: an **inert proposal** with a SHA-256 hash of its material fields and a plain-language read-back. A proposal fires nothing.

A **standing mandate** is the budget a set of plans may spend: a total, a per-trade cap, a per-coin cap, a daily-loss cap, the highest confirmation tier it accepts and a time-to-live. Every cap is clamped to a hard ceiling ($2000 total, $500 per trade, $1000 per coin, $2000 daily loss, 24 h) and nothing is ever coerced upward: there is no "raise cap" anywhere; a different cap is a new draft that needs a new arming gesture. `dexterm mandate draft --total 100 --per-trade 20 --ttl-hours 4` writes one.

**Arming** a plan under a mandate is the only step that lets anything fire, and it is a physical gesture: a key held at the terminal on the `O` screen (`a`) or `dexterm plan arm <id> --mandate <id>` on a real TTY, which refuses a pipe or a subprocess. The gesture proof is bound to the plan hash, single-use and expiring, so an edited plan voids every earlier confirmation. Once armed, a monitor fed by the prices the terminal already shows (the screener rows, the watchlist, the open token; never fixture data) fires the entry, each take-profit tranche and the stop **only inside the armed plan and only through the executor**, which re-checks the mandate caps on every fill (and, on the live path, the signer re-checks its own caps, allow-lists and the panic marker on top). `dexterm plan amend <id> --size 25 --entry mc-below:280k` edits a **proposed** plan: the edit is a new plan with a new hash, the old proposal is superseded and every earlier confirmation is void, so arming it is a new keypress; an armed plan cannot be edited (cancel it first). Cancel (`c`), revoke (`r`) and panic (`!`, or `dexterm wallet panic`) stop a plan at once; nothing resumes a paused plan without a new keypress.

Two **confirmation tiers** beyond the keypress exist in the model and are off by default: `ptt-held` (push-to-talk held while you speak the confirmation) fires at 0.5× the per-trade cap and `hands-free` at 0.25×, and neither can arm a mandate or a batch. Turning hands-free on is the only "less safe" switch in dexterm: `G` on the `O` screen raises a prompt that says so, it is accepted by a keypress only (a spoken, agent or Phantom "yes" is refused), it is journaled, it expires after 24 h and `G` again restores the gate.

The **journal** (`~/.dexterm/plans.journal`) is append-only and hash-chained; every proposal, arm, fire, fill, cancel, revoke, gate change and refusal is a row, `dexterm plan journal --verify` recomputes the chain and `--export` dumps it, and it is the source the service recovers from after a crash. The popup is a read-only HUD fed view models only (never a key, a secret or an arm capability); its single write is "cancel this plan", re-validated at the server allow-list and again at the terminal.

What is proven, on fixtures and a fake clock: the north-star plan fills end to end on the paper executor; a replayed price stream fires each leg once; and a compromised-model suite shows that spoken text, agent text, a forged proof, a replayed proof, a widened mandate and an edited plan with an old confirmation all fail to arm, raise a cap, widen a mandate, resume a paused plan, accept the risk prompt or switch the fire path.
