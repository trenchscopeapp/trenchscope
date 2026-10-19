// VoiceController tests (task-1282), fully headless with fake engines. They prove the push-to-talk
// state machine, the mic-live indicator, interruption, mute, voice cycling, and latency capture —
// everything that does NOT need a real mic. The real mic path is verified live at the Mac (see handoff).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController, FakeStt, FakeTts, type VoiceDecision, type FakeSttScript, type SttEngine } from '../src/index.ts';

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

function make(scripts: FakeSttScript[] = []) {
  const stt = new FakeStt(scripts);
  const tts = new FakeTts(['Samantha', 'Alex', 'Daniel']);
  const decisions: VoiceDecision[] = [];
  let t = 0;
  const now = () => (t += 10); // each read advances 10ms, so every latency sample is positive
  const screen = { screen: 'screener', selected: { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, visibleSymbols: ['SOL', 'BONK', 'WIF'] };
  const ctrl = new VoiceController({ stt, tts, now, getScreenState: () => screen, onDecision: (d) => decisions.push(d) });
  return { ctrl, stt, tts, decisions };
}

test('enable/disable moves off <-> idle and loads voices', async () => {
  const { ctrl } = make();
  assert.equal(ctrl.status().mode, 'off');
  ctrl.enable();
  assert.equal(ctrl.status().mode, 'idle');
  assert.equal(ctrl.isEnabled, true);
  await tick();
  assert.ok(ctrl.availableVoices().length > 0, 'voices load on enable');
  ctrl.disable();
  assert.equal(ctrl.status().mode, 'off');
});

test('push-to-talk: first press opens the mic (listening), second transcribes + routes to the analyst', async () => {
  const { ctrl, tts, decisions } = make([{ text: 'is bonk a rug' }]);
  ctrl.enable();
  await ctrl.toggleTalk();
  assert.equal(ctrl.status().mode, 'listening', 'mic is LIVE while listening');
  assert.equal(ctrl.isListening, true);
  await ctrl.toggleTalk();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, 'analyst');
  assert.equal(ctrl.status().mode, 'thinking');
  assert.equal(ctrl.status().lastTranscript, 'is bonk a rug');
  // The app answers; the controller speaks the first ~2 sentences and returns to idle.
  ctrl.speakAnswer({ verdict: 'AVOID', summary: ['Liquidity is thin.', 'Top holder owns 40%.'] });
  await tick();
  assert.match(tts.spoken[0], /Verdict: AVOID/);
  assert.equal(ctrl.status().mode, 'idle');
});

test('an instant decision (navigate) speaks its own one-liner and records an instant-path latency', async () => {
  const { ctrl, tts, decisions } = make([{ text: 'show me the top runners' }]);
  ctrl.enable();
  await ctrl.toggleTalk();
  await ctrl.toggleTalk();
  assert.equal(decisions[0].kind, 'navigate');
  await tick();
  assert.ok(tts.spoken.length >= 1);
  const report = ctrl.report();
  const instant = report.find((r) => r.path === 'instant')!;
  assert.equal(instant.n, 1);
  assert.ok((instant.p50 ?? 0) > 0, 'a key-release → first-word sample was captured');
});

test('a spoken buy only emits open-ticket (never executes) and confirms by voice', async () => {
  const { ctrl, decisions } = make([{ text: 'buy bonk' }]);
  ctrl.enable();
  await ctrl.toggleTalk();
  await ctrl.toggleTalk();
  assert.equal(decisions[0].kind, 'open-ticket');
  const t = decisions[0] as Extract<VoiceDecision, { kind: 'open-ticket' }>;
  assert.equal(t.side, 'buy');
});

test('mute suppresses audio but still completes the turn and latency sample', async () => {
  const { ctrl, tts, decisions } = make([{ text: 'is bonk a rug' }]);
  ctrl.enable();
  ctrl.setMuted(true);
  await ctrl.toggleTalk();
  await ctrl.toggleTalk();
  ctrl.speakAnswer({ summary: ['It looks fine.'] });
  await tick();
  assert.equal(tts.spoken.length, 0, 'nothing is spoken while muted');
  assert.equal(decisions[0].kind, 'analyst');
  assert.ok(ctrl.report().find((r) => r.path === 'analyst')!.n === 1, 'latency still recorded while muted');
  assert.equal(ctrl.status().lastSay, 'It looks fine.', 'the would-be spoken line is still surfaced');
});

test('starting to talk interrupts a reply in progress', async () => {
  const { ctrl, tts } = make([{ text: 'is bonk a rug' }, { text: 'show watchlist' }]);
  ctrl.enable();
  await ctrl.toggleTalk(); await ctrl.toggleTalk();
  ctrl.speakAnswer({ summary: ['A long first sentence that is being read right now.'] });
  // Immediately start the next utterance before playback finishes.
  await ctrl.toggleTalk();
  assert.equal(tts.stops, 1, 'the in-progress reply was interrupted');
  assert.equal(ctrl.status().mode, 'listening');
});

test('cycleVoice rotates through the installed voices', async () => {
  const { ctrl } = make();
  ctrl.enable();
  await tick();
  const first = ctrl.currentVoice();
  ctrl.cycleVoice();
  assert.notEqual(ctrl.currentVoice(), first);
});

test('disable while listening closes the mic', async () => {
  const { ctrl } = make([{ text: 'hello' }]);
  ctrl.enable();
  await ctrl.toggleTalk();
  assert.equal(ctrl.isListening, true);
  ctrl.disable();
  assert.equal(ctrl.status().mode, 'off');
  assert.equal(ctrl.isListening, false);
});

// ---- task-1282 rework regression tests (each fails on the pre-rework controller) ----

test('rework D2: the mic auto-stops at the listen hard cap — it never stays live', async () => {
  const stt = new FakeStt([{ text: 'hello' }]);
  let fire: (() => void) | null = null;
  const ctrl = new VoiceController({
    stt, tts: new FakeTts(), maxListenMs: 15_000,
    setTimer: (fn) => { fire = fn; return 1; }, clearTimer: () => { fire = null; },
  });
  ctrl.enable();
  await ctrl.toggleTalk();
  assert.equal(ctrl.status().mode, 'listening', 'mic is live after pressing talk');
  assert.ok(fire, 'a listen-timeout was armed while listening');
  (fire as () => void)(); // simulate the hard cap elapsing
  assert.equal(ctrl.status().mode, 'idle', 'the mic auto-stopped at the cap');
  assert.equal(ctrl.isListening, false);
  assert.match(ctrl.status().message ?? '', /timed out/i);
});

test('rework D2: a transcription error releases the capture and returns to idle', async () => {
  let cancelled = false;
  const boom = {
    name: 'boom', label: 'boom', available: async () => true,
    listen: async () => ({ stop: async () => { throw new Error('mic exploded'); }, cancel: () => { cancelled = true; } }),
  };
  const ctrl = new VoiceController({ stt: boom as unknown as SttEngine, tts: new FakeTts() });
  ctrl.enable();
  await ctrl.toggleTalk();
  assert.equal(ctrl.status().mode, 'listening');
  await ctrl.toggleTalk(); // second press → stop() throws
  assert.equal(ctrl.status().mode, 'idle', 'error returns voice to idle');
  assert.equal(ctrl.isListening, false);
  assert.equal(cancelled, true, 'the capture is released on error, never left open');
  assert.match(ctrl.status().message ?? '', /transcription failed/i);
});

test('rework D3: an analyst error does NOT wedge voice in "thinking" — interrupt() returns to idle and voice is usable', async () => {
  const { ctrl } = make([{ text: 'is bonk a rug' }, { text: 'show me the top runners' }]);
  ctrl.enable();
  await ctrl.toggleTalk(); await ctrl.toggleTalk();
  assert.equal(ctrl.status().mode, 'thinking', 'the analyst turn is in flight');
  ctrl.interrupt(); // what the app does when the analyst turn errors/interrupts
  assert.equal(ctrl.status().mode, 'idle', 'the error must return voice to idle, not leave it stuck');
  // Voice is alive again: the next press opens the mic.
  await ctrl.toggleTalk();
  assert.equal(ctrl.status().mode, 'listening');
});

test('rework D3: abortTurn speaks a clear error and leaves voice idle', async () => {
  const { ctrl, tts } = make([{ text: 'is bonk a rug' }]);
  ctrl.enable();
  await ctrl.toggleTalk(); await ctrl.toggleTalk();
  assert.equal(ctrl.status().mode, 'thinking');
  ctrl.abortTurn('Sorry — the analyst hit an error. Try again.');
  await tick();
  assert.equal(ctrl.status().mode, 'idle');
  assert.match(tts.spoken.at(-1) ?? '', /analyst hit an error/i);
  assert.match(ctrl.status().message ?? '', /error/i);
});

test('no STT engine: enabling still allows spoken replies, and talk explains it', async () => {
  const tts = new FakeTts();
  const decisions: VoiceDecision[] = [];
  const ctrl = new VoiceController({ stt: null, tts, onDecision: (d) => decisions.push(d) });
  ctrl.enable();
  assert.match(ctrl.status().message ?? '', /voice-in unavailable/i);
  await ctrl.toggleTalk();
  assert.match(ctrl.status().message ?? '', /type your question/i);
  assert.equal(decisions.length, 0);
});
