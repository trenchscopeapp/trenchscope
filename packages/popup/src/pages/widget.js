// dexterm popup — pack WIDGET wrapper page (task-1358 r3). OUR document (nonce CSP like every built-in page): it owns
// the WebSocket, the drag strip, the close button and Escape, and holds the pack page in `<iframe sandbox="allow-scripts">`
// whose only permitted document is the host's widget-frame route (the page CSP's `frame-src`). The pack page has no
// network of its own: everything it sees comes through here by postMessage, and the only things it can say back are
// ready / log / close.
//
// Why a frame: a document may always navigate ITSELF, and `sandbox` only stops it navigating others — so a pack page
// served top-level could carry data to a remote URL in the address bar (the r2 verifier's finding, browser fallback).
// A nested browsing context's navigations are governed by the PARENT's `frame-src`, whoever initiates them: the engine
// refuses a remote URL before any request leaves, and this page hears the violation and closes the widget.
(() => {
  'use strict';
  const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.content || '';
  const KEY = meta('dexterm-widget');
  DT.page = `widget:${KEY}`.slice(0, 24);
  const frame = document.getElementById('widget'), blockedEl = document.getElementById('blocked');
  let child = null, loads = 0, dead = false, frameReady = false;
  const last = new Map(); // the latest payload per topic, replayed once the frame says ready (pushes may arrive first)

  // targetOrigin must be '*' for an opaque-origin (sandboxed) frame; the only document that can be in there is ours
  // (frame-src), and the frame is dropped the moment anything else is seen.
  const post = (m) => { if (!dead && child && frameReady) { try { child.postMessage(m, '*'); } catch { /* frame gone */ } } };
  const kill = (why) => {
    if (dead) return;
    dead = true; child = null; frameReady = false;
    try { frame.removeAttribute('src'); frame.remove(); } catch { /* already gone */ }
    blockedEl.textContent = `widget blocked: ${why}`; blockedEl.hidden = false;
    DT.status('blocked', 'down');
    DT.send({ type: 'log', msg: `widget ${KEY} blocked: ${why}`.slice(0, 200) });
    DT.requestClose();
  };

  // r6: a second `load` is NOT proof of a navigation — WebKit fires it for a same-document fragment navigation too (an
  // in-page `<a href="#section">`), which used to close honest widgets. So on a second load the wrapper asks the document
  // to identify itself: our SDK answers a `ping` with `pong` at once; an error document committed after a refused
  // navigation (frame-src), a spent-token 404 or about:blank cannot — then the widget is closed. Pushes pause meanwhile.
  let pingTimer = null;
  const liveness = () => {
    frameReady = false; child = frame.contentWindow;
    if (pingTimer) clearTimeout(pingTimer);
    try { child && child.postMessage({ type: 'ping' }, '*'); } catch { /* no window */ }
    pingTimer = setTimeout(() => { pingTimer = null; if (!dead) kill('the page tried to leave its frame (the navigation was refused)'); }, 400);
  };
  frame.addEventListener('load', () => {
    loads++;
    if (loads > 1) { liveness(); return; }
    child = frame.contentWindow;
  });
  // frame-src violations are reported to the EMBEDDING document's policy: this page hears a pack page's attempt to go elsewhere
  document.addEventListener('securitypolicyviolation', (e) => {
    const d = String(e.effectiveDirective || e.violatedDirective || '');
    if (d.startsWith('frame-src') || d.startsWith('child-src')) kill(`tried to navigate to ${String(e.blockedURI || '?').slice(0, 80)} (refused by frame-src)`);
  });
  window.addEventListener('message', (e) => {
    // identity is the window object; the sandboxed frame's origin is the literal 'null'
    if (dead || !child || e.source !== child) return;
    const m = e.data;
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'ready':
        frameReady = true;
        // r5: the frame says whether this WebView has Trusted Types; without them the SDK's seal is the only HTML-sink guard
        if (m.tt === false) { DT.status('live · no Trusted Types', 'warn'); DT.send({ type: 'log', msg: `widget ${KEY}: this WebView has no Trusted Types — the SDK seal is the HTML-sink guard`.slice(0, 200) }); }
        else DT.status('live', 'up');
        post({ type: 'hello', theme: DT.theme });
        for (const [topic, payload] of last) post({ type: 'data', topic, payload });
        break;
      case 'pong': // r6: the document is still ours after a second load (a fragment navigation) — keep feeding it
        if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
        frameReady = true; break;
      case 'log': DT.send({ type: 'log', msg: String(m.msg).slice(0, 200) }); break;
      case 'close': DT.requestClose(); break;
      // r5: the seal's kill switch saw a loader element appear in the page — it was removed; close the widget
      case 'breach': kill(`a <${String(m.what).replace(/[^a-z0-9-]/gi, '').slice(0, 24)}> element appeared in the page (removed; the seal reported it)`); break;
      default: break; // anything else a page invents is ignored here and never reaches the socket
    }
  });

  DT.onTheme((t) => post({ type: 'theme', tokens: t }));
  DT.onData((payload, topic) => { if (typeof topic !== 'string') return; last.set(topic, payload); post({ type: 'data', topic, payload }); });
  DT.onClose(() => { post({ type: 'close' }); });
  DT.wireChrome();
  DT.loop(() => {});
  DT.connect();
})();
