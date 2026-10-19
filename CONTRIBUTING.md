# Contributing to dexterm

Thanks for looking. dexterm is small, opinionated and pre-1.0, so the most useful contributions right now are bug reports with reproduction steps, data-source fixes, and tests. Big features are better discussed in an issue first.

## Ground rules

- **Non-custodial, caps in the signer, paper by default.** Your wallet signs; your wallet's keys never enter dexterm. Pull requests that make dexterm hold, read or import a user's wallet key, sign or send without the user's keypress and wallet approval, move a cap out of the signer process, give the model or an agent a path to the signer, or make a run start anywhere but paper will not be merged on the main line. That boundary is the product.
- **Honest data.** A panel whose source is down shows `unavailable` or `needs key`, never a made-up number. Model output is labelled as such with the age of every input.
- **Untrusted text stays untrusted.** Anything that comes from a token, a website or a feed goes through the prompt firewall before a model sees it.
- **No new runtime dependencies** without a discussion. dexterm has zero third-party runtime dependencies on purpose (the SBOM and the scanners stay boring). Dev tooling is fine.
- **No telemetry, ever.**

## Setup

```sh
git clone https://github.com/dexterm-xyz/dexterm.git && cd dexterm
npm install            # TypeScript + @types/node only
npm run typecheck
npm test               # node --test over packages/*/test; runs offline
npm run dexterm -- --fixtures   # the app on seeded demo data, no network
```

Node 22.18+ is required. `DEXTERM_OFFLINE=1` makes every live source refuse to connect, which is what CI uses. Details, screens, flags and the test harnesses: [docs/development.md](docs/development.md).

## Pull requests

1. Open an issue first for anything beyond a small fix.
2. Branch from `main`; keep the change focused.
3. Add or update tests next to the code (`packages/<pkg>/test/`). Replay-based tests (recorded fixtures) are preferred over live ones.
4. `npm run typecheck && npm test` must pass locally; CI runs the same plus actionlint, gitleaks and osv-scanner.
5. Describe what changed and why in the PR; the template asks the questions we care about.
6. Sign off your commits (`git commit -s`): by doing so you certify the [Developer Certificate of Origin](https://developercertificate.org/), i.e. that you have the right to submit the change under the project's license.

A maintainer reviews every PR. Expect questions about safety boundaries and about what happens when a source is down.

## Reporting bugs

Use the bug template. Include `dexterm doctor` output (it contains no secrets), your terminal, and the exact command or key sequence. For anything security-related, read [SECURITY.md](SECURITY.md) first and do not post it publicly.

## Releases

Maintainers only: [docs/release-process.md](docs/release-process.md).
