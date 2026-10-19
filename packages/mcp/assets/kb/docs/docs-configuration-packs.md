---
id: docs-configuration-packs
title: Configuration and files on disk › Packs
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: Packs
anchor: packs
url: https://dexterm.xyz/docs/configuration#packs
tags:
  - docs
  - configuration
  - packs
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

A pack is a directory you can share: `pack.json` (name, version, publisher, what it contains), then `workspaces/*.json`, `themes/*.json`, `rules/*.rules`, `keymap.json` and `widgets/<name>/` (see widgets (https://dexterm.xyz/docs/configuration#widgets)), plus a generated `pack.lock` (sha256 per file and a pack hash) and an optional `pack.lock.sig` from `ssh-keygen -Y sign` (no new dependency; the key everyone already has).

```sh
$ dexterm pack verify ./trenches                 # the install card: integrity, signature, trust, contents, refusals
$ dexterm pack add ./trenches --accept-unsigned  # install into ~/.dexterm/packs/trenches@1.0.0
$ dexterm pack export ./mine --name mine --workspace hud --theme amber --rules --keymap
$ dexterm pack sign ./mine --key ~/.ssh/id_ed25519 ; dexterm pack trust alice "ssh-ed25519 AAAA…"
```

- **Trust tiers decide defaults, never powers.** `reviewed` (the pack hash is on the list dexterm ships or in your `reviewed-packs.json`) > `signed` (a publisher key you pinned with `dexterm pack trust`) > `unsigned` (needs `--accept-unsigned`: the risk card). Rules from a reviewed or signed pack load enabled; from an unsigned pack they load disabled and you enable each one on the rules screen (that makes your own copy). A pack keymap is shown and merged only by `dexterm pack keymap <name> --merge`, through the same reserved-key checks as your own. Widgets install disabled.
- **A pack never runs code.** It is plain files; there is no entry script, no dependency, no network. Refused outright, not skipped: paths with `..` or an absolute root, symlinks anywhere, hidden files, `node_modules`, more than 200 files or 2 MB, a `__proto__` key in any JSON, a capability or enabled field on a widget, a rule that tries to arm or oversize, a keymap that rebinds a reserved key. The hash is pinned at install and re-checked on every load: a pack edited after install is skipped and reported, and a directory copied into `packs/` without a record is not an install.
- **Export refuses secrets.** Anything in your exported files that looks like a base58 private key, a Helius token, a 32-byte hex string or a high-entropy blob stops the export before a file is written.
- **Not built yet:** `pack add` from a git URL or a zip (install is from a directory you already have), and a shipped reviewed list (empty until a first-party pack is reviewed). The example pack is `packs/example-widgets` in the repo.
