---
id: docs-analyst-what-the-analyst-can-never-do
title: The analyst › What the analyst can never do
kind: docs
page: analyst
page_title: The analyst
heading: What the analyst can never do
anchor: what-the-analyst-can-never-do
url: https://dexterm.xyz/docs/analyst#what-the-analyst-can-never-do
tags:
  - docs
  - analyst
  - can
  - never
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/analyst.md
date: 2026-10-16
---

- sign, send or confirm a transaction. No tool builds, signs or sends anything; there is no signer for it to talk to.
- confirm a PAPER trade. `open_ticket` opens the ticket in its editing phase; your keys arm and confirm it.
- act on a coin that is not on your screen, or act at all while the scan has the session.
- use its memory about a token. Facts come from tools or they are not facts.
- follow text found in a token's name, description, socials or website. That text is data, wrapped and flagged.
- read your keys. It never sees the RPC key, your wallet, or your Claude credentials; dexterm only spawns the `claude` binary already on your machine.
- persist a setting on its own. A theme, price-mode or intensity change waits for your `y`; voice, wallet, alert, network and money settings have no action at all.
