// trenchscope — the per-token SOCIAL panel + AI SUMMARY box (task-1330; INTEGRATIONS-DESIGN §5.2, mockups
// social-panel-{176,120,90}.txt). Drawn by both token renderers (fixture + live) in place of the ON-CHAIN /
// HOLDERS band when `state.tokenSocial` is on. Every post text here has been through the ingest firewall; the
// table clips to the cell width, so a post can never overflow its row or carry an escape sequence.
//
// Columns by breakpoint (design §5.2): 176 age/src/author/tier/cred/vel/post/♥/⟳/dup/flag · 120 drops
// tier/vel/⟳/dup · 90 age/author/cred/post/flag.
import { Canvas, table, badge, breakpoint, mix, wrap, fmtAgeSec, type Column, type Hex } from '@dexterm/tui';
import type { SocialPost } from '@dexterm/data';
import { fmtAgeShort, buildSummaryWindow } from '@dexterm/data';
import type { AppState } from '../state.ts';
import { socialOf, panelPosts, hiddenCounts, fmtVelocity, velocityMarks, TIER_LABEL, platformLabel, flagLabel, postText, authorRate, sourcesLine, xBadge } from '../social/view.ts';

export const SUMMARY_BOX_H = 6;

export interface SocialPanelOpts { mint: string; symbol: string; now: number }

/** Draw the SOCIAL table + AI SUMMARY into [x, x+w) × [y, y+h). Returns the rows drawn. */
export function renderSocialPanel(c: Canvas, x: number, y: number, w: number, h: number, state: AppState, opts: SocialPanelOpts): number {
  const t = c.theme;
  const bp = breakpoint(c.w);
  const feed = socialOf(state);
  const { mint, symbol, now } = opts;
  const sumH = h >= 14 ? SUMMARY_BOX_H : 0;
  const listH = h - sumH;
  if (!feed) {
    const box = c.box(x, y, w, listH, { title: `SOCIAL · $${symbol}`, caption: 'no social feed in this mode' });
    c.textC(box.x, box.y + 1, box.w, 'social layer needs live or fixture mode', { fg: t.muted, bg: box.bg, i: true });
    return 0;
  }
  const row = feed.trendRows().find((r) => r.mint === mint) ?? null;
  const posts = panelPosts(state, mint);
  const hidden = hiddenCounts(feed, mint);
  const filter = state.socialFilter ?? 'all';
  const pph = row ? `${row.postsPerHour.toLocaleString('en-US')} posts/1h` : `${posts.length} posts`;
  const vel = row && row.velocity !== null ? ` (${row.velocity >= 1 ? '▲' : '▼'}${fmtVelocity(row.velocity, row.velocityBasis)} vs 24h mean)` : row ? ' (new)' : '';
  const kols = row ? ` · ${row.kolCount} KOL${row.kolCount === 1 ? '' : 's'}` : '';
  const hid = hidden.spam ? ` · ${hidden.spam} hidden as spam` : '';
  const inj = hidden.injection ? ` · ${hidden.injection} withheld (firewall)` : '';
  const only = state.socialAuthor ? ` · @${state.socialAuthor} only` : '';
  const title = `SOCIAL · $${symbol} · ${pph}${vel}${kols}${hid}${inj}${only} · ${xBadge(feed)}`;
  const cap = `${filter === 'all' ? '' : `filter ${filter} · `}${state.socialShowSpam ? 'x=hide spam' : 'x=show hidden'} · f=filter · K=KOL lists · a=summary`;
  const box = c.box(x, y, w, listH, { title, caption: cap });
  const bg: Hex = box.bg;
  const age = (p: SocialPost) => fmtAgeSec(Math.max(0, Math.round((now - p.t) / 1000)));
  const credOf = (p: SocialPost) => feed.credibilityOfPost(p);
  const credStyle = (n: number) => ({ fg: n >= 70 ? t.up : n >= 40 ? t.text : n >= 20 ? t.muted : t.down, bg });
  const authorFg = (p: SocialPost) => (p.author.tier === 'kol-a' || p.author.tier === 'kol-b' ? t.accent : p.author.tier === 'src' ? t.muted : p.author.tier === 'spam' ? t.down : p.author.tier === 'own' ? t.ai : t.text);
  const colAge: Column<SocialPost> = { key: 'age', label: 'age', w: 4, prio: 0, render: (cv, cx, cy, cw, p, rb) => { cv.text(cx, cy, age(p), { fg: t.dim, bg: rb }, cw); } };
  const colSrc: Column<SocialPost> = { key: 'src', label: 'src', w: 5, prio: 1, render: (cv, cx, cy, cw, p, rb) => { cv.text(cx, cy, platformLabel(p.platform), { fg: p.platform === 'chain' ? t.up : t.muted, bg: rb }, cw); } };
  const colAuthor: Column<SocialPost> = { key: 'author', label: 'author', w: bp === 'compact' ? 13 : 16, prio: 0, render: (cv, cx, cy, cw, p, rb) => { cv.text(cx, cy, p.author.handle, { fg: authorFg(p), bg: rb, b: p.author.tier === 'kol-a' }, cw); } };
  const colTier: Column<SocialPost> = { key: 'tier', label: 'tier', w: 5, prio: 2, render: (cv, cx, cy, cw, p, rb) => { cv.text(cx, cy, TIER_LABEL[p.author.tier], { fg: p.author.tier === 'spam' ? t.down : p.author.tier.startsWith('kol') ? t.accent : t.muted, bg: rb }, cw); } };
  const colCred: Column<SocialPost> = { key: 'cred', label: bp === 'compact' ? 'cr' : 'cred', w: bp === 'compact' ? 3 : 4, align: 'right', prio: 0, render: (cv, cx, cy, cw, p, rb) => { const n = credOf(p); cv.textR(cx, cy, cw, String(n), { ...credStyle(n), bg: rb }); } };
  const colVel: Column<SocialPost> = { key: 'vel', label: 'vel', w: 3, prio: 3, render: (cv, cx, cy, cw, p, rb) => { const n = authorRate(feed, mint, p.author.handle, now); cv.text(cx, cy, n >= 7 ? '▲▲▲' : n >= 4 ? '▲▲' : n >= 2 ? '▲' : '·', { fg: n >= 4 ? t.warn : t.muted, bg: rb }, cw); } };
  const colPost: Column<SocialPost> = { key: 'post', label: bp === 'compact' ? 'post' : 'post (firewalled, truncated)', w: 24, prio: 0, flex: true, render: (cv, cx, cy, cw, p, rb) => {
    const txt = postText(p);
    const fg = p.collapsed ? t.dim : p.flags.includes('injection') ? t.down : p.platform === 'chain' ? t.up : p.platform === 'news' ? t.muted : t.text;
    cv.text(cx, cy, txt, { fg, bg: rb, i: !!p.collapsed }, cw);
  } };
  const colLikes: Column<SocialPost> = { key: 'likes', label: '♥', w: 4, align: 'right', prio: 1, render: (cv, cx, cy, cw, p, rb) => { cv.textR(cx, cy, cw, p.platform === 'x' || p.platform === 'telegram' || p.platform === 'discord' ? String(p.metrics.likes) : '', { fg: t.muted, bg: rb }); } };
  const colReposts: Column<SocialPost> = { key: 'reposts', label: '⟳', w: 4, align: 'right', prio: 3, render: (cv, cx, cy, cw, p, rb) => { cv.textR(cx, cy, cw, p.platform === 'x' ? String(p.metrics.reposts) : '', { fg: t.muted, bg: rb }); } };
  const colDup: Column<SocialPost> = { key: 'dup', label: 'dup', w: 3, align: 'right', prio: 2, render: (cv, cx, cy, cw, p, rb) => { cv.textR(cx, cy, cw, p.dupCount > 1 ? String(p.dupCount) : '', { fg: t.muted, bg: rb }); } };
  const colFlag: Column<SocialPost> = { key: 'flag', label: bp === 'compact' ? 'fl' : 'flag', w: 5, prio: 0, render: (cv, cx, cy, cw, p, rb) => { const f = flagLabel(p); if (f) badge(cv, cx, cy, f.slice(0, cw), f === 'INJ' || f === 'SPAM' || f === 'SQUAT' ? t.down : t.warn, { on: rb }); } };
  const cols: Column<SocialPost>[] = bp === 'compact'
    ? [colAge, colAuthor, colCred, colPost, colFlag]
    : bp === 'standard'
      ? [colAge, colSrc, colAuthor, colCred, colPost, colLikes, colFlag]
      : [colAge, colSrc, colAuthor, colTier, colCred, colVel, colPost, colLikes, colReposts, colDup, colFlag];
  if (posts.length === 0) {
    const xs = feed.status();
    const why = xs.xState === 'logged-out' ? 'x-stream ○ logged out · trenchscope x login (your own X app) · keyless sources: news + on-chain rows'
      : xs.xState === 'ok' ? 'x-stream ● logged in · nothing matched yet (search runs every 60 s for the open token)'
        : `${xBadge(feed)} · ${xs.xDetail} · keyless sources: news + on-chain rows`;
    c.textC(box.x, box.y + 1, box.w, `no posts yet · ${why}`, { fg: xs.xState === 'ok' || xs.xState === 'logged-out' ? t.muted : t.warn, bg, i: true });
    c.text(box.x + 1, box.y, 'age  author  cred  post', { fg: t.dim, bg });
  } else {
    table(c, box.x + 1, box.y, box.w - 2, box.h, { columns: cols, rows: posts, selected: -1, bg, zebra: false });
  }
  if (sumH) renderSummaryBox(c, x, y + listH, w, sumH, state, feed, opts, row?.mint ?? mint, posts.length);
  return posts.length;
}

function renderSummaryBox(c: Canvas, x: number, y: number, w: number, h: number, state: AppState, feed: NonNullable<ReturnType<typeof socialOf>>, opts: SocialPanelOpts, mint: string, shown: number): void {
  const t = c.theme;
  const border = mix(t.border, t.ai, 0.35);
  const box = c.box(x, y, w, h, { title: '✦ AI SUMMARY', titleFg: t.ai, caption: 'model output, not facts', captionFg: t.dim, border });
  const bg: Hex = box.bg;
  const label = `✦ analyst · model output, not facts · sources: ${sourcesLine(feed)}`;
  const win = buildSummaryWindow({ mint, symbol: opts.symbol, posts: feed.postsFor(mint, { includeInjection: true, includeSpam: true, includeHidden: true }), row: null, news: feed.newsFor(mint), ages: feed.ages(), now: opts.now, max: 40 });
  const cached = state.socialSummaries?.get(mint) ?? null;
  const lines: string[] = [];
  if (cached) {
    lines.push(`${label} · ${fmtAgeShort(opts.now - cached.at)} ago`);
    lines.push(...cached.text.split('\n'));
  } else {
    lines.push(label);
    const withheld = `window: ${win.blocks.length} firewalled block${win.blocks.length === 1 ? '' : 's'} (≤ 40 newest) · withheld ${win.withheld.injection} instruction-like, ${win.withheld.spam} spam, ${win.withheld.squat} squat, ${win.withheld.hidden} near-dupes · ${shown} posts in 24 h`;
    lines.push(withheld);
    lines.push(state.live ? 'press  a  to ask the analyst for a ≤4-line read of this window (one claude turn, rate-limited 1 per 2 min); the reply lands in the analyst panel.' : 'fixtures: the analyst summary runs only in live mode (the window above is what it would receive — never the raw posts).');
  }
  let cy = box.y;
  for (const ln of lines) {
    for (const part of wrap(ln, box.w - 2)) { if (cy >= box.y + box.h) return; c.text(box.x + 1, cy, part, { fg: cy === box.y ? t.ai : t.muted, bg, i: cy !== box.y }, box.w - 2); cy += 1; }
  }
}
