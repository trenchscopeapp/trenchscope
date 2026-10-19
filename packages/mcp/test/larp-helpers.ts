// Shared offline harness for the LARP tool tests: a fake one-coin data layer and a replayed `net`, so McpTools runs its
// real fetch_page / larp_check / check_github code with recorded responses and no network.
import type { McpTools } from '../src/index.ts';
import type { SafeFetchResult } from '@dexterm/data';

export const MINT = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
export const OTHER = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
export const PAIR = 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL';

export function pageRes(body: string, finalUrl: string, status = 200): SafeFetchResult {
  return { ok: status < 400, status, finalUrl, contentType: 'text/html', body, bytes: body.length, truncated: false, redirects: [], blocked: null, elapsedMs: 1 };
}

/** A fake data layer for one coin that advertises `site` (and optional extra socials), with one DexScreener pair. */
export function fakeData(opts: { symbol: string; name: string; site: string | null; socials?: Array<{ type: string; url: string }>; createdAt?: number | null; accounts?: Record<string, { programOwner: string | null; exists: boolean; lamports: number; executable?: boolean }> }) {
  return {
    rpcPool: { accountMeta: async (addrs: string[]) => new Map(addrs.map((a) => [a, opts.accounts?.[a] ?? { programOwner: null, exists: false, lamports: 0, executable: false }])) },
    store: { enrich: async () => ({ rows: [{ mint: MINT, token: { symbol: opts.symbol, name: opts.name, launchpad: 'raydium', createdAt: opts.createdAt ?? null, socials: { x: null, tg: null, web: null } } }], errors: [] }) },
    dexscreener: {
      tokensRaw: async () => ({
        pairs: [{ chainId: 'solana', pairAddress: PAIR, baseToken: { address: MINT }, quoteToken: { address: 'So11111111111111111111111111111111111111112' }, liquidity: { usd: 100 },
          info: { websites: opts.site ? [{ label: 'Website', url: opts.site }] : [], socials: opts.socials ?? [] } }],
        fetchedAt: 0, latencyMs: 0,
      }),
    },
    jupiter: { search: async () => [] },
  };
}

/** Replace the tools' network with a URL → response map; anything unmapped is a 404 (and is recorded). */
export function replayNet(tools: McpTools, pages: Record<string, SafeFetchResult>, texts: Record<string, { ok: boolean; status: number; body: string }> = {}): string[] {
  const seen: string[] = [];
  tools.net = {
    fetchPage: async (url) => { seen.push(url); return pages[url] ?? pageRes('', url, 404); },
    textFetch: async (url) => { seen.push(url); return texts[url] ?? { ok: false, status: 404, body: '' }; },
  };
  return seen;
}

