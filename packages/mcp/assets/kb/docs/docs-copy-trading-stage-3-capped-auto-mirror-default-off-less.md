---
id: docs-copy-trading-stage-3-capped-auto-mirror-default-off-less
title: Copy trading (staged, personal, paper by default) › Stage 3: capped auto-mirror (default off, less safe)
kind: docs
page: copy-trading
page_title: Copy trading (staged, personal, paper by default)
heading: Stage 3: capped auto-mirror (default off, less safe)
anchor: stage-3-capped-auto-mirror-default-off-less-safe
url: https://dexterm.xyz/docs/copy-trading#stage-3-capped-auto-mirror-default-off-less-safe
tags:
  - docs
  - copy-trading
  - stage
  - capped
  - auto-mirror
  - default
  - off
  - less
  - safe
  - copy
  - trading
  - staged
  - personal
  - paper
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/copy-trading.md
date: 2026-10-16
---

`A` on a followed wallet raises the **AUTO-MIRROR** prompt. Turning it on is a held physical keypress, and it is refused unless the plan engine's own "this is less safe" popup (`G` on the `O` screen, keypress-only, 24 h expiry) is active. That one gesture drafts and arms a **copy mandate** in the plan engine, the signer trust domain: buy-only, `maxTier: hands-free`, with exactly the policy's caps, clamped to the engine's hard ceilings.

Every later buy by that wallet then runs the Stage 2 checks and, if they pass, is proposed and armed automatically with the **weakest confirmation tier**. The engine therefore sizes it at **¼ of the per-trade cap** (the same rule a spoken confirmation gets) and re-checks the per-trade, per-coin, total and daily-loss caps, the allow-list and the panic state at arming and on every fill. On top, the policy keeps a per-wallet **daily cap** (the mandate's total), **max open mirrors**, a **cooldown** between mirrors, a **size factor** against the leader, and an **auto-disarm streak**: that many refused or failed mirrors in a row turn it off.

What turns it off, always without a gesture: `A` again; the `!` panic key or `dexterm wallet panic`; restoring the keypress gate; the copy mandate expiring or being revoked; the refusal streak; unfollowing the wallet; and **every restart**, after which a copy mandate the engine recovered as armed is revoked on load. Caps can only be changed while it is off, from the shell:

```
dexterm follow auto <addr> --per-trade 20 --daily 100 --max-open 3 --cooldown 60 --k 1 --disarm 3
dexterm follow auto            # list policies and their state
dexterm follow auto <addr> --off
```

Ceilings: $100 per trade, $500 per day, 10 open, a 10 s minimum cooldown, k ≤ 2. Every policy change, enable, disable, proposal, arm and refusal is appended to a hash-chained journal at `~/.dexterm/copy.journal`, next to the plans journal.
