// @dexterm/custom — the config loader (task-1358 Tier 1). ~/.dexterm/config.json is the canonical,
// machine-written config (0600, `version: 4`); workspaces are one JSON file each in ~/.dexterm/workspaces/,
// user themes in ~/.dexterm/themes/. THIS MODULE NEVER READS A KEY FILE: `<name>.key` files are the data
// layer's business, and the only thing the loader does with a key is move one OUT of an old config.
//
// Failure model: a missing config is the defaults (nothing is written until the user saves something); an
// unreadable or invalid config keeps the defaults and reports the error so the app can show a toast and
// `trenchscope doctor` can name the file. Nothing here throws on I/O except `saveConfig` / `writeWorkspace`.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync, unlinkSync, statSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CONFIG_VERSION, defaultConfig, migrate, validateConfig, type DextermConfig, type PatchOp, type SchemaError } from './schema.ts';
import { applyOps } from './schema.ts';
import { builtinWorkspaces, parseWorkspace, validateWorkspace, type Workspace } from './workspace.ts';

/** `DEXTERM_HOME` overrides `~/.dexterm` (tests point it at a temp dir). Same rule as the CLI's boot-state. */
export function dextermHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEXTERM_HOME && env.DEXTERM_HOME.trim() ? env.DEXTERM_HOME : join(homedir(), '.dexterm');
}
export const configPath = (home: string): string => join(home, 'config.json');
export const journalPath = (home: string): string => join(home, 'config.journal.jsonl');
export const workspacesDir = (home: string): string => join(home, 'workspaces');
export const packsDir = (home: string): string => join(home, 'packs');

export interface LoadedConfig {
  config: DextermConfig;
  path: string;
  /** true when config.json did not exist (defaults in use, nothing written). */
  missing: boolean;
  /** Problems found; the config in use is the defaults when `ok` is false. */
  ok: boolean;
  errors: string[];
  /** Migration notes (what changed) when an older config was upgraded and rewritten. */
  notes: string[];
  /** Key files written by a migration (names only, never values). */
  extractedKeyFiles: string[];
  /** sha256 of the file as loaded (for stale-proposal checks). */
  hash: string;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Load (and migrate if needed) ~/.dexterm/config.json. Never throws. */
export function loadConfig(home: string): LoadedConfig {
  const path = configPath(home);
  const base: LoadedConfig = { config: defaultConfig(), path, missing: false, ok: true, errors: [], notes: [], extractedKeyFiles: [], hash: sha('') };
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...base, missing: true };
    return { ...base, ok: false, errors: [`${path}: ${(e as Error).message}`] };
  }
  base.hash = sha(text);
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { ...base, ok: false, errors: [`${path}: not valid JSON (${(e as Error).message}); keeping defaults`] }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...base, ok: false, errors: [`${path}: expected an object; keeping defaults`] };
  const version = Number((raw as { version?: unknown }).version ?? 1);
  if (version === CONFIG_VERSION) {
    const errors = validateConfig(raw);
    if (errors.length) return { ...base, ok: false, errors: errors.slice(0, 5).map((e) => `${path}: ${e.path || '/'} ${e.msg}`) };
    return { ...base, config: raw as DextermConfig };
  }
  // older (or newer) config: migrate, back up, write the new one, write extracted keys to <name>.key (0600)
  let m: ReturnType<typeof migrate>;
  try { m = migrate(raw); } catch (e) { return { ...base, ok: false, errors: [`${path}: ${(e as Error).message}`] }; }
  if (m.errors.length) return { ...base, ok: false, errors: m.errors.slice(0, 5).map((e) => `${path}: after migration ${e.path || '/'} ${e.msg}`) };
  const out: LoadedConfig = { ...base, config: m.config, notes: [...m.notes] };
  try {
    writeFileSync(`${path}.bak-v${m.from}`, text, { mode: 0o600 });
    for (const [name, value] of Object.entries(m.extractedKeys)) {
      const kf = join(home, `${name}.key`);
      if (!existsSync(kf)) { writeFileSync(kf, value + '\n', { mode: 0o600 }); out.extractedKeyFiles.push(`${name}.key`); }
      else out.notes.push(`${name}.key already exists; the key in config.json was dropped, not copied`);
    }
    saveConfig(home, m.config);
    out.notes.push(`migrated config.json v${m.from} → v${CONFIG_VERSION} (backup: config.json.bak-v${m.from})`);
    out.hash = sha(readFileSync(path, 'utf8'));
  } catch (e) {
    out.ok = false;
    out.errors.push(`${path}: migration could not be written (${(e as Error).message}); using the migrated config for this run only`);
  }
  return out;
}

/** Validate + write config.json atomically (0600, directory 0700). Throws on a schema error or I/O failure. */
export function saveConfig(home: string, config: DextermConfig): void {
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`config invalid: ${errors[0].path || '/'} ${errors[0].msg}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = configPath(home);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

// ------------------------------------------------------------------ journal (applied changes with inverses → undo)
export interface JournalEntry { seq: number; at: number; kind: 'apply' | 'undo' | 'redo'; actor: string; why: string; ops: PatchOp[]; inverse: PatchOp[]; hashBefore: string; hashAfter: string }

export function readJournal(home: string): JournalEntry[] {
  try {
    return readFileSync(journalPath(home), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as JournalEntry);
  } catch { return []; }
}

/** Apply ops to the stored config, journal them with the inverse, and save. Throws (and writes nothing) on a bad op or schema error. */
export function applyAndJournal(home: string, ops: PatchOp[], meta: { actor: string; why: string; kind?: JournalEntry['kind']; now?: number }): { config: DextermConfig; entry: JournalEntry } {
  const loaded = loadConfig(home);
  if (!loaded.ok) throw new Error(loaded.errors[0]);
  const { doc, inverse } = applyOps(loaded.config, ops);
  const errors = validateConfig(doc);
  if (errors.length) throw new Error(`refused: ${errors[0].path || '/'} ${errors[0].msg}`);
  saveConfig(home, doc);
  const after = sha(readFileSync(configPath(home), 'utf8'));
  const seq = (readJournal(home).at(-1)?.seq ?? 0) + 1;
  const entry: JournalEntry = { seq, at: meta.now ?? Date.now(), kind: meta.kind ?? 'apply', actor: meta.actor, why: meta.why, ops, inverse, hashBefore: loaded.hash, hashAfter: after };
  appendFileSync(journalPath(home), JSON.stringify(entry) + '\n', { mode: 0o600 });
  return { config: doc, entry };
}

/** Undo the last applied/redone change if the config has not been edited by hand since. */
export function undoLast(home: string, now = Date.now()): { ok: true; entry: JournalEntry } | { ok: false; reason: string } {
  const j = readJournal(home);
  // the last entry that can be undone: walk back skipping already-undone applies
  let depth = 0;
  for (let i = j.length - 1; i >= 0; i--) {
    const e = j[i];
    if (e.kind === 'undo') { depth++; continue; }
    if (depth > 0) { depth--; continue; }
    const current = loadConfig(home);
    if (current.hash !== e.hashAfter) return { ok: false, reason: 'cannot undo: config.json changed since (edited by hand?)' };
    try {
      const { entry } = applyAndJournal(home, e.inverse, { actor: 'user', why: `undo #${e.seq}`, kind: 'undo', now });
      return { ok: true, entry };
    } catch (err) { return { ok: false, reason: `cannot undo: ${(err as Error).message}` }; }
  }
  return { ok: false, reason: 'nothing to undo' };
}

// ------------------------------------------------------------------ workspaces on disk
export const WS_FILE = /^[a-z][a-z0-9-]{0,39}\.json$/;

export interface WorkspaceFile { name: string; path: string | null; workspace: Workspace; builtin: boolean; error?: string; /** task-1358 Tier 4: set when the workspace comes from an installed pack (`<pack>/<name>`). */ pack?: string }

/** Built-ins first (default, morning-hud), then the user's files; a user file with a built-in's name REPLACES it. Bad files are listed with their error. */
export function listWorkspaces(home: string): WorkspaceFile[] {
  const out: WorkspaceFile[] = builtinWorkspaces().map((w) => ({ name: w.name, path: null, workspace: w, builtin: true }));
  const dir = workspacesDir(home);
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => WS_FILE.test(f)).sort(); } catch { return out; }
  for (const f of files) {
    const path = join(dir, f);
    const name = f.slice(0, -5);
    try {
      if (statSync(path).isSymbolicLink()) continue;
      const ws = parseWorkspace(readFileSync(path, 'utf8'), f);
      if (ws.name !== name) throw new Error(`${f}: "name" must be "${name}" (the file name)`);
      const i = out.findIndex((w) => w.name === name);
      const entry: WorkspaceFile = { name, path, workspace: ws, builtin: false };
      if (i >= 0) out[i] = entry; else out.push(entry);
    } catch (e) {
      out.push({ name, path, workspace: { name }, builtin: false, error: (e as Error).message });
    }
  }
  return out;
}

export function readWorkspace(home: string, name: string): Workspace | null {
  return listWorkspaces(home).find((w) => w.name === name && !w.error)?.workspace ?? null;
}

/** Write a workspace file (validated, 0600). Throws on a bad document or name. */
export function writeWorkspace(home: string, ws: Workspace): string {
  const errors = validateWorkspace(ws);
  if (errors.length) throw new Error(`workspace invalid: ${errors[0].path || '/'} ${errors[0].msg}`);
  if (ws.name.includes('/')) throw new Error('a user workspace name cannot contain "/" (reserved for packs)');
  mkdirSync(workspacesDir(home), { recursive: true, mode: 0o700 });
  const path = join(workspacesDir(home), `${ws.name}.json`);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(ws, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

export function removeWorkspace(home: string, name: string): boolean {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) return false;
  const path = join(workspacesDir(home), `${name}.json`);
  try { unlinkSync(path); return true; } catch { return false; }
}

export type { DextermConfig, SchemaError };
