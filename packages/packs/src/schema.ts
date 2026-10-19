// Reasoning-stage output schemas (AI-SUITE-DESIGN §2, research/task-1287/packs/schemas). Passed to the
// user's claude CLI with `--json-schema` so the model answers in exactly this shape, and re-validated in
// code afterwards (checkTokenVerdict / checkWalletVerdict in reason.ts) — never trust the CLI alone.
//
// Kept as plain objects (not JSON files) so the package is self-contained and the shapes typecheck here.

export const TOKEN_DOSSIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pack', 'pack_version', 'mint', 'verdict', 'confidence', 'rug_probability', 'summary', 'facts', 'flags', 'invalidation', 'proposals', 'injection_detected', 'missing_data', 'sources_used'],
  properties: {
    pack: { type: 'string', enum: ['token-dossier'] },
    pack_version: { type: 'string' },
    mint: { type: 'string' },
    verdict: { type: 'string', enum: ['WATCH', 'SPECULATIVE', 'AVOID', 'INSUFFICIENT_DATA', 'AMBIGUOUS'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rug_probability: { type: 'number', minimum: 0, maximum: 1, description: "model's probability the token rugs or dies within 72 h" },
    summary: { type: 'string', maxLength: 600 },
    facts: {
      type: 'array', maxItems: 20,
      items: { type: 'object', additionalProperties: false, required: ['claim', 'tool', 'field', 'value'],
        properties: { claim: { type: 'string', maxLength: 160 }, tool: { type: 'string' }, field: { type: 'string' }, value: { type: ['number', 'string', 'boolean', 'null'] }, age_sec: { type: ['number', 'null'] } } },
    },
    flags: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    invalidation: { type: 'string', maxLength: 240 },
    proposals: {
      type: 'array', maxItems: 5,
      items: { type: 'object', additionalProperties: false, required: ['type', 'text'],
        properties: { type: { type: 'string', enum: ['alert', 'note', 'watchlist'] }, text: { type: 'string', maxLength: 200 }, condition: { type: 'string', maxLength: 120 } } },
    },
    injection_detected: { type: 'boolean' },
    missing_data: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 10 },
    sources_used: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['tool'], properties: { tool: { type: 'string' }, source: { type: 'string' }, age_sec: { type: ['number', 'null'] } } } },
  },
} as const;

export const WALLET_DOSSIER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pack', 'pack_version', 'wallet', 'verdict', 'confidence', 'summary', 'facts', 'labels_restated', 'flags', 'proposals', 'injection_detected', 'missing_data', 'sources_used'],
  properties: {
    pack: { type: 'string', enum: ['wallet-dossier'] },
    pack_version: { type: 'string' },
    wallet: { type: 'string' },
    verdict: { type: 'string', enum: ['SMART', 'NEUTRAL', 'SUSPECT', 'INSUFFICIENT_DATA'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string', maxLength: 600 },
    facts: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['claim', 'tool', 'field', 'value'], properties: { claim: { type: 'string', maxLength: 160 }, tool: { type: 'string' }, field: { type: 'string' }, value: { type: ['number', 'string', 'boolean', 'null'] }, age_sec: { type: ['number', 'null'] } } } },
    labels_restated: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['label', 'rule', 'confidence'], properties: { label: { type: 'string' }, rule: { type: 'string' }, confidence: { type: 'string', enum: ['on-chain', 'program-authority', 'derived', 'seed', 'weak', 'user'] } } } },
    flags: { type: 'array', items: { type: 'string' }, maxItems: 20 },
    proposals: { type: 'array', maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['type', 'text'], properties: { type: { type: 'string', enum: ['alert', 'note', 'watchlist', 'follow_wallet'] }, text: { type: 'string', maxLength: 200 }, condition: { type: 'string', maxLength: 120 } } } },
    injection_detected: { type: 'boolean' },
    missing_data: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    sources_used: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['tool'], properties: { tool: { type: 'string' }, source: { type: 'string' }, age_sec: { type: ['number', 'null'] } } } },
  },
} as const;
