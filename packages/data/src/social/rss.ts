// @dexterm/data — publishers' RSS as the NEWS column (task-1330; design §4 "context, not signal").
// Four official feeds, polled every 10 minutes through the shared HttpClient (`news-rss` source,
// polite bucket), parsed with a small dependency-free RSS 2.0 / Atom reader. Headlines are untrusted
// text and go through the ingest firewall like any post; links are kept as `url` (opened by the OS
// browser on ⏎, never fetched by dexterm).

import type { HttpClient } from '../http.ts';
import type { NewsTag, RawPost } from './model.ts';

export interface RssFeedSpec { id: string; url: string; domain: string; label: string }

export const RSS_FEEDS: RssFeedSpec[] = [
  { id: 'coindesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', domain: 'coindesk.com', label: 'coindesk' },
  { id: 'cointelegraph', url: 'https://cointelegraph.com/rss', domain: 'cointelegraph.com', label: 'cointelegr' },
  { id: 'theblock', url: 'https://www.theblock.co/rss.xml', domain: 'theblock.co', label: 'theblock' },
  { id: 'decrypt', url: 'https://decrypt.co/feed', domain: 'decrypt.co', label: 'decrypt' },
];

export const NEWS_REFRESH_MS = 10 * 60_000;
const META = { source: 'news-rss', bucket: 'news-rss' } as const;

export interface RssItem {
  title: string;
  link: string | null;
  /** Epoch ms from pubDate / dc:date / updated / published; null when unparsable. */
  publishedAt: number | null;
  guid: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
  if (!m) return null;
  let v = m[1].trim();
  const cd = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
  if (cd) v = cd[1];
  return decodeEntities(v.replace(/<[^>]+>/g, '')).trim();
}

/** RSS 2.0 `<item>` and Atom `<entry>` → RssItem[], newest first; items without a title are dropped. */
export function parseRss(xml: string): RssItem[] {
  const out: RssItem[] = [];
  const blocks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  for (const b of blocks) {
    const title = tag(b, 'title');
    if (!title) continue;
    let link = tag(b, 'link');
    if (!link) {
      const atom = /<link[^>]*href="([^"]+)"/i.exec(b);
      link = atom ? decodeEntities(atom[1]) : null;
    }
    if (link && !/^https?:\/\//i.test(link)) link = null;
    const dateText = tag(b, 'pubDate') ?? tag(b, 'dc:date') ?? tag(b, 'updated') ?? tag(b, 'published');
    const t = dateText ? Date.parse(dateText) : NaN;
    const guid = tag(b, 'guid') ?? tag(b, 'id') ?? link ?? title;
    out.push({ title, link, publishedAt: Number.isFinite(t) ? t : null, guid });
  }
  return out.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
}

const TAG_RULES: [NewsTag, RegExp][] = [
  ['security', /\b(hack|hacked|exploit|drain|drains|drained|breach|phishing|stolen|theft|scam|rug|malware|vulnerab)/i],
  ['regulation', /\b(sec\b|cftc|regulat|lawsuit|court|judge|congress|senate|bill\b|ban\b|bans\b|barred|fine\b|fines\b|seize|settlement|attorney general|treasury)/i],
  ['solana', /\b(solana|sol\b|pump\.?fun|jupiter|raydium|meteora|memecoin|meme coin|phantom)/i],
  ['macro', /\b(fed\b|rates?\b|inflation|cpi|etf|bitcoin|btc|ethereum|eth\b|market|stocks?|treasur|dollar|tariff)/i],
];

/** Keyword bracket for the NEWS panel (`[macro]`, `[security]`, …): rules, not a judgement. */
export function newsTag(title: string): NewsTag {
  for (const [t, re] of TAG_RULES) if (re.test(title)) return t;
  return 'other';
}

export function rssItemToRaw(item: RssItem, feed: RssFeedSpec, fetchedAt: number): RawPost {
  return {
    id: `news:${feed.id}:${item.guid}`.slice(0, 200),
    t: item.publishedAt ?? fetchedAt,
    platform: 'news',
    author: { id: feed.domain, handle: feed.domain, tier: 'src', createdAt: null },
    text: item.title,
    url: item.link,
    lang: null,
    metrics: {},
    mints: [],
    source: 'news-rss',
    fetchedAt,
  };
}

export class NewsRss {
  private readonly http: HttpClient;
  readonly feeds: RssFeedSpec[];

  constructor(http: HttpClient, feeds: RssFeedSpec[] = RSS_FEEDS) {
    this.http = http;
    this.feeds = feeds;
  }

  async fetch(feed: RssFeedSpec): Promise<{ items: RssItem[]; fetchedAt: number }> {
    const r = await this.http.getText(feed.url, META);
    return { items: parseRss(r.data), fetchedAt: r.fetchedAt };
  }

  /** All feeds, sequential (the bucket paces); each failure is a caption, never a throw. */
  async fetchAll(): Promise<{ posts: RawPost[]; errors: Record<string, string>; fetchedAt: number | null }> {
    const posts: RawPost[] = [];
    const errors: Record<string, string> = {};
    let fetchedAt: number | null = null;
    for (const f of this.feeds) {
      try {
        const r = await this.fetch(f);
        fetchedAt = Math.max(fetchedAt ?? 0, r.fetchedAt);
        for (const it of r.items) posts.push(rssItemToRaw(it, f, r.fetchedAt));
      } catch (e) {
        errors[f.id] = (e instanceof Error ? e.message : String(e)).slice(0, 80);
      }
    }
    return { posts, errors, fetchedAt };
  }
}
