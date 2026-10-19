# Security policy

dexterm is a local terminal app that reads public market data and can trade without custody: trading is simulated (paper) by default, a real trade is signed by your own wallet, your wallet's keys never enter dexterm, and the caps are enforced in a separate signer process. It also opens WebSockets, runs loopback HTTP servers for the chart window and the wallet bridge, fetches token websites on request, and feeds untrusted text to a language model. Bugs in any of that matter to us.

## Report a vulnerability

**Please do not open a public issue for a security problem.**

- Preferred: GitHub's private vulnerability reporting on this repository ("Security" tab → "Report a vulnerability"). It creates a private advisory only maintainers can see.
- Or email: `security@dexterm.xyz` (reaches the maintainers; use it if you cannot use the GitHub form).

Include what you can: the version or commit, your OS and terminal, steps to reproduce, and what you believe the impact is. `dexterm doctor` output helps and contains no secrets. If you have a proof of concept, attach it to the private report rather than describing it publicly.

## What to expect

| step | target |
|---|---|
| acknowledgement | within 3 days |
| first assessment (is it in scope, how bad) | within 7 days |
| fix or mitigation for a confirmed issue | within 30 days for high impact, 90 days otherwise; we will tell you if we need longer and why |
| credit | in the release notes and advisory, if you want it |

We do not currently pay bounties. We will never contact you first by DM about a report; anyone doing so in our name is not us.

## Scope

In scope:

- anything that lets a remote party read or change local state, or run code;
- anything that gets a transaction signed or sent without your keypress (and, for a Phantom trade, your wallet approval), gets one past the signer's caps, or reads your linked wallet's key (dexterm should never see it) or the devnet fast-wallet key;
- the signer process: its caps and ledgers, its authenticated pipe to the terminal, the transaction checks it runs before anything is signed;
- the wallet bridge: the one-shot loopback pages, their tokens, Host/Origin checks and CSP;
- any path from a model, voice command, agent or token metadata to arming a plan, raising a cap or reaching the signer;
- the loopback chart server and the native shell: ticket, token, Host/Origin checks, CSP, navigation pinning;
- the prompt firewall: untrusted text (token metadata, fetched pages, feeds) escaping its wrapping or steering the analyst into actions;
- the SSRF-safe page fetcher (private ranges, redirects, content types, size caps);
- the release pipeline: provenance, checksums, SBOM, the scan results on the trust page;
- the install script and the Node download verification.

Out of scope (still welcome as normal issues):

- the correctness of third-party market data, rug scores or the model's judgement;
- rate limiting by upstream APIs;
- issues that need a compromised local machine or a modified copy of dexterm.

## Supported versions

Only the latest release gets fixes. Pre-1.0, there is no long-term branch.

## How we handle a flagged scan

Every release artifact is scanned by VirusTotal and the results, including any engine that flags a file, are published on the trust page with a note. A flag is investigated like a report: reproduce with the exact hash, compare against the attested build, and either fix the cause or document the false positive next to the result. We do not hide or re-roll a flagged result.
