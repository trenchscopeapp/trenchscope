// Local-only high-risk follow-up draft pipeline (task-1433). The score is the H1 rug heuristic, not the LARP
// detector: no page, domain or repo is checked here, so nothing it prints may say "LARP" about a coin (larp-fixes).
// History mode reads the recorder
// without network access, scores only the point-in-time t0 row, joins only later outcome labels, and
// writes drafts/cards for human review. Live mode performs one read-only enrichment for one mint.
// Nothing here has X credentials, opens a composer, schedules work, trades, arms, signs or posts.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDataLayer, defaultDbPath, type EnrichedRow } from '@dexterm/data';
import { openHistoryReadOnly, exportRecorded, type ExportRecord, type ExportOutcome } from '@dexterm/recorder';
import { h1Model, rugFeaturesFromRecord, rugFeaturesFromToken } from '@dexterm/packs';
import { Canvas, THEMES } from '@dexterm/tui';
import { writeExport, fmtAge, type ExportView } from './export.ts';

export const LARP_DRAFT_MIN_SAMPLE = 50;
export const LARP_DRAFT_HORIZON = 259_200;
export const LARP_DRAFT_THRESHOLD = 0.5;

export interface LarpDraftIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
}

export interface FollowUp {
  mint: string;
  t0: number;
  score: number;
  model: string;
  outcome: ExportOutcome;
}

export interface FollowUpDataset {
  horizonSec: number;
  threshold: number;
  flagged: FollowUp[];
  collapsed: FollowUp[];
  didNotCollapse: number;
}

const isoMinute = (t: number): string => new Date(t).toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z');
const shortMint = (mint: string): string => `${mint.slice(0, 4)}...${mint.slice(-4)}`;
const pct = (n: number, d: number): string => `${d ? ((n / d) * 100).toFixed(1) : '0.0'}%`;

/** One point-in-time flag per mint: earliest flagged t0 with an observed outcome at this horizon. */
export function buildFollowUpDataset(records: readonly ExportRecord[], horizonSec = LARP_DRAFT_HORIZON, threshold = LARP_DRAFT_THRESHOLD): FollowUpDataset {
  const model = h1Model();
  const byMint = new Map<string, FollowUp>();
  for (const r of records) {
    const outcome = r.outcomes[`${horizonSec}`];
    if (!outcome || byMint.has(r.mint)) continue;
    const score = model.score(rugFeaturesFromRecord(r.features));
    if (score < threshold) continue;
    byMint.set(r.mint, { mint: r.mint, t0: r.t0, score, model: model.id, outcome });
  }
  const flagged = [...byMint.values()];
  const collapsed = flagged.filter((r) => r.outcome.positive);
  return { horizonSec, threshold, flagged, collapsed, didNotCollapse: flagged.length - collapsed.length };
}

function outcomeText(o: ExportOutcome): string {
  if (o.label === 'rug') return 'recorder label: liquidity-pull condition';
  if (o.label === 'dead') return 'recorder label: inactive at follow-up';
  return `recorder label: ${o.label}`;
}

function datasetLine(d: FollowUpDataset): string {
  return `Same-dataset follow-up: ${d.collapsed.length}/${d.flagged.length} met the condition (${pct(d.collapsed.length, d.flagged.length)}); ${d.didNotCollapse}/${d.flagged.length} did not.`;
}

export function cardCanvas(row: FollowUp, d: FollowUpDataset, now: number): Canvas {
  const c = new Canvas(92, 25, THEMES.cyberspace);
  const t = c.theme;
  c.fill(0, 0, c.w, c.h, ' ', { bg: t.bg });
  c.fill(0, 0, c.w, 3, ' ', { bg: t.headBg });
  c.text(3, 1, 'HIGH RISK · RECORDED FOLLOW-UP', { fg: t.warn, bg: t.headBg, b: true });
  c.textR(0, 1, c.w - 3, shortMint(row.mint), { fg: t.muted, bg: t.headBg });
  c.text(4, 5, 'AT THE RECORDED MOMENT', { fg: t.muted, b: true });
  c.text(4, 7, `HIGH RISK ${Math.round(row.score * 100)}/100`, { fg: t.down, b: true });
  c.text(4, 9, `${row.model} heuristic · model output · risk flag, not a certificate`, { fg: t.text });
  c.text(4, 10, `${isoMinute(row.t0)} · local recorder · t0 evidence age ${fmtAge((now - row.t0) / 1000)}`, { fg: t.muted });
  c.text(4, 13, 'LATER OBSERVED', { fg: t.muted, b: true });
  c.text(4, 15, outcomeText(row.outcome).toUpperCase(), { fg: t.warn, b: true });
  c.text(4, 17, `${fmtAge(d.horizonSec)} follow-up · ${row.outcome.tier} · labeler evidence`, { fg: t.text });
  c.text(4, 20, datasetLine(d), { fg: t.muted }, c.w - 8);
  c.text(4, 22, 'Sources: local trenchscope recorder · DexScreener + Jupiter · draft only', { fg: t.muted }, c.w - 8);
  c.text(4, 23, 'Not financial advice.', { fg: t.muted });
  return c;
}

export function historyDraft(row: FollowUp, d: FollowUpDataset, now: number): string {
  return [
    'HIGH RISK: recorded follow-up (rug heuristic, not a LARP check)',
    '',
    `Here is what the data showed: graded HIGH RISK ${Math.round(row.score * 100)}/100 at ${isoMinute(row.t0)} by ${row.model} (heuristic model output); ${outcomeText(row.outcome)} at the ${fmtAge(d.horizonSec)} follow-up.`,
    '',
    datasetLine(d),
    '',
    `Evidence: local trenchscope recorder; DexScreener + Jupiter; t0 data age ${fmtAge((now - row.t0) / 1000)} at export; ${row.outcome.tier}; coin ${shortMint(row.mint)}.`,
    '',
    'A risk flag is not a certificate. Draft only; a human decides whether to post. Not financial advice.',
  ].join('\n') + '\n';
}

export function renderHistoryDrafts(d: FollowUpDataset, opts: { outDir: string; now?: number; limit?: number; minSample?: number }): { drafts: string[]; cards: string[] } {
  const now = opts.now ?? Date.now();
  const min = opts.minSample ?? LARP_DRAFT_MIN_SAMPLE;
  if (d.flagged.length < min) return { drafts: [], cards: [] };
  mkdirSync(opts.outDir, { recursive: true, mode: 0o700 });
  const rows = [...d.collapsed].sort((a, b) => b.t0 - a.t0).slice(0, opts.limit ?? 3);
  const drafts: string[] = [], cards: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const stem = `${String(i + 1).padStart(2, '0')}-${row.mint.slice(0, 4)}-${row.mint.slice(-4)}`;
    const draft = join(opts.outDir, `${stem}.md`);
    writeFileSync(draft, historyDraft(row, d, now), { mode: 0o600 });
    drafts.push(draft);
    const view: ExportView = {
      kind: 'larp-detected', title: `RECORDED FOLLOW-UP · ${shortMint(row.mint)}`, label: 'replay', canvas: cardCanvas(row, d, now),
      ages: [
        { name: 't0 evidence', source: 'local recorder · DexScreener + Jupiter', ageSec: (now - row.t0) / 1000 },
        { name: 'follow-up', source: `${row.outcome.tier} recorder outcome`, ageSec: d.horizonSec },
      ],
      report: historyDraft(row, d, now).trimEnd().split('\n'),
    };
    const saved = writeExport(view, { dir: opts.outDir, now: now + i, subject: stem });
    cards.push(saved.png);
  }
  return { drafts, cards };
}

function parse(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value !== undefined && !value.startsWith('--')) { out[a.slice(2)] = value; i++; }
    else out[a.slice(2)] = true;
  }
  return out;
}

export const LARP_DETECTED_HELP = `trenchscope larp-detected: local high-risk draft/card pipeline; never posts or schedules

  trenchscope larp-detected --out DIR [--db PATH] [--horizon SEC] [--limit 3]
  trenchscope larp-detected --live MINT --out DIR

The grade is the H1 rug heuristic (a risk flag from market and holder data), not a LARP verdict: no website,
domain or repo is checked, so the cards say HIGH RISK, never LARP.

History mode is cron-ready and offline: it reads recorder t0 rows plus later labels, requires at least
${LARP_DRAFT_MIN_SAMPLE} unique flagged coins, and otherwise writes no drafts. Live mode performs one read-only
keyless lookup and writes a graded-now card. All output is for human review.`;

function liveFeatures(row: EnrichedRow) {
  return rugFeaturesFromToken({
    liquidity_usd: row.pair.liquidityUsd, mcap: row.mcap?.value ?? row.pair.mcap, age_sec: row.token.createdAt === null ? null : Math.max(0, (Date.now() - row.token.createdAt) / 1000),
    top10_pct: row.audit?.top10Pct ?? null, dev_pct: row.audit?.devPct ?? null, organic_score: row.stats?.organicScore ?? null,
    holder_count: row.stats?.holderCount ?? null, mint_authority: row.audit?.mintAuthority ?? null, freeze_authority: row.audit?.freezeAuthority ?? null,
  });
}

async function liveCard(mint: string, outDir: string, dbPath: string, io: LarpDraftIo): Promise<number> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) { io.stderr.write('trenchscope larp-detected: --live needs a Solana mint\n'); return 2; }
  const dl = createDataLayer({ dbPath });
  try {
    const result = await dl.store.enrich([mint]);
    const row = result.rows[0];
    if (!row) { io.stderr.write('trenchscope larp-detected: no current market record found for that mint\n'); return 2; }
    const now = Date.now(), model = h1Model(), score = model.score(liveFeatures(row));
    const c = new Canvas(92, 20, THEMES.cyberspace), t = c.theme;
    c.fill(0, 0, c.w, c.h, ' ', { bg: t.bg }); c.fill(0, 0, c.w, 3, ' ', { bg: t.headBg });
    c.text(3, 1, 'RUG RISK · GRADED NOW', { fg: t.warn, bg: t.headBg, b: true });
    c.textR(0, 1, c.w - 3, shortMint(mint), { fg: t.muted, bg: t.headBg });
    c.text(4, 6, `${score >= LARP_DRAFT_THRESHOLD ? 'HIGH RISK' : 'BELOW HIGH-RISK LINE'} ${Math.round(score * 100)}/100`, { fg: score >= LARP_DRAFT_THRESHOLD ? t.down : t.up, b: true });
    c.text(4, 9, `${model.id} heuristic · model output · risk flag, not a certificate`, { fg: t.text });
    c.text(4, 11, `${isoMinute(now)} · LIVE DATA · DexScreener + Jupiter`, { fg: t.muted });
    c.text(4, 14, 'No later outcome yet. No person, project or wallet is identified.', { fg: t.text });
    c.text(4, 17, 'Draft only · human review · not financial advice', { fg: t.muted });
    const view: ExportView = { kind: 'larp-now', title: `GRADED NOW · ${shortMint(mint)}`, label: 'live', canvas: c,
      ages: [{ name: 'market', source: 'DexScreener + Jupiter', ageSec: Math.max(0, (now - Math.max(row.token.fetchedAt, row.pair.fetchedAt)) / 1000) }],
      report: [`coin ${shortMint(mint)}`, `graded now ${Math.round(score * 100)}/100 · ${model.id} heuristic model output`, 'No later outcome yet. Risk flag, not a certificate. Draft only.'],
    };
    const saved = writeExport(view, { dir: outDir, now, subject: `${mint.slice(0, 4)}-${mint.slice(-4)}` });
    io.stdout.write(`graded-now card: ${saved.png}\n`); return 0;
  } finally { dl.close(); }
}

export async function larpDetectedCommand(argv: string[], io: LarpDraftIo): Promise<number> {
  const o = parse(argv);
  if (o.help || o.h) { io.stdout.write(LARP_DETECTED_HELP + '\n'); return 0; }
  const dbPath = typeof o.db === 'string' ? resolve(o.db) : (io.env.DEXTERM_DB_PATH || defaultDbPath(io.env));
  const outDir = typeof o.out === 'string' ? resolve(o.out) : resolve('marketing', 'larp-detected', new Date().toISOString().slice(0, 10));
  if (typeof o.live === 'string') return liveCard(o.live, outDir, dbPath, io);
  if (!existsSync(dbPath)) { io.stderr.write(`trenchscope larp-detected: no recorder history at ${dbPath}\n`); return 2; }
  const horizon = typeof o.horizon === 'string' ? Number(o.horizon) : LARP_DRAFT_HORIZON;
  if (!Number.isFinite(horizon) || horizon <= 0) { io.stderr.write('trenchscope larp-detected: --horizon must be positive seconds\n'); return 2; }
  const db = openHistoryReadOnly(dbPath);
  if (!db) { io.stderr.write('trenchscope larp-detected: recorder database could not be opened read-only\n'); return 2; }
  try {
    const dataset = buildFollowUpDataset(exportRecorded(db, { labelledOnly: true }).records, horizon);
    if (dataset.flagged.length < LARP_DRAFT_MIN_SAMPLE) {
      io.stdout.write(`thin sample: ${dataset.flagged.length} unique flagged coins (< ${LARP_DRAFT_MIN_SAMPLE}); wrote no drafts\n`);
      return 0;
    }
    const limit = typeof o.limit === 'string' ? Math.max(0, Math.floor(Number(o.limit))) : 3;
    const saved = renderHistoryDrafts(dataset, { outDir, limit: Number.isFinite(limit) ? limit : 3 });
    io.stdout.write(`${datasetLine(dataset)}\nwrote ${saved.drafts.length} draft(s) and ${saved.cards.length} card(s) to ${outDir}\n`);
    return 0;
  } finally { db.close(); }
}
