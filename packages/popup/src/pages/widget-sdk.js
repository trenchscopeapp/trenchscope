// dexterm popup — PACK WIDGET SDK (task-1358 Tier 5, r2, r3, r4). Inlined by the popup server into a pack's widget page,
// ahead of the pack's own markup, and allow-listed in the page's CSP by its sha256 (a widget page carries no nonce;
// every inline block, this one included, runs by hash). It is the FIRST script of the frame document and it does two
// things: it seals the DOM (r4), then it defines ONE frozen global, `window.dexterm`:
//
//   dexterm.on(topic, fn)      fn(payload) on every push of a topic the widget declared (rows · token · narrative ·
//                              positions · alerts · theme); the current value is replayed to a late listener
//   dexterm.off(topic, fn)
//   dexterm.theme              the terminal's theme tokens (also set as CSS variables: --bg --panel --border
//                              --borderFocus --text --muted --dim --accent --up --down --warn --ai --pump --dbc)
//   dexterm.topics             the topics this widget subscribed to (from its widget.json)
//   dexterm.key                '<pack>/<widget>[/<id>]'
//   dexterm.close()            ask the terminal to close this window (Esc does the same)
//   dexterm.log(text)          a line in the terminal's popup log (sanitised there, 200 chars)
//
// That is the whole API. (r3) The page is the document inside the host's wrapper iframe: it has NO network of its own
// (connect-src 'none' — no socket, no fetch, nothing), an opaque origin (sandbox without allow-same-origin: no cookies,
// no storage, no reach into the wrapper) and may only be shown inside the host's own origin. View models arrive from the
// wrapper by postMessage (accepted only from the parent window AND the host origin named in <head>); the only messages
// this page can send are ready / log / close, and only to that origin. No imports or remote scripts (script-src is the
// hash list and nothing else), no eval, no inline handlers, no remote images or fonts, no runtime script injection
// (Trusted Types), no popups, forms or downloads (sandbox), and no navigating away: the wrapper's frame-src names the one
// document this frame may show, the engine refuses any other, and the wrapper then closes the widget.
//
// (r4) THE DOM SEAL. One thing no CSP directive covers: a `<link rel=preconnect|dns-prefetch>` built at run time makes
// WebKit resolve a name and open a bare TCP connection to a host:port the page chose (nothing is fetched, so no
// directive applies; Trusted Types do not see it; the install-time audit cannot, the element does not exist yet). The
// page cannot obtain a second realm (nested frames are created but sealed off from it by the sandbox; every HTML-parsing
// sink is a Trusted Types sink), so this script — first to run, hash-listed — replaces the DOM's insertion methods on
// the prototypes with non-configurable, non-writable guards that refuse any node whose subtree holds a LOADER element
// (link · meta · base · iframe · frame · frameset · object · embed · applet · portal · fencedframe · script), makes the
// HTML-string sinks throw outright (innerHTML / outerHTML setters, insertAdjacentHTML, document.write, setHTML,
// setHTMLUnsafe, createContextualFragment, DOMParser) so the rule holds on an engine without Trusted Types too, and
// removes WebRTC (the other connection CSP has no directive for). The natives live only in this closure: a pack script
// runs after it and cannot get them back. (r5, after the fourth verifier) The STATIC parsers (`Document.parseHTMLUnsafe`,
// `Document.parseHTML`) and `document.execCommand` throw too; `adoptNode` / `importNode` and the element-taking setters
// (`table.caption` / `tHead` / `tFoot`, `document.body`, `select.add`, `options.add`) refuse a loader subtree at the door —
// the system WKWebView on macOS 14/15 (Safari < 26) has NO Trusted Types, so this seal must be complete on its own; a
// MutationObserver removes any loader element that ever appears and tells the wrapper, which closes the widget (after the
// fact: a belt, not the control), and `ready` reports whether Trusted Types exist. (r6, after the fifth verifier) A click
// on a link that targets ANOTHER window (`<a target=_blank>`) makes WebKit open a bare TCP connection to the link's
// host:port even though the sandbox refuses the popup — an `<a>` is not a loader, so the seal never saw it. Now a
// capture-phase listener on `window`, registered before any pack script exists (it runs first and nothing can remove
// it), cancels every click / auxclick / submit whose path holds a link with a target other than `_self`, a `download`
// or `ping`, or a form; `attachShadow` is forced open so a closed shadow root cannot hide such a link from the guard's
// composedPath; the belt treats a `<meta>` as a breach only when it carries `http-equiv`. Render untrusted strings
// (symbols, names, alert text) with textContent. Nothing in a view model names a key, a signer, a cap, a mandate or the gate.
(() => {
  'use strict';
  let sealBreach = null, sealNote = null; // set once the SDK can talk to the wrapper
  // ------------------------------------------------------------------ the DOM seal (r4, r5)
  (() => {
    const LOADERS = new Set(['link', 'meta', 'base', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal', 'fencedframe', 'script']);
    const SEL = [...LOADERS].join(',');
    const N = Node.prototype, E = Element.prototype, D = Document.prototype, F = DocumentFragment.prototype, CD = CharacterData.prototype, DT = DocumentType.prototype;
    const desc = (o, k) => Object.getOwnPropertyDescriptor(o, k);
    const nodeType = desc(N, 'nodeType').get, localName = desc(E, 'localName').get;
    const qsaE = E.querySelectorAll, qsaF = F.querySelectorAll, hasAttribute = E.hasAttribute, getAttribute = E.getAttribute;
    const apply = Reflect.apply;
    const refuse = (what) => { throw new DOMException(`dexterm widget: ${what} is sealed (loaders, nested documents and HTML-string sinks are refused in a pack page; see WIDGETS.md)`, 'NotAllowedError'); };
    // the loader element (local name) a node carries, or null; a non-node is left to the native to reject
    const findIn = (n, set, sel) => {
      if (!n || typeof n !== 'object') return null;
      let t; try { t = apply(nodeType, n, []); } catch { return null; }
      if (t === 1) { const ln = apply(localName, n, []); if (set.has(ln)) return ln; const hit = apply(qsaE, n, [sel]); return hit.length ? apply(localName, hit[0], []) : null; }
      if (t === 11) { const hit = apply(qsaF, n, [sel]); return hit.length ? apply(localName, hit[0], []) : null; }
      return null;
    };
    const loaderIn = (n) => findIn(n, LOADERS, SEL);
    // the kill switch watches the parser too, and the pack's own (hashed) <script> elements arrive through the parser: a
    // runtime <script> has no hash (CSP refuses it) and the insertion guards refuse it anyway, so the watch excludes script
    // (r6) a plain <meta> the parser reaches after this script (a page without </head>, or one in <body>) is harmless — the
    // audit refuses <meta http-equiv> and so does the watch; any other meta is not a breach
    const WATCHED = new Set([...LOADERS].filter((x) => x !== 'script' && x !== 'meta')), WATCH_SEL = [...WATCHED, 'meta[http-equiv]'].join(',');
    const breachIn = (n) => {
      const w = findIn(n, WATCHED, WATCH_SEL); if (w) return w;
      try { if (apply(nodeType, n, []) === 1 && apply(localName, n, []) === 'meta' && apply(hasAttribute, n, ['http-equiv'])) return 'meta'; } catch { /* not an element */ }
      return null;
    };
    const lock = (proto, name, value) => Object.defineProperty(proto, name, { value, writable: false, configurable: false, enumerable: true });
    // which argument(s) a method inserts: 0 = the first, 1 = the second, -1 = all of them
    const guard = (proto, name, which) => {
      const d = desc(proto, name); if (!d || typeof d.value !== 'function') return;
      const native = d.value;
      lock(proto, name, function (...args) {
        if (which === -1) { for (const a of args) { const w = loaderIn(a); if (w) refuse(`inserting <${w}>`); } }
        else { const w = loaderIn(args[which]); if (w) refuse(`inserting <${w}>`); }
        return apply(native, this, args);
      });
    };
    guard(N, 'appendChild', 0); guard(N, 'insertBefore', 0); guard(N, 'replaceChild', 0);
    for (const p of [E, D, F]) { guard(p, 'append', -1); guard(p, 'prepend', -1); guard(p, 'replaceChildren', -1); guard(p, 'moveBefore', 0); }
    for (const p of [E, CD, DT]) { guard(p, 'before', -1); guard(p, 'after', -1); guard(p, 'replaceWith', -1); }
    guard(E, 'insertAdjacentElement', 1);
    if (typeof Range !== 'undefined') { guard(Range.prototype, 'insertNode', 0); guard(Range.prototype, 'surroundContents', 0); }
    // HTML-string sinks: refused outright (Trusted Types refuse them too where the engine has them; this holds everywhere)
    const sinkMethod = (proto, name) => { if (proto && desc(proto, name)) lock(proto, name, function () { refuse(`${name}()`); }); };
    const sinkSetter = (proto, name) => { const d = proto && desc(proto, name); if (d && d.set) Object.defineProperty(proto, name, { get: d.get, set() { refuse(`the ${name} setter`); }, configurable: false, enumerable: d.enumerable }); };
    sinkSetter(E, 'innerHTML'); sinkSetter(E, 'outerHTML'); sinkSetter(typeof ShadowRoot !== 'undefined' ? ShadowRoot.prototype : null, 'innerHTML');
    sinkMethod(E, 'insertAdjacentHTML'); sinkMethod(E, 'setHTML'); sinkMethod(E, 'setHTMLUnsafe');
    if (typeof ShadowRoot !== 'undefined') { sinkMethod(ShadowRoot.prototype, 'setHTML'); sinkMethod(ShadowRoot.prototype, 'setHTMLUnsafe'); }
    sinkMethod(D, 'write'); sinkMethod(D, 'writeln'); sinkMethod(D, 'open');
    if (typeof Range !== 'undefined') sinkMethod(Range.prototype, 'createContextualFragment');
    if (typeof DOMParser !== 'undefined') sinkMethod(DOMParser.prototype, 'parseFromString');
    if (typeof XSLTProcessor !== 'undefined') { sinkMethod(XSLTProcessor.prototype, 'transformToFragment'); sinkMethod(XSLTProcessor.prototype, 'transformToDocument'); }
    // r5: the STATIC parsers (not on any prototype) and the editor command that parses HTML into the document
    for (const name of ['parseHTMLUnsafe', 'parseHTML']) { if (typeof Document[name] === 'function') lock(Document, name, function () { refuse(`Document.${name}()`); }); }
    sinkMethod(D, 'execCommand');
    // r5: a node from ANOTHER document (a parsed one, an XML one) enters this one by adoptNode / importNode, by an insertion
    // method (guarded above) or by an element-taking setter: refuse a loader subtree at every door
    guard(D, 'adoptNode', 0); guard(D, 'importNode', 0);
    const guardSetter = (proto, name) => {
      const d = proto && desc(proto, name); if (!d || !d.set) return;
      const set = d.set;
      Object.defineProperty(proto, name, { get: d.get, set(v) { const w = loaderIn(v); if (w) refuse(`setting ${name} to a subtree with <${w}>`); return apply(set, this, [v]); }, configurable: false, enumerable: d.enumerable });
    };
    if (typeof HTMLTableElement !== 'undefined') for (const k of ['caption', 'tHead', 'tFoot']) guardSetter(HTMLTableElement.prototype, k);
    guardSetter(D, 'body');
    if (typeof HTMLSelectElement !== 'undefined') guard(HTMLSelectElement.prototype, 'add', 0);
    if (typeof HTMLOptionsCollection !== 'undefined') guard(HTMLOptionsCollection.prototype, 'add', 0);
    // r5: the last line — if a loader element ever becomes part of the document anyway (a parsing path this list does not
    // name on some engine, or a parser/audit disagreement in the markup itself), it is removed at once and the wrapper
    // closes the widget. After the fact (the engine may already have acted on it), so a belt, not the control.
    const removeChild = N.removeChild;
    const mo = new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) {
        const w = breachIn(n);
        if (w) { try { const p = n.parentNode; if (p) apply(removeChild, p, [n]); } catch { /* already gone */ } if (sealBreach) sealBreach(w); }
      }
    });
    mo.observe(document, { childList: true, subtree: true });
    // r6: ACTIVATIONS. A click on a link that targets another window makes WebKit open a bare TCP connection to the link's
    // host:port before the sandbox refuses the popup. This listener sits on `window` in the capture phase, registered
    // before any pack script exists: it runs first and nothing can remove it (no reference). It cancels a click /
    // auxclick whose composed path holds a link (`a` / `area`, HTML or SVG) with a target other than `_self` / empty, or a
    // `download` / `ping` attribute, and every form submit (the sandbox refuses forms anyway). A link to our own origin
    // with no target navigates the frame, which the wrapper's frame-src governs (r3).
    const composedPath = Event.prototype.composedPath, preventDefault = Event.prototype.preventDefault, stopImmediate = Event.prototype.stopImmediatePropagation;
    let noted = 0;
    const cancel = (e, why) => { apply(preventDefault, e, []); apply(stopImmediate, e, []); if (sealNote && noted < 5) { noted++; sealNote(why); } };
    const activation = (e) => {
      let path; try { path = apply(composedPath, e, []); } catch { path = []; }
      for (const n of path) {
        let t; try { t = apply(nodeType, n, []); } catch { continue; }
        if (t !== 1) continue;
        const ln = apply(localName, n, []);
        if (ln === 'a' || ln === 'area') {
          const target = (apply(hasAttribute, n, ['target']) ? String(apply(getAttribute, n, ['target']) || '') : '').trim().toLowerCase();
          if ((target && target !== '_self') || apply(hasAttribute, n, ['download']) || apply(hasAttribute, n, ['ping'])) { cancel(e, `refused a ${e.type} on a link that targets another window (${target || 'download/ping'})`); return; }
        }
        if (ln === 'form') { cancel(e, `refused a form ${e.type}`); return; }
      }
    };
    for (const type of ['click', 'auxclick', 'submit']) window.addEventListener(type, activation, { capture: true });
    // a closed shadow root would hide its links from composedPath: every shadow root a pack page makes is open
    { const d = desc(E, 'attachShadow'); if (d && typeof d.value === 'function') { const native = d.value; lock(E, 'attachShadow', function (init, ...rest) { const i = init && typeof init === 'object' ? { ...init, mode: 'open' } : init; return apply(native, this, [i, ...rest]); }); } }
    // WebRTC: a connection with no CSP directive; a pack page has no use for it
    for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCIceTransport', 'RTCDtlsTransport', 'RTCSctpTransport']) {
      if (name in window) lock(window, name, function () { refuse(`${name}`); });
    }
    Object.defineProperty(window, 'dextermSealed', { value: true, writable: false, configurable: false, enumerable: true });
  })();

  // ------------------------------------------------------------------ the SDK
  const meta = (n) => (document.querySelector(`meta[name="${n}"]`) || {}).content || '';
  const KEY = meta('dexterm-widget'), TOPICS = Object.freeze(meta('dexterm-topics').split(',').filter(Boolean)), HOST = meta('dexterm-host');
  // the wrapper is the parent window; a page opened any other way has nobody to talk to and stays inert
  const host = window.parent !== window && /^http:\/\/127\.0\.0\.1:\d+$/.test(HOST) ? window.parent : null;
  const listeners = new Map();
  const last = new Map();
  let theme = {};
  const CSS_TOKENS = ['bg', 'panel', 'panelAlt', 'border', 'borderFocus', 'text', 'muted', 'dim', 'accent', 'up', 'down', 'warn', 'ai', 'pump', 'dbc', 'glow'];
  function send(o) { if (host) { try { host.postMessage(o, HOST); } catch { /* wrapper gone */ } } }
  function applyTheme(t) {
    theme = Object.freeze({ ...theme, ...(t || {}) });
    const r = document.documentElement.style;
    for (const k of CSS_TOKENS) if (typeof theme[k] === 'string') r.setProperty(`--${k}`, theme[k]);
    fire('theme', theme);
  }
  function fire(topic, payload) {
    last.set(topic, payload);
    const fns = listeners.get(topic);
    if (!fns) return;
    for (const fn of [...fns]) { try { fn(payload); } catch (err) { send({ type: 'log', msg: `widget ${KEY} ${topic} handler: ${err && err.message}` }); } }
  }
  function requestClose() { send({ type: 'close' }); }
  sealBreach = (what) => send({ type: 'breach', what: String(what).slice(0, 24) });
  sealNote = (why) => send({ type: 'log', msg: `widget ${KEY}: ${why}`.slice(0, 200) });
  window.addEventListener('message', (e) => {
    if (!host || e.source !== host || e.origin !== HOST) return;
    const m = e.data;
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'hello': if (m.theme) applyTheme(m.theme); break;
      case 'theme': applyTheme(m.tokens || {}); break;
      case 'data': if (typeof m.topic === 'string' && TOPICS.includes(m.topic)) fire(m.topic, m.payload); break;
      case 'ping': send({ type: 'pong' }); break; // r6: the wrapper checks the document is still ours after a frame `load`
      case 'close': document.documentElement.dataset.dexterm = 'closed'; break; // the host closes the window itself
      default: break;
    }
  });
  const api = Object.freeze({
    on(topic, fn) {
      if (typeof fn !== 'function' || typeof topic !== 'string') return api;
      if (!listeners.has(topic)) listeners.set(topic, new Set());
      listeners.get(topic).add(fn);
      if (last.has(topic)) { try { fn(last.get(topic)); } catch (err) { send({ type: 'log', msg: `widget ${KEY} ${topic} handler: ${err && err.message}` }); } }
      return api;
    },
    off(topic, fn) { const s = listeners.get(topic); if (s) s.delete(fn); return api; },
    get theme() { return theme; },
    get topics() { return TOPICS; },
    get key() { return KEY; },
    close: requestClose,
    log(text) { send({ type: 'log', msg: String(text).slice(0, 200) }); },
  });
  Object.defineProperty(window, 'dexterm', { value: api, writable: false, configurable: false, enumerable: true });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') requestClose(); });
  window.addEventListener('error', (e) => send({ type: 'log', msg: `widget ${KEY} error: ${e.message}`.slice(0, 200) }));
  // the pack's own scripts run after this one; `ready` goes out once the document has parsed, so their listeners exist
  // before the wrapper replays the current view models
  const ready = () => send({ type: 'ready', page: `widget:${KEY}`.slice(0, 24), tt: typeof trustedTypes !== 'undefined' });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
