// task-1413 — the app-help golden set: >=40 "how do I …" questions, each with the entry id a user should
// land on. A deterministic (no-model) retrieval test: searchAppHelp(q)[0].id must equal the expected id.
// This guards both the entries' coverage and the retrieval's ranking. Tone of a real model answer is NOT
// judged here (that is reported from live `claude` transcripts in the handoff).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppHelp, searchAppHelp, getAppHelp } from '../src/app-help.ts';
import { GOLDEN } from './app-help-golden-data.ts';

test(`app-help golden set: ${GOLDEN.length} how-do-I questions each hit their expected entry`, () => {
  assert.ok(GOLDEN.length >= 40, `golden set must have >= 40 questions (has ${GOLDEN.length})`);
  const entries = loadAppHelp();
  const misses: string[] = [];
  for (const [q, id] of GOLDEN) {
    const results = searchAppHelp(q, 5, entries);
    if (results[0]?.id !== id) {
      misses.push(`"${q}" -> expected ${id}, got [${results.slice(0, 3).map((r) => `${r.id}:${r.score}`).join(', ') || 'none'}]`);
    }
  }
  assert.equal(misses.length, 0, `golden retrieval misses:\n  ${misses.join('\n  ')}`);
});

test('every expected golden id is a real app-help entry', () => {
  const entries = loadAppHelp();
  for (const [, id] of GOLDEN) assert.ok(getAppHelp(id, entries), `golden id ${id} has no entry`);
});

test('an app-help result carries the exact keys/commands as structured fields', () => {
  const e = getAppHelp('export-a-view')!;
  assert.deepEqual(e.keys, ['E'], 'export entry names the exact key E');
  assert.deepEqual(e.flags, ['--export']);
  const open = getAppHelp('open-a-coin')!;
  assert.ok(open.keys.includes('g'), 'open-a-coin names the g key');
  assert.ok(open.tools.includes('open_token'));
});
