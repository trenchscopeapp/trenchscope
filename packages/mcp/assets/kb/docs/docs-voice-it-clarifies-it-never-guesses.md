---
id: docs-voice-it-clarifies-it-never-guesses
title: Jarvis voice mode › It clarifies; it never guesses
kind: docs
page: voice
page_title: Jarvis voice mode
heading: It clarifies; it never guesses
anchor: it-clarifies-it-never-guesses
url: https://dexterm.xyz/docs/voice#it-clarifies-it-never-guesses
tags:
  - docs
  - voice
  - clarifies
  - never
  - guesses
  - jarvis
  - mode
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/voice.md
date: 2026-10-16
---

- A ticker it cannot see on screen gets "I don't see a token called X — open it first". There is no fuzzy match: "buy bonks" does not become BONK.
- A ticker that resolves to **more than one mint** (a copycat) gets "I see 2 tokens called X. Open the exact one first, then say buy" and no ticket opens.
- A pronoun ("buy it") means the row actually highlighted on the current screen. On an empty list it asks instead of acting on a coin you cannot see.
- "cell wif" / "by bonk" (homophones) ask "did you mean sell?". A screen command and a trade in one breath ("show runners and sell all my bonk") ask you to say just one. A bare "close" or "exit" asks what to close.
- A named ticker beats a pronoun: "buy BONK, confirm it" with WIF selected opens a BONK ticket, never WIF.
- A spoken ticker that is **also a command word** and is visible on screen — "buy live" with a token called LIVE in the list — is not assumed to be the highlighted row: it asks which token you mean rather than silently buying the selected coin.
- **More than one ticker in a breath** ("buy wif and bonk") asks which one; it never quietly drops one and trades the other.
- A **spoken size, amount or slippage** ("buy 10 sol of bonk", "buy bonk with max size", "buy bonk 50 percent slippage") is not applied by voice: it says it does not set size or slippage by voice, and asks you to open the ticket and set it there. No size spoken aloud ever reaches a ticket.
- An **order plan** needs every market cap to carry its scale: "dips to 300k" is a plan, "dips to 300" asks "300k or 300m?" instead of guessing, and "1.2m" keeps its decimal point rather than collapsing to 12m. An unclear fraction ("sell some at 600k") asks what fraction; a plan with no named or highlighted coin asks which coin. "… and confirm it" at the end of a plan drafts the same inert proposal and arms nothing.
