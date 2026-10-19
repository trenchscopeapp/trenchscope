---
id: docs-cli-flags
title: CLI flags and commands › Flags
kind: docs
page: cli
page_title: CLI flags and commands
heading: Flags
anchor: flags
url: https://dexterm.xyz/docs/cli#flags
tags:
  - docs
  - cli
  - flags
  - commands
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/cli.md
date: 2026-10-16
---

(generated from the app: see https://dexterm.xyz/docs/cli#flags; app-help has the exact keys and commands)

Exclusive combinations parseArgs rejects: `--fixtures` with `--replay`; `--record` with either; `--mint` or `--event` without the data they need (`--mint` needs live or replay data, `--event` needs `--fixtures`); `--scan` with `--fixtures` or with `--screen`.
