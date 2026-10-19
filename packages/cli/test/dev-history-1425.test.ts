// DEV HISTORY (task-1425) in the app: the per-mint book over the recorder DB, the token screen's DEV rows, linked
// wallets from a wallet-intel scan, the `devrugs` rule field (screener rows + new pairs from a wallet that rugged
// before), the new-pairs creator hook, and the pack flag fed by local history. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Recorder } from '@dexterm/recorder';
import { RulesEngine, parseRule, FIELD_NAMES } from '@dexterm/custom';
import { assembleTokenDossier } from '@dexterm/packs';
import { DevHistoryBook, devRows, linkedFrom, devBookOf } from '../src/live/dev-history.ts';
import { ruleRowsOf } from '../src/rules.ts';
import { NewPairsLive } from '../src/live/newpairs.ts';
import { makeFixtureState } from '../src/index.ts';

const DEV = 'DevW1111111111111111111111111111111111111111';
const PAL = 'PaLW1111111111111111111111111111111111111111';
const FUNDER = 'FundW111111111111111111111111111111111111111';
const MINT = 'MintJudged111111111111111111111111111111111';
const NEWMINT = 'MintNewPair11111111111111111111111111111111';
const m = (i: number): string => `Mint${'abcdefghijk'[i]}${'1'.repeat(40)}`.slice(0, 44);
const T0 = Date.now() - 10 * 86_400_000;

function seeded(): Recorder {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-devhist-')), 'h.db');
  const rec = new Recorder({ path: file });
  const out = rec.database.prepare("INSERT INTO outcomes (mint, t0, horizon_sec, t1, label, label_tier, evidence, labeler_version) VALUES (?, ?, 259200, ?, ?, 'keyless-proxy', '{}', '0.2.0')");
  const snap = rec.database.prepare("INSERT INTO token_snapshots (mint, t, kind, hash, src_market, sources, dev_pct) VALUES (?, ?, 'live', 'h', 'dexscreener', '[]', ?)");
  ['rug', 'rug', 'runner'].forEach((label, i) => {
    const t = T0 + i * 3_600_000;
    rec.recordCreator(m(i), DEV, 'jupiter-tokens', t, t);
    out.run(m(i), t, t + 259_200_000, label);
    snap.run(m(i), t, 6); snap.run(m(i), t + 20 * 60_000, 0); // the dev held 6 % and was out 20 min later
  });
  rec.recordCreator(m(5), PAL, 'pumpportal', T0, T0);
  out.run(m(5), T0, T0 + 259_200_000, 'rug');
  rec.recordCreator(MINT, DEV, 'jupiter-tokens', Date.now(), null);
  return rec;
}

test('DevHistoryBook: report + one-line summary from the recorder, cached; rugsFor feeds the rule field', () => {
  const rec = seeded();
  let now = Date.now();
  const book = new DevHistoryBook(() => rec.database, () => now);
  const e = book.forMint(MINT);
  assert.equal(e.creator?.creator, DEV);
  assert.equal(e.report?.labelled.rug, 2);
  assert.match(e.line, /^rugged 2 of 3 labelled prior launches/);
  assert.equal(book.rugsFor(MINT), 2);
  assert.equal(book.forMint(MINT), e, 'cached within the TTL');
  now += 61_000;
  assert.notEqual(book.forMint(MINT), e, 'refreshed after the TTL');
  assert.equal(book.rugsFor('MintNobody1111111111111111111111111111111111'.slice(0, 43)), null, 'unknown creator = null, never 0');
});

test('no recorder = unknown with the reason; a Jupiter-named dev the recorder has not linked still gets a report', () => {
  const none = new DevHistoryBook(() => null).forMint(MINT);
  assert.match(none.line, /recorder is off/);
  const rec = seeded();
  const hinted = new DevHistoryBook(() => rec.database).forMint('MintHinted11111111111111111111111111111111', DEV);
  assert.equal(hinted.creator?.source, 'jupiter-tokens');
  assert.equal(hinted.report?.labelled.rug, 2);
});

test('DEV rows: every value carries the sample (n=) or says unknown; levels follow the record', () => {
  const rec = seeded();
  const rows = devRows(new DevHistoryBook(() => rec.database).forMint(MINT));
  assert.deepEqual(rows[0], ['Dev rugs (recorded)', '2/3 · n=3', 'bad'], 'two labelled rugs = serial rugger = bad');
  assert.equal(rows[1][0], 'Dev launches seen');
  assert.match(rows[1][1], /^3 prior/);
  assert.deepEqual(rows[2], ['Dev sold its bag', 'median 20m · n=3', 'warn']);
  const unknown = devRows(new DevHistoryBook(() => rec.database).forMint('MintNobody111111111111111111111111111111111'));
  assert.deepEqual(unknown[0], ['Dev rugs (recorded)', 'unknown', 'na']);
});

test('linked wallets from the wallet-intel scan: funder, cluster, and the cluster mates that rugged', () => {
  const rec = seeded();
  const analysis = {
    mint: MINT, holders: [{ owner: DEV, funder: { address: FUNDER, label: null, blockTime: null, sig: null } }],
    clusters: [{ name: 'C1', kind: 'funder', members: [DEV, PAL, 'Some1111111111111111111111111111111111111111'], pct: 12.5, labels: [], evidence: [] }],
    funding: {}, insights: {}, buyEvents: [],
  } as never;
  const l = linkedFrom(analysis, DEV, rec.database);
  assert.equal(l.fundedBy, FUNDER);
  assert.deepEqual(l.cluster, { name: 'C1', kind: 'funder', members: 3, pct: 12.5 });
  assert.equal(l.linkedCreators, 1, 'PAL launched coins too');
  assert.equal(l.linkedRugs, 1);
  const rows = devRows(new DevHistoryBook(() => rec.database).forMint(MINT, null, analysis));
  assert.deepEqual(rows.at(-1), ['Dev linked', 'funder 3w · 1 devs 1 rugs', 'bad']);
});

test('rule field devrugs: parses, and fires for a screener row and a brand-new pair from a wallet that rugged before', () => {
  assert.ok(FIELD_NAMES.includes('devrugs'));
  const rec = seeded();
  const state = makeFixtureState({ screen: 'screener' }) as never as Parameters<typeof ruleRowsOf>[0];
  // a minimal live context: the recorder DB + one new pair whose creator is DEV
  rec.recordCreator(NEWMINT, DEV, 'pumpportal', Date.now(), Date.now());
  const np = { rows: new Map([[NEWMINT, { mint: NEWMINT, symbol: 'NEW', creator: DEV, createdAt: Date.now() - 60_000, mcap: 5000, liq: null, holders: null, launchpad: 'pump.fun', bonding: 3 }]]) };
  (state as { live: unknown }).live = { recorder: { database: rec.database }, newpairs: np, intel: { entry: () => null }, token: null, signals: null };
  (state as { screener: { rows: unknown[] } }).screener.rows = [{ mint: MINT, symbol: 'JDG', mcap: 1e6 }];
  const rows = ruleRowsOf(state);
  assert.equal(rows.find((r) => r.mint === MINT)?.devRugs, 2);
  const fresh = rows.find((r) => r.mint === NEWMINT);
  assert.ok(fresh, 'the new pair joined the rule rows because its creator has a record');
  assert.equal(fresh!.devRugs, 2);
  assert.ok(fresh!.ageMin! <= 2);
  parseRule('when devrugs >= 2 then alert(warn, "x") scope newpairs'); // the grammar accepts the field
  const engine = new RulesEngine({ rules: ['when devrugs >= 2 then alert(warn, "new coin from a wallet that rugged before") scope newpairs name "serial dev"'] });
  engine.observe(rows, Date.now());
  const res = engine.evaluate(rows, Date.now());
  const fired = res.alerts.filter((e) => e.mint === NEWMINT);
  assert.ok(fired.length >= 1, 'alert fired for the new pair');
  // unknown creators never join: a pair with no record stays out of the rule rows
  np.rows.set('MintUnknown1111111111111111111111111111111', { mint: 'MintUnknown1111111111111111111111111111111', symbol: 'U', creator: 'Nobody111111111111111111111111111111111111', createdAt: Date.now(), mcap: 1, liq: null, holders: null, launchpad: 'pump.fun', bonding: 1 });
  assert.equal(ruleRowsOf(state).some((r) => r.mint === 'MintUnknown1111111111111111111111111111111'), false);
});

test('devBookOf: none without a live recorder (fixtures / --no-recorder), one shared book with it', () => {
  assert.equal(devBookOf({}), null);
  const rec = seeded();
  const s = { live: { recorder: { database: rec.database } } } as never as Parameters<typeof devBookOf>[0];
  const b = devBookOf(s);
  assert.ok(b);
  assert.equal(devBookOf(s), b);
});

test('NewPairsLive.onCreator reports a PumpPortal create\'s creator once', () => {
  const np = new NewPairsLive({ jupiter: {}, dexscreener: {}, rugcheck: {} } as never, { polls: { recent: false, newTokens: false, enrich: false } });
  const seen: string[] = [];
  np.onCreator = (mint, creator, source) => seen.push(`${mint}:${creator}:${source}`);
  const create = { kind: 'create', create: { mint: NEWMINT, symbol: 'NEW', name: 'New', creator: DEV, launchpad: 'pump.fun', initialBuySol: 1, vSol: 30, vToken: 1e9, marketCapSol: 30, uri: '', signature: 's', bondingPct: 1, receivedAt: Date.now() } };
  np.handleEvent(create as never);
  np.handleEvent(create as never);
  assert.deepEqual(seen, [`${NEWMINT}:${DEV}:pumpportal`]);
});

test('the token-dossier pack flags serial_rugger from local-history prior rugs (get_dev_history tier local-history)', () => {
  const base = { mint: MINT, market: { token: { mint: MINT, symbol: 'JDG', createdAt: Date.now() - 86_400_000 }, pair: { priceUsd: 1, liquidityUsd: 50_000 } }, creator: { tier: 'local-history', devHistory: { launches: 3, rugged: 2, bestAth: null } } };
  const a = assembleTokenDossier(base as never) as { flags: string[] };
  assert.ok(a.flags.includes('serial_rugger'));
  const b = assembleTokenDossier({ ...base, creator: { tier: 'needs-key', devHistory: null } } as never) as { flags: string[] };
  assert.ok(!b.flags.includes('serial_rugger'), 'no record, no flag');
});
