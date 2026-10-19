---
id: docs-analyst-use-codex-instead-of-claude
title: The analyst › Use Codex instead of Claude
kind: docs
page: analyst
page_title: The analyst
heading: Use Codex instead of Claude
anchor: use-codex-instead-of-claude
url: https://dexterm.xyz/docs/analyst#use-codex-instead-of-claude
tags:
  - docs
  - analyst
  - use
  - codex
  - instead
  - claude
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/analyst.md
date: 2026-10-16
---

*Since 0.1.5.* The analyst can run on **your own Codex CLI login** instead of Claude. dexterm ships no key and reads no credential: the `codex` you set up and signed in to does the work, on your plan.

- **Pick it:** `--analyst-engine codex` at launch, `DEXTERM_ANALYST_ENGINE=codex`, `"analyst": {"engine": "codex"}` in `~/.dexterm/config.json`, or type `/engine codex` in the chat box (it applies to new conversations; `/engine` alone shows the current engine and which CLIs it found). The default, `auto`, prefers Claude Code and falls back to Codex. Only you choose: the analyst cannot change its own engine.
- **Same guarantees, enforced in the Codex CLI itself.** dexterm runs `codex exec --json` with your Codex config and rules files ignored, apps, plugins, hooks, skills discovery and sub-agents off, the shell and exec tools removed, the sandbox read-only, approvals `never` and web search off. Its only MCP server is the read-only `dexterm mcp`, limited by an allow-list: the read tools plus the UI actions the session allows (none in scan mode (https://dexterm.xyz/docs/scan)), never a paper or trade tool. If Codex still reports a command, a file change, a web search or any other tool, dexterm stops the turn and says so. The firewalled CONTEXT block, the skills and your own skill overlays are the same; the skill playbook is passed inline because Codex has no plugin directory.
- **What is different.** Codex reports whole messages, so an answer appears per message rather than word by word. The caption shows `codex plan` instead of a dollar cost (Codex reports tokens, not cost). The model is your Codex default for your login; pin one with `DEXTERM_CODEX_MODEL`. Which models a ChatGPT plan allows is decided by your plan, not by dexterm.
- **Codex errors are one line each:** no Codex CLI (`npm i -g @openai/codex && codex login`), a logged-out Codex (`codex login`), or an old one (update; the lock needs codex-cli 0.163.0 or newer, and an unknown lock flag fails the run instead of loosening it). `dexterm doctor` shows a Codex CLI line with the version and whether you are logged in. On Windows dexterm only starts a `codex.exe` on PATH; the npm `codex.cmd` shim is not started.
- **How we checked.** Offline tests drive a fake `codex` through the real app path, and a measurement harness runs the real codex-cli 0.163.0 against a local mock model (no account, no model): the tool list Codex sends is the dexterm allow-list only, and forged shell, exec, patch, sub-agent and ticket calls come back "unsupported" without running. Answer quality and speed against Claude have not been benchmarked.

Codex is also supported the other way round, as an MCP client that drives dexterm: `dexterm mcp install codex` (see bring your own agent (https://dexterm.xyz/docs/agents#install-in-one-command)).
