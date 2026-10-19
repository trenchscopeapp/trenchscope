---
id: docs-voice-what-you-can-say
title: Jarvis voice mode › What you can say
kind: docs
page: voice
page_title: Jarvis voice mode
heading: What you can say
anchor: what-you-can-say
url: https://dexterm.xyz/docs/voice#what-you-can-say
tags:
  - docs
  - voice
  - can
  - say
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

| you say | what happens | path |
|---|---|---|
| "show me the runners", "go to new pairs", "open my watchlist", "positions" | switches the screen | instant, no model |
| "open bonk", "pull up wif" | opens that coin's token screen | instant |
| "filter liquidity over 50k", "only show age under 10 minutes" | sets the screener filter | instant |
| "watch this one", "add bonk to my watchlist" | adds to the watchlist | instant |
| "show the chart", "close the chart" | opens or closes the chart popup for the open coin through the popup host | instant |
| "buy bonk", "sell half of wif", "ape into this one" | opens a **PAPER ticket in its editing phase** for the spoken coin and says so | instant |
| "is this a rug?", "what do you think about wif", "tell me about the holders" | asks the analyst; the first two sentences of the answer are read aloud | Claude |
| "buy this if it dips to 300k, sell half at 600k, and leave a moon bag", "buy bonk if it drops to 250k, stop at 150k" | drafts an **order-plan proposal** (entry trigger, take-profit ladder, moon bag, stop) for the named or highlighted coin; it is inert until you arm it with a held keypress on the `O` screen or `dexterm plan arm` | instant, no model |

`m` mutes the replies, `,` cycles the macOS `say` voice (the fallback; Piper itself has one fixed voice), `<` / `>` make it slower or faster, `esc` stops a reply or cancels the mic. Only the keyboard changes the voice: the analyst can explain these keys but has no action that sets them. Any other key pressed while the mic is live closes it first and then does its normal job, and the mic auto-closes after 15 s if you walk away. On the ticket screen the voice keys are off, so nothing spoken can reach the confirm gate.
