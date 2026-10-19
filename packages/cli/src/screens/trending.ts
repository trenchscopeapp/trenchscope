// trenchscope — TRENDING IN THE SPACE (screen T, task-1330; INTEGRATIONS-DESIGN §5.3, mockups trending-feed-*.txt).
// Rank = velocity × credibility, computed locally from the keyless venues + whatever posts the feed holds.
// Sub-panels: NARRATIVES (clusters by shared KOL threads + co-mention; label from the analyst/user, never a
// single post) and NEWS (official RSS, "context, not signal"). `s` swaps NARRATIVES for the SOURCES panel
// (health + ages + errors). Without X the header band says `x-stream ○ logged out` and the board still works.
import { Canvas, table, badge, header, footer, breakpoint, mix, fmtUsd, fmtAgeSec, type Column, type Hex } from '@dexterm/tui';
import type { TrendRow, Narrative, NewsItem } from '@dexterm/data';
import type { AppState } from '../state.ts';
import { headerModel } from '../state.ts';
import { socialOf, kolOf, trendingRows, fmtVelocity, sourcesLine, newsTagLabel } from '../social/view.ts';

const dash = '—';

export function renderTrending(c: Canvas, state: AppState): void {
  const t = c.theme;
  const bp = breakpoint(c.w);
  header(c, headerModel(state));
  const now = state.now.getTime();
  const feed = socialOf(state);
  const top = 2, bottom = c.h - 2; // last row above the footer carries the model-output line
  // row 1 band: the ranking rule + source ages
  c.fill(0, 1, c.w, 1, ' ', { bg: t.bg });
  c.noRain(0, 1, c.w, 1);
  let bx = c.text(1, 1, 'TRENDING IN THE SPACE', { fg: t.borderFocus, bg: t.bg, b: true });
  bx = c.text(bx, 1, '  ·  rank = velocity × credibility  ·  window 1h  ·  ', { fg: t.dim, bg: t.bg }, Math.max(0, c.w - bx - 1));
  if (feed) c.text(bx, 1, sourcesLine(feed), { fg: t.muted, bg: t.bg }, Math.max(0, c.w - bx - 1));
  if (!feed) {
    const box = c.box(0, top, c.w, bottom - top, { title: 'TRENDING', caption: 'no social feed in this mode' });
    c.textC(box.x, box.y + 1, box.w, 'the trending board needs live, replay or fixture mode', { fg: t.muted, bg: box.bg, i: true });
    footer(c, [['esc', 'back'], ['q', 'quit']], t.name);
    return;
  }
  const all = feed.trendRows();
  const rows = trendingRows(state);
  const st = feed.status();
  const nar = state.socialNarrative ?? 0;
  const narratives = feed.narratives();
  const narName = nar > 0 ? (narratives[nar - 1]?.label ?? narratives[nar - 1]?.symbols.slice(0, 3).join(' ') ?? '') : '';
  const filter = state.socialFilter ?? 'all';
  const hiddenCap = `hidden: ${st.hiddenSpam} spam cluster post${st.hiddenSpam === 1 ? '' : 's'}, ${st.hiddenSquats} unverified cashtag squat${st.hiddenSquats === 1 ? '' : 's'}${st.hiddenInjection ? `, ${st.hiddenInjection} withheld (firewall)` : ''}`;
  const title = `TRENDING · ${rows.length} of ${all.length}${filter !== 'all' ? ` · filter ${filter}` : ''}${state.socialAuthor ? ` · @${state.socialAuthor} only` : ''}${narName ? ` · narrative ${narName}` : ''} · ${hiddenCap}`;
  const subH = bp === 'compact' ? Math.min(12, Math.max(6, Math.floor((bottom - top) * 0.4))) : Math.max(6, Math.floor((bottom - top) * 0.36));
  const boardH = bottom - top - subH;
  const box = c.box(0, top, c.w, boardH, { title, caption: bp === 'compact' ? undefined : `${state.socialShowSpam ? 'x=hide' : 'x=show hidden'} · f=filter · n=narrative · s=sources · a=summary`, focus: true });
  const bg: Hex = box.bg;
  const sel = Math.max(0, Math.min(rows.length - 1, state.selected || 0));
  const scroll = Math.max(0, sel - (box.h - 3));
  const credStyle = (n: number) => ({ fg: n >= 70 ? t.up : n >= 40 ? t.text : n >= 20 ? t.muted : t.down, bg });
  const cols: Column<TrendRow>[] = [
    { key: 'rank', label: '#', w: 2, align: 'right', prio: 0, render: (cv, x, y, w, _r, rb, m) => { cv.textR(x, y, w, String(m.index + 1), { fg: m.selected ? t.borderFocus : t.dim, bg: rb }); } },
    { key: 'token', label: 'token', w: 8, prio: 0, render: (cv, x, y, w, r, rb, m) => { cv.text(x, y, r.symbol, { fg: m.selected ? t.borderFocus : t.text, bg: rb, b: true }, w); } },
    { key: 'mint', label: 'mint', w: 11, prio: 3, render: (cv, x, y, w, r, rb) => { cv.text(x, y, `${r.mint.slice(0, 4)}…${r.mint.slice(-4)}`, { fg: t.dim, bg: rb }, w); } },
    { key: 'narrative', label: bp === 'compact' ? 'narr' : 'narrative', w: bp === 'compact' ? 9 : 12, prio: 2, render: (cv, x, y, w, r, rb) => { cv.text(x, y, r.narrative ?? '', { fg: t.muted, bg: rb, i: true }, w); } },
    { key: 'vel', label: 'vel', w: 5, align: 'right', prio: 0, render: (cv, x, y, w, r, rb) => { cv.textR(x, y, w, fmtVelocity(r.velocity, r.velocityBasis), { fg: r.velocity === null ? t.dim : r.velocity >= 5 ? t.up : r.velocity >= 2 ? t.text : t.muted, bg: rb, b: (r.velocity ?? 0) >= 5 }); } },
    { key: 'pph', label: bp === 'compact' ? 'p/h' : 'posts/h', w: bp === 'compact' ? 5 : 7, align: 'right', prio: 1, render: (cv, x, y, w, r, rb) => { cv.textR(x, y, w, r.postsPerHour ? String(r.postsPerHour) : dash, { fg: t.text, bg: rb }); } },
    { key: 'kol', label: 'kol', w: 3, align: 'right', prio: 1, render: (cv, x, y, w, r, rb) => { cv.textR(x, y, w, String(r.kolCount), { fg: r.kolCount ? t.accent : t.dim, bg: rb }); } },
    { key: 'cred', label: bp === 'compact' ? 'cr' : 'cred', w: bp === 'compact' ? 3 : 4, align: 'right', prio: 0, render: (cv, x, y, w, r, rb) => { cv.textR(x, y, w, String(r.credibility), { ...credStyle(r.credibility), bg: rb }); } },
    { key: 'px1h', label: 'px 1h', w: 6, align: 'right', prio: 1, render: (cv, x, y, w, r, rb) => { const v = r.priceChange1h; cv.textR(x, y, w, v === null ? dash : `${v >= 0 ? '+' : ''}${Math.abs(v) >= 100 ? Math.round(v) : v.toFixed(0)}%`, { fg: v === null ? t.dim : v >= 0 ? t.up : t.down, bg: rb }); } },
    { key: 'liq', label: 'liq', w: 6, align: 'right', prio: 2, render: (cv, x, y, w, r, rb) => { cv.textR(x, y, w, r.liq === null ? dash : fmtUsd(r.liq, { digits: 1 }), { fg: t.muted, bg: rb }); } },
    { key: 'sources', label: bp === 'compact' ? 'src' : 'sources', w: bp === 'compact' ? 12 : 15, prio: 1, render: (cv, x, y, w, r, rb) => { const s = r.sources.join('·'); cv.text(x, y, s || dash, { fg: r.venue?.boosted ? t.warn : t.muted, bg: rb }, w); } },
    { key: 'age', label: 'age', w: 4, align: 'right', prio: 2, render: (cv, x, y, w, r, rb) => { cv.textR(x, y, w, fmtAgeSec(Math.max(0, Math.round((now - r.updatedAt) / 1000))), { fg: t.dim, bg: rb }); } },
    { key: 'latest', label: 'latest credible post (firewalled)', w: 22, prio: 4, flex: true, render: (cv, x, y, w, r, rb) => {
      const p = r.latestCrediblePost;
      if (!p) { cv.text(x, y, r.venue ? `— (no credible post; ${r.venue.sources.join('+')} only)` : dash, { fg: t.dim, bg: rb, i: true }, w); return; }
      const who = p.platform === 'news' ? p.author.handle : p.author.handle;
      const cx = cv.text(x, y, `${who}: `, { fg: p.author.tier.startsWith('kol') ? t.accent : t.muted, bg: rb }, w);
      cv.text(cx, y, p.text, { fg: p.platform === 'chain' ? t.up : t.text, bg: rb }, Math.max(0, w - (cx - x)));
    } },
  ];
  if (rows.length === 0) c.textC(box.x, box.y + 2, box.w, all.length ? 'no rows match the filter — f cycles filters, n clears the narrative' : 'nothing trending yet — the keyless venues refresh every 60 s', { fg: t.muted, bg, i: true });
  else table(c, box.x + 1, box.y, box.w - 2, box.h, { columns: cols, rows, selected: sel, scroll, bg });

  // sub-panels
  const sy = top + boardH;
  const news = feed.newsItems(12);
  if (bp === 'compact') {
    const half = Math.floor(subH / 2);
    if (state.socialSources) renderSources(c, 0, sy, c.w, subH, state, feed);
    else { renderNarratives(c, 0, sy, c.w, half, narratives, nar, bg); renderNews(c, 0, sy + half, c.w, subH - half, news, now); }
  } else {
    const leftW = Math.floor(c.w * 0.5);
    if (state.socialSources) renderSources(c, 0, sy, leftW, subH, state, feed);
    else renderNarratives(c, 0, sy, leftW, subH, narratives, nar, bg);
    renderNews(c, leftW, sy, c.w - leftW, subH, news, now);
  }
  // the model-output line above the footer
  const kol = kolOf(state);
  c.fill(0, bottom, c.w, 1, ' ', { bg: t.bg });
  c.noRain(0, bottom, c.w, 1);
  c.text(1, bottom, `✦ model output · KOL lists: ${kol?.summary() ?? 'none'} · credibility = early-entry score × follower quality × on-chain confirmation; never from follower counts alone`, { fg: t.dim, bg: t.bg, i: true }, c.w - 2);
  footer(c, [['⏎', 'open token'], ['n', 'narrative'], ['K', 'KOL lists'], ['f', 'filter'], ['w', 'watch'], ['s', state.socialSources ? 'narratives' : 'sources'], ['x', state.socialShowSpam ? 'hide spam' : 'show hidden'], ['a', 'summary'], ['r', 'refresh'], ['esc', 'back'], ['q', 'quit']], t.name);
}

function renderNarratives(c: Canvas, x: number, y: number, w: number, h: number, narratives: Narrative[], active: number, _bg: Hex): void {
  const t = c.theme;
  const box = c.box(x, y, w, h, { title: 'NARRATIVES · 1h', caption: active ? 'n=next · filtering the board' : 'clusters by shared KOL threads + co-mention · label from the analyst, never one post' });
  let cy = box.y;
  if (narratives.length === 0) { c.textC(box.x, cy, box.w, 'no cross-token clusters yet (needs ≥ 2 tokens sharing a KOL thread or a post)', { fg: t.dim, bg: box.bg, i: true }); return; }
  const maxVel = Math.max(1, ...narratives.map((n) => n.velocity ?? 0));
  narratives.forEach((n, i) => {
    if (cy >= box.y + box.h) return;
    const sel = active === i + 1;
    const label = (n.label ?? 'unlabelled').padEnd(12).slice(0, 12);
    let cx = c.text(box.x + 1, cy, label, { fg: sel ? t.borderFocus : n.label ? t.text : t.dim, bg: box.bg, b: sel, i: !n.label });
    const barW = Math.max(2, Math.min(10, Math.round(((n.velocity ?? 0) / maxVel) * 10)));
    cx = c.text(cx + 1, cy, '▇'.repeat(barW).padEnd(10), { fg: mix(box.bg, t.accent, 0.8), bg: box.bg, soft: true });
    const d = n.delta24h;
    cx = c.textR(cx + 1, cy, 6, d === null ? dash : `${d >= 0 ? '+' : ''}${d.toFixed(0)}%`, { fg: d === null ? t.dim : d >= 0 ? t.up : t.down, bg: box.bg });
    const tail = `${n.symbols.slice(0, 4).join(' ')} · ${n.kolThreads} KOL thread${n.kolThreads === 1 ? '' : 's'}${n.newsCount ? ` · news: ${n.newsCount}` : ''}${n.velocity !== null ? ` · ${fmtVelocity(n.velocity)}` : ''}`;
    c.text(cx + 1, cy, tail, { fg: t.muted, bg: box.bg }, Math.max(0, box.x + box.w - cx - 2));
    cy += 1;
  });
  if (cy + 1 < box.y + box.h) c.rainZone(box.x + 1, cy + 1, box.w - 2, box.y + box.h - cy - 1, 2);
}

function renderNews(c: Canvas, x: number, y: number, w: number, h: number, news: NewsItem[], now: number): void {
  const t = c.theme;
  const box = c.box(x, y, w, h, { title: 'NEWS · official RSS', caption: 'context, not signal' });
  let cy = box.y;
  if (news.length === 0) { c.textC(box.x, cy, box.w, 'no headlines yet (RSS polls every 10 min)', { fg: t.dim, bg: box.bg, i: true }); return; }
  for (const n of news) {
    if (cy >= box.y + box.h) break;
    const tag = newsTagLabel(n);
    let cx = c.text(box.x + 1, cy, fmtAgeSec(Math.max(0, Math.round((now - n.post.t) / 1000))).padStart(3), { fg: t.dim, bg: box.bg });
    cx = c.text(cx + 1, cy, n.domain.replace(/\..*$/, '').slice(0, 10).padEnd(10), { fg: t.muted, bg: box.bg });
    const room = box.x + box.w - 1 - cx - 1 - tag.length - 1;
    const headline = n.post.text.length > room ? n.post.text.slice(0, Math.max(1, room - 2)) + ' …' : n.post.text;
    cx = c.text(cx + 1, cy, headline, { fg: n.tag === 'cross-ref' ? t.text : t.muted, bg: box.bg }, Math.max(0, room));
    c.textR(box.x + 1, cy, box.w - 2, tag, { fg: n.tag === 'security' ? t.down : n.tag === 'cross-ref' ? t.accent : t.dim, bg: box.bg });
    cy += 1;
  }
  if (cy + 1 < box.y + box.h) c.rainZone(box.x + 1, cy + 1, box.w - 2, box.y + box.h - cy - 1, 2);
}

function renderSources(c: Canvas, x: number, y: number, w: number, h: number, state: AppState, feed: NonNullable<ReturnType<typeof socialOf>>): void {
  const t = c.theme;
  const st = feed.status();
  const box = c.box(x, y, w, h, { title: 'SOURCES · keyless', caption: 'health · age · limiter' });
  let cy = box.y;
  const fmt = (ms: number | null) => (ms === null ? dash : ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);
  const buckets = state.live ? state.live.dl.limiter.stats() : [];
  const bucketOf: Record<string, string> = { jup: 'jupiter', gecko: 'geckoterminal', boost: 'dexscreener-slow', cg: 'coingecko', news: 'news-rss' };
  for (const s of st.sources) {
    if (cy >= box.y + box.h) break;
    const glyph = s.state === 'ok' ? '●' : s.state === 'error' ? '◐' : '○';
    const fg = s.state === 'ok' ? t.up : s.state === 'error' ? t.warn : t.dim;
    let cx = c.text(box.x + 1, cy, glyph, { fg, bg: box.bg });
    cx = c.text(cx + 1, cy, s.label.padEnd(10), { fg: t.text, bg: box.bg });
    const xs = s.id === 'x' ? feed.xStatus() : null;
    const detail = xs ? (xs.state === 'ok' ? `${xs.detail}${s.ageMs !== null ? ` · age ${fmt(s.ageMs)}` : ' · nothing read yet'} · ${xs.requests} req this run` : xs.detail)
      : s.state === 'off' ? 'off in this mode' : s.state === 'error' ? `error: ${s.error ?? '?'} · last ok ${fmt(s.ageMs)}` : s.state === 'never' ? 'not fetched yet' : `age ${fmt(s.ageMs)}`;
    cx = c.text(cx + 1, cy, detail, { fg: s.state === 'error' ? t.warn : t.muted, bg: box.bg }, Math.max(0, box.x + box.w - cx - 2));
    const b = buckets.find((k) => k.bucket === (s.id === 'x' ? 'x-api' : bucketOf[s.id]));
    if (b) c.textR(box.x + 1, cy, box.w - 2, `${b.rpmUsed}/${b.budget} rpm${b.pausedUntil ? ' · paused' : ''}`, { fg: t.dim, bg: box.bg });
    cy += 1;
  }
  if (cy < box.y + box.h) { c.text(box.x + 1, cy, `posts stored ${st.posts} (24 h) · hidden spam ${st.hiddenSpam} · squats ${st.hiddenSquats} · withheld ${st.hiddenInjection}`, { fg: t.dim, bg: box.bg, i: true }, box.w - 2); cy += 1; }
  if (cy + 1 < box.y + box.h) c.rainZone(box.x + 1, cy + 1, box.w - 2, box.y + box.h - cy - 1, 2);
}

export { badge };
