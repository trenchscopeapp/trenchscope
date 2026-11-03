import { build } from 'esbuild';
import path from 'node:path';

await build({
  absWorkingDir: path.resolve(import.meta.dirname, '..'),
  entryPoints: ['server/ca-runtime.mjs'],
  outfile: 'server/generated/ca-runtime.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  mainFields: ['module', 'main'],
  // Optional native accelerators are unnecessary for these read-only RPC calls.
  external: ['bufferutil', 'utf-8-validate'],
  legalComments: 'inline',
  logLevel: 'info',
});
