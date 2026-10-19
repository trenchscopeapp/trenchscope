// task-1358 Tier 3 — the rules engine (ported from the task-1288 prototype) + the COMPROMISED-RULE suite: whatever
// a rule says, the engine can only alert, annotate, open UI or PROPOSE; nothing arms, signs, sizes past the cap or
// smuggles money-shaped args through text or JSON.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRule, parseExpr, ruleToJson, ruleToText, RulesEngine, exprToText, parseRulesFile, normalizeAction, describeActions, MAX_PER_HOUR_CAP, TICKET_SIZE_CAP, ACTIONS } from '../src/rules.ts';
import { validate, validateConfig, defaultConfig, policyCheck } from '../src/schema.ts';
import { ticks, T0, TICK_MS, type FixtureRow } from './fixtures/ticks.ts';

const SURGE = 'when vol5m.velocity > 3 and cluster < 20 and liq > 25K for 2 ticks then alert(up, "volume surge, clean holders") ticket(buy, 0.5) ask(token-dossier) cooldown 15m max 6/h name "surge-clean"';

test('grammar: clauses, derived signals, tags, and/or/not, parentheses, actions, modifiers', () => {
  const r = parseRule(SURGE);
  assert.equal(exprToText(r.when), 'vol5m.velocity > 3 and cluster < 20 and liq > 25K');
  assert.equal(r.for, '2 ticks');
  assert.deepEqual(r.then.map((a) => a.action), ['alert', 'ticket', 'ask']);
  assert.deepEqual(r.then[1].args, { side: 'buy', size: 0.5, unit: 'sol' });
  assert.equal(r.cooldown, '15m'); assert.equal(r.maxPerHour, 6); assert.equal(r.name, 'surge-clean');
  const r2 = parseRule('when (liq.delta < -40K or dev > 8) and not flag:mint and launchpad:pump then alert(down, "x") scope watchlist');
  assert.equal(exprToText(r2.when), '(liq.delta < -40K or dev > 8) and not (flag:mint) and launchpad:pump');
  assert.equal(r2.scope, 'watchlist');
  const json = ruleToJson(SURGE);
  assert.deepEqual(validate('ruleJson', json), []);
  assert.equal(json.id, 'surge-clean');
  // the JSON form round-trips to text and back to the same JSON
  const again = ruleToJson(ruleToText(json), { id: json.id });
  assert.deepEqual(again, json);
  // aliases and units
  const r3 = parseRule('mc > $1.5M and liquidity >= 50k and age < 2h then watch');
  assert.equal(exprToText(r3.when), 'mcap > 1500K and liq >= 50K and age < 120');
  assert.deepEqual(validate('ruleJson', ruleToJson(r3 && 'mc > $1.5M then watch')), []);
});

test('grammar refuses unknown fields/signals/actions, money-shaped ticket args, and over-cap limits', () => {
  assert.throws(() => parseRule('when foo > 1 then alert("x")'), /unknown field "foo"/);
  assert.throws(() => parseRule('when liq.slope > 1 then alert("x")'), /unknown signal/);
  assert.throws(() => parseRule('when liq > 1 then sign()'), /unknown action/);
  assert.throws(() => parseRule('when liq > 1 then arm()'), /unknown action/);
  assert.throws(() => parseRule('when liq > 1 then execute(buy)'), /unknown action/);
  assert.throws(() => parseRule(`when liq > 1 then ticket(buy, ${TICKET_SIZE_CAP + 1})`), /≤ 50/);
  assert.throws(() => parseRule('when liq > 1 then ticket(buy, 1, sol, arm=true)'), /cannot carry/);
  assert.throws(() => parseRule('when liq > 1 then ticket(buy, 1, sol, confirm=yes)'), /cannot carry/);
  assert.throws(() => parseRule('when liq > 1 then ticket(buy, 1, sol, live=1)'), /cannot carry/);
  assert.throws(() => parseRule('when liq > 1 then ticket(yolo, 1)'), /buy or sell/);
  assert.throws(() => parseRule('when liq > 1 then ticket(buy, 0)'), /≤ 50/);
  assert.throws(() => parseRule('when liq > 1 then ticket(buy, 1, btc)'), /sol, usd or pct/);
  assert.throws(() => parseRule('when liq > 1'), /needs "then/);
  assert.throws(() => parseRule('when liq > 1 then alert("x") eval(1)'), /unexpected/);
  assert.throws(() => parseRule(`when liq > 1 then alert("x") max ${MAX_PER_HOUR_CAP + 1}/h`), /1\.\.120/);
  assert.throws(() => parseRule('when liq > 1 then alert("x") max 0/h'), /1\.\.120/);
  assert.throws(() => parseRule('when liq > 1 then alert("x") scope signer'), /scope must be/);
  assert.throws(() => parseRule('when liq > 1 then alert("x") scope mint:not-base58'), /scope must be/);
  assert.throws(() => parseRule('when liq > 1 then alert("x") cooldown 3 ticks'), /bad duration|cooldown is a time/);
  assert.throws(() => parseRule('when liq > 1 then alert("x") cooldown 3ticks'), /cooldown is a time/);
  assert.throws(() => parseRule('when liq > 1 then popup(terminal)'), /popup\(kind\)/);
  assert.throws(() => parseRule('when liq > 1 then ask("rm -rf")'), /skill name/);
  assert.throws(() => parseRule('when liq > 1 then tag("\u001b[2J")'), /control characters/);
  assert.throws(() => parseRule('when liq > 1 then tag("\\u001b[2J")'), /control characters|printable/);
  assert.throws(() => parseRule('when liq > 1 then tag("a\\u202eb")'), /printable/);
  assert.throws(() => parseRule('when liq > 1 then ' + 'watch '.repeat(7)), /at most 6 actions/);
  assert.throws(() => parseRule('when ' + 'liq > 1 and '.repeat(60) + 'liq > 1 then watch'), /longer than 400/);
  assert.throws(() => parseRule('when liq > 1 then alert(`x`)'), /unexpected character|unexpected/);
});

test('end to end on fixtures: the surge rule fires once for WIF (clean cluster), never for CABAL (46 %) or THIN ($8K liq)', () => {
  const e = new RulesEngine({ rules: [ruleToJson(SURGE)] });
  assert.deepEqual(e.errors, []);
  const fired: Array<ReturnType<RulesEngine['evaluate']>['fired'][number] & { tick: number }> = [];
  const suppressed: Array<ReturnType<RulesEngine['evaluate']>['suppressed'][number] & { tick: number }> = [];
  for (const { tick, now, rows } of ticks({ n: 24 })) {
    e.observe(rows, now);
    const res = e.evaluate(rows, now);
    fired.push(...res.fired.map((f) => ({ ...f, tick })));
    suppressed.push(...res.suppressed.map((s) => ({ ...s, tick })));
  }
  assert.equal(fired.length, 1, `exactly one fire, got ${fired.map((f) => f.symbol + '@' + f.tick).join(',')}`);
  const f = fired[0];
  assert.equal(f.symbol, 'WIF');
  assert.equal(f.tick, 13, 'fires on the second consecutive tick the condition holds (for 2 ticks)');
  assert.ok(f.reasons.find((r) => r.clause.startsWith('vol5m.velocity'))!.value > 3);
  assert.ok(suppressed.some((s) => s.symbol === 'WIF' && s.why === 'holding' && s.tick === 12));
  assert.ok(suppressed.some((s) => s.symbol === 'WIF' && s.why === 'cooldown' && s.tick === 14));
  assert.ok(!fired.some((x) => x.symbol === 'CABAL') && !suppressed.some((x) => x.symbol === 'CABAL'), 'CABAL never even holds');
  assert.ok(!fired.some((x) => x.symbol === 'THIN'));
  // the actions: one alert, two PROPOSALS, nothing armed
  assert.deepEqual(f.actions.map((a) => a.kind), ['alert', 'proposal', 'proposal']);
  assert.equal((f.actions[0] as { level: string }).level, 'up');
  assert.match((f.actions[0] as { text: string }).text, /volume surge, clean holders: vol5m\.velocity > 3 \(\d/);
  for (const a of f.actions.slice(1)) { assert.equal((a as { status: string }).status, 'proposal'); assert.equal((a as { requiresKeypress: boolean }).requiresKeypress, true); assert.equal((a as { armedBy: null }).armedBy, null); }
  assert.equal(e.firesLastHour('surge-clean', T0 + 23 * TICK_MS), 1);
  assert.equal(e.lastFiredAt('surge-clean'), T0 + 13 * TICK_MS);
});

test('COMPROMISED RULE: no action output can carry armed/executed state, whatever the text or the JSON says', () => {
  const texts = [
    'when liq > 0 then ticket(sell, 50, pct) alert(info, "x") ask(rug-check) popup(chart) tag("t") sound(ping) cooldown 0s max 120/h',
    'when liq > 0 then ticket(side=buy, size=0.1, unit=usd) watch',
  ];
  for (const t of texts) {
    const e = new RulesEngine({ rules: [ruleToJson(t)] });
    assert.deepEqual(e.errors, []);
    let outputs = 0;
    for (const { now, rows } of ticks({ n: 3 })) {
      e.observe(rows, now);
      const res = e.evaluate(rows, now);
      for (const f of res.fired) for (const a of f.actions as unknown as Array<Record<string, unknown>>) {
        outputs += 1;
        assert.ok(!['armed', 'executed', 'filled', 'live'].includes(String(a.status)));
        for (const k of ['caps', 'arm', 'armed', 'sign', 'execute', 'confirm', 'mandate', 'gate', 'send']) assert.ok(!(k in a), `${k} leaked into an output`);
        if (a.kind === 'proposal') { assert.equal(a.requiresKeypress, true); assert.equal(a.armedBy, null); assert.equal(a.status, 'proposal'); }
      }
    }
    assert.ok(outputs > 0);
  }
  // JSON smuggling: args not in the grammar are dropped; money-shaped keys are refused by name; prototype keys refused
  const e = new RulesEngine();
  assert.throws(() => e.load({ id: 'x', when: 'liq > 0', then: [{ action: 'ticket', args: { side: 'buy', size: 1, unit: 'sol', autoArm: true } }] }), /cannot carry "autoArm"/);
  assert.throws(() => e.load({ id: 'x', when: 'liq > 0', then: [{ action: 'ticket', args: { side: 'buy', size: 1, unit: 'sol', caps: { perTx: 999 } } }] }), /cannot carry "caps"/);
  assert.throws(() => e.load({ id: 'x', when: 'liq > 0', then: [{ action: 'alert', args: JSON.parse('{"__proto__": {"x": 1}, "text": "a"}') }] }), /cannot carry "__proto__"/);
  const r = e.load({ id: 'x', when: 'liq > 0', then: [{ action: 'ticket', args: { side: 'buy', size: 1, unit: 'sol', note: 'dropped', mandateId: 'm1' } }] });
  assert.deepEqual(r.then[0].args, { side: 'buy', size: 1, unit: 'sol' });
  assert.throws(() => e.load({ id: 'x', when: 'liq > 0', then: [{ action: 'ticket', args: { side: 'buy', size: 5000 } }] }), /≤ 50/);
  assert.throws(() => e.load({ id: 'x', when: 'liq > 0', then: [{ action: 'sign', args: {} } as never] }), /unknown action/);
  assert.throws(() => e.load({ id: 'x', when: 'liq > 0', then: [], } as never), /1–6 actions/);
  assert.throws(() => e.load({ id: 'x', when: 'liq > 0', then: [{ action: 'watch' }], maxPerHour: 10_000 }), /1\.\.120/);
  assert.throws(() => e.load({ id: 'x', when: 'liq > 0', then: [{ action: 'watch' }], source: 'signer' }), /bad source/);
  assert.throws(() => e.load({ id: '../x', when: 'liq > 0', then: [{ action: 'watch' }] }), /slug/);
  // the action table itself has nothing money-shaped
  for (const a of ACTIONS) assert.ok(!/arm|sign|exec|send|confirm|live|mandate|cap/.test(a), a);
  // the config schema and the actor policy agree: a model/plugin/pack cannot add arm-shaped args to a rule
  assert.ok(validate('ruleJson', { id: 'x', when: 'liq > 0', then: [{ action: 'execute', args: {} }] }).length > 0);
  const denied = policyCheck([{ op: 'add', path: '/rules/0/then/0/args/arm', value: true }], 'jarvis');
  assert.ok(denied.length > 0, 'jarvis cannot write arm args into a rule');
});

test('rate limits are mandatory: cooldown per (rule, mint) and max/h per rule; defaults apply when unspecified', () => {
  const e = new RulesEngine({ rules: [{ id: 'always', when: 'liq > 0', then: [{ action: 'alert', args: { text: 'a' } }], cooldown: '30s', maxPerHour: 3 }] });
  let fires = 0;
  for (const { now, rows } of ticks({ n: 10 })) { e.observe(rows, now); fires += e.evaluate(rows, now).fired.length; }
  assert.equal(fires, 3, '12 rows × 10 ticks would be 120 fires; max 3/h caps it');
  const d = new RulesEngine({ rules: ['when liq > 0 then watch'] });
  assert.equal(d.rules[0].cooldownMs, 600_000); assert.equal(d.rules[0].maxPerHour, 12); assert.equal(d.rules[0].windowMs, 600_000);
  let dfires = 0;
  for (const { now, rows } of ticks({ n: 10 })) { d.observe(rows, now); dfires += d.evaluate(rows, now).fired.length; }
  assert.equal(dfires, 12, 'default 12/h');
});

test('derived signals need history: velocity is null (false) on the first two samples; windows prune; dry-run reports no-history rows', () => {
  const e = new RulesEngine({ rules: [{ id: 'v', when: 'vol5m.velocity > 0', then: [{ action: 'watch' }], cooldown: '0s', maxPerHour: 120, window: '30s' }] });
  const counts: number[] = [];
  let first: { mint: string } | null = null;
  for (const { now, rows } of ticks({ n: 6 })) { first ??= rows[0]; e.observe(rows, now); counts.push(e.evaluate(rows, now).fired.length); }
  assert.deepEqual(counts.slice(0, 3), [0, 0, 12], 'two prior samples required');
  assert.ok(e.ring.get(first!.mint)!.length <= 7, 'ring retains at most the largest rule window (≥ 60 s) of samples');
  // dry-run on a fresh engine: no history → 0 matches, 12 noHistory; the same rule on a warmed engine matches
  const fresh = new RulesEngine();
  const rows0 = [...ticks({ n: 1 })][0].rows;
  const d0 = fresh.dryRun('vol5m.velocity > 0 then watch', rows0, T0);
  assert.equal(d0.error, null); assert.equal(d0.matches.length, 0); assert.equal(d0.noHistory, 12); assert.equal(d0.considered, 12);
  const warm = new RulesEngine();
  let last: { now: number; rows: FixtureRow[] } | null = null;
  for (const t of ticks({ n: 4 })) { warm.observe(t.rows, t.now); last = t; }
  const d1 = warm.dryRun('vol5m.velocity > 0 then watch', last!.rows, last!.now);
  assert.equal(d1.matches.length, 12);
  assert.equal(warm.tick, 4, 'dry-run never observes or fires');
  assert.equal(warm.firesLastHour('dry-run'), 0);
});

test('dry-run: "would fire on N rows right now" ignores cooldown/max/for, honours scope, and returns parse errors instead of throwing', () => {
  const e = new RulesEngine();
  const rows = [...ticks({ n: 1 })][0].rows;
  const d = e.dryRun('liq > 1M and cluster < 10 then alert(up, "big and clean")', rows, T0);
  assert.equal(d.error, null);
  assert.deepEqual(d.matches.map((m) => m.symbol).sort(), ['ACT', 'BOME', 'GOAT', 'NEIRO', 'SIGMA']);
  assert.ok(d.matches[0].reasons.length === 2);
  const w = e.dryRun('liq > 1M then watch scope watchlist', rows, T0, { watchlist: new Set([rows[0].mint]) });
  assert.equal(w.considered, 1); assert.equal(w.matches.length, 1);
  const bad = e.dryRun('when liq >> 1 then watch', rows, T0);
  assert.equal(bad.rule, null); assert.match(bad.error!, /unexpected|expected/);
  const money = e.dryRun('liq > 1 then ticket(buy, 1, sol, arm=true)', rows, T0);
  assert.match(money.error!, /cannot carry/);
  // a `for 3 ticks` rule still reports matches (dry-run says "would match", not "would fire now")
  const f = e.dryRun('liq > 1M for 3 ticks then watch', rows, T0);
  assert.equal(f.matches.length, 6);
});

test('scopes: mint:<addr> binds to one coin, newpairs = age ≤ 120 min, positions needs the set; unknown data is false', () => {
  const rows = [...ticks({ n: 1 })][0].rows;
  const wif = rows.find((r) => r.symbol === 'WIF')!;
  const e = new RulesEngine({ rules: [`liq > 0 then watch scope mint:${wif.mint}`, 'liq > 0 then watch scope newpairs name "np"', 'liq > 0 then watch scope positions name "pos"'] });
  assert.deepEqual(e.errors, []);
  e.observe(rows, T0);
  const res = e.evaluate(rows, T0, { positions: new Set([rows[1].mint]) });
  const by = (id: string) => res.fired.filter((f) => f.rule === id).map((f) => f.symbol).sort();
  assert.deepEqual(by(e.rules[0].id), ['WIF']);
  assert.deepEqual(by('np'), ['CABAL', 'CHILL', 'PLONK', 'THIN']);
  assert.deepEqual(by('pos'), ['GOAT']);
  // null fields never satisfy a comparison, even `!=`
  const n = new RulesEngine({ rules: ['snipers != 99 then watch', 'bonding > -1 then watch name "b"'] });
  n.observe([{ mint: 'm'.repeat(32), symbol: 'X', snipers: null, bonding: null }], T0);
  assert.equal(n.evaluate([{ mint: 'm'.repeat(32), symbol: 'X', snipers: null, bonding: null }], T0).fired.length, 0);
});

test('rules file: one rule per line, comments, bad lines reported with their number, pack source + id prefix', () => {
  const text = `# trenches pack rules
vol5m.velocity > 3 and cluster < 20 and liq > 25K for 2 ticks then alert(up, "surge") name "surge"

liq.delta < -40K then alert(down, "liquidity leaving") popup(chart) name "lp-drain"
liq > 1 then sign() name "evil"
holders.velocity > 1.5 then ask(token-dossier) name "crowd"`;
  const r = parseRulesFile(text, { source: 'pack:trenches', idPrefix: 'trenches' });
  assert.deepEqual(r.rules.map((x) => x.id), ['trenches-surge', 'trenches-lp-drain', 'trenches-crowd']);
  assert.deepEqual(r.errors, [{ line: 5, msg: 'unknown action "sign" (alert | ticket | ask | popup | tag | sound | watch)' }]);
  for (const x of r.rules) { assert.equal(x.source, 'pack:trenches'); assert.deepEqual(validate('ruleJson', x), []); }
  const dup = parseRulesFile('liq > 1 then watch name "a"\nliq > 2 then watch name "a"');
  assert.equal(dup.rules.length, 1); assert.match(dup.errors[0].msg, /duplicate rule id/);
  // the whole set fits the config
  const cfg = { ...defaultConfig(), rules: r.rules };
  assert.deepEqual(validateConfig(cfg), []);
});

test('engine construction skips bad rules and reports them; good ones run; describeActions is stable', () => {
  const e = new RulesEngine({ rules: [{ id: 'ok', when: 'liq > 0', then: [{ action: 'watch' }] }, { id: 'bad', when: 'liq >>> 0', then: [{ action: 'watch' }] }, 'nonsense here'] });
  assert.equal(e.rules.length, 1);
  assert.equal(e.errors.length, 2);
  assert.equal(e.errors[0].id, 'bad');
  assert.equal(describeActions({ then: [normalizeAction('alert', { level: 'up', text: 'x' }), normalizeAction('ticket', { side: 'buy', size: 0.5 }), normalizeAction('ask', {})] }), 'alert up · ticket buy 0.5 sol · ask token-dossier');
  assert.equal(e.setEnabled('ok', false), true);
  e.observe([...ticks({ n: 1 })][0].rows, T0);
  assert.equal(e.evaluate([...ticks({ n: 1 })][0].rows, T0).fired.length, 0, 'a disabled rule never fires');
  e.remove('ok');
  assert.equal(e.rules.length, 0);
  assert.equal(parseExpr('liq > 1 and (dev < 5 or verified:yes)').kind, 'and');
});

test('r4 (verifier): `__proto__` / `constructor` / `toString` are not fields or tags — refused at parse (own-property lookups), never persisted, never a crash in evaluate()', () => {
  for (const text of ['__proto__ > 1 then watch', 'when constructor >= 0 then watch', 'hasOwnProperty < 3 then watch', 'toString.velocity > 1 then watch', 'valueOf.delta < 0 then watch']) {
    assert.throws(() => parseRule(text), /unknown field "(__proto__|constructor|hasownproperty|tostring|valueof)"/, text);
  }
  for (const text of ['constructor:x then watch', '__proto__:pump then watch', 'not toString:y then watch']) {
    assert.throws(() => parseRule(text), /unknown tag "(constructor|__proto__|tostring)"/, text);
  }
  // an alias may not point outside the field table either, and the JSON form goes through the same parser
  assert.throws(() => ruleToJson('__proto__ > 1 then watch', { id: 'bad-field' }), /unknown field/);
  // the JSON form (what a pack or config.rules carries) is refused by the engine's load too — nothing to crash on later
  const eng = new RulesEngine();
  assert.throws(() => eng.load({ id: 'proto-rule', when: '__proto__ > 1', then: [{ action: 'watch', args: {} }] }), /unknown field "__proto__"/);
  assert.throws(() => eng.load({ id: 'ctor-tag', when: 'constructor:x', then: [{ action: 'watch', args: {} }] }), /unknown tag "constructor"/);
  // a legitimate rule on the same tick still evaluates
  eng.load(ruleToJson('liq > 1 then watch', { id: 'ok-rule' }));
  for (const { now, rows } of ticks({ n: 2 })) { eng.observe(rows, now); assert.doesNotThrow(() => eng.evaluate(rows, now)); }
});
