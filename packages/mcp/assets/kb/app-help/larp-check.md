---
id: larp-check
title: Run the LARP check (is the product real?)
kind: app-help
screen: token
feature: larp-check
tags:
  - app-help
  - larp
  - fake
  - real
  - legit
  - website
  - product
  - domain
  - github
  - vet
tools:
  - larp_check
  - get_links
  - fetch_page
  - check_domain
  - check_github
  - check_programs
confidence: high
owner: maintainers
origin: app-help-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/app keymap + overlay + mcp tools + cli (task-1413)
sources:
  - packages/tui/src/keymap.ts
  - packages/cli/src/main.ts
  - packages/mcp/src/server.ts
date: 2026-10-16
---

The LARP check vets whether a real product exists (website, domain age, GitHub) read-only — it is not a price call. Ask the analyst "is <coin> a larp?" (skill `larp-check`), or an agent can call the `larp_check` MCP tool. A grade is a risk flag, never a certificate; it never recommends buy/sell.
