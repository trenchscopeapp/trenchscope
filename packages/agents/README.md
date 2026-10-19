# @dexterm/agents — bring your own agent (task-1345)

Hook your own agent (Claude Code, Codex, a local agent, a custom bot) up to a running dexterm.
Agents are **untrusted by default**: every agent has a server-side capability tier, every call passes one
gate, and no agent path can ever arm, sign, send, raise a cap, change the confirmation gate, or touch a
wallet, a mandate or the signer. Fixture data only in tests and demos; no wallets, no mainnet.

## Two ways to connect

1. **MCP (read-only, the main hookup).** `claude mcp add dexterm -- dexterm mcp`. The standalone MCP server
   exposes the read tools, plus the dexterm **skills as MCP prompts** and the **KB / cases / skills as MCP
   resources** (agent packs), so your agent gets the same playbooks. `dexterm mcp --replay FILE` serves a
   recorded fixture file offline.
2. **The loopback agent bus (WebSocket + JSON-RPC 2.0).** A running dexterm listens on `127.0.0.1:<port>`
   (written to `~/.dexterm/agent-bus.json`). Your agent authenticates with its registered name + token,
   lists the tools its tier allows, calls read/navigation tools, subscribes to live topics (new pairs,
   trades, alerts, screen), and creates proposals the user confirms. TS and Python SDKs ship here.

## Capability tiers (server-side, per agent identity)

| Tier | May | Never (any tier) |
|---|---|---|
| `observe` | read tools + live streams | arm, sign, confirm, send a trade |
| `annotate` | + non-financial navigation, agent-owned notes/tags | raise or change a cap |
| `propose` | + proposals (alerts, order plans, watch adds) the user confirms with a keypress | change the gate; touch a wallet / mandate / signer / keys |

The tier comes from the registry at `hello`, never from the request. A client may only request to run
**below** its grant. A request argument named `tier`, `agent`, `session`, `token`, … is refused as spoofing.
A dangerous tool-name shape (arm/sign/cap/gate/wallet/mandate/key/exec/ticket…) is refused by the never-list
*before any lookup*.

## Register an agent

```
dexterm agent add scanbot --tier observe          # prints a one-time token (shown once)
dexterm agent list | rotate <name> | remove <name> | tier <name> <tier> | pause <name> | resume <name>
dexterm agent audit [--agent NAME]                # the full per-agent audit log
dexterm agent packs                               # the skills/KB your agent gets over MCP
dexterm agent serve [--fixtures|--live]           # run a standalone loopback bus
dexterm agent connect --name NAME [--watch 30]    # token via $DEXTERM_AGENT_TOKEN (never a flag)
```

The token is shown once and stored only as a salted SHA-256 hash in `~/.dexterm/agents.json` (mode 0600).
`rotate` and `remove` invalidate it immediately. Pass the token to your agent through the
`DEXTERM_AGENT_TOKEN` environment variable — never on a command line.

## TypeScript SDK (`@dexterm/agents/sdk`, zero dependencies)

```ts
import { connectAgent } from '@dexterm/agents/sdk';
const agent = await connectAgent({ name: 'scanbot', token: process.env.DEXTERM_AGENT_TOKEN! });
const tools = await agent.listTools();
const rows = await agent.call('screener_query', { preset: 'new', limit: 8 });
agent.on('new_pairs', (ev) => console.log(ev.data));
await agent.subscribe(['new_pairs']);
await agent.propose('propose_alert', { mint, when: 'mcap crosses 1M', idempotency_key: 'k-' + Date.now() });
agent.close();
```

## Python SDK (`python/dexterm_agent.py`, stdlib only)

```py
import os
from dexterm_agent import connect
agent = connect(name="scanbot", token=os.environ["DEXTERM_AGENT_TOKEN"])
print(agent.list_tools())
rows = agent.call("screener_query", {"preset": "new", "limit": 8})
agent.subscribe(["new_pairs"], lambda ev: print("event", ev["data"]))
agent.close()
```

## Bus protocol (JSON-RPC 2.0 over a loopback WebSocket)

- `hello { name, token, tier?, client? }` → `{ protocol, agent, tier, grantedTier, tools[], paused }`
- `tools/list` → `{ tools: [{ name, tier, description, inputSchema }] }` (filtered to your tier)
- `tools/call { name, arguments }` → the tool result, or a JSON-RPC error whose `data.code` is the refusal
  reason (`never`, `tier`, `spoof`, `bad-args`, `rate-limited`, `quota`, `idempotency-key`, `agent-paused`…)
- `ping` → `{ pong: true }`
- server → client: `{ method: "event", params: { topic, seq, t, data } }` for subscribed topics

Proposals carry an idempotency key (8–64 chars); the same agent + key returns the same proposal instead of a
second one. Rate limits, quotas and a flood breaker are per agent and enforced in the gate. Every connect,
call, refusal, proposal, note and disconnect is one row in the audit log the roster popup reads.

## Worked demo + security suite (task-1345, tiers 5–6)

- `node packages/agents/demo/worked-demo.ts` — the capture-ready worked demo (fixtures, offline, no wallets,
  no mainnet). Three actors share one running dexterm: **claude-code over MCP** (spawns the real `dexterm mcp`
  stdio server, receives the `trench-scan` skill + agent packs, runs the scan on the fixture dataset and
  proposes a WATCH alert), a **custom TS agent** that subscribes to the stream and proposes an alert on a
  signal, and a **malicious agent** that fails every escalation. It writes a normalised `demo/transcript.txt`
  and `demo/evidence.json` for the agents film (task-1344). `--no-mcp` runs the bus-only path the test uses.
- `test/malicious-1345.test.ts` — the malicious-agent suite: 41 escalation / exfiltration / financial / spoof
  / flood / replay / quota / UI-injection attempts over the real bus, every one refused (or neutralised) and
  the refusals asserted in the audit log.
