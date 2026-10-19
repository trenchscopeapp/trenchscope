// Tier 1 (task-1345): the capability-tier table and the never-list. The never-list is checked FIRST and
// is deliberately broad: a dangerous name-shape (arm/sign/cap/gate/wallet/mandate/key/exec…) is refused
// before any lookup, so a future tool with a dangerous name cannot be added to the table by accident.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIERS, TIER_RANK, isTier, tierAtLeast, lowerTier, neverAllowed, tierFor, toolsForTier,
  TOOL_TIERS, PROPOSAL_TOOLS, NAVIGATION_TOOLS,
} from '../src/tiers.ts';

test('tier ordering', () => {
  assert.deepEqual(TIERS, ['observe', 'annotate', 'propose']);
  assert.ok(TIER_RANK.observe < TIER_RANK.annotate && TIER_RANK.annotate < TIER_RANK.propose);
  assert.ok(tierAtLeast('propose', 'observe'));
  assert.ok(tierAtLeast('observe', 'observe'));
  assert.ok(!tierAtLeast('observe', 'propose'));
  assert.equal(lowerTier('propose', 'observe'), 'observe');
  assert.ok(isTier('observe') && !isTier('root'));
});

test('read tools are observe, proposals are propose', () => {
  assert.equal(tierFor('get_token'), 'observe');
  assert.equal(tierFor('screener_query'), 'observe');
  assert.equal(tierFor('agent_note'), 'annotate');
  assert.equal(tierFor('open_token'), 'annotate');
  assert.equal(tierFor('propose_alert'), 'propose');
  assert.equal(tierFor('propose_order_plan'), 'propose');
  assert.equal(tierFor('add_to_watchlist'), 'propose');
});

test('toolsForTier is monotonic', () => {
  const o = new Set(toolsForTier('observe'));
  const a = new Set(toolsForTier('annotate'));
  const p = new Set(toolsForTier('propose'));
  for (const t of o) assert.ok(a.has(t) && p.has(t), `${t} should remain available at higher tiers`);
  assert.ok(p.size > a.size && a.size > o.size);
  // observe must never include a proposal or a navigation tool
  for (const t of PROPOSAL_TOOLS) assert.ok(!o.has(t));
  for (const t of NAVIGATION_TOOLS) assert.ok(!o.has(t));
});

test('the never-list refuses dangerous name-shapes before any lookup', () => {
  const dangerous = [
    'arm', 'arm_plan', 'sign', 'sign_tx', 'signer', 'confirm', 'confirm_order', 'send', 'send_tx',
    'broadcast', 'submit_tx', 'swap', 'transfer', 'withdraw', 'deposit', 'approve_spend',
    'raise_cap', 'set_limit', 'set_budget', 'set_ceiling', 'change_gate', 'opt_out', 'less_safe',
    'arm_mandate', 'wallet_export', 'panic', 'go_live', 'set_mode', 'mainnet',
    'read_key', 'get_keys', 'dump_secret', 'seed_phrase', 'mnemonic', 'private_key', 'helius_key',
    'exec', 'shell', 'spawn', 'eval', 'read_file', 'read_dir', 'env', 'process_list',
    'buy_now', 'sell_now', 'trade_now', 'execute', 'ticket_confirm', 'open_ticket_live',
    'set_tier', 'grant', 'escalate', 'promote', 'admin', 'sudo', 'root', 'kick', 'pause_agent', 'unpause',
    'open_ticket', // paper ticket is money-adjacent UI: no external agent opens it
  ];
  for (const name of dangerous) assert.ok(neverAllowed(name), `${name} must be on the never-list`);
  for (const name of dangerous) assert.equal(tierFor(name), null, `${name} must have no tier`);
});

test('odd name shapes are refused, never parsed', () => {
  assert.ok(neverAllowed(''));
  assert.ok(neverAllowed('a'.repeat(65)));
  assert.ok(neverAllowed('get token')); // space
  assert.ok(neverAllowed('../etc/passwd'));
  assert.ok(neverAllowed('get_token;rm'));
  assert.ok(neverAllowed(123 as unknown as string));
});

test('every vetted table name passes the never-list', () => {
  for (const name of Object.keys(TOOL_TIERS)) assert.ok(!neverAllowed(name), `${name} is in the table but the never-list refuses it`);
});

test('unknown tools have no tier', () => {
  assert.equal(tierFor('totally_unknown_tool'), null);
});
