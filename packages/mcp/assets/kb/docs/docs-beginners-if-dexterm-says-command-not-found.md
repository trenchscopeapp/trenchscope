---
id: docs-beginners-if-dexterm-says-command-not-found
title: New to terminals? Start here › Common mistakes and recovery › If dexterm says command not found
kind: docs
page: beginners
page_title: New to terminals? Start here
heading: If dexterm says command not found
anchor: if-dexterm-says-command-not-found
url: https://dexterm.xyz/docs/beginners#if-dexterm-says-command-not-found
tags:
  - docs
  - beginners
  - dexterm
  - says
  - command
  - found
  - common
  - mistakes
  - recovery
  - new
  - terminals
  - start
  - here
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/beginners.md
date: 2026-10-16
---

Close and reopen the terminal first. Then run `npm prefix -g` to see npm's global install folder. On macOS/Linux, npm's executable folder must be on your PATH; the installer output normally tells you the exact line for your setup. Do not paste a PATH fix from a stranger. On Windows, rerun the Node.js installer and keep its “Add to PATH” option enabled, then reopen Windows Terminal.

You can confirm whether the shell can find dexterm with `command -v dexterm` on macOS/Linux or `Get-Command dexterm` in PowerShell.
