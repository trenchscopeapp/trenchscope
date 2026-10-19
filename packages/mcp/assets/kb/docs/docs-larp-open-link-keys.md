---
id: docs-larp-open-link-keys
title: LARP detector › Open-link keys
kind: docs
page: larp
page_title: LARP detector
heading: Open-link keys
anchor: open-link-keys
url: https://dexterm.xyz/docs/larp#open-link-keys
tags:
  - docs
  - larp
  - open-link
  - keys
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

`W`, `X` and `T` open the advertised website, X and Telegram in your browser; `L` lists every advertised link (including secondary socials from DexScreener) in a menu. The URL is drawn on screen before anything launches; only `http` and `https` links are ever passed to the opener (`open` on macOS, `xdg-open` on Linux, as a single argument, no shell). The footer shows these keys only when the token actually advertises links.
