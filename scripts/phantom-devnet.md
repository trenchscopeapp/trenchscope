# trenchscope — real Phantom test, DEVNET first (task-1310 T1 → task-1328 T2)

This is the manual test for the non-custodial trading path. **No private key ever enters dexterm.**
trenchscope opens a page in your browser; Phantom (a browser extension) does the signing; trenchscope keeps
only your public key, and a **separate signer process** (not the terminal UI) holds the caps, builds
the transaction, verifies what Phantom returns, re-simulates it and submits it.

Everything below runs from the root of a trenchscope checkout.

Prereqs: Node 24+, and Phantom installed in your default browser with **Developer mode / devnet**
enabled (Phantom → Settings → Developer Settings → Testnet Mode → Solana Devnet). Fund the devnet
wallet for free at https://faucet.solana.com (pick Devnet).

---

## 1. Link your wallet (connect + sign-a-message proof) — safe, no transaction

Either from a shell:

```sh
node packages/cli/bin/dexterm.mjs wallet link
```

or inside the app: type `/wallet link` on the screener's `/` line (or in the chat box).

What happens:
- trenchscope starts a one-shot server on `127.0.0.1:41291` (loopback only; a fixed port since task-1368 so
  Phantom's per-origin trust carries from link to sign — random only if 41291 is busy, and then the page
  says so: Phantom will ask to connect once on that one-off port) with a single-use token, and opens your
  browser to it.
- The page asks Phantom to **connect** and **sign a message** (a trenchscope nonce). No transaction, no
  funds, no approvals.
- Phantom pops up → approve the signature. trenchscope verifies the Ed25519 proof and stores **only your
  public key** at `~/.dexterm/wallet-link.json`.

Check / remove the link anytime: `trenchscope wallet status`, `trenchscope wallet unlink`, or `/wallet` /
`/wallet unlink` in the app. The link shows as `linked: <short>` in the ticket and portfolio banners.

---

## 2. What "devnet first" means here (read this)

**Jupiter's swap liquidity is mainnet-only — there is no Jupiter devnet.** So a real Jupiter *swap*
is a **mainnet** action. By default the signer runs against **devnet** and **refuses to sign a
mainnet swap** (`mainnet-not-enabled`): you can build and read a plan, and the plan screen tells you
it will be refused. That is the safe default (SPEC §6.10 "mainnet read-only quotes/sims, confirm
disabled").

Two separate things get tested on devnet, both with NO value at risk:

- **The whole signing path** — keypress → Phantom sign → decode + signature verify → re-simulate →
  submit → confirm — with the **devnet PROBE** (§3): a transaction trenchscope builds itself that wraps
  0.001 SOL into your own wrapped-SOL account and closes it back to you in the same transaction. The
  only SOL that leaves is the network fee. It goes through exactly the same signer code a swap does.
- **Phantom's Lighthouse behaviour** — Phantom may append Lighthouse assertion instructions to what it
  signs. The signer accepts an appended Lighthouse *tail* (and nothing else) and reports it; the probe
  result line says whether Phantom appended any. **This is the one thing nobody has observed yet.**

A real Jupiter swap on mainnet is **NOT** part of this test (§5).

---

## 3. The devnet PROBE (fees only) — run this

From a shell (prints the plan, waits for a real keypress, then opens Phantom):

```sh
node packages/cli/bin/dexterm.mjs wallet probe
```

You should see something like:

```
DEVNET PROBE for <AbCd…wXyZ> via api.devnet.solana.com
  wraps 0.0010 SOL into your own WSOL account and closes it back · fee ≈ 0.000005 SOL
  will sign: AssociatedToken:CreateIdempotent · System:Transfer→own WSOL · Token:SyncNative · Memo:memo · Token:CloseAccount→wallet
  simulation: ok (… lamports leave the wallet) · policy: ok · caps: ok
Press Y to sign this probe in Phantom (any other key aborts)…
```

Press `Y` → the browser opens the sign page → approve in Phantom → the shell prints:

```
✓ confirmed on devnet · signature <sig> · no Lighthouse tail · <ms> ms
```

or `… · Phantom appended N Lighthouse instruction(s)`. **Please paste that line into the card.**
Anything else is a refusal with a named reason (nothing was sent) or `send-unknown` with a signature
(do not resend; check the explorer). The result is also booked in `~/.dexterm/live-trades.sqlite` as
a probe (never a position).

The same probe inside the app: `/wallet probe` opens a LIVE ticket in probe mode → `Y`.

> The tx-sign page needs `@solana/web3.js` on the page as `window.dexSolana` to rebuild the
> transaction for `signTransaction()` (Phantom's API takes a `VersionedTransaction` object, not bytes).
> If the page says so, that shell has not landed yet — report it; nothing is signed either way.
>
> The sign page **connects first** (task-1368 (g)): the first time on this origin Phantom shows a Connect
> prompt, after that it connects silently; the page shows the connected account and refuses one that is
> not the linked wallet. A `4100` ("not authorized") is explained on the page — press Approve again and
> accept the Connect prompt, or allow `127.0.0.1:41291` under Phantom → Settings → Trusted apps.

---

## 4. A LIVE ticket in the app (devnet: builds a plan; the signer refuses to sign a mainnet swap)

```sh
node packages/cli/bin/dexterm.mjs
```

Open a token → `B` (or `S`) → press **`L`** on the ticket to flip PAPER → LIVE. The banner turns into
`◉ LIVE · DEVNET` (the network comes from the signer process, never from a flag) and the first LIVE
action starts the signer process. Enter a size → `⏎` → the signer quotes, builds, decodes, binds the
route to the plan and simulates → the **PLAN** screen: what will be signed, you pay / receive, min
received, impact (as a percent), fee, route, simulation, SOL/USD sources, and the caps verdict.

On devnet the plan says `the signer WILL REFUSE this plan: mainnet-not-enabled` (a Jupiter swap is a
mainnet transaction). `Y` asks anyway and gets the same refusal back from the signer — nothing is
signed. `esc` drops the plan.

`/wallet panic` (or `trenchscope wallet panic` from any shell) disables signing everywhere at once;
re-enabling needs a real keypress: `trenchscope wallet resume` in a terminal.

---

## 5. Mainnet swap — NOT YET (do not run this)

**There is no mainnet step in this round.** The heavy independent verification of T2 has not run.
Do not pass `--mainnet` to anything for this test. When the maintainers clear a mainnet trial, the command
will be `trenchscope --mainnet` (caps $5 per trade / $20 per day; raising them needs the flag and is
capped at $500 / $2000), the banner turns red `⚠ LIVE · MAINNET — REAL FUNDS`, and the same ticket
flow applies.

---

## What trenchscope never does

- never asks for, stores, or logs a private key, seed phrase, or signature material (only your pubkey);
- never signs or submits without your physical approval in Phantom;
- never lets the AI/analyst/voice/scan mode open a LIVE ticket, confirm or sign — they can only open a
  PAPER ticket you still confirm;
- the UI process never holds the caps or the transaction: the signer process does, and it refuses
  anything that is not the exact plan you saw.
