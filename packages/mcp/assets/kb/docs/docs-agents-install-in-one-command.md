---
id: docs-agents-install-in-one-command
title: Bring your own agent › Install in one command
kind: docs
page: agents
page_title: Bring your own agent
heading: Install in one command
anchor: install-in-one-command
url: https://dexterm.xyz/docs/agents#install-in-one-command
tags:
  - docs
  - agents
  - install
  - command
  - bring
  - own
  - agent
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/agents.md
date: 2026-10-16
---

`dexterm mcp install <client>` writes (or prints) the MCP config for your client. It prints the exact snippet, shows the file it will change, **asks first**, is **idempotent** (re-running changes nothing), and **backs the file up** before editing.

```sh
$ dexterm mcp install claude-code      # writes ./.mcp.json in this project (asks first)
$ dexterm mcp install cursor           # writes ~/.cursor/mcp.json
$ dexterm mcp install claude-desktop   # writes the Claude Desktop config for your OS
$ dexterm mcp install codex            # appends [mcp_servers.dexterm] to ~/.codex/config.toml
$ dexterm mcp install generic --print  # just print the snippet to paste anywhere
$ dexterm mcp doctor                   # spawn the server and list the tools your agent will see
```

| client | what it writes |
| --- | --- |
| `claude-code` | project `.mcp.json` (or run `claude mcp add dexterm -- dexterm mcp`) |
| `claude-desktop` | `claude_desktop_config.json` for your OS (restart the app after) |
| `cursor` | `~/.cursor/mcp.json` |
| `codex` | a `[mcp_servers.dexterm]` table in `~/.codex/config.toml` |
| `generic` | prints a standard `mcpServers` entry to paste where your agent reads MCP servers (`--config FILE` writes it) |

Flags: `--config FILE` writes to a specific file instead of the client default; `--print` only prints; `--node` emits a `node <path> mcp` command for when `dexterm` is not on your PATH; `--yes` skips the confirmation prompt. On a non-interactive shell the command prints the plan and writes nothing unless you pass `--yes`.

`dexterm mcp doctor` spawns the server over stdio, does the MCP handshake, and lists the tools, prompts and resources the agent sees — proof the connection works before you point an agent at it.

Codex is supported both ways: as an MCP client here (`dexterm mcp install codex`), and, since 0.1.5, as the engine that runs the in-app analyst on your own Codex login (use Codex instead of Claude (https://dexterm.xyz/docs/analyst#use-codex-instead-of-claude)).
