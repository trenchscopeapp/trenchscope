# solgent

A Solana memecoin terminal for the trenches, with your own `claude` or `codex` login as the analyst, and a read-only MCP server so your agent sees the same screener, token dossiers, holder, rug and LARP checks, candles and trades. Formerly `trenchscope`.

```sh
npm i -g solgent
solgent doctor    # checks Node, the terminal, the optional claude/codex CLI and every data source
solgent           # start
```

Try it on sample data: `npx solgent --fixtures`.

## Use it from Claude or Codex

| Client | One line |
|---|---|
| Claude Code | `claude mcp add solgent -- npx -y solgent mcp` |
| Codex | `codex mcp add solgent -- npx -y solgent mcp` |
| Claude Desktop, Cursor and others | `solgent mcp install claude-desktop` (or `cursor`, `generic`) |

`solgent mcp doctor` checks the connection. The MCP server has no tool that can build, sign or send a transaction.

## Status

Pre-1.0 and early. Trading is simulated (paper) by default and live trading is experimental; a real trade is signed by your own wallet and its keys never enter solgent. Not financial advice.

The old `trenchscope` and `dexterm` commands still work and run solgent.

Source, install scripts and the full safety model: https://github.com/solgentapp/solgent. Updates: https://x.com/solgentapp. License: AGPL-3.0-only.
