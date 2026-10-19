// measure-analyst.mjs — wall-clock timing of one analyst turn (task-1314).
//   node packages/cli/tools/measure-analyst.mjs <skill> <mint> [model]
// Spawns the real `claude -p` with the dexterm MCP server and reports: time to first streamed token,
// total duration, tool-call count (should be ~1 get_dossier now), the verdict, confidence, missing_data
// and cost. Uses ONE claude session per run. Needs `claude login` already done.

import { createDataLayer, defaultDbPath } from '@dexterm/data';
import { runAnalyst } from '../src/analyst/backend.ts';
import { TokenLive } from '../src/live/index.ts';

const skill = process.argv[2] ?? 'token-dossier';
const mint = process.argv[3] ?? 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK
const model = process.argv[4] || undefined;
const warm = process.argv.includes('--warm');

// Simulate "the token screen was open": warm the shared on-disk cache the MCP server now reads.
if (warm) {
  const dbPath = defaultDbPath(process.env);
  process.env.DEXTERM_DB_PATH = dbPath;
  const dl = createDataLayer({ dbPath, rpcPublicPool: true });
  const live = new TokenLive(dl, { mint, symbol: '?', name: '?', launchpad: 'unknown' }, {});
  const tw = Date.now();
  await live.load();
  await live.prefetchAdjacent();
  console.log(`warmed shared cache in ${((Date.now() - tw) / 1000).toFixed(1)}s (candles=${live.view.candles.length})`);
  dl.close();
}

const prompt = `/dexterm:${skill} ${mint}`.trim();
const schema = skill === 'trench-scan' ? 'trench-scan.schema.json' : 'verdict.schema.json';
const screenState = { screen: 'token', mint, selected: mint };

const t0 = Date.now();
let firstTokenMs = null;
let firstToolMs = null;
const tools = [];

console.log(`run: ${skill} ${mint}${model ? ' model=' + model : ' (cli default model)'}`);

runAnalyst(
  { prompt, schema, screenState, model, budgetUsd: 1.0 },
  {
    onInit: (info) => console.log(`  init: model=${info.model} skills=[${info.skills.join(',')}] mcp=[${info.mcp.join(',')}]`),
    onToolCall: (ev) => { if (firstToolMs === null) firstToolMs = Date.now() - t0; tools.push(ev.name); process.stdout.write(`  tool @${((Date.now() - t0) / 1000).toFixed(1)}s: ${ev.name}\n`); },
    onText: () => { if (firstTokenMs === null) { firstTokenMs = Date.now() - t0; process.stdout.write(`  first token @${(firstTokenMs / 1000).toFixed(1)}s\n`); } },
    onResult: (ev) => {
      const total = Date.now() - t0;
      const s = ev.structured ?? {};
      console.log('\nRESULT');
      console.log(`  first token : ${firstTokenMs === null ? 'n/a' : (firstTokenMs / 1000).toFixed(1) + 's'}`);
      console.log(`  first tool  : ${firstToolMs === null ? 'n/a' : (firstToolMs / 1000).toFixed(1) + 's'}`);
      console.log(`  total       : ${(total / 1000).toFixed(1)}s`);
      console.log(`  tool calls  : ${tools.length} [${tools.join(', ')}]`);
      console.log(`  verdict     : ${s.verdict ?? '—'}  confidence=${s.confidence ?? '—'}  rug_prob=${s.rug_probability ?? '—'}`);
      console.log(`  missing_data: ${JSON.stringify(s.missing_data ?? null)}`);
      console.log(`  cost        : ${ev.costUsd !== null ? '$' + ev.costUsd.toFixed(3) : '—'}  model=${ev.model ?? '—'}  turns=${ev.turns ?? '—'}`);
      process.exit(0);
    },
    onError: (message, detail) => { console.error(`  ERROR: ${message} — ${detail ?? ''}`); process.exit(2); },
  },
);

setTimeout(() => { console.error('timeout 120s'); process.exit(3); }, 120000);
