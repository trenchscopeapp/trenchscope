---
id: docs-copy-trading-stage-2-the-one-key-mirror-ticket-a-proposal
title: Copy trading (staged, personal, paper by default) › Stage 2: the one-key mirror ticket (a proposal)
kind: docs
page: copy-trading
page_title: Copy trading (staged, personal, paper by default)
heading: Stage 2: the one-key mirror ticket (a proposal)
anchor: stage-2-the-one-key-mirror-ticket-a-proposal
url: https://dexterm.xyz/docs/copy-trading#stage-2-the-one-key-mirror-ticket-a-proposal
tags:
  - docs
  - copy-trading
  - stage
  - one-key
  - mirror
  - ticket
  - proposal
  - copy
  - trading
  - staged
  - personal
  - paper
  - default
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/copy-trading.md
date: 2026-10-16
---

On a followed wallet, `m` previews a **MIRROR TICKET** for that wallet's latest buy. The preview shows every check and its number:

| check | refuses when | why |
|---|---|---|
| lag | more than 30 s since the leader's block | you are late |
| drift | the price is more than 5 % above the leader's fill | you are chasing |
| liquidity | under $25k | you cannot get out |
| age | the pair is under 60 s old | launch noise |
| leader sold | the leader has already sold this mint since the buy | they left |
| leader dev / leader holds | the leader is linked to the dev cluster, or holds more than 5 % of supply (from a bubble-map scan) | they may be distributing to you |

Unknown facts are shown as unknown (`?`), never guessed, except decimals: without them the drift cannot be computed and the mirror is refused until the token is open. The size is `min(your cap, k × the leader's size, 1 % of liquidity)`; the cap is $20 per mirror today (the mandate's per-trade cap applies again at arming). `m` again **proposes**: an order plan, buy now, no ladder, 3 % slippage, expiring in 10 minutes, labelled `copy`, that lands on the `O` screen exactly like a typed or spoken plan. It is inert until you hold `a` to arm it into an armed mandate, or approve it in Phantom; nothing on the follows screen can arm.

The same mirror ticket works from a shell, for scripts and replays, with the same checks and the same size rule:

```sh
$ dexterm follow mirror <addr>                # preview the latest buy's mirror ticket; writes nothing
$ dexterm follow mirror <addr> --cap 10 --k 1 # preview with your own cap and size factor
$ dexterm follow mirror <addr> --propose      # write it as an INERT proposed order plan on the O screen
$ dexterm follow mirror <addr> --json         # machine-readable preview
```

A refused mirror prints every failed check and exits non-zero. `--propose` writes a plan with status `proposed` and no mandate. The command has no arm, sign or execute path, so the plan can only be armed in the app through the keypress or Phantom gate. A replay test drives a followed wallet's buy through `--propose` and checks that the plan exists, is not armed and that no execute path was reached. This is the copy-trade mirror ticket of the 0.1.3 release (its first copy-trading step in the release notes): **a proposal only. Nothing arms or fires on its own.**
