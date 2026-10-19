// Managed Piper runtime for macOS (task-1416). The prebuilt macOS Piper tarball from rhasspy is BROKEN
// (it needs a libespeak-ng dylib it does not bundle), so on macOS trenchscope builds its own private Python
// runtime instead: a virtualenv at `~/.dexterm/piper/venv` with `pip install piper-tts`, plus the
// checksum-verified en_GB-alan-medium voice model. After setup the voice runs fully OFFLINE, needs no
// key, and is driven by `<venv>/bin/python -m piper` (see piper.ts resolvePiperRuntime).
//
// Everything that touches the system (running python/pip, the network) is INJECTED, so this module is
// unit-testable with fakes and never spawns or downloads in tests. `trenchscope voice setup` wires the real
// child_process + global fetch (see packages/cli/src/voice-cmd.ts).
//
// Hosts contacted, ONLY while the user runs setup (documented on the site trust page):
//   - https://pypi.org + https://files.pythonhosted.org  (pip resolves + downloads the piper-tts wheel and its deps)
//   - https://huggingface.co                             (the voice model, via the existing checksum-verified downloader)

import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadModel, modelRegistry, modelStatus, type DownloadResult, type DownloadDeps, type ModelSpec } from '../download.ts';

/** Pinned piper-tts version (verified working on macOS/Python 3.9 in task-1416). */
export const PIPER_PYPI_VERSION = '1.8.0';
/** The minimum Python the managed runtime needs (piper-tts wheels + onnxruntime). */
export const MIN_PYTHON = [3, 9] as const;

/** Paths inside the managed runtime, derived from the trenchscope home. */
export function piperRuntimePaths(home: string): { dir: string; venv: string; python: string; pip: string; record: string } {
  const dir = join(home, 'piper');
  const venv = join(dir, 'venv');
  const binDir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const exe = process.platform === 'win32' ? '.exe' : '';
  return {
    dir,
    venv,
    python: join(venv, binDir, `python${exe}`),
    pip: join(venv, binDir, `pip${exe}`),
    record: join(dir, 'runtime.json'),
  };
}

/** What `runtime.json` records so status/uninstall know what was installed (never a secret). */
export interface PiperRuntimeRecord {
  kind: 'venv';
  piperTts: string;
  python: string;
  pythonVersion: string;
  model: string;
  platform: string;
  installedAt: string;
}

/** Result of a `run()` — mirrors child_process.spawnSync output (injected in tests). */
export interface RunResult { code: number | null; stdout: string; stderr: string }

export interface SetupDeps {
  home: string;
  /** Run a command and resolve its exit code + output. Injected so tests never spawn. */
  run(cmd: string, args: string[]): Promise<RunResult>;
  /** Ask the user once, before anything is built/downloaded. Returns true to proceed. */
  confirm(promptText: string): Promise<boolean>;
  /** Status / progress lines. */
  log?(s: string): void;
  /** fetch for the model download (defaults to global fetch; injected in tests). */
  fetchImpl?: typeof fetch;
  /** Candidate python executables to probe, best-first (injected in tests; the CLI picks sensible defaults). */
  pythonCandidates?: string[];
  /** The model-download step (injected in tests so the 63 MB fetch never runs); defaults to downloadModel. */
  downloadModelImpl?: (spec: ModelSpec, deps: DownloadDeps) => Promise<DownloadResult>;
  /** Clock (injected in tests). */
  now?(): number;
}

export type SetupStatus = 'ok' | 'already' | 'cancelled' | 'no-python' | 'failed';

export interface SetupResult {
  status: SetupStatus;
  /** A copy-pasteable fix line when status is 'no-python' or 'failed'. */
  fix?: string;
  /** The resolved python (when found). */
  python?: string;
  pythonVersion?: string;
  /** The model files on disk after setup (when ok/already). */
  model?: string[];
}

/** Parse "Python 3.11.7" → [3, 11, 7]; null when it does not look like a version. */
export function parsePythonVersion(s: string): number[] | null {
  const m = s.match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/** True when a parsed version is at least MIN_PYTHON. */
export function pythonVersionOk(v: number[] | null): boolean {
  if (!v) return false;
  if (v[0] !== MIN_PYTHON[0]) return v[0] > MIN_PYTHON[0];
  return v[1] >= MIN_PYTHON[1];
}

/** The exact fix line shown when no suitable python3 is found (platform-specific). */
export function pythonFixLine(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') {
    return 'Install Python 3.9+ : `brew install python@3.12` (Homebrew) or the Xcode Command Line Tools (`xcode-select --install`), then re-run `trenchscope voice setup`.';
  }
  if (platform === 'win32') {
    return 'Install Python 3.9+ from python.org (or `winget install Python.Python.3.12`), then re-run `trenchscope voice setup`.';
  }
  return 'Install Python 3.9+ and venv: `sudo apt install python3 python3-venv` (Debian/Ubuntu), then re-run `trenchscope voice setup`.';
}

/** The default python executables to probe, best-first. The CLI passes this (and may prepend DEXTERM_PYTHON). */
export const DEFAULT_PYTHON_CANDIDATES: readonly string[] = [
  'python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3.9', 'python3', 'python',
];

/** Find the first candidate whose `--version` is >= 3.9. Returns the executable + parsed version, or null. */
export async function detectPython(deps: Pick<SetupDeps, 'run' | 'pythonCandidates'>): Promise<{ python: string; version: number[] } | null> {
  const seen = new Set<string>();
  for (const cand of deps.pythonCandidates ?? DEFAULT_PYTHON_CANDIDATES) {
    if (!cand || seen.has(cand)) continue;
    seen.add(cand);
    let res: RunResult;
    try { res = await deps.run(cand, ['--version']); } catch { continue; }
    const v = parsePythonVersion(`${res.stdout} ${res.stderr}`.trim());
    if (res.code === 0 && pythonVersionOk(v)) return { python: cand, version: v! };
  }
  return null;
}

/** Read the managed-runtime record, or null when it is absent/invalid. */
export function readRuntimeRecord(home: string): PiperRuntimeRecord | null {
  const { record } = piperRuntimePaths(home);
  try { return JSON.parse(readFileSync(record, 'utf8')) as PiperRuntimeRecord; } catch { return null; }
}

export interface RuntimeStatus {
  installed: boolean;
  python: string;
  pythonPresent: boolean;
  modelInstalled: boolean;
  record: PiperRuntimeRecord | null;
}

/** Inspect the managed runtime WITHOUT touching python or the network (for `voice status` / the doctor). */
export async function piperRuntimeStatus(home: string): Promise<RuntimeStatus> {
  const paths = piperRuntimePaths(home);
  const model = await modelStatus(modelRegistry(home)['piper-voice']);
  return {
    installed: existsSync(paths.python) && model.installed,
    python: paths.python,
    pythonPresent: existsSync(paths.python),
    modelInstalled: model.installed,
    record: readRuntimeRecord(home),
  };
}

/**
 * Build the managed Piper runtime: detect python3 → confirm once → create the venv → `pip install
 * piper-tts` (pinned, wheels only) → download + verify the voice model → write the record. Idempotent:
 * returns 'already' without prompting when the venv python, piper-tts, and the model are all present.
 * Any failure is reported (never thrown) with a copy-pasteable fix.
 */
export async function setupPiperRuntime(deps: SetupDeps): Promise<SetupResult> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const paths = piperRuntimePaths(deps.home);
  const piperVoice = modelRegistry(deps.home)['piper-voice'];

  // Already fully installed? Verify piper-tts imports too, so a half-built venv is repaired.
  if (existsSync(paths.python) && (await modelStatus(piperVoice)).installed) {
    const check = await deps.run(paths.python, ['-c', 'import piper']);
    if (check.code === 0) {
      log('Piper runtime is already installed and verified.');
      return { status: 'already', python: paths.python, model: piperVoice.files.map((f) => f.dest) };
    }
  }

  const found = await detectPython(deps);
  if (!found) return { status: 'no-python', fix: pythonFixLine() };
  const versionStr = found.version.join('.');

  const prompt = [
    'Set up the neural voice (Piper en_GB-alan-medium). This will, only now:',
    `  • create a private Python environment at ${paths.venv}`,
    `  • pip install piper-tts==${PIPER_PYPI_VERSION} (wheels only) from pypi.org / files.pythonhosted.org`,
    `  • download the ~61 MB voice model from huggingface.co (checksum-verified)`,
    'It runs fully offline afterwards, needs no key, and `trenchscope voice uninstall` removes it. Proceed?',
  ].join('\n');
  if (!(await deps.confirm(prompt))) {
    log('Cancelled — nothing installed.');
    return { status: 'cancelled' };
  }

  // 1. venv
  try { mkdirSync(paths.dir, { recursive: true }); } catch { /* reported by the venv step if it matters */ }
  if (!existsSync(paths.python)) {
    log(`  • creating the Python environment (${found.python} ${versionStr})…`);
    const venv = await deps.run(found.python, ['-m', 'venv', paths.venv]);
    if (venv.code !== 0 || !existsSync(paths.python)) {
      return { status: 'failed', python: found.python, pythonVersion: versionStr,
        fix: `Creating the venv failed: ${(venv.stderr || venv.stdout).slice(-300).trim() || 'unknown error'}. On Debian/Ubuntu install \`python3-venv\` and re-run \`trenchscope voice setup\`.` };
    }
  }

  // 2. pip install piper-tts (pinned, wheels only so there is never a source build / compiler requirement)
  log(`  • installing piper-tts==${PIPER_PYPI_VERSION} (this downloads a few wheels)…`);
  const pip = await deps.run(paths.python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary', ':all:', `piper-tts==${PIPER_PYPI_VERSION}`]);
  if (pip.code !== 0) {
    return { status: 'failed', python: found.python, pythonVersion: versionStr,
      fix: `pip install failed: ${(pip.stderr || pip.stdout).slice(-300).trim() || 'unknown error'}. Check your network and that a wheel exists for this Python, then re-run \`trenchscope voice setup\`.` };
  }
  const imp = await deps.run(paths.python, ['-c', 'import piper']);
  if (imp.code !== 0) {
    return { status: 'failed', python: found.python, pythonVersion: versionStr,
      fix: `piper-tts installed but does not import: ${(imp.stderr || imp.stdout).slice(-300).trim() || 'unknown error'}.` };
  }

  // 3. model (reuse the checksum-verified downloader; setup already confirmed, so do not prompt again)
  let dl: DownloadResult;
  try {
    const download = deps.downloadModelImpl ?? downloadModel;
    dl = await download(piperVoice, { confirm: () => Promise.resolve(true), log, fetchImpl: deps.fetchImpl });
  } catch (e) {
    return { status: 'failed', python: found.python, pythonVersion: versionStr,
      fix: `Voice model download failed: ${(e as Error).message}. Re-run \`trenchscope voice setup\` (it resumes) once your network is back.` };
  }

  // 4. record
  const record: PiperRuntimeRecord = {
    kind: 'venv',
    piperTts: PIPER_PYPI_VERSION,
    python: paths.python,
    pythonVersion: versionStr,
    model: piperVoice.files[0].dest,
    platform: process.platform,
    installedAt: new Date(now()).toISOString(),
  };
  try { writeFileSync(paths.record, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 }); } catch { /* non-fatal */ }

  log('Neural voice ready. It is now the default speaking voice (fallback: the system voice).');
  return { status: 'ok', python: found.python, pythonVersion: versionStr, model: dl.files };
}

export interface UninstallResult { status: 'ok' | 'absent'; removed: string[] }

/**
 * Remove the managed Piper runtime (the venv + its record). The downloaded voice model is LEFT in place
 * by default because it is shared with `trenchscope voice download piper-voice` and the Linux binary path;
 * pass `purgeModel` to delete it too.
 */
export async function uninstallPiperRuntime(home: string, opts: { purgeModel?: boolean } = {}): Promise<UninstallResult> {
  const paths = piperRuntimePaths(home);
  const removed: string[] = [];
  let found = false;
  for (const p of [paths.venv, paths.record]) {
    if (existsSync(p)) { found = true; try { rmSync(p, { recursive: true, force: true }); removed.push(p); } catch { /* ignore */ } }
  }
  if (opts.purgeModel) {
    for (const f of modelRegistry(home)['piper-voice'].files) {
      if (existsSync(f.dest)) { found = true; try { rmSync(f.dest, { force: true }); removed.push(f.dest); } catch { /* ignore */ } }
    }
  }
  // Remove the now-empty piper dir if nothing else lives in it.
  try { rmSync(paths.dir, { recursive: false }); } catch { /* not empty / absent — fine */ }
  return { status: found ? 'ok' : 'absent', removed };
}
