#!/usr/bin/env node
// trenchscope read-only MCP server (stdio). Spawned by the TUI analyst and usable standalone:
//   claude mcp add trenchscope -- node <this file>
// Runs the TypeScript sources via Node's built-in type stripping (Node >= 22.18).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  process.stderr.write(`trenchscope mcp needs Node 22.18 or newer (found ${process.versions.node})\n`);
  process.exit(1);
}
if (process.argv.includes('--selftest')) {
  const { selfTest } = await import('../src/index.ts');
  process.stdout.write(JSON.stringify(selfTest(), null, 1) + '\n');
  process.exit(0);
}
const { runStdioServer } = await import('../src/index.ts');
await runStdioServer({ argv: process.argv.slice(2) });
