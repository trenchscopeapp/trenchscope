// JARVIS voice latency harness (task-1282, scope item 3). Measures the key-release → first-spoken-word
// budget and its stages, with a FAKE analyst (deterministic, immediate) and — with --real-claude — a
// real `claude -p` first-token measurement. Run from the package:
//
//   node packages/voice/tools/voice-bench.mjs              # fake analyst, real `say` + router
//   node packages/voice/tools/voice-bench.mjs --real-claude # also measure a real claude first token
//
// It never opens the mic (no headless mic). STT stage numbers are carried from the spike's real runs
// and clearly labelled as such; the router and `say` numbers here are measured live on this machine.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { route, VoiceController, FakeStt, FakeTts, ensureHelper } from '../src/index.ts';
import { existsSync, rmSync as rmDir } from 'node:fs';
import { homedir } from 'node:os';

const screen = { screen: 'screener', selected: { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, visibleSymbols: ['SOL', 'BONK', 'WIF'] };
const prov = { pttActive: true, speakerCount: 1, echoFlagged: false, sttConfidence: 1, lowConfTokens: [] };
const p50 = (xs) => xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;
const round = (n) => n == null ? null : Math.round(n * 1000) / 1000;

// 1) Router latency (real, no model in the loop).
function benchRouter(iters = 2000) {
  const utterances = ['show me the top runners', 'buy bonk', 'is wif a rug', 'filter liquidity over 50k', 'watch this one', 'sell half'];
  const xs = [];
  for (let i = 0; i < iters; i++) {
    const u = utterances[i % utterances.length];
    const t = process.hrtime.bigint();
    route(u, prov, screen);
    xs.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return { n: iters, p50: round(p50(xs)), max: round(Math.max(...xs)) };
}

// 2) `say` first-audio (real): spawn to a temp file (no speaker noise) and time the spawn event.
async function benchSay(iters = 5) {
  if (process.platform !== 'darwin') return { skipped: 'not macOS' };
  const dir = mkdtempSync(join(tmpdir(), 'voice-bench-'));
  const xs = [];
  try {
    for (let i = 0; i < iters; i++) {
      const out = join(dir, `s${i}.aiff`);
      const t = process.hrtime.bigint();
      const ms = await new Promise((resolve, reject) => {
        const c = spawn('say', ['-o', out, 'This token launched four minutes ago.'], { stdio: 'ignore' });
        c.on('spawn', () => resolve(Number(process.hrtime.bigint() - t) / 1e6));
        c.on('error', reject);
      });
      xs.push(ms);
      await new Promise((r) => setTimeout(r, 30));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return { n: iters, p50: round(p50(xs)), max: round(Math.max(...xs)) };
}

// 3) End-to-end through the real controller with fake engines (confirms wiring + captures samples).
async function benchE2E() {
  const stt = new FakeStt([{ text: 'show me the top runners' }, { text: 'is bonk a rug' }]);
  const tts = new FakeTts();
  const ctrl = new VoiceController({ stt, tts, getScreenState: () => screen, onDecision: (d) => { if (d.kind === 'analyst') ctrl.speakAnswer({ verdict: 'CAUTION', summary: ['Liquidity is thin.', 'One wallet holds forty percent.'] }); } });
  ctrl.enable();
  await ctrl.toggleTalk(); await ctrl.toggleTalk(); // instant: navigate
  await new Promise((r) => setTimeout(r, 10));
  await ctrl.toggleTalk(); await ctrl.toggleTalk(); // analyst (fake answer, immediate)
  await new Promise((r) => setTimeout(r, 10));
  return ctrl.report();
}

// 3b) Apple Speech helper (task-1339): the one-time swiftc compile is the real first-`v` cost on a fresh
// Mac, and the cached lookup is what every later launch pays. Both measured live; nothing is listened to.
function benchAppleHelper() {
  if (process.platform !== 'darwin') return { skipped: 'not macOS' };
  const dir = process.env.DEXTERM_VOICE_HELPER_DIR || join(homedir(), '.dexterm', 'voice-helper');
  const wasCached = existsSync(join(dir, 'recognize'));
  const t0 = process.hrtime.bigint();
  const bin = ensureHelper();
  const firstMs = round(Number(process.hrtime.bigint() - t0) / 1e6);
  if (!bin) return { skipped: 'swiftc not available (voice-in degrades to whisper / text)' };
  const t1 = process.hrtime.bigint();
  ensureHelper();
  const cachedMs = round(Number(process.hrtime.bigint() - t1) / 1e6);
  let compileMs = null;
  if (process.argv.includes('--recompile')) {
    // Force a real compile to measure the fresh-Mac cost (the cache is rebuilt in place).
    try { rmDir(join(dir, '.srchash'), { force: true }); } catch {}
    const t2 = process.hrtime.bigint();
    ensureHelper();
    compileMs = round(Number(process.hrtime.bigint() - t2) / 1e6);
  }
  return { wasCached, firstCallMs: firstMs, cachedLookupMs: cachedMs, compileMs };
}

// 4) Real `claude -p` first-token (optional, guarded). Measures model latency only (no MCP/tools).
async function benchClaude(model = process.env.DEXTERM_ANALYST_MODEL || 'claude-sonnet-5-5') {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let firstToken = null, settled = false;
    let child;
    const finish = (r) => { if (!settled) { settled = true; try { child?.kill('SIGTERM'); } catch {} resolve(r); } };
    try {
      child = spawn('claude', ['-p', 'Reply with exactly one short sentence about Solana.', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', model], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return finish({ skipped: `claude not available: ${e.message}` }); }
    let buf = '', err = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i; while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        const se = ev.event;
        if (firstToken === null && ((se?.type === 'content_block_delta' && se?.delta?.text) || (ev.type === 'assistant'))) { firstToken = Number(process.hrtime.bigint() - t0) / 1e6; finish({ firstTokenMs: round(firstToken) }); return; }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ skipped: `claude spawn failed: ${e.message}` }));
    child.on('close', () => finish(firstToken === null ? { skipped: `no token (login/err): ${err.trim().slice(-160) || 'no output'}` } : { firstTokenMs: round(firstToken) }));
    setTimeout(() => finish(firstToken === null ? { skipped: 'timeout 30s' } : { firstTokenMs: round(firstToken) }), 30000);
  });
}

const main = async () => {
  const real = process.argv.includes('--real-claude');
  const router = benchRouter();
  const say = await benchSay();
  const e2e = await benchE2E();
  const apple = benchAppleHelper();
  const claude = real ? await benchClaude() : { skipped: 'not requested (pass --real-claude); using spike numbers below' };

  // STT stage from the spike (real runs on a CPU-only Intel Mac; not re-measured here — no mic).
  const sttSpike = { appleStreaming: 'sub-second perceived (partials during speech)', whisperBaseEnBatch: '3500–4800 ms', note: 'large-v3-turbo on CPU = 55–93 s, unusable' };
  const claudeMs = claude.firstTokenMs ?? null;
  const sayMs = say.p50 ?? null;
  const routerMs = router.p50 ?? null;

  const out = { at: new Date().toISOString(), platform: process.platform, router, say, e2eControllerSamples: e2e, appleHelper: apple, claudeFirstToken: claude, sttStageFromSpike: sttSpike };
  const budget = {
    note: 'key-release → first spoken word. STT excluded here (no mic); add the STT row for a full figure.',
    instantPath_ms: round((routerMs ?? 0) + (sayMs ?? 0)),
    analystPath_ms_realClaude: claudeMs != null ? round((routerMs ?? 0) + claudeMs + (sayMs ?? 0)) : null,
    analystPath_ms_spikeWarm: round((routerMs ?? 0) + 2590 + (sayMs ?? 0)),
  };
  out.composedBudget = budget;

  console.log('\n=== JARVIS voice latency (task-1282) ===');
  console.log(`platform: ${process.platform}`);
  console.log(`router:        p50 ${router.p50} ms  max ${router.max} ms  (n=${router.n})`);
  console.log(`say 1st audio: p50 ${say.p50 ?? say.skipped} ms  max ${say.max ?? ''} ms  (n=${say.n ?? 0})`);
  console.log(`controller e2e (fake engines) samples: ${JSON.stringify(e2e)}`);
  console.log(`apple helper:  ${apple.skipped ?? `cached lookup ${apple.cachedLookupMs} ms · first call ${apple.firstCallMs} ms (${apple.wasCached ? 'was cached' : 'compiled'})${apple.compileMs != null ? ` · forced compile ${apple.compileMs} ms` : ''}`}`);
  console.log(`claude first token: ${claude.firstTokenMs != null ? claude.firstTokenMs + ' ms' : claude.skipped}`);
  console.log('\nSTT stage (from the spike, real runs; not re-measured — no headless mic):');
  console.log(`  Apple Speech (streaming): ${sttSpike.appleStreaming}`);
  console.log(`  whisper base.en (batch):  ${sttSpike.whisperBaseEnBatch}   [${sttSpike.note}]`);
  console.log('\ncomposed key-release → first word (excl. STT):');
  console.log(`  instant path:            ${budget.instantPath_ms} ms  (router + say)`);
  console.log(`  analyst path (warm,spike): ${budget.analystPath_ms_spikeWarm} ms  (router + 2590 claude + say)`);
  if (budget.analystPath_ms_realClaude != null) console.log(`  analyst path (real claude): ${budget.analystPath_ms_realClaude} ms`);

  const dest = join(process.cwd(), 'packages/voice/out');
  try { rmSync(dest, { recursive: true, force: true }); } catch {}
  try { (await import('node:fs')).mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, 'latency.json'), JSON.stringify(out, null, 2)); console.log(`\nwrote ${join(dest, 'latency.json')}`); } catch (e) { console.log('(could not write latency.json:', e.message, ')'); }
};
main();
