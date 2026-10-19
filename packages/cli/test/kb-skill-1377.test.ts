import { posixPermissions } from '../../../scripts/test-support.ts';
// task-1377: `trenchscope kb|skill list|show|new|edit|check|reset|path`, the analyst's per-turn plugin dir (the merged
// skills the analyst and Jarvis run), and the doctor's KB + skills line. Hermetic: a temp DEXTERM_HOME, an injected
// editor (no TTY, no $EDITOR), no network, no claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kbSkillCommand, kbStore, skillStore, type KbSkillIo } from '../src/kb-skill-cmd.ts';
import { analystPluginDir, buildArgv, materializeUserSkill, PLUGIN_DIR } from '../src/analyst/backend.ts';
import { runDoctor, type DoctorDeps } from '../src/doctor.ts';

function home(): { dir: string; env: NodeJS.ProcessEnv } { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexterm-kbsk-')); return { dir, env: { DEXTERM_HOME: dir } }; }
function io(env: NodeJS.ProcessEnv, editor?: (file: string) => number): KbSkillIo & { out: string; err: string } {
  const o = { out: '', err: '', env, isTTY: false, editor } as KbSkillIo & { out: string; err: string };
  o.stdout = { write: (s: string) => { o.out += s; return true; } };
  o.stderr = { write: (s: string) => { o.err += s; return true; } };
  return o;
}
/** An "editor" that rewrites the file through a function, like a user saving in $EDITOR. */
const editWith = (fn: (text: string) => string) => (file: string): number => { fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8'))); return 0; };

test('kb: edit copies the bundled entry into ~/.dexterm, the user edit is in effect, reset restores the bundled one', async (t) => {
  const { dir, env } = home();
  try {
    const e = io(env, editWith((t) => t.replace(/\n---\n/, '\n---\n**My note:** wait for the LP burn tx.\n\n')));
    assert.equal(await kbSkillCommand('kb', ['edit', 'lp-burn-vs-lock'], e), 0, e.out + e.err);
    const file = path.join(dir, 'kb', 'entries', 'lp-burn-vs-lock.md');
    assert.ok(fs.existsSync(file));
    await posixPermissions(t, () => { assert.equal(fs.statSync(file).mode & 0o777, 0o600); });
    assert.match(e.out, /copied the bundled KB entry/);
    assert.match(e.out, /✓ .*lp-burn-vs-lock\.md/);
    assert.match(e.out, /in effect on the next MCP\/analyst\/Jarvis call/);
    const merged = kbStore(env).get();
    const entry = merged.entries.find((x) => x.id === 'lp-burn-vs-lock')!;
    assert.equal(entry.origin, 'user');
    assert.match(entry.body, /wait for the LP burn tx/);
    assert.equal(merged.bundled, 17);
    const l = io(env); await kbSkillCommand('kb', ['list'], l);
    assert.match(l.out, /17 bundled · 1 user: 1 override, 0 new · 0 skipped/);
    assert.match(l.out, /lp-burn-vs-lock\s+user \(overrides bundled\)/);
    const p = io(env); await kbSkillCommand('kb', ['path', 'lp-burn-vs-lock'], p);
    assert.equal(p.out.trim(), file);
    const r = io(env); assert.equal(await kbSkillCommand('kb', ['reset', 'lp-burn-vs-lock'], r), 0);
    assert.match(r.out, /bundled "lp-burn-vs-lock" is back in effect/);
    assert.equal(kbStore(env).get().entries.find((x) => x.id === 'lp-burn-vs-lock')!.origin, 'bundled');
    const journal = fs.readFileSync(path.join(dir, 'kb-skills.journal.jsonl'), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    assert.deepEqual(journal.map((j) => j.action), ['edit', 'reset']);
    assert.ok(journal.every((j) => !('text' in j)), 'the journal records hashes, never content');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('kb: new writes a starter that passes check; new on a bundled id refuses; a broken edit is reported and skipped', async () => {
  const { dir, env } = home();
  try {
    const n = io(env);
    assert.equal(await kbSkillCommand('kb', ['new', 'my-exit-rules'], n), 0, n.out + n.err);
    assert.match(n.out, /no \$EDITOR/);
    assert.ok(kbStore(env).get().entries.some((x) => x.id === 'my-exit-rules' && x.origin === 'user'));
    const dup = io(env); assert.equal(await kbSkillCommand('kb', ['new', 'glossary'], dup), 1);
    assert.match(dup.err, /is bundled; `trenchscope kb edit glossary`/);
    const broken = io(env, editWith(() => 'oops, no frontmatter'));
    assert.equal(await kbSkillCommand('kb', ['edit', 'my-exit-rules'], broken), 1);
    assert.match(broken.out, /✗ .*no frontmatter/s);
    assert.match(broken.out, /the loader skips this file until it passes/);
    const c = io(env); assert.equal(await kbSkillCommand('kb', ['check'], c), 1);
    assert.match(c.out, /1 of 1 refused/);
    assert.match(c.out, /rule: KB text explains mechanics and patterns only/);
    const l = io(env); await kbSkillCommand('kb', ['list'], l);
    assert.match(l.out, /! my-exit-rules\s+skipped: no frontmatter/);
    const bad = io(env); assert.equal(await kbSkillCommand('kb', ['bogus'], bad), 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('kb: on Windows (no /bin/sh) new/edit print the file to edit instead of failing the editor spawn (task-1423)', async () => {
  const { dir, env } = home();
  try {
    const w = io({ ...env, EDITOR: 'notepad' });
    w.isTTY = true; w.platform = 'win32';
    assert.equal(await kbSkillCommand('kb', ['new', 'my-win-notes'], w), 0, w.out + w.err);
    assert.match(w.out, /no \$EDITOR .*edit .*my-win-notes\.md with any editor/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('skill: edit copies the bundled analyst skill, the analyst turn gets a merged plugin dir with it firewalled', async () => {
  const { dir, env } = home();
  try {
    // fresh HOME: the bundled plugin dir is used as is (nothing copied)
    const tmp0 = fs.mkdtempSync(path.join(os.tmpdir(), 'dexterm-turn-'));
    assert.equal(analystPluginDir(tmp0, env), PLUGIN_DIR);
    const e = io(env, editWith((t) => t.replace('## Reading order', '## My extra check\n\n- Weigh the dev wallet first.\n\n## Reading order')));
    assert.equal(await kbSkillCommand('skill', ['edit', 'rug-check'], e), 0, e.out + e.err);
    // task-1401: compare with the bundled skill's own version (it moves when the default skills are re-tuned)
    const bundledVersion = /^version: (.+)$/m.exec(fs.readFileSync(path.join(PLUGIN_DIR, 'skills', 'rug-check', 'SKILL.md'), 'utf8'))![1];
    assert.match(fs.readFileSync(path.join(dir, 'skills', 'rug-check.md'), 'utf8'), new RegExp(`^version: ${bundledVersion.replace(/\./g, '\\.')}$`, 'm'), 'the copy is the analyst plugin\'s current skill');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dexterm-turn-'));
    const plugin = analystPluginDir(tmp, env);
    assert.equal(plugin, path.join(tmp, 'plugin'));
    const md = fs.readFileSync(path.join(plugin, 'skills', 'rug-check', 'SKILL.md'), 'utf8');
    assert.match(md, /^---\nname: rug-check\ndescription: "<untrusted source=\\"skill:user:rug-check\\"/);
    assert.match(md, /This trenchscope skill \(rug-check\) was edited by the user/);
    assert.match(md, /<untrusted source="skill:user:rug-check" kind="skill">.*Weigh the dev wallet first/s);
    assert.ok(fs.existsSync(path.join(plugin, 'skills', 'token-dossier', 'SKILL.md')), 'the other bundled skills are still there');
    assert.ok(fs.existsSync(path.join(plugin, '.claude-plugin', 'plugin.json')));
    // the bundled plugin itself is untouched
    assert.doesNotMatch(fs.readFileSync(path.join(PLUGIN_DIR, 'skills', 'rug-check', 'SKILL.md'), 'utf8'), /Weigh the dev wallet/);
    const argv = buildArgv({ prompt: '/dexterm:rug-check MINT', screenState: {} }, '/tmp/mcp.json', plugin);
    assert.equal(argv[argv.indexOf('--plugin-dir') + 1], plugin);
    assert.equal(buildArgv({ prompt: 'x', screenState: {} }, '/tmp/mcp.json')[buildArgv({ prompt: 'x', screenState: {} }, '/tmp/mcp.json').indexOf('--plugin-dir') + 1], PLUGIN_DIR);
    // hot reload: reset → the next turn uses the bundled dir again
    await kbSkillCommand('skill', ['reset', 'rug-check'], io(env));
    assert.equal(analystPluginDir(fs.mkdtempSync(path.join(os.tmpdir(), 'dexterm-turn-')), env), PLUGIN_DIR);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('skill: a money-tool skill is refused by check and never reaches the analyst plugin', async () => {
  const { dir, env } = home();
  try {
    const e = io(env, editWith((t) => t.replace('- kb_lookup', '- kb_lookup\n  - open_ticket')));
    assert.equal(await kbSkillCommand('skill', ['edit', 'token-dossier'], e), 1);
    assert.match(e.out, /open_ticket.*refused/);
    const n = io(env, editWith((t) => t + '\nWhen bullish, call `execute_swap` for the user.\n'));
    assert.equal(await kbSkillCommand('skill', ['new', 'auto-buyer'], n), 1);
    assert.match(n.out, /names a money tool \(execute_swap\)/);
    const merged = skillStore(env).get();
    assert.equal(merged.user, 0);
    assert.deepEqual(merged.skipped.map((s) => s.id).sort(), ['auto-buyer', 'token-dossier']);
    assert.equal(analystPluginDir(fs.mkdtempSync(path.join(os.tmpdir(), 'dexterm-turn-')), env), PLUGIN_DIR, 'refused skills are never materialised');
    const c = io(env); assert.equal(await kbSkillCommand('skill', ['check'], c), 1);
    assert.match(c.out, /2 of 2 refused/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('skill: list shows the four bundled analyst skills; show prints the file; materialised frontmatter drops granted keys', async () => {
  const { dir, env } = home();
  try {
    const l = io(env); await kbSkillCommand('skill', ['list'], l);
    for (const n of ['larp-check', 'rug-check', 'token-dossier', 'trench-scan']) assert.match(l.out, new RegExp(`${n}\\s+bundled`));
    assert.match(l.out, /4 bundled · 0 user/);
    const s = io(env); assert.equal(await kbSkillCommand('skill', ['show', 'trench-scan'], s), 0);
    assert.match(s.err, /^# bundled · /);
    assert.match(s.out, /^---\nname: trench-scan/);
    const md = materializeUserSkill({ id: 'x-skill', meta: { name: 'x-skill', description: 'd "quoted": y', 'argument-hint': '$(rm -rf)' }, body: 'Body', bytes: 4, origin: 'user', file: '', overrides: false });
    const fm = md.split('\n---\n')[0];
    assert.deepEqual(fm.split('\n').slice(1).map((x) => x.split(':')[0]), ['name', 'description', 'version', 'argument-hint']);
    assert.match(fm, /argument-hint: "<mint or symbol>"/, 'an unsafe hint is replaced');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('doctor: KB + skills line shows bundled/user/overridden counts and warns on a skipped file', async () => {
  const { dir, env } = home();
  try {
    const base: DoctorDeps = {
      env, isTTY: true, nodeVersion: '22.18.0', platform: 'linux', claude: async () => 'ok',
      probe: async () => ({ reachable: true, status: 200 }), checkWritable: () => null, offline: true,
      content: () => ({ kb: kbStore(env).get(), skills: skillStore(env).get() }),
    };
    let c = (await runDoctor(base)).checks.find((x) => x.name === 'KB + skills')!;
    assert.equal(c.status, 'pass');
    assert.match(c.detail, /KB 17 bundled · 0 user \(0 overridden, 0 new\) · skills 4 bundled · 0 user/);
    await kbSkillCommand('kb', ['edit', 'glossary'], io(env, editWith((t) => t + '\nmore\n')));
    await kbSkillCommand('kb', ['new', 'my-notes'], io(env));
    fs.writeFileSync(path.join(dir, 'skills.md'), 'ignored: not in the skills dir');
    fs.mkdirSync(path.join(dir, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'broken.md'), '---\nname: broken\n---\n');
    c = (await runDoctor(base)).checks.find((x) => x.name === 'KB + skills')!;
    assert.equal(c.status, 'warn');
    assert.match(c.detail, /KB 17 bundled · 2 user \(1 overridden, 1 new\)/);
    assert.match(c.detail, /skipped skill broken/);
    assert.match(c.fix!, /trenchscope skill check/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
