// `trenchscope pack <list|verify|add|remove|export|lock|sign|trust|signers|keymap|widget> …` (task-1358 Tier 4).
// A pack is a directory of plain files (workspaces, themes, rules, a keymap, popup widgets) with a sha256 lock
// and an optional `ssh-keygen -Y` signature. No network, no model, never a key file. Everything a pack can do to
// this machine is decided HERE, by the user, through the config journal (actor user):
//   list                               installed packs (trust, hash, what they contribute, widget consent)
//   verify <dir>                       the install card: integrity, signature, trust tier, contents, refusals (exit 1 on a problem)
//   add <dir> [--accept-unsigned]      install under ~/.dexterm/packs/<name>@<version>; unsigned needs the flag (the risk card)
//   remove <name>                      delete the pack directory + record + its widget registrations
//   export <dir> --name <n> [--publisher <p>] [--description <d>] [--workspace <w>]… [--theme <t>]… [--rules] [--keymap]
//                                      write a pack from YOUR files (+ pack.lock); secrets are refused
//   lock <dir>                         (re)write pack.lock
//   sign <dir> --key <ssh private key> sign pack.lock with ssh-keygen -Y (namespace dexterm-pack)
//   trust <identity> "<ssh pubkey>"    pin a publisher key in ~/.dexterm/allowed_signers
//   signers                            the pinned publisher keys
//   keymap <name> [--merge]            show a pack's keymap; --merge layers it over config.keymap (reserved keys refused; all or nothing)
//   widget <pack> <name> --enable|--disable
//                                      consent for a pack widget page (installed DISABLED; the popup host serves it only when enabled)
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DEFAULT_KEYMAP, type AppAction } from '@dexterm/tui';
import {
  dextermHome, loadConfig, applyAndJournal, listWorkspaces, listUserThemes, packsDir,
  inspectPack, installPack, removePack, exportPack, writeLock, signPack, pinSigner, listSigners, loadPacks, setWidgetEnabled, packWidgetKey, checkIntegrity,
  applyKeymapConfig, collisions, PackError,
  type DextermConfig, type PackInspection, type KeymapConfig, type RuleJson, type Workspace, type UserTheme, type PatchOp,
} from '@dexterm/custom';

export interface PackIo { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown }; env: NodeJS.ProcessEnv }

export const PACK_USAGE = `usage: trenchscope pack list | verify <dir> | add <dir> [--accept-unsigned] | remove <name>
       trenchscope pack export <dir> --name <n> [--publisher <p>] [--description <d>] [--workspace <w>]… [--theme <t>]… [--rules] [--keymap]
       trenchscope pack lock <dir> | sign <dir> --key <ssh-private-key> | trust <identity> "<ssh pubkey>" | signers
       trenchscope pack keymap <name> [--merge] | widget <pack> <widget> --enable|--disable
  a pack is plain files + pack.lock (sha256) + an optional ssh signature; it never runs code: widgets land DISABLED,
  rules from an unsigned pack load disabled, a pack keymap is merged only by "pack keymap <name> --merge"`;

/** Parse `--flag value` / `--flag` (boolean) / repeated flags; positionals in order. */
function parse(argv: string[], bools: readonly string[], multi: readonly string[] = []): { pos: string[]; flags: Record<string, string | string[] | true> } {
  const pos: string[] = []; const flags: Record<string, string | string[] | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const name = a.slice(2);
    if (bools.includes(name)) { flags[name] = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`--${name} needs a value`);
    if (multi.includes(name)) (flags[name] = ((flags[name] as string[] | undefined) ?? [])).push(v); else flags[name] = v;
  }
  return { pos, flags };
}

const trustWord = (t: string): string => (t === 'reviewed' ? 'REVIEWED (hash on the shipped list)' : t === 'signed' ? 'SIGNED by a pinned publisher key' : 'UNSIGNED / not reviewed');

/** The install card: what the pack is, what it contributes, what was refused, what the user is accepting. */
export function renderPackCard(insp: PackInspection): string {
  const m = insp.manifest;
  const lines: string[] = [];
  lines.push(`${m.name}@${m.version} · publisher ${m.publisher}${m.description ? ` · ${m.description}` : ''}`);
  lines.push(`  integrity  ${insp.integrity.ok ? `ok ${insp.integrity.hash}` : `✗ ${insp.integrity.reason}`}`);
  lines.push(`  signature  ${insp.signature.ok ? `ok (identity ${insp.signature.identity})` : insp.signature.reason}`);
  lines.push(`  trust      ${trustWord(insp.trust)}`);
  for (const w of insp.workspaces) lines.push(`  workspace  ${w.workspace ? `${m.name}/${w.workspace.name}${w.workspace.popups?.length ? ` (${w.workspace.popups.length} popups)` : ''}` : `✗ ${w.path}: ${w.error}`}`);
  for (const t of insp.themes) lines.push(`  theme      ${t.doc ? `${m.name}-${t.name} (extends ${t.doc.extends})` : `✗ ${t.path}: ${t.error}`}`);
  for (const f of insp.rules) { for (const r of f.rules) lines.push(`  rule       ${r.id}: when ${r.when} → ${r.then.map((a) => a.action).join(' ')}  (loads ${insp.trust === 'unsigned' ? 'DISABLED' : 'enabled'})`); for (const e of f.errors) lines.push(`  rule       ✗ ${f.path}:${e.line} ${e.msg}`); }
  if (insp.keymap) lines.push(`  keymap     ${insp.keymap.keymap ? `${insp.keymap.path} (NOT merged; trenchscope pack keymap ${m.name} to review)` : `✗ ${insp.keymap.error}`}`);
  for (const w of insp.widgets) lines.push(`  widget     ${w.manifest ? `${m.name}/${w.name}: ${w.manifest.widgets.map((x) => `${x.id} "${x.title}" topics ${x.topics.join(',')}`).join('; ')}  (installed DISABLED, no capabilities)` : `✗ ${w.name}: ${w.error}`}`);
  for (const w of insp.warnings) lines.push(`  ⚠ ${w}`);
  return lines.join('\n');
}

export async function packCommand(argv: string[], io: PackIo): Promise<number> {
  const home = dextermHome(io.env);
  const cmd = argv[0];
  const bad = (s: string): number => { io.stderr.write(`trenchscope pack: ${s}\n${PACK_USAGE}\n`); return 2; };
  const fail = (e: unknown): number => { io.stderr.write(`trenchscope pack: ${e instanceof PackError ? `${e.code}: ` : ''}${(e as Error).message}\n`); return 1; };
  const persist = (ops: PatchOp[], why: string): DextermConfig => applyAndJournal(home, ops, { actor: 'user', why }).config;
  let p: ReturnType<typeof parse>;
  try { p = parse(argv.slice(1), ['accept-unsigned', 'merge', 'enable', 'disable', 'rules', 'keymap'], ['workspace', 'theme']); } catch (e) { return bad((e as Error).message); }
  const [a, b] = p.pos;
  try {
    switch (cmd) {
      case undefined: case 'list': {
        const cfg = loadConfig(home);
        for (const e of cfg.errors) io.stderr.write(`trenchscope pack: config: ${e}\n`);
        const packs = cfg.config.packs ?? [];
        io.stdout.write(`${cfg.path} · ${packs.length} pack(s) installed\n`);
        if (!packs.length) return 0;
        const loaded = loadPacks(home, cfg.config);
        for (const r of packs) {
          const ws = loaded.workspaces.filter((w) => w.pack === r.name).map((w) => w.name);
          const th = loaded.themes.filter((t) => t.pack === r.name).map((t) => t.name);
          const ru = loaded.rules.filter((x) => x.source === `pack:${r.name}`);
          const wi = loaded.widgets.filter((w) => w.pack === r.name);
          io.stdout.write(`  ${r.name}@${r.version}  ${r.trust.padEnd(8)} ${r.hash.slice(0, 23)}…  publisher ${r.publisher ?? '?'}\n`);
          if (ws.length) io.stdout.write(`    workspaces ${ws.join(', ')}\n`);
          if (th.length) io.stdout.write(`    themes     ${th.join(', ')}\n`);
          if (ru.length) io.stdout.write(`    rules      ${ru.map((x) => `${x.id} (${x.enabled ? 'on' : 'off'})`).join(', ')}\n`);
          for (const w of wi) io.stdout.write(`    widget     ${w.pack}/${w.name}  ${w.enabled ? 'ENABLED' : 'disabled'}  ${w.manifest.widgets.map((x) => x.id).join(', ')}\n`);
          if (loaded.keymaps.some((k) => k.pack === r.name)) io.stdout.write(`    keymap     not merged (trenchscope pack keymap ${r.name} --merge)\n`);
        }
        for (const e of loaded.errors) io.stdout.write(`  ⚠ ${e}\n`);
        for (const n of loaded.notes) io.stdout.write(`  · ${n}\n`);
        return 0;
      }
      case 'verify': {
        if (!a) return bad('verify needs a pack directory');
        const insp = inspectPack(resolve(a), { home });
        io.stdout.write(renderPackCard(insp) + '\n');
        const refused = insp.warnings.filter((w) => / refused: /.test(w));
        if (!insp.integrity.ok || refused.length) { io.stdout.write(`✗ ${!insp.integrity.ok ? 'integrity failed' : `${refused.length} item(s) refused`}; this pack would not install\n`); return 1; }
        io.stdout.write(`ok: installs as ${trustWord(insp.trust)}${insp.trust === 'unsigned' ? ' (needs --accept-unsigned)' : ''}\n`);
        return 0;
      }
      case 'add': {
        if (!a) return bad('add needs a pack directory');
        const dir = resolve(a);
        const cfg = loadConfig(home);
        if (!cfg.ok) return fail(new Error(cfg.errors[0]));
        const insp = inspectPack(dir, { home });
        io.stdout.write(renderPackCard(insp) + '\n');
        // integrity first: a pack whose files do not match its lock is refused whatever its signature or the flag says
        if (!insp.integrity.ok) return fail(new PackError(`integrity: ${insp.integrity.reason}${'changed' in insp.integrity && insp.integrity.changed?.length ? ` (${insp.integrity.changed.join(', ')})` : ''}`, 'integrity'));
        if (insp.trust === 'unsigned' && !p.flags['accept-unsigned']) {
          io.stderr.write(`trenchscope pack: ${insp.manifest.name} is not reviewed or signed — do you trust its source? re-run with --accept-unsigned to install it anyway\n  (its rules will load DISABLED, its widgets stay disabled, its keymap is not merged)\n`);
          return 1;
        }
        const r = installPack(home, dir, cfg.config, { acceptUnsigned: !!p.flags['accept-unsigned'] });
        persist([{ op: 'replace', path: '/packs', value: r.config.packs ?? [] }, { op: 'replace', path: '/plugins', value: r.config.plugins ?? {} }], `trenchscope pack add ${r.manifest.name}@${r.manifest.version} (${r.trust})`);
        io.stdout.write(`installed ${r.manifest.name}@${r.manifest.version} → ${r.dest} (${r.trust})\n`);
        if (r.replaced) io.stdout.write(`  upgraded: removed ${r.replaced}; widget consent starts over (the pages may have changed)\n`);
        for (const w of r.inspection.widgets) if (w.manifest) io.stdout.write(`  widget ${r.manifest.name}/${w.name} is DISABLED: read ${w.pages.join(', ')} then "trenchscope pack widget ${r.manifest.name} ${w.name} --enable"\n`);
        if (r.inspection.keymap?.keymap) io.stdout.write(`  keymap not merged: "trenchscope pack keymap ${r.manifest.name}" shows it, --merge applies it\n`);
        return 0;
      }
      case 'remove': {
        if (!a) return bad('remove needs a pack name');
        const cfg = loadConfig(home);
        if (!cfg.ok) return fail(new Error(cfg.errors[0]));
        if (!(cfg.config.packs ?? []).some((x) => x.name === a)) { io.stderr.write(`trenchscope pack: no installed pack "${a}"\n`); return 1; }
        const r = removePack(home, cfg.config, a);
        persist([{ op: 'replace', path: '/packs', value: r.config.packs ?? [] }, { op: 'replace', path: '/plugins', value: r.config.plugins ?? {} }], `trenchscope pack remove ${a}`);
        io.stdout.write(`removed ${a}${r.removed ? ` (${r.removed})` : ''}\n`);
        return 0;
      }
      case 'export': {
        if (!a) return bad('export needs an output directory');
        const name = p.flags.name as string | undefined;
        if (!name) return bad('export needs --name <pack-name>');
        const cfg = loadConfig(home);
        const workspaces: Workspace[] = [];
        for (const w of (p.flags.workspace as string[] | undefined) ?? []) {
          const f = listWorkspaces(home).find((x) => x.name === w && !x.error);
          if (!f) return fail(new Error(`no workspace "${w}" (trenchscope workspace list)`));
          if (f.pack) return fail(new Error(`workspace "${w}" belongs to pack ${f.pack}; export your own files`));
          workspaces.push(f.workspace);
        }
        const themes: Array<UserTheme & { name: string }> = [];
        for (const t of (p.flags.theme as string[] | undefined) ?? []) {
          const f = listUserThemes(home, cfg.config).find((x) => x.name === t && !x.error);
          if (!f) return fail(new Error(`no user theme "${t}" (trenchscope theme list)`));
          themes.push(f.doc);
        }
        const rules: RuleJson[] = p.flags.rules ? (cfg.config.rules ?? []).filter((r) => !r.source || r.source === 'user') : [];
        const keymap: KeymapConfig | undefined = p.flags.keymap ? cfg.config.keymap : undefined;
        const lock = exportPack(resolve(a), { name, version: p.flags.version as string | undefined, publisher: (p.flags.publisher as string | undefined) ?? io.env.USER ?? 'me', description: p.flags.description as string | undefined, workspaces, themes, rules, keymap });
        io.stdout.write(`wrote ${resolve(a)} · ${lock.files.length} file(s) · ${lock.hash}\n  share the directory; sign it with "trenchscope pack sign ${a} --key ~/.ssh/id_ed25519" so others can pin your key\n`);
        return 0;
      }
      case 'lock': {
        if (!a) return bad('lock needs a pack directory');
        const lock = writeLock(resolve(a));
        io.stdout.write(`${lock.hash} · ${lock.files.length} file(s)\n`);
        return 0;
      }
      case 'sign': {
        if (!a) return bad('sign needs a pack directory');
        const key = p.flags.key as string | undefined;
        if (!key) return bad('sign needs --key <ssh private key file> (e.g. ~/.ssh/id_ed25519)');
        if (!existsSync(key)) return fail(new Error(`${key}: no such key file`));
        const sig = signPack(resolve(a), { keyFile: key });
        io.stdout.write(`signed → ${sig}\n  publish your PUBLIC key (${key}.pub) so users can run: trenchscope pack trust <your-identity> "$(cat ${key}.pub)"\n`);
        return 0;
      }
      case 'trust': {
        if (!a || !b) return bad('trust needs <identity> "<ssh pubkey line>"');
        const path = pinSigner(home, a, b);
        io.stdout.write(`pinned ${a} in ${path}\n`);
        return 0;
      }
      case 'signers': {
        const s = listSigners(home);
        io.stdout.write(s.length ? s.map((x) => `  ${x.identity.padEnd(32)} ${x.key}`).join('\n') + '\n' : 'no pinned publisher keys (trenchscope pack trust <identity> "<pubkey>")\n');
        return 0;
      }
      case 'keymap': {
        if (!a) return bad('keymap needs a pack name');
        const cfg = loadConfig(home);
        if (!cfg.ok) return fail(new Error(cfg.errors[0]));
        const k = loadPacks(home, cfg.config).keymaps.find((x) => x.pack === a);
        if (!k) { io.stderr.write(`trenchscope pack: no installed pack "${a}" with a keymap\n`); return 1; }
        const entries: Array<[string | null, string, string[]]> = [];
        for (const [action, keys] of Object.entries(k.keymap.global ?? {})) entries.push([null, action, keys]);
        for (const [screen, t] of Object.entries(k.keymap.screens ?? {})) for (const [action, keys] of Object.entries(t)) entries.push([screen, action, keys]);
        const own = cfg.config.keymap ?? {};
        const conflicts = entries.filter(([s, action]) => (s ? own.screens?.[s]?.[action] : own.global?.[action]) !== undefined);
        io.stdout.write(`${a} keymap (${entries.length} binding(s); ${p.flags.merge ? 'merging' : 'NOT merged'}):\n`);
        for (const [s, action, keys] of entries) io.stdout.write(`  ${(s ?? 'global').padEnd(10)} ${action.padEnd(22)} ${keys.join(' / ')}${conflicts.some(([cs, ca]) => cs === s && ca === action) ? '   (replaces your override)' : ''}\n`);
        // validate the MERGED result (defaults + yours + the pack's): reserved keys/actions and collisions refuse the whole merge
        const merged: KeymapConfig = { global: { ...(own.global ?? {}), ...(k.keymap.global ?? {}) }, screens: { ...(own.screens ?? {}) } };
        for (const [screen, t] of Object.entries(k.keymap.screens ?? {})) merged.screens![screen] = { ...(merged.screens![screen] ?? {}), ...t };
        const res = applyKeymapConfig<AppAction>(DEFAULT_KEYMAP.bindings, merged);
        const errs = res.errors.length ? res.errors : collisions(res.bindings);
        if (errs.length) { for (const e of errs) io.stdout.write(`  ✗ ${e.path} ${e.msg}\n`); io.stdout.write(`refused: this keymap cannot be merged (${errs.length} problem(s)); your keys are unchanged\n`); return 1; }
        if (!p.flags.merge) { io.stdout.write(`ok: would merge cleanly · trenchscope pack keymap ${a} --merge\n`); return 0; }
        persist([{ op: 'replace', path: '/keymap', value: merged }], `trenchscope pack keymap ${a} --merge`);
        io.stdout.write(`merged ${entries.length} binding(s) into config.keymap (ctrl+z in the app or the journal undoes it)\n`);
        return 0;
      }
      case 'widget': {
        if (!a || !b) return bad('widget needs <pack> <widget> --enable|--disable');
        const on = p.flags.enable ? true : p.flags.disable ? false : null;
        if (on === null) return bad('widget needs --enable or --disable');
        const cfg = loadConfig(home);
        if (!cfg.ok) return fail(new Error(cfg.errors[0]));
        const key = packWidgetKey(a, b);
        if (on) {
          // consent is informed: the pack must still hash to its record, and the page is named so the user has read it
          const rec = (cfg.config.packs ?? []).find((x) => x.name === a);
          if (!rec) return fail(new Error(`no installed pack "${a}" (trenchscope pack list)`));
          const integ = checkIntegrity(join(packsDir(home), `${rec.name}@${rec.version}`));
          if (!integ.ok || integ.hash !== rec.hash) return fail(new Error(`pack ${a} changed since install (${integ.ok ? 'hash differs' : integ.reason}); re-install before enabling a widget`));
          const w = loadPacks(home, cfg.config).widgets.find((x) => x.pack === a && x.name === b);
          if (!w) return fail(new Error(`no installed widget ${key} (trenchscope pack list)`));
          io.stdout.write(`enabling ${key}: the popup host will serve ${w.manifest.widgets.map((x) => `${w.dir}/${x.page}`).join(', ')} in a loopback window (hash-only CSP: only the inline script/style you just read runs — no remote script, style, frame or import, no fetch, no eval; topics ${[...new Set(w.manifest.widgets.flatMap((x) => x.topics))].join(', ')})\n`);
        }
        const next = setWidgetEnabled(cfg.config, a, b, on);
        persist([{ op: 'replace', path: '/plugins', value: next.plugins ?? {} }], `trenchscope pack widget ${a} ${b} ${on ? '--enable' : '--disable'}`);
        io.stdout.write(`${key} ${on ? 'ENABLED (open it from a workspace popup {"kind":"widget","widget":"' + key + '"} or ctrl+w o)' : 'disabled'}\n`);
        return 0;
      }
      default: return bad(`unknown subcommand "${cmd}"`);
    }
  } catch (e) { return fail(e); }
}

/** For tests + the install card: the text of a pack page, size-capped (the popup host applies its own cap too). */
export function readPackPage(path: string, max = 512_000): string { const t = readFileSync(path, 'utf8'); return t.length > max ? t.slice(0, max) : t; }
