// trenchscope — PAPER trade ticket state machine (task-1310 T0, SPEC §6.1). Pure and TTY-free so the
// ticket maths and the keypress confirm gate are unit-testable. The interactive loop and the live
// binding drive this reducer and perform the side effects (quote fetch, executor.execute).
//
// Safety: this file builds an *order* and reads a *quote*. It never signs, holds a key, or sends a
// transaction, and it imports no wallet/signing library (SPEC §6.0). Every ticket is labelled PAPER
// and the confirm gate is ON by default: arming needs a deliberate keypress, and sizes above a
// configurable threshold must be typed back (SPEC §6.1 step 3).

import { solToLamports, LAMPORTS_PER_SOL, type PaperOrder, type Side, type Fill, type SwapQuote, type TradeRecord, type PlanView, type ConfirmView, type StatusView } from '@dexterm/data';

/**
 * Phases. PAPER: editing → confirm → filling → filled | error. LIVE (task-1328): editing → planning
 * (the signer builds + simulates) → plan (the PLAN screen; the keypress gate) → signing (Phantom) →
 * filled | refused | error. Nothing in this file signs: the live phases only name what the signer
 * process is doing; the signer decides.
 */
export type TicketPhase = 'editing' | 'confirm' | 'filling' | 'filled' | 'error' | 'planning' | 'plan' | 'signing' | 'refused';
/** PAPER = simulated wallet; LIVE = the non-custodial signer process + Phantom (task-1328). */
export type TicketMode = 'paper' | 'live';
/** Buy sizes in SOL or % of the free SOL balance; sell sizes in % of the held position. */
export type SizeUnit = 'sol' | 'pct';
export type TicketField = 'size' | 'slippage';

/** Default slippage and the SOL notional above which the confirm requires a typed-back amount. */
export const DEFAULT_SLIPPAGE_BPS = 50;
export const DEFAULT_TYPEBACK_THRESHOLD_SOL = 1;
export const MAX_SLIPPAGE_BPS = 5000;

export interface TicketState {
  mint: string;
  symbol: string;
  decimals: number;
  side: Side;
  sizeUnit: SizeUnit;
  /** Raw text the user typed for the size, e.g. "0.5" (SOL) or "50" (%). */
  sizeInput: string;
  /** Slippage in bps as text; defaults to DEFAULT_SLIPPAGE_BPS. */
  slippageInput: string;
  field: TicketField;
  phase: TicketPhase;
  /** PAPER (default) or LIVE. Only the user's `L` key flips it, and only when a wallet is linked + the signer is up. */
  mode: TicketMode;
  /** Keypress confirm gate; ON by default (SPEC §6.0 invariant 2). */
  gateOn: boolean;
  /** True once armed when the SOL notional is above the typed-back threshold. */
  typebackRequired: boolean;
  /** The amount typed back during confirm (when required). */
  typeback: string;
  /** Status / error line. */
  message: string | null;
}

/** Context the reducer needs from the live wallet/quote to size and gate an order. */
export interface TicketContext {
  /** Free SOL balance, lamports (for buy % sizing and funds checks). */
  balanceLamports: bigint;
  /** Held tokens of this mint, raw base units (for sell % sizing). */
  positionTokensRaw: bigint;
  /** SOL notional of the current order (from the warm quote / balance); gates the typed-back step. */
  notionalSol: number;
  typebackThresholdSol: number;
}

export interface TicketSeed {
  mint: string;
  symbol: string;
  /** Token decimals; omit when unknown (the live binding resolves it, defaulting to 9 until then). */
  decimals?: number;
  side: Side;
  slippageBps?: number;
  gateOn?: boolean;
  mode?: TicketMode;
}

export function openTicket(seed: TicketSeed): TicketState {
  return {
    mint: seed.mint,
    symbol: seed.symbol,
    decimals: typeof seed.decimals === 'number' && Number.isFinite(seed.decimals) && seed.decimals > 0 ? seed.decimals : 9,
    side: seed.side,
    sizeUnit: seed.side === 'buy' ? 'sol' : 'pct',
    sizeInput: '',
    slippageInput: String(seed.slippageBps ?? DEFAULT_SLIPPAGE_BPS),
    field: 'size',
    phase: 'editing',
    mode: seed.mode ?? 'paper',
    gateOn: seed.gateOn ?? true,
    typebackRequired: false,
    typeback: '',
    message: null,
  };
}

function parseNum(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export function slippageBps(ts: TicketState): number {
  if (ts.slippageInput.trim() === '') return DEFAULT_SLIPPAGE_BPS;
  const n = parseNum(ts.slippageInput);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SLIPPAGE_BPS;
  return Math.min(MAX_SLIPPAGE_BPS, Math.round(n));
}

/** The raw amount an order would spend, given the live context; 0n when the size is empty/invalid. */
export function orderAmountRaw(ts: TicketState, ctx: Pick<TicketContext, 'balanceLamports' | 'positionTokensRaw'>): bigint {
  const n = parseNum(ts.sizeInput);
  if (!Number.isFinite(n) || n <= 0) return 0n;
  if (ts.side === 'buy') {
    if (ts.sizeUnit === 'sol') return solToLamports(n);
    // % of free SOL balance
    const pct = Math.min(100, n);
    return (ctx.balanceLamports * BigInt(Math.round(pct * 100))) / 10000n;
  }
  // sell: % of the held position
  const pct = Math.min(100, n);
  return (ctx.positionTokensRaw * BigInt(Math.round(pct * 100))) / 10000n;
}

/** Build the order the ticket represents (amount already in raw base units). */
export function toOrder(ts: TicketState, ctx: Pick<TicketContext, 'balanceLamports' | 'positionTokensRaw'>): PaperOrder {
  return { mint: ts.mint, symbol: ts.symbol, side: ts.side, decimals: ts.decimals, amountRaw: orderAmountRaw(ts, ctx), slippageBps: slippageBps(ts) };
}

/** Is the current size a fillable order (positive amount, and for a sell there are tokens to sell)? */
export function orderValid(ts: TicketState, ctx: Pick<TicketContext, 'balanceLamports' | 'positionTokensRaw'>): boolean {
  const amt = orderAmountRaw(ts, ctx);
  if (amt <= 0n) return false;
  if (ts.side === 'sell' && ctx.positionTokensRaw <= 0n) return false;
  return true;
}

/**
 * What the reducer asks the caller to do after a key.
 *  - 'plan'         : LIVE ⏎ → ask the signer to build the plan (phase → planning)
 *  - 'confirm-live' : LIVE Y on the PLAN screen → ask the signer to confirm (phase → signing)
 *  - 'drop-plan'    : the user left the PLAN screen → tell the signer to forget the plan
 *  - 'toggle-live'  : the user pressed L → the binding flips paper ⇄ live if it can
 *  - 'fit-cap'      : LIVE editing, the user pressed f → the binding sizes the order to the signer's cap (task-1368)
 */
export type TicketEffect = 'none' | 'changed' | 'confirm' | 'close' | 'plan' | 'confirm-live' | 'drop-plan' | 'toggle-live' | 'fit-cap';

export interface TicketKey {
  name: string;
  /** Printable char for name==='char'/'space'. */
  ch?: string;
  ctrl?: boolean;
  alt?: boolean;
}

const DIGIT = /[0-9.]/;

function editField(ts: TicketState, key: TicketKey): boolean {
  const cur = ts.field === 'size' ? ts.sizeInput : ts.slippageInput;
  if (key.name === 'backspace') {
    const next = cur.slice(0, -1);
    if (ts.field === 'size') ts.sizeInput = next; else ts.slippageInput = next;
    return true;
  }
  if ((key.name === 'char') && key.ch && DIGIT.test(key.ch) && !key.ctrl && !key.alt) {
    // one decimal point only; slippage is integer bps
    if (key.ch === '.' && (ts.field === 'slippage' || cur.includes('.'))) return true;
    const next = (cur + key.ch).slice(0, 12);
    if (ts.field === 'size') ts.sizeInput = next; else ts.slippageInput = next;
    return true;
  }
  return false;
}

/**
 * Advance the ticket by one key. Returns the effect the caller performs:
 *  - 'changed' : the order inputs changed → re-fetch the warm quote;
 *  - 'confirm' : the gate was satisfied → the caller must execute the order now;
 *  - 'close'   : leave the ticket (back to the token screen);
 *  - 'none'    : nothing to do.
 * A stray key during the confirm step can NEVER confirm — it cancels back to editing.
 */
export function ticketKey(ts: TicketState, key: TicketKey, ctx: TicketContext): TicketEffect {
  ts.message = null;

  if (ts.phase === 'filling' || ts.phase === 'signing') return 'none'; // in-flight: ignore input
  if (ts.phase === 'planning') return 'none'; // the signer is building; esc is handled by the binding (cancel)

  if (ts.phase === 'filled' || ts.phase === 'error' || ts.phase === 'refused') {
    // a receipt is showing: esc closes, any other key starts a fresh ticket for the same mint (same mode)
    if (key.name === 'esc') return 'close';
    const side = ts.side;
    Object.assign(ts, openTicket({ mint: ts.mint, symbol: ts.symbol, decimals: ts.decimals, side, gateOn: ts.gateOn, slippageBps: slippageBps(ts), mode: ts.mode }));
    return 'changed';
  }

  // ---- LIVE plan screen (task-1328): the keypress gate for a REAL trade. Y / ⏎ confirms (with the
  // typed-back size above the threshold, exactly like paper); esc returns to editing; ANY other key
  // cancels — a stray key can never confirm, and never navigates mid-plan.
  if (ts.phase === 'plan') {
    if (key.name === 'esc') { ts.phase = 'editing'; ts.typeback = ''; return 'drop-plan'; }
    if (ts.typebackRequired && key.name === 'char' && key.ch && DIGIT.test(key.ch)) {
      if (key.ch === '.' && ts.typeback.includes('.')) return 'none';
      ts.typeback = (ts.typeback + key.ch).slice(0, 12);
      return 'none';
    }
    if (ts.typebackRequired && key.name === 'backspace') { ts.typeback = ts.typeback.slice(0, -1); return 'none'; }
    const confirmKey = (key.name === 'char' && (key.ch === 'y' || key.ch === 'Y')) || key.name === 'enter';
    if (confirmKey) {
      if (ts.typebackRequired) {
        const want = parseNum(ts.sizeInput);
        const got = parseNum(ts.typeback);
        if (!(Number.isFinite(got) && Math.abs(got - want) < 1e-9)) {
          ts.message = `type the size (${ts.sizeInput}) to confirm this LIVE ${ts.side}`;
          return 'none';
        }
      }
      ts.phase = 'signing';
      return 'confirm-live';
    }
    ts.phase = 'editing';
    ts.typeback = '';
    ts.message = 'plan cancelled';
    return 'drop-plan';
  }

  if (ts.phase === 'confirm') {
    if (key.name === 'esc') { ts.phase = 'editing'; ts.typeback = ''; return 'none'; }
    if (ts.typebackRequired && key.name === 'char' && key.ch && DIGIT.test(key.ch)) {
      if (key.ch === '.' && ts.typeback.includes('.')) return 'none';
      ts.typeback = (ts.typeback + key.ch).slice(0, 12);
      return 'none';
    }
    if (ts.typebackRequired && key.name === 'backspace') { ts.typeback = ts.typeback.slice(0, -1); return 'none'; }
    const confirmKey = (key.name === 'char' && (key.ch === 'y' || key.ch === 'Y')) || key.name === 'enter';
    if (confirmKey) {
      if (ts.typebackRequired) {
        const want = parseNum(ts.sizeInput);
        const got = parseNum(ts.typeback);
        if (!(Number.isFinite(got) && Math.abs(got - want) < 1e-9)) {
          ts.message = `type the size (${ts.sizeInput}) to confirm this PAPER ${ts.side}`;
          return 'none';
        }
      }
      ts.phase = 'filling';
      return 'confirm';
    }
    // any other key cancels the arm (a stray key never confirms, and never navigates mid-confirm)
    ts.phase = 'editing';
    ts.typeback = '';
    ts.message = 'confirm cancelled';
    return 'none';
  }

  // ---- editing
  if (key.name === 'esc') return 'close';
  if (key.name === 'char' && (key.ch === 'L' || key.ch === 'l') && !key.ctrl && !key.alt) return 'toggle-live';
  if (key.name === 'tab') { ts.field = ts.field === 'size' ? 'slippage' : 'size'; return 'none'; }
  if (key.name === 'left' || key.name === 'right') {
    ts.side = ts.side === 'buy' ? 'sell' : 'buy';
    ts.sizeUnit = ts.side === 'buy' ? ts.sizeUnit : 'pct';
    ts.typeback = '';
    return 'changed';
  }
  if (key.name === 'char' && key.ch === 'u' && !key.ctrl) {
    if (ts.side === 'buy') { ts.sizeUnit = ts.sizeUnit === 'sol' ? 'pct' : 'sol'; return 'changed'; }
    return 'none'; // sell is always % of the position
  }
  if (key.name === 'enter') {
    if (!orderValid(ts, ctx)) { ts.message = ts.side === 'sell' && ctx.positionTokensRaw <= 0n ? `no ${ts.symbol} position to sell` : 'enter a size first'; return 'none'; }
    ts.typebackRequired = ts.gateOn && ctx.notionalSol > ctx.typebackThresholdSol;
    ts.typeback = '';
    if (ts.mode === 'live') { ts.phase = 'planning'; return 'plan'; }
    ts.phase = 'confirm';
    return 'none';
  }
  // task-1368: f on a LIVE buy = size the order to the signer's cap (the binding knows the caps + SOL/USD; the
  // reducer only names the effect). Inert on PAPER (no caps) and on a sell (sized in % of the position).
  if (key.name === 'char' && (key.ch === 'f' || key.ch === 'F') && !key.ctrl && !key.alt) {
    return ts.mode === 'live' && ts.side === 'buy' ? 'fit-cap' : 'none';
  }
  if (editField(ts, key)) return 'changed';
  return 'none';
}

// --------------------------------------------------------------------------- view models

/** Everything the ticket screen renders (built by the live binding, or seeded for a demo frame). */
export interface TicketView {
  ticket: TicketState;
  balanceSol: number;
  /** Human token balance of this mint (for sell sizing + the receipt). */
  positionTokens: number;
  /** Mark value of the held position in SOL, null when no price. */
  positionValueSol: number | null;
  /** The warm quote behind the preview fill (route, min-received, usd); null while loading/invalid. */
  quote: SwapQuote | null;
  /** The fill the current order would produce from `quote` (preview). */
  preview: Fill | null;
  /** Age of the warm quote in ms (freshness countdown). */
  quoteAgeMs: number | null;
  loading: boolean;
  error: string | null;
  /** The booked fill once the ticket reaches the `filled` phase. */
  receipt: Fill | null;
  /** True while a confirm-time quote is queued behind a Jupiter 429 pause (drives the retrying UI). */
  rateLimited: boolean;
  /**
   * task-1368: false while the token's decimals are still unknown (the binding is resolving them; `ticket.decimals`
   * is a placeholder 9). The screen must then say so instead of printing a token amount computed from a guess.
   * Absent = known (seeded demo views).
   */
  decimalsKnown?: boolean;
  /** LIVE mode state (task-1328); absent on a paper ticket. */
  live?: LiveTicketView;
}

/** What the ticket screen shows for a LIVE ticket: all of it comes from the signer process's views. */
export interface LiveTicketView {
  /** The signer's status (its network, caps, panic) as last read; null = the signer could not be reached. */
  signer: StatusView | null;
  /** The plan the signer built (phase plan/signing/… ); null while editing/planning. */
  plan: PlanView | null;
  /** The outcome of the last confirm. */
  outcome: ConfirmView | null;
  /** Why LIVE is not available / the last live error, if any. */
  error: string | null;
  /** Short linked-wallet address the signer will sign with. */
  linked: string | null;
  /** True when the plan is the devnet probe (wrap-and-unwrap, fees only). */
  probe: boolean;
  /** task-1368: the size-vs-caps preflight for the order being edited (null = no signer status / no size yet). */
  preflight?: CapPreflight | null;
  /**
   * task-1368: while the signer is rate limited by Jupiter the ticket STAYS in `planning` and retries by itself at
   * `retryAt` (ms epoch); `retryMessage` is the signer's own line ("Jupiter is rate limiting this IP (429 from
   * api.jup.ag); retry in 8s"). `r` retries now, esc cancels. Null when not waiting.
   */
  retryAt?: number | null;
  retryMessage?: string | null;
  /** task-1368: the devnet-signer-cannot-fill-a-mainnet-token line, shown BEFORE ⏎ (null when it does not apply). */
  devnetWarning?: string | null;
}

// --------------------------------------------------------------------------- task-1368 preflight + hints (pure)

/**
 * Fees + token-account rent the signer's simulated SOL-out may add on top of the size of a BUY (a tx fee, a priority
 * fee and one associated-token-account rent of 0.00203928 SOL when the wallet has never held the token). The
 * signer prices the LARGER of the planned SOL leg and the simulated SOL out, so a size that is exactly the cap in
 * USD is refused once rent lands on top; `fitSizeSol` leaves this much room.
 */
export const CAP_FIT_OVERHEAD_SOL = 0.0025;

export interface CapPreflightInput {
  side: Side;
  /** The order's SOL leg: a buy's size, a sell's quoted SOL out (0 when unknown). */
  sizeSol: number;
  /** The SIGNER's SOL/USD (the price its caps are enforced with); null when it has none yet. */
  solUsd: number | null;
  perTradeUsd: number;
  dailyUsd: number;
  spentTodayUsd: number;
  overheadSol?: number;
}

export interface CapPreflight {
  sizeSol: number;
  /** size × SOL/USD, null when the price is unknown. */
  sizeUsd: number | null;
  perTradeUsd: number;
  dailyRemainingUsd: number;
  /** The binding cap for this order right now: min(per-trade, what is left of today). */
  capUsd: number;
  /** True when the size prices above the cap: the signer WILL refuse it (per-trade-cap / daily-cap). */
  over: boolean;
  /** The largest size (SOL, 3 dp, overhead subtracted) that fits the cap; null when nothing fits or no price. */
  fitSizeSol: number | null;
  /** Which cap binds when over ('per-trade' or 'daily'); null when not over. */
  binding: 'per-trade' | 'daily' | null;
  /** One line for the ticket. */
  line: string;
}

const usd = (n: number): string => `$${n.toFixed(2).replace(/\.00$/, '')}`;

/**
 * Size vs the signer's caps BEFORE ⏎ (task-1368 item b): the USD value of the size at the signer's own SOL/USD, the
 * per-trade cap and what is left of the daily cap, a red verdict when the size is over, and the size that fits.
 * Pure: the signer still decides at precheck/confirm — this only stops the user from building a plan that will be
 * refused for a reason they could not see.
 */
export function capPreflight(i: CapPreflightInput): CapPreflight {
  const sizeSol = Number.isFinite(i.sizeSol) && i.sizeSol > 0 ? i.sizeSol : 0;
  const price = i.solUsd !== null && Number.isFinite(i.solUsd) && i.solUsd > 0 ? i.solUsd : null;
  const perTradeUsd = Math.max(0, i.perTradeUsd);
  const dailyRemainingUsd = Math.max(0, i.dailyUsd - Math.max(0, i.spentTodayUsd));
  const capUsd = Math.min(perTradeUsd, dailyRemainingUsd);
  const sizeUsd = price !== null && sizeSol > 0 ? sizeSol * price : null;
  const over = sizeUsd !== null && sizeUsd > capUsd + 1e-9;
  const binding: CapPreflight['binding'] = !over ? null : dailyRemainingUsd < perTradeUsd ? 'daily' : 'per-trade';
  const overhead = Math.max(0, i.overheadSol ?? CAP_FIT_OVERHEAD_SOL);
  let fitSizeSol: number | null = null;
  if (price !== null && capUsd > 0) {
    const fit = Math.floor((capUsd / price - overhead) * 1000) / 1000;
    fitSizeSol = fit > 0 ? fit : null;
  }
  const capText = `cap ${usd(perTradeUsd)}/trade · ${usd(dailyRemainingUsd)} left of ${usd(Math.max(0, i.dailyUsd))} today`;
  let line: string;
  if (sizeSol <= 0) line = `${capText} · enter a size`;
  else if (price === null) line = `${sizeSol} SOL = $? (the signer has no SOL/USD yet; it will refuse an unpriced trade on mainnet) · ${capText}`;
  else if (over) {
    const which = binding === 'daily' ? `${usd(dailyRemainingUsd)} left today` : `${usd(perTradeUsd)} cap`;
    line = `${sizeSol} SOL = ${usd(sizeUsd!)} > ${which}: ${fitSizeSol !== null ? `use ≤ ${fitSizeSol} SOL (f fits it; fees + token-account rent counted)` : 'nothing fits — the cap is spent for today'}`;
  } else line = `${sizeSol} SOL ≈ ${usd(sizeUsd!)} at SOL ${usd(price)} · ${capText}`;
  return { sizeSol, sizeUsd, perTradeUsd, dailyRemainingUsd, capUsd, over, fitSizeSol, binding, line };
}

const WSOL = 'So11111111111111111111111111111111111111112';

/**
 * task-1368 item c: a DEVNET signer + a Jupiter swap = a transaction built on MAINNET state (there is no Jupiter
 * devnet): it can never simulate or fill on devnet, so say so BEFORE ⏎ and name the two ways out. Null for the
 * probe (built for devnet on purpose), for wrapped SOL itself, and on mainnet.
 */
export function devnetMintWarning(a: { network: 'devnet' | 'mainnet' | null; probe: boolean; mint: string; perTradeUsd?: number; dailyUsd?: number }): string | null {
  if (a.network !== 'devnet' || a.probe || a.mint === WSOL) return null;
  const caps = `caps ${usd(a.perTradeUsd ?? 5)}/${usd(a.dailyUsd ?? 20)}`;
  return `DEVNET cannot fill mainnet tokens: paper trade (L) or restart with --mainnet (real funds, ${caps})`;
}

const MAINNET_STATE_ERR = /invalid transaction|blockhash|account.*not found|not found|could not find|address (table|lookup)|AccountNotFound|ProgramAccountNotFound|unknown program|InvalidAccountData/i;

/**
 * task-1368 item f: a plain-English hint under a failed simulation when the failure pattern is the devnet-vs-mainnet
 * mismatch (a mainnet route simulated on a devnet node: accounts, lookup tables or blockhash not found). Null when
 * the simulation passed, was not run, or failed for another reason (the full error is still shown).
 */
export function simFailureHint(p: Pick<PlanView, 'kind' | 'network' | 'sim' | 'mintOnNetwork'>, caps?: { perTradeUsd: number; dailyUsd: number }): string | null {
  if (p.kind !== 'swap' || !p.sim.ran || p.sim.ok) return null;
  const err = p.sim.error ?? '';
  const mainnetState = MAINNET_STATE_ERR.test(err);
  if (p.network === 'devnet' && (mainnetState || p.mintOnNetwork === false)) {
    const mint = p.mintOnNetwork === false ? ' (the mint does not exist on devnet)' : '';
    return `devnet-vs-mainnet wall${mint}: a Jupiter swap is built on MAINNET state (accounts, lookup tables, blockhash) that a devnet node does not have. Paper trade (L) or restart with --mainnet (real funds, caps ${usd(caps?.perTradeUsd ?? 5)}/${usd(caps?.dailyUsd ?? 20)}).`;
  }
  if (mainnetState) return 'the node could not find the route\'s accounts or blockhash: a stale plan or the wrong RPC network — rebuild with ⏎, or check --trade-rpc';
  return null;
}

export interface PositionRowView {
  mint: string;
  symbol: string;
  tokens: number;
  costSol: number;
  avgEntrySol: number | null;
  priceSol: number | null;
  valueSol: number | null;
  unrealizedSol: number | null;
  unrealizedPct: number | null;
  realizedSol: number;
}

/** Everything the positions screen renders. */
export interface PositionsView {
  balanceSol: number;
  startSol: number;
  /** balance + marked value of all open positions. */
  equitySol: number;
  totalUnrealizedSol: number;
  totalRealizedSol: number;
  /** equity − start, as a fraction of start. */
  totalPct: number | null;
  solPriceUsd: number | null;
  rows: PositionRowView[];
  history: TradeRecord[];
  loading: boolean;
}

/** SOL notional of a buy order sized in SOL/%, used to gate the typed-back step without a quote. */
export function buyNotionalSol(ts: TicketState, balanceLamports: bigint): number {
  const n = parseNum(ts.sizeInput);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (ts.sizeUnit === 'sol') return n;
  return (Number(balanceLamports) / 1e9) * Math.min(100, n) / 100;
}
