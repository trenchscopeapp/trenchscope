// analyst-1323-ab.mjs — task-1323 before/after capture for the analyst's chat answers.
//   node packages/cli/test/measure/analyst-1323-ab.mjs <label> <out.json> [questionIndex…]
// Builds the real screener screen state from the replay fixture (packages/data/fixtures/live-sample.json),
// hovers a real on-screen coin (CRAWL, a pump.fun mint), then asks each question through the SAME path the
// app's chat box uses (main.ts sendChat → AnalystSession.ask → runAnalyst with no schema, the CONTEXT block,
// a fresh session). The displayed answer is accumulated from onText exactly like AnalystSession does, and
// "lines" uses the session's own rule (split on \n, trim, drop blanks). Needs `claude login`. No keys printed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildScreenState } from '../../src/main.ts';
import { makeFeedState } from '../../src/state.ts';
import { createReplayFeed } from '../../src/feed.ts';
import { LiveContext } from '../../src/live/index.ts';
import { runAnalyst } from '../../src/analyst/backend.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(HERE, '..', '..', '..', 'data', 'fixtures', 'live-sample.json');

export const QUESTIONS = [
  'should I buy this?',
  "where's my stop?",
  'is this a rug?',
  'size for a $200 account?',
  'what do you think of this coin?',
  'give me the full breakdown on this coin',
];

const label = process.argv[2] ?? 'run';
const out = process.argv[3] ?? `/tmp/analyst-1323-${label}.json`;
const pick = process.argv.slice(4).map(Number).filter((n) => Number.isInteger(n));
const which = pick.length ? pick : QUESTIONS.map((_, i) => i);

const feed = createReplayFeed(SAMPLE);
await feed.refresh();
const state = makeFeedState(feed, 'replay', { screen: 'screener' });
state.live = new LiveContext(feed.dl, { mode: 'replay' });
state.selected = 3; // CRAWL (BXoHJddsWJLHtAopeiSbKUSELsu8hSFMs8baGMDkpump) in the replay fixture
const screenState = buildScreenState(state);
try { state.live.close(); } catch { /* */ }
try { feed.close(); } catch { /* */ }
console.log(`selected: ${JSON.stringify(screenState.selected)}`);

const lineCount = (t) => t.split('\n').map((l) => l.trim()).filter(Boolean).length;

function ask(question) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let text = '';
    const tools = [];
    const timer = setTimeout(() => { h.cancel(); resolve({ question, error: 'timeout 180s', text, tools }); }, 180000);
    const h = runAnalyst(
      { prompt: question, screenState, budgetUsd: 1.0 },
      {
        onToolCall: (ev) => tools.push(ev.name),
        onText: (d) => { text += d; },
        onResult: (ev) => {
          clearTimeout(timer);
          const shown = text || ev.rawText || '';
          resolve({ question, text: shown, lines: lineCount(shown), chars: shown.length, tools,
            seconds: +((Date.now() - t0) / 1000).toFixed(1), costUsd: ev.costUsd, model: ev.model, isError: ev.isError });
        },
        onError: (message, detail) => { clearTimeout(timer); resolve({ question, error: `${message}: ${String(detail ?? '').slice(0, 120)}`, text, tools }); },
      },
    );
  });
}

const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { label, selected: screenState.selected, runs: {} };
for (const i of which) {
  const q = QUESTIONS[i];
  console.log(`\n[${label}] Q${i + 1}: ${q}`);
  const r = await ask(q);
  r.at = new Date().toISOString();
  prev.runs[i] = r;
  fs.writeFileSync(out, JSON.stringify(prev, null, 2));
  console.log(r.error ? `  ERROR ${r.error}` : `  ${r.lines} lines · ${r.chars} chars · ${r.seconds}s · $${r.costUsd?.toFixed(3)} · ${r.model} · tools=[${r.tools.join(',')}]`);
  console.log(r.text.split('\n').map((l) => '  | ' + l).join('\n'));
}
process.exit(0);
