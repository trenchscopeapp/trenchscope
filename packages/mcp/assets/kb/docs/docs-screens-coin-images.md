---
id: docs-screens-coin-images
title: Screens tour › Coin images
kind: docs
page: screens
page_title: Screens tour
heading: Coin images
anchor: coin-images
url: https://dexterm.xyz/docs/screens#coin-images
tags:
  - docs
  - screens
  - coin
  - images
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

Every row in the screener, new pairs and watchlist carries the coin's picture as a 2-cell icon (dropped silently when the frame is too narrow); the token screen shows an 8×4 picture at the left of its header, the screener's spotlight card a 6×3 one, and the chart popup a 16 px one in its title strip.

- **Real pixels** in terminals with an inline-image protocol: kitty graphics (kitty, Ghostty, WezTerm, Konsole), iTerm2 inline images (iTerm2), sixel where the terminal advertises it. At startup dexterm sends one short capability query to the terminal (≤ 150 ms) and picks the richest protocol it actually answers.
- **Everywhere else, Apple Terminal.app included: block art.** The picture is sampled into half-block and quadrant cells and, on a 256-colour terminal, dithered into the xterm palette so round logos keep their disc. Not a photo, but recognisable at a glance. `dexterm doctor` has a **Coin images** line that says which path you get; Ghostty or iTerm2 (both free) give the real pictures.
- **A placeholder, never an error:** while a picture loads, when a coin has none, or when its host is down, the box shows the ticker's initial on a colour hashed from the symbol.
- **Off switch:** `--no-images`, `DEXTERM_IMAGES=0`, or `~/.dexterm/images.json` (`{"enabled": false}`). Replays and offline runs have no network, so pictures there could only come from the cache: they stay off unless asked.
- **Privacy:** fetching a picture contacts the host that serves it (DexScreener's image CDN for most coins, otherwise the token's own metadata host). dexterm fetches once through its own local cache and the chart popup is served the cached copy, so an image host never sees a popup load and a coin seen before is never fetched again. `--no-images` keeps every image host from ever seeing your IP. Bytes are treated as hostile: sniffed by magic bytes, capped, and decoded by dexterm's own pure-TypeScript decoders (PNG, JPEG, GIF) — nothing executes. The trust page (https://dexterm.xyz/trust/#privacy) has the statement.
