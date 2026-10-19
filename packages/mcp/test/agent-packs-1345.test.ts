// task-1345 tier 2: the agent packs the MCP server exposes to external agents — the task-1293 skills as
// MCP prompts, and the KB / cases / skills as MCP resources. Offline, no network, no claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfTest, listPrompts, getPrompt, resourceList, resourceRead } from '../src/index.ts';

test('selfTest reports the three bundled skills and the resource count', () => {
  const s = selfTest();
  const skills = s.skills as string[];
  assert.deepEqual([...skills].sort(), ['rug-check', 'token-dossier', 'trench-scan']);
  assert.ok((s.resources as number) >= (s.kbEntries as number) + (s.cases as number) + skills.length - 1);
});

test('prompts/list advertises each skill with its declared arguments', () => {
  const prompts = listPrompts();
  const trench = prompts.find((p) => p.name === 'trench-scan');
  assert.ok(trench, 'trench-scan is offered as a prompt');
  assert.match(String(trench!.description), /scan/i);
  const args = trench!.arguments as Array<{ name: string }>;
  assert.ok(args.some((a) => a.name === 'limit'));
});

test('prompts/get returns the skill body with $ARGUMENTS substituted', () => {
  const p = getPrompt('trench-scan', { limit: '8' });
  assert.ok(!('error' in p));
  if ('error' in p) return;
  const text = (p.messages[0].content as { text: string }).text;
  assert.match(text, /Trench scan/);
  assert.ok(!text.includes('$ARGUMENTS'), 'the placeholder is substituted');
  assert.ok(text.includes('8'), 'the limit argument lands in the body');
});

test('prompts/get on an unknown skill reports an error, never throws', () => {
  const p = getPrompt('does-not-exist');
  assert.ok('error' in p);
});

test('resources list KB, cases and skills; resources/read returns each or rejects a bad uri', () => {
  const list = resourceList();
  assert.ok(list.some((r) => String(r.uri).startsWith('dexterm://kb/')));
  assert.ok(list.some((r) => String(r.uri).startsWith('dexterm://skill/')));
  assert.ok(list.some((r) => String(r.uri).startsWith('dexterm://case/')));
  const skill = resourceRead('dexterm://skill/trench-scan');
  assert.ok('contents' in skill && /Trench scan/.test(String(skill.contents[0].text)));
  const kbUri = String(list.find((r) => String(r.uri).startsWith('dexterm://kb/'))!.uri);
  assert.ok('contents' in resourceRead(kbUri));
  assert.ok('error' in resourceRead('dexterm://evil/../../etc/passwd'));
  assert.ok('error' in resourceRead('file:///etc/passwd'));
});
