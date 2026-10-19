---
id: docs-larp-paste-a-coin-on-the-web
title: LARP detector › Paste a coin on the web
kind: docs
page: larp
page_title: LARP detector
heading: Paste a coin on the web
anchor: paste-a-coin-on-the-web
url: https://dexterm.xyz/docs/larp#paste-a-coin-on-the-web
tags:
  - docs
  - larp
  - paste
  - coin
  - web
  - detector
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/larp.md
date: 2026-10-16
---

A no-install version is in preview at the preview checker (https://dexterm-larp-preview.dexterm-site.workers.dev/check/), not deployed to dexterm.xyz. Paste a Solana mint or a DexScreener / pump.fun / Solscan link and get the grade in your browser, read-only, no wallet. It runs on a Cloudflare Worker and reuses the app's tuned link-shape grade (`larp-links-v1`) and the same prompt firewall, so a hostile coin name or symbol is stripped and shown as inert text, never obeyed.

What the web checker shows, each datum with its source and the age of the reading: the **LARP grade** from the coin's advertised link shape (`LARP` / `REAL?` / `UNKNOWN`), **top-10 holder concentration** and **holder count** (Jupiter), and **liquidity** in USD (DexScreener). It never shows a price, a market cap or a buy/sell call. A **shareable PNG card** carries the grade, those facts, the heuristic label and a dexterm.xyz link.

The preview defaults to the **keyless** tier. The full in-app LARP check above — fetching the website (SSRF-safe), the RDAP domain lookup and the GitHub read, graded by the analyst — is not part of the web checker. The bundle / sniper checkbox runs the app's wallet-intel rules and Helius history adapter as an optional second step, only when a dedicated site key and real Turnstile configuration are present. The visible preview test mode disables paid deep scans. Missing credentials refuse scans or disable the deep step; there is no silent test-secret fallback.

The deep step samples the top 20 accounts, up to seven funding histories and the first 100 launch transactions. Complete immutable launch windows and funding facts stay in durable storage without expiration; incomplete launch windows are fetched again. Market results expire after 45 seconds. Every scan, including a cache hit, is rate-limited per IP and globally. A serialized daily credit budget reserves 84 credits before deep RPCs and refunds only counted unused credits. Synthetic replay measures 84 cold / 4 with facts cached; these are call-based estimates, not independently measured provider billing. Real deep-scan latency, billing and Worker CPU are still unverified pending dedicated credentials. Refusals display "busy, try again"; a deep-budget refusal keeps the keyless grade with an explicit note. No trackers or analytics; the pasted input is not logged.

> warn: the web grade is the links-only baseline, a weak signal measured on a held-out set (see measured accuracy (https://dexterm.xyz/docs/larp#measured-accuracy) above). It is a risk flag, not a certificate, and not financial advice.
