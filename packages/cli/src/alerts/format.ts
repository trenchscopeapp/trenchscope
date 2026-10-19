// trenchscope — turn a rule-engine alert / proposal into a firewalled AlertDelivery (task-1398). Pure.
//
// Untrusted text (a token symbol, and whatever the user put in the rule's alert text) is run through the
// prompt firewall (control/bidi/ANSI stripped, URLs → [url], foreign base58 → [addr], wide glyphs → ▯,
// injection-like content neutralised) and the spoken form through the `say` sanitiser (defuses `[[…]]`,
// shortens addresses). Nothing reaches a channel raw.
import { firewallText } from '@dexterm/data/core';
import { sanitizeSpeech } from '@dexterm/voice';
import type { RuleAlert, RuleProposal } from '@dexterm/custom';
// task-1399: a TYPE-only import — the delivery layer never loads a trading/copy runtime module (its safety invariant).
import type { CopyAlert } from '@dexterm/data/copy';
import type { AlertDelivery } from './types.ts';

const TITLE_MAX = 64;
const BODY_MAX = 180;

/** Local short address (the copy module's own, inlined so the delivery layer imports no copy runtime). */
function shortAddr(a: string): string { return a.length <= 10 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`; }

/** Firewall a string; keep the row's own mint readable, drop URLs, cap length. */
function fw(s: string, max: number, mint?: string | null): string {
  return firewallText(s, { keepMint: mint ?? null, keepUrls: false, max }).text;
}

export function alertToDelivery(a: RuleAlert): AlertDelivery {
  const symbol = fw(a.symbol, 24) || '?';
  const body = fw(a.text, BODY_MAX, a.mint);
  const title = `${symbol} ⚑`.slice(0, TITLE_MAX);
  return {
    kind: 'alert', level: a.level, title, body,
    spoken: sanitizeSpeech(`${symbol}. ${body}`),
    symbol, mint: a.mint, source: a.source, rule: a.rule, at: a.at,
  };
}

export function proposalToDelivery(p: RuleProposal): AlertDelivery {
  const symbol = fw(p.symbol, 24) || '?';
  const what = p.type === 'ticket'
    ? `rule proposes ${p.side} ${p.size} ${p.unit} — confirm in the app (nothing armed)`
    : `rule asks the analyst: ${p.skill}`;
  const body = fw(what, BODY_MAX, p.mint);
  const title = `${symbol} ⚑ proposal`.slice(0, TITLE_MAX);
  return {
    kind: 'proposal', level: 'info', title, body,
    spoken: sanitizeSpeech(`${symbol}. ${body}`),
    symbol, mint: p.mint, source: p.source, rule: p.rule, at: p.at,
  };
}

/**
 * task-1399 — a WALLET TRACKER event (a followed wallet's decoded buy/sell) as a firewalled AlertDelivery, so a
 * follow alert reaches the same push channels (desktop / Telegram / Discord) as a rule alert. The delivery layer
 * stays read-only: this only READS the CopyAlert. `source` is `follow`; `rule` names the followed wallet (short,
 * never a real-person label beyond the user's own words). A buy is `up`, a sell `down`. No performance claim: the
 * body states the fill and carries "not a recommendation".
 */
export function copyAlertToDelivery(a: CopyAlert): AlertDelivery {
  const tr = a.trade;
  const did = tr.side === 'buy' ? 'bought' : 'sold';
  const who = fw(a.name ?? shortAddr(a.wallet), 24) || shortAddr(a.wallet);
  const mintShort = shortAddr(tr.mint);
  const usd = tr.usd !== null ? ` ≈ $${tr.usd.toFixed(0)}` : '';
  const sol = tr.solDelta !== null ? ` (${Math.abs(tr.solDelta).toFixed(3)} SOL)` : '';
  const symbol = mintShort;
  const title = `follow: ${who} ${did}`.slice(0, TITLE_MAX);
  const body = fw(`${who} ${did} ${mintShort}${usd}${sol} · not a recommendation`, BODY_MAX, tr.mint);
  return {
    kind: 'alert', level: tr.side === 'buy' ? 'up' : 'down', title, body,
    spoken: sanitizeSpeech(`${who} ${did} ${mintShort}${usd}`),
    symbol, mint: tr.mint, source: 'follow', rule: shortAddr(a.wallet), at: a.t,
  };
}

/** The one-line form a text channel sends (Telegram / Discord / stdout toast). */
export function deliveryLine(d: AlertDelivery): string {
  return d.title === `${d.symbol} ⚑` ? `${d.title} ${d.body}` : `${d.title} — ${d.body}`;
}
