// trenchscope T2 — the SIGNER channel protocol (task-1328, SPEC §6.5 "separate process / hard-API module").
//
// The signer runs as its OWN PROCESS. The UI talks to it over the child's stdio pipes — a channel only
// the spawning process holds — with every frame authenticated by an HMAC over a per-session secret the
// parent hands the child as the FIRST line on stdin (never argv, never the environment, never a file).
// Frames carry a strictly increasing sequence number per direction, so a replayed or reordered frame is
// dropped. Anything that does not verify is ignored and counted; too many bad frames and the host exits
// (fail closed: a confused signer stops signing).
//
// The API is DELIBERATELY small (SPEC §6.5): status · plan · probe · precheck · confirm · drop · panic.
// There is no `sign(bytes)`, no `submit`, no `setCaps`. The UI never sends transaction bytes, a wallet
// key, or a cap: the signer builds its own transaction from a Jupiter quote, reads the linked public key
// from its own store, and applies the caps it was started with.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SIGNER_PROTOCOL_VERSION = 1;
/** A frame larger than this is dropped unread (a plan view is a few KB). */
export const MAX_FRAME_BYTES = 64 * 1024;
/** Bad frames tolerated before the host exits. */
export const MAX_BAD_FRAMES = 8;

// task-1363 adds `fast` (the fast wallet's public status) and `fill` (build a DEVNET FILL for the fast wallet
// from an armed order plan's leg). Still no sign/submit/setCaps, and NO create/export/import of the fast wallet:
// it is created only by `trenchscope wallet fast create` on a TTY, and the signer only ever reads it.
// task-1368 adds `quote`: the keyless, read-only Jupiter /quote for an order, fetched by the SIGNER's own HTTP
// client so the LIVE ticket's preview, the signer's re-quote at ⏎ and the /swap build are paced through ONE rate
// limiter (one process, one `jupiter` bucket) and a quote fetched for the preview is reused by the build a moment
// later. It returns numbers and strings only — never transaction bytes — and changes nothing in the signer.
export type SignerMethod = 'status' | 'plan' | 'probe' | 'precheck' | 'confirm' | 'drop' | 'panic' | 'fast' | 'fill' | 'quote';
export const SIGNER_METHODS: ReadonlySet<string> = new Set<SignerMethod>(['status', 'plan', 'probe', 'precheck', 'confirm', 'drop', 'panic', 'fast', 'fill', 'quote']);

export interface SignerRequest { id: number; method: string; params?: Record<string, unknown> }
/**
 * An error response carries the SignerError reason and, for `rate-limited` (task-1368), how long the caller
 * should wait before asking again, so the ticket can show a countdown and retry instead of dropping the plan.
 */
export type SignerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string; reason?: string; retryAfterMs?: number };
export interface SignerEvent { event: 'ready' | 'exit'; detail?: unknown }
export type SignerMessage = SignerRequest | SignerResponse | SignerEvent;

export interface Hello { hello: 'dexterm-signer'; v: number; secret: string }

export interface Frame { v: number; seq: number; body: string; mac: string }

export function newSecret(): Buffer { return randomBytes(32); }

export function mac(secret: Buffer, seq: number, body: string): string {
  return createHmac('sha256', secret).update(`${seq}\n${body}`).digest('hex');
}

/** Build one authenticated frame line (with the trailing newline). */
export function encodeFrame(secret: Buffer, seq: number, message: SignerMessage): string {
  const body = JSON.stringify(message);
  return `${JSON.stringify({ v: SIGNER_PROTOCOL_VERSION, seq, body, mac: mac(secret, seq, body) } satisfies Frame)}\n`;
}

export type DecodeResult = { ok: true; seq: number; message: SignerMessage } | { ok: false; why: string };

/**
 * Verify and decode one frame line. `expectSeq` is the next sequence number this direction must carry;
 * anything else (replay, gap, reorder) is refused. Constant-time MAC comparison.
 */
export function decodeFrame(secret: Buffer, line: string, expectSeq: number): DecodeResult {
  if (line.length > MAX_FRAME_BYTES) return { ok: false, why: 'frame too large' };
  let f: unknown;
  try { f = JSON.parse(line); } catch { return { ok: false, why: 'not json' }; }
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return { ok: false, why: 'not an object' };
  const fr = f as Partial<Frame>;
  if (fr.v !== SIGNER_PROTOCOL_VERSION) return { ok: false, why: 'bad version' };
  if (typeof fr.seq !== 'number' || !Number.isInteger(fr.seq) || fr.seq !== expectSeq) return { ok: false, why: `bad seq ${String(fr.seq)} (expected ${expectSeq})` };
  if (typeof fr.body !== 'string' || typeof fr.mac !== 'string') return { ok: false, why: 'missing body/mac' };
  const want = Buffer.from(mac(secret, fr.seq, fr.body), 'hex');
  const got = Buffer.from(fr.mac, 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, why: 'bad mac' };
  let message: unknown;
  try { message = JSON.parse(fr.body); } catch { return { ok: false, why: 'body not json' }; }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return { ok: false, why: 'body not an object' };
  return { ok: true, seq: fr.seq, message: message as SignerMessage };
}

export function isRequest(m: SignerMessage): m is SignerRequest { return typeof (m as SignerRequest).method === 'string' && typeof (m as SignerRequest).id === 'number'; }
export function isResponse(m: SignerMessage): m is SignerResponse { return typeof (m as SignerResponse).id === 'number' && typeof (m as SignerResponse).ok === 'boolean'; }
export function isEvent(m: SignerMessage): m is SignerEvent { return typeof (m as SignerEvent).event === 'string'; }

/** Parse the unauthenticated hello line the parent writes first. Null when malformed. */
export function parseHello(line: string): { secret: Buffer } | null {
  let h: unknown;
  try { h = JSON.parse(line); } catch { return null; }
  if (h === null || typeof h !== 'object') return null;
  const x = h as Partial<Hello>;
  if (x.hello !== 'dexterm-signer' || x.v !== SIGNER_PROTOCOL_VERSION || typeof x.secret !== 'string') return null;
  const secret = Buffer.from(x.secret, 'base64');
  if (secret.length !== 32) return null;
  return { secret };
}

export function encodeHello(secret: Buffer): string {
  return `${JSON.stringify({ hello: 'dexterm-signer', v: SIGNER_PROTOCOL_VERSION, secret: secret.toString('base64') } satisfies Hello)}\n`;
}

// ---------------------------------------------------------------------------------------------- views
// JSON-safe views the signer returns (bigint → decimal string). The UI renders these; it never sees the
// transaction bytes, the plan registry, or the caps object itself.

export interface SolUsdView { price: number | null; sources?: string[]; reason?: string }
export interface VerdictView { ok: boolean; reason?: string; message?: string }

/** task-1368: a keyless Jupiter quote as the signer fetched it (bigint → decimal string). No bytes, no route data. */
export interface QuoteView {
  inputMint: string;
  outputMint: string;
  inAmountRaw: string;
  outAmountRaw: string;
  /** Min out (ExactIn) after slippage, raw base units. */
  minOutRaw: string;
  slippageBps: number;
  /** Percent (Jupiter's fraction ×100, normalized once in the data layer). */
  priceImpactPct: number | null;
  route: string[];
  /** Jupiter's own USD estimate of the swap (display only; the signer never caps by it). */
  usdValue: number | null;
  /** The signer's SOL/USD at quote time (the price the caps are enforced with). */
  solUsd: SolUsdView;
  /** The host that answered, and the age of the quote when it was served (0 = fetched now; > 0 = reused). */
  host: string;
  ageMs: number;
  fetchedAt: number;
}

export interface PlanView {
  hash: string;
  kind: 'swap' | 'probe' | 'devnet-fill';
  /** task-1363: 'main' = Phantom signs; 'fast' = the capped devnet fast wallet signs locally (mandate fills). */
  lane: 'main' | 'fast';
  /** task-1363: the order-plan leg a devnet fill is for (`planId:legKey`); null for a ticket plan / probe. */
  ref: string | null;
  /** The network the SIGNER will submit to, from its RPC endpoint classification — never a label. */
  network: 'devnet' | 'mainnet';
  mint: string;
  symbol: string;
  side: 'buy' | 'sell';
  decimals: number;
  amountInRaw: string;
  amountOutRaw: string;
  minOutRaw: string;
  slippageBps: number;
  route: string[];
  priceImpactPct: number | null;
  notionalUsd: number | null;
  solUsd: SolUsdView;
  sim: { ran: boolean; ok: boolean; error: string | null; unitsConsumed: number | null; solOutLamports: string | null };
  /**
   * task-1368: does the order's mint account exist on the network the SIGNER talks to? `false` on a devnet signer
   * for a mainnet-only token is the plain-English reason a Jupiter (mainnet) swap can never simulate or fill there;
   * `null` when the RPC could not answer. Swap plans only; absent from views built before this field existed.
   */
  mintOnNetwork?: boolean | null;
  feeLamports: string;
  prioritizationFeeLamports: number | null;
  instructions: { program: string; op: string }[];
  policy: VerdictView;
  /** The caps verdict as of now ("will be refused: …" before the keypress). */
  precheck: VerdictView;
  userPublicKey: string;
  builtAt: number;
  expiresAt: number;
}

export interface FillView {
  t: number; mint: string; symbol: string; side: 'buy' | 'sell'; decimals: number;
  solDelta: string; tokenDelta: string; feeLamports: string; priceSol: number; realizedLamports: string;
}

export type ConfirmView =
  | { kind: 'filled'; signature: string; fill: FillView; roundTripMs: number; lighthouseTail: number; network: 'devnet' | 'mainnet' }
  | { kind: 'refused'; reason: string; message: string }
  | { kind: 'send-failed'; signature: string | null; error: string }
  | { kind: 'send-unknown'; signature: string; error: string };

export interface CapsView {
  network: 'devnet' | 'mainnet';
  mainnetEnabled: boolean;
  perTradeUsd: number;
  dailyUsd: number;
  maxPriceImpactPct: number;
  maxSolOut: number;
  maxSlippageBps: number;
}

/** task-1363: the fast wallet as the signer sees it. Public key and balance only — never a seed. */
export interface FastView {
  /** A fast wallet is loaded in this signer (devnet RPC + record present). */
  loaded: boolean;
  publicKey: string | null;
  network: 'devnet';
  /** Lamports on devnet, or null when the balance could not be read. */
  balanceLamports: string | null;
  /** Hard ceiling on the SOL one fill may move out (fast-wallet.ts). */
  maxSolPerFill: number;
  createdAt: number | null;
  /** Why it is not loaded, when it is not. */
  reason: string | null;
}

/** task-1363: what the engine sends to build a devnet fill. Untrusted; validated by parseFillParams. */
export interface FillParams {
  /** `planId:legKey` — journaled, part of the fill hash, in the on-chain memo. */
  ref: string;
  mint: string;
  symbol: string;
  decimals: number;
  side: 'buy' | 'sell';
  /** The SOL leg in lamports (decimal string). */
  lamports: string;
}

export interface StatusView {
  version: number;
  pid: number;
  linked: { publicKey: string; linkedAt: number } | null;
  /** task-1363: the loaded fast wallet's public key, or null. */
  fastWallet: { publicKey: string } | null;
  /** The network of the RPC endpoint the signer actually talks to (classified from the URL). */
  network: 'devnet' | 'mainnet';
  /** Hostname of the RPC endpoint (never the full URL — it may carry a key). */
  rpcHost: string;
  caps: CapsView;
  panic: { engagedAt: number; reason: string } | null;
  ledgerLocked: { lockedAt: number; reason: string } | null;
  spentTodayUsd: number;
  plans: number;
  solUsd: SolUsdView;
  probeAvailable: boolean;
}
