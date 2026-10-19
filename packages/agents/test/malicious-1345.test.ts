// Tier 5 (task-1345): the MALICIOUS-AGENT suite. "Untrusted by default" is the whole point of the
// bring-your-own-agent layer, so this drives the REAL loopback bus (the WebSocket server + the shipped TS
// SDK + raw protocol frames) playing an agent that is assumed compromised or buggy and tries, 41 different ways, to escalate its tier, exfiltrate keys/secrets/files, run financial actions, spoof another agent,
// flood the server, replay a proposal, or inject terminal-control sequences into the UI. EVERY attempt is
// refused (or the injected payload is neutralised), and every gated refusal lands in the audit log — the
// suite asserts both. If any single attempt ever succeeds, the headline test fails loudly.
//
// Nothing here can arm, sign, confirm, send, raise a cap, change the gate, or touch a wallet/mandate/signer:
// no such tool exists in the table and the never-list refuses the SHAPE of the request before any lookup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentBus } from '../src/bus.ts';
import { AgentRegistry, TOKEN_PREFIX } from '../src/identity.ts';
import { MemoryAuditLog } from '../src/audit.ts';
import { FixtureExecutor, FixtureFeed } from '../src/executor.ts';
import { MemoryProposalStore } from '../src/proposals.ts';
import { DextermAgent } from '../src/sdk.ts';
import { FLOOD_REFUSALS, DEFAULT_LIMITS } from '../src/gate.ts';

const MINT_A = 'FixtMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

async function harness() {
  const registry = new AgentRegistry({ path: ':memory:' });
  const audit = new MemoryAuditLog();
  const executor = new FixtureExecutor();
  const proposals = new MemoryProposalStore();
  const feed = new FixtureFeed();
  const bus = new AgentBus({ registry, audit, executor, proposals, feed, discoveryPath: null });
  const port = await bus.start();
  const url = `ws://127.0.0.1:${port}`;
  const tokens = {
    attacker: registry.add('attacker', 'propose').token,   // worst case: highest tier, still boxed in
    lowagent: registry.add('lowagent', 'observe').token,    // tier-escalation target
    victim: registry.add('victim', 'observe').token,        // identity-spoof target
    spammer: registry.add('spammer', 'propose').token,      // quota / idempotency
    flooder: registry.add('flooder', 'propose').token,      // flood breaker (poisons its own agent)
  };
  return { registry, audit, executor, proposals, feed, bus, url, tokens };
}

/** A refusal recorded by the battery: either the gate refused it, auth failed, or an injected payload was scrubbed. */
interface Attempt { n: number; category: string; name: string; refused: boolean; how: string }

function codeOf(e: unknown): string {
  const err = e as Error & { data?: { code?: string } };
  return err?.data?.code ?? (err?.message ? `error:${err.message.slice(0, 40)}` : 'unknown');
}

/** Call a tool that must be refused; returns the refusal code (throws the test if it unexpectedly succeeds). */
async function mustRefuse(a: DextermAgent, tool: string, args: Record<string, unknown>): Promise<{ refused: boolean; how: string }> {
  try {
    const r = await a.call(tool, args);
    return { refused: false, how: `UNEXPECTEDLY ALLOWED -> ${JSON.stringify(r).slice(0, 80)}` };
  } catch (e) {
    return { refused: true, how: codeOf(e) };
  }
}

// Two distinct injection payloads exercise two distinct defences:
//   CONTROL  — an ANSI clear-screen + OSC title + BEL (C0/C1). The closed schema REFUSES it outright.
//   INVISIBLE — bidi-override + zero-width + BOM (no C0, so it passes the schema). It is ACCEPTED as text
//               but every such character is stripped before it reaches the roster, the terminal or an agent.
const CONTROL_PAYLOAD = '\u001b[2Jwiped\u001b]0;pwn\u0007';
const INVISIBLE_PAYLOAD = 'safe‮evil​zero﻿mark';
const hasControl = (s: string): boolean => /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/.test(s);

/** Open a raw loopback WebSocket, optionally authenticate, send ONE object, resolve its first reply. */
function rawProbe(url: string, opts: { hello?: Record<string, unknown>; sendRaw?: string; send?: Record<string, unknown> }): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const to = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('raw probe timed out')); }, 4000);
    let helloed = false;
    ws.addEventListener('open', () => { if (opts.hello) ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'h', method: 'hello', params: opts.hello })); else fire(); });
    ws.addEventListener('message', (e: MessageEvent) => {
      const msg = JSON.parse(String(e.data)) as Record<string, unknown>;
      if (opts.hello && !helloed && msg.id === 'h') { helloed = true; fire(); return; }
      clearTimeout(to); try { ws.close(); } catch { /* ignore */ } resolve(msg);
    });
    ws.addEventListener('error', () => { clearTimeout(to); reject(new Error('raw probe socket error')); });
    function fire() { if (opts.sendRaw !== undefined) ws.send(opts.sendRaw); else ws.send(JSON.stringify(opts.send)); }
  });
}

test('malicious agent: 41 escalation / exfiltration / flood / spoof / UI-injection attempts, every one refused', async () => {
  const h = await harness();
  const attempts: Attempt[] = [];
  let n = 0;
  const push = (category: string, name: string, r: { refused: boolean; how: string }) => { attempts.push({ n: ++n, category, name, refused: r.refused, how: r.how }); };
  try {
    const attacker = await DextermAgent.connect({ name: 'attacker', token: h.tokens.attacker, url: h.url, client: 'malicious 6.6.6' });

    // ----- A. financial actions: refused by SHAPE (never-list), before any lookup, even at propose tier
    for (const tool of ['arm_plan', 'sign_tx', 'confirm_trade', 'send_transaction', 'swap_now', 'raise_cap', 'set_budget', 'open_ticket', 'trade_now', 'wallet_export', 'panic_sell', 'go_live', 'mandate_create']) {
      push('financial', tool, await mustRefuse(attacker, tool, { mint: MINT_A }));
    }

    // ----- B. exfiltration of keys / secrets / env / files / shell
    for (const tool of ['read_key', 'dump_seed', 'get_env', 'read_file', 'exec_shell', 'helius_key']) {
      push('exfiltration', tool, await mustRefuse(attacker, tool, {}));
    }

    // ----- C. malformed input: a file:// URL fails the closed schema; an oversize arg blob is refused
    push('bad-input', 'fetch_page file://', await mustRefuse(attacker, 'fetch_page', { url: 'file:///etc/passwd' }));
    push('bad-input', 'oversize args', await mustRefuse(attacker, 'get_token', { mint: MINT_A, symbol: 'x'.repeat(20_000) }));

    // ----- D. tier escalation: a request can only LOWER the grant; an observe agent cannot propose
    const low1 = await DextermAgent.connect({ name: 'lowagent', token: h.tokens.lowagent, url: h.url, tier: 'propose' }); // asks for propose
    assert.equal(low1.hello?.tier, 'observe', 'a client cannot raise its granted tier at hello');
    push('escalation', 'hello tier=propose (granted observe) then propose_alert', await mustRefuse(low1, 'propose_alert', { mint: MINT_A, when: 'mcap 1M', idempotency_key: 'esc-12345678' }));
    push('escalation', 'observe agent calls add_to_watchlist', await mustRefuse(low1, 'add_to_watchlist', { mint: MINT_A, idempotency_key: 'esc-22345678' }));
    low1.close();

    // ----- E. identity/capability spoof in the call arguments (server owns identity and tier)
    for (const f of ['tier', 'agent', 'on_behalf_of', 'impersonate']) {
      push('spoof-args', `screener_query {${f}}`, await mustRefuse(attacker, 'screener_query', { preset: 'new', [f]: 'victim' }));
    }

    // ----- F. transport-level impersonation: you cannot wear another agent's name
    const reuse = await mustConnectFail(h.url, 'victim', h.tokens.attacker);   // victim's name + attacker's token
    push('spoof-identity', 'connect as victim with attacker token', reuse);
    const forged = await mustConnectFail(h.url, 'victim', `${TOKEN_PREFIX}${'A'.repeat(43)}`); // forged token
    push('spoof-identity', 'connect as victim with a forged token', forged);

    // ----- G. raw JSON-RPC protocol abuse
    const preHello = await rawProbe(h.url, { send: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screener_query' } } });
    push('protocol', 'tools/call before hello', { refused: !!preHello.error, how: `rpc ${(preHello.error as { code?: number })?.code}` });
    const parse = await rawProbe(h.url, { sendRaw: 'this is not json' });
    push('protocol', 'malformed JSON frame', { refused: !!parse.error, how: `rpc ${(parse.error as { code?: number })?.code}` });
    const badMethod = await rawProbe(h.url, { hello: { name: 'attacker', token: h.tokens.attacker }, send: { jsonrpc: '2.0', id: 2, method: 'admin/shutdown', params: {} } });
    push('protocol', 'unknown method after hello', { refused: !!badMethod.error, how: `rpc ${(badMethod.error as { code?: number })?.code}` });

    // ----- H. idempotency replay + proposal quota (on a dedicated agent so counts stay clean)
    const spammer = await DextermAgent.connect({ name: 'spammer', token: h.tokens.spammer, url: h.url });
    const dup = { mint: MINT_A, when: 'replayed', idempotency_key: 'replay-key-123456' };
    const first = await spammer.propose('propose_alert', dup);
    const second = await spammer.propose('propose_alert', dup); // replay the same key
    push('replay', 'replayed proposal (same idempotency key)', { refused: second.duplicate === true && (first.proposal as { id: string }).id === (second.proposal as { id: string }).id, how: 'returned the same proposal, no second row' });
    push('replay', 'proposal without idempotency_key', await mustRefuse(spammer, 'propose_alert', { mint: MINT_A, when: 'no key' }));
    // exhaust the hourly proposal quota and confirm the overflow is refused
    let quotaRefused = false;
    for (let i = 0; i < DEFAULT_LIMITS.proposalsPerHour + 2; i++) {
      try { await spammer.propose('add_to_watchlist', { mint: MINT_A, idempotency_key: `q-${i}-abcdef` }); }
      catch (e) { if (codeOf(e) === 'quota') quotaRefused = true; }
    }
    push('quota', 'proposal flood past the hourly quota', { refused: quotaRefused, how: 'quota' });
    spammer.close();

    // ----- I. flood breaker: sustained refusals auto-pause the agent (DoS containment), poisoning only itself
    const flooder = await DextermAgent.connect({ name: 'flooder', token: h.tokens.flooder, url: h.url });
    for (let i = 0; i < FLOOD_REFUSALS; i++) { try { await flooder.call('make_me_rich', {}); } catch { /* expected */ } }
    const afterFlood = await mustRefuse(flooder, 'screener_query', { preset: 'new' }); // even a VALID call now refused
    push('flood', 'flood breaker auto-pauses after sustained refusals', { refused: afterFlood.refused && afterFlood.how === 'flood-paused', how: afterFlood.how });
    flooder.close();

    // ----- J. UI-injection. Two defences: the schema REFUSES C0/control outright; bidi/zero-width that
    //          slip past the schema are STRIPPED before they reach the roster, the terminal or an agent.
    push('ui-injection', 'agent_note with an ANSI clear-screen (C0)', await mustRefuse(attacker, 'agent_note', { mint: MINT_A, text: CONTROL_PAYLOAD, tag: 'watch' }));
    push('ui-injection', 'propose_alert "when" with a control sequence', await mustRefuse(attacker, 'propose_alert', { mint: MINT_A, when: CONTROL_PAYLOAD, idempotency_key: 'inject-key-1234' }));
    // bidi + zero-width pass the schema but must come back neutralised
    const noteRes = await attacker.call('agent_note', { mint: MINT_A, text: INVISIBLE_PAYLOAD, tag: 'watch' });
    const noteClean = !hasControl(String(noteRes.text ?? '')) && String(noteRes.text ?? '') !== INVISIBLE_PAYLOAD;
    push('ui-injection', 'agent_note with bidi/zero-width (neutralised)', { refused: noteClean, how: 'bidi + zero-width stripped from the result' });
    const alertRes = await attacker.propose('propose_alert', { mint: MINT_A, when: INVISIBLE_PAYLOAD, note: INVISIBLE_PAYLOAD, idempotency_key: 'inject-key-5678' });
    const summary = (alertRes.proposal as { summary: string }).summary;
    const detailJson = JSON.stringify((alertRes.proposal as { detail: unknown }).detail);
    push('ui-injection', 'proposal text with bidi/zero-width (neutralised)', { refused: !hasControl(summary) && !hasControl(detailJson), how: 'proposal summary + detail firewalled' });
    attacker.close();

    // client label carrying control sequences is firewalled before it reaches the roster
    const labelled = await DextermAgent.connect({ name: 'victim', token: h.tokens.victim, url: h.url, client: `bot${CONTROL_PAYLOAD}${INVISIBLE_PAYLOAD}` });
    const rosterClient = h.bus.roster().find((r) => r.name === 'victim')?.client ?? '';
    push('ui-injection', 'client label carried control sequences at hello', { refused: !hasControl(rosterClient), how: 'roster client label firewalled' });
    labelled.close();

    // ---------- verdict ----------
    const log = attempts.map((a) => `  [${a.refused ? 'REFUSED' : ' ALLOWED !!'}] #${String(a.n).padStart(2, '0')} ${a.category.padEnd(14)} ${a.name}  (${a.how})`).join('\n');
    console.log(`\nmalicious-agent battery — ${attempts.length} attempts\n${log}\n`);

    const allowed = attempts.filter((a) => !a.refused);
    assert.equal(allowed.length, 0, `every malicious attempt must be refused; these slipped through:\n${allowed.map((a) => a.name).join('\n')}`);
    assert.ok(attempts.length >= 25, `the suite must make at least 25 attempts (made ${attempts.length})`);

    // ---------- with logs: the gate wrote a refusal row for the gated attempts ----------
    const refusedRows = h.audit.recent(500, { kind: 'refused' });
    assert.ok(refusedRows.length >= 25, `the audit log should record the refusals (saw ${refusedRows.length})`);
    assert.ok(h.audit.recent(500, { kind: 'flood' }).length >= 1, 'the flood breaker trip is audited');
    // every audited detail is a single safe line (no control sequences leaked into the log)
    assert.ok(h.audit.recent(1000).every((r) => !hasControl(r.detail)), 'no audit detail may carry a control sequence');
  } finally {
    await h.bus.close();
  }
});

/** A connect that MUST fail authentication (wrong identity/token). */
async function mustConnectFail(url: string, name: string, token: string): Promise<{ refused: boolean; how: string }> {
  try {
    const a = await DextermAgent.connect({ name, token, url });
    a.close();
    return { refused: false, how: 'UNEXPECTEDLY AUTHENTICATED' };
  } catch (e) {
    return { refused: true, how: `auth:${(e as Error).message.slice(0, 32)}` };
  }
}

// A focused companion test: a kicked agent's live sessions are closed and further calls refused, and the
// audit names the kick — the user's panic control over a rogue agent.
test('malicious agent: a kick closes the rogue session and is audited', async () => {
  const h = await harness();
  try {
    const a = await DextermAgent.connect({ name: 'attacker', token: h.tokens.attacker, url: h.url });
    assert.equal(h.bus.roster().length, 1);
    assert.equal(h.bus.kickAgent('attacker'), 1);
    await new Promise((r) => setTimeout(r, 40));
    await assert.rejects(a.call('screener_query', { preset: 'new' }), /closed|internal/);
    assert.ok(h.audit.recent(50, { kind: 'kick' }).length >= 1, 'the kick is audited');
  } finally {
    await h.bus.close();
  }
});
