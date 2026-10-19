import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { SERVER_INFO } from '../src/server.ts';

const root = resolve(import.meta.dirname, '..', '..', '..');
const server = JSON.parse(readFileSync(resolve(root, 'server.json'), 'utf8'));
const cliPackage = JSON.parse(readFileSync(resolve(root, 'packages/cli/package.json'), 'utf8'));

test('registry metadata names the published package and starts its MCP command', () => {
  assert.equal(cliPackage.mcpName, server.name);
  assert.equal(server.packages.length, 1);
  assert.equal(server.packages[0].registryType, 'npm');
  assert.equal(server.packages[0].identifier, cliPackage.name);
  assert.equal(server.packages[0].transport.type, 'stdio');
  assert.deepEqual(server.packages[0].packageArguments, [{ type: 'positional', value: 'mcp' }]);
});

test('registry description stays inside the official 100-character limit', () => {
  assert.ok(server.description.length > 0);
  assert.ok(server.description.length <= 100);
});

test('MCP initialize reports the release package version', () => {
  assert.equal(SERVER_INFO.name, 'dexterm');
  assert.equal(SERVER_INFO.version, cliPackage.version);
});
