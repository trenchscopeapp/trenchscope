---
id: docs-larp-what-it-looks-at
title: LARP detector › What it looks at
kind: docs
page: larp
page_title: LARP detector
heading: What it looks at
anchor: what-it-looks-at
url: https://dexterm.xyz/docs/larp#what-it-looks-at
tags:
  - docs
  - larp
  - looks
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

| evidence | source | what counts |
|---|---|---|
| the advertised links | DexScreener info + Jupiter metadata (`get_links`), de-duplicated and classified; a note when the two sources disagree | a mismatch across sources is a flag in itself |
| the website | one SSRF-safe, read-only GET (`fetch_page`): no JavaScript, no cookies, no downloads, 512 KiB and 8 s caps, `robots.txt` honoured on every redirect hop, private and loopback addresses refused, DNS re-validated at connect time | site-builder or default-page signals, a live app or demo, docs, wallet-connect patterns, drainer and approval signatures in scripts, external script hosts, whether the symbol and name appear, team-claim and stock-placeholder text |
| the domain | RDAP lookup of the exact advertised domain (`check_domain`) | registration age, registrar, registrant privacy. A days-old domain behind privacy is a mild signal, not proof. Novelty TLDs without an RDAP server come back as unverifiable. |
| GitHub | the keyless GitHub API (`check_github`) for a `github.com/owner/repo` link | created and last-push dates, stars, open issues, archived or fork, up to five real commit hashes with dates |
| pump.fun metadata | the metadata URI GoPlus reports, through the same safe fetch | the advertised description and links, when they exist |

X is usually login-walled keyless, so account age and follower counts are reported as unverifiable rather than guessed. Every fetched string reaches the model through the prompt firewall: normalised, control and bidi characters stripped, URLs and addresses masked, wrapped as untrusted data, tags stripped so a planted closing tag cannot break out.
