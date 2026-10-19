---
id: docs-keyboard
title: Keyboard reference
kind: docs
page: keyboard
page_title: Keyboard reference
url: https://dexterm.xyz/docs/keyboard
tags:
  - docs
  - keyboard
  - reference
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/keyboard.md
date: 2026-10-16
---

Every key, generated from the app's keymap and the help overlay at build time.

Generated at build time from `packages/tui/src/keymap.ts` (the keymap) and `packages/cli/src/screens/overlay.ts` (the `?` overlay, which adds the keys the interactive loop handles itself). `npm run docs:check` fails if this page and the app disagree.

Conventions: keys are case-sensitive (`g` and `G` differ). A key listed under a screen overrides the global binding on that screen only (on the token screen `1`–`6` are timeframes, not screen switches). While the chat input, the filter line, the sort menu or a PAPER ticket has the keys, printable keys type instead of acting, so `q` or `1` can never quit or navigate out from under a half-typed order.
