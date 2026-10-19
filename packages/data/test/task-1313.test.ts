// @dexterm/data — task-1313 analyst UI-action channel: the strict validator and the authenticated
// channel line format. Pure, offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAnalystAction, serializeActionLine, parseActionLine, ACTION_RATE } from '../src/analyst-actions.ts';

const A = 'Aaa' + '1'.repeat(40); // 43-char valid base58, on screen
const B = 'Bbb' + '2'.repeat(40); // on screen
const EVIL = 'Zzz' + '9'.repeat(40); // valid base58 but NOT on screen → must be rejected by the allow-list
const allow = { mints: [A, B], feeds: ['trending', 'new'], sortKeys: ['vol', 'liq', 'h24'] } as const;

test('validateAnalystAction accepts well-formed actions that reference on-screen tokens', () => {
  assert.equal(validateAnalystAction({ type: 'open_token', mint: A }, allow).ok, true);
  assert.equal(validateAnalystAction({ type: 'add_to_watchlist', mint: B }, allow).ok, true);
  assert.equal(validateAnalystAction({ type: 'open_ticket', mint: A, side: 'buy' }, allow).ok, true);
  assert.equal(validateAnalystAction({ type: 'switch_feed', feed: 'trending' }, allow).ok, true);
  assert.equal(validateAnalystAction({ type: 'show_in_screener', filter: 'liq > 50K', sort: { key: 'vol', dir: 'desc' }, highlight: A }, allow).ok, true);
});

test('validateAnalystAction rejects a mint that is not on screen (the anti-injection gate)', () => {
  const r = validateAnalystAction({ type: 'open_token', mint: EVIL }, allow);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /not among the tokens currently on screen/);
  // add_to_watchlist / open_ticket / highlight all gate on the same allow-list
  assert.equal(validateAnalystAction({ type: 'add_to_watchlist', mint: EVIL }, allow).ok, false);
  assert.equal(validateAnalystAction({ type: 'open_ticket', mint: EVIL, side: 'buy' }, allow).ok, false);
  assert.equal(validateAnalystAction({ type: 'show_in_screener', highlight: EVIL }, allow).ok, false);
});

test('validateAnalystAction rejects malformed types, mints, sides, feeds, sorts and filters', () => {
  assert.equal(validateAnalystAction({ type: 'exfiltrate', mint: A }, allow).ok, false);
  assert.equal(validateAnalystAction({ type: 'open_token', mint: 'not-base58' }, allow).ok, false);
  assert.equal(validateAnalystAction({ type: 'open_ticket', mint: A, side: 'confirm' }, allow).ok, false);
  assert.equal(validateAnalystAction({ type: 'switch_feed', feed: 'rm-rf' }, allow).ok, false);
  assert.equal(validateAnalystAction({ type: 'show_in_screener', sort: { key: 'pwn' } }, allow).ok, false);
  assert.equal(validateAnalystAction({ type: 'show_in_screener', filter: '`$(rm -rf /)`' }, allow).ok, false);
  assert.equal(validateAnalystAction({ type: 'show_in_screener' }, allow).ok, false, 'nothing to do');
  assert.equal(validateAnalystAction('not-an-object', allow).ok, false);
});

test('validateAnalystAction normalizes the action (defaults sort dir, trims) and labels it', () => {
  const r = validateAnalystAction({ type: 'show_in_screener', sort: { key: 'h24' } }, allow);
  assert.equal(r.ok, true);
  assert.deepEqual((r as { action: unknown }).action, { type: 'show_in_screener', sort: { key: 'h24', dir: 'desc' } });
  assert.match((r as { label: string }).label, /showed the screener/);
});

test('channel lines are token-authenticated: a wrong token or malformed line does not parse', () => {
  const token = 'secret-run-token';
  const line = serializeActionLine(token, 7, { type: 'open_token', mint: A });
  const good = parseActionLine(line, token);
  assert.ok(good);
  assert.equal(good!.seq, 7);
  assert.deepEqual(good!.action, { type: 'open_token', mint: A });
  assert.equal(parseActionLine(line, 'other-token'), null, 'a different token is rejected');
  assert.equal(parseActionLine('{"v":2,"token":"secret-run-token","seq":1,"action":{}}', token), null, 'wrong version');
  assert.equal(parseActionLine('not json', token), null);
  assert.equal(parseActionLine('', token), null);
});

test('ACTION_RATE exposes a sane shared ceiling', () => {
  assert.ok(ACTION_RATE.max >= 1 && ACTION_RATE.windowMs >= 1000);
});
