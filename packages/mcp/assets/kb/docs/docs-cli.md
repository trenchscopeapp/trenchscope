---
id: docs-cli
title: CLI flags and commands
kind: docs
page: cli
page_title: CLI flags and commands
url: https://dexterm.xyz/docs/cli
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

Every flag parseArgs accepts, the subcommands, the filter grammar, sort keys and presets.

Generated from `packages/cli/src/main.ts` (`parseArgs`, the subcommand dispatch and `dexterm --help`), `scan/command.ts` (the `--scan-*` table), `screener/filter.ts`, `screener/sort.ts` and `screener/presets.ts` at commit `(generated from the app: see https://dexterm.xyz/docs/cli; app-help has the exact keys and commands)`. `npm run docs:check` fails if a flag here does not exist or an accepted flag is undocumented.
