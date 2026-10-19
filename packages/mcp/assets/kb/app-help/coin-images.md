---
id: coin-images
title: Turn coin images on or off
kind: app-help
screen: all
feature: coin-images
tags:
  - app-help
  - images
  - image
  - pictures
  - icons
  - logos
  - off
flags:
  - --no-images
confidence: high
owner: maintainers
origin: app-help-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/app keymap + overlay + mcp tools + cli (task-1413)
sources:
  - packages/tui/src/keymap.ts
  - packages/cli/src/main.ts
  - packages/mcp/src/server.ts
date: 2026-10-16
---

Coin pictures render as real pixels in image-capable terminals (kitty/iTerm2/sixel) and as block art everywhere else. Turn them off with `--no-images` (or `DEXTERM_IMAGES=0`, or `enabled:false` in `~/.dexterm/images.json`). `trenchscope doctor` has a Coin images line that says which path you get.
