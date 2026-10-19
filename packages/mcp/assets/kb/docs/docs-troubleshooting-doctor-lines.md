---
id: docs-troubleshooting-doctor-lines
title: Troubleshooting › Doctor lines
kind: docs
page: troubleshooting
page_title: Troubleshooting
heading: Doctor lines
anchor: doctor-lines
url: https://dexterm.xyz/docs/troubleshooting#doctor-lines
tags:
  - docs
  - troubleshooting
  - doctor
  - lines
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/troubleshooting.md
date: 2026-10-16
---

| line | meaning | fix |
|---|---|---|
| `✗ Node … too old` | Node is below 22.18 (needed to run the TypeScript entry) | `nvm install 22` or `brew install node`, then re-run. `./install.sh` can fetch a verified Node for you. |
| `! Terminal: not a TTY` | output is piped or the shell is not interactive | run `dexterm` in a terminal window. One-shot frames still work with `--screen`. |
| `! Terminal colour: 256-colour only` | the terminal cannot do 24-bit colour | use a truecolor terminal (iTerm2, WezTerm, Ghostty, Kitty, Alacritty, Windows Terminal) or set `COLORTERM=truecolor`. The app runs, flattened. |
| `! Terminal colour: no colour` | `NO_COLOR` is set, or a monochrome terminal | unset `NO_COLOR` for the full look; dexterm works in monochrome. |
| `! Claude CLI: not found` | `claude` is not on PATH | only the analyst needs it: install Claude Code and run `claude` once to log in. Everything else works. |
| `! Codex CLI: … not logged in` | the optional Codex engine is installed but logged out | `codex login`, or keep the analyst on Claude. |
| `! Codex CLI: … older than 0.163.0` | the read-only lock needs a newer codex | `npm i -g @openai/codex@latest`. |
| `! Helius RPC: no key` | no key configured | optional. Holders and some safety fields show `needs key`; see configuration (https://dexterm.xyz/docs/configuration#the-optional-free-rpc-key). |
| `✗ Data sources: unreachable …` | a required host did not answer | check your connection, VPN or firewall. If only some hosts fail they may be blocked on your network. `--fixtures` or `DEXTERM_OFFLINE=1` browse offline demo data. |
| `! Data sources: … PumpPortal …` | only the new-pairs host is down | the rest works; new pairs may be blocked on your network. |
| `! Chart window: not built` | no native shell | the chart popup opens in your browser. For the docked window install Rust and run `npm run build:shell` in `packages/popup`. |
| `✗ Data directory: cannot write …` | the data dir is not writable | fix the permissions the line names, or run with `--db :memory:`. |
