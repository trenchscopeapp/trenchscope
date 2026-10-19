# Publishing dexterm to npm: the package shape and what is left

The release pipeline publishes with provenance from GitHub Actions (`.github/workflows/publish.yml`, gated by the `NPM_PUBLISH` repository variable). It stays off until the switches below are flipped on purpose.

## The package name is `dexterm-cli`

npm refuses to publish the unscoped name `dexterm` (HTTP 403, "Package name too similar to existing package xterm"), so the package is `dexterm-cli`; the command it installs is `dexterm`. Things learned on the first publish (2026-10-15): a new package's first publish creates a `0.0.0-stage` placeholder and the real version shows "Validating" for several minutes before it is installable; a security-key-only account cannot supply a one-time password at publish time, so the first publish needs a granular token that bypasses 2FA (short-lived, then revoked); and `dexterm-cli@0.1.1` was published by hand, so it has no provenance. The next version should go through `publish.yml` once trusted publishing is configured for `dexterm-cli`.

## Why there is a build step

dexterm runs its TypeScript sources directly from a checkout or the source tarball: `packages/cli/bin/dexterm.mjs` imports `../src/main.ts` and Node 22.18+ strips the types at load time (the installer symlinks the workspace packages into `node_modules/@dexterm/*`, and Node resolves them through the symlink to their real path under `packages/`).

That does not work for an npm install: Node refuses to type-strip any `.ts` file whose real path is under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). So the published package ships compiled JavaScript.

## The shape (implemented)

`packages/cli/scripts/build-dist.mjs` (the cli package's `build` and `prepack` script) compiles every workspace package into `packages/cli/dist/`, mirroring the repo layout, inlines the `@dexterm/*` workspace packages (bare specifiers rewritten to relative paths, so ONE package is published and no `@dexterm` scope is needed), and copies the runtime files loaded by path (assets, vendor, the popup pages, the MCP bin). `bin.dexterm` points at `dist/`, `files` is `dist` + `LICENSE`, and the package carries `license: AGPL-3.0-only`. The optional native chart shell stays a documented `cargo` step.

Verified from a clean checkout: `npm pack --workspace packages/cli` → install the tarball into an empty directory with a fresh `HOME` → `dexterm --help`, `dexterm doctor`, `dexterm --screen screener --fixtures` and an interactive `dexterm --fixtures --no-boot` on a pty all exit 0.

## What is left before the first npm publish

1. `packages/cli/package.json` still has `"private": true`, which makes `npm publish` refuse. Remove it in the same change that sets the release version (it is the deliberate "we publish to npm" switch).
2. npm attaches a trusted publisher to an **existing** package (package settings → Trusted publishing), so the very first version needs another credential. To keep provenance on that first version, publish it from this workflow with a short-lived token:
   - on npmjs.com (maintainer account, 2FA): a granular access token, read and write, limited to publishing, expiring in 1 day; store it as the repository secret `NPM_TOKEN` (the workflow passes it as `NODE_AUTH_TOKEN`; the npm CLI tries OIDC first and falls back to it);
   - set the repository variable `NPM_PUBLISH=true`, publish the release (or re-run the `npm` job of the release's `publish` run);
   - then: npmjs.com → dexterm → Settings → Trusted publishing → GitHub Actions: owner, repository `dexterm`, workflow `publish.yml`, no environment, and allow `npm publish` (configurations created after 2026-09-03 allow only `npm stage publish` unless direct publishing is ticked). A new configuration must see its first successful publish within 2 days or it expires;
   - Settings → Publishing access → "Require two-factor authentication and disallow tokens"; delete the `NPM_TOKEN` secret and revoke the token.
3. Every later release then publishes through OIDC with provenance, no token anywhere.

## Until then

- The GitHub release carries the source tarball, which the installer handles today.
- A Homebrew tap formula installs from that tarball with Homebrew's own Node (`docs/release-process.md`), avoiding both the npm question and macOS Gatekeeper (no signed binary is involved).
- `scan-results.json` reports `package.npmName: null` and `provenance: false`, and the trust page renders that honestly.
