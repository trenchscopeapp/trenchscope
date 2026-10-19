// `trenchscope plan …` and `trenchscope mandate …` — typed order-plan + standing-mandate CLI (task-1355).
//
//   trenchscope plan propose --mint M --symbol S --size 20 --entry mc-below:300k [--tp mc-above:600k:50%]…
//                        [--stop mc-below:150k] [--decimals 6] [--supply 1b] [--slippage 300]
//   trenchscope plan list [--json]
//   trenchscope plan arm <planId> --mandate <id>     # requires a PHYSICAL keypress on a TTY (refuses pipes)
//   trenchscope plan amend <planId> [--size 25] [--entry …] [--tp …]… [--stop …|none] [--slippage N]   # task-1363
//   trenchscope plan cancel <planId>
//   trenchscope plan journal [--verify] [--export]
//   trenchscope mandate draft [--total 100] [--per-trade 20] [--per-coin 40] [--daily-loss 50]
//                         [--max-tier keypress|ptt-held|hands-free] [--ttl-hours 4]
//   trenchscope mandate list [--json] | arm <id> | revoke <id>
//
// Arming is the only gate: `arm` reads ONE real keystroke in raw mode (ttyKeypress) and refuses a pipe,
// a subprocess, a voice router or an agent — exactly like `trenchscope wallet resume`. Proposing never arms.
// Default runs are PAPER (no key, no wallet, no mainnet); the journal under ~/.dexterm/plans.journal is
// the hash-chained audit log + recovery source.

import {
  PlanService, defaultPlansJournalPath, parseAmount, parseTrigger, parseExit, planStatusLabel, fmtUsd,
  PlanError, PolicyRefusal, MandateError, ConfirmError,
  type PlanInput, type TierName,
} from '@dexterm/data/plans';
import { ttyKeypress } from './wallet-cmd.ts';
import type { Io } from './main.ts';

function flag(rest: string[], name: string): string | undefined { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; }
function has(rest: string[], name: string): boolean { return rest.includes(name); }
/** Collect every value after each occurrence of `name` (for repeatable flags like --tp). */
function flags(rest: string[], name: string): string[] { const out: string[] = []; for (let i = 0; i < rest.length; i++) if (rest[i] === name && rest[i + 1] !== undefined) out.push(rest[i + 1]); return out; }

function openService(rest: string[], io: Io): PlanService {
  const journalPath = flag(rest, '--journal') ?? defaultPlansJournalPath(io.env);
  return new PlanService({ journalPath });
}

function errMsg(e: unknown): string {
  if (e instanceof PlanError || e instanceof PolicyRefusal || e instanceof MandateError || e instanceof ConfirmError) return `${e.reason}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

const PLAN_USAGE = `trenchscope plan <command>
  propose --mint M --size 20 --entry mc-below:300k [--symbol S] [--decimals 6] [--supply 1b]
          [--tp mc-above:600k:50%]… [--stop mc-below:150k] [--slippage 300] [--side buy|sell] [--json]
  list [--json]
  arm <planId> --mandate <id>        (needs a physical keypress on a TTY; a pipe/agent is refused)
  amend <planId> [--size 25] [--entry mc-below:280k] [--tp mc-above:600k:50%]… [--stop mc-below:150k|none] [--slippage N]
                                     (a PROPOSED plan only: the edit is a NEW plan with a new hash; the old one is
                                      superseded and every earlier confirmation is void; re-arm by keypress)
  cancel <planId>
  journal [--verify] [--export]`;

const MANDATE_USAGE = `trenchscope mandate <command>
  draft [--total 100] [--per-trade 20] [--per-coin 40] [--daily-loss 50]
        [--max-tier keypress|ptt-held|hands-free] [--ttl-hours 4] [--json]
  list [--json]
  arm <id>                           (needs a physical keypress on a TTY; a pipe/agent is refused)
  revoke <id>`;

export async function runPlan(rest: string[], io: Io): Promise<number> {
  const cmd = rest[0];
  const out = (s: string) => io.stdout.write(s + '\n');
  const errOut = (s: string) => io.stderr.write(s + '\n');
  try {
    switch (cmd) {
      case 'propose': {
        const mint = flag(rest, '--mint');
        if (!mint) { errOut('trenchscope plan propose: --mint is required'); return 2; }
        const sizeStr = flag(rest, '--size');
        if (!sizeStr) { errOut('trenchscope plan propose: --size is required (USD)'); return 2; }
        const entryStr = flag(rest, '--entry') ?? 'immediate';
        const supply = parseAmount(flag(rest, '--supply') ?? '1b');
        const input: PlanInput = {
          mint, symbol: flag(rest, '--symbol'), decimals: Number(flag(rest, '--decimals') ?? 6),
          side: flag(rest, '--side') ?? 'buy', sizeUsd: parseAmount(sizeStr),
          entry: parseTrigger(entryStr),
          exits: flags(rest, '--tp').map(parseExit),
          stop: flag(rest, '--stop') ? parseTrigger(flag(rest, '--stop')!) : null,
          slippageBps: flag(rest, '--slippage') ? Number(flag(rest, '--slippage')) : undefined,
        };
        const svc = openService(rest, io);
        const plan = svc.propose(input, { supply, by: 'user' });
        if (has(rest, '--json')) { out(JSON.stringify({ id: plan.id, hash: plan.hash, readBack: svc.readBack(plan.id) })); return 0; }
        out(`proposed ${plan.id}`);
        out(`  ${svc.readBack(plan.id)}`);
        out('  PROPOSAL only — not armed. Arm with: trenchscope plan arm ' + plan.id + ' --mandate <id>  (physical keypress)');
        return 0;
      }
      case 'list': {
        const svc = openService(rest, io);
        const rows = svc.listPlans();
        if (has(rest, '--json')) { out(JSON.stringify(rows)); return 0; }
        if (!rows.length) { out('no plans'); return 0; }
        for (const r of rows) out(`${r.id.padEnd(22)} ${planStatusLabel(r)}`);
        return 0;
      }
      case 'arm': {
        const planId = rest[1];
        const mandateId = flag(rest, '--mandate');
        if (!planId || !mandateId) { errOut('usage: trenchscope plan arm <planId> --mandate <id>'); return 2; }
        const svc = openService(rest, io);
        const plan = svc.engine.plan(planId);
        if (!plan) { errOut(`no such plan ${planId}`); return 1; }
        out(`Arm this plan into ${mandateId}?`);
        out(`  ${svc.readBack(planId)}`);
        out('Hold any key to confirm (physical keypress). A pipe or agent cannot arm. Waiting 15s…');
        const key = await ttyKeypress(io.stdin as never, 15_000);
        if (key === null) { errOut('refused: no physical keypress (stdin is not a TTY, or timed out). Voice/agents can never arm.'); return 1; }
        svc.armPlanByKeypress(planId, mandateId);
        out(`armed ${planId} into ${mandateId}`);
        return 0;
      }
      case 'amend': {
        // task-1363 (card item 3): edit a PROPOSED plan without the cancel + re-propose dance. The engine's amend
        // is the existing primitive: a mutated plan is a NEW plan (new id, new hash), the old proposal is
        // superseded, and nothing armed can be edited (cancel it first). Arming the new plan is a new keypress.
        const planId = rest[1];
        if (!planId) { errOut('usage: trenchscope plan amend <planId> [--size USD] [--entry TRIGGER] [--tp EXIT]… [--stop TRIGGER|none] [--slippage BPS]'); return 2; }
        const patch: Record<string, unknown> = {};
        if (flag(rest, '--size')) patch.sizeUsd = parseAmount(flag(rest, '--size')!);
        if (flag(rest, '--entry')) patch.entry = parseTrigger(flag(rest, '--entry')!);
        if (flags(rest, '--tp').length) patch.exits = flags(rest, '--tp').map(parseExit);
        if (flag(rest, '--stop')) patch.stop = flag(rest, '--stop') === 'none' ? null : parseTrigger(flag(rest, '--stop')!);
        if (flag(rest, '--slippage')) patch.slippageBps = Number(flag(rest, '--slippage'));
        if (!Object.keys(patch).length) { errOut('trenchscope plan amend: nothing to change (pass --size / --entry / --tp / --stop / --slippage)'); return 2; }
        const svc = openService(rest, io);
        const next = svc.engine.amend(planId, patch, { by: 'user' });
        if (has(rest, '--json')) { out(JSON.stringify({ id: next.id, hash: next.hash, supersedes: planId, readBack: svc.readBack(next.id) })); return 0; }
        out(`amended: ${planId} → ${next.id} (superseded; every earlier confirmation is void)`);
        out(`  ${svc.readBack(next.id)}`);
        out('  PROPOSAL only — not armed. Arm with: trenchscope plan arm ' + next.id + ' --mandate <id>  (physical keypress)');
        return 0;
      }
      case 'cancel': {
        const planId = rest[1];
        if (!planId) { errOut('usage: trenchscope plan cancel <planId>'); return 2; }
        const svc = openService(rest, io);
        const status = svc.cancelPlan(planId, 'user');
        out(`${planId}: ${status}`);
        return 0;
      }
      case 'journal': {
        const svc = openService(rest, io);
        if (has(rest, '--export')) { out(svc.exportJournal()); return 0; }
        const v = svc.verifyJournal();
        out(v.ok ? `audit log OK — ${v.count} events, hash chain verified` : `audit log BROKEN at seq ${v.atSeq}: ${v.why}`);
        return v.ok ? 0 : 1;
      }
      default:
        (cmd ? errOut(`unknown subcommand: ${cmd}`) : out(PLAN_USAGE));
        return cmd ? 2 : 0;
    }
  } catch (e) {
    errOut(`trenchscope plan: ${errMsg(e)}`);
    return 1;
  }
}

export async function runMandate(rest: string[], io: Io): Promise<number> {
  const cmd = rest[0];
  const out = (s: string) => io.stdout.write(s + '\n');
  const errOut = (s: string) => io.stderr.write(s + '\n');
  try {
    switch (cmd) {
      case 'draft': {
        const svc = openService(rest, io);
        const num = (n: string) => (flag(rest, n) !== undefined ? parseAmount(flag(rest, n)!) : undefined);
        const maxTier = flag(rest, '--max-tier') as TierName | undefined;
        const ttlHours = flag(rest, '--ttl-hours') ? Number(flag(rest, '--ttl-hours')) : undefined;
        const m = svc.draftMandate({
          totalUsd: num('--total'), perTradeUsd: num('--per-trade'), perCoinUsd: num('--per-coin'),
          dailyLossUsd: num('--daily-loss'), maxTier, ttlMs: ttlHours ? ttlHours * 3600_000 : undefined,
        });
        if (has(rest, '--json')) { out(JSON.stringify({ id: m.id, budget: m.budget, maxTier: m.maxTier })); return 0; }
        out(`drafted ${m.id}`);
        out(`  total ${fmtUsd(m.budget.totalUsd)} · per-trade ${fmtUsd(m.budget.perTradeUsd)} · per-coin ${fmtUsd(m.budget.perCoinUsd)} · daily-loss ${fmtUsd(m.budget.dailyLossUsd)} · maxTier ${m.maxTier}`);
        out('  DRAFT only — not armed. Arm with: trenchscope mandate arm ' + m.id + '  (physical keypress)');
        return 0;
      }
      case 'list': {
        const svc = openService(rest, io);
        const rows = svc.listMandates();
        if (has(rest, '--json')) { out(JSON.stringify(rows)); return 0; }
        if (!rows.length) { out('no mandates'); return 0; }
        for (const r of rows) out(`${r.id.padEnd(24)} ${r.status.padEnd(7)} total ${fmtUsd(r.totalUsd)} · reserved ${fmtUsd(r.reservedUsd)} · spent ${fmtUsd(r.spentUsd)} · maxTier ${r.maxTier}`);
        return 0;
      }
      case 'arm': {
        const id = rest[1];
        if (!id) { errOut('usage: trenchscope mandate arm <id>'); return 2; }
        const svc = openService(rest, io);
        const row = svc.listMandates().find((m) => m.id === id);
        if (!row) { errOut(`no such mandate ${id}`); return 1; }
        out(`Arm standing mandate ${id}? This lets armed plans fire at machine speed from the capped fast wallet.`);
        out(`  total ${fmtUsd(row.totalUsd)} · per-trade ${fmtUsd(row.perTradeUsd)} · per-coin ${fmtUsd(row.perCoinUsd)} · maxTier ${row.maxTier}`);
        out('Hold any key to confirm (physical keypress). A pipe or agent cannot arm. Waiting 15s…');
        const key = await ttyKeypress(io.stdin as never, 15_000);
        if (key === null) { errOut('refused: no physical keypress (stdin is not a TTY, or timed out). Voice/agents can never arm a mandate.'); return 1; }
        svc.armMandateByKeypress(id);
        out(`armed mandate ${id}`);
        return 0;
      }
      case 'revoke': {
        const id = rest[1];
        if (!id) { errOut('usage: trenchscope mandate revoke <id>'); return 2; }
        const svc = openService(rest, io);
        svc.revokeMandate(id, 'user');
        out(`revoked ${id}`);
        return 0;
      }
      default:
        (cmd ? errOut(`unknown subcommand: ${cmd}`) : out(MANDATE_USAGE));
        return cmd ? 2 : 0;
    }
  } catch (e) {
    errOut(`trenchscope mandate: ${errMsg(e)}`);
    return 1;
  }
}
