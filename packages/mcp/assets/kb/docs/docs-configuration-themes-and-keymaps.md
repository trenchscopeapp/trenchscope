---
id: docs-configuration-themes-and-keymaps
title: Configuration and files on disk › Themes and keymaps
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: Themes and keymaps
anchor: themes-and-keymaps
url: https://dexterm.xyz/docs/configuration#themes-and-keymaps
tags:
  - docs
  - configuration
  - themes
  - keymaps
  - files
  - disk
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/configuration.md
date: 2026-10-16
---

`~/.dexterm/themes/<name>.json` is `{ "extends": "cyberspace", "tokens": { "accent": "#ffb02e", … } }`: a built-in base plus hex overrides. At load every value must be a hex colour, ramps exactly four, unknown tokens are refused, and two semantic checks protect you from a shared theme: a **contrast floor** (text on background, muted on panel, the up / down / warn colours) and an **up / down guard** (`up` must read green/cyan and `down` red/pink by hue, both must carry real colour — an HSL saturation floor — and they must sit a minimum perceptual distance apart, so neither an amber pair nor a near-grey pair can make a loss look like a gain). A theme that fails loads as `paper` with a toast naming the token. `config.theme.overrides` is the same for one-off tokens; `dexterm theme list | show | init <name> | check <name>`.

`config.keymap` re-binds the app's actions: `"global": { "screen.watchlist": ["3", "W"] }` and `"screens": { "screener": { "preset.next": ["]"] } }`, chords as `"ctrl+w s"`. Refused by name, whatever the file says: assigning `ctrl+c`, `esc`, `enter`, `y` / `Y` or `!` to anything; changing the keys of quit, back, the alert confirm / dismiss, arm, panic or the gate; two actions on one key within one scope; a chord prefix bound on its own; more than four keys per action. Any error keeps the defaults (a half-applied keymap is worse than none) and names the path. `dexterm keymap [screen]` prints the effective keys with overrides marked `·`; the `?` overlay marks them the same way.
