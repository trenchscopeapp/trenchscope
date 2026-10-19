// Prompt firewall for the pack engine (SPEC §5.3 CL-06, AI-SUITE-DESIGN §9). Token-derived strings
// (symbol, name, description, risk text) are DATA, never instructions. The MCP tools already wrap the
// strings they return in <untrusted> blocks (packages/mcp/src/server.ts `firewall`); this module is the
// same contract for pack-side text that did not come through an MCP tool (e.g. a watchlist row's raw
// symbol fed into a digest prompt) plus the injection scan every pack runs over its assembled sections.
//
// Two pieces of hard-won guidance from the prototype (AI-SUITE-DESIGN §9):
//   1. escape </>  so a description cannot close its own <untrusted> wrapper;
//   2. the injection scan looks only INSIDE <untrusted> blocks — instruction-like prose there is the red
//      flag, not instruction-like prose in the (first-party) rest of the object.

/** Control, bidi and zero-width code points dropped from any stored/printed string. */
const STRIP_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠⁦-⁩﻿]/g;

/** Max kept length per kind of untrusted string. */
export const UNTRUSTED_LIMITS: Record<string, number> = { symbol: 16, name: 64, description: 512, risk: 160, text: 256 };

function escapeXml(v: string): string {
  return v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** Strip control/bidi/zero-width, collapse whitespace, cap length. The display-safe form of a string. */
export function clean(text: unknown, max = 256): string {
  if (text === null || text === undefined) return '';
  let s = String(text).normalize('NFC').replace(STRIP_RE, '').replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max) + '…';
  return s;
}

/**
 * Wrap token-derived text as untrusted DATA for a model prompt: clean it, escape `<`/`>`/`&`/`"` so it
 * cannot close its wrapper or inject attributes, cap the length, and tag it with its source and kind.
 * Returns '' for empty input (so callers can omit the field).
 */
export function wrapUntrusted(text: unknown, source: string, kind = 'text'): string {
  if (text === null || text === undefined || text === '') return '';
  const s = clean(text, UNTRUSTED_LIMITS[kind] ?? 256);
  if (!s) return '';
  return `<untrusted source="${escapeXml(source)}" kind="${escapeXml(kind)}">${escapeXml(s)}</untrusted>`;
}

/** Instruction-like phrases that are a red flag when they appear inside an <untrusted> block. */
const INJECTION_RE = /(ignore (?:all |any |the |prior |previous |above |these |those )*(?:instructions|context|prompt)|system (note|prompt|message)|disregard (the )?above|output (the )?verdict|you (must|should|are now)|as an ai|do not (flag|warn)|mark (this |it )?(as )?(safe|watch|buy)|override)/i;

/**
 * Scan an assembled object for prompt injection: JSON-stringify it, then test only the text INSIDE
 * `<untrusted …>…</untrusted>` blocks for instruction-like phrasing. Returns true when any untrusted
 * block contains such a phrase. (The MCP firewall escapes `<`/`>` inside blocks, so a block's content is
 * a single run of non-`<` text; we match that run.)
 */
export function scanForInjection(assembled: unknown): boolean {
  const json = typeof assembled === 'string' ? assembled : JSON.stringify(assembled);
  const re = /<untrusted\b[^>]*>([^<]*)<\/untrusted>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(json)) !== null) {
    if (INJECTION_RE.test(m[1])) return true;
  }
  return false;
}
