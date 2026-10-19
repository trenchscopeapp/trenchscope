---
id: docs-configuration-the-optional-free-rpc-key
title: Configuration and files on disk › The optional free RPC key
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: The optional free RPC key
anchor: the-optional-free-rpc-key
url: https://dexterm.xyz/docs/configuration#the-optional-free-rpc-key
tags:
  - docs
  - configuration
  - optional
  - free
  - rpc
  - key
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

Keyless, the holders panel shows the holder count and the top-10 share from Jupiter; the ranked top-20 list with owner wallets needs a free RPC key (a 2-minute signup with no card at Helius, Alchemy, QuickNode or Ankr). Configure one of:

```sh
$ mkdir -p ~/.dexterm && printf %s "<your-key>" > ~/.dexterm/helius.key && chmod 600 ~/.dexterm/helius.key
```

```sh any read-only RPC URL; the first wins, extras join the rotation pool
$ export DEXTERM_RPC_URL="https://<provider>/<path>"
$ export DEXTERM_RPC_URLS="https://rpc-a/...,https://rpc-b/..."
```

Resolution order: `DEXTERM_RPC_URL`, else `~/.dexterm/helius.key`, else the public RPC pool. All configured endpoints rotate by health score; a 429 pauses one endpoint (honouring `Retry-After`) and fails over to the next. Every URL in an error, a `--verbose` line or a `--record` file passes a redactor; a recording that still carries a key refuses to save. `dexterm doctor` reports the provider name only, never the key.

> warn: never paste a key into a command line argument, a shell history, a chat or a repository. The file above is the only place dexterm reads it from.
