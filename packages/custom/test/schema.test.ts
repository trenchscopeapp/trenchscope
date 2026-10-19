// task-1358 Tier 1 — config schema, JSON patch + inverses, actor policy, migrations (ported from the task-1288 prototype).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, defaultConfig, applyOps, policyCheck, migrate, CONFIG_VERSION, getAt, validate } from '../src/schema.ts';
import { validateWorkspace } from '../src/workspace.ts';

test('the default config validates and has no key/signer/trading section', () => {
  const cfg = defaultConfig();
  assert.deepEqual(validateConfig(cfg), []);
  for (const k of ['keys', 'signer', 'trading', 'wallet', 'caps', 'mandates']) assert.ok(!(k in cfg), `${k} must not exist in the config shape`);
});

test('unknown sections, prototype-pollution keys and a keys section are refused by name', () => {
  const bad = { ...defaultConfig(), keys: { helius: 'x' } };
  assert.ok(validateConfig(bad).some((e) => e.path === '/keys' && e.msg === 'unknown key'));
  const polluted = JSON.parse('{"version":3,"theme":{"__proto__":{"name":"x"}}}');
  assert.ok(validateConfig(polluted).some((e) => e.path === '/theme/__proto__' && e.msg === 'forbidden key'));
  assert.ok(validateConfig({ version: 99 }).some((e) => e.path === '/version'));
});

test('theme overrides must be hex; a shell-looking theme name is refused', () => {
  assert.ok(validateConfig({ ...defaultConfig(), theme: { name: 'cyberspace', overrides: { up: 'green' } } }).some((e) => e.path === '/theme/overrides/up'));
  assert.ok(validateConfig({ ...defaultConfig(), theme: { name: '$(rm -rf ~)' } }).some((e) => e.path === '/theme/name'));
});

test('applyOps applies add/replace/remove/test on a copy and returns an inverse that restores it', () => {
  const cfg = defaultConfig();
  const ops = [
    { op: 'replace' as const, path: '/theme/name', value: 'ember' },
    { op: 'add' as const, path: '/rules/-', value: { id: 'r1', when: 'liq > 10K', then: [{ action: 'alert', args: { text: 'hi' } }] } },
    { op: 'remove' as const, path: '/fx/sound' },
    { op: 'test' as const, path: '/version', value: CONFIG_VERSION },
  ];
  const { doc, inverse } = applyOps(cfg, ops);
  assert.equal(cfg.theme?.name, 'mono', 'the original is untouched');
  assert.equal(doc.theme?.name, 'ember');
  assert.equal(doc.rules?.length, 1);
  assert.ok(!('sound' in (doc.fx ?? {})));
  assert.deepEqual(validateConfig(doc), []);
  const back = applyOps(doc, inverse).doc;
  assert.deepEqual(back, cfg);
});

test('applyOps refuses root ops, __proto__ segments and replace-of-missing', () => {
  const cfg = defaultConfig();
  assert.throws(() => applyOps(cfg, [{ op: 'replace', path: '', value: {} }]), /root ops/);
  assert.throws(() => applyOps(cfg, [{ op: 'add', path: '/__proto__/x', value: 1 }]), /forbidden/);
  assert.throws(() => applyOps(cfg, [{ op: 'replace', path: '/nope', value: 1 }]), /missing/);
  assert.equal(getAt(cfg, '/theme/name'), 'mono');
  assert.equal(getAt(cfg, '/__proto__'), undefined);
});

test('policy: a non-user actor is refused on money/secret paths and money-shaped values, the user is not', () => {
  const refused = [
    [{ op: 'add', path: '/signer', value: {} }],
    [{ op: 'add', path: '/jarvis/gate', value: 'voice' }],
    [{ op: 'replace', path: '/plugins/tip/enabled', value: true }],
    [{ op: 'add', path: '/packs/-', value: { name: 'x' } }],
    [{ op: 'add', path: '/rules/-', value: { id: 'r', when: 'liq > 1', then: [{ action: 'ticket', args: { arm: true } }] } }],
    [{ op: 'replace', path: '/theme/name', value: { apiKey: 'x' } }],
    [{ op: 'replace', path: '/version', value: 9 }],
  ];
  for (const ops of refused) {
    const errs = policyCheck(ops, 'jarvis');
    assert.ok(errs.length > 0, `jarvis should be refused: ${JSON.stringify(ops)}`);
    assert.ok(errs.every((e) => /refused/.test(e.msg) || /not allowed/.test(e.msg)), errs.map((e) => e.msg).join('; '));
  }
  assert.deepEqual(policyCheck([{ op: 'replace', path: '/theme/name', value: 'ember' }], 'jarvis'), []);
  assert.deepEqual(policyCheck([{ op: 'add', path: '/packs/-', value: { name: 'x' } }], 'user'), []);
  assert.ok(policyCheck([], 'user').length);
  assert.ok(policyCheck(Array.from({ length: 21 }, () => ({ op: 'test', path: '/version', value: 3 })), 'user').some((e) => /more than 20/.test(e.msg)));
});

test('task-1393: the voice section validates, rejects bad shapes, and is user-only for models', () => {
  // A valid voice preference passes.
  assert.deepEqual(validateConfig({ ...defaultConfig(), voice: { name: 'Daniel', rate: 190 } }), []);
  // Wrong types / out-of-range / unknown keys are refused.
  assert.ok(validateConfig({ ...defaultConfig(), voice: { rate: 5000 } }).some((e) => e.path === '/voice/rate'));
  assert.ok(validateConfig({ ...defaultConfig(), voice: { engine: 'x' } }).some((e) => e.path === '/voice/engine' && e.msg === 'unknown key'));
  // Only the user may set the voice; a model actor (jarvis) is refused.
  assert.ok(policyCheck([{ op: 'add', path: '/voice/name', value: 'Daniel' }], 'jarvis').some((e) => /refused/.test(e.msg)));
  assert.deepEqual(policyCheck([{ op: 'add', path: '/voice/name', value: 'Daniel' }], 'user'), []);
});

test('migration v1 → v3 moves the key OUT of the config, converts alerts into rules and keeps unknown sections', () => {
  const v1 = { theme: 'ember', keys: { helius: 'hlx-secret-123' }, alerts: [{ kind: 'price', op: '>', value: 1, mint: 'So11111111111111111111111111111111111111112' }], custom: { a: 1 } };
  const m = migrate(v1);
  assert.equal(m.from, 1);
  assert.equal(m.to, CONFIG_VERSION);
  assert.deepEqual(m.errors, []);
  assert.deepEqual(m.extractedKeys, { helius: 'hlx-secret-123' });
  assert.ok(!JSON.stringify(m.config).includes('hlx-secret'), 'the migrated config never contains the key');
  assert.equal(m.config.theme?.name, 'ember');
  assert.equal(m.config.rules?.length, 1);
  assert.equal(m.config.rules?.[0].scope, 'mint:So11111111111111111111111111111111111111112');
  assert.deepEqual(m.config['x-unknown'], { custom: { a: 1 } });
  assert.ok(m.notes.some((n) => /moved 1 key/.test(n)));
  assert.throws(() => migrate({ version: 99 }), /newer than this trenchscope/);
});

test('workspace schema: popups are the host kinds only; unknown widgets and ../ paths are refused', () => {
  assert.deepEqual(validate('workspace', { name: 'x', popups: [{ kind: 'narrative' }], start: 'narrative' }), []);
  assert.ok(validate('workspace', { name: 'x', popups: [{ kind: 'shell' }] }).length);
  assert.ok(validateWorkspace({ name: 'x', screens: { screener: { kind: 'pane', widget: 'shell.exec' } } }).some((e) => /unknown widget/.test(e.msg)));
  assert.ok(validate('workspace', { name: '../etc' }).length);
  assert.ok(validate('workspace', { name: 'x', exec: 'rm' }).some((e) => e.msg === 'unknown key'));
});
