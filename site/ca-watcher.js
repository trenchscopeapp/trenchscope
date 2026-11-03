// The contract address row in the hero. It shows `tba` until /api/ca reports the coin
// live (proven on chain by @nullxnothing/solana-launch-kit/ca-watch), then the address
// with a copy button. The reserved address never reaches the browser before that.
export function liveAddress(status) {
  return status?.state === 'live' && typeof status.ca === 'string'
    && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(status.ca) ? status.ca : null;
}

const SVG = 'http://www.w3.org/2000/svg';
function icon() {
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

export function mountCaWatcher(root, { endpoint = '/api/ca', intervalMs = 5000 } = {}) {
  const label = document.createElement('span');
  label.className = 'ca-label';
  label.textContent = 'CA';
  const value = document.createElement('span');
  value.className = 'ca-value';
  value.textContent = 'tba';
  const note = document.createElement('span');
  note.className = 'ca-note';
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ca-copy';
  button.hidden = true;
  const word = document.createElement('span');
  word.textContent = 'Copy';
  button.append(icon(), word);
  root.dataset.state = 'pending';
  root.replaceChildren(label, value, button, note);

  let address = null;
  let timer;
  let copiedTimer;
  let reading = false;

  const check = async () => {
    if (reading || address || root.hidden || document.hidden) return;
    reading = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Unavailable');
      const body = await response.json();
      const next = liveAddress(body);
      if (next) {
        address = next;
        root.dataset.state = 'live';
        value.textContent = next;
        value.title = next;
        button.hidden = false;
        button.setAttribute('aria-label', `Copy the contract address ${next}`);
        note.textContent = '';
      } else if (body?.state === 'unset') {
        root.hidden = true;
      } else {
        note.textContent = 'announced at launch';
      }
    } catch {
      note.textContent = 'announced at launch';
    } finally {
      clearTimeout(timeout);
      reading = false;
      if (!address && !root.hidden) timer = setTimeout(check, intervalMs);
    }
  };

  button.addEventListener('click', async () => {
    if (!address) return;
    clearTimeout(copiedTimer);
    try {
      await navigator.clipboard.writeText(address);
      button.dataset.done = '';
      word.textContent = 'Copied';
      note.textContent = 'address copied';
    } catch {
      // Select the address so it can be copied by hand.
      const range = document.createRange();
      range.selectNodeContents(value);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      note.textContent = 'select the address to copy it';
    }
    copiedTimer = setTimeout(() => {
      delete button.dataset.done;
      word.textContent = 'Copy';
      note.textContent = '';
    }, 2400);
  });

  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (!document.hidden) void check();
  });
  void check();
}

if (typeof document !== 'undefined') {
  document.querySelectorAll('[data-ca-watcher]').forEach(root => mountCaWatcher(root));
}
