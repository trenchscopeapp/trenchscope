---
id: docs-configuration-environment-variables
title: Configuration and files on disk › Environment variables
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: Environment variables
anchor: environment-variables
url: https://dexterm.xyz/docs/configuration#environment-variables
tags:
  - docs
  - configuration
  - environment
  - variables
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

| variable | effect |
|---|---|
| `DEXTERM_HOME` | the directory for `state.json`, `helius.key`, `popup.json`, `config.json`, workspaces, themes and packs (default `~/.dexterm`) |
| `DEXTERM_DB_PATH` | set by the app for its analyst MCP child so it shares the same cache file; you normally use `--db` |
| `DEXTERM_RPC_URL` · `DEXTERM_RPC_URLS` | read-only RPC endpoints (see above) |
| `DEXTERM_CALM=1` | effects off (same as `--calm`) |
| `DEXTERM_INTENSITY` | `off` · `normal` · `fever` |
| `DEXTERM_OFFLINE=1` | refuse live data; `--fixtures` or `--replay` only (tests and CI) |
| `DEXTERM_ANALYST_MODEL` | the Claude model for analyst turns (default `(generated from the app: see https://dexterm.xyz/docs/configuration#environment-variables; app-help has the exact keys and commands)`) |
| `DEXTERM_ANALYST_ENGINE` | `auto` (default) · `claude` · `codex`: which of your CLIs runs the analyst (since 0.1.5; also `--analyst-engine` and `analyst.engine` in `config.json`) |
| `DEXTERM_CODEX_MODEL` | pin the Codex model for analyst turns (default: your Codex default) |
| `DEXTERM_POPUP_SHELL` | path to a prebuilt native chart window |
| `DEXTERM_POPUP_HOTKEY` · `DEXTERM_POPUP_HOTKEY_CLOSE` | override the popup chords without a config file |
| `DEXTERM_RECORDER=0` | history recorder off (same as `--no-recorder`; `off`, `false` and `no` work too) |
| `DEXTERM_TRACE` | write first-frame and first-rows milestones to a file (boot measurements) |
| `DEXTERM_VOICE_STT` · `DEXTERM_VOICE_TTS` | pick the voice (https://dexterm.xyz/docs/voice) engines: `auto` (default) · `apple` · `whisper` · `none`, and `auto` · `say` · `none` |
| `DEXTERM_VOICE_RECORD=1` | keep the whisper path's temporary WAV instead of deleting it after transcription |
| `DEXTERM_WHISPER_MODEL` · `DEXTERM_VOICE_HELPER_DIR` · `DEXTERM_SWIFTC` | the whisper model file (default `~/.dexterm/models/ggml-base.en.bin`), the compiled Apple Speech helper's cache dir (default `~/.dexterm/voice-helper`), the Swift compiler |
| `DEXTERM_SCREEN_STATE` | set by the app for its MCP child (the current screen context); not for you |
| `NO_COLOR` · `FORCE_COLOR` · `COLORTERM` · `TERM` | colour depth detection; `NO_COLOR` also implies calm |
| `LANG` / `LC_ALL` | a non-UTF-8 locale switches the rain to hex glyphs (`--ascii-rain` forces it) |
