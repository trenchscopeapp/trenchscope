import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPopupHost, displayAvailable, openInBrowser, BrowserPopupHost, shellBinaryPath } from '../src/host.ts';

test('displayAvailable: GUI platforms yes; linux needs DISPLAY/WAYLAND', () => {
  assert.equal(displayAvailable({}, 'darwin'), true);
  assert.equal(displayAvailable({}, 'win32'), true);
  assert.equal(displayAvailable({}, 'linux'), false);
  assert.equal(displayAvailable({ DISPLAY: ':0' } as NodeJS.ProcessEnv, 'linux'), true);
  assert.equal(displayAvailable({ WAYLAND_DISPLAY: 'wayland-0' } as NodeJS.ProcessEnv, 'linux'), true);
});

test('createPopupHost: forceBrowser returns the browser fallback', () => {
  const d = createPopupHost({ forceBrowser: true, platform: 'linux' });
  assert.equal(d.native, false);
  assert.equal(d.host.native, false);
  assert.match(d.reason, /browser/i);
});

test('createPopupHost: missing shell binary → browser fallback with a build hint', () => {
  const d = createPopupHost({ env: { DEXTERM_POPUP_SHELL: '/no/such/dexterm-shell' } as NodeJS.ProcessEnv, platform: 'darwin' });
  assert.equal(d.native, false);
  assert.match(d.reason, /not built|build:shell/);
});

test('createPopupHost: no display → browser fallback', () => {
  // A fake-but-present binary path on linux with no DISPLAY still falls back for lack of a display.
  const d = createPopupHost({ env: { DEXTERM_POPUP_SHELL: shellBinaryPath() } as NodeJS.ProcessEnv, platform: 'linux' });
  assert.equal(d.native, false);
});

test('openInBrowser: refuses non-http(s) schemes and junk', () => {
  assert.equal(openInBrowser('file:///etc/passwd', 'darwin'), false);
  assert.equal(openInBrowser('javascript:alert(1)', 'darwin'), false);
  assert.equal(openInBrowser('not a url', 'darwin'), false);
});

// Defect 2 (task-1290): the browser fallback may only launch loopback http — never a remote origin, and
// never https (even to loopback). This is the last line before a URL is handed to the OS launcher.
test('openInBrowser: launches only loopback http, refuses remote and https', () => {
  assert.equal(openInBrowser('https://evil.example/', 'linux'), false, 'remote https refused');
  assert.equal(openInBrowser('http://evil.example/', 'linux'), false, 'remote http refused');
  assert.equal(openInBrowser('https://127.0.0.1:5000/', 'linux'), false, 'https to loopback refused');
  // loopback http is allowed (spawns xdg-open on linux → absent on the test box, harmless, returns true).
  assert.equal(openInBrowser('http://127.0.0.1:5000/popup/chart?p=x', 'linux'), true);
});

test('BrowserPopupHost: open is best-effort and the rest are no-ops; start resolves null', async () => {
  // platform 'linux' so open() spawns xdg-open (absent on the test box → harmless), never a real browser.
  const h = new BrowserPopupHost('linux');
  assert.equal(h.native, false);
  assert.equal(await h.start(), null);
  // no-ops must not throw
  h.open('p1', 'http://127.0.0.1:1/popup/chart?p=x');
  h.alwaysOnTop('p1', true); h.clickThrough('p1', true); h.move('p1', 1, 1); h.show('p1'); h.hide('p1'); h.focus('p1');
  h.close('p1'); h.quit();
});
