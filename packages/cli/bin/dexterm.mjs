#!/usr/bin/env node
// trenchscope bin shim. Runs the TypeScript sources directly via Node's built-in type stripping
// (Node >= 22.18 / 23.6+ / 24). This is the checkout/source-tarball entry; the npm package's bin is
// the compiled copy at dist/packages/cli/bin/dexterm.mjs, built by scripts/build-dist.mjs (task-1346).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(`trenchscope needs Node 22.18 or newer (found ${process.versions.node})\n`);
  process.exit(1);
}
// The PAPER bot runs without loading the app: main.ts pulls in the trade / signer modules, the bot's own import
// graph never does (packages/cli/test/bot-paper-guard.test.ts), so route it first.
if (process.argv[2] === 'bot') {
  const { botCommand } = await import('../src/bot-cmd.ts');
  process.exitCode = await botCommand(process.argv.slice(3), { stdout: process.stdout, stderr: process.stderr, env: process.env });
} else {
  const { main } = await import('../src/main.ts');
  process.exitCode = await main(process.argv.slice(2));
}
