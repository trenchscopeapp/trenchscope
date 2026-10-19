// @dexterm/packs — the AI analysis suite (task-1356, AI-SUITE-DESIGN). Public surface, grown tier by tier.
//
// Tier 1: analysis packs (token-dossier, wallet-dossier) — a deterministic ASSEMBLE stage over the
// read-only tools and an optional tool-less REASON stage that may only tighten, every model block
// labelled model output with data ages, untrusted text firewalled.

export * from './firewall.ts';
export * from './token-dossier.ts';
export * from './wallet-dossier.ts';
export * from './schema.ts';
export * from './reason.ts';
export * from './verdicts.ts';
export * from './narrative.ts';

// Tier 3: one-line digests (watchlist + new pairs). Tier 4: rug-probability model (H1 v0 + logistic v1,
// scored in-app at zero model cost). Tier 5: backtest harness over recorder history (honest metrics).
export * from './digest.ts';
export * from './rug-model.ts';
export * from './backtest.ts';
// task-1359: LARP eval (recorded product verdicts vs outcome labels; counts only below n = 50).
export * from './larp-eval.ts';
export * from './skill-backtest.ts';
// task-1414: skill care — rolling split, the proposal gate (new-coins + interval-noise + frozen canary), trend.
export * from './skill-care.ts';
