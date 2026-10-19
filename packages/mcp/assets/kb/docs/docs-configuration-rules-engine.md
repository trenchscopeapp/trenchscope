---
id: docs-configuration-rules-engine
title: Configuration and files on disk › Rules engine
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: Rules engine
anchor: rules-engine
url: https://dexterm.xyz/docs/configuration#rules-engine
tags:
  - docs
  - configuration
  - rules
  - engine
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

A rule is one line: `when <cond> [for <n> ticks | <n>s | <n>m] then <action>+ [cooldown <dur>] [max <n>/h] [scope screener | watchlist | newpairs | positions | mint:<addr>] [window <dur>] [name "<s>"]`. Conditions use the filter grammar (https://dexterm.xyz/docs/cli#filter-grammar)'s fields and tags with `and` / `or` / `not` and parentheses, plus two derived signals over a per-coin history the engine keeps itself: `<field>.velocity` (current ÷ the mean of the earlier samples in the window) and `<field>.delta` (current − oldest in the window); both are false until two earlier samples exist, so a rule never fires on a coin's first paint. Actions: `alert(level, "text")`, `ticket(buy | sell, size ≤ 50, sol | usd | pct)`, `ask(skill)`, `popup(chart | token | bubbles | narrative | plans | feeds)`, `tag("label")`, `sound(name)`, `watch`.

```text
vol5m.velocity > 3 and cluster < 20 and liq > 25K for 2 ticks then alert(up, "surge") ask(token-dossier) popup(chart) cooldown 15m max 6/h name "surge-clean"
```

- The open token's live holder and rug signals (https://dexterm.xyz/docs/screens#live-holder-and-rug-signals) are rule fields too: `top10`, `dev`, `bundled`, `snipers`, `fresh`, `cluster`, `lplocked`, `bonding`, `mintable`, `freezable`, with `.delta` and `.velocity` (`dexterm rules fields` lists them all).
- Since 0.1.5: `devrugs` is the coin's creator's labelled prior rugs from the local record (dev history (https://dexterm.xyz/docs/screens#dev-history); unknown = no match), e.g. `when devrugs >= 2 then alert(warn, "new coin from a wallet that rugged before") scope newpairs`.
- The text is parsed, never evaluated as code. Every rule has a cooldown (default 10 m) and a max per hour (default 12, hard cap 120), so a bad rule is annoying, not dangerous.
- Rules can **alert**, annotate your own watchlist (`tag`, `watch`), open the read-only windows and ring the bell, or **propose**. `ticket` and `ask` do not act: each fire becomes a proposal card on the rules screen (status proposal, your keypress required, armed by nobody); acting on it opens the PAPER ticket in its editing phase, where you size and confirm, or asks the analyst. Nothing a rule does reaches an order plan, a mandate, the signer or the gate, and a rule argument named like money (`arm`, `auto`, `confirm`, `execute`, `sign`, `send`) is refused at parse time, in text and in JSON.
- `ctrl+r` opens the RULES screen: the list with enabled / last fired / source, `i` types a new rule with a live "would match N of M rows right now" dry-run, `tab` the proposals pane, `space` toggles, `d` removes. `dexterm rules list | add "<rule>" | remove | enable | disable <id> | check "<rule>" | dry-run "<rule>" | fields`. Rules live in `config.json`, every change through the journal.
