---
id: docs-data-sources-cache
title: Data sources and rate limits › Cache
kind: docs
page: data-sources
page_title: Data sources and rate limits
heading: Cache
anchor: cache
url: https://dexterm.xyz/docs/data-sources#cache
tags:
  - docs
  - data-sources
  - cache
  - data
  - sources
  - rate
  - limits
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/data-sources.md
date: 2026-10-16
---

A persistent SQLite cache (`node:sqlite`, one table, namespaced) makes a restart or a reopen instant and cheap. The analyst's MCP server reads the same file, so a warm dossier needs no network.

(generated from the app: see https://dexterm.xyz/docs/data-sources#cache; app-help has the exact keys and commands)

The last rows shown per preset are also snapshotted so a launch paints instantly, marked `cached Nm old · refreshing`.
