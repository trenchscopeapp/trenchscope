---
id: docs-screens-order-plans
title: Screens tour › Order plans
kind: docs
page: screens
page_title: Screens tour
heading: Order plans
anchor: order-plans
url: https://dexterm.xyz/docs/screens#order-plans
tags:
  - docs
  - screens
  - order
  - plans
  - tour
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/screens.md
date: 2026-10-16
---

`O` from anywhere opens the order-plans screen: a PLANS / MANDATES tab strip (`tab` flips), each plan on one line with its status tone (proposed, armed, filled, done, cancelled, expired) and the signer's read-back of what it will do. `a` on a row opens a hold-to-arm prompt; only a key held at the terminal arms, and the prompt is unreachable from the popup, voice, an agent or piped input. `c` cancels a plan, `r` revokes a mandate, `!` is panic (revoke everything), `M` opens the read-only plans popup, `G` shows the hands-free gate setting (GATE ON by default), and `L` raises the fire-path prompt: a held keypress switches plan fills between PAPER and LIVE · DEVNET · fast wallet (refused while plans are armed, without the signer process, off devnet or without a fast wallet). The header says PAPER unless a fill path is provably live. Plans, mandates, caps and the journal are in order plans and standing mandates (https://dexterm.xyz/docs/paper-trading#order-plans-and-standing-mandates).
