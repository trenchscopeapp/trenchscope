---
id: docs-getting-started-updating
title: Getting started › Updating
kind: docs
page: getting-started
page_title: Getting started
heading: Updating
anchor: updating
url: https://dexterm.xyz/docs/getting-started#updating
tags:
  - docs
  - getting-started
  - updating
  - getting
  - started
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/getting-started.md
date: 2026-10-16
---

`dexterm update` asks npm and GitHub for the latest release and prints the exact command for how this copy was installed (npm, Homebrew, the release tarball or a git checkout). It never upgrades anything by itself.

A live, interactive run also checks once a day in the background and shows one quiet toast when a newer version exists. The check is two anonymous GET requests with the same fixed headers for everyone (no version, no OS, no ids). Turn it off with `dexterm update --off` (and back on with `--on`), or set `DEXTERM_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1`. It never runs with `--fixtures`, `--replay`, `CI` or `DEXTERM_OFFLINE`. The trust page (https://dexterm.xyz/trust/#endpoints) lists the hosts.
