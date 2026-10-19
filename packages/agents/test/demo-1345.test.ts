// Tier 6 (task-1345): the worked demo is EXERCISED by the suite (bus-only, no spawned MCP child so the
// test stays fast and offline) and its invariants asserted — proof the capture-ready demo still runs and
// still refuses every malicious attempt. The full demo (`node packages/agents/demo/worked-demo.ts`) also
// spawns the real `trenchscope mcp` stdio server to show Claude Code receiving the trench-scan skill over MCP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDemo } from '../demo/worked-demo.ts';

test('worked demo runs on fixtures: scan verdict, custom-agent proposal, every malicious attempt refused', async () => {
  const { result } = await runDemo({ withMcp: false, echo: false });

  // Actor 1: the trench-scan produced grounded candidates and skipped the obvious rug.
  assert.equal(result.scan.skill, 'trench-scan');
  assert.ok(result.scan.scanned >= 4, 'the scan read the fixture screener rows');
  assert.ok(result.scan.skipped.length >= 1, 'the freeze/mint-authority rug is skipped with a reason');
  assert.ok(result.scan.candidates.some((c) => c.verdict === 'WATCH'), 'at least one WATCH candidate');
  assert.ok(result.scan.candidates.every((c) => /\.(rows|organicScore|scoreNormalised)|rugcheck|screener_query/.test(c.strongest)), 'every candidate cites a tool + field');

  // Actor 2: a custom agent created a proposal, labelled with its own name, never armed.
  assert.equal((result.custom as { agentName: string }).agentName, 'scanbot');
  assert.equal((result.custom as { armed: boolean }).armed, false);

  // Actor 3: the malicious agent made several attempts and EVERY one was refused.
  assert.ok(result.malicious.length >= 6, 'the malicious agent made several attempts');
  assert.ok(result.malicious.every((m) => m.refused), 'every malicious attempt must be refused');
  assert.ok(result.malicious.some((m) => m.code === 'never'), 'financial/escalation tools hit the never-list');
  assert.ok(result.malicious.some((m) => m.code === 'spoof'), 'an identity-spoof argument is refused');

  // Every proposal in the store is labelled and unarmed.
  const props = result.proposals as Array<{ agentName: string; armed: boolean }>;
  assert.ok(props.length >= 2);
  assert.ok(props.every((p) => p.agentName && p.armed === false), 'proposals are labelled and never armed');
});
