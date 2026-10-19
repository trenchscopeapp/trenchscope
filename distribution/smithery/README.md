# Smithery MCPB release input

Smithery distributes local stdio servers as MCPB bundles. This directory is the
release input, not a checked-in bundle.

For each release:

1. Update `manifest.json` and `server.json` to the exact published npm version.
2. Run `npm pack --workspace packages/cli` from the repository root.
3. Extract the tarball's `package/dist` directory to
   `distribution/smithery/stage/server/dist`.
4. Copy `manifest.json` to `distribution/smithery/stage/manifest.json`.
5. Run `npx @anthropic-ai/mcpb validate distribution/smithery/stage`.
6. Run `npx @anthropic-ai/mcpb pack distribution/smithery/stage
   dexterm-<version>.mcpb`.
7. Smoke-test the bundle on every platform claimed by the manifest before a
   maintainer uploads it to Smithery.

Do not commit `stage/` or a generated `.mcpb` artifact.
