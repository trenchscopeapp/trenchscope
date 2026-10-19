---
id: docs-getting-started-install
title: Getting started › Install
kind: docs
page: getting-started
page_title: Getting started
heading: Install
anchor: install
url: https://dexterm.xyz/docs/getting-started#install
tags:
  - docs
  - getting-started
  - install
  - getting
  - started
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/getting-started.md
date: 2026-10-16
---

The repository README's short path is: choose one installer, then start dexterm.

```sh repository quick start
$ npm i -g dexterm-cli
$ brew install dexterm-xyz/dexterm/dexterm
$ dexterm
```

Do not run both install lines. The first is npm; the second is the one-line Homebrew alternative for macOS.

```sh install with npm
$ npm i -g dexterm-cli
$ dexterm doctor
```

The package is named `dexterm-cli` because npm refuses the name `dexterm` as too similar to `xterm`. The command it installs is `dexterm`. The package ships compiled JavaScript, so it needs no build step. Every GitHub release carries a build-provenance attestation and `SHA256SUMS` you can verify (see the trust page (https://dexterm.xyz/trust/)).

```sh install from the release
$ # download dexterm-0.1.5-src.tar.gz and SHA256SUMS from the releases page, then:
$ shasum -a 256 -c SHA256SUMS --ignore-missing
$ gh attestation verify dexterm-0.1.5-src.tar.gz --repo dexterm-xyz/dexterm
$ tar -xzf dexterm-0.1.5-src.tar.gz && cd dexterm-0.1.5
$ ./install.sh
$ dexterm doctor
```

The releases page is github.com/dexterm-xyz/dexterm/releases (https://github.com/dexterm-xyz/dexterm/releases).

```sh install with Homebrew (macOS)
$ brew tap dexterm-xyz/dexterm
$ brew trust dexterm-xyz/dexterm
$ brew install dexterm
$ dexterm doctor
```

Homebrew 7 and newer load a third-party tap only after you trust it; without `brew trust`, `brew install dexterm` stops with "Refusing to load formula … from untrusted tap". Typing the full name, `brew install dexterm-xyz/dexterm/dexterm`, also works, because naming a formula in full trusts that one formula. The formula installs the same release tarball and runs it with Homebrew's Node. Homebrew no longer ships prebuilt packages for Intel Macs, so on Intel it builds Node and its toolchain from source, which takes a long time; the release installer above is much faster there.

The steps below are the same installer, run from a checkout.

```sh install from a checkout
$ cd dexterm/app
$ ./install.sh
$ dexterm doctor
$ dexterm
```

`install.sh` is user-level: no `sudo`, no edits to your shell profile. It checks for Node 22.18+, downloads an official build into your home directory only if none is found (verified against Node's published `SHASUMS256.txt`), links the app, builds the native chart window when `cargo` is present, and writes a `dexterm` launcher to `~/.local/bin`. If that directory is not on your PATH it prints the one line to add and does not add it for you.

Already have Node 22.18+? You can skip the installer. dexterm has no third-party runtime dependencies, so it runs straight from the source tree:

```sh run from source
$ npm run dexterm
$ node packages/cli/bin/dexterm.mjs doctor
```

`npm install` is optional and only pulls the dev tooling (TypeScript, `@types/node`).
