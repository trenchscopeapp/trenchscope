// `trenchscope theme <list|show|init|check> …` and `trenchscope keymap [screen]` (task-1358 Tier 2). No network, no
// model, never touches a key file.
//   theme list              built-ins + ~/.dexterm/themes/*.json + config.theme.user, with errors for bad ones
//   theme show <name>       the resolved tokens (user theme merged over its base, overrides applied)
//   theme init <name> [--extends cyberspace|midnight|ember|paper]   write a starter theme file to edit
//   theme check <file>      validate a theme file (schema, contrast floor, up/down hue) without installing it
//   keymap [screen]         the effective bindings (defaults + config.keymap), user overrides marked with ·
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { THEMES, THEME_NAMES, DEFAULT_KEYMAP, type AppAction } from '@dexterm/tui';
import { dextermHome, loadConfig, listUserThemes, resolveTheme, applyOverrides, starterTheme, themesDir, validate, applyKeymapConfig, renderKeymap, BASE_THEMES, type ThemeDoc, type UserTheme } from '@dexterm/custom';

export interface ThemeIo { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown }; env: NodeJS.ProcessEnv }

export const THEME_USAGE = `usage: trenchscope theme list | show <name> | init <name> [--extends ${BASE_THEMES.join('|')}] | check <file>
  files: ~/.dexterm/themes/<name>.json = { "extends": "<built-in>", "tokens": { "<token>": "#rrggbb", "<ramp>": [4 × "#rrggbb"] } }
  guard: text/warn/up/down must keep a contrast floor against bg/panel; up stays green/cyan, down stays red/pink`;

const bases = THEMES as unknown as Record<string, ThemeDoc>;

export async function themeCommand(argv: string[], io: ThemeIo): Promise<number> {
  const home = dextermHome(io.env);
  const [cmd, name] = argv;
  const bad = (s: string): number => { io.stderr.write(`trenchscope theme: ${s}\n${THEME_USAGE}\n`); return 2; };
  const cfg = loadConfig(home);
  switch (cmd) {
    case undefined: case 'list': {
      io.stdout.write(`${themesDir(home)}\n`);
      for (const n of THEME_NAMES) io.stdout.write(`  ${n.padEnd(24)} built-in\n`);
      for (const t of listUserThemes(home, cfg.config)) {
        if (t.error) { io.stdout.write(`  ${t.name.padEnd(24)} ⚠ ${t.error}\n`); continue; }
        const r = resolveTheme(t.doc, bases);
        io.stdout.write(`  ${t.name.padEnd(24)} ${t.path ? 'file' : 'config'} · extends ${t.doc.extends} · ${Object.keys(t.doc.tokens ?? {}).length} token(s)${r.theme ? '' : ` · ⚠ ${r.errors[0].path} ${r.errors[0].msg}`}\n`);
      }
      const ov = cfg.config.theme?.overrides ?? {};
      if (Object.keys(ov).length) io.stdout.write(`  overrides (config.theme.overrides): ${Object.keys(ov).join(', ')}\n`);
      return 0;
    }
    case 'show': {
      if (!name) return bad('show needs a name');
      let doc: ThemeDoc | null = bases[name] ?? null;
      if (!doc) {
        const t = listUserThemes(home, cfg.config).find((x) => x.name === name);
        if (!t) { io.stderr.write(`trenchscope theme: no theme "${name}"\n`); return 1; }
        if (t.error) { io.stderr.write(`trenchscope theme: ${name}: ${t.error}\n`); return 1; }
        const r = resolveTheme(t.doc, bases);
        if (!r.theme) { io.stderr.write(`trenchscope theme: ${name} refused: ${r.errors.map((e) => `${e.path} ${e.msg}`).join('; ')}\n`); return 1; }
        doc = r.theme;
      }
      const o = applyOverrides(doc, cfg.config.theme?.overrides);
      for (const e of o.errors) io.stderr.write(`trenchscope theme: override ignored: ${e.path} ${e.msg}\n`);
      io.stdout.write(JSON.stringify(o.theme, null, 2) + '\n');
      return 0;
    }
    case 'init': {
      if (!name) return bad('init needs a name');
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) return bad('name: lowercase letters, digits and dashes');
      if ((BASE_THEMES as readonly string[]).includes(name)) return bad(`"${name}" is a built-in theme`);
      const ei = argv.indexOf('--extends');
      const base = ei >= 0 ? argv[ei + 1] : 'cyberspace';
      if (!(BASE_THEMES as readonly string[]).includes(base)) return bad(`--extends expects ${BASE_THEMES.join('|')}`);
      mkdirSync(themesDir(home), { recursive: true, mode: 0o700 });
      const path = join(themesDir(home), `${name}.json`);
      if (existsSync(path)) { io.stdout.write(`${path} already exists\n`); return 0; }
      const { name: _n, ...body } = starterTheme(name, base as (typeof BASE_THEMES)[number]);
      void _n;
      writeFileSync(path, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
      io.stdout.write(`wrote ${path}\n  edit the tokens, then: trenchscope --theme ${name}  (or t in the app cycles to it)\n`);
      return 0;
    }
    case 'check': {
      if (!name) return bad('check needs a file');
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(name, 'utf8')); } catch (e) { io.stderr.write(`trenchscope theme: ${name}: ${(e as Error).message}\n`); return 1; }
      const doc = { name: 'check', ...(raw as object) } as UserTheme & { name: string };
      const errors = validate('userTheme', doc);
      const r = errors.length ? { theme: null, errors } : resolveTheme(doc, bases);
      if (r.theme) { io.stdout.write(`ok: ${name} extends ${doc.extends} (${Object.keys(doc.tokens ?? {}).length} token(s)); contrast floor and the up/down guard (hue, saturation, distance) pass\n`); return 0; }
      for (const e of r.errors) io.stdout.write(`✗ ${e.path || '/'} ${e.msg}\n`);
      return 1;
    }
    default: return bad(`unknown subcommand "${cmd}"`);
  }
}

export async function keymapCommand(argv: string[], io: ThemeIo): Promise<number> {
  const home = dextermHome(io.env);
  const cfg = loadConfig(home);
  for (const e of cfg.errors) io.stderr.write(`trenchscope keymap: config: ${e}\n`);
  const r = applyKeymapConfig<AppAction>(DEFAULT_KEYMAP.bindings, cfg.config.keymap);
  const screen = argv[0] && /^[a-z]+$/.test(argv[0]) ? argv[0] : undefined;
  io.stdout.write(`${cfg.path}${cfg.missing ? ' (no config: defaults)' : ''} · config.keymap.global[action] = ["key", …] · config.keymap.screens[screen][action] = [...]\n`);
  io.stdout.write(`reserved keys: ctrl+c esc enter y Y ! · reserved actions keep their keys: quit back alert.confirm alert.dismiss plans.arm plans.panic plans.gate\n`);
  io.stdout.write(renderKeymap(r, screen) + '\n');
  return r.errors.length ? 1 : 0;
}
