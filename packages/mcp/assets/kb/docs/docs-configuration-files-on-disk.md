---
id: docs-configuration-files-on-disk
title: Configuration and files on disk › Files on disk
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: Files on disk
anchor: files-on-disk
url: https://dexterm.xyz/docs/configuration#files-on-disk
tags:
  - docs
  - configuration
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

| path | what | notes |
|---|---|---|
| `~/.local/share/dexterm/dexterm.db` | SQLite: the data cache, your watchlist and alerts, the feed snapshot, the request and credit meters, the PAPER wallet (balance, positions, trades), your KOL lists and mutes, and the history recorder (https://dexterm.xyz/docs/configuration#history-recorder)'s tables | `--db PATH` moves it, `--db :memory:` skips it. `$XDG_DATA_HOME/dexterm/dexterm.db` when set; `%APPDATA%\dexterm\dexterm.db` on Windows. |
| `~/.dexterm/state.json` | how many times dexterm has booted (the first launch gets the full boot and the welcome card) | `DEXTERM_HOME` moves the directory |
| `~/.dexterm/helius.key` | your optional free Helius key, mode 600 | read in code, URL built in memory, never printed. Optional. |
| `~/.dexterm/popup.json` | chart popup hotkeys, docking, rain, fps cap | optional; see popup chart (https://dexterm.xyz/docs/popup-chart#config-dexterm-popup-json) |
| `~/.dexterm/config.json` · `config.journal.jsonl` | the customization config (v4: theme overrides, keymap, rules, installed packs, widget consent, the price display mode (https://dexterm.xyz/docs/configuration#price-display-mode)) and its journal of applied changes with their inverses | machine-written, mode 600; `ctrl+z` in the app undoes the last change. Holds no secrets by construction: the schema has no key field, and an older config that carried one gets it moved out to `<name>.key`. See workspaces (https://dexterm.xyz/docs/configuration#workspaces), rules (https://dexterm.xyz/docs/configuration#rules-engine), packs (https://dexterm.xyz/docs/configuration#packs) |
| `~/.dexterm/workspaces/<name>.json` · `themes/<name>.json` | your workspaces and themes, one file each | `dexterm workspace`, `dexterm theme` |
| `~/.dexterm/packs/<name>@<version>/` · `allowed_signers` · `reviewed-packs.json` | installed packs (exactly the files their lock names), the publisher keys you pinned, pack hashes you marked reviewed | `dexterm pack` |
| `~/.dexterm/voice-helper/` | the Apple Speech helper (`recognize.swift`, its compiled binary and a source hash), built once by `swiftc` on the first voice use | optional; see voice (https://dexterm.xyz/docs/voice). No audio or transcript is ever written here |
| `~/.dexterm/piper/` · `~/.dexterm/models/` | the neural voice: a private Python environment with Piper (macOS, written by `dexterm voice setup`), and the downloaded voice models (`en_GB-alan-medium`, whisper `base.en`) | optional; `dexterm voice uninstall` removes the runtime, `--purge-model` the Piper voice too. See voice (https://dexterm.xyz/docs/voice#the-voice-neural-by-default) |
| `~/.dexterm/exports/` | PNG and text files from `E` (export a view) and `H` (PnL cards (https://dexterm.xyz/docs/paper-trading#pnl-cards)) | directory 700, files 600; local only, nothing is uploaded |
| `~/.dexterm/spectator.json` | the spectator stream (https://dexterm.xyz/docs/spectator#2-the-read-only-stream-spectate)'s loopback port and per-session token, while `dexterm agent serve --spectate` runs | mode 600; never printed or passed as an argument |
| `~/.local/bin/dexterm` | the launcher `install.sh` writes | user-level |
| `packages/popup/shell/wry/target/release/dexterm-shell-wry` | the native chart window, if built | `DEXTERM_POPUP_SHELL` points elsewhere |

Delete the first three and dexterm forgets everything.
