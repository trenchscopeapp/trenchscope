// task-1420 — the docs golden set: questions whose answer is ONLY in the site docs pages (spectator view, PnL
// cards, voice, recorder, mirror ticket, analyst controls, install, trust/privacy, update check, limits). A
// deterministic (no-model) retrieval test like the task-1413 set: searchHelp(q)[0] must be the expected docs
// section. Also: the docs never displace an app-help answer (the 1413 set still tops the merged search), the
// question-shape rule, the citation URL, the "I don't see that in the docs" path, and the shipped entries'
// shape (these run on a public checkout too; the regenerate-and-diff lives in packages/cli/test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppHelp, loadDocsKb, searchHelp, getDocs, helpIntent, type DocsEntry } from '../src/app-help.ts';
import { appHelpAnswer } from '../src/server.ts';
import { LIMITS } from '../src/firewall.ts';
import { loadBundled } from '../src/user-content.ts';
import { DOCS_KB_DIR } from '../src/app-help.ts';
import { GOLDEN as APP_GOLDEN } from './app-help-golden-data.ts';

/** [question, expected top docs entry id]. Every expected id is a docs section, not an app-help topic. */
const DOCS_GOLDEN: Array<[string, string]> = [
  // spectator view
  ['what is redacted in the spectator view', 'docs-spectator-what-is-redacted'],
  ['which addresses does the spectator view redact', 'docs-spectator-what-is-redacted'],
  ['what is the security model of the spectator view', 'docs-spectator-security-model'],
  ['is the spectator stream read-only for viewers', 'docs-spectator-2-the-read-only-stream-spectate'],
  ['is streaming the spectator view to obs supported', 'docs-spectator-streaming-it'],
  ['what are the three spectator surfaces', 'docs-spectator-the-three-surfaces'],
  ['what does the agent activity window show with pause take over and kill', 'docs-spectator-1-the-agent-activity-window-follow-mode'],
  ['what does save and replay keep from a spectator session', 'docs-spectator-3-save-and-replay-record-file-dexterm-spectate'],
  // limits
  ['what are the limits of the spectator view', 'docs-spectator-limits'],
  ['what are the known limits of spectating an agent', 'docs-spectator-limits'],
  ['what are the limits of the free x api tier', 'docs-login-with-x-free-vs-paid-x-api-tiers-your-bill-your-limits'],
  ['what are the free vs paid x api tiers', 'docs-login-with-x-free-vs-paid-x-api-tiers-your-bill-your-limits'],
  ['what are the rate limits and pacing for data sources', 'docs-data-sources-rate-limits-and-pacing'],
  ['what is the helius credit meter', 'docs-data-sources-the-helius-credit-meter'],
  ['how long is data cached', 'docs-data-sources-cache'],
  ['what is still unverified about voice', 'docs-voice-still-unverified'],
  // PnL cards / trade moments / live path
  ['what is a pnl card', 'docs-paper-trading-pnl-cards'],
  ['what does a pnl card show for a closed trade', 'docs-paper-trading-pnl-cards'],
  ['what are trade moments', 'docs-paper-trading-trade-moments'],
  ['what does the live trading path keep', 'docs-paper-trading-what-the-live-path-keeps'],
  ['what does wallet panic do and how is it resumed', 'docs-paper-trading-panic'],
  // voice
  ['how fast does the voice respond, what is the latency', 'docs-voice-latency'],
  ['does the voice work on linux and windows', 'docs-voice-linux-and-windows'],
  ['what can I say to the voice assistant', 'docs-voice-what-you-can-say'],
  ['does the voice clarify or guess when a request is ambiguous', 'docs-voice-it-clarifies-it-never-guesses'],
  ['can the voice router arm or sign anything', 'docs-voice-what-it-can-never-do'],
  ['what happens when the piper neural voice is not installed', 'docs-voice-the-voice-neural-by-default'],
  ['why is the voice neural by default', 'docs-voice-the-voice-neural-by-default'],
  // recorder
  ['how does the history recorder store data and how big does it get', 'docs-configuration-history-recorder'],
  ['can the recorder prune old history', 'docs-configuration-history-recorder'],
  ['can the recorder run headless as a background service with launchd or systemd', 'docs-configuration-headless-recorder-dexterm-record'],
  // mirror ticket / copy trading
  ['what is the mirror ticket proposal for a followed wallet', 'docs-copy-trading-stage-2-the-one-key-mirror-ticket-a-proposal'],
  ['what is the mirror ticket and do I still confirm it', 'docs-copy-trading-stage-2-the-one-key-mirror-ticket-a-proposal'],
  ['is capped auto-mirror on by default', 'docs-copy-trading-stage-3-capped-auto-mirror-default-off-less'],
  ['what is proven and what is not about copy trading', 'docs-copy-trading-what-is-proven-what-is-not'],
  // analyst controls
  ['what can the analyst change, the three tiers', 'docs-analyst-what-it-can-change-three-tiers'],
  ['what can the analyst never do', 'docs-analyst-what-the-analyst-can-never-do'],
  ['what if claude is not installed for the analyst', 'docs-analyst-if-claude-is-missing'],
  ['what the analyst sees', 'docs-analyst-what-it-sees'],
  ['how does the analyst format its answers', 'docs-analyst-answer-style'],
  ['are agents untrusted by default', 'docs-agents-untrusted-by-default'],
  ['what agent capability tiers are enforced server side', 'docs-agents-capability-tiers-enforced-server-side'],
  // install / update check
  ['what node version and requirements does dexterm need', 'docs-getting-started-requirements'],
  ['what are the ways to install dexterm', 'docs-getting-started-install'],
  ['how does updating work and does it check for a new version', 'docs-getting-started-updating'],
  ['what does the daily update check send', 'docs-getting-started-updating'],
  ['what happens on the first run', 'docs-getting-started-first-run'],
  ['what does building the native chart window need', 'docs-popup-chart-build-the-native-window'],
  // trust / privacy
  ['what does voice mode send off my machine, privacy', 'docs-voice-privacy'],
  ['where are the x login tokens stored', 'docs-login-with-x-where-the-tokens-live'],
  ['what degraded states can login with x show', 'docs-login-with-x-degraded-states-you-will-see'],
  ['what is the security model of the chart popup', 'docs-popup-chart-security-model'],
  ['what files does dexterm keep on disk', 'docs-configuration-files-on-disk'],
  ['how accurate is the larp check measured', 'docs-larp-measured-accuracy'],
  ['what does the larp verdict mean', 'docs-larp-the-verdict'],
  ['what are the safety layers of scan mode', 'docs-scan-safety-four-layers'],
  ['how does scan mode control ai cost', 'docs-scan-cost-control'],
  ['what are the live holder and rug signals on the token page', 'docs-screens-live-holder-and-rug-signals'],
  ['where should a bug or problem be reported', 'docs-troubleshooting-reporting-a-problem'],
];

const sets = () => ({ appHelp: loadAppHelp(), docs: loadDocsKb() });

test(`docs golden set: ${DOCS_GOLDEN.length} docs-only questions each land on their docs section first`, () => {
  assert.ok(DOCS_GOLDEN.length >= 40, `docs golden set must have >= 40 questions (has ${DOCS_GOLDEN.length})`);
  const s = sets();
  const misses: string[] = [];
  for (const [q, id] of DOCS_GOLDEN) {
    const r = searchHelp(q, 5, s);
    if (r[0]?.id !== id || r[0]?.origin !== 'docs') {
      misses.push(`"${q}" -> expected ${id}, got [${r.slice(0, 3).map((h) => `${h.origin}:${h.id}:${h.score}`).join(', ') || 'none'}]`);
    }
  }
  assert.equal(misses.length, 0, `docs golden retrieval misses:\n  ${misses.join('\n  ')}`);
});

test('every expected docs golden id is a real docs entry, not an app-help topic', () => {
  const s = sets();
  const appIds = new Set(s.appHelp.map((e) => e.id));
  for (const [, id] of DOCS_GOLDEN) {
    assert.ok(getDocs(id, s.docs), `docs golden id ${id} has no docs entry`);
    assert.ok(!appIds.has(id), `${id} is an app-help id`);
  }
});

test(`the docs never displace app-help: all ${APP_GOLDEN.length} task-1413 questions still top the merged search`, () => {
  const s = sets();
  const misses: string[] = [];
  for (const [q, id] of APP_GOLDEN) {
    const r = searchHelp(q, 5, s);
    if (r[0]?.id !== id || r[0]?.origin !== 'app-help') misses.push(`"${q}" -> expected ${id}, got ${r[0]?.origin}:${r[0]?.id}`);
  }
  assert.equal(misses.length, 0, `app-help answers displaced by docs:\n  ${misses.join('\n  ')}`);
});

test('question shape: key/command/how-to questions rank app-help first; conceptual ones rank docs first', () => {
  assert.equal(helpIntent('what key opens the chart popup'), 'key');
  assert.equal(helpIntent('which command records history'), 'key');
  assert.equal(helpIntent('how do I export a view'), 'key');
  assert.equal(helpIntent('export the current view'), 'key');
  assert.equal(helpIntent('what does the token screen show'), 'key');
  assert.equal(helpIntent('is this coin a rug'), 'key');
  assert.equal(helpIntent('what is redacted in the spectator view'), 'concept');
  assert.equal(helpIntent('does the voice work on linux'), 'concept');
  assert.equal(helpIntent('how does the history recorder store data'), 'concept');

  const s = sets();
  // A key question about a docs-heavy topic: app-help still leads (it carries the exact key/command).
  const k = searchHelp('what key shows the spectator view', 5, s);
  assert.equal(k[0]?.origin, 'app-help', 'a key question leads with app-help');
  // Both sets stay in view either way.
  const c = searchHelp('what is redacted in the spectator view', 5, s);
  assert.equal(c[0]?.origin, 'docs');
  assert.ok(c.some((h) => h.origin === 'app-help'), 'a conceptual answer still lists the app-help topic');
  assert.ok(k.some((h) => h.origin === 'docs'), 'a key answer still lists the docs section');
});

test('a docs result cites its URL, carries no keys/commands, and its text is firewalled data', () => {
  const r = appHelpAnswer({ query: 'what is redacted in the spectator view' });
  const top = (r.results as Array<Record<string, unknown>>)[0];
  assert.equal(top.origin, 'docs');
  assert.equal(top.url, 'https://dexterm.xyz/docs/spectator#what-is-redacted');
  assert.deepEqual([top.keys, top.commands, top.flags, top.tools], [[], [], [], []]);
  assert.match(String(top.text), /^<untrusted source="docs:docs-spectator-what-is-redacted" kind="docs">[\s\S]*<\/untrusted>$/);
  assert.match(String(r.rule), /cite their url/i);
  // fetch by id works for a docs entry too
  const one = appHelpAnswer({ id: 'docs-voice-privacy' });
  assert.equal(one.origin, 'docs');
  assert.equal(one.url, 'https://dexterm.xyz/docs/voice#privacy');
});

test('nothing in the app-help or the docs: no results, and the rule says "I don\'t see that in the docs"', () => {
  const r = appHelpAnswer({ query: 'quantum teleporter for my hamster' });
  assert.deepEqual(r.results, []);
  assert.match(String(r.rule), /I don't see that in the docs/);
  assert.match(String(r.rule), /never invent a key or command/i);
});

test('shipped docs entries are well-formed: every page, unique ids, docs URLs, no placeholders, fit the firewall', () => {
  const docs: DocsEntry[] = loadDocsKb();
  assert.ok(docs.length >= 100, `expected the full docs KB, got ${docs.length}`);
  const pages = new Set(docs.map((e) => e.page));
  // the pages task-1419 shipped, and the rest of the docs index
  for (const p of ['beginners', 'spectator', 'voice', 'analyst', 'agents', 'paper-trading', 'copy-trading', 'configuration', 'getting-started', 'screens', 'keyboard', 'cli', 'scan', 'larp', 'data-sources', 'popup-chart', 'login-with-x', 'troubleshooting']) {
    assert.ok(pages.has(p), `no docs entries for page ${p}`);
    assert.ok(docs.some((e) => e.page === p && e.id === `docs-${p}` && e.anchor === ''), `page ${p} has no intro entry`);
  }
  const ids = new Set<string>();
  for (const e of docs) {
    assert.ok(!ids.has(e.id), `duplicate id ${e.id}`); ids.add(e.id);
    assert.ok(/^[a-z0-9][a-z0-9-]{0,63}$/.test(e.id), `bad id ${e.id}`);
    assert.equal(e.url, `https://dexterm.xyz/docs/${e.page}${e.anchor ? `#${e.anchor}` : ''}`, `${e.id}: url`);
    assert.ok(!e.body.includes('{{'), `${e.id}: unexpanded site placeholder`);
    assert.ok(e.body.length <= LIMITS.docs, `${e.id}: body ${e.body.length} chars exceeds the docs firewall cap ${LIMITS.docs}`);
  }
  // raw frontmatter: maintainers-owned, generated, and never a structured key/command/flag/tool list
  for (const raw of loadBundled([{ dir: DOCS_KB_DIR, layout: 'flat' }])) {
    assert.equal(raw.meta.owner, 'maintainers', `${raw.id}: owner`);
    assert.equal(raw.meta.origin, 'docs-generated', `${raw.id}: origin`);
    assert.equal(raw.meta.kind, 'docs', `${raw.id}: kind`);
    for (const k of ['keys', 'actions', 'commands', 'flags', 'tools']) assert.ok(!(k in raw.meta), `${raw.id}: docs entry must not carry ${k}`);
  }
});
