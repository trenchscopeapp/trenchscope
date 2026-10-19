// @dexterm/custom — PACKS (task-1358 Tier 4, from the task-1288 design §9 and prototype `packs/pack.mjs`).
//
// A pack is a directory: pack.json + workspaces/ themes/ rules/ keymap.json widgets/<name>/{widget.json, *.html}.
// Integrity is a lock file (sha256 per file + a pack hash); authenticity is an SSH signature over the lock
// (`ssh-keygen -Y`, present on every macOS/Linux box, zero new dependencies); "reviewed" is a hash allow-list
// trenchscope ships (the task-1301 trust page publishes the same list). Trust tiers decide DEFAULTS, never powers:
//   • rules from a reviewed/signed pack load enabled, from an unsigned pack disabled (the user enables each one);
//   • a pack keymap is never merged at install — it is shown, and merged only by an explicit command;
//   • a pack widget (an html page the popup host would serve) is registered DISABLED with no capabilities; the
//     user enables it by name (that is the consent: a pack never gets code run on install or on load);
//   • nothing in a pack can reach keys, the signer, caps, mandates or the gate: there is no such field, the
//     config schema refuses unknown sections by name, and pack rules go through the same `normalizeAction`
//     refusals as typed ones (money-shaped args die at load).
// Everything here is plain files + sha256 + one optional ssh-keygen spawn for sign/verify. No network.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync, existsSync, mkdirSync, cpSync, realpathSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validate, type SchemaError, type DextermConfig, type RuleJson, type UserTheme, type KeymapConfig, type PackRecord } from './schema.ts';
import { parseWorkspace, type Workspace } from './workspace.ts';
import { parseRulesFile, ruleToJson, ruleToText, slug, RulesEngine } from './rules.ts';
import { packsDir } from './config.ts';
import { auditWidgetHtml } from './widget-html.ts';

export const PACK_MANIFEST = 'pack.json';
export const PACK_LOCK = 'pack.lock';
export const PACK_SIG = 'pack.lock.sig';
export const PACK_NAMESPACE = 'dexterm-pack';
export const WIDGET_MANIFEST = 'widget.json';
/** Hard caps so a pack can never be a disk / memory problem: 200 files, 2 MB total, 512 KB per file. */
export const PACK_LIMITS = { maxFiles: 200, maxBytes: 2_000_000, maxFileBytes: 512_000 } as const;
const SKIP = new Set([PACK_LOCK, PACK_SIG, '.DS_Store']);
const sha = (buf: Buffer | string): string => createHash('sha256').update(buf).digest('hex');

export interface PackLockFile { path: string; sha256: string; bytes: number }
export interface PackLock { version: 1; files: PackLockFile[]; hash: string }
export interface PackManifest {
  name: string; version: string; publisher: string; description?: string;
  requires?: { dexterm?: string; api?: number };
  contents: { workspaces?: string[]; themes?: string[]; rules?: string[]; keymap?: string; widgets?: string[] };
}
export interface WidgetManifest {
  name: string; version: string; api: number; description?: string;
  widgets: Array<{ id: string; title: string; page: string; topics: string[]; min?: { w: number; h: number } }>;
}
export type PackTrust = PackRecord['trust'];

export type PackErrorCode = 'manifest' | 'files' | 'integrity' | 'signature' | 'trust' | 'install' | 'secret' | 'io';
export class PackError extends Error {
  readonly code: PackErrorCode;
  constructor(msg: string, code: PackErrorCode = 'manifest') { super(msg); this.name = 'PackError'; this.code = code; }
}

/** Shipped reviewed-pack hashes (`sha256:…`). Empty until a first-party pack is published AND reviewed; `~/.dexterm/reviewed-packs.json` adds to it. */
export const REVIEWED_PACKS: readonly string[] = [];

// ------------------------------------------------------------------ files + lock
/**
 * Every regular file in the pack, sorted, as pack-relative posix paths. REFUSES (does not skip) symlinks of any
 * kind, `node_modules`, `.git`, dotfiles, paths that are not plain `[a-z0-9/_.-]`, and the size caps: a pack that
 * tries any of these is not a pack. (A symlink copied into ~/.dexterm/packs would be followed on load.)
 */
export function listPackFiles(dir: string): string[] {
  const out: string[] = [];
  let bytes = 0;
  const walk = (d: string): void => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (SKIP.has(f) && d === dir) continue;
      const rel = relative(dir, p).split(sep).join('/');
      if (f === 'node_modules' || f === '.git') throw new PackError(`refused: ${rel} (packs are plain files; no dependencies, no repos)`, 'files');
      if (f.startsWith('.')) throw new PackError(`refused: hidden entry ${rel}`, 'files');
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new PackError(`refused: ${rel} is a symlink (packs may not link outside themselves)`, 'files');
      if (st.isDirectory()) { walk(p); continue; }
      if (!st.isFile()) throw new PackError(`refused: ${rel} is not a regular file`, 'files');
      if (!/^[a-z0-9][a-z0-9/_.-]*$/.test(rel) || rel.includes('..') || rel.includes('//')) throw new PackError(`refused: file name ${rel} (lowercase letters, digits, - _ . / only)`, 'files');
      if (st.size > PACK_LIMITS.maxFileBytes) throw new PackError(`refused: ${rel} is ${st.size} bytes (max ${PACK_LIMITS.maxFileBytes})`, 'files');
      bytes += st.size;
      out.push(rel);
      if (out.length > PACK_LIMITS.maxFiles) throw new PackError(`refused: more than ${PACK_LIMITS.maxFiles} files`, 'files');
      if (bytes > PACK_LIMITS.maxBytes) throw new PackError(`refused: pack is larger than ${PACK_LIMITS.maxBytes} bytes`, 'files');
    }
  };
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw new PackError(`${dir}: not a directory`, 'io');
  walk(dir);
  return out;
}

/** Compute the lock: per-file hashes and the pack hash (hash of the sorted "path sha" lines). */
export function computeLock(dir: string): PackLock {
  const files = listPackFiles(dir).map((path) => { const buf = readFileSync(join(dir, path)); return { path, sha256: sha(buf), bytes: buf.length }; });
  const hash = 'sha256:' + sha(files.map((f) => `${f.path} ${f.sha256}`).join('\n'));
  return { version: 1, files, hash };
}
export function writeLock(dir: string): PackLock {
  const lock = computeLock(dir);
  writeFileSync(join(dir, PACK_LOCK), JSON.stringify(lock, null, 2) + '\n');
  return lock;
}
export function readLock(dir: string): PackLock | null {
  const p = join(dir, PACK_LOCK);
  if (!existsSync(p)) return null;
  const raw = JSON.parse(readFileSync(p, 'utf8')) as PackLock;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.files) || typeof raw.hash !== 'string') throw new PackError('pack.lock is not a v1 lock', 'integrity');
  return raw;
}

/** Integrity: the lock on disk must match the files on disk. */
export function checkIntegrity(dir: string): { ok: true; hash: string } | { ok: false; reason: string; changed?: string[]; missing?: string[]; added?: string[]; hash?: string } {
  let stored: PackLock | null;
  try { stored = readLock(dir); } catch (e) { return { ok: false, reason: (e as Error).message }; }
  if (!stored) return { ok: false, reason: 'no pack.lock (run: trenchscope pack lock <dir>)' };
  let now: PackLock;
  try { now = computeLock(dir); } catch (e) { return { ok: false, reason: (e as Error).message }; }
  if (stored.hash !== now.hash) {
    const changed = now.files.filter((f) => { const s = stored!.files.find((x) => x.path === f.path); return s && s.sha256 !== f.sha256; }).map((f) => f.path);
    const missing = stored.files.filter((s) => !now.files.find((f) => f.path === s.path)).map((s) => s.path);
    const added = now.files.filter((f) => !stored!.files.find((s) => s.path === f.path)).map((f) => f.path);
    return { ok: false, reason: 'files differ from pack.lock', changed, missing, added, hash: now.hash };
  }
  return { ok: true, hash: now.hash };
}

// ------------------------------------------------------------------ manifest
const JSON_FORBIDDEN = /"(__proto__|constructor|prototype)"\s*:/;
/** Parse JSON from a pack file: a prototype-pollution key anywhere is a refusal, whatever the schema says later. */
export function readPackJson(dir: string, rel: string): unknown {
  const p = join(dir, rel);
  let text: string;
  try { text = readFileSync(p, 'utf8'); } catch (e) { throw new PackError(`${rel}: ${(e as Error).message}`, 'io'); }
  if (JSON_FORBIDDEN.test(text)) throw new PackError(`${rel}: forbidden key (__proto__ / constructor / prototype)`, 'manifest');
  try { return JSON.parse(text) as unknown; } catch (e) { throw new PackError(`${rel}: not valid JSON (${(e as Error).message})`, 'manifest'); }
}

/** Is `rel` a regular file inside `dir` (after realpath; no traversal, no link)? */
function insidePack(dir: string, rel: string): boolean {
  const root = realpathSync(dir);
  const p = resolve(dir, rel);
  if (!existsSync(p)) return false;
  if (lstatSync(p).isSymbolicLink()) return false;
  const real = realpathSync(p);
  return real === root || (real.startsWith(root + sep) && statSync(real).isFile());
}

export function readManifest(dir: string): PackManifest {
  const m = readPackJson(dir, PACK_MANIFEST);
  const errors = validate('packManifest', m);
  if (errors.length) throw new PackError(`pack.json invalid: ${errors.slice(0, 3).map((e) => `${e.path || '/'} ${e.msg}`).join('; ')}`, 'manifest');
  const man = m as PackManifest;
  if (man.requires?.api !== undefined && man.requires.api > 1) throw new PackError(`pack.json needs api ${man.requires.api}; this trenchscope speaks api 1`, 'manifest');
  const refs = [...(man.contents.workspaces ?? []), ...(man.contents.themes ?? []), ...(man.contents.rules ?? []), ...(man.contents.keymap ? [man.contents.keymap] : []), ...(man.contents.widgets ?? []).map((w) => `${w}/${WIDGET_MANIFEST}`)];
  for (const r of refs) if (!insidePack(dir, r)) throw new PackError(`pack.json references ${r}, which is missing or not a plain file inside the pack`, 'manifest');
  return man;
}

// ------------------------------------------------------------------ signatures (ssh-keygen -Y)
export const allowedSignersPath = (home: string): string => join(home, 'allowed_signers');
export const reviewedPacksPath = (home: string): string => join(home, 'reviewed-packs.json');

/** The reviewed hashes: the shipped list plus the user's `~/.dexterm/reviewed-packs.json` (an array of `sha256:…`). */
export function reviewedHashes(home: string): string[] {
  const out = [...REVIEWED_PACKS];
  try {
    const raw = JSON.parse(readFileSync(reviewedPacksPath(home), 'utf8')) as unknown;
    if (Array.isArray(raw)) for (const h of raw) if (typeof h === 'string' && /^sha256:[0-9a-f]{64}$/.test(h)) out.push(h);
  } catch { /* none */ }
  return out;
}

const SSH_PUBKEY = /^(ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|ssh-rsa|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( [^\s]+)?$/;
const IDENTITY = /^[a-z0-9][a-z0-9._@-]{0,79}$/;

/** Pin a publisher key: one `<identity> namespaces="dexterm-pack" <pubkey>` line in ~/.dexterm/allowed_signers (0600). */
export function pinSigner(home: string, identity: string, pubkey: string): string {
  if (!IDENTITY.test(identity)) throw new PackError('identity: lowercase letters, digits, . _ @ - (max 80)', 'signature');
  const key = pubkey.trim();
  if (!SSH_PUBKEY.test(key)) throw new PackError('pubkey: an OpenSSH public key line (ssh-ed25519 AAAA… [comment])', 'signature');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const line = `${identity} namespaces="${PACK_NAMESPACE}" ${key.split(/\s+/).slice(0, 2).join(' ')}\n`;
  const p = allowedSignersPath(home);
  const existing = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (existing.includes(line)) return p;
  appendFileSync(p, line, { mode: 0o600 });
  return p;
}
export function listSigners(home: string): Array<{ identity: string; key: string }> {
  try {
    return readFileSync(allowedSignersPath(home), 'utf8').split('\n').filter(Boolean).map((l) => { const [identity, , type, key] = l.split(/\s+/); return { identity, key: `${type} ${key.slice(0, 16)}…` }; });
  } catch { return []; }
}

export function signPack(dir: string, opts: { keyFile: string; namespace?: string }): string {
  const lockPath = join(dir, PACK_LOCK);
  if (!existsSync(lockPath)) writeLock(dir);
  const r = spawnSync('ssh-keygen', ['-Y', 'sign', '-f', opts.keyFile, '-n', opts.namespace ?? PACK_NAMESPACE, lockPath], { encoding: 'utf8', timeout: 10_000 });
  if (r.error) throw new PackError(`ssh-keygen not available: ${r.error.message}`, 'signature');
  if (r.status !== 0) throw new PackError(`ssh-keygen sign failed: ${(r.stderr || '').trim().split('\n')[0]}`, 'signature');
  return join(dir, PACK_SIG);
}

/** Verify pack.lock.sig against the pinned publisher `identity` in `allowedSigners`. Never throws. */
export function verifySignature(dir: string, opts: { allowedSigners: string; identity: string; namespace?: string }): { ok: true; identity: string } | { ok: false; reason: string } {
  const lockPath = join(dir, PACK_LOCK), sigPath = join(dir, PACK_SIG);
  if (!existsSync(sigPath)) return { ok: false, reason: 'unsigned (no pack.lock.sig)' };
  if (!existsSync(lockPath)) return { ok: false, reason: 'no pack.lock' };
  if (!existsSync(opts.allowedSigners)) return { ok: false, reason: `no pinned publisher keys (${basename(opts.allowedSigners)}); trenchscope pack trust <identity> "<pubkey>"` };
  if (!IDENTITY.test(opts.identity)) return { ok: false, reason: 'bad identity' };
  const r = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', opts.allowedSigners, '-I', opts.identity, '-n', opts.namespace ?? PACK_NAMESPACE, '-s', sigPath], { input: readFileSync(lockPath), encoding: 'utf8', timeout: 10_000 });
  if (r.error) return { ok: false, reason: `ssh-keygen not available: ${r.error.message}` };
  return r.status === 0 ? { ok: true, identity: opts.identity } : { ok: false, reason: (r.stderr || r.stdout || 'bad signature').trim().split('\n')[0] };
}

/** Trust tier for a pack: reviewed (hash in the shipped list) > signed (pinned publisher) > unsigned. */
export function trustOf(x: { hash: string; signatureOk: boolean; reviewedHashes: readonly string[] }): PackTrust {
  if (x.reviewedHashes.includes(x.hash)) return 'reviewed';
  if (x.signatureOk) return 'signed';
  return 'unsigned';
}

// ------------------------------------------------------------------ inspect (pure read; the install card + `trenchscope pack verify`)
export interface PackRulesFile { path: string; rules: RuleJson[]; errors: Array<{ line: number; msg: string }> }
export interface PackWidget { name: string; dir: string; manifest: WidgetManifest | null; pages: string[]; error?: string }
export interface PackInspection {
  dir: string;
  manifest: PackManifest;
  integrity: ReturnType<typeof checkIntegrity>;
  signature: ReturnType<typeof verifySignature>;
  trust: PackTrust;
  workspaces: Array<{ path: string; workspace: Workspace | null; error?: string }>;
  themes: Array<{ path: string; name: string; doc: (UserTheme & { name: string }) | null; error?: string }>;
  rules: PackRulesFile[];
  keymap: { path: string; keymap: KeymapConfig | null; error?: string } | null;
  widgets: PackWidget[];
  /** Things the user should see on the card before accepting. */
  warnings: string[];
}

/** Rule ids and sources are namespaced per pack: `<pack>-<rule>` from `pack:<pack>`. */
export const packRuleId = (pack: string, id: string): string => slug(`${pack}-${id}`);
export const packWorkspaceName = (pack: string, name: string): string => `${pack}/${name}`;
export const packThemeName = (pack: string, name: string): string => slug(`${pack}-${name}`);
export const packWidgetKey = (pack: string, widget: string): string => `${pack}/${widget}`;

export function inspectPack(dir: string, opts: { home?: string; reviewedHashes?: readonly string[]; identity?: string } = {}): PackInspection {
  const manifest = readManifest(dir);
  const integrity = checkIntegrity(dir);
  const identity = opts.identity ?? manifest.publisher;
  const signature = opts.home ? verifySignature(dir, { allowedSigners: allowedSignersPath(opts.home), identity }) : { ok: false as const, reason: 'no home (signature not checked)' };
  const reviewed = opts.reviewedHashes ?? (opts.home ? reviewedHashes(opts.home) : REVIEWED_PACKS);
  const trust = integrity.ok ? trustOf({ hash: integrity.hash, signatureOk: signature.ok, reviewedHashes: reviewed }) : 'unsigned';
  const warnings: string[] = [];
  const out: PackInspection = { dir, manifest, integrity, signature, trust, workspaces: [], themes: [], rules: [], keymap: null, widgets: [], warnings };
  for (const rel of manifest.contents.workspaces ?? []) {
    try {
      const raw = readPackJson(dir, rel);
      const ws = parseWorkspace(JSON.stringify(raw), rel);
      if (ws.name !== basename(rel, '.json')) throw new Error(`"name" must be "${basename(rel, '.json')}" (the file name)`);
      out.workspaces.push({ path: rel, workspace: ws });
    } catch (e) { out.workspaces.push({ path: rel, workspace: null, error: (e as Error).message }); }
  }
  for (const rel of manifest.contents.themes ?? []) {
    const name = basename(rel, '.json');
    try {
      const raw = readPackJson(dir, rel) as Record<string, unknown>;
      if (raw && typeof raw === 'object' && raw.name !== undefined && raw.name !== name) throw new Error(`"name" must be "${name}" (the file name)`);
      const doc = { ...(raw as object), name } as UserTheme & { name: string };
      const errors = validate('userTheme', doc);
      if (errors.length) throw new Error(`${errors[0].path || '/'} ${errors[0].msg}`);
      out.themes.push({ path: rel, name, doc });
    } catch (e) { out.themes.push({ path: rel, name, doc: null, error: (e as Error).message }); }
  }
  for (const rel of manifest.contents.rules ?? []) {
    let text: string;
    try { text = readFileSync(join(dir, rel), 'utf8'); } catch (e) { out.rules.push({ path: rel, rules: [], errors: [{ line: 0, msg: (e as Error).message }] }); continue; }
    if (rel.endsWith('.json')) {
      try {
        const raw = readPackJson(dir, rel);
        const arr = Array.isArray(raw) ? raw : [raw];
        const file: PackRulesFile = { path: rel, rules: [], errors: [] };
        arr.forEach((r, i) => {
          const errs = validate('ruleJson', r);
          if (errs.length) { file.errors.push({ line: i + 1, msg: `${errs[0].path || '/'} ${errs[0].msg}` }); return; }
          const j = r as RuleJson;
          const rule: RuleJson = { ...j, id: packRuleId(manifest.name, j.id), source: `pack:${manifest.name}` };
          // the same refusals a typed rule gets (money-shaped args, prototype keys, caps): the schema alone allows any args
          try { new RulesEngine().load(rule); } catch (e) { file.errors.push({ line: i + 1, msg: (e as Error).message }); return; }
          file.rules.push(rule);
        });
        out.rules.push(file);
      } catch (e) { out.rules.push({ path: rel, rules: [], errors: [{ line: 0, msg: (e as Error).message }] }); }
    } else {
      const parsed = parseRulesFile(text, { source: `pack:${manifest.name}`, idPrefix: manifest.name });
      out.rules.push({ path: rel, rules: parsed.rules, errors: parsed.errors });
    }
  }
  for (const f of out.rules) for (const e of f.errors) warnings.push(`${f.path}:${e.line} refused: ${e.msg}`);
  if (manifest.contents.keymap) {
    const rel = manifest.contents.keymap;
    try {
      const raw = readPackJson(dir, rel);
      const errors = validate('keymap', raw);
      if (errors.length) throw new Error(`${errors[0].path || '/'} ${errors[0].msg}`);
      out.keymap = { path: rel, keymap: raw as KeymapConfig };
      const n = Object.keys((raw as KeymapConfig).global ?? {}).length + Object.values((raw as KeymapConfig).screens ?? {}).reduce((a, t) => a + Object.keys(t).length, 0);
      warnings.push(`keymap: ${n} binding(s) are NOT merged on install — review with "trenchscope pack keymap ${manifest.name}" and merge explicitly`);
    } catch (e) { out.keymap = { path: rel, keymap: null, error: (e as Error).message }; warnings.push(`${rel} refused: ${(e as Error).message}`); }
  }
  for (const wdir of manifest.contents.widgets ?? []) {
    const name = basename(wdir);
    const entry: PackWidget = { name, dir: wdir, manifest: null, pages: [] };
    try {
      const raw = readPackJson(dir, `${wdir}/${WIDGET_MANIFEST}`);
      const errors = validate('widgetManifest', raw);
      if (errors.length) throw new Error(`${errors[0].path || '/'} ${errors[0].msg}`);
      const wm = raw as WidgetManifest;
      if (wm.name !== name) throw new Error(`"name" must be "${name}" (the directory name)`);
      for (const w of wm.widgets) {
        if (!insidePack(dir, `${wdir}/${w.page}`)) throw new Error(`page ${w.page} is missing`);
        // r2: a page that would load code or documents from elsewhere is refused HERE, before anything lands (the popup
        // host refuses the same page again at open and at ticket issue; its CSP allow-lists inline blocks by hash only)
        const problems = auditWidgetHtml(readFileSync(join(dir, wdir, w.page), 'utf8'));
        if (problems.length) throw new Error(`page ${w.page}: ${problems.join('; ')}`);
        entry.pages.push(`${wdir}/${w.page}`);
      }
      entry.manifest = wm;
      warnings.push(`widget ${name}: ${wm.widgets.length} page(s) of html+js the popup host would serve (inline only, hash-allow-listed; no remote script, style, frame or import) — installed DISABLED; enable with "trenchscope pack widget ${manifest.name} ${name} --enable" after reading it`);
    } catch (e) { entry.error = (e as Error).message; warnings.push(`widget ${name} refused: ${(e as Error).message}`); }
    out.widgets.push(entry);
  }
  for (const w of out.workspaces) if (w.error) warnings.push(`${w.path} refused: ${w.error}`);
  for (const t of out.themes) if (t.error) warnings.push(`${t.path} refused: ${t.error}`);
  if (!integrity.ok) warnings.unshift(`integrity: ${integrity.reason}${'changed' in integrity && integrity.changed?.length ? ` (changed: ${integrity.changed.join(', ')})` : ''}`);
  if (trust === 'unsigned') warnings.unshift(`not reviewed or signed (${signature.ok ? '' : signature.reason}) — its rules load DISABLED; do you trust its source?`);
  return out;
}

// ------------------------------------------------------------------ install / remove
export interface InstallResult { config: DextermConfig; dest: string; trust: PackTrust; hash: string; manifest: PackManifest; inspection: PackInspection; /** r2: the previous version's directory, deleted on an upgrade (null on a first install). */ replaced: string | null }

/**
 * Install into <home>/packs/<name>@<version>/ and record it in config.packs. Unsigned packs need an explicit
 * `acceptUnsigned` (the risk card). Widgets are registered DISABLED with no capabilities. The keymap is not merged.
 * Returns the NEW config (the caller persists it); writes only under <home>/packs.
 * r2: installing a NEW VERSION of an installed pack is an upgrade — the old `<name>@<old>` directory is deleted (only
 * under <home>/packs) once the new one is in place, stale widget registrations go, and every widget of the new version
 * starts DISABLED again (its page may have changed; consent is per reviewed page).
 */
export function installPack(home: string, dir: string, config: DextermConfig, opts: { acceptUnsigned?: boolean; now?: number; reviewedHashes?: readonly string[]; identity?: string } = {}): InstallResult {
  const insp = inspectPack(dir, { home, reviewedHashes: opts.reviewedHashes, identity: opts.identity });
  if (!insp.integrity.ok) throw new PackError(`integrity: ${insp.integrity.reason}${'changed' in insp.integrity && insp.integrity.changed?.length ? ' (' + insp.integrity.changed.join(', ') + ')' : ''}`, 'integrity');
  if (insp.trust === 'unsigned' && !opts.acceptUnsigned) throw new PackError('pack is unsigned and not reviewed; accept the risk card first (--accept-unsigned)', 'trust');
  // anything refused inside the pack blocks the install: a pack is all-or-nothing, like a keymap
  const refused = insp.warnings.filter((w) => / refused: /.test(w));
  if (refused.length) throw new PackError(`pack content refused: ${refused[0]}`, 'install');
  const dest = join(packsDir(home), `${insp.manifest.name}@${insp.manifest.version}`);
  if (existsSync(dest)) throw new PackError(`already installed: ${insp.manifest.name}@${insp.manifest.version} (remove it first)`, 'install');
  mkdirSync(packsDir(home), { recursive: true, mode: 0o700 });
  // copy exactly the locked files (never a symlink, never node_modules: listPackFiles already refused them)
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const f of [...listPackFiles(dir), PACK_LOCK, ...(existsSync(join(dir, PACK_SIG)) ? [PACK_SIG] : [])]) {
    mkdirSync(join(dest, f, '..'), { recursive: true, mode: 0o700 });
    cpSync(join(dir, f), join(dest, f), { dereference: false });
  }
  const cfg = structuredClone(config);
  const prev = (cfg.packs ?? []).find((p) => p.name === insp.manifest.name);
  cfg.packs = (cfg.packs ?? []).filter((p) => p.name !== insp.manifest.name);
  cfg.packs.push({ name: insp.manifest.name, version: insp.manifest.version, source: realpathSync(dir).slice(0, 200), hash: insp.integrity.hash, trust: insp.trust, publisher: insp.manifest.publisher, installedAt: opts.now ?? Date.now() });
  // widgets from packs are registered DISABLED with NO capabilities: consent is a later, explicit step (and an upgrade
  // starts from zero again: the registrations of the previous version — enabled or not — are dropped first)
  for (const k of Object.keys(cfg.plugins ?? {})) if (k.startsWith(`${insp.manifest.name}/`)) delete cfg.plugins![k];
  for (const w of insp.widgets) {
    if (!w.manifest) continue;
    cfg.plugins ??= {};
    cfg.plugins[packWidgetKey(insp.manifest.name, w.name)] = { enabled: false, capabilities: [], settings: {} };
  }
  // the previous version's directory goes now that the new one is complete (never anything outside <home>/packs)
  let replaced: string | null = null;
  if (prev && prev.version !== insp.manifest.version) {
    const old = join(packsDir(home), `${prev.name}@${prev.version}`);
    const root = resolve(packsDir(home));
    if (resolve(old).startsWith(root + sep) && existsSync(old)) { rmSync(old, { recursive: true, force: true }); replaced = old; }
  }
  return { config: cfg, dest, trust: insp.trust, hash: insp.integrity.hash, manifest: insp.manifest, inspection: insp, replaced };
}

/** Remove an installed pack: its directory (only under <home>/packs) and its config record + widget registrations. */
export function removePack(home: string, config: DextermConfig, name: string): { config: DextermConfig; removed: string | null } {
  const rec = (config.packs ?? []).find((p) => p.name === name);
  const cfg = structuredClone(config);
  cfg.packs = (cfg.packs ?? []).filter((p) => p.name !== name);
  for (const k of Object.keys(cfg.plugins ?? {})) if (k.startsWith(`${name}/`)) delete cfg.plugins![k];
  let removed: string | null = null;
  if (rec) {
    const dest = join(packsDir(home), `${rec.name}@${rec.version}`);
    const root = resolve(packsDir(home));
    if (resolve(dest).startsWith(root + sep) && existsSync(dest)) { rmSync(dest, { recursive: true, force: true }); removed = dest; }
  }
  return { config: cfg, removed };
}

/** Flip a pack widget's consent flag (the only way its page can ever be served). Returns the new config or throws. */
export function setWidgetEnabled(config: DextermConfig, pack: string, widget: string, enabled: boolean): DextermConfig {
  const key = packWidgetKey(pack, widget);
  if (!config.plugins?.[key]) throw new PackError(`no widget ${key} (installed packs register theirs disabled)`, 'install');
  const cfg = structuredClone(config);
  cfg.plugins![key] = { ...cfg.plugins![key], enabled };
  return cfg;
}

// ------------------------------------------------------------------ load (every config load)
export interface LoadedPackContent {
  workspaces: Array<{ pack: string; name: string; path: string; workspace: Workspace }>;
  themes: Array<{ pack: string; name: string; path: string; doc: UserTheme & { name: string } }>;
  /** Pack rules, namespaced, `enabled` only when the pack is reviewed/signed (the user may enable one on the Rules screen: that makes a user copy). */
  rules: RuleJson[];
  keymaps: Array<{ pack: string; keymap: KeymapConfig }>;
  widgets: Array<{ pack: string; name: string; dir: string; manifest: WidgetManifest; enabled: boolean }>;
  errors: string[];
  notes: string[];
}

/**
 * The content of every INSTALLED pack (a config.packs record whose directory still hashes to the recorded hash).
 * A directory under ~/.dexterm/packs without a record is ignored and noted (copying files is not an install); a
 * pack whose files changed since install is skipped and reported (re-install to accept the new hash).
 */
export function loadPacks(home: string, config: DextermConfig): LoadedPackContent {
  const out: LoadedPackContent = { workspaces: [], themes: [], rules: [], keymaps: [], widgets: [], errors: [], notes: [] };
  const records = config.packs ?? [];
  for (const rec of records) {
    const dir = join(packsDir(home), `${rec.name}@${rec.version}`);
    if (!existsSync(dir)) { out.errors.push(`pack ${rec.name}@${rec.version}: directory missing (trenchscope pack remove ${rec.name})`); continue; }
    let insp: PackInspection;
    try { insp = inspectPack(dir, { home, reviewedHashes: [] }); } catch (e) { out.errors.push(`pack ${rec.name}: ${(e as Error).message}`); continue; }
    if (!insp.integrity.ok || insp.integrity.hash !== rec.hash) { out.errors.push(`pack ${rec.name}: files changed since install (${insp.integrity.ok ? 'hash differs' : insp.integrity.reason}); skipped — re-install to accept`); continue; }
    const enabled = rec.trust === 'reviewed' || rec.trust === 'signed';
    for (const w of insp.workspaces) { if (w.workspace) out.workspaces.push({ pack: rec.name, name: packWorkspaceName(rec.name, w.workspace.name), path: join(dir, w.path), workspace: { ...w.workspace, name: packWorkspaceName(rec.name, w.workspace.name) } }); else out.errors.push(`pack ${rec.name}: ${w.path}: ${w.error}`); }
    for (const t of insp.themes) { if (t.doc) { const name = packThemeName(rec.name, t.name); out.themes.push({ pack: rec.name, name, path: join(dir, t.path), doc: { ...t.doc, name } }); } else out.errors.push(`pack ${rec.name}: ${t.path}: ${t.error}`); }
    for (const f of insp.rules) { for (const r of f.rules) out.rules.push({ ...r, enabled }); for (const e of f.errors) out.errors.push(`pack ${rec.name}: ${f.path}:${e.line}: ${e.msg}`); }
    if (insp.keymap?.keymap) out.keymaps.push({ pack: rec.name, keymap: insp.keymap.keymap });
    for (const w of insp.widgets) { if (w.manifest) out.widgets.push({ pack: rec.name, name: w.name, dir: join(dir, w.dir), manifest: w.manifest, enabled: config.plugins?.[packWidgetKey(rec.name, w.name)]?.enabled === true }); else out.errors.push(`pack ${rec.name}: widget ${w.name}: ${w.error}`); }
  }
  // rogue directories: present on disk, absent from config
  try {
    for (const d of readdirSync(packsDir(home)).sort()) {
      const m = /^([a-z][a-z0-9-]{0,39})@(\d+\.\d+\.\d+)$/.exec(d);
      if (!m) { out.notes.push(`packs/${d}: not a pack directory name; ignored`); continue; }
      if (!records.some((r) => r.name === m[1] && r.version === m[2])) out.notes.push(`packs/${d}: not installed (no config record); ignored — trenchscope pack add <dir> installs a pack`);
    }
  } catch { /* no packs dir */ }
  return out;
}

// ------------------------------------------------------------------ export (the user's own files → a pack)
/** Refuse anything that looks like a secret inside pack text: base58 private keys, Helius-style tokens, long hex, high-entropy blobs. */
export function scanForSecrets(text: string): string | null {
  const b58 = /[1-9A-HJ-NP-Za-km-z]{64,90}/.exec(text);
  if (b58) return `looks like a base58 private key (${b58[0].slice(0, 6)}…)`;
  const hlx = /\bhlx-[A-Za-z0-9_-]{8,}/.exec(text);
  if (hlx) return 'looks like a Helius token (hlx-…)';
  const hex = /\b[0-9a-f]{64}\b/.exec(text);
  if (hex && !/sha256:/.test(text.slice(Math.max(0, hex.index - 7), hex.index))) return `looks like a 32-byte hex secret (${hex[0].slice(0, 6)}…)`;
  const uuidish = /[A-Za-z0-9_-]{40,}/.exec(text);
  if (uuidish && entropy(uuidish[0]) > 4.6) return `a high-entropy token (${uuidish[0].slice(0, 6)}…)`;
  return null;
}
function entropy(s: string): number {
  const f = new Map<string, number>();
  for (const ch of s) f.set(ch, (f.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

export interface ExportSpec {
  name: string; version?: string; publisher: string; description?: string;
  workspaces?: Workspace[]; themes?: Array<UserTheme & { name: string }>; rules?: RuleJson[]; keymap?: KeymapConfig;
}

/** Write a pack directory from the user's own objects (+ pack.lock). Refuses secrets and bad names. Returns the lock. */
export function exportPack(outDir: string, spec: ExportSpec): PackLock {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(spec.name)) throw new PackError('pack name: lowercase letters, digits, dashes', 'manifest');
  const version = spec.version ?? '1.0.0';
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new PackError('version: x.y.z', 'manifest');
  if (existsSync(outDir) && readdirSync(outDir).length) throw new PackError(`${outDir} is not empty`, 'io');
  const manifest: PackManifest = { name: spec.name, version, publisher: spec.publisher, ...(spec.description ? { description: spec.description.slice(0, 300) } : {}), requires: { dexterm: '>=0.1.0', api: 1 }, contents: {} };
  const files: Array<[string, string]> = [];
  for (const ws of spec.workspaces ?? []) {
    const base = ws.name.includes('/') ? ws.name.split('/')[1] : ws.name;
    files.push([`workspaces/${base}.json`, JSON.stringify({ ...ws, name: base }, null, 2) + '\n']);
    (manifest.contents.workspaces ??= []).push(`workspaces/${base}.json`);
  }
  for (const t of spec.themes ?? []) {
    const { name, ...body } = t;
    files.push([`themes/${name}.json`, JSON.stringify(body, null, 2) + '\n']);
    (manifest.contents.themes ??= []).push(`themes/${name}.json`);
  }
  if (spec.rules?.length) {
    const lines = ['# rules exported by trenchscope — one per line; parsed by the rules grammar, never eval\'d', ...spec.rules.map((r) => ruleTextOf(r))];
    files.push(['rules/rules.rules', lines.join('\n') + '\n']);
    manifest.contents.rules = ['rules/rules.rules'];
  }
  if (spec.keymap && (Object.keys(spec.keymap.global ?? {}).length || Object.keys(spec.keymap.screens ?? {}).length)) {
    files.push(['keymap.json', JSON.stringify(spec.keymap, null, 2) + '\n']);
    manifest.contents.keymap = 'keymap.json';
  }
  const errors = validate('packManifest', manifest);
  if (errors.length) throw new PackError(`manifest: ${errors[0].path || '/'} ${errors[0].msg}`, 'manifest');
  files.unshift([PACK_MANIFEST, JSON.stringify(manifest, null, 2) + '\n']);
  for (const [p, text] of files) { const s = scanForSecrets(text); if (s) throw new PackError(`refused to export ${p}: ${s}`, 'secret'); }
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  for (const [p, text] of files) { mkdirSync(join(outDir, p, '..'), { recursive: true }); writeFileSync(join(outDir, p), text, { mode: 0o600 }); }
  return writeLock(outDir);
}
/** One exported rule line, named so the importer gets a stable id; re-parsed so the line is exactly what an importer will parse. */
function ruleTextOf(r: RuleJson): string {
  const name = r.name && !r.name.startsWith('when ') ? r.name : r.id;
  const line = ruleToText({ ...r, name });
  ruleToJson(line); // throws if the export would not round-trip through the grammar
  return line;
}
