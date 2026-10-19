// `trenchscope kb …` / `trenchscope skill …` (task-1377): the user's overlay of the knowledge base and the analyst
// skills, under ~/.dexterm/kb/entries/<id>.md and ~/.dexterm/skills/<name>.md (DEXTERM_HOME overrides).
// A user file with a bundled id overrides it, a new id is added, bundled files are never edited in place.
//   list              bundled + user entries with their origin; skipped files with the reason
//   show <id>         print the file in effect (origin and path on stderr)
//   new <id>          write a starter file (refuses a bundled id: use edit), open $EDITOR, check it
//   edit <id>         copy the bundled file into the overlay if needed, open $EDITOR, check it
//   check [id|file]   validate (frontmatter, size, KB live-token rule, skill read-tools only); exit 1 on an error
//   reset <id>        move the user file to <dir>/.reset/ (the bundled entry is back in effect)
//   path [id]         the overlay directory, or the file in effect for <id>
// The MCP server, the analyst and Jarvis re-read the merged set on the next call: no restart. No network, no model.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  OverlayStore, checkKb, checkSkill, dextermHome, userDir, writeOverlayFile, resetOverlayFile, templateFor, journalContent,
  READ_ONLY_TOOLS, BUNDLED_KB_DIR, BUNDLED_SKILLS_DIR, KB_ID, SKILL_NAME, KB_RULE,
  type BundledSource, type CheckResult, type ContentKind, type MergedSet,
} from '@dexterm/mcp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The analyst plugin's skills (the copies `/dexterm:<skill>` runs) come first; the MCP server's own copies fill any gap. */
export const SKILL_SOURCES: readonly BundledSource[] = [
  { dir: path.resolve(HERE, '..', 'assets', 'claude', 'plugin', 'skills'), layout: 'nested' },
  { dir: BUNDLED_SKILLS_DIR, layout: 'flat' },
];
export const KB_SOURCES: readonly BundledSource[] = [{ dir: BUNDLED_KB_DIR, layout: 'flat' }];

const stores = new Map<string, OverlayStore>();
function storeFor(kind: ContentKind, env: NodeJS.ProcessEnv): OverlayStore {
  const home = dextermHome(env);
  const key = `${kind}\n${home}`;
  let s = stores.get(key);
  if (!s) {
    s = new OverlayStore({ kind, bundled: kind === 'kb' ? KB_SOURCES : SKILL_SOURCES, readTools: READ_ONLY_TOOLS, home: () => home });
    stores.set(key, s);
  }
  return s;
}
/** The hot-reloading merged KB for a DEXTERM_HOME (doctor, the CLI). */
export const kbStore = (env: NodeJS.ProcessEnv = process.env): OverlayStore => storeFor('kb', env);
/** The hot-reloading merged skills for a DEXTERM_HOME (the analyst's per-turn plugin dir, doctor, the CLI). */
export const skillStore = (env: NodeJS.ProcessEnv = process.env): OverlayStore => storeFor('skill', env);

export interface KbSkillIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
  /** Whether an interactive editor may be opened (default: stdout is a TTY). */
  isTTY?: boolean;
  /** Open the editor on a file and wait; returns its exit code. Tests inject this; default spawns $VISUAL/$EDITOR. */
  editor?: (file: string) => number;
  /** Platform for the default editor spawn (default: process.platform). Tests inject it. */
  platform?: NodeJS.Platform;
}

const NOUN = { kb: 'KB entry', skill: 'skill' } as const;

export function usage(kind: ContentKind): string {
  return kind === 'kb'
    ? `usage: trenchscope kb list | show <id> | new <id> | edit <id> | check [<id>|<file>] | reset <id> | path [<id>]
  files: ~/.dexterm/kb/entries/<id>.md (DEXTERM_HOME overrides): same id as a bundled entry overrides it, a new id adds one.
  The MCP server, the analyst and Jarvis read the merged set on their next call (no restart). ${KB_RULE}`
    : `usage: trenchscope skill list | show <name> | new <name> | edit <name> | check [<name>|<file>] | reset <name> | path [<name>]
  files: ~/.dexterm/skills/<name>.md (DEXTERM_HOME overrides): same name as a bundled skill overrides it, a new name adds one.
  A skill is read-only guidance: \`tools:\` may name only read tools and nothing may name a trade/sign/arm/ticket tool.`;
}

function check(kind: ContentKind, raw: string, stem: string, file: string): CheckResult {
  return kind === 'kb' ? checkKb(raw, stem, 'user', file) : checkSkill(raw, stem, READ_ONLY_TOOLS, 'user', file);
}

/** Print one check result; returns true when the file passes. The KB rule line is printed once by the caller. */
function report(io: KbSkillIo, file: string, res: CheckResult): boolean {
  const ok = res.errors.length === 0;
  io.stdout.write(`${ok ? '✓' : '✗'} ${file}\n`);
  for (const e of res.errors) io.stdout.write(`    error: ${e}\n`);
  for (const w of res.warnings) if (!w.startsWith('rule: ')) io.stdout.write(`    warn:  ${w}\n`);
  return ok;
}

function openEditor(io: KbSkillIo, file: string): 'edited' | 'no-editor' | 'failed' {
  if (io.editor) return io.editor(file) === 0 ? 'edited' : 'failed';
  const ed = (io.env.VISUAL || io.env.EDITOR || '').trim();
  if (!ed || io.isTTY === false) return 'no-editor';
  // task-1423: Windows has no /bin/sh, so the spawn below always failed there; print the path to edit instead
  if ((io.platform ?? process.platform) === 'win32') return 'no-editor';
  // `sh -c '$EDITOR "$1"'` so an EDITOR with arguments ("code -w") works; the path is passed as $1, never interpolated.
  const r = spawnSync('/bin/sh', ['-c', `${ed} "$1"`, 'sh', file], { stdio: 'inherit', env: io.env });
  return r.status === 0 ? 'edited' : 'failed';
}

function readOr(file: string): string { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }

/** After new/edit: open the editor, journal the change, check the file, say what the loader will do. */
function editAndCheck(kind: ContentKind, io: KbSkillIo, home: string, id: string, file: string, before: string, action: 'new' | 'edit'): number {
  const ed = openEditor(io, file);
  if (ed === 'no-editor') io.stdout.write(`no $EDITOR (or not a terminal): edit ${file} with any editor; \`trenchscope ${kind} check ${id}\` validates it\n`);
  if (ed === 'failed') io.stderr.write(`trenchscope ${kind}: the editor exited with an error; the file is kept as it is\n`);
  const after = readOr(file);
  if (after !== before) journalContent(home, { kind, action, id, before, after });
  const res = check(kind, after, id, file);
  const ok = report(io, file, res);
  if (kind === 'kb') io.stdout.write(`  rule: ${KB_RULE}\n`);
  if (!ok) { io.stdout.write(`  the loader skips this file until it passes (the bundled ${NOUN[kind]} stays in effect); fix it, or \`trenchscope ${kind} reset ${id}\`\n`); return 1; }
  io.stdout.write(`  in effect on the next MCP/analyst/Jarvis call (no restart)\n`);
  return 0;
}

function listMerged(kind: ContentKind, io: KbSkillIo, m: MergedSet): void {
  io.stdout.write(`${m.dir}  (${m.bundled} bundled · ${m.user} user: ${m.overridden} override${m.overridden === 1 ? '' : 's'}, ${m.added} new · ${m.skipped.length} skipped)\n`);
  for (const e of m.entries) {
    const tag = e.origin === 'bundled' ? 'bundled' : e.overrides ? 'user (overrides bundled)' : 'user (new)';
    const what = String((kind === 'kb' ? e.meta.title : e.meta.description) ?? '').slice(0, 90);
    io.stdout.write(`  ${e.id.padEnd(32)} ${tag.padEnd(25)} ${what}\n`);
  }
  for (const s of m.skipped) io.stdout.write(`! ${s.id.padEnd(32)} skipped: ${s.reason}\n`);
}

export async function kbSkillCommand(kind: ContentKind, argv: string[], io: KbSkillIo): Promise<number> {
  const home = dextermHome(io.env);
  const store = storeFor(kind, io.env);
  const dir = userDir(kind, home);
  const [cmd, arg] = argv;
  const bad = (s: string): number => { io.stderr.write(`trenchscope ${kind}: ${s}\n${usage(kind)}\n`); return 2; };
  const idOk = (id: string | undefined): id is string => !!id && (kind === 'kb' ? KB_ID : SKILL_NAME).test(id);
  const userFile = (id: string): string => path.join(dir, `${id}.md`);
  const bundledOf = (id: string) => store.bundled().find((e) => e.id === id) ?? null;

  switch (cmd) {
    case undefined: case 'list': {
      listMerged(kind, io, store.get());
      return 0;
    }
    case 'show': {
      if (!arg) return bad('show needs an id');
      const e = store.get().entries.find((x) => x.id === arg);
      if (!e) { io.stderr.write(`trenchscope ${kind}: no ${NOUN[kind]} "${arg}" (see: trenchscope ${kind} list)\n`); return 1; }
      io.stderr.write(`# ${e.origin}${e.overrides ? ' (overrides bundled)' : ''} · ${e.file}\n`);
      io.stdout.write(readOr(e.file));
      return 0;
    }
    case 'path': {
      if (!arg) { io.stdout.write(`${dir}\n`); return 0; }
      const e = store.get().entries.find((x) => x.id === arg);
      if (!e) { io.stderr.write(`trenchscope ${kind}: no ${NOUN[kind]} "${arg}"\n`); return 1; }
      io.stdout.write(`${e.file}\n`);
      return 0;
    }
    case 'new': {
      if (!idOk(arg)) return bad(`new needs a ${kind === 'kb' ? 'KB id' : 'skill name'} (lowercase letters, digits, dashes)`);
      if (bundledOf(arg)) { io.stderr.write(`trenchscope ${kind}: "${arg}" is bundled; \`trenchscope ${kind} edit ${arg}\` makes an editable copy that overrides it\n`); return 1; }
      if (fs.existsSync(userFile(arg))) { io.stderr.write(`trenchscope ${kind}: ${userFile(arg)} already exists; \`trenchscope ${kind} edit ${arg}\`\n`); return 1; }
      const file = writeOverlayFile(kind, home, arg, templateFor(kind, arg));
      io.stdout.write(`wrote ${file}\n`);
      return editAndCheck(kind, io, home, arg, file, '', 'new');
    }
    case 'edit': {
      if (!idOk(arg)) return bad('edit needs an id');
      let file = userFile(arg);
      let before = readOr(file);
      if (!fs.existsSync(file)) {
        const b = bundledOf(arg);
        if (!b) { io.stderr.write(`trenchscope ${kind}: no ${NOUN[kind]} "${arg}" to edit; \`trenchscope ${kind} new ${arg}\` starts one\n`); return 1; }
        // A copy of the bundled file, byte for byte; the bundled asset itself is never touched.
        file = writeOverlayFile(kind, home, arg, readOr(b.file));
        before = '';
        io.stdout.write(`copied the bundled ${NOUN[kind]} to ${file} (it now overrides the bundled one; \`trenchscope ${kind} reset ${arg}\` undoes it)\n`);
      }
      return editAndCheck(kind, io, home, arg, file, before, 'edit');
    }
    case 'check': {
      let targets: Array<{ file: string; stem: string }>;
      if (arg && (arg.includes('/') || arg.endsWith('.md'))) targets = [{ file: path.resolve(arg), stem: path.basename(arg) === 'SKILL.md' ? path.basename(path.dirname(path.resolve(arg))) : path.basename(arg, '.md') }];
      else if (arg) {
        const f = fs.existsSync(userFile(arg)) ? userFile(arg) : bundledOf(arg)?.file;
        if (!f) { io.stderr.write(`trenchscope ${kind}: no ${NOUN[kind]} "${arg}"\n`); return 1; }
        targets = [{ file: f, stem: arg }];
      } else {
        let names: string[] = [];
        try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('.')).sort(); } catch { /* no overlay yet */ }
        targets = names.map((n) => ({ file: path.join(dir, n), stem: n.slice(0, -3) }));
        if (!targets.length) { io.stdout.write(`no user ${kind === 'kb' ? 'KB entries' : 'skills'} in ${dir} (the ${store.bundled().length} bundled are in use)\n`); return 0; }
      }
      let failed = 0;
      for (const t of targets) {
        let st: fs.Stats | null = null;
        try { st = fs.lstatSync(t.file); } catch { /* missing */ }
        if (!st || !st.isFile()) { io.stdout.write(`✗ ${t.file}\n    error: ${st?.isSymbolicLink() ? 'a symlink: overlay files must be regular files' : 'not a regular file'}\n`); failed++; continue; }
        if (!report(io, t.file, check(kind, readOr(t.file), t.stem, t.file))) failed++;
      }
      if (kind === 'kb') io.stdout.write(`rule: ${KB_RULE}\n`);
      io.stdout.write(failed ? `${failed} of ${targets.length} refused (the loader skips them; bundled entries stay in effect)\n` : `${targets.length} ok\n`);
      return failed ? 1 : 0;
    }
    case 'reset': {
      if (!idOk(arg)) return bad('reset needs an id');
      const bak = resetOverlayFile(kind, home, arg);
      if (!bak) { io.stdout.write(`no user ${NOUN[kind]} "${arg}" in ${dir}; nothing to reset\n`); return 0; }
      io.stdout.write(`moved your ${NOUN[kind]} to ${bak}\n  ${bundledOf(arg) ? `the bundled "${arg}" is back in effect` : `"${arg}" is no longer offered`} on the next call\n`);
      return 0;
    }
    default: return bad(`unknown subcommand "${cmd}"`);
  }
}
