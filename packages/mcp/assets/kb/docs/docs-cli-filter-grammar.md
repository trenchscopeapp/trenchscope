---
id: docs-cli-filter-grammar
title: CLI flags and commands › Filter grammar
kind: docs
page: cli
page_title: CLI flags and commands
heading: Filter grammar
anchor: filter-grammar
url: https://dexterm.xyz/docs/cli#filter-grammar
tags:
  - docs
  - cli
  - filter
  - grammar
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

Used by `--filter`, the `/` line, and the analyst's `show_in_screener` tool. Space-separated clauses are ANDed. A clause is `field op value`, a tag, or a bare word (symbol or name substring).

- Operators: `>` `>=` `<` `<=` `=` `==` `!=`.
- Money takes `K` / `M` / `B` (`5M`, `100K`). Percents are plain or `%`. Ages need a unit: `s` `m` `h` `d` `w` `mo` (`6h`, `30m`).
- Tags: `launchpad:` (alias `lp:`) one of `pump dbc raydium meteora bonk` · `flag:` one of `mint freeze top10 dev bundle lp clean` · `verified:yes|no` · `sus:yes|no` · `chain:solana`. Negate with a leading `!` (`!flag:mint`).

(generated from the app: see https://dexterm.xyz/docs/cli#filter-grammar; app-help has the exact keys and commands)

Aliases: (generated from the app: see https://dexterm.xyz/docs/cli#filter-grammar; app-help has the exact keys and commands)

Example: `vol24 > 250K liq > 50K age < 30d org >= 60 launchpad:pump !flag:mint cat`.
