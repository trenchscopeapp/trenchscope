---
id: docs-paper-trading-trade-moments
title: Paper trading, live trading and the safety model › Trade moments
kind: docs
page: paper-trading
page_title: Paper trading, live trading and the safety model
heading: Trade moments
anchor: trade-moments
url: https://dexterm.xyz/docs/paper-trading#trade-moments
tags:
  - docs
  - paper-trading
  - trade
  - moments
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

The cyberspace look reacts to a trade, but only to its **result**. A confirmed buy fires a green shockwave from the ticket with coins streaming up; a profitable sell a gold burst and gold rain; a loss red static that collapses down the screen (no shake, no mockery); a signer refusal or a failed send a red lockout flicker in the bands; and while a send is in flight a neutral cyan scanning sweep that is never a verdict. Normal and fever tiers differ in length and density; `--calm` shows none of it and the result card still lands at once; any key skips a running moment.

Two things are mechanical, not conventions. **Only a settled outcome can fire a moment:** the ticket reports exactly one outcome per booked paper fill, confirmed live fill, signer refusal or send failure, and the effects engine refuses anything without a confirmed-or-failed status; a quote, a PLAN, an armed order or a `send-unknown` (the chain may still confirm it) fires nothing, and a test checks the one call site. **The ticket is shielded:** every cell of the ticket and the PAPER / LIVE banner is marked off-limits on the cell buffer, so rain, glitch, datamosh, scanlines and the moments cannot write a glyph, a colour or a background into it in any phase (tested byte-identical against a calm render at 176, 120 and 90 columns). `--sound` (or `DEXTERM_SOUND=1`) adds short synthesized cues after the same outcome: a buy chirp, a sell sweep then a chime or a thud, a buzz on a failure. Muted by default; the WAVs are written once to `~/.dexterm/sounds` and played detached so the render loop never waits.
