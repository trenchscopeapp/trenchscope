#!/usr/bin/env node
// task-1407 visual review: render the PnL card fixtures (profit / loss / long hold, both aspects, plus the
// wallet-shown + exact-size and devnet variants) to PNGs at full size. Offline; writes only into --out.
//   node packages/cli/tools/pnl-cards.mjs --out /tmp/pnl-cards
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { computeCard, renderCard, cardPixels, cardText } from '../src/pnl-card.ts';
import { encodePng } from '@dexterm/data';
import { NOW, profitInput, lossInput, longHoldInput } from '../test/fixtures/pnl-1407.ts';

const i = process.argv.indexOf('--out');
const out = resolve(i >= 0 ? process.argv[i + 1] : 'pnl-cards');
mkdirSync(out, { recursive: true });
const cases = [
  ['profit-paper', profitInput(), {}],
  ['loss-live', lossInput(), {}],
  ['longhold-tracked', longHoldInput(), {}],
  ['loss-live-revealed-exact', lossInput(), { showWallet: true, exactSize: true }],
  ['loss-live-devnet', lossInput('devnet'), {}],
];
let bad = 0;
for (const [name, input, o] of cases) {
  const s = computeCard(input, NOW);
  for (const aspect of ['wide', 'square']) {
    const r = renderCard(s, { ...o, aspect });
    const px = cardPixels(r);
    const file = join(out, `${name}-${aspect === 'wide' ? '16x9' : '1x1'}.png`);
    writeFileSync(file, encodePng({ w: px.w, h: px.h, rgba: px.rgba }));
    console.log(`${file}  ${px.w}x${px.h}  big-text scales ${px.scales.join('/')}${r.clipped.length ? `  CLIPPED: ${JSON.stringify(r.clipped)}` : ''}`);
    if (r.clipped.length) bad++;
  }
  writeFileSync(join(out, `${name}.txt`), cardText(s, o));
}
process.exit(bad ? 1 : 0);
