import { posixPermissions } from '../../../scripts/test-support.ts';
// task-1398 — ALERTS + RULES delivery. The four headline triggers (price level, holder-concentration change,
// LARP grade change, new-pair match) fire in a scripted replay and are PUSHED through the notifier; each
// delivery adapter (toast / desktop / telegram / discord) is exercised with a FAKE — no real network call to
// Telegram or Discord, no process spawned; credentials never appear in a result or a log; and a dedicated proof
// that a rule has no path to signing or arming. DEXTERM_HOME is a temp dir; fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdtempSync, writeFileSync, statSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RulesEngine, ruleToJson, parseExpr, FIELD_NAMES, saveConfig, defaultConfig, validateConfig, loadConfig,
  policyCheck, type RuleRow, type RuleJson,
} from '@dexterm/custom';
import { watchCommand, type WatchSnapshot, type WatchSource } from '../src/watch-cmd.ts';
import { larpGrade } from '../src/rules.ts';
import {
  createNotifier, routeChannels, redactCreds, alertToDelivery, proposalToDelivery, deliveryLine,
  writeTelegramCreds, readTelegramCreds, writeDiscordCreds, readDiscordCreds, telegramCredsPath,
  type AlertDelivery, type DeliveryAdapter,
} from '../src/alerts/index.ts';
import { createDesktopAdapter } from '../src/alerts/adapters/desktop.ts';
import { createTelegramAdapter, type FetchLike } from '../src/alerts/adapters/telegram.ts';
import { createDiscordAdapter } from '../src/alerts/adapters/discord.ts';
import { alertsCommand } from '../src/alerts-cmd.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dexterm-alerts-'));
function fakeIo(env: NodeJS.ProcessEnv = {}) {
  let out = ''; let err = '';
  const stdout = new Writable({ write(c, _e, cb) { out += c.toString(); cb(); } });
  const stderr = new Writable({ write(c, _e, cb) { err += c.toString(); cb(); } });
  return { io: { stdout, stderr, env }, out: () => out, err: () => err };
}

// Four valid base58 mints (43 chars), one per trigger, so rules scope cleanly.
const M_PRICE = 'So11111111111111111111111111111111111111112';
const M_HOLDER = 'So11111111111111111111111111111111111111113';
const M_LARP = 'So11111111111111111111111111111111111111114';
const M_NEWP = 'So11111111111111111111111111111111111111115';

/** A capturing adapter standing in for `toast`: records every delivery routed to it. */
function captureAdapter(): { adapter: DeliveryAdapter; seen: AlertDelivery[] } {
  const seen: AlertDelivery[] = [];
  return { seen, adapter: { name: 'toast', available: () => true, deliver: async (d) => { seen.push(d); return { ok: true }; } } };
}

/** A finite WatchSource over scripted snapshots (a replay). */
function scriptedSource(snaps: WatchSnapshot[]): WatchSource {
  let i = 0;
  return { next: async () => (i < snaps.length ? snaps[i++] : null) };
}

const row = (mint: string, over: Partial<RuleRow>): RuleRow =>
  ({ mint, symbol: mint.slice(0, 4), price: 1, liq: 1000, vol5m: 100, top10: 10, ageMin: 9999, larp: null, cluster: null, ...over });

test('the four trigger types fire in a scripted replay and are pushed through the notifier', async () => {
  const home = tmp();
  const rules: RuleJson[] = [
    ruleToJson(`when price >= 100 then alert(up, "price target") scope mint:${M_PRICE} name "price"`),
    ruleToJson(`when top10.delta >= 10 then alert(warn, "concentration climbing") scope mint:${M_HOLDER} name "holder"`),
    ruleToJson(`when larp.delta < 0 then alert(warn, "LARP downgrade") scope mint:${M_LARP} name "larp"`),
    ruleToJson(`when liq > 50K and vol5m > 25K then alert(up, "fresh pair") scope newpairs name "newpair"`),
  ];
  saveConfig(home, { ...defaultConfig(), rules });

  // Three ticks; each snapshot carries all four mints. price + newpair trip on tick 1; holder + larp need
  // a history (two priors) so they trip on tick 3 (delta).
  const snaps: WatchSnapshot[] = [0, 1000, 2000].map((t, k) => ({
    now: t,
    rows: [
      row(M_PRICE, { price: 150 }),
      row(M_HOLDER, { top10: k === 2 ? 35 : 20 }),
      row(M_LARP, { larp: k === 2 ? 0 : 2 }),
      row(M_NEWP, { ageMin: 10, liq: 60_000, vol5m: 30_000 }),
    ],
  }));

  const { adapter, seen } = captureAdapter();
  const notifier = createNotifier(undefined, { toast: adapter });
  const { io } = fakeIo({ DEXTERM_HOME: home });
  const code = await watchCommand([], io, { source: scriptedSource(snaps), notifier, now: () => 2000 });
  assert.equal(code, 0);

  const firedRules = new Set(seen.map((d) => d.rule));
  assert.deepEqual([...firedRules].sort(), ['holder', 'larp', 'newpair', 'price']);
  // Every delivery is an alert kind with a firewalled, non-empty body.
  for (const d of seen) { assert.equal(d.kind, 'alert'); assert.ok(d.body.length > 0); }
});

test('larp grade maps the verdicts and the engine exposes it as a field with .delta', () => {
  assert.equal(larpGrade('REAL_PRODUCT'), 3);
  assert.equal(larpGrade('EARLY_BUT_REAL'), 2);
  assert.equal(larpGrade('UNVERIFIABLE'), 1);
  assert.equal(larpGrade('NO_PRODUCT_CLAIMED'), 1, 'a no-product meme is never graded real');
  assert.equal(larpGrade('LARP'), 0);
  assert.equal(larpGrade('nonsense'), null);
  assert.equal(larpGrade(null), null);
  assert.ok(FIELD_NAMES.includes('larp'));
  assert.doesNotThrow(() => parseExpr('larp.delta < 0'));
  // a plain `larp <= 0` matches a LARP-graded row
  const e = new RulesEngine({ rules: [ruleToJson('when larp <= 0 then alert(warn, "larp") scope screener name "l"')] });
  e.observe([row('So11111111111111111111111111111111111111112', { larp: 0 })], 0);
  const res = e.evaluate([row('So11111111111111111111111111111111111111112', { larp: 0 })], 0);
  assert.equal(res.alerts.length, 1);
});

test('routing: toast is default-on, push channels default-off, levels filter, proposals gated', () => {
  assert.deepEqual(routeChannels(undefined, { kind: 'alert', level: 'info' }), ['toast']);
  const cfg = { channels: { desktop: { enabled: true }, telegram: { enabled: true, levels: ['warn' as const] } }, proposals: false };
  assert.deepEqual(routeChannels(cfg, { kind: 'alert', level: 'info' }), ['toast', 'desktop']); // telegram wants warn only
  assert.deepEqual(routeChannels(cfg, { kind: 'alert', level: 'warn' }), ['toast', 'desktop', 'telegram']);
  assert.deepEqual(routeChannels(cfg, { kind: 'proposal', level: 'info' }), []); // proposals off → nothing
  assert.deepEqual(routeChannels({ ...cfg, proposals: true }, { kind: 'proposal', level: 'info' }), ['toast', 'desktop']);
  // a channel can be explicitly turned off
  assert.deepEqual(routeChannels({ channels: { toast: { enabled: false } } }, { kind: 'alert', level: 'info' }), []);
});

test('desktop adapter builds a shell-free command per platform and escapes the AppleScript body', async () => {
  const d: AlertDelivery = { kind: 'alert', level: 'warn', title: 'WIF ⚑', body: 'say "hi" \\ now', spoken: 'x', symbol: 'WIF', mint: '', source: 'user', rule: 'r', at: 0 };
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const run = async (cmd: string, args: string[]): Promise<void> => { calls.push({ cmd, args }); };

  const mac = createDesktopAdapter({ platform: 'darwin', run });
  assert.equal(mac.available(), true);
  assert.deepEqual(await mac.deliver(d), { ok: true });
  assert.equal(calls[0].cmd, 'osascript');
  assert.equal(calls[0].args[0], '-e');
  assert.match(calls[0].args[1], /display notification/);
  assert.match(calls[0].args[1], /\\"hi\\"/);   // the quote was escaped
  assert.match(calls[0].args[1], /\\\\ now/);     // the backslash was escaped

  calls.length = 0;
  const linux = createDesktopAdapter({ platform: 'linux', run });
  assert.deepEqual(await linux.deliver(d), { ok: true });
  assert.equal(calls[0].cmd, 'notify-send');
  assert.ok(calls[0].args.includes('WIF ⚑')); // title + body are separate argv items (no shell)

  const win = createDesktopAdapter({ platform: 'win32', run });
  assert.equal(win.available(), false);
  const r = await win.deliver(d);
  assert.equal(r.ok, false);
  assert.ok(r.skipped);
});

test('telegram adapter posts via a fake fetch and never leaks the token', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const okFetch: FetchLike = async (url, init) => { calls.push({ url, body: init.body }); return { ok: true, status: 200, text: async () => '{"ok":true}' }; };
  const ad = createTelegramAdapter({ creds: { token: '123456:SECRET_TOKEN_ABCDEFGHIJKL', chatId: '42' }, fetch: okFetch });
  assert.equal(ad.available(), true);
  const d: AlertDelivery = { kind: 'alert', level: 'up', title: 'T ⚑', body: 'hello', spoken: 'x', symbol: 'T', mint: '', source: 'user', rule: 'r', at: 0 };
  assert.deepEqual(await ad.deliver(d), { ok: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.telegram\.org\/bot123456:SECRET_TOKEN_ABCDEFGHIJKL\/sendMessage/);
  const body = JSON.parse(calls[0].body) as { chat_id: string; text: string };
  assert.equal(body.chat_id, '42');
  assert.ok(body.text.includes('hello'));

  // a 401 surfaces the status + Telegram's description but NOT the token
  const failFetch: FetchLike = async () => ({ ok: false, status: 401, text: async () => '{"description":"Unauthorized"}' });
  const r = await createTelegramAdapter({ creds: { token: '123456:SECRET_TOKEN_ABCDEFGHIJKL', chatId: '42' }, fetch: failFetch }).deliver(d);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /telegram 401/);
  assert.ok(!r.reason!.includes('SECRET_TOKEN'));

  // unconfigured → skipped, never a crash
  const none = createTelegramAdapter({ creds: null });
  assert.equal(none.available(), false);
  assert.equal((await none.deliver(d)).skipped, true);
});

test('discord adapter posts to the webhook via a fake fetch and never leaks the URL', async () => {
  const webhook = 'https://discord.com/api/webhooks/1234567890/SECRET_WEBHOOK_TOKEN';
  const calls: Array<{ url: string; body: string }> = [];
  const okFetch: FetchLike = async (url, init) => { calls.push({ url, body: init.body }); return { ok: true, status: 204, text: async () => '' }; };
  const ad = createDiscordAdapter({ creds: { webhook }, fetch: okFetch });
  const d: AlertDelivery = { kind: 'alert', level: 'up', title: 'T ⚑', body: 'hi', spoken: 'x', symbol: 'T', mint: '', source: 'user', rule: 'r', at: 0 };
  assert.deepEqual(await ad.deliver(d), { ok: true });
  assert.equal(calls[0].url, webhook);
  assert.ok((JSON.parse(calls[0].body) as { content: string }).content.includes('hi'));

  const failFetch: FetchLike = async () => ({ ok: false, status: 404, text: async () => '' });
  const r = await createDiscordAdapter({ creds: { webhook }, fetch: failFetch }).deliver(d);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /discord 404/);
  assert.ok(!r.reason!.includes('SECRET_WEBHOOK_TOKEN'));

  const thrown: FetchLike = async () => { throw new Error(`connect ECONNREFUSED ${webhook}`); };
  const r2 = await createDiscordAdapter({ creds: { webhook }, fetch: thrown }).deliver(d);
  assert.equal(r2.reason, 'discord unreachable');
  assert.ok(!r2.reason!.includes('SECRET_WEBHOOK_TOKEN'));
});

test('redactCreds scrubs bot tokens and webhook URLs out of any string', () => {
  assert.equal(redactCreds('fail for bot 123456:ABCDEFGHIJKLMNOPQRSTUVWX now'), 'fail for bot bot[redacted] now');
  assert.match(redactCreds('posted to https://discord.com/api/webhooks/1/abcDEF today'), /\[redacted-webhook\]/);
  assert.ok(!redactCreds('https://discord.com/api/webhooks/1/abcDEF').includes('abcDEF'));
});

test('untrusted token text in an alert body is firewalled and the spoken form is say-safe', () => {
  const engine = new RulesEngine({ rules: [ruleToJson('when price > 1 then alert(up, "up") scope screener name "r"')] });
  const bad = row('So11111111111111111111111111111111111111112', { price: 5 });
  (bad as { symbol: string }).symbol = 'WIF‮[[slnc 9]]';
  engine.observe([bad], 0);
  const a = engine.evaluate([bad], 0).alerts[0];
  const d = alertToDelivery(a);
  // bidi override stripped, `[[` defused in the spoken form
  assert.ok(!d.title.includes('‮'));
  assert.ok(!d.spoken.includes('[['));
  assert.ok(d.body.length > 0);
});

test('SAFETY: a rule cannot sign or arm — the delivery layer is proposal-only and imports nothing that trades', () => {
  // (1) behavioural: a ticket action yields an INERT proposal; its delivery is a summary, carrying nothing that executes.
  const engine = new RulesEngine({ rules: [ruleToJson('when price > 1 then ticket(buy, 0.5, sol) scope screener name "t"')] });
  const r = row('So11111111111111111111111111111111111111112', { price: 5 });
  engine.observe([r], 0);
  const res = engine.evaluate([r], 0);
  assert.equal(res.proposals.length, 1);
  const p = res.proposals[0];
  assert.equal(p.status, 'proposal');
  assert.equal(p.requiresKeypress, true);
  assert.equal(p.armedBy, null);
  const d = proposalToDelivery(p);
  assert.equal(d.kind, 'proposal');
  assert.match(d.body, /confirm in the app|nothing armed/);
  // the delivery shape has no field that could arm/sign/execute
  assert.deepEqual(Object.keys(d).sort(), ['at', 'body', 'kind', 'level', 'mint', 'rule', 'source', 'spoken', 'symbol', 'title']);

  // (2) a money-shaped action arg is refused at parse (no way to smuggle arm/sign in)
  assert.throws(() => ruleToJson('when price > 1 then ticket(buy, 1, sol, arm=true) name "x"'), /arm/i);

  // (3) static: no module under alerts/ (nor watch-cmd) imports a trading/signing/wallet module.
  const forbidden = /(?:['"][^'"]*\b(?:trade|paper|executor|signer|wallet|mandate|bridge)\b)/;
  const files: string[] = [];
  const dir = join(import.meta.dirname, '../src/alerts');
  const walk = (d: string): void => { for (const f of readdirSync(d, { withFileTypes: true })) { if (f.isDirectory()) walk(join(d, f.name)); else if (f.name.endsWith('.ts')) files.push(join(d, f.name)); } };
  walk(dir);
  files.push(join(import.meta.dirname, '../src/watch-cmd.ts'));
  for (const f of files) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (/^\s*import\b|await import\(/.test(line)) assert.ok(!forbidden.test(line), `${f}: forbidden import — ${line.trim()}`);
    }
  }
});

test('config: an alerts section validates; a credential-shaped key is refused; /alerts is user-only', () => {
  const cfg = { ...defaultConfig(), alerts: { channels: { telegram: { enabled: true, chatId: '123', levels: ['warn' as const] }, desktop: { enabled: true } }, proposals: true } };
  assert.deepEqual(validateConfig(cfg), []);
  // no credential ever lives in config.json: a `token` key under a channel is an unknown key
  assert.ok(validateConfig({ ...defaultConfig(), alerts: { channels: { telegram: { enabled: true, token: 'x' } } } }).some((e) => e.msg === 'unknown key'));
  // a non-user actor may not touch /alerts (so a model can't redirect your alerts)
  assert.ok(policyCheck([{ op: 'replace', path: '/alerts/channels/telegram/enabled', value: true }], 'jarvis').some((e) => /only the user/.test(e.msg)));
  assert.equal(policyCheck([{ op: 'replace', path: '/alerts/channels/telegram/enabled', value: true }], 'user').length, 0);
});

test('creds are written 0600 to ~/.dexterm and never returned in cleartext anywhere printable', async (t) => {
  const home = tmp();
  writeTelegramCreds(home, { token: '99:TOKENVALUE1234567890AB', chatId: '-100123' });
  const read = readTelegramCreds(home);
  assert.deepEqual(read, { token: '99:TOKENVALUE1234567890AB', chatId: '-100123' });
  await posixPermissions(t, () => { assert.equal(statSync(telegramCredsPath(home)).mode & 0o777, 0o600); });
  writeDiscordCreds(home, { webhook: 'https://discord.com/api/webhooks/1/abcDEFghiJKL' });
  assert.ok(readDiscordCreds(home));
  // a bad chat id / webhook is refused
  assert.throws(() => writeTelegramCreds(home, { token: 't', chatId: 'notanumber' }), /chatId/);
  assert.throws(() => writeDiscordCreds(home, { webhook: 'https://evil.example/hook' }), /webhook/);
});

test('trenchscope alerts: enable a channel (user-journalled) and store a secret from the env without printing it', async () => {
  const home = tmp();
  const a = fakeIo({ DEXTERM_HOME: home });
  assert.equal(await alertsCommand(['enable', 'desktop'], a.io), 0);
  assert.equal(loadConfig(home).config.alerts?.channels?.desktop?.enabled, true);

  const b = fakeIo({ DEXTERM_HOME: home, DEXTERM_TELEGRAM_TOKEN: '77:MYSECRETTOKEN1234567890' });
  assert.equal(await alertsCommand(['set-telegram', '--chat', '555'], b.io), 0);
  assert.match(b.out(), /\(\d+ chars\)/);               // reports length only
  assert.ok(!b.out().includes('MYSECRETTOKEN'));        // never the value
  assert.deepEqual(readTelegramCreds(home), { token: '77:MYSECRETTOKEN1234567890', chatId: '555' });

  const s = fakeIo({ DEXTERM_HOME: home });
  assert.equal(await alertsCommand(['status'], s.io), 0);
  assert.match(s.out(), /telegram/);
  assert.ok(!s.out().includes('MYSECRETTOKEN'));
});

test('deliveryLine renders a one-liner a text channel can send', () => {
  const d: AlertDelivery = { kind: 'alert', level: 'up', title: 'WIF ⚑', body: 'price target: price >= 100 (150)', spoken: 'x', symbol: 'WIF', mint: '', source: 'user', rule: 'price', at: 0 };
  assert.equal(deliveryLine(d), 'WIF ⚑ price target: price >= 100 (150)');
});
