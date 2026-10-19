// DEV HISTORY (task-1425): the read-only `dev_history` MCP tool and the local-history fill of get_dev_history,
// over a seeded recorder DB and a stub data layer. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Recorder } from '@dexterm/recorder';
import { McpTools, TOOLS, READ_ONLY_TOOLS } from '../src/index.ts';

const DEV = 'DevW1111111111111111111111111111111111111111';
const MINT = 'MintJudged111111111111111111111111111111111';
const m = (i: number): string => `Mint${'abcdefghijk'[i]}${'1'.repeat(40)}`.slice(0, 44);
const T0 = Date.now() - 10 * 86_400_000;

function seededDb(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-devhist-')), 'h.db');
  const rec = new Recorder({ path: file });
  const out = rec.database.prepare("INSERT INTO outcomes (mint, t0, horizon_sec, t1, label, label_tier, evidence, labeler_version) VALUES (?, ?, 259200, ?, ?, 'keyless-proxy', '{}', '0.2.0')");
  ['rug', 'rug', 'flat'].forEach((label, i) => {
    const t = T0 + i * 3_600_000;
    rec.recordCreator(m(i), DEV, 'jupiter-tokens', t, t);
    out.run(m(i), t, t + 259_200_000, label);
  });
  rec.recordCreator(MINT, DEV, 'pumpportal', Date.now() - 60_000, null);
  rec.close();
  return file;
}

function stubData(creators: string[] = [], dev: string | null = null) {
  const ok = <T>(value: T) => ({ value, fetchedAt: Date.now(), stale: false });
  return {
    store: { enrich: async () => ({ rows: [{ mint: MINT, token: { symbol: 'X', name: 'X', mint: MINT }, pair: { fetchedAt: Date.now() }, audit: { devAddress: dev, fetchedAt: Date.now() }, sources: [], stale: false }], errors: {} }) },
    detail: {
      security: async () => ok({ creators }),
      mintInfo: async () => ok({ mintAuthority: null, freezeAuthority: null }),
    },
    jupiter: { search: async () => [] },
  } as never;
}

test('dev_history is advertised and read-only (never an action tool), so every analyst engine gets it', () => {
  assert.ok(TOOLS.some((t) => t.name === 'dev_history'));
  assert.ok(READ_ONLY_TOOLS.includes('dev_history'));
});

test('dev_history by mint: creator from the recorder link, counts with sample + age, serial_rugger, disclaimer', async () => {
  const tools = new McpTools(stubData(), () => ({ screen: 'token' }), null, seededDb());
  const r = await tools.call('dev_history', { mint: MINT }) as Record<string, any>;
  assert.equal(r.creator, DEV);
  assert.match(r.creatorSource, /^recorder \(pumpportal/);
  assert.equal(r.status, 'ok');
  assert.equal(r.launches.n, 3);
  assert.deepEqual([r.labelled.n, r.labelled.rug, r.labelled.flat], [3, 2, 1]);
  assert.equal(r.serialRugger, true);
  assert.match(r.summary, /^rugged 2 of 3 labelled prior launches/);
  assert.match(r.disclaimer, /not a certificate/);
  assert.equal(typeof r.labelled.ageSec, 'number');
});

test('dev_history falls back to Jupiter dev, then GoPlus; no source = unknown; no DB = unknown with why', async () => {
  const db = seededDb();
  const other = 'MintXther1111111111111111111111111111111111'; // base58 (no O)
  const viaJup = await new McpTools(stubData([], DEV), () => ({}), null, db).call('dev_history', { mint: other }) as Record<string, any>;
  assert.equal(viaJup.creatorSource, 'jupiter-tokens dev');
  assert.equal(viaJup.labelled.rug, 2);
  const viaGoplus = await new McpTools(stubData([DEV]), () => ({}), null, db).call('dev_history', { mint: other }) as Record<string, any>;
  assert.equal(viaGoplus.creatorSource, 'goplus creators');
  const none = await new McpTools(stubData(), () => ({}), null, db).call('dev_history', { mint: other }) as Record<string, any>;
  assert.equal(none.status, 'unknown'); assert.equal(none.creator, null);
  const noDb = await new McpTools(stubData(), () => ({}), null, null).call('dev_history', { creator: DEV }) as Record<string, any>;
  assert.equal(noDb.status, 'unknown'); assert.match(noDb.note, /no recorded history/);
  const bad = await new McpTools(stubData(), () => ({}), null, db).call('dev_history', { mint: 'not a mint' }) as Record<string, any>;
  assert.match(bad.error, /base58/);
  assert.match((await new McpTools(stubData(), () => ({}), null, db).call('dev_history', {}) as Record<string, any>).error, /needs a mint or a creator/);
});

test('get_dev_history fills prior launches/rugs from local history (tier local-history), so analyze_token can flag serial_rugger', async () => {
  const tools = new McpTools(stubData(), () => ({}), null, seededDb());
  const r = await tools.call('get_dev_history', { mint: MINT }) as Record<string, any>;
  assert.equal(r.tier, 'local-history');
  assert.equal(r.devHistory.rugged, 2);
  assert.equal(r.devHistory.launches, 3);
  assert.equal(r.creator, DEV);
  const keyless = await new McpTools(stubData(), () => ({}), null, null).call('get_dev_history', { mint: MINT }) as Record<string, any>;
  assert.equal(keyless.tier, 'needs-key');
  assert.equal(keyless.devHistory, null);
});
