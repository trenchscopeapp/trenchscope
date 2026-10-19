# Release process (maintainers)

Nothing in this repository publishes on its own. A tag starts a build; a human publishes the draft; only then do the downstream jobs run, and each of those is behind an explicit switch.

## One-time setup

Repository → Settings:

- **Actions → General**: workflow permissions "Read repository contents and packages permissions" (the workflows request what they need per job). Fork PRs cannot access secrets by default; keep it that way.
- **Secrets**: `VT_API_KEY` (VirusTotal public API key; optional — without it the VirusTotal entries are `pending`). `SITE_REPO_TOKEN` only if `SITE_REPO` is set (a fine-grained token with contents + pull-requests write on the site repo only).
- **Variables**: `LICENSE_SPDX` (e.g. `AGPL-3.0-only`) so scan-results.json carries it; `NPM_PUBLISH` = `true` once the npm trusted publisher is set up ([npm-publish-shape.md](npm-publish-shape.md)); no npm token secret is needed; `SITE_REPO` = `owner/site-repo` to have the pipeline open a PR with `scan-results.json`.
- **Rulesets**: protect `main` (PR required, CI required, no force push) and protect tags `v*` (only maintainers create). OpenSSF Scorecard reads rulesets with the default token.
- **Security**: enable private vulnerability reporting, Dependabot alerts, Dependabot security updates. Code scanning: the scorecard workflow uploads SARIF.
- **npmjs.com**: the trusted publisher for `dexterm-cli` → GitHub Actions, `dexterm-xyz` / `dexterm`, `publish.yml`, no environment, direct `npm publish` allowed; then Publishing access → "Require two-factor authentication and disallow tokens" ([npm-publish-shape.md](npm-publish-shape.md)).

## Cutting a release

1. Update `CHANGELOG.md` and bump `version` in `packages/cli/package.json` (and the other workspace packages if they changed). The release workflow fails if the tag and the package version disagree.
2. Merge to `main`; CI must be green.
3. Tag and push the tag:
   ```sh
   git tag -s v0.1.0 -m "dexterm v0.1.0"     # a signed tag if you have a key; -a otherwise
   git push origin v0.1.0
   ```
4. `release.yml` runs: clean checkout → `npm ci` → typecheck → tests (offline) → `build.mjs` (reproducible tarball) → `sbom.mjs` → `checksums.mjs` → build-provenance attestation over `SHA256SUMS` → SBOM attestation → `supply-chain.mjs` → `virustotal.mjs` (live if the key is set) → `scan-results.mjs` → draft release with the tarball, `SHA256SUMS`, the SBOM and `scan-results.json`.
5. Open the draft release. Check: the checksums in the notes match the assets; `gh attestation verify dexterm-0.1.0-src.tar.gz --owner dexterm-xyz` passes; `scan-results.json` says what you expect (a `flagged` entry is not a reason to hide the release; see [false-positives.md](false-positives.md)). Edit the notes.
6. **Publish** the draft. This is the only step that makes anything public, and a person does it.
7. `publish.yml` then runs the gated jobs: npm through trusted publishing with provenance (if `NPM_PUBLISH`), site PR (if `SITE_REPO`).
8. `rescan.yml` re-scans the latest published release every Sunday 06:00 UTC and replaces its `scan-results.json`; the site picks it up through the next PR or at build time.

## Local dry run

Everything except signing and uploading runs locally; the dry run script in the distribution kit (`dexterm/distribution/dry-run.sh` in the internal workspace) exercises export → build → SBOM → checksums → unsigned provenance statement → VirusTotal fixtures → supply-chain → scan-results, and `act` can run `ci.yml` in Docker. Signed attestations only exist on GitHub-hosted runners.

## Homebrew

A tap formula (`Formula/dexterm.rb`, in the `homebrew-dexterm` tap repo once created) installs the release tarball with Homebrew's `node` and writes a `dexterm` wrapper; `sha256` is the `SHA256SUMS` line for the tarball. Users: `brew tap dexterm-xyz/dexterm && brew trust dexterm-xyz/dexterm && brew install dexterm` (Homebrew 7+ refuses to load a third-party tap until it is trusted). No Apple Developer account, no notarization: nothing in the formula is a signed Mach-O; the optional native chart window is compiled on the user's machine by `cargo` if they choose. Homebrew core submission is possible later (needs a stable tag history, an OSI license and notability).

## macOS Gatekeeper and notarization

CLI tools installed by npm or Homebrew do not trigger Gatekeeper; only apps and binaries downloaded by a browser and double-clicked do. dexterm ships no prebuilt binary. If a signed, notarized `.app` or standalone binary is ever wanted, that needs an Apple Developer Program membership (USD 99/year) and a signing step in the release workflow; it is not needed for the current distribution shape.

## VirusTotal quota

Public API: 4 requests/minute, 500/day, non-commercial, one account. A release costs ~16-24 requests, a weekly re-scan ~12-20; `virustotal.mjs` paces itself and stops at a daily budget of 450. Do not add retries or parallelism around it.
