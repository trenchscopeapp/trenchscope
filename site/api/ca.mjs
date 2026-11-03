// GET /api/ca: whether the site may show the coin's contract address, from
// @nullxnothing/solana-launch-kit/ca-watch. The reserved mint and its creator are
// server-only variables; the address leaves this function only once the chain proves
// the coin exists and was made by the configured wallet.
const EMPTY = Object.freeze({ state: 'unset', ca: null, checkedAt: null, stats: null });

// One configured mint and creator per running process. Request parameters never
// select chain accounts, credentials or a provider URL.
export function createCaHandler({ env = process.env, createWatch,
  loadWatch = () => import('../server/generated/ca-runtime.cjs').then(module => module.default.createContractAddressWatch),
  connection = async url => {
    const { default: { Connection } } = await import('../server/generated/ca-runtime.cjs');
    return new Connection(url, { commitment: 'finalized', disableRetryOnRateLimit: true,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(6000) }),
    });
  }, now = Date.now } = {}) {
  let watch;
  let pending;
  let lastCheck = -Infinity;
  const read = async () => {
    const mint = env.SOLGENT_RESERVED_MINT?.trim();
    const creator = env.SOLGENT_CREATOR?.trim();
    const key = env.HELIUS_API_KEY?.trim();
    if (!mint) return { code: 200, body: EMPTY };
    if (!creator || !key) {
      console.error('[ca-watch] incomplete configuration', { creatorPresent: Boolean(creator), providerPresent: Boolean(key) });
      return { code: 503, body: { ...EMPTY, state: 'tba' } };
    }
    // Load the chain runtime inside the guarded request, so a packaging or provider
    // failure is an unavailable response, never a startup crash.
    if (!watch) {
      const factory = createWatch ?? await loadWatch();
      const transport = await connection(`https://beta.helius-rpc.com/?api-key=${encodeURIComponent(key)}`);
      watch ??= factory({ mint, creator, connection: transport, log: line => {
        if (line.includes('the check failed')) console.error('[ca-watch] chain read unavailable');
      } });
    }
    if (watch.status().state === 'live') return { code: 200, body: watch.status() };
    if (!pending && now() - lastCheck >= 5000) {
      lastCheck = now();
      pending = watch.check().finally(() => { pending = undefined; });
    }
    const status = pending ? await pending : watch.status();
    // The kit keeps the previous checkedAt on provider errors. Keep the address
    // hidden and tell the browser a check is unavailable rather than claiming tba.
    if (status.state !== 'live' && (!status.checkedAt || now() - Date.parse(status.checkedAt) > 30000)) {
      return { code: 503, body: { ...EMPTY, state: 'tba' } };
    }
    return { code: 200, body: status };
  };

  return async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('CDN-Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      return response.status(405).end();
    }
    try {
      const result = await read();
      if (request.method === 'HEAD') return response.status(result.code).end();
      return response.status(result.code).json(result.body);
    } catch (error) {
      // Classify runtime failures without reflecting messages, URLs or credentials.
      console.error('[ca-watch] runtime unavailable', {
        name: error instanceof Error ? error.name : 'Error',
        code: typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : undefined,
      });
      return response.status(503).json({ ...EMPTY, state: 'tba' });
    }
  };
}

export default createCaHandler();
