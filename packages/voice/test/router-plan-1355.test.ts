// task-1355 — Jarvis order-plan PROPOSAL path. Voice recognises a conditional entry + ladder + moon bag
// + stop and emits an inert `propose-plan` decision bound to a mint. It never arms (isSafe holds, no
// execution-shaped field), and every mishear — unscaled number, ambiguous token, unclear fraction —
// clarifies instead of guessing. The app turns a `propose-plan` into a `proposed` plan; arming is a keypress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, isSafe, type VoiceDecision, type VoiceProvenance, type VoiceScreenState } from '../src/index.ts';

const prov: VoiceProvenance = { pttActive: true, speakerCount: 1, echoFlagged: false, sttConfidence: 1, lowConfTokens: [] };
const screen: VoiceScreenState = { screen: 'token', selected: { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, visibleSymbols: ['SOL', 'BONK', 'WIF'] };

test('north-star utterance → a propose-plan proposal bound to the selected mint, never armed', () => {
  const d = route('buy this if it dips to 300k, sell half at 600k, and leave a moon bag', prov, screen);
  assert.equal(d.kind, 'propose-plan');
  if (d.kind !== 'propose-plan') return;
  assert.equal(d.side, 'buy');
  assert.equal(d.target, '__selected__');
  assert.deepEqual(d.entry, { mcUsd: 300_000 });
  assert.equal(d.exits.length, 1);
  assert.equal(d.exits[0].mcUsd, 600_000);
  assert.ok(Math.abs(d.exits[0].fraction - 0.5) < 1e-9);
  assert.equal(d.moonBag, true);
  assert.ok(isSafe(d), 'the proposal is a safe decision');
  // defence in depth: it carries no arm/confirm/execute field
  for (const k of ['arm', 'armed', 'confirm', 'execute', 'sign', 'send', 'caps', 'live', 'mode']) assert.ok(!(k in (d as unknown as Record<string, unknown>)), `carries ${k}`);
});

test('a two-leg ladder + stop parses into ascending exits + a stop', () => {
  const d = route('buy this if it dips to 300k, sell half at 600k, sell a quarter at 1.2m, stop below 150k', prov, screen);
  assert.equal(d.kind, 'propose-plan');
  if (d.kind !== 'propose-plan') return;
  assert.equal(d.exits.length, 2);
  assert.equal(d.exits[0].mcUsd, 600_000);
  assert.equal(d.exits[1].mcUsd, 1_200_000);
  assert.equal(d.stopMcUsd, 150_000);
});

test('scale mishear (the 300k-vs-3M trap) clarifies, never guesses', () => {
  const d = route('buy this if it dips to 300, sell half at 600k', prov, screen);
  assert.equal(d.kind, 'clarify');
  if (d.kind === 'clarify') assert.match(d.question, /k or .*million/i);
});

test('an order plan on no named/selected token clarifies (bind to a mint, never a bare symbol)', () => {
  const d = route('buy if it dips to 300k and sell half at 600k', prov, { screen: 'screener', visibleSymbols: [] });
  assert.equal(d.kind, 'clarify');
});

test('verify fix: a NAMED ticker that is not on screen clarifies — never the highlighted row (no fuzzy match)', () => {
  const d = route('buy zzqq if it dips to 300k, sell half at 600k', prov, screen);
  assert.equal(d.kind, 'clarify');
  assert.match((d as { question: string }).question, /don't see a token called ZZQQ/);
  // a pronoun object still binds to the highlighted row; a visible ticker still binds to itself
  assert.equal(route('buy this if it dips to 300k, sell half at 600k', prov, screen).kind, 'propose-plan');
  const named = route('ape into bonk if it dips to 300k, sell half at 600k', prov, screen);
  assert.equal(named.kind, 'propose-plan');
  assert.equal((named as { target: string }).target, 'BONK');
});

test('isSafe holds, and no plan utterance ever arms, across a mixed corpus', () => {
  const corpus = [
    'buy this if it dips to 300k, sell half at 600k, moon bag',
    'buy bonk if it dips to 250k and take profit of half at 500k',
    'buy this if it dips to 300k, sell half at 600k and confirm it',  // "confirm" must not arm
    'sell half at 600k and a third at 900k',
    'buy this if it drops to 300k, stop at 150k',
    'set a plan buy if it dips to three hundred thousand',            // spoken-word amount → clarify
  ];
  for (const u of corpus) {
    const d = route(u, prov, screen);
    assert.ok(isSafe(d), `unsafe: "${u}"`);
    const o = d as unknown as Record<string, unknown>;
    for (const k of ['arm', 'armed', 'confirm', 'execute', 'sign', 'send', 'caps', 'live', 'mode', 'gate']) assert.ok(!(k in o), `"${u}" carries ${k}`);
  }
});
