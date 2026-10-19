---
id: docs-spectator-what-is-redacted
title: Spectator view (watch the agent cook) › What is redacted
kind: docs
page: spectator
page_title: Spectator view (watch the agent cook)
heading: What is redacted
anchor: what-is-redacted
url: https://dexterm.xyz/docs/spectator#what-is-redacted
tags:
  - docs
  - spectator
  - redacted
  - view
  - watch
  - agent
  - cook
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/spectator.md
date: 2026-10-16
---

Redaction runs on every copy that leaves the hub: the stream, the saved file and the AGENT ACTIVITY window.

- **Wallet and token addresses**: any base58 run of 32 to 44 characters becomes `head4…tail4` (`7xKX…gAsU`), the same short form the app uses elsewhere. A full address never appears.
- **Key material**: any base58 run of 45 or more characters, or a hex run of 64 or more, becomes `[key]` with nothing kept. The gate already refuses every key and signer tool, so key material should never reach an event, and this rule covers it anyway.
- **Every string field, not just the summary.** The tool name, the refusal reason, the agent's name and every navigation field (screen, token, feed, filter, highlight, side) are scrubbed too. An untrusted agent might put an address or a key in an unknown tool name to smuggle it into the stream. The bus cuts a refused tool name to 64 characters and redaction masks what is left. A test drives that exact attack through the real bus and checks the stream and the saved file.
- **Sensitive events**: an event marked sensitive keeps only `[sensitive]` as its summary.

What stays readable: phases, tool names, tiers, timings, data ages, refusal codes and verdict labels, which is what makes the stream worth watching. A token symbol, a filter or a number in a summary is shown as it is. If you don't want real coin names in a capture, run on fixtures (the default).
