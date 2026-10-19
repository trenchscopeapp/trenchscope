// task-1406: the spectator popup composes with the popup host (ticket → one-time WS token, nonce CSP,
// event allow-list). The page renders the redacted SpectatorPopupVM; the only events it may send are
// spectator.pause / resume / takeover / kill by agent name — anything else, or a bad agent name, is dropped.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPopupServer, validateEventPayload, POPUP_EVENTS, type PopupServer } from '../src/server.ts';
import { fixtureSpectatorVM } from '../src/selftest.ts';
import type { ServerEvent, ThemeTokens } from '../src/protocol.ts';

const THEME: ThemeTokens = {
  bg: '#000', panel: '#010', border: '#020', borderFocus: '#39ff14', text: '#fff', muted: '#0a0', dim: '#060',
  accent: '#0ff', up: '#0f0', down: '#f06', warn: '#ff0', ai: '#d77', rain: ['#1', '#2', '#3', '#4'], rainPump: ['#1', '#2', '#3', '#4'], rainDump: ['#1', '#2', '#3', '#4'],
};

async function withServer(fn: (srv: PopupServer, events: ServerEvent[]) => Promise<void>): Promise<void> {
  const events: ServerEvent[] = [];
  const srv = await createPopupServer({ theme: THEME, onEvent: (e) => events.push(e) });
  try { await fn(srv, events); } finally { await srv.close(); }
}

test('the spectator popup page renders under the host CSP and never leaks a full address', async () => {
  await withServer(async (srv) => {
    const url = srv.issueTicket('spectator', 'sp1', { data: fixtureSpectatorVM() });
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'nonce-/, 'nonce CSP applies to the spectator page like every popup');
    const html = await res.text();
    assert.match(html, /WATCH THE AGENT COOK/);
    // the view model travels over the WS, not in the page HTML — the page carries no mint at all
    assert.ok(!/Fixt/.test(html), 'no view-model data (masked or not) is baked into the page');
  });
});

test('spectator events are allow-listed and validated; a bad agent name is dropped', () => {
  for (const name of ['spectator.pause', 'spectator.resume', 'spectator.takeover', 'spectator.kill']) {
    assert.ok(POPUP_EVENTS.has(`event:${name}`), `${name} is allow-listed`);
    assert.deepEqual(validateEventPayload(name, { agent: 'scanbot' }), { agent: 'scanbot' });
    assert.deepEqual(validateEventPayload(name, { agent: 'scanbot', evil: '<x>' }), { agent: 'scanbot' }, 'extra keys stripped');
    assert.equal(validateEventPayload(name, { agent: 'Bad Name!' }), null, 'a malformed agent name is refused');
    assert.equal(validateEventPayload(name, {}), null);
  }
  // a trade/arm shape has no spectator event at all
  assert.ok(!POPUP_EVENTS.has('event:spectator.buy'));
  assert.ok(!POPUP_EVENTS.has('event:spectator.arm'));
});
