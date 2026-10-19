---
id: docs-configuration-the-analyst-s-launch
title: Configuration and files on disk › The analyst's launch
kind: docs
page: configuration
page_title: Configuration and files on disk
heading: The analyst's launch
anchor: the-analyst-s-launch
url: https://dexterm.xyz/docs/configuration#the-analyst-s-launch
tags:
  - docs
  - configuration
  - analyst
  - launch
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

For the record, the analyst is spawned as `claude -p` with `--output-format stream-json`, `--tools ''` (no built-in tools), `--strict-mcp-config` pointing at the dexterm server only, `--allowedTools mcp__dexterm__*`, `--permission-mode dontAsk`, `--setting-sources ''` (none of your Claude Code settings or other plugins), the dexterm plugin directory for the skills, the analyst system prompt appended, a JSON schema for structured skills, and `--disallowedTools` for the action tools in scan mode. It cannot read files, run commands or reach any other MCP server from inside dexterm.

On Codex (since 0.1.5) it is spawned as `codex exec --json` with `--ignore-user-config` and `--ignore-rules`, `--disable` for `shell_tool`, `unified_exec`, `apps`, `plugins`, `hooks`, `multi_agent`, `browser_use` and `computer_use` (an unknown name fails the run), `sandbox_mode="read-only"`, `approval_policy="never"`, `web_search="disabled"`, the system prompt as `developer_instructions`, one `dexterm` MCP server with an `enabled_tools` allow-list and its environment forwarded by name (no value on the command line), and `--output-schema` for structured skills. The same lock is repeated on every resumed turn. `analyst.engine` in `config.json` is yours alone: a model or agent proposal that touches it is refused.
