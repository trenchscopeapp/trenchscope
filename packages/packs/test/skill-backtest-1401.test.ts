// task-1401 skill backtest: the links-only LARP baseline, the rug-check rules, per-grade precision/recall, the
// train-only tuning guard, and the committed eval set + report staying consistent with the shipped rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  linkFeatures, linkSignals, gradeLinks, primaryLinks, LINK_RUBRIC_V0, LINK_RUBRIC_V1, DEFAULT_LINK_RUBRIC, LINK_RUBRIC_MEASURED,
  type LinkFeatures,
} from '@dexterm/data';
import {
  gradeRugRules, splitMetrics, tuneLinkRubric, tuneRugRules, skillBacktest, renderSkillBacktestText, runLarpSubject,
  RUG_RULES_V0, RUG_RULES_V1, LARP_GRADE_CLAIMS, LARP_GRADE_ORDER, SKILL_MIN_N, SKILL_EVAL_SCHEMA,
  type SkillEvalRow, type SkillEvalSet, type RugRuleFeatures, type SkillBacktestReport,
} from '../src/index.ts';

const EVAL = fileURLToPath(new URL('../eval/skills-eval.json', import.meta.url));
const REPORT = fileURLToPath(new URL('../eval/skills-backtest.json', import.meta.url));

test('linkFeatures: classifies the website, the X link and the domain match without keeping any URL', () => {
  const f = linkFeatures({ web: 'https://www.wifcoin.xyz/', x: 'https://x.com/wifcoin', tg: 'https://t.me/wif', symbol: '$WIF', name: 'dogwifcoin' });
  assert.deepEqual(f, { web: 'own-domain', x: 'profile', tg: true, webMatchesToken: true, cheapTld: true });
  assert.equal(linkFeatures({ web: 'https://x.com/someone/status/123' }).web, 'social');
  assert.equal(linkFeatures({ web: 'https://pump.fun/coin/abc' }).web, 'launchpad');
  assert.equal(linkFeatures({ web: 'https://linktr.ee/abc' }).web, 'linktree');
  assert.equal(linkFeatures({ web: 'https://my-coin.vercel.app' }).web, 'free-host');
  assert.equal(linkFeatures({ web: 'javascript:alert(1)' }).web, 'invalid');
  assert.equal(linkFeatures({ web: null }).web, 'none');
  assert.equal(linkFeatures({ x: 'https://x.com/i/communities/1234' }).x, 'community');
  assert.equal(linkFeatures({ x: 'https://twitter.com/abc/status/99' }).x, 'status');
  assert.equal(linkFeatures({ x: 'https://x.com/search?q=abc' }).x, 'other');
  assert.equal(linkFeatures({ web: 'https://example.org', symbol: 'ZZZ', name: 'Quux' }).webMatchesToken, false);
  assert.equal(linkFeatures({ web: 'https://example.org' }).webMatchesToken, null, 'no symbol/name → unknown, not a mismatch');
  assert.equal(linkFeatures({ web: 'https://example.org' }).cheapTld, false);
});

test('primaryLinks: the store merge order (Jupiter first, then DexScreener first website / X / Telegram)', () => {
  const ds = { info: { websites: [{ url: 'https://a.example' }, { url: 'https://b.example' }], socials: [{ type: 'telegram', url: 'https://t.me/a' }, { type: 'twitter', url: 'https://x.com/a' }] } };
  assert.deepEqual(primaryLinks({ dexscreener: ds }), { web: 'https://a.example', x: 'https://x.com/a', tg: 'https://t.me/a' });
  assert.deepEqual(primaryLinks({ dexscreener: ds, jupiter: { website: 'https://j.example', twitter: null, telegram: null } }), { web: 'https://j.example', x: 'https://x.com/a', tg: 'https://t.me/a' });
});

test('gradeLinks: no website is always UNVERIFIABLE; never REAL_PRODUCT; the score is the weighted signal sum', () => {
  const none: LinkFeatures = { web: 'none', x: 'none', tg: false, webMatchesToken: null, cheapTld: null };
  for (const r of [LINK_RUBRIC_V0, LINK_RUBRIC_V1]) assert.equal(gradeLinks(none, r).grade, 'UNVERIFIABLE');
  const shady: LinkFeatures = { web: 'own-domain', x: 'status', tg: false, webMatchesToken: false, cheapTld: true };
  assert.deepEqual(linkSignals(shady), ['site_no_name_match', 'cheap_tld', 'x_not_profile', 'no_tg']);
  const g = gradeLinks(shady, LINK_RUBRIC_V1);
  assert.equal(g.score, 1 + 1 + 2 + 1);
  assert.equal(g.grade, 'LARP');
  const clean: LinkFeatures = { web: 'own-domain', x: 'profile', tg: true, webMatchesToken: true, cheapTld: false };
  assert.equal(gradeLinks(clean, LINK_RUBRIC_V1).grade, 'EARLY_BUT_REAL');
  assert.equal(DEFAULT_LINK_RUBRIC, LINK_RUBRIC_V1);
});

const rf = (o: Partial<RugRuleFeatures> = {}): RugRuleFeatures => ({ freeze_auth: false, mint_auth: false, dev_pct: 1, top10_pct: 20, organic_score: 60, liquidity_usd: 20_000, price_usd: 0.001, lp_locked_pct: null, launchpad: 'pump.fun', age_sec: 3600, ...o });

test('gradeRugRules: AVOID disqualifiers are fixed, INSUFFICIENT only without price and liquidity, v1 = low liquidity', () => {
  assert.equal(gradeRugRules(rf({ freeze_auth: true }), RUG_RULES_V1).grade, 'AVOID');
  assert.equal(gradeRugRules(rf({ mint_auth: true }), RUG_RULES_V0).grade, 'AVOID');
  assert.equal(gradeRugRules(rf({ lp_locked_pct: 0, launchpad: 'raydium', top10_pct: 60 })).grade, 'AVOID');
  assert.equal(gradeRugRules(rf({ price_usd: null, liquidity_usd: null })).grade, 'INSUFFICIENT_DATA');
  assert.equal(gradeRugRules(rf({ liquidity_usd: 4_000 }), RUG_RULES_V1).grade, 'SPECULATIVE');
  assert.equal(gradeRugRules(rf({ dev_pct: 25 }), RUG_RULES_V1).grade, 'WATCH', 'v1 no longer sets SPECULATIVE on dev %');
  assert.equal(gradeRugRules(rf({ dev_pct: 25 }), RUG_RULES_V0).grade, 'SPECULATIVE', 'v0 did');
  assert.equal(gradeRugRules(rf({ organic_score: 10 }), RUG_RULES_V0).grade, 'SPECULATIVE');
});

test('splitMetrics: per-grade precision/recall with Wilson intervals; counts only under SKILL_MIN_N', () => {
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => ({ grade: 'LARP', bad: i < 18 })),
    ...Array.from({ length: 40 }, (_, i) => ({ grade: 'EARLY_BUT_REAL', bad: i < 4 })),
    ...Array.from({ length: 5 }, () => ({ grade: 'UNVERIFIABLE', bad: true })),
  ];
  const m = splitMetrics(rows, LARP_GRADE_CLAIMS, LARP_GRADE_ORDER);
  const larp = m.by_grade.find((g) => g.grade === 'LARP')!;
  assert.equal(larp.precision!.value, 18 / 30);
  assert.equal(larp.recall!.value, 18 / 27, 'recall = LARP-caught bad / all bad');
  assert.ok(larp.precision!.lo < 0.6 && larp.precision!.hi > 0.6);
  const ebr = m.by_grade.find((g) => g.grade === 'EARLY_BUT_REAL')!;
  assert.equal(ebr.precision!.value, 36 / 40, 'a clean grade is right when the coin did NOT go bad');
  assert.equal(ebr.recall!.value, 36 / 48);
  const unv = m.by_grade.find((g) => g.grade === 'UNVERIFIABLE')!;
  assert.equal(unv.precision, null); assert.equal(unv.bad_rate, null, `n=5 < ${SKILL_MIN_N}: counts only`);
  assert.deepEqual({ tp: m.binary.tp, fp: m.binary.fp, fn: m.binary.fn, tn: m.binary.tn }, { tp: 18, fp: 12, fn: 9, tn: 36 });
});

function row(i: number, split: 'train' | 'test', link: Partial<LinkFeatures>, bad: boolean, rug: Partial<RugRuleFeatures> = {}): SkillEvalRow {
  return { mint: `M${i}`, t0: i, split, outcome: bad ? 'dead' : 'flat', bad, link: { web: 'own-domain', x: 'profile', tg: true, webMatchesToken: true, cheapTld: false, ...link }, link_sources: ['dexscreener'], link_lag_sec: 10, rug: rf(rug) };
}

test('tuning refuses any TEST row (no tuning on the held-out split)', () => {
  const rows = [row(1, 'train', {}, false), row(2, 'test', {}, true)];
  assert.throws(() => tuneLinkRubric(rows), /tuning refused: .* test split/);
  assert.throws(() => tuneRugRules(rows), /tuning refused/);
});

test('tuneLinkRubric / tuneRugRules find a planted signal on synthetic train rows', () => {
  const rows: SkillEvalRow[] = [];
  for (let i = 0; i < 60; i++) rows.push(row(i, 'train', { x: 'status' }, i % 6 !== 0, { liquidity_usd: 1_000 }));
  for (let i = 60; i < 160; i++) rows.push(row(i, 'train', {}, i % 10 === 0));
  const l = tuneLinkRubric(rows);
  assert.ok(l.rubric.weights.x_not_profile > 0, 'the planted X-status signal carries weight');
  assert.ok((l.train_mcc ?? 0) > 0.5);
  const r = tuneRugRules(rows);
  assert.ok(r.rules.liq_below !== null && r.rules.liq_below > 1_000, 'the planted low-liquidity signal is found');
});

test('committed eval set: schema, time split, no URLs/names, and the train/test cutoff is respected', () => {
  const raw = readFileSync(EVAL, 'utf8');
  const set = JSON.parse(raw) as SkillEvalSet;
  assert.equal(set.schema, SKILL_EVAL_SCHEMA);
  assert.equal(set.rows.length, set.counts.rows);
  assert.doesNotMatch(raw, /https?:|\.com\b|"symbol"|"name"/, 'no URL, symbol or name is stored');
  for (const r of set.rows) assert.equal(r.split, r.t0 >= set.cutoff_t0 ? 'test' : 'train');
  assert.equal(new Set(set.rows.map((r) => r.mint)).size, set.rows.length, 'one row per coin');
});

test('committed report = the shipped rules on the committed set; re-tuning on train reproduces v1; measured constants match', () => {
  const set = JSON.parse(readFileSync(EVAL, 'utf8')) as SkillEvalSet;
  const committed = JSON.parse(readFileSync(REPORT, 'utf8')) as SkillBacktestReport;
  const train = set.rows.filter((r) => r.split === 'train');
  const l = tuneLinkRubric(train); const r = tuneRugRules(train);
  assert.deepEqual(l.rubric.weights, LINK_RUBRIC_V1.weights); assert.equal(l.rubric.threshold, LINK_RUBRIC_V1.threshold);
  for (const k of ['dev_pct_over', 'organic_below', 'top10_over', 'liq_below'] as const) assert.equal(r.rules[k], RUG_RULES_V1[k], k);
  const fresh = skillBacktest(set, { larpBefore: LINK_RUBRIC_V0, larpAfter: LINK_RUBRIC_V1, rugBefore: RUG_RULES_V0, rugAfter: RUG_RULES_V1 });
  assert.deepEqual(fresh.larp.after.test, committed.larp.after.test);
  assert.deepEqual(fresh.larp.before.test, committed.larp.before.test);
  assert.deepEqual(fresh.rug.after.test, committed.rug.after.test);
  assert.deepEqual(fresh.rug.before.test, committed.rug.before.test);
  const t = runLarpSubject(set, LINK_RUBRIC_V1).test;
  assert.equal(LINK_RUBRIC_MEASURED.test.n, t.n); assert.equal(LINK_RUBRIC_MEASURED.test.bad, t.bad);
  for (const g of t.by_grade) assert.deepEqual(LINK_RUBRIC_MEASURED.test.by_grade[g.grade as 'LARP'], { n: g.n, bad: g.bad }, g.grade);
  const text = renderSkillBacktestText(fresh);
  assert.match(text, /not measured:/); assert.match(text, /a risk flag, not a certificate/);
});
