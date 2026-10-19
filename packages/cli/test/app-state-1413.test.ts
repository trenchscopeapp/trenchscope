// task-1413 — appStateBlock (the source of the app_state MCP tool) reports alert channels as yes/no
// booleans computed from creds PRESENCE, and never the token/webhook itself, even with a real creds file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appStateBlock } from '../src/main.ts';
import type { AppState } from '../src/state.ts';

const SECRET_TOKEN = '987654321:AA_fake_bot_token_must_never_leak';
const SECRET_WEBHOOK = 'https://discord.com/api/webhooks/1/FAKE_SECRET_WEBHOOK_VALUE';

function fakeState(home: string, alerts: Record<string, unknown>): AppState {
  const config = {
    version: 4,
    theme: { name: 'cyberspace' },
    display: { priceMode: 'price' },
    fx: { intensity: 'fever' },
    voice: { name: 'Eddy', rate: 220 },
    alerts,
  };
  return {
    custom: { home, config },
    theme: { name: 'cyberspace' },
    vfx: { intensity: 'fever' },
    priceMode: 'price',
    scan: null,
  } as unknown as AppState;
}

test('appStateBlock: a configured telegram channel reports true, and the token never appears', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dexterm-appstate-'));
  fs.writeFileSync(path.join(home, 'telegram.json'), JSON.stringify({ token: SECRET_TOKEN, chatId: '12345' }), { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'discord.json'), JSON.stringify({ webhook: SECRET_WEBHOOK }), { mode: 0o600 });
  const block = appStateBlock(fakeState(home, { channels: { telegram: { enabled: true }, discord: { enabled: true } } }))!;
  const alerts = block.alerts as Record<string, boolean>;
  assert.equal(alerts.telegram, true, 'telegram configured + enabled -> true');
  assert.equal(alerts.discord, true, 'discord configured + enabled -> true');
  assert.equal(alerts.toast, true, 'toast on by default');
  const json = JSON.stringify(block);
  assert.ok(!json.includes(SECRET_TOKEN), 'the telegram token never appears');
  assert.ok(!json.includes('FAKE_SECRET_WEBHOOK_VALUE'), 'the discord webhook never appears');
  fs.rmSync(home, { recursive: true, force: true });
});

test('appStateBlock: enabled-but-no-creds reports false (never implies configured)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dexterm-appstate-'));
  const block = appStateBlock(fakeState(home, { channels: { telegram: { enabled: true }, discord: { enabled: true } } }))!;
  const alerts = block.alerts as Record<string, boolean>;
  assert.equal(alerts.telegram, false, 'enabled but no telegram.json -> false');
  assert.equal(alerts.discord, false, 'enabled but no discord.json -> false');
  fs.rmSync(home, { recursive: true, force: true });
});

test('appStateBlock: only non-secret fields are exposed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dexterm-appstate-'));
  const block = appStateBlock(fakeState(home, {}))!;
  assert.deepEqual(Object.keys(block).sort(), ['alerts', 'calm', 'intensity', 'priceMode', 'scan', 'theme', 'voice']);
  assert.equal(block.theme, 'cyberspace');
  assert.deepEqual(block.voice, { name: 'Eddy', rate: 220 });
  assert.equal((block.scan as { on: boolean }).on, false);
  fs.rmSync(home, { recursive: true, force: true });
});
