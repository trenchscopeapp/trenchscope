// Docs page behaviour: a copy button on every code block, and the contents list that lights the
// section you are reading (after Osmo's Table of Contents for Article, without GSAP: one scroll read
// per frame). Without JavaScript the page reads the same; only the copy buttons are missing.
import { initBasicNavigationBar } from './nav.js?v=20261020-docs3';

const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
initBasicNavigationBar();
const SVG = 'http://www.w3.org/2000/svg';

function copyIcon() {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const outline = document.createElementNS(SVG, 'g');
  outline.setAttribute('class', 'copy-outline');
  const rect = document.createElementNS(SVG, 'rect');
  for (const [k, v] of [['x', '5.5'], ['y', '5.5'], ['width', '8'], ['height', '8'], ['rx', '1.5']]) rect.setAttribute(k, v);
  const back = document.createElementNS(SVG, 'path');
  back.setAttribute('d', 'M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5');
  outline.append(rect, back);
  const check = document.createElementNS(SVG, 'path');
  check.setAttribute('class', 'copy-check');
  check.setAttribute('d', 'm3 8 3 3 7-7');
  svg.append(outline, check);
  return svg;
}

// ---------------------------------------------------------------- copy
for (const block of $$('[data-code]')) {
  const code = block.querySelector('code');
  // the prompt is drawn by CSS, so each line's text is exactly the command
  const text = () => $$('.ln', code).map((l) => l.textContent).join('\n');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'code-copy';
  const label = $$('.ln[data-prompt]', code).length ? 'Copy command' : 'Copy text';
  button.setAttribute('aria-label', label);
  const word = document.createElement('span');
  word.textContent = 'Copy';
  word.setAttribute('role', 'status');
  word.setAttribute('aria-live', 'polite');
  button.append(copyIcon(), word);
  block.append(button);
  let timer = 0;
  button.addEventListener('click', async () => {
    clearTimeout(timer);
    try {
      await navigator.clipboard.writeText(text());
      button.setAttribute('data-done', '');
      word.textContent = 'Copied';
    } catch {
      // select it so it can be copied by hand
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      word.textContent = 'Selected';
    }
    timer = setTimeout(() => { button.removeAttribute('data-done'); word.textContent = 'Copy'; }, 2000);
  });
}

// ---------------------------------------------------------------- contents
const toc = document.querySelector('[data-toc]');
const links = $$('[data-toc-list] a');
const sections = links.map((a) => document.getElementById(a.getAttribute('href').slice(1))).filter(Boolean);
const narrow = window.matchMedia('(max-width: 991px)');

// a card above the article on narrow screens starts folded; beside it, it is always open
const fold = () => { if (toc) toc.open = !narrow.matches; };
fold();
narrow.addEventListener('change', fold);
links.forEach((a) => a.addEventListener('click', () => { if (narrow.matches && toc) toc.open = false; }));

let current = -1;
let raf = 0;
function light() {
  raf = 0;
  const root = getComputedStyle(document.documentElement);
  // --bar-h is in rem; the line sits a little below the bar
  const line = (parseFloat(root.getPropertyValue('--bar-h')) || 3.75) * parseFloat(root.fontSize) + 32;
  let i = 0;
  sections.forEach((s, n) => { if (s.getBoundingClientRect().top <= line) i = n; });
  // the last section can be too short to reach the line; the end of the page lights it
  if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) i = sections.length - 1;
  if (i === current) return;
  current = i;
  links.forEach((a, n) => { if (n === i) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current'); });
}
const schedule = () => { if (!raf) raf = requestAnimationFrame(light); };
if (sections.length) {
  addEventListener('scroll', schedule, { passive: true });
  addEventListener('resize', schedule);
  light();
}
