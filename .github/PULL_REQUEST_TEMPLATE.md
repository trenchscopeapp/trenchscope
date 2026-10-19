## What and why

<!-- one paragraph: the problem, the change, the issue it closes (Fixes #…) -->

## Safety boundaries

- [ ] This change does not let dexterm hold a user's wallet key, sign or send without the user's keypress and wallet approval, bypass or move the signer's caps, give a model or agent a path to the signer, or add telemetry.
- [ ] Untrusted text (token metadata, fetched pages, feeds) still goes through the prompt firewall.
- [ ] No new third-party runtime dependency. (Dev tooling changes are listed below.)

## When a source is down

<!-- what the affected screen shows when its data source is unavailable, rate-limited or keyless -->

## Tests

- [ ] `npm run typecheck && npm test` pass locally.
- [ ] Added or updated tests in `packages/<pkg>/test/` (replay fixtures preferred over live calls).

## Commits are signed off (`git commit -s`, DCO)

- [ ] Yes.
