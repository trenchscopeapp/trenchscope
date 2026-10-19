---
id: docs-configuration-workspaces
title: Configuration and files on disk › Workspaces
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: Workspaces
anchor: workspaces
url: https://dexterm.xyz/docs/configuration#workspaces
tags:
  - docs
  - configuration
  - workspaces
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

A workspace is one JSON file, `~/.dexterm/workspaces/<name>.json`: the screen to land on, the theme and intensity, the screener preset / filter / sort, the token-screen panel toggles, optional per-screen pane trees for the layout solver (weights, fixed widths, priorities, what collapses at which width), and the HUD popups to open together. The shipped `default` reproduces the five screens exactly; `morning-hud` is "show me everything": the narrative board, the feeds, order plans and the chart of the selected coin as windows beside the terminal.

- In the app: `ctrl+w` then `w` list · `n` / `N` next / previous · `s` save the current layout under a typed name · `m` the morning HUD · `o` open the active workspace's popups · `d` default · `1`–`9` pick a slot. `--workspace <name>` starts in one. The footer shows the active workspace.
- On the command line: `dexterm workspace list | show <name> | remove <name> | init` (`init` writes `default` as an editable file with the shipped trees).
- A switch is a UI action and nothing more. It can navigate, re-theme and open the same read-only windows the keys open; it cannot open a ticket, confirm, arm or sign, and a workspace file has no field for any of that (the schema refuses unknown keys by name). Jarvis proposes workspace switches through the same proposal card as everything else.
