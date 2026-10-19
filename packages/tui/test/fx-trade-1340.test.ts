// task-1340 trade moments: the shield mask is mechanical (no effect pass can touch a shielded cell), a moment can
// only be fired from a SETTLED outcome, the tiers behave, and the sound cues follow the moment (muted by default).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { Canvas, THEMES, makeVfx, type CueName, applyFx, stepVfx, pulse, fireMoment, fireInflight, skipMoment, momentP, momentKindFor, MOMENT_SECONDS, momentFrames, cuesFor, playMoment, play, synth, wav, soundOn, soundDir, type SettledTx, type Vfx } from '../src/index.ts';

const T = THEMES.cyberspace;
const TX = (over: Partial<SettledTx> = {}): SettledTx => ({ status: 'confirmed', side: 'buy', symbol: 'WIF', mint: 'M', sig: 'sig', solDelta: -0.5, pnlSol: 0, pnlPct: 0, ledger: 'paper', ...over });

/** A busy screen: panels, a rain zone, headings, data text and a shielded "ticket" box in the middle. */
function scene(w = 120, h = 40): Canvas {
  const c = new Canvas(w, h, T);
  c.fill(0, 0, w, h, ' ', { bg: T.bg });
  c.rainZone(0, 0, w, h, 1);
  for (let y = 2; y < h - 2; y += 3) c.text(2, y, `row ${y} price $0.0123 ▲ 12.5% vol 1.2M`, { fg: T.text, bg: T.bg });
  c.box(0, 0, w, 2, { title: 'HEADING' });
  const r = { x: 30, y: 10, w: 60, h: 14 };
  const box = c.box(r.x, r.y, r.w, r.h, { title: 'BUY $WIF', plain: true, rounded: true });
  c.text(box.x + 2, box.y + 1, 'spend 0.50 SOL ($60)', { fg: T.text, bg: box.bg, b: true });
  c.text(box.x + 2, box.y + 2, 'caps tx 0.50/1.00 · day 0.50/10.00 SOL', { fg: T.text, bg: box.bg });
  c.shieldRect(r.x, r.y, r.w, r.h);
  return c;
}

function snapshotRect(c: Canvas, r: { x: number; y: number; w: number; h: number }): string {
  const out: string[] = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const i = c.idx(x, y); out.push(`${c.ch[i]}|${c.fg[i]}|${c.bg[i]}|${c.at[i]}`); }
  return out.join('\n');
}

test('shield: putFx / tintFx refuse shielded cells; plain boxes register no heading', () => {
  const c = scene();
  assert.ok(c.hasShield);
  assert.equal(c.shields.length, 1);
  assert.equal(c.putFx(40, 12, 'X', { fg: T.up }), false);
  assert.equal(c.tintFx(40, 12, T.up, 0.5), false);
  assert.equal(c.putFx(5, 20, 'X', { fg: T.up }), true, 'outside the shield effects still write');
  assert.ok(c.headings.every((h) => h.y !== 10), 'the ticket title is not a heading');
  const copy = new Canvas(c.w, c.h, T); copy.copyFrom(c);
  assert.ok(copy.hasShield && copy.shield[copy.idx(40, 12)] === 1, 'copyFrom carries the shield');
});

test('shield invariant: the ticket rect is byte-identical with every effect and every moment live, across tiers and progress', () => {
  const r = { x: 30, y: 10, w: 60, h: 14 };
  const kinds: Array<Partial<SettledTx>> = [{ side: 'buy' }, { side: 'sell', pnlSol: 0.3, pnlPct: 0.4 }, { side: 'sell', pnlSol: -0.2, pnlPct: -0.3 }, { status: 'failed', reason: 'slippage' }];
  let cases = 0;
  for (const intensity of ['normal', 'fever'] as const) {
    for (const over of kinds) {
      for (const tp of [0.05, 0.3, 0.6, 0.95]) {
        const v = makeVfx({ intensity, seed: 7, sources: ['WIF', 'POPCAT'] });
        v.frame = 100;
        pulse(v, 'rug'); // glitch + shake + stutter + dump mood: the loudest the engine gets
        const m = fireMoment(v, TX(over), { fps: 30, origin: r, milestone: tp > 0.5 ? 'first' : null })!;
        v.frame = m.t0 + Math.round(m.dur * tp);
        const calm = scene();
        const fx = scene();
        applyFx(fx, v, { scan: true });
        assert.equal(snapshotRect(fx, r), snapshotRect(calm, r), `${intensity} ${over.side ?? over.status} p=${tp}`);
        cases += 1;
      }
    }
    // inflight sweep too
    const v = makeVfx({ intensity, seed: 7 }); v.frame = 50; fireInflight(v, 'WIF', r);
    for (let f = 0; f < 12; f++) { v.frame += 1; const fx = scene(); applyFx(fx, v); assert.equal(snapshotRect(fx, r), snapshotRect(scene(), r)); cases += 1; }
  }
  assert.ok(cases >= 56, `${cases} cases`);
});

test('moments do paint outside the shield (the effect is real) and never a hard cell', () => {
  const v = makeVfx({ intensity: 'fever', seed: 7 });
  v.frame = 10;
  const m = fireMoment(v, TX({ side: 'sell', pnlSol: 0.5, pnlPct: 0.5 }), { fps: 30 })!;
  v.frame = m.t0 + Math.round(m.dur * 0.3);
  const base = scene();
  const fx = scene();
  applyFx(fx, v, { rain: false, scan: false });
  let changed = 0, hardChanged = 0;
  const inHeading = (i: number) => base.headings.some((h) => i >= base.idx(h.x, h.y) && i < base.idx(h.x, h.y) + h.w);
  for (let i = 0; i < fx.ch.length; i++) {
    if (fx.ch[i] !== base.ch[i] || fx.fg[i] !== base.fg[i] || fx.bg[i] !== base.bg[i]) {
      changed++;
      // a hard cell may only ever take the heading colour split (pre-existing rule); its glyph and bg never move
      if (base.hard[i] && (fx.ch[i] !== base.ch[i] || fx.bg[i] !== base.bg[i] || !inHeading(i))) hardChanged++;
    }
  }
  assert.ok(changed > 50, `profit burst painted ${changed} cells`);
  assert.equal(hardChanged, 0);
});

test('fireMoment needs a settled outcome: a quote-shaped object throws; off tier fires nothing', () => {
  const v = makeVfx({ intensity: 'fever' });
  assert.throws(() => fireMoment(v, { status: 'quoted' } as unknown as SettledTx), /settled chain outcome/);
  assert.throws(() => fireMoment(v, { status: 'pending' } as unknown as SettledTx));
  assert.throws(() => fireMoment(v, null as unknown as SettledTx));
  const off = makeVfx({ calm: true });
  assert.equal(fireMoment(off, TX()), null);
  assert.equal(off.moment, null);
  assert.equal(fireInflight(off, 'WIF'), null);
  const c = scene(); const before = c.toAnsi();
  applyFx(c, off);
  assert.equal(c.toAnsi(), before, 'calm: no effect at all');
});

test('momentKindFor: buy → buy; sell by realized PnL → profit | loss; failed → failed', () => {
  assert.equal(momentKindFor(TX()), 'buy');
  assert.equal(momentKindFor(TX({ side: 'sell', pnlSol: 0.1 })), 'profit');
  assert.equal(momentKindFor(TX({ side: 'sell', pnlSol: 0 })), 'profit');
  assert.equal(momentKindFor(TX({ side: 'sell', pnlSol: -0.1 })), 'loss');
  assert.equal(momentKindFor(TX({ status: 'failed' })), 'failed');
});

test('lifecycle: progress 0→1, finished moments drop in stepVfx, any key skips, mood swap expires, fever runs 1.45× longer', () => {
  const v = makeVfx({ intensity: 'normal' });
  v.frame = 0;
  const m = fireMoment(v, TX({ side: 'sell', pnlSol: 1, pnlPct: 2 }), { fps: 30 })!;
  assert.equal(m.dur, momentFrames('profit', 'normal', 30));
  assert.equal(m.dur, Math.round(MOMENT_SECONDS.profit * 30));
  assert.equal(momentFrames('profit', 'fever', 30), Math.round(MOMENT_SECONDS.profit * 1.45 * 30));
  assert.equal(v.mood, 'pump');
  assert.equal(momentP(v), 0);
  for (let i = 0; i < m.dur; i++) stepVfx(v);
  assert.equal(momentP(v), 1);
  stepVfx(v);
  assert.equal(v.moment, null, 'dropped once p > 1');
  for (let i = 0; i < 100; i++) stepVfx(v);
  assert.equal(v.mood, 'neutral', 'mood swap expired');
  // skip
  fireMoment(v, TX({ side: 'sell', pnlSol: -1, pnlPct: -0.5 }));
  assert.equal(v.mood, 'dump');
  skipMoment(v);
  assert.equal(v.moment, null); assert.equal(v.mood, 'neutral'); assert.equal(v.glitch, 0);
  // the moment rides its tx
  const m2 = fireMoment(v, TX({ sig: 'abc' }))!;
  assert.equal(m2.tx?.sig, 'abc');
  // shake is disabled while a shield exists
  const vs = makeVfx({ intensity: 'fever' }); pulse(vs, 'newpair');
  const c = scene(); const before = c.toPlain(); applyFx(c, vs, { rain: false, scan: false });
  assert.equal(c.rowPlain(20).trim().startsWith('row 20'), true, 'data did not move');
  void before;
  void (vs as Vfx);
});

test('sound: cues follow the moment, play nothing while muted, and the synth produces valid WAVs', () => {
  assert.deepEqual(cuesFor('buy'), [['buy', 0]]);
  assert.deepEqual(cuesFor('buy', 'first'), [['buy', 0], ['profit', 180]]);
  assert.deepEqual(cuesFor('profit').map((c) => c[0]), ['sell', 'profit']);
  assert.deepEqual(cuesFor('loss').map((c) => c[0]), ['sell', 'loss']);
  assert.deepEqual(cuesFor('failed'), [['error', 0]]);
  assert.deepEqual(cuesFor('inflight'), []);
  const log: Array<{ name: CueName; at: number }> = [];
  assert.equal(play('buy', { on: false }, { log }), false);
  assert.equal(play('buy', null, { log }), false);
  assert.equal(play('buy', { on: true }, { log }), true);
  assert.deepEqual(log.map((l) => l.name), ['buy']);
  assert.equal(playMoment('inflight', null, { on: true }, { log }), 0, 'a pending send never chirps');
  assert.equal(playMoment('loss', null, { on: true }, { log }), 2);
  for (const name of ['buy', 'sell', 'profit', 'loss', 'error'] as const) {
    const s = synth(name);
    let peak = 0; for (const x of s) peak = Math.max(peak, Math.abs(x));
    assert.ok(Math.abs(peak - 0.5) < 1e-6, `${name} normalised to −6 dBFS`);
    const w = wav(s);
    assert.equal(w.toString('ascii', 0, 4), 'RIFF');
    assert.equal(w.readUInt32LE(40), s.length * 2);
  }
  assert.equal(soundOn(false, {}), false);
  assert.equal(soundOn(true, {}), true);
  assert.equal(soundOn(false, { DEXTERM_SOUND: '1' }), true);
  assert.equal(soundDir({ DEXTERM_HOME: '/tmp/dx' }), join('/tmp/dx', 'sounds'));
});
