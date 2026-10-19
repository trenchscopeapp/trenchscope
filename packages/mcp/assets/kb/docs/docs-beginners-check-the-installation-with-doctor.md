---
id: docs-beginners-check-the-installation-with-doctor
title: New to terminals? Start here › Check the installation with doctor
kind: docs
page: beginners
page_title: New to terminals? Start here
heading: Check the installation with doctor
anchor: check-the-installation-with-doctor
url: https://dexterm.xyz/docs/beginners#check-the-installation-with-doctor
tags:
  - docs
  - beginners
  - check
  - installation
  - doctor
  - new
  - terminals
  - start
  - here
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/beginners.md
date: 2026-10-16
---

Run:

```sh check dexterm
dexterm doctor
```

`doctor` is a read-only check. A check mark means that part is ready. A warning means an optional part is missing. A failure includes a suggested fix. It never asks for a wallet key, password, seed phrase, or token.

The Claude line may warn that Claude Code is missing. That is okay: the screener works without it. Only the optional analyst needs your own Claude Code installation and login.
