---
id: docs-getting-started-requirements
title: Getting started › Requirements
kind: docs
page: getting-started
page_title: Getting started
heading: Requirements
anchor: requirements
url: https://dexterm.xyz/docs/getting-started#requirements
tags:
  - docs
  - getting-started
  - requirements
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

| need | why | notes |
|---|---|---|
| Node.js 22.18 or newer | dexterm runs its TypeScript sources directly; no build step | `node -v` to check. The installer can fetch a verified Node for you. |
| a terminal with 24-bit colour | the cyberspace look | iTerm2, WezTerm, Ghostty, Kitty, Alacritty, Windows Terminal. 256-colour and monochrome terminals still work, flattened. |
| an internet connection | all data is public and keyless | nothing goes through a dexterm server; see data sources (https://dexterm.xyz/docs/data-sources). |
| optional: Claude Code logged in | only the analyst needs it | `claude` on your PATH, logged in with your own account. Everything else works without it. |
| optional: a free RPC key | the ranked top-20 holder list and faster chain reads | Helius, Alchemy, QuickNode or Ankr free tier; see configuration (https://dexterm.xyz/docs/configuration). |
| optional: Rust (`cargo`) | the native docked chart window | without it the chart popup opens in your browser; see popup chart (https://dexterm.xyz/docs/popup-chart). |

> note: dexterm 0.1.5 is out (2026-10-18), open source under AGPL-3.0-only at github.com/dexterm-xyz/dexterm (https://github.com/dexterm-xyz/dexterm). It is early: trading is experimental and has known bugs. The release ships checksums, a build-provenance attestation and an SBOM, and its VirusTotal result (including flags we explain) is on the trust page (https://dexterm.xyz/trust/). It is also on npm as `dexterm-cli` (https://www.npmjs.com/package/dexterm-cli); the command it installs is still `dexterm`.
