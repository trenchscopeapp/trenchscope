// `trenchscope rules <list|add|remove|enable|disable|check|dry-run|fields> …` (task-1358 Tier 3). No network, no
// model, never touches a key file. Rules live in ~/.dexterm/config.json `rules[]`; every change goes through the
// config journal (actor user) so `config.journal.jsonl` records it with its inverse.
//   rules list                      every rule with enabled / when / then / source (+ the ones that fail to load)
//   rules add "<rule text>"         parse (never eval), validate against the schema, append; refuses money-shaped args
//   rules remove|enable|disable <id>
//   rules check "<rule text>"       parse + show the JSON the config would store; exit 1 on a refusal
//   rules dry-run "<rule text>"     "would match N rows" against the demo fixture rows (flat history: velocity = 1)
//   rules fields                    the field / signal / tag / action vocabulary
import { dextermHome, loadConfig, applyAndJournal, RulesEngine, ruleToJson, ruleToText, describeActions, FIELD_NAMES, TAG_NAMES, ACTIONS, SCOPES, RULE_POPUP_KINDS, MAX_PER_HOUR_CAP, TICKET_SIZE_CAP, slug, type RuleJson } from '@dexterm/custom';

export interface RulesIo { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown }; env: NodeJS.ProcessEnv }

export const RULES_USAGE = `usage: trenchscope rules list | add "<rule>" | remove <id> | enable <id> | disable <id> | check "<rule>" | dry-run "<rule>" | fields
  rule: [when] <cond> [for <n> ticks|<n>s|<n>m] then <action>+ [cooldown <dur>] [max <n>/h] [scope screener|watchlist|newpairs|positions|mint:<addr>] [window <dur>] [name "<s>"]
  e.g.: trenchscope rules add 'vol5m.velocity > 3 and cluster < 20 and liq > 25K for 2 ticks then alert(up, "surge") popup(chart) name "surge"'
  actions only alert, annotate, open UI or PROPOSE (ticket/ask cards need your keypress; the paper ticket editor is where you confirm)`;

export async function rulesCommand(argv: string[], io: RulesIo): Promise<number> {
  const home = dextermHome(io.env);
  const [cmd, arg] = argv;
  const bad = (s: string): number => { io.stderr.write(`trenchscope rules: ${s}\n${RULES_USAGE}\n`); return 2; };
  const cfg = loadConfig(home);
  for (const e of cfg.errors) io.stderr.write(`trenchscope rules: config: ${e}\n`);
  const rules: RuleJson[] = cfg.config.rules ?? [];
  switch (cmd) {
    case undefined: case 'list': {
      io.stdout.write(`${cfg.path}${cfg.missing ? ' (no config: no rules)' : ''} · ${rules.length} rule(s)\n`);
      const e = new RulesEngine({ rules });
      for (const r of e.rules) io.stdout.write(`  ${(r.enabled ? 'on ' : 'off')} ${r.id.padEnd(24)} when ${r.whenText}${r.for ? ` for ${'ticks' in r.for ? r.for.ticks + ' ticks' : Math.round(r.for.ms / 1000) + 's'}` : ''} → ${describeActions(r)} · ${r.source} · cooldown ${Math.round(r.cooldownMs / 60000)}m · max ${r.maxPerHour}/h · scope ${r.scope}\n`);
      for (const x of e.errors) io.stdout.write(`  ⚠   ${x.id.padEnd(24)} ${x.msg}\n`);
      return 0;
    }
    case 'add': {
      if (!arg) return bad('add needs the rule text in quotes');
      let json: RuleJson;
      try { json = ruleToJson(arg); } catch (e) { io.stderr.write(`trenchscope rules: refused: ${(e as Error).message}\n`); return 1; }
      const taken = new Set(rules.map((r) => r.id));
      let id = json.id; let n = 2;
      while (taken.has(id)) id = slug(`${json.id}-${n++}`);
      json.id = id;
      try { applyAndJournal(home, [{ op: 'add', path: '/rules/-', value: json }], { actor: 'user', why: `trenchscope rules add ${id}` }); }
      catch (e) { io.stderr.write(`trenchscope rules: not saved: ${(e as Error).message}\n`); return 1; }
      io.stdout.write(`added rule ${id}: ${ruleToText(json)}\n`);
      return 0;
    }
    case 'remove': case 'enable': case 'disable': {
      if (!arg) return bad(`${cmd} needs a rule id`);
      const i = rules.findIndex((r) => r.id === arg);
      if (i < 0) { io.stderr.write(`trenchscope rules: no rule "${arg}"\n`); return 1; }
      const ops = cmd === 'remove' ? [{ op: 'remove' as const, path: `/rules/${i}` }] : [{ op: 'replace' as const, path: `/rules/${i}/enabled`, value: cmd === 'enable' }];
      try { applyAndJournal(home, ops, { actor: 'user', why: `trenchscope rules ${cmd} ${arg}` }); }
      catch (e) { io.stderr.write(`trenchscope rules: not changed: ${(e as Error).message}\n`); return 1; }
      io.stdout.write(`${cmd === 'remove' ? 'removed' : cmd + 'd'} rule ${arg}\n`);
      return 0;
    }
    case 'check': {
      if (!arg) return bad('check needs the rule text in quotes');
      try {
        const json = ruleToJson(arg);
        const e = new RulesEngine(); e.load(json);
        io.stdout.write(`ok: ${ruleToText(json)}\n${JSON.stringify(json, null, 2)}\n`);
        return 0;
      } catch (e) { io.stdout.write(`✗ ${(e as Error).message}\n`); return 1; }
    }
    case 'dry-run': {
      if (!arg) return bad('dry-run needs the rule text in quotes');
      const { makeFixtureState } = await import('./state.ts');
      const st = makeFixtureState();
      const rows = st.screener.rows.filter((r) => !r.skeleton);
      const e = new RulesEngine();
      const t0 = Date.now() - 30_000;
      for (let i = 0; i < 3; i++) e.observe(rows, t0 + i * 10_000); // flat history so velocity/delta are defined (1 / 0)
      const d = e.dryRun(arg, rows, t0 + 30_000);
      if (d.error) { io.stdout.write(`✗ ${d.error}\n`); return 1; }
      io.stdout.write(`would match ${d.matches.length} of ${d.considered} demo rows right now (fixture data, flat history) → ${describeActions(d.rule!)}\n`);
      for (const m of d.matches) io.stdout.write(`  ${m.symbol.padEnd(8)} ${m.reasons.map((r) => `${r.clause} (${r.value})`).join(', ')}\n`);
      if (d.noHistory) io.stdout.write(`  (${d.noHistory} rows had no history for a derived signal)\n`);
      return 0;
    }
    case 'fields': {
      io.stdout.write(`fields:  ${FIELD_NAMES.join(' ')}\n`);
      io.stdout.write(`aliases: vol volume liquidity cap mc holder organic top locked cluster% clusterpct\n`);
      io.stdout.write(`signals: <field>.velocity (current ÷ mean of earlier samples in the window) · <field>.delta (current − oldest in the window)\n`);
      io.stdout.write(`tags:    ${TAG_NAMES.map((t) => t + ':').join(' ')}  (e.g. launchpad:pump flag:mint flag:clean verified:yes sus:no; prefix ! to negate)\n`);
      io.stdout.write(`values:  $1.5M 25K 2B 20% 2h 30m 3d · ops > >= < <= = != · and or not ( )\n`);
      io.stdout.write(`actions: ${ACTIONS.join(' ')}  alert(level, "text") ticket(buy|sell, size ≤ ${TICKET_SIZE_CAP}, sol|usd|pct) ask(skill) popup(${RULE_POPUP_KINDS.join('|')}) tag("label") sound(name) watch\n`);
      io.stdout.write(`limits:  cooldown (default 10m) · max n/h (default 12, cap ${MAX_PER_HOUR_CAP}) · scope ${SCOPES.join('|')}|mint:<addr> · window (default 10m)\n`);
      return 0;
    }
    default: return bad(`unknown subcommand "${cmd}"`);
  }
}
