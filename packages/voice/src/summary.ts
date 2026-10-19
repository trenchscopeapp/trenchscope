// Turn an analyst answer into its spoken form. It used to read only the FIRST ~2 sentences; since 2026-10-12
// the whole answer is read, so the default is now every sentence, capped for sanity (a long-form dossier). The analyst's answer arrives either as a verdict + summary lines (structured
// skills) or as free prose (chat follow-ups); this flattens both and trims to a speakable length.
//
// Pure and dependency-free so it is unit-tested headless.

/** The subset of an AnalystSession we read for the spoken line. */
export interface SpokenSource {
  verdict?: string | null;
  summary?: string[];
  text?: string;
}

const MAX_CHARS = 1800;

/** Collapse whitespace and strip markup/markdown that would be read aloud as noise. */
function tidy(s: string): string {
  return s
    .replace(/[*_`#>]/g, ' ')          // markdown emphasis / headings / code / quotes
    .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => m.replace(/\]\([^)]*\)/, ']').replace(/[[\]]/g, '')) // [label](url) -> label
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split into sentences on ., !, ? boundaries, keeping it simple and robust. */
export function splitSentences(text: string): string[] {
  const t = tidy(text);
  if (!t) return [];
  const parts = t.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  return (parts ?? [t]).map((s) => s.trim()).filter(Boolean);
}

/**
 * Build the spoken summary. A verdict (e.g. "AVOID", "LARP") is spoken first as its own short clause,
 * then the whole answer (every summary/prose sentence unless `maxSentences` limits it). Capped at MAX_CHARS.
 */
export function spokenSummary(src: SpokenSource, maxSentences = Infinity): string {
  const chunks: string[] = [];
  const verdict = (src.verdict ?? '').trim();
  if (verdict) chunks.push(`Verdict: ${verdict}.`);

  const body = (src.summary && src.summary.length ? src.summary.join('. ') : (src.text ?? '')).trim();
  const sentences = splitSentences(body).slice(0, maxSentences);
  chunks.push(...sentences);

  let out = tidy(chunks.join(' '));
  if (out.length > MAX_CHARS) {
    // Cut at the last sentence boundary that fits, else hard-trim.
    const cut = out.slice(0, MAX_CHARS);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    out = (lastStop > 80 ? cut.slice(0, lastStop + 1) : cut.trimEnd() + '…');
  }
  return out;
}
