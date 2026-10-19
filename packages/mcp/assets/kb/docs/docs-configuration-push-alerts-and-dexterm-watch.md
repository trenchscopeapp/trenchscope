---
id: docs-configuration-push-alerts-and-dexterm-watch
title: Configuration and files on disk › Push alerts and dexterm watch
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: Push alerts and dexterm watch
anchor: push-alerts-and-dexterm-watch
url: https://dexterm.xyz/docs/configuration#push-alerts-and-dexterm-watch
tags:
  - docs
  - configuration
  - push
  - alerts
  - dexterm
  - watch
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

Rules (above) already alert inside the running terminal. To hear about a match when the terminal is closed, pick where alerts go and run your rules headless.

```sh
dexterm alerts status                 # which channels are on
dexterm alerts set-telegram           # your own Telegram bot (token + chat id read from the environment or stdin, never argv)
dexterm alerts set-discord            # your own Discord webhook URL
dexterm alerts enable desktop         # a desktop notification (macOS, Linux)
dexterm alerts test                   # send one test alert to every enabled channel
dexterm watch                         # run your rules with no terminal UI and deliver alerts
dexterm watch --once                  # one pass, then exit (good for cron)
```

- **Off by default.** Nothing is sent anywhere until you configure and enable a channel. `dexterm alerts disable` turns a channel off again.
- **Your credentials, stored locally.** A Telegram bot token or a Discord webhook lives in your home folder with mode 0600 and is never logged or printed. dexterm ships no bot and no webhook of its own.
- **Triggers are plain rules.** A price level, a holder-concentration change, a LARP grade change, or a new pair that matches a filter are all rule lines (see the rules section); the LARP grade is a numeric field, so "downgraded" is `when larp.delta < 0`.
- **Proposals only.** A rule can raise an alert, open a ticket proposal or ask the analyst. There is no path from a rule, or from `dexterm watch`, to signing, arming or raising a cap.
- **Untrusted text is cleaned.** Token names and symbols pass the prompt firewall before they reach any channel.
