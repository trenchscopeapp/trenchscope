// task-1413 — the app-help KB cannot drift from the app. Two directions:
//   1. regenerate-and-diff: the committed assets/kb/app-help/*.md must equal a fresh generation from the
//      current keymap / overlay / MCP tools / CLI. A key/tool/command change in the app that flows through
//      the generator changes the output, so the committed files go stale and this fails until regenerated.
//   2. every key / command / flag / tool a committed entry NAMES still exists in the app (no stale ref),
//      and every documented key on each screen, and every read-only MCP tool, is covered by some entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_KEYMAP, type ScreenKey } from '@dexterm/tui';
import { loadAppHelp, APP_HELP_DIR } from '@dexterm/mcp';
import { READ_ONLY_TOOLS } from '@dexterm/mcp';
import { buildAppHelpEntries, serializeEntry, appSubcommands, appFlags, appTools, SCREENS_DOCUMENTED, INTERNAL_FLAGS } from '../src/app-help-gen.ts';

test('regenerate-and-diff: committed app-help entries match a fresh generation (run gen-app-help-kb.ts)', () => {
  const entries = buildAppHelpEntries();
  const onDisk = fs.readdirSync(APP_HELP_DIR).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(onDisk, entries.map((e) => `${e.id}.md`).sort(), 'the set of committed entry files differs from the generator');
  const stale: string[] = [];
  for (const e of entries) {
    const committed = fs.readFileSync(path.join(APP_HELP_DIR, `${e.id}.md`), 'utf8');
    if (committed !== serializeEntry(e)) stale.push(e.id);
  }
  assert.equal(stale.length, 0, `stale committed entries (re-run packages/cli/scripts/gen-app-help-kb.ts): ${stale.join(', ')}`);
});

test('backward: every key / command / flag / tool a committed entry names still exists in the app', () => {
  const entries = loadAppHelp();
  const boundKeys = new Set<string>();
  for (const b of DEFAULT_KEYMAP.bindings) for (const k of b.keys) boundKeys.add(k);
  const subs = new Set(appSubcommands());
  const flags = new Set(appFlags());
  const tools = new Set(appTools());
  const bad: string[] = [];
  for (const e of entries) {
    for (const k of e.keys) if (!boundKeys.has(k)) bad.push(`${e.id}: key "${k}" is not bound in the keymap`);
    for (const c of e.commands) if (!subs.has(c)) bad.push(`${e.id}: command "${c}" is not a trenchscope subcommand`);
    for (const f of e.flags) if (!flags.has(f)) bad.push(`${e.id}: flag "${f}" is not accepted by the CLI`);
    for (const t of e.tools) if (!tools.has(t)) bad.push(`${e.id}: tool "${t}" is not an MCP tool`);
  }
  assert.equal(bad.length, 0, `stale references in app-help entries:\n  ${bad.join('\n  ')}`);
});

test('forward (keys): every labeled keymap key on each documented screen is covered by that screen entry', () => {
  const entries = new Map(loadAppHelp().map((e) => [e.id, e]));
  const missing: string[] = [];
  for (const screen of SCREENS_DOCUMENTED) {
    const entry = entries.get(`screen-${screen}`);
    assert.ok(entry, `no screen entry for ${screen}`);
    const have = new Set(entry!.keys);
    for (const b of DEFAULT_KEYMAP.forScreen(screen as ScreenKey)) {
      if (!b.label) continue;
      for (const k of b.keys) if (!have.has(k)) missing.push(`screen ${screen}: key "${k}" (${b.action}) not in screen-${screen} entry`);
    }
  }
  assert.equal(missing.length, 0, `keymap keys not covered by their screen entry:\n  ${missing.join('\n  ')}`);
});

test('forward (tools): every read-only MCP tool is referenced by at least one app-help entry', () => {
  const covered = new Set<string>();
  for (const e of loadAppHelp()) for (const t of e.tools) covered.add(t);
  const uncovered = READ_ONLY_TOOLS.filter((t) => !covered.has(t));
  assert.equal(uncovered.length, 0, `read-only MCP tools with no app-help entry: ${uncovered.join(', ')}`);
});

test('forward (subcommands): every trenchscope subcommand is covered by at least one app-help entry', () => {
  const covered = new Set<string>();
  for (const e of loadAppHelp()) for (const c of e.commands) covered.add(c);
  const uncovered = appSubcommands().filter((c) => !covered.has(c));
  assert.equal(uncovered.length, 0, `trenchscope subcommands with no app-help entry (add a topic in app-help-gen.ts): ${uncovered.join(', ')}`);
});

test('forward (flags): every accepted CLI flag is covered by an entry or is on the internal allow-list', () => {
  const covered = new Set<string>();
  for (const e of loadAppHelp()) for (const f of e.flags) covered.add(f);
  const uncovered = appFlags().filter((f) => !covered.has(f) && !INTERNAL_FLAGS.has(f));
  assert.equal(uncovered.length, 0,
    `user-facing CLI flags with no app-help entry (add to a topic, or to INTERNAL_FLAGS if truly internal): ${uncovered.join(', ')}`);
});

test('INTERNAL_FLAGS allow-list has no stale entries (every listed flag is still an accepted flag)', () => {
  const flags = new Set(appFlags());
  const stale = [...INTERNAL_FLAGS].filter((f) => !flags.has(f));
  assert.equal(stale.length, 0, `INTERNAL_FLAGS names flags the CLI no longer accepts: ${stale.join(', ')}`);
});
