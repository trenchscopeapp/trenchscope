import { Tour } from './tour.js?v=20261019-ghost1';
import { liveTrench, gpuKind, reveals, sparks, magnet, glare } from './fx.js?v=20261019-soft2';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
const narrowQ = window.matchMedia('(max-width: 767px)');

// Osmo's inline copy confirmation, shared by command and agent controls.
function copyFeedback(button, content, source) {
  const word = $('[data-copy-word]', button);
  const label = button.getAttribute('aria-label');
  // the words follow the button's own case: "copy" in the agent panel, "Copy" on the installer
  const idle = word.textContent.trim();
  const say = (w) => (/^[A-Z]/.test(idle) ? w[0].toUpperCase() + w.slice(1) : w);
  let timer = 0, revision = 0;
  const reset = () => {
    revision++;
    clearTimeout(timer);
    word.textContent = say('copy');
    button.removeAttribute('data-done');
    button.setAttribute('aria-label', label);
  };
  button.addEventListener('click', async () => {
    reset();
    const attempt = revision;
    try {
      await navigator.clipboard.writeText(content());
      if (attempt !== revision) return;
      word.textContent = say('copied');
      button.setAttribute('data-done', '');
      button.setAttribute('aria-label', 'Copied to clipboard');
    } catch {
      if (attempt !== revision) return;
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(source);
      selection.removeAllRanges();
      selection.addRange(range);
      word.textContent = say('retry');
      button.setAttribute('aria-label', 'Copy failed. Text selected for manual copying. Try again');
    }
    timer = setTimeout(reset, 2000);
  });
  return reset;
}

// ---------------------------------------------------------------- install blocks
// The visitor's own OS picks the first tab; the HTML already holds the macOS / Linux command for no-JS.
const platform = navigator.userAgentData?.platform || navigator.platform || '';
const os = /win/i.test(platform) ? 'win' : 'unix';

const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

// The command bar shows a short form of the command, typed in (Osmo Typewriter: a humanised delay per
// character, a longer pause at the pipe). Copy always takes the full commands from the selected tab.
function typer(el) {
  let timer = 0;
  const caret = document.createElement('i');
  caret.className = 'caret';
  caret.setAttribute('aria-hidden', 'true');
  return (text) => {
    clearTimeout(timer);
    if (reduced.matches) { el.textContent = text; el.append(caret); caret.setAttribute('data-blink', ''); return; }
    const node = document.createTextNode('');
    el.replaceChildren(node, caret);
    caret.removeAttribute('data-blink');
    let n = 0;
    const step = () => {
      if (n >= text.length) { caret.setAttribute('data-blink', ''); return; }
      const ch = text[n++];
      node.nodeValue += ch;
      let d = 1000 / 70 + Math.random() * 18 - 6;
      if (ch === ' ') d += Math.random() * 20;
      if (ch === '|') d += 120 + Math.random() * 60;
      if (Math.random() < 0.06) d += 40 + Math.random() * 50;
      timer = setTimeout(step, Math.max(8, d));
    };
    timer = setTimeout(step, 160);
  };
}

// React Bits Rubber Segment: the thumb stretches across the old and new slots, then lands on the new one.
function rubber(thumb, tabs) {
  let handoff = 0;
  const slot = (t) => ({ l: t.offsetLeft, w: t.offsetWidth });
  const set = (l, w) => { thumb.style.transform = `translateX(${l - 3}px)`; thumb.style.width = `${w}px`; };
  const snap = (tab) => { clearTimeout(handoff); thumb.style.transition = 'none'; const s = slot(tab); set(s.l, s.w); };
  const go = (from, to) => {
    clearTimeout(handoff);
    if (reduced.matches || !from) { snap(to); return; }
    const a = slot(from), b = slot(to);
    const l = Math.min(a.l, b.l), r = Math.max(a.l + a.w, b.l + b.w);
    thumb.style.transition = 'transform 190ms cubic-bezier(0.23, 1, 0.32, 1), width 190ms cubic-bezier(0.23, 1, 0.32, 1)';
    set(l, r - l);
    handoff = setTimeout(() => { thumb.style.transition = 'transform 300ms cubic-bezier(0.34, 1.36, 0.64, 1), width 300ms cubic-bezier(0.34, 1.36, 0.64, 1)'; set(b.l, b.w); }, 150);
  };
  return { go, snap };
}

// React Bits Spotlight Card: a soft light follows the pointer inside the card and catches its border
// as the pointer comes near. It settles and stops drawing when nothing moves.
function spotlight(root) {
  const light = $('.inst-light', root), edge = $('.inst-edge', root);
  if (!light || !edge || !finePointer.matches || reduced.matches) return;
  const st = { x: 0, y: 0, p: 0, flare: 0, down: false };
  const ptr = { x: 0, y: 0, on: false };
  let raf = 0, last = 0;
  const paint = () => {
    const size = 260 * (1 + 0.2 * st.flare), x = st.x.toFixed(1), y = st.y.toFixed(1);
    light.style.background = `radial-gradient(circle ${size.toFixed(0)}px at ${x}px ${y}px, rgb(74 222 128 / 0.2), rgb(74 222 128 / 0.05) 45%, transparent 72%)`;
    edge.style.background = `radial-gradient(circle ${(size * 0.6).toFixed(0)}px at ${x}px ${y}px, rgb(74 222 128 / 0.95), rgb(74 222 128 / 0.25) 50%, transparent 80%)`;
    light.style.opacity = String(Math.min(1, st.p * 0.6 * (1 + 0.7 * st.flare)));
    edge.style.opacity = String(Math.min(1, st.p * 0.75 * (1 + 0.7 * st.flare)));
  };
  const tick = (now) => {
    raf = 0;
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000)); last = now;
    const r = root.getBoundingClientRect();
    let tx = st.x, ty = st.y, target = 0;
    if (ptr.on) {
      tx = ptr.x - r.left; ty = ptr.y - r.top;
      const gap = Math.hypot(Math.max(0, -tx, tx - r.width), Math.max(0, -ty, ty - r.height));
      target = gap === 0 ? 1 : Math.max(0, 1 - gap / 90) ** 2;
    }
    if (st.p < 0.02 && target > 0) { st.x = tx; st.y = ty; }
    const follow = 1 - Math.exp(-dt / 0.08);
    st.x += (tx - st.x) * follow; st.y += (ty - st.y) * follow;
    st.p += (target - st.p) * (1 - Math.exp(-dt / (target > st.p ? 0.1 : 0.32)));
    if (Math.abs(target - st.p) < 0.002) st.p = target;
    const press = st.down ? 1 : 0;
    st.flare += (press - st.flare) * (1 - Math.exp(-dt / (press ? 0.05 : 0.28)));
    if (Math.abs(press - st.flare) < 0.002) st.flare = press;
    paint();
    if (Math.abs(tx - st.x) > 0.1 || Math.abs(ty - st.y) > 0.1 || st.p !== target || st.flare !== press) raf = requestAnimationFrame(tick);
  };
  const wake = () => { if (raf) return; last = performance.now(); raf = requestAnimationFrame(tick); };
  addEventListener('pointermove', (e) => {
    ptr.x = e.clientX; ptr.y = e.clientY; ptr.on = true;
    // only wake for a pointer near this card, or to fade out once it has left
    const r = root.getBoundingClientRect();
    if (st.p > 0 || (e.clientX > r.left - 90 && e.clientX < r.right + 90 && e.clientY > r.top - 90 && e.clientY < r.bottom + 90)) wake();
  }, { passive: true });
  document.addEventListener('pointerout', (e) => { if (!e.relatedTarget) { ptr.on = false; wake(); } });
  root.addEventListener('pointerdown', () => { st.down = true; wake(); });
  addEventListener('pointerup', () => { if (st.down) { st.down = false; wake(); } });
}

// Osmo Button 069: on hover the word's letters rotate once around, then settle.
function shuffle(button) {
  const word = $('[data-copy-word]', button);
  if (!finePointer.matches || reduced.matches) return;
  let timer = 0, original = '';
  const stop = () => {
    clearInterval(timer); timer = 0;
    if (original && !button.hasAttribute('data-done')) word.textContent = original;
  };
  button.addEventListener('pointerenter', () => {
    if (button.hasAttribute('data-done') || timer) return;
    original = word.textContent;
    let s = original, tick = 0;
    timer = setInterval(() => {
      s = s.slice(-1) + s.slice(0, -1);
      word.textContent = s;
      if (++tick >= original.length) stop();
    }, 46);
  });
  button.addEventListener('pointerleave', stop);
  // stop before copy feedback writes its own word
  button.addEventListener('pointerdown', () => { clearInterval(timer); timer = 0; if (original) word.textContent = original; });
}

$$('[data-install]').forEach((box, n) => {
  const show = $('[data-cmd-show]', box);
  const full = $('[data-cmd-full]', box);
  const note = $('[data-note-out]', box);
  const src = $('[data-src-out]', box);
  const srcLabel = $('[data-src-label-out]', box);
  const panel = $('[data-panel]', box);
  const tabs = $$('[role="tab"]', box);
  const copy = $('[data-copy]', box);
  const type = typer(show);
  const thumb = rubber($('.seg-thumb', box), tabs);
  let lines = [], current = null;
  const resetCopy = copyFeedback(copy, () => lines.join('\n'), show);
  // one shared panel per block: every tab controls it, and it is named by the selected tab
  panel.id = `install-panel-${n}`;
  tabs.forEach((t, i) => { t.id = `install-tab-${n}-${i}`; t.setAttribute('aria-controls', panel.id); });
  const pick = (tab, animate = true) => {
    if (tab === current) return;
    resetCopy();
    for (const t of tabs) { t.setAttribute('aria-selected', String(t === tab)); t.tabIndex = t === tab ? 0 : -1; }
    panel.setAttribute('aria-labelledby', tab.id);
    lines = tab.dataset.cmd.split('\n');
    full.textContent = lines.join(', then ');
    show.title = lines.join('\n');
    type(tab.dataset.show);
    note.textContent = tab.dataset.note;
    // what the command runs, one click away: the install script itself or the npm package
    src.href = tab.dataset.src; srcLabel.textContent = tab.dataset.srcLabel;
    if (animate) thumb.go(current, tab); else thumb.snap(tab);
    current = tab;
  };
  // the visitor's own OS picks the first tab; the HTML already holds the macOS / Linux command for no-JS
  pick(tabs.find((t) => t.dataset.os === os) ?? tabs[0], false);
  const resnap = () => current && thumb.snap(current);
  new ResizeObserver(resnap).observe(box);
  document.fonts.ready.then(resnap);
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => pick(tab));
    tab.addEventListener('keydown', (e) => {
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      const next = tabs[(to + tabs.length) % tabs.length];
      next.focus(); pick(next);
    });
  });
  spotlight(box);
  shuffle(copy);
});

// ---------------------------------------------------------------- agent hookup
// One read-only server, `npx -y trenchscope mcp` (the form the README, the plugin and the MCP registry
// entry use: it runs with or without trenchscope on PATH, which desktop apps often do not inherit).
const MCP = { command: 'npx', args: ['-y', 'trenchscope', 'mcp'] };
const json = (root, extra = {}) => {
  // two-space JSON with the args array kept on one line, the way people write these files
  const args = `[${MCP.args.map((a) => JSON.stringify(a)).join(', ')}]`;
  const lines = Object.entries({ command: MCP.command, ...extra }).map(([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  return `{\n  ${JSON.stringify(root)}: {\n    "trenchscope": {\n${lines.join('\n')}\n      "args": ${args}\n    }\n  }\n}`;
};
const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=trenchscope&config=${btoa(JSON.stringify(MCP))}`;
const AGENTS = {
  claude: { name: 'Claude Code', cli: 'claude mcp add trenchscope -- npx -y trenchscope mcp', file: '.mcp.json in your project', config: json('mcpServers') },
  codex: { name: 'Codex', cli: 'codex mcp add trenchscope -- npx -y trenchscope mcp', file: '~/.codex/config.toml', config: '[mcp_servers.trenchscope]\ncommand = "npx"\nargs = ["-y", "trenchscope", "mcp"]' },
  cursor: { name: 'Cursor', link: cursorLink, step: 'Open the link; Cursor asks before it adds the server', file: '~/.cursor/mcp.json', config: json('mcpServers') },
  gemini: { name: 'Gemini CLI', cli: 'gemini mcp add -s user trenchscope npx -- -y trenchscope mcp', file: '~/.gemini/settings.json', config: json('mcpServers') },
  vscode: { name: 'VS Code (Copilot)', cli: 'code --add-mcp "{\\"name\\":\\"trenchscope\\",\\"command\\":\\"npx\\",\\"args\\":[\\"-y\\",\\"trenchscope\\",\\"mcp\\"]}"', file: '.vscode/mcp.json in your workspace', config: json('servers') },
};

(function agents() {
  const root = $('[data-agents]');
  if (!root) return;
  const tabs = $$('[role="tab"]', root);
  const modes = $$('[data-mode]', root);
  const code = $('[data-agent-code]', root);
  const title = $('[data-agent-title]', root);
  const step = $('[data-agent-step]', root);
  const open = $('[data-agent-open]', root);
  const copy = $('[data-agent-copy]', root);
  const panel = $('#agents-panel', root);
  const tabThumb = rubber($('.agents-rail .seg-thumb', root), tabs);
  const modeThumb = rubber($('.agents-mode .seg-thumb', root), modes);
  let agent = 'claude', mode = 'cli', text = '', onTab = null, onMode = null;
  const resetCopy = copyFeedback(copy, () => text, code);
  tabs.forEach((t) => { t.id = `agent-${t.dataset.agent}`; t.setAttribute('aria-controls', panel.id); });

  const render = (animate = true) => {
    resetCopy();
    const a = AGENTS[agent];
    const cli = mode === 'cli';
    text = cli ? (a.link ?? a.cli) : a.config;
    title.textContent = `Connect ${a.name}`;
    step.textContent = cli ? (a.step ?? 'Run this in your terminal') : `Add to ${a.file}`;
    // a command sits in the bar after its prompt, like the installer; a link or a config file is plain text
    code.textContent = text;
    code.title = cli ? text : '';
    root.dataset.mode = mode;
    root.toggleAttribute('data-link', cli && !!a.link);
    open.hidden = !(cli && a.link);
    if (a.link) open.href = a.link;
    for (const t of tabs) { const on = t.dataset.agent === agent; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; }
    panel.setAttribute('aria-labelledby', `agent-${agent}`);
    for (const m of modes) m.setAttribute('aria-pressed', String(m.dataset.mode === mode));
    const tab = tabs.find((t) => t.dataset.agent === agent), md = modes.find((m) => m.dataset.mode === mode);
    if (animate) { tabThumb.go(onTab, tab); modeThumb.go(onMode, md); } else { tabThumb.snap(tab); modeThumb.snap(md); }
    onTab = tab; onMode = md;
  };

  tabs.forEach((t, i) => {
    t.addEventListener('click', () => { agent = t.dataset.agent; render(); });
    t.addEventListener('keydown', (e) => {
      const to = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      const next = tabs[(to + tabs.length) % tabs.length];
      agent = next.dataset.agent; render(); next.focus();
    });
  });
  // the chosen format stays as you move between agents
  modes.forEach((m) => m.addEventListener('click', () => { mode = m.dataset.mode; render(); }));
  render(false);
  const resnap = () => { if (onTab) tabThumb.snap(onTab); if (onMode) modeThumb.snap(onMode); };
  new ResizeObserver(resnap).observe(root);
  document.fonts.ready.then(resnap);
  spotlight(root);
  shuffle(copy);
})();

// ---------------------------------------------------------------- stage
const KEY_LABEL = { trenchscope: 'launch', j: 'next row', '⏎': 'open the coin', a: 'ask the analyst', 2: 'new pairs', 3: 'watchlist' };
// what happens in each chapter, read off the same sample frames: [tone, kind, subject, detail]
const EVENTS = {
  boot: [['up', 'link', 'dexscreener', 'pair search'], ['up', 'link', 'jupiter', 'tokens and prices'], ['up', 'link', 'geckoterminal', '60 hourly candles'], ['up', 'link', 'rugcheck', 'mint, freeze, LP'], ['', 'local', 'claude -p', 'your own login']],
  screener: [['', 'screen', 'vol24 > 250K', '34 tokens'], ['up', '24h', 'SIGMA', '▲45.3%'], ['dn', '24h', 'GOAT', '▼61.8%'], ['', 'risk', 'GIGA', 'p(rug) 0.02'], ['up', 'safety', 'GIGA', 'mint and freeze revoked']],
  token: [['up', 'buy', 'GIGA', '$290 at $0.0828'], ['dn', 'sell', 'GIGA', '$26 at $0.0833'], ['up', 'lp', 'GIGA', 'locked 100%'], ['', 'rugcheck', 'GIGA', '27/100'], ['warn', 'analyst', 'speculative', 'conf 0.44']],
  newpairs: [['', 'new', 'WAGMI', '9% bonded'], ['up', 'bonding', 'BOOP', '97% to PumpSwap'], ['', 'migrated', 'GRIDLOCK', 'DBC'], ['up', '1h', 'GRIDLOCK', '▲85.5%'], ['dn', '5m', 'GRIDLOCK', '▼12.7%']],
  analyst: [['', 'tool', 'screener_query', '38ms'], ['', 'tool', 'get_holders_delta', '212ms'], ['up', 'rank', 'SIGMA', 'leads on holder velocity'], ['warn', 'watch', 'BOME', 'rule added, no trade']],
  watchlist: [['up', 'price', 'GOAT', 'crossed +25% 1h'], ['', 'holders', 'ACT', '+312 in 10m'], ['dn', 'risk', 'CLAUDE', 'dev sold 60%'], ['', 'migration', 'RATTO', 'to PumpSwap'], ['warn', 'ai', 'MANEKI', 'thesis invalidated']],
};
function showEvents(id) {
  const list = $('[data-events]');
  const items = EVENTS[id];
  if (!list || !items) return;
  list.replaceChildren(...items.map(([tone, kind, what, detail], i) => {
    const li = document.createElement('li');
    if (tone) li.className = `tone-${tone}`;
    const k = document.createElement('span'); k.className = 'kind'; k.textContent = kind;
    const d = document.createElement('span'); d.className = 'd'; d.textContent = detail;
    li.append(k, what, d);
    li.setAttribute('data-in', '');
    li.style.setProperty('--i', String(i));
    return li;
  }));
}
// one line per chapter in the rail, so a dense screen says what to look at
const CAPTION = {
  boot: 'Starts in your terminal. No account, no keys.',
  screener: 'Compare volume, liquidity and risk in one view.',
  token: 'Open a coin: chart, holders, live tape and on-chain safety.',
  newpairs: 'Fresh pairs as they land, with bonding progress.',
  analyst: 'Ask your own claude or codex login about what is on screen.',
  watchlist: 'Coins you watch, with alerts stored on your machine.',
};

/** Scale a <pre> of cells to fill its box, keeping the terminal's aspect. */
function fit(box, pre, cols, rows) {
  const measure = () => {
    // offsetWidth is the untransformed layout width of the grid
    const w = pre.offsetWidth || cols * 8.4;
    const s = box.clientWidth / w;
    pre.style.transform = `scale(${s})`;
    box.style.height = `${rows * 18 * s}px`;
  };
  new ResizeObserver(measure).observe(box);
  // the mono face loads only once cells use it, so wait for that face, not just fonts.ready
  document.fonts.load('400 14px "JetBrains Mono"').then(measure, measure);
  document.fonts.load('700 14px "JetBrains Mono"').then(measure, measure);
  measure();
}

async function load(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function stage() {
  const pre = $('[data-tour="main"]');
  const box = $('[data-fit]');
  const doc = await load(narrowQ.matches ? 'tour-narrow.json' : 'tour.json');
  $('[data-size]').textContent = `${doc.w}×${doc.h}`;
  $('[data-wait]')?.remove();

  // the chapter pill: six tabs (three per row on phones) with one indicator that slides to the current one
  const nav = $('[data-chapters]');
  const pill = $('[data-pill]');
  const progress = $('[data-progress]');
  const items = doc.chapters.map((c, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab';
    b.innerHTML = `<span>${c.label}</span>${c.key ? `<kbd>${c.key === 'trenchscope' ? '$' : c.key}</kbd>` : ''}`;
    b.addEventListener('click', () => {
      tour.show(i, reduced.matches ? last(i) : 0);
      if (c.key) key(c.key);
      // a chosen screen stays chosen: it plays through once and holds; Play moves the tour on
      if (reduced.matches) setHand(true); else { tour.hold = true; setHand(false); }
    });
    nav.appendChild(b);
    return b;
  });
  const place = (i) => { const n = narrowQ.matches ? 3 : 6; pill.style.setProperty('--col', String(i % n)); pill.style.setProperty('--row', String(Math.floor(i / n))); };
  narrowQ.addEventListener('change', () => place(Math.max(0, shown)));
  // a chapter change crossfades out of a slight blur instead of cutting
  const fade = () => {
    if (reduced.matches || !pre.animate) return;
    pre.animate([{ opacity: 0, filter: 'blur(3px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 520, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
  };

  const hud = $('[data-hud]');
  let hudTimer = 0;
  const key = (k) => {
    $('[data-hud-key]', hud).textContent = k === 'trenchscope' ? '$' : k;
    $('[data-hud-label]', hud).textContent = k === 'trenchscope' ? 'trenchscope' : KEY_LABEL[k] ?? '';
    hud.setAttribute('data-on', '');
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => hud.removeAttribute('data-on'), 1500);
    // the key press ripples out through the live trench from where it lands on the screen
    const r = hud.getBoundingClientRect();
    if (r.bottom > 0 && r.top < innerHeight) window.dispatchEvent(new CustomEvent('ts:pulse', { detail: { x: r.left + r.width / 2, y: r.top + r.height / 2 } }));
  };

  let shown = -1;
  const cap = $('[data-chapter-cap]');
  const onChapter = (ch, p) => {
    if (ch !== shown) {
      items.forEach((b, i) => { if (i === ch) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
      place(ch);
      const c = doc.chapters[ch];
      if (cap && c) { cap.innerHTML = ''; const b = document.createElement('b'); b.textContent = `${c.label} `; cap.append(b, CAPTION[c.id] ?? ''); }
      if (c) showEvents(c.id);
      if (shown !== -1) fade();
      shown = ch;
    }
    progress.style.setProperty('--p', String(p));
  };

  const tour = new Tour(pre, doc, { onChapter, onKey: key, loopFrom: 1 });
  fit(box, pre, doc.w, doc.h);

  // reduced motion: no frames play, but the tour still steps through every screen, each at its finished state
  const last = (ch) => tour.list[ch].frames.length - 1;
  // the 60-column launch banner is a mosaic at phone width, so phones open on the screener
  if (narrowQ.matches && !reduced.matches) tour.show(1, 0);
  if (reduced.matches) tour.show(1, last(1));
  let stepTimer = 0;
  const stepStill = () => {
    const next = tour.ch + 1 >= tour.list.length ? 1 : tour.ch + 1;
    tour.show(next, last(next));
    if (tour.list[next].key) key(tour.list[next].key);
  };

  // play while on screen; pause when the tab is hidden, a mouse rests on the screen, or by hand.
  // Touch never pauses it: a tap fires pointerenter with no matching leave.
  const toggle = $('[data-toggle]');
  const live = $('[data-live]');
  const caption = $('[data-caption]');
  let byHand = false, visible = false, hover = false;
  const sync = () => {
    const go = visible && !byHand && !hover && !document.hidden;
    // the live dot and the caption say whether it is playing
    live.toggleAttribute('data-paused', byHand || hover);
    caption.textContent = hover && !byHand ? 'Paused · move away to resume' : byHand ? 'Paused' : 'Sample data, drawn by trenchscope cell for cell';
    if (reduced.matches) {
      clearInterval(stepTimer);
      if (go) stepTimer = setInterval(stepStill, 5000);
      return;
    }
    if (go) tour.play(); else tour.pause();
  };
  new IntersectionObserver((es) => { visible = es[0].isIntersecting; sync(); }, { threshold: 0.2 }).observe(box);
  document.addEventListener('visibilitychange', sync);
  // only the screen pauses on hover, so the rail's tabs and Pause stay usable while the pointer is on them
  const scene = $('.screen');
  scene.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'mouse') return; hover = true; sync(); });
  scene.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'mouse') return; hover = false; sync(); });
  function setHand(v) {
    byHand = v;
    toggle.setAttribute('aria-pressed', String(byHand));
    $('[data-toggle-word]', toggle).textContent = byHand ? 'Play' : 'Pause';
    $('[data-icon-pause]', toggle).toggleAttribute('hidden', byHand);
    $('[data-icon-play]', toggle).toggleAttribute('hidden', !byHand);
    sync();
  }
  toggle.addEventListener('click', () => { tour.hold = false; setHand(!byHand); });
  tour.onHold = () => setHand(true);

  // a slight lean toward the pointer (after Osmo's 3D perspective hover), fine pointers only
  const lean = $('[data-lean]');
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches && !reduced.matches) {
    let raf = 0, px = 0, py = 0;
    window.addEventListener('pointermove', (e) => {
      px = e.clientX; py = e.clientY;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const r = lean.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) return;
        const nx = Math.max(-1, Math.min(1, (px - (r.left + r.width / 2)) / (r.width / 2)));
        const ny = Math.max(-1, Math.min(1, (py - (r.top + r.height / 2)) / (r.height / 2)));
        lean.style.setProperty('--ry', `${(nx * 1.2).toFixed(2)}deg`);
        lean.style.setProperty('--rx', `${(-ny * 0.9).toFixed(2)}deg`);
      });
    }, { passive: true });
  }
}

// the analyst panel on its own: the token chapter's analyst panel (site-frames.mjs writes it to
// tour-analyst.json), playing its answer. It rests on the answered frame; on first view it plays once.
async function crop() {
  const pre = $('[data-tour="crop"]');
  const box = $('[data-fit-crop]');
  const doc = await load('tour-analyst.json');
  // the panel's answer reads to a clean break at row 21 (the verdict and its five reasons), and its very last frame is mid-scramble, so it rests on the last clean frame
  const ROWS = Math.min(doc.h, 21);
  const t = new Tour(pre, doc, { loopFrom: 0, crop: [0, doc.w, 0, ROWS] });
  const frames = t.list[0].frames;
  const SCRAMBLE = /[∷⋮⋯╳◇◆]/;
  const clean = (k) => !frames[k][0].some((id) => doc.rows[id].some(([s]) => SCRAMBLE.test(s)));
  let end = frames.length - 1;
  while (end > 0 && !clean(end)) end--;
  t.show(0, end);
  fit(box, pre, doc.w, ROWS);
  if (reduced.matches) return;
  // the answer starts streaming 2 s into the token chapter (site-frames.mjs: thinking at 6.4 s, streaming at 8.4 s)
  let start = 0;
  for (let acc = 0; start < end && acc + frames[start][1] <= 2 * t.doc.fps; start++) acc += frames[start][1];
  let played = false;
  const io = new IntersectionObserver((es) => {
    if (!es[0].isIntersecting || played) return;
    played = true; io.disconnect();
    t.show(0, start);
    const hold = () => { if (t.fr >= end) { t.pause(); t.show(0, end); } else requestAnimationFrame(hold); };
    t.play(); requestAnimationFrame(hold);
  }, { threshold: 0.4 });
  io.observe(box);
}

// the live trench runs only on a hardware GPU; a software renderer keeps the light glyph field
gpuKind().then((kind) => { if (kind !== 'software') liveTrench(document.querySelector('.ascii-bg')); });
reveals();
sparks();
magnet();
glare(document.querySelector('.screen'));

// the two screens load on their own, so one failing never blanks the other
// A failed screen says so in its own frame, and the controls that would act on it step aside.
const failed = (sel) => (err) => {
  console.error(err);
  const box = $(sel);
  box.closest('section').setAttribute('data-failed', '');
  box.style.height = '';
  box.innerHTML = '<p class="screen-msg">The tour could not load. Every screen in it is trenchscope itself: install it and run <code>trenchscope --fixtures</code> to see them with sample data.</p>';
};
stage().catch(failed('[data-fit]'));
crop().catch(failed('[data-fit-crop]'));

// ---------------------------------------------------------------- glyph field
// A sparse ASCII field over the whole background: a few cells hold a glyph, a few of those change or
// go dark each tick, the way the app decrypts text. Denser toward the bottom, where the trench is.
(function field() {
  const cv = document.querySelector('[data-field]');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const GLYPHS = '.·:+x*=%#$';
  const CELL = 15;
  let cols = 0, rows = 0, cells = [], dpr = 1, raf = 0, last = 0;
  const seed = (y) => Math.random() < 0.012 + 0.05 * (y / rows) ** 2.2;
  const pick = () => GLYPHS[Math.floor(Math.random() ** 1.6 * GLYPHS.length)];
  function size() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    cols = Math.ceil(innerWidth / CELL * 1.65); rows = Math.ceil(innerHeight / CELL);
    cells = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (seed(y)) cells.push({ x, y, g: pick(), a: 0.05 + Math.random() * 0.13 });
    draw();
  }
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    ctx.font = '400 12px "JetBrains Mono", monospace';
    ctx.textBaseline = 'top';
    const cw = CELL / 1.65;
    for (const c of cells) { if (c.a <= 0) continue; ctx.fillStyle = `rgba(237,237,237,${c.a.toFixed(3)})`; ctx.fillText(c.g, c.x * cw, c.y * CELL); }
  }
  function tick(now) {
    // the live trench draws its own sky once it is running
    if (cv.parentElement.classList.contains('gl')) { cancelAnimationFrame(raf); return; }
    raf = requestAnimationFrame(tick);
    if (now - last < 110) return;
    last = now;
    for (let i = 0; i < cells.length * 0.04; i++) {
      const c = cells[Math.floor(Math.random() * cells.length)];
      if (Math.random() < 0.25) c.a = c.a > 0 ? 0 : 0.05 + Math.random() * 0.13; else c.g = pick();
    }
    draw();
  }
  size();
  let t = 0;
  addEventListener('resize', () => { clearTimeout(t); t = setTimeout(size, 150); });
  document.fonts.load('400 12px "JetBrains Mono"').then(draw, draw);
  if (reduced.matches) return;
  const run = () => { cancelAnimationFrame(raf); if (!document.hidden) raf = requestAnimationFrame(tick); };
  document.addEventListener('visibilitychange', run);
  run();
})();
