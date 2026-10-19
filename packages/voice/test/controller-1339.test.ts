// task-1339 controller tests: the re-verify's N1 (the app's own clarify must not be overwritten by the
// decision's `say`) and N3 (a second talk key while the mic is opening must not open a second session).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController, FakeTts, type SttEngine, type SttSession, type VoiceDecision } from '../src/index.ts';

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));
const screen = { screen: 'screener', selected: { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, visibleSymbols: ['SOL', 'BONK', 'WIF'] };

/** An STT whose listen() resolves only when the test says so, counting live sessions. */
function slowStt(text = 'buy bonk') {
  const pending: Array<(s: SttSession) => void> = [];
  const live = { opened: 0, open: 0, cancelled: 0 };
  const engine: SttEngine = {
    name: 'slow', label: 'slow (test)',
    available: async () => true,
    listen: () => new Promise<SttSession>((resolve) => { pending.push(resolve); }),
  };
  const release = () => {
    const r = pending.shift();
    if (!r) return;
    live.opened++; live.open++;
    let closed = false;
    const close = () => { if (!closed) { closed = true; live.open--; } };
    r({ stop: async () => { close(); return { text, confidence: 1, speakerCount: 1 }; }, cancel: () => { close(); live.cancelled++; } });
  };
  return { engine, release, live, pendingCount: () => pending.length };
}

test('N3: two talk keys while the mic is opening start ONE session; it is live and stoppable', async () => {
  const { engine, release, live, pendingCount } = slowStt();
  const decisions: VoiceDecision[] = [];
  const ctrl = new VoiceController({ stt: engine, tts: new FakeTts(), getScreenState: () => screen, onDecision: (d) => { decisions.push(d); } });
  ctrl.enable();
  const p1 = ctrl.toggleTalk();
  assert.equal(ctrl.status().starting, true, 'starting while listen() is in flight');
  assert.equal(ctrl.micEngaged, true);
  const p2 = ctrl.toggleTalk(); // "vv" in one read
  assert.equal(pendingCount(), 1, 'only one listen() was issued');
  release();
  await Promise.all([p1, p2]);
  assert.equal(ctrl.status().mode, 'listening');
  assert.equal(live.opened, 1, 'one mic session');
  assert.equal(live.open, 1);
  await ctrl.toggleTalk(); // stop + route
  await tick();
  assert.equal(live.open, 0, 'the single session was stopped');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, 'open-ticket');
});

test('N3/N8: a cancel while the mic is opening closes the session the moment it arrives', async () => {
  const { engine, release, live } = slowStt();
  const ctrl = new VoiceController({ stt: engine, tts: new FakeTts(), getScreenState: () => screen });
  ctrl.enable();
  const p = ctrl.toggleTalk();
  ctrl.cancelListen(); // the user pressed esc / moved on before the engine came up
  release();
  await p;
  assert.equal(ctrl.status().mode, 'idle');
  assert.equal(ctrl.status().starting, false);
  assert.equal(live.opened, 1);
  assert.equal(live.open, 0, 'the late session was cancelled at once');
  assert.equal(live.cancelled, 1);
  // and the next talk key works normally
  const p2 = ctrl.toggleTalk(); release(); await p2;
  assert.equal(ctrl.status().mode, 'listening');
  ctrl.disable();
  assert.equal(live.open, 0);
});

test('N3: disable() while the mic is opening never leaves it live', async () => {
  const { engine, release, live } = slowStt();
  const ctrl = new VoiceController({ stt: engine, tts: new FakeTts(), getScreenState: () => screen });
  ctrl.enable();
  const p = ctrl.toggleTalk();
  ctrl.disable();
  release();
  await p;
  assert.equal(ctrl.status().mode, 'off');
  assert.equal(live.open, 0);
});

test('N1: when the app answers a decision itself (returns false) the decision\'s `say` is NOT spoken over it', async () => {
  const { engine, release } = slowStt('buy bonk');
  const tts = new FakeTts();
  let ctrl!: VoiceController;
  ctrl = new VoiceController({ stt: engine, tts, getScreenState: () => screen, onDecision: (d) => {
    if (d.kind === 'open-ticket') { ctrl.speak('I see 2 tokens called BONK. Open the exact one first, then say buy.'); return false; }
    return true;
  } });
  ctrl.enable();
  const p = ctrl.toggleTalk(); release(); await p;
  await ctrl.toggleTalk();
  await tick(10);
  assert.deepEqual(tts.spoken, ['I see 2 tokens called BONK. Open the exact one first, then say buy.'], 'only the app\'s clarify was spoken');
  assert.equal(tts.stops, 0, 'the clarify was never cut off');
  assert.equal(ctrl.status().lastSay, 'I see 2 tokens called BONK. Open the exact one first, then say buy.');
  assert.equal(ctrl.status().mode, 'idle', 'back to idle after the reply');
});

test('N1: an app handler that returns nothing keeps the old behaviour (the decision\'s `say` is spoken)', async () => {
  const { engine, release } = slowStt('buy bonk');
  const tts = new FakeTts();
  const ctrl = new VoiceController({ stt: engine, tts, getScreenState: () => screen, onDecision: () => { /* opened the ticket */ } });
  ctrl.enable();
  const p = ctrl.toggleTalk(); release(); await p;
  await ctrl.toggleTalk();
  await tick(10);
  assert.equal(tts.spoken.length, 1);
  assert.match(tts.spoken[0], /opening a buy ticket for BONK/);
});
