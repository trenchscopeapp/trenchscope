// Deterministic, LLM-free voice router (task-1282). Ported and trimmed from the spike
// (dexterm/research/jarvis/src/router.mjs) to the in-app safety contract:
//
//   Voice may ONLY ask the analyst a question or trigger the analyst's existing SAFE actions —
//   navigate a screen, open a token, set a filter, add to the watchlist, or OPEN a pre-filled PAPER
//   ticket. Voice may NEVER confirm, sign, or execute a trade. A spoken "buy"/"sell" resolves at most
//   to `open-ticket`, which opens the ticket in its editing phase; the keypress gate still stands.
//
// Every return path is one of the closed VoiceDecision kinds below; none can execute a trade. The
// exported `isSafe()` invariant and its test assert that property holds for every decision.
//
// Pure, zero-dependency. Runs in well under a millisecond (no model in the loop).

import type { VoiceProvenance, VoiceScreenState } from './types.ts';

export type VoiceDecision =
  // Dropped before NLU: not push-to-talk, multiple speakers, echo/TV, or empty.
  | { kind: 'ignore'; reason: string }
  // Ask the user something and read it back; no app state changes.
  | { kind: 'clarify'; reason: string; question: string }
  // Switch to a named screen (maps to the app's show_screen / screen.* navigation).
  | { kind: 'navigate'; screen: string; say: string }
  // Open the token detail for the selected row, or a named ticker the app must resolve.
  | { kind: 'open-token'; target: '__selected__' | string; say: string }
  // Set the screener filter bar with the tiny parsed grammar (never evaluated as code).
  | { kind: 'filter'; expr: string; say: string }
  // Add the selected/named token to the watchlist.
  | { kind: 'watchlist'; target: '__selected__' | string; say: string }
  // Open the PAPER ticket pre-set to a side. Editing phase only — NEVER confirmed by voice.
  | { kind: 'open-ticket'; side: 'buy' | 'sell'; target: '__selected__' | string; say: string }
  // Create an ORDER-PLAN PROPOSAL (task-1355): a conditional entry + take-profit ladder + moon bag +
  // stop, bound to a mint. This is INERT data the app turns into a `proposed` plan — it carries NO
  // arm/confirm/sign field, and voice can never arm it (arming needs a physical keypress). Any mishear
  // (unscaled number, ambiguous token, unclear fraction) returns `clarify` instead, never a guess.
  | { kind: 'propose-plan'; side: 'buy' | 'sell'; target: '__selected__' | string;
      entry: { mcUsd: number } | null; exits: { mcUsd: number; fraction: number }[];
      stopMcUsd: number | null; moonBag: boolean; say: string }
  // Open or close a popup PANEL through the popup host (task-1339): today the chart HUD window for the
  // open token. Read-only views; the popup host never sees keys and can only send UI events.
  | { kind: 'popup'; panel: 'chart'; open: boolean; say: string }
  // Switch to a named WORKSPACE (task-1358): "show me everything" / "morning hud" → morning-hud, "default
  // workspace" → default, "workspace trenches" → trenches. A workspace switch is navigation + theme + read-only
  // popups; the app resolves the name against its own list and asks when it does not exist.
  | { kind: 'workspace'; name: string; say: string }
  // Send the utterance to the analyst (Claude) as a normal question with screen context.
  | { kind: 'analyst'; question: string };

/** The decision kinds voice is allowed to produce. A trade can only ever reach `open-ticket`. */
const SAFE_KINDS = new Set(['ignore', 'clarify', 'navigate', 'open-token', 'filter', 'watchlist', 'open-ticket', 'propose-plan', 'popup', 'workspace', 'analyst']);

/**
 * The global safety invariant: a voice decision never executes a trade. `open-ticket` only opens the
 * editing ticket (the keypress gate still applies); no decision carries a confirm/arm/execute flag.
 * Any caller can assert this before acting; the router test asserts it for every utterance.
 */
export function isSafe(d: VoiceDecision): boolean {
  if (!SAFE_KINDS.has(d.kind)) return false;
  // Defence in depth: reject anything that smuggled an execution-shaped field onto the decision.
  const o = d as Record<string, unknown>;
  if ('execute' in o || 'confirm' in o || 'armed' in o || 'arm' in o || 'sign' in o || 'send' in o || 'mode' in o || 'caps' in o || 'live' in o) return false;
  return true;
}

const SCREENS: Record<string, string[]> = {
  screener: ['screener', 'the screen', 'main screen', 'the board', 'the list', 'top runners', 'runners', 'movers', 'gainers', 'trending'],
  newpairs: ['new pairs', 'new pools', 'fresh pairs', 'just launched', 'new launches', 'newpairs'],
  watchlist: ['watchlist', 'my watchlist', 'my list'],
  analyst: ['analyst', 'the analyst', 'chat'],
  positions: ['positions', 'my positions', 'my bags', 'portfolio'],
};
// Nav verbs that mean "put this on screen" rather than a trade or a question.
const NAV_LEAD = /^(show|open|go to|goto|switch to|take me to|pull up|bring up|show me)\b/;

const BUY_WORDS = ['buy', 'ape', 'long', 'grab', 'snipe', 'cop'];
const SELL_WORDS = ['sell', 'dump', 'close', 'exit', 'take profit', 'offload'];
// Homophones STT commonly confuses with the trade verbs. A homophone with no clear buy/sell word
// present is UNCERTAIN: the router clarifies rather than opening the wrong-side ticket.
const ACTION_HOMOPHONES: Record<string, 'buy' | 'sell'> = { cell: 'sell', sail: 'sell', by: 'buy', bye: 'buy' };

const ANALYSIS_HINTS = ['is it safe', 'rug', 'analyze', 'analyse', 'should i', 'whats the deal',
  "what's the deal", 'thoughts on', 'look into', 'holders', 'whos holding', "who's holding",
  'tell me about', 'summary of', 'how is', 'why is', 'explain', 'is this', 'safe to', 'what do you think'];

const clean = (s: string): string => s.toLowerCase().normalize('NFKC').replace(/[.,!?]/g, '').replace(/\s+/g, ' ').trim();
const has = (text: string, phrases: string[]): string | undefined => phrases.find((p) => text.includes(p));
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Whole-word match. Trade verbs MUST match on word boundaries so "copy the mint" is not a COPY buy
// ("cop"), and "escape the shape" is not an ESCAPE buy ("ape") — task-1282 rework D4.
const wordHas = (text: string, phrases: string[]): string | undefined =>
  phrases.find((p) => new RegExp(`(?:^|\\s)${escapeRe(p)}(?:\\s|$)`).test(text));

// ---------- tiny amount parser (for filters) ----------
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, grand: 1e3, m: 1e6, mil: 1e6, million: 1e6, b: 1e9, bil: 1e9, billion: 1e9 };
function parseAmount(fragment: string): { value: number; scaleExplicit: boolean } | null {
  const f = fragment.toLowerCase().replace(/[,$]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = f.match(/(\d+(?:\.\d+)?)\s*(k|m|b|thousand|grand|mil|million|bil|billion)?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const scaleWord = m[2];
  if (scaleWord) return { value: n * (SCALE[scaleWord] ?? 1), scaleExplicit: true };
  return { value: n, scaleExplicit: false };
}
function fmtShort(n: number): string {
  if (n >= 1e9) return (n / 1e9) + 'b';
  if (n >= 1e6) return (n / 1e6) + 'm';
  if (n >= 1e3) return (n / 1e3) + 'k';
  return String(n);
}
function compileFilter(expr: string): string | null {
  const e = expr.toLowerCase();
  const amt = parseAmount(e);
  if (/liquid/.test(e) && amt) return `liq${/over|above|>|more than/.test(e) ? '>' : '<'}${fmtShort(amt.value)}`;
  if (/(age|old|minutes|new)/.test(e) && amt) return `age${/under|below|less than|</.test(e) ? '<' : '>'}${amt.value}m`;
  if (/(mcap|market cap)/.test(e) && amt) return `mc${/over|above|>/.test(e) ? '>' : '<'}${fmtShort(amt.value)}`;
  if (/(vol|volume)/.test(e) && amt) return `vol24${/over|above|>|more than/.test(e) ? '>' : '<'}${fmtShort(amt.value)}`;
  return null;
}

/** A workspace switch phrase → the workspace name, or null. Names are lowercase letters/digits/dashes only. */
function workspaceOf(text: string): string | null {
  if (/\b(show me everything|show everything|everything on|morning (hud|mode|view|workspace)|the trenches are hot|jack me in)\b/.test(text)) return 'morning-hud';
  if (/\b(default|normal|plain) (workspace|view|layout)\b/.test(text) || /\b(close|reset) (the )?workspace\b/.test(text)) return 'default';
  const m = /\b(?:workspace|layout) (?:called |named )?([a-z][a-z0-9-]{0,39})\b/.exec(text) ?? /\b([a-z][a-z0-9-]{0,39}) (?:workspace|layout)\b/.exec(text);
  if (m && !['the', 'a', 'my', 'this', 'that', 'default', 'morning'].includes(m[1])) return m[1];
  return null;
}

const STOP = new Set([...BUY_WORDS, ...SELL_WORDS, 'the', 'a', 'of', 'at', 'if', 'it', 'to', 'and', 'then', 'me',
  'some', 'half', 'all', 'this', 'that', 'one', 'coin', 'token', 'show', 'open', 'go', 'into', 'in', 'my', 'now',
  'please', 'runners', 'pairs', 'screen', 'ignore', 'previous', 'instructions', 'add', 'watch', 'watchlist',
  // task-1339: words that ride along with a trade verb but are never a ticker. "buy it and confirm" means
  // the selected coin, not a token called CONFIRM; "show me the paper trades" is not a token called PAPER.
  'confirm', 'confirmed', 'send', 'execute', 'sign', 'yes', 'ok', 'okay', 'paper', 'live', 'trade', 'trades',
  'ticket', 'order', 'chart', 'popup', 'window', 'position', 'positions', 'bag', 'bags', 'everything', 'max', 'rest']);

const PRONOUN = /\b(this one|this coin|that one|the selected|selected row|it)\b/;

// ---------- spoken number-words (task-1339 F1) ----------
// STT returns sizes as words far more often than digits ("ten sol", "a hundred bucks", "fifty
// percent"), so a digit-only size detector silently drops them. These let `detectSizeSpec` catch the
// word forms too and clarify, exactly like the digit forms. Pure, allocation-light, no model.
const NUM_ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const NUM_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// Every word that can appear inside a spoken quantity. Used to build the match regex below.
const NUM_WORD = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)';
// A spoken quantity phrase: "ten", "twenty five", "a hundred", "a couple", "two point five".
const QTY = `(?:a[\\s-]+(?:hundred|thousand|couple|few)|${NUM_WORD}(?:[\\s-]+${NUM_WORD})*(?:[\\s-]+point[\\s-]+${NUM_WORD}(?:[\\s-]+${NUM_WORD})*)?)`;

/** Convert a spoken quantity phrase to a number, or null if it is not a clean quantity. */
function wordsToNumber(phrase: string): number | null {
  const toks = phrase.toLowerCase().split(/[\s-]+/).filter(Boolean);
  let total = 0, cur = 0, seen = false, i = 0;
  for (; i < toks.length; i++) {
    const t = toks[i];
    if (t === 'point') break;
    if (t === 'a' || t === 'an') continue; // article in "a hundred" — carries no value of its own
    if (t === 'couple') { cur += 2; seen = true; continue; }
    if (t === 'few') { cur += 3; seen = true; continue; }
    if (t in NUM_ONES) { cur += NUM_ONES[t]; seen = true; continue; }
    if (t in NUM_TENS) { cur += NUM_TENS[t]; seen = true; continue; }
    if (t === 'hundred') { cur = (cur || 1) * 100; seen = true; continue; }
    if (t === 'thousand') { total += (cur || 1) * 1000; cur = 0; seen = true; continue; }
    return null; // an unexpected token — not a clean number
  }
  let value = total + cur;
  if (i < toks.length && toks[i] === 'point') {
    let frac = '';
    for (i++; i < toks.length; i++) {
      const d = NUM_ONES[toks[i]];
      if (d === undefined || d > 9) break; // only single spoken digits after "point"
      frac += String(d);
    }
    if (frac) value = parseFloat(`${value}.${frac}`);
  }
  return seen ? value : null;
}
/** A spoken quantity formatted for the clarify line: the parsed number, else the raw words. */
function fmtQty(phrase: string): string {
  const v = wordsToNumber(phrase);
  return v !== null ? String(v) : phrase.trim().replace(/\s+/g, ' ');
}

/**
 * A spoken trade SIZE / amount / slippage. Voice must NOT set these on a ticket silently — size and
 * slippage are money parameters the user confirms on the ticket itself. When one is heard the router
 * CLARIFIES instead of dropping it (task-1339 re-verify: "buy 10 sol of bonk", "buy bonk with max size"
 * and "buy bonk 50 percent slippage" used to open a plain ticket with the size discarded and unmentioned,
 * which breaks the "it clarifies; it never guesses" contract). task-1339 F1: STT usually gives these as
 * WORDS, not digits ("ten sol", "half", "a hundred bucks", "fifty percent"); those must clarify too,
 * never fall through and drop the size. Returns a short human phrase, or null.
 */
function detectSizeSpec(text: string): string | null {
  let m: RegExpMatchArray | null;
  // --- digit forms ---
  if ((m = text.match(/\b(\d+(?:\.\d+)?)\s*sol\b/))) return `${m[1]} SOL`;
  if ((m = text.match(/\$\s*(\d+(?:\.\d+)?)/)) || (m = text.match(/\b(\d+(?:\.\d+)?)\s*(?:dollars?|bucks|usd|usdc)\b/))) return `$${m[1]}`;
  if ((m = text.match(/\b(\d+(?:\.\d+)?)\s*(?:%|percent|pct)\b/))) return /slippage/.test(text) ? `${m[1]}% slippage` : `${m[1]}%`;
  // --- spoken word-number forms (F1): a quantity in words, with or without a unit ---
  if ((m = text.match(new RegExp(`\\b(${QTY})[\\s-]+sols?\\b`)))) return `${fmtQty(m[1])} SOL`;
  if ((m = text.match(new RegExp(`\\b(${QTY})[\\s-]+(?:dollars?|bucks|usd|usdc)\\b`)))) return `$${fmtQty(m[1])}`;
  if ((m = text.match(new RegExp(`\\b(${QTY})[\\s-]+(?:percent|pct)\\b`)))) return /slippage/.test(text) ? `${fmtQty(m[1])}% slippage` : `${fmtQty(m[1])}%`;
  // a bare spoken quantity of a token ("buy twenty of bonk", "a hundred of wif") — size without a unit
  if ((m = text.match(new RegExp(`\\b(${QTY})[\\s-]+of\\b`)))) return `a size of ${fmtQty(m[1])}`;
  // --- fraction of a position ("half", "a quarter", "two thirds") — a size voice must not set silently ---
  if ((m = text.match(/\b(?:(?:a|one|two|three)[\s-]+)?(half|quarter|quarters|third|thirds)\b/))) return m[0].trim().replace(/\s+/g, ' ');
  // --- qualifier forms ---
  if (/\bslippage\b/.test(text)) return 'a slippage setting';
  if (/\b(max|full|whole)\s+(size|position|bag|stack)\b/.test(text)) return 'max size';
  if (/\ball[- ]?in\b/.test(text)) return 'an all-in size';
  return null;
}

/** What an utterance points at: a named ticker, the selected row, several/ambiguous tickers, or nothing. */
type Target =
  | { kind: 'symbol'; symbol: string }
  | { kind: 'selected' }
  | { kind: 'ambiguous'; reason: 'multi' | 'collision'; symbols: string[] }
  | { kind: 'none' };

/**
 * Best-effort ticker from an utterance; the APP resolves it to a mint (the router never guesses one).
 *
 * An explicitly NAMED ticker always beats a pronoun: "buy BONK, confirm it" with WIF selected must
 * resolve to BONK, never the selected row (task-1282 rework D1). A pronoun ("it" / "this one") only
 * wins when no ticker word was spoken. The app still resolves the symbol against the live
 * screener / watchlist / open token and clarifies if it is unknown or ambiguous — the router never
 * silently substitutes the selected coin for a named one.
 *
 * task-1339 re-verify defects 1 & 2:
 *   - Tickers that are ALSO command words (LIVE, SIGN, MAX, SEND, ...) are matched against the visible
 *     symbols BEFORE the stop-word filter. Previously "buy live" (with LIVE on screen) had `live`
 *     stripped as a stop word, so no ticker matched and it silently fell back to the highlighted row.
 *     A lone visible ticker that is also a command word is itself ambiguous → clarify.
 *   - More than one on-screen ticker in one breath ("buy wif and bonk") is ambiguous → clarify, instead
 *     of taking the first and silently dropping the rest.
 */
function resolveTarget(text: string, visible: string[]): Target {
  const vis = new Set(visible.map((s) => s.toLowerCase()));
  const m = text.match(/\$?[a-z][a-z0-9]{1,9}\b/g);
  if (!m) return PRONOUN.test(text) ? { kind: 'selected' } : { kind: 'none' };
  // An explicit $TICKER is unambiguous; two different ones must be disambiguated.
  const dollars = [...new Set(m.filter((w) => w.startsWith('$')).map((w) => w.slice(1).toUpperCase()))].filter(Boolean);
  if (dollars.length > 1) return { kind: 'ambiguous', reason: 'multi', symbols: dollars };
  if (dollars.length === 1) return { kind: 'symbol', symbol: dollars[0] };
  const raw = m.map((w) => w.replace('$', ''));
  // Words the user actually spoke that are TICKERS ON SCREEN — checked BEFORE the stop-word filter.
  const visWords = [...new Set(raw.filter((w) => vis.has(w)))];
  if (visWords.length > 1) return { kind: 'ambiguous', reason: 'multi', symbols: visWords.map((w) => w.toUpperCase()) };
  if (visWords.length === 1) {
    const w = visWords[0];
    if (STOP.has(w)) return { kind: 'ambiguous', reason: 'collision', symbols: [w.toUpperCase()] };
    return { kind: 'symbol', symbol: w.toUpperCase() };
  }
  // No on-screen ticker was spoken. Fall back to the first non-stop word (the app resolves/clarifies an
  // unknown symbol), or the selected row for a pure pronoun.
  const words = raw.filter((w) => !STOP.has(w) && !/^\d+$/.test(w));
  if (words.length === 0 && PRONOUN.test(text)) return { kind: 'selected' };
  if (words[0]) return { kind: 'symbol', symbol: words[0].toUpperCase() };
  return PRONOUN.test(text) ? { kind: 'selected' } : { kind: 'none' };
}

/** The spoken clarifying question for an ambiguous/colliding ticker, phrased for the action verb. */
function clarifyTokenQ(t: Extract<Target, { kind: 'ambiguous' }>, verb: string): string {
  const names = t.symbols.join(' and ');
  return t.reason === 'multi'
    ? `I heard more than one token — ${names}. Which one should I ${verb}?`
    : `Did you mean the token ${names}? Say "${verb} ${t.symbols[0]}" if so, or name another token.`;
}

function detectAction(text: string): { isTrade: boolean; side?: 'buy' | 'sell'; uncertain?: boolean; surface?: string; verb?: string } {
  const words = text.split(' ');
  const buyHit = wordHas(text, BUY_WORDS);
  const sellHit = wordHas(text, SELL_WORDS);
  let homophone: { surface: string; maps: 'buy' | 'sell' } | null = null;
  for (const w of words) if (w in ACTION_HOMOPHONES) homophone = { surface: w, maps: ACTION_HOMOPHONES[w] };
  const side = buyHit && sellHit ? 'both' : buyHit ? 'buy' : sellHit ? 'sell' : (homophone ? homophone.maps : null);
  if (!side) return { isTrade: false };
  if (side === 'both') return { isTrade: true, uncertain: true };
  const uncertain = !!homophone && !buyHit && !sellHit;
  return { isTrade: true, side, uncertain, surface: homophone?.surface, verb: buyHit ?? sellHit };
}

// ── Order-plan grammar (task-1355): recognise a conditional entry + take-profit ladder + moon bag +
// stop. Every market-cap number must carry an EXPLICIT scale (k/m/b); a bare "300" clarifies rather than
// guessing 300k vs 3M. Spoken-word amounts that carry no digit also clarify. Voice never fills a number
// silently — the §6.13 300k-vs-3M trap is caught here, not by luck. ──
const PLAN_CUE = /\b(dips? to|drops? to|falls? to|if it (?:dips|drops|falls|hits|gets|reaches)|when it (?:hits|reaches|gets)|take[\s-]?profit|moon[\s-]?bag|leave (?:a|the) bag|keep (?:a|the) bag|sell (?:half|a quarter|a third|\d+\s*(?:%|percent))|stop (?:loss )?(?:at|below|under))\b/;

function parseFraction(frag: string): number | null {
  if (/\bhalf\b/.test(frag)) return 0.5;
  if (/\bquarter\b/.test(frag)) return 0.25;
  if (/\bthird\b/.test(frag)) return 1 / 3;
  const pct = frag.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)\b/);
  if (pct) return Number(pct[1]) / 100;
  return null;
}

type PlanParse =
  | { ok: true; entry: { mcUsd: number } | null; exits: { mcUsd: number; fraction: number }[]; stopMcUsd: number | null; moonBag: boolean }
  | { ok: false; reason: string; question: string };

function parsePlanSpec(utterance: string): PlanParse {
  // Normalise but KEEP the decimal point: the router's global clean() strips '.', which would turn
  // "1.2m" into "12m" — a 10x error. Commas become spaces so clause boundaries stay word-boundaries.
  const text = utterance.toLowerCase().normalize('NFKC').replace(/[,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  const exits: { mcUsd: number; fraction: number }[] = [];
  let entry: { mcUsd: number } | null = null;
  let stopMcUsd: number | null = null;
  const moonBag = /\bmoon[\s-]?bag\b|\bleave (?:a|the) bag\b|\bkeep (?:a|the) bag\b/.test(text);
  const scaleQ = (what: string, raw: number): PlanParse => ({ ok: false, reason: 'ambiguous market-cap scale', question: `Did you mean ${raw}k or ${raw} million for the ${what}? Say the scale, e.g. "${raw}k".` });

  const em = text.match(/(?:dips?|drops?|falls?)\s+(?:down\s+)?to\s+([a-z0-9.\s]+?)(?=[,;]|$|\bsell\b|\btake\b|\bstop\b|\bkeep\b|\bleave\b|\band\b)/)
    || text.match(/\bif it (?:dips|drops|falls|hits|gets to|reaches)\s+(?:to\s+)?([a-z0-9.\s]+?)(?=[,;]|$|\bsell\b|\btake\b|\bstop\b|\bkeep\b|\bleave\b|\band\b)/);
  if (em) {
    const a = parseAmount(em[1]);
    if (!a) return { ok: false, reason: 'entry unparsable', question: 'What market cap should it dip to? e.g. "300k".' };
    if (!a.scaleExplicit) return scaleQ('entry', a.value);
    entry = { mcUsd: a.value };
  }

  const tpRe = /\b(?:sell|take[\s-]?profit(?:\s+of)?)\s+(half|a quarter|a third|\d+\s*(?:%|percent))\s+(?:at|when it (?:hits|reaches))\s+([a-z0-9.\s]+?)(?=[,;]|$|\bsell\b|\btake\b|\bstop\b|\bkeep\b|\bleave\b|\band\b)/g;
  let tm: RegExpExecArray | null;
  while ((tm = tpRe.exec(text)) !== null) {
    const frac = parseFraction(tm[1]);
    if (frac == null) return { ok: false, reason: 'take-profit fraction unclear', question: 'What fraction should I sell at each level? e.g. "sell half".' };
    const a = parseAmount(tm[2]);
    if (!a) return { ok: false, reason: 'take-profit level unparsable', question: 'At what market cap should I take profit? e.g. "600k".' };
    if (!a.scaleExplicit) return scaleQ('take-profit', a.value);
    exits.push({ mcUsd: a.value, fraction: frac });
  }

  const sm = text.match(/\bstop\s+(?:loss\s+)?(?:at|below|under)\s+([a-z0-9.\s]+?)(?=[,;]|$|\band\b)/);
  if (sm) {
    const a = parseAmount(sm[1]);
    if (!a) return { ok: false, reason: 'stop unparsable', question: 'At what market cap should the stop trigger? e.g. "150k".' };
    if (!a.scaleExplicit) return scaleQ('stop', a.value);
    stopMcUsd = a.value;
  }

  return { ok: true, entry, exits, stopMcUsd, moonBag };
}

/**
 * Route one transcribed utterance. `prov` carries the push-to-talk / diarization / echo facts that
 * gate the decision before any language understanding runs.
 */
export function route(utterance: string, prov: VoiceProvenance, screen: VoiceScreenState = {}): VoiceDecision {
  // --- Gate 0: audio provenance. Guards against stray room audio ever reaching an action. ---
  if (!prov.pttActive) return { kind: 'ignore', reason: 'push-to-talk not active; audio ignored' };
  if (prov.speakerCount > 1) return { kind: 'ignore', reason: `multiple speakers (${prov.speakerCount}); ignoring` };
  if (prov.echoFlagged) return { kind: 'ignore', reason: 'echo/TV audio detected; ignoring' };

  const text = clean(utterance);
  if (!text) return { kind: 'ignore', reason: 'empty utterance' };
  if (prov.sttConfidence < 0.45) return { kind: 'clarify', reason: 'low STT confidence', question: "I didn't catch that — say it again?" };

  const visible = screen.visibleSymbols ?? [];

  // --- Popup panels (task-1339): "show the chart", "pop the chart", "close the chart". Decided before
  // the trade verbs so "close the chart" can never become a SELL of a token called CHART. ---
  const chart = /\b(the |my |a )?(chart|chart popup|popup chart|chart window)\b/.test(text);
  if (chart) {
    if (/\b(close|hide|kill|dismiss|shut)\b/.test(text)) return { kind: 'popup', panel: 'chart', open: false, say: 'closing the chart' };
    if (/\b(show|open|pop|pull up|bring up|popup|pop up|give me)\b/.test(text)) return { kind: 'popup', panel: 'chart', open: true, say: 'opening the chart' };
  }

  // --- Workspaces (task-1358): decided before the trade verbs and the screen names so "show me everything"
  // is the morning HUD, not a navigation to a token called EVERYTHING. Never combined with a trade. ---
  const ws = workspaceOf(text);
  if (ws && !detectAction(text).isTrade) return { kind: 'workspace', name: ws, say: ws === 'morning-hud' ? 'morning HUD' : ws === 'default' ? 'default workspace' : `${ws} workspace` };

  const trade = detectAction(text);
  const navLead = NAV_LEAD.test(text);
  const navScreen = (() => { for (const [scr, phrases] of Object.entries(SCREENS)) if (has(text, phrases)) return scr; return null; })();

  // --- Compound / injected-audio pattern: a navigation command AND a trade verb in one breath
  // ("show runners and sell all my bonk"). Never split it silently; ask which was meant. ---
  if ((navLead || navScreen) && trade.isTrade) {
    return { kind: 'clarify', reason: 'compound command (navigation + trade in one utterance)',
      question: 'I heard a screen command and a trade in one breath — say just one.' };
  }

  // --- Navigation (instant, no model): "show me the runners", "go to watchlist". ---
  if ((navLead || navScreen) && !trade.isTrade) {
    if (navScreen) return { kind: 'navigate', screen: navScreen, say: navScreen };
    // "open <ticker>" / "pull up <ticker>" with no screen name -> open a token.
    const tgt = resolveTarget(text.replace(NAV_LEAD, '').trim(), visible);
    if (tgt.kind === 'ambiguous') return { kind: 'clarify', reason: `ambiguous token (${tgt.reason})`, question: clarifyTokenQ(tgt, 'open') };
    if (tgt.kind === 'symbol') return { kind: 'open-token', target: tgt.symbol, say: tgt.symbol };
    if (tgt.kind === 'selected') return { kind: 'open-token', target: '__selected__', say: 'this one' };
  }

  // --- Filter: "filter liquidity over 50k", "only show age under 10 minutes". ---
  const filterMatch = text.match(/\b(filter|set filter|only show|show only)\b\s*(.*)$/);
  if (filterMatch && filterMatch[2] && !trade.isTrade) {
    const expr = compileFilter(filterMatch[2]);
    if (expr) return { kind: 'filter', expr, say: `filter ${expr}` };
    return { kind: 'clarify', reason: 'unparsable filter', question: 'Filter on what? e.g. "liquidity over 50k" or "age under 10 minutes".' };
  }

  // --- Watchlist: "watch this one", "add bonk to my watchlist". ---
  if (/\b(watch|add to (my )?watchlist|watchlist)\b/.test(text) && !trade.isTrade) {
    const tgt = resolveTarget(text, visible);
    if (tgt.kind === 'ambiguous') return { kind: 'clarify', reason: `ambiguous token (${tgt.reason})`, question: clarifyTokenQ(tgt, 'watch') };
    const sym = tgt.kind === 'symbol' ? tgt.symbol : '__selected__';
    return { kind: 'watchlist', target: sym, say: `watch ${sym === '__selected__' ? 'this one' : sym}` };
  }

  // --- Order-plan PROPOSAL (task-1355): a trade verb with a conditional/ladder cue ("buy this if it
  // dips to 300k, sell half at 600k, moon bag"). Voice PROPOSES only; arming needs a physical keypress.
  // Decided before the plain ticket so "buy if it dips to 300k" is a plan, not an instant buy ticket.
  // Any mishear — unscaled number, ambiguous token, unclear fraction — clarifies, never guesses. ---
  if (trade.isTrade && PLAN_CUE.test(text)) {
    // A plan legitimately names both sides ("BUY the entry, SELL the ladder"), so the side comes from the
    // LEADING verb, not detectAction's both-sides uncertainty. An unclear lead clarifies.
    const buyLead = new RegExp(`^(?:${BUY_WORDS.join('|')})\\b`).test(text);
    const sellLead = new RegExp(`^(?:${SELL_WORDS.join('|')})\\b`).test(text);
    const planSide: 'buy' | 'sell' | null = buyLead ? 'buy' : (sellLead || (wordHas(text, SELL_WORDS) && !wordHas(text, BUY_WORDS))) ? 'sell' : null;
    if (planSide) {
      // A plan binds to a MINT: an explicitly-named visible symbol, else the open/selected token. We do
      // NOT run the general ticker resolver here — a filler word ("dips") must never become a ticker.
      const named = visible.find((s) => new RegExp(`\\b${s.toLowerCase().replace(/[^a-z0-9]/g, '')}\\b`).test(text));
      // task-1355 verify fix: a ticker the user NAMED right after the verb ("buy zzqq if it dips…") that is
      // not on screen must clarify — never silently become the highlighted row (the ticket path's "a named
      // ticker beats a pronoun; no fuzzy match" rule applies to plans too). Only the verb's object word is
      // considered, so a filler word later in the sentence ("dips") can still never become a ticker.
      if (!named) {
        const obj = text.match(new RegExp(`^(?:${[...BUY_WORDS, ...SELL_WORDS].join('|')})\\s+(?:into\\s+|some\\s+|more\\s+)?\\$?([a-z][a-z0-9]{1,9})\\b`))?.[1];
        if (obj && !STOP.has(obj) && !PRONOUN.test(obj) && !/^\d+$/.test(obj)) {
          return { kind: 'clarify', reason: 'order plan names a token not on screen', question: `I don't see a token called ${obj.toUpperCase()} — open it first, then say the plan.` };
        }
      }
      const sym = named ?? (screen.selected ? '__selected__' : null);
      if (!sym) return { kind: 'clarify', reason: 'order plan with no target token', question: 'Set a plan on which token? Open it or say the ticker.' };
      const spec = parsePlanSpec(utterance);
      if (!spec.ok) return { kind: 'clarify', reason: spec.reason, question: spec.question };
      if (spec.entry || spec.exits.length > 0 || spec.stopMcUsd !== null) {
        const who = sym === '__selected__' ? 'this token' : sym;
        return { kind: 'propose-plan', side: planSide, target: sym, entry: spec.entry, exits: spec.exits, stopMcUsd: spec.stopMcUsd, moonBag: spec.moonBag,
          say: `drafting an order plan for ${who} — review the card and hold to arm (I can't arm it by voice)` };
      }
    }
    // a cue word but no clear side / nothing structured parsed: fall through to the normal ticket path.
  }

  // --- Interrogative phrasing is an ANALYSIS question even if it contains a trade word ("should I
  // ape this?"). Imperative trade commands ("buy ...", "sell ...") stay on the ticket path. ---
  const interrogative = /^(is|are|should|what|whats|why|how|who|does|do|can|could|would|tell|thoughts)\b/.test(text) || utterance.trim().endsWith('?');
  const imperativeTrade = new RegExp(`^(${[...BUY_WORDS, ...SELL_WORDS].join('|')})\\b`).test(text);
  if (interrogative && !imperativeTrade) return { kind: 'analyst', question: utterance.trim() };

  // --- Trade verb -> OPEN a PAPER ticket only (never confirm). ---
  if (trade.isTrade) {
    if (trade.uncertain) {
      const q = trade.side
        ? `Did you mean ${trade.side}? I heard "${trade.surface ?? ''}". Say "${trade.side}" or the other side.`
        : 'I heard both buy and sell — say just one.';
      return { kind: 'clarify', reason: 'trade action uncertain', question: q };
    }
    // task-1339 re-verify defect 3: a spoken size / amount / slippage is a money parameter voice must
    // not set silently. Clarify and send the user to the ticket to set it there.
    const size = detectSizeSpec(text);
    if (size) return { kind: 'clarify', reason: 'trade size/slippage spoken',
      question: `I heard ${size}, but I don't set trade size or slippage by voice — open the ticket and set it there, or just say "${trade.side} <ticker>".` };
    const tgt = resolveTarget(text, visible);
    // A ticker that is also a command word (LIVE/SIGN/...) or more than one ticker in one breath is
    // ambiguous: clarify instead of silently trading the highlighted row or the first ticker (defects 1 & 2).
    if (tgt.kind === 'ambiguous') return { kind: 'clarify', reason: `ambiguous ticker (${tgt.reason})`, question: clarifyTokenQ(tgt, trade.side!) };
    // "close" / "exit" with nothing named and no pronoun is ambiguous ("close the window"? "exit"?):
    // clarify rather than open a SELL for whatever happens to be highlighted (task-1339, N6).
    if (tgt.kind === 'none' && (trade.verb === 'close' || trade.verb === 'exit')) {
      return { kind: 'clarify', reason: 'bare close/exit with no target', question: `${trade.verb === 'close' ? 'Close' : 'Exit'} what? Say "sell <ticker>" or "sell this one".` };
    }
    const sym = tgt.kind === 'symbol' ? tgt.symbol : '__selected__';
    return { kind: 'open-ticket', side: trade.side!, target: sym,
      say: `opening a ${trade.side} ticket for ${sym === '__selected__' ? 'this token' : sym} — review and press enter to confirm` };
  }

  // --- Analysis hints or a trailing question mark -> the analyst. ---
  if (has(text, ANALYSIS_HINTS) || utterance.trim().endsWith('?')) return { kind: 'analyst', question: utterance.trim() };

  // --- Default: treat it as a question for the analyst rather than guessing an action. ---
  return { kind: 'analyst', question: utterance.trim() };
}
