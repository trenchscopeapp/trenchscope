---
id: docs-beginners-macos-homebrew
title: New to terminals? Start here › Choose a setup path › macOS: Homebrew
kind: docs
page: beginners
page_title: New to terminals? Start here
heading: macOS: Homebrew
anchor: macos-homebrew
url: https://dexterm.xyz/docs/beginners#macos-homebrew
tags:
  - docs
  - beginners
  - macos
  - homebrew
  - choose
  - setup
  - path
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

If you already use Homebrew, this tested macOS path also works:

```sh add the dexterm tap
brew tap dexterm-xyz/dexterm
```

```sh trust that tap
brew trust dexterm-xyz/dexterm
```

```sh install dexterm
brew install dexterm
```

Homebrew on Apple Silicon has not yet run the project's manual install test. On an Intel Mac it may spend a long time building Node; the npm path above is faster.
