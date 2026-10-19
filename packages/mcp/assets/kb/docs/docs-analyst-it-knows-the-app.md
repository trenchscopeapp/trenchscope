---
id: docs-analyst-it-knows-the-app
title: The analyst › It knows the app
kind: docs
page: analyst
page_title: The analyst
heading: It knows the app
anchor: it-knows-the-app
url: https://dexterm.xyz/docs/analyst#it-knows-the-app
tags:
  - docs
  - analyst
  - knows
  - app
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/analyst.md
date: 2026-10-16
---

Ask "how do I export this?" or "what does B do here?" and the analyst calls `app_help` first. That is a knowledge base **generated from the app's own keymap, `?` overlay, MCP tools and CLI**, so the answer is the exact key or command, never a guess from memory. A drift test in the app's test suite fails when a CLI subcommand or flag is missing from it. The same entries work on the command line, offline and with no model:

```sh
$ dexterm help                # list the topics
$ dexterm help export         # the best-matching topic: keys, commands, how-to
$ dexterm help voice speed    # multi-word queries work
```

`app_state` is a read-only snapshot of what you see: the screen, the selected coin, theme, price mode, voice name and speed, whether scan and calm are on, and whether each alert channel is configured. For channels it reports **yes or no only**, never a token, webhook or key. The selected coin's symbol passes the prompt firewall like any other token text. With it the analyst fits an answer to your screen ("press `B` on this token screen") instead of describing every screen.
