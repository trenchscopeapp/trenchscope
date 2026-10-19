// trenchscope doctor (task-1305): a pre-flight the user runs before anything else. It answers one
// question — "will trenchscope work on this machine, and if not, exactly what do I fix?" — as a plain
// pass/warn/fail list with a copy-pasteable fix on every line that is not a pass.
//
// Everything that touches the outside world (the claude binary, the network) is injected so the
// checks stay deterministic in tests and never hang: each probe carries its own timeout and any
// failure is turned into a `fail`/`warn` line, never an exception. The doctor NEVER prints the
// Helius key or any URL that could carry it — it reports the provider name only.
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { shellBinaryPath } from '@dexterm/popup';
import { detectColorDepth, type ColorDepth, protocolFromEnv } from '@dexterm/tui';
import { resolveRpcUrl, resolveTrackerKey, TRACKER_KEY_FILE, resolveShrineKey, SHRINE_KEY_FILE, defaultDbPath } from '@dexterm/data';
import { XTokenStore } from '@dexterm/data';
import { SayTts, voiceDoctor, resolveVoice, WHISPER_MODEL, resolvePiperRuntime, pickPlayer, PIPER_MODEL, type VoiceDoctorDeps } from '@dexterm/voice';
import type { MergedSet } from '@dexterm/mcp';
import { loadConfig, dextermHome } from '@dexterm/custom';
import { kbStore, skillStore } from './kb-skill-cmd.ts';
import { readBotSummary, type PaperBotSummary } from './bot/store.ts';
import { analystCliOnPath, CODEX_MIN_VERSION, parseEngineChoice, resolveEngine, versionAtLeast } from './analyst/codex.ts';

/** The minimum Node that runs trenchscope (type-stripping of the .ts entry needs 22.18). */
export const MIN_NODE = [22, 18, 0] as const;

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  /** Short label, e.g. "Node", "Terminal colour", "Claude CLI". */
  name: string;
  status: CheckStatus;
  /** What the doctor found (safe to print; never a secret). */
  detail: string;
  /** Exactly what to run / do to turn this green. Omitted on a pass. */
  fix?: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  /** No failing check (warnings are allowed): the app will run. */
  ok: boolean;
}

/** One network probe outcome. `reachable` means the host answered at all (even a 4xx/5xx); only a
 *  network error or a timeout is unreachable. */
export interface ProbeResult {
  reachable: boolean;
  status?: number;
  ms?: number;
  error?: string;
}

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  /** Running Node version "x.y.z" (default process.versions.node). */
  nodeVersion: string;
  platform: NodeJS.Platform;
  /** Resolve the claude CLI: 'ok' logged-in, 'present' on PATH but login unconfirmed, 'missing'. */
  claude: () => Promise<'ok' | 'present' | 'missing'>;
  /** 0.1.5: the codex CLI, the optional second analyst engine. Absent = the check is skipped. */
  codex?: () => Promise<CodexProbe>;
  /** 0.1.5: the user's analyst-engine choice (env / config), for the engine line. Absent = auto. */
  analystEngine?: string | null;
  /** Probe one URL; must resolve (never reject) within its own timeout. */
  probe: (url: string) => Promise<ProbeResult>;
  /** Check a directory is writable by creating and deleting a temp file; returns null or an error message. */
  checkWritable: (dir: string) => string | null;
  /** Skip the network probes (DEXTERM_OFFLINE, or `--offline`). */
  offline: boolean;
  /** task-1325: the native chart window (wry shell). Absent = the check is skipped. */
  popupShell?: () => { path: string; built: boolean; cargo: boolean };
  /** Gather the voice-mode facts (task-1282). Omitted in tests that do not exercise the voice section. */
  voiceProbe?: () => Promise<VoiceDoctorDeps>;
  /** task-1377: the merged KB + skill sets (bundled / user / overridden / skipped). Absent = the check is skipped. */
  content?: () => { kb: MergedSet; skills: MergedSet };
  /** The paper bot ledger summary (`trenchscope bot`), or null when it never ran. Absent = the check is skipped. */
  paperBot?: () => PaperBotSummary | null;
}

/** Cheap PATH lookup (no spawn). Windows (task-1423): PATH is `;`-separated and commands carry an extension
 *  (`claude.cmd` from npm, `claude.exe` from the native installer), so try the PATHEXT list there. */
export function onPath(bin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const win = platform === 'win32';
  // Windows file names are case-insensitive; lower-case keeps the lookup exact on the case-sensitive test hosts
  const exts = win ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean)] : [''];
  for (const p of (env.PATH ?? env.Path ?? '').split(win ? ';' : ':')) {
    if (!p) continue;
    for (const ext of exts) if (existsSync(join(p, bin + ext))) return true;
  }
  return false;
}

/**
 * Default voice probe. Deliberately cheap and non-blocking: it never compiles the Swift helper (that
 * is left to the first real `v` press), so resolvedStt is inferred from swiftc / whisper presence.
 */
export async function defaultVoiceProbe(platform: NodeJS.Platform = process.platform, configuredVoice?: string | null): Promise<VoiceDoctorDeps> {
  const say = new SayTts();
  const sayAvailable = platform === 'darwin' ? await say.available() : false;
  const voices = sayAvailable ? await say.listVoicesDetailed() : [];
  const swiftcPresent = platform === 'darwin' && onPath('swiftc');
  const whisperBinPresent = onPath('whisper-cli');
  const whisperModelPresent = existsSync(WHISPER_MODEL);
  const micToolPresent = onPath('sox') || onPath('rec') || onPath('ffmpeg') || onPath('arecord');
  // Apple Speech is macOS-only; everywhere else whisper.cpp is the default voice-in (task-1393 Part 2).
  const resolvedStt = swiftcPresent ? 'apple' : (whisperBinPresent && whisperModelPresent && micToolPresent) ? 'whisper' : null;
  // espeak-ng is the baseline portable speech-out engine off macOS.
  const espeakPresent = platform !== 'darwin' && (onPath('espeak-ng') || onPath('espeak'));
  // Piper is the preferred neural speech-out engine EVERYWHERE (task-1408, task-1416): a runtime (the
  // prebuilt binary off macOS, the managed venv on macOS) + the voice model + a player (afplay on macOS).
  const piperPresent = resolvePiperRuntime() !== null;
  const piperVoicePresent = existsSync(PIPER_MODEL);
  const playerName = pickPlayer();
  // task-1393: show which voice will actually speak, and why — never a silent system/novelty voice.
  const r = sayAvailable ? resolveVoice({ configured: configuredVoice, installed: voices }) : { voice: null, reason: '' };
  return {
    platform, sayAvailable, voiceCount: voices.length, swiftcPresent, whisperBinPresent, whisperModelPresent, micToolPresent, resolvedStt,
    espeakPresent, piperPresent, piperVoicePresent, playerName,
    resolvedVoice: sayAvailable ? r.voice : undefined, resolvedVoiceReason: r.reason,
  };
}

/** The keyless data sources the live app depends on, with a cheap reachability URL for each. */
export const DATA_SOURCES: ReadonlyArray<{ name: string; url: string; soft?: boolean }> = [
  { name: 'DexScreener', url: 'https://api.dexscreener.com/latest/dex/search?q=SOL' },
  { name: 'Jupiter', url: 'https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112' },
  { name: 'GeckoTerminal', url: 'https://api.geckoterminal.com/api/v2/networks' },
  { name: 'RugCheck', url: 'https://api.rugcheck.xyz/v1/stats/new_tokens' },
  { name: 'GoPlus', url: 'https://api.gopluslabs.io/api/v1/supported_chains' },
  { name: 'Solana RPC', url: 'https://api.mainnet-beta.solana.com' },
  // PumpPortal is a websocket; a plain GET to the host proves the network path (new pairs is a soft dep).
  { name: 'PumpPortal', url: 'https://pumpportal.fun/', soft: true },
];

function parseVersion(v: string): [number, number, number] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compare two semver triples: -1 / 0 / 1. */
export function cmpVersion(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}

/** Default live probe: a GET with a hard timeout. Any HTTP answer = reachable; only transport errors fail. */
export async function livingProbe(url: string, timeoutMs = 4000): Promise<ProbeResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', signal: ctl.signal, headers: { 'user-agent': 'dexterm-doctor' } });
    // Drain a little so sockets close cleanly; we do not care about the body.
    try { await res.arrayBuffer(); } catch { /* ignore */ }
    return { reachable: true, status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    const err = (e as Error).name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (e as Error).message;
    return { reachable: false, error: err, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Default claude probe: spawn `claude --version` with a timeout. Presence only (login is not asserted here). */
export async function claudeProbe(timeoutMs = 4000, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<'ok' | 'present' | 'missing'> {
  // Windows (task-1423): answer from PATH without a spawn, and count only what the analyst's shell-less spawn can
  // start: `claude.exe` / `.com` (the native installer). An npm `claude.cmd` alone is 'missing', because the
  // analyst cannot run it, so "found on PATH" would be a false pass.
  if (platform === 'win32') return onPath('claude', { ...env, PATHEXT: '.EXE;.COM' }, platform) ? 'present' : 'missing';
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: 'ok' | 'present' | 'missing') => { if (!done) { done = true; resolve(r); } };
    try {
      const child = execFile('claude', ['--version'], { timeout: timeoutMs }, (err) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') finish('missing');
        else if (err) finish('present'); // on PATH but the probe errored/timed out: do not block on it
        else finish('present');
      });
      child.on('error', () => finish('missing'));
    } catch { finish('missing'); }
  });
}

/** What doctor learned about the codex CLI. `loggedIn` null = the status probe could not tell. */
export type CodexProbe = { state: 'missing' } | { state: 'present'; version: string | null; loggedIn: boolean | null };

/**
 * Default codex probe (0.1.5): PATH (spawnable form only), then `codex --version` and `codex login status`. The
 * status command is the user's own CLI reporting on its own login; trenchscope never reads the credential itself.
 */
export async function codexProbe(timeoutMs = 4000, env: NodeJS.ProcessEnv = process.env): Promise<CodexProbe> {
  if (!analystCliOnPath('codex', env)) return { state: 'missing' };
  const { execFile } = await import('node:child_process');
  const run = (args: string[]): Promise<{ code: number | null; out: string }> => new Promise((resolve) => {
    try {
      const child = execFile('codex', args, { timeout: timeoutMs, env }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
        resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}` });
      });
      child.on('error', () => resolve({ code: null, out: '' }));
    } catch { resolve({ code: null, out: '' }); }
  });
  const v = await run(['--version']);
  const version = /(\d+\.\d+\.\d+[\w.-]*)/.exec(v.out)?.[1] ?? null;
  const st = await run(['login', 'status']);
  const loggedIn = st.code === 0 ? !/not logged in/i.test(st.out) : st.code === null ? null : false;
  return { state: 'present', version, loggedIn };
}

/** Default writable check: create the directory, write and remove a temp file. Returns an error message or null. */
export function writableProbe(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = mkdtempSync(join(dir, '.dexterm-doctor-'));
    const f = join(tmp, 'probe');
    writeFileSync(f, 'ok');
    rmSync(tmp, { recursive: true, force: true });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env, isTTY = process.stdout.isTTY === true): DoctorDeps {
  return {
    env,
    isTTY,
    nodeVersion: process.versions.node,
    platform: process.platform,
    claude: () => claudeProbe(),
    codex: () => codexProbe(4000, env),
    analystEngine: env.DEXTERM_ANALYST_ENGINE ?? loadConfig(dextermHome(env)).config.analyst?.engine ?? null,
    probe: (url) => livingProbe(url),
    checkWritable: writableProbe,
    offline: env.DEXTERM_OFFLINE === '1' || env.DEXTERM_OFFLINE === 'true',
    popupShell: () => {
      const path = shellBinaryPath(env);
      const cargo = spawnSync('cargo', ['--version'], { stdio: 'ignore', timeout: 3000 }).status === 0;
      return { path, built: existsSync(path), cargo };
    },
    voiceProbe: () => defaultVoiceProbe(process.platform, loadConfig(dextermHome(env)).config.voice?.name ?? null),
    content: () => ({ kb: kbStore(env).get(), skills: skillStore(env).get() }),
    paperBot: () => readBotSummary(defaultDbPath(env)),
  };
}

/** Run every check. Never throws; network and claude probes are the injected ones. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  // 1. Node version
  const node = parseVersion(deps.nodeVersion);
  if (cmpVersion(node, MIN_NODE) >= 0) {
    checks.push({ name: 'Node', status: 'pass', detail: `v${deps.nodeVersion} (need ${MIN_NODE.join('.')}+)` });
  } else {
    checks.push({
      name: 'Node', status: 'fail',
      detail: `v${deps.nodeVersion} is too old (need ${MIN_NODE.join('.')}+ for the TypeScript entry)`,
      fix: 'Install Node 22.18+ : `nvm install 22` (nvm) or `brew install node` (Homebrew), then re-run.',
    });
  }

  // 2. Terminal colour
  const depth = detectColorDepth(deps.env as never, deps.isTTY);
  const term = deps.env.TERM_PROGRAM || deps.env.TERM || 'unknown';
  if (!deps.isTTY) {
    checks.push({
      name: 'Terminal', status: 'warn',
      detail: 'not a TTY (output is being piped); the interactive UI needs a real terminal',
      fix: 'Run trenchscope directly in a terminal window, not through a pipe or a non-interactive shell.',
    });
  } else if (depth === 'truecolor') {
    checks.push({ name: 'Terminal colour', status: 'pass', detail: `24-bit truecolor (${term})` });
  } else if (depth === '256') {
    checks.push({
      name: 'Terminal colour', status: 'warn',
      detail: `256-colour only (${term}); trenchscope runs but the neon look is flattened`,
      fix: 'Use a truecolor terminal (iTerm2, WezTerm, Ghostty, Kitty, Alacritty, Windows Terminal) or set COLORTERM=truecolor.',
    });
  } else {
    checks.push({
      name: 'Terminal colour', status: 'warn',
      detail: `no colour (${term}${deps.env.NO_COLOR ? ', NO_COLOR set' : ''}); trenchscope falls back to monochrome`,
      fix: 'Unset NO_COLOR and use a colour terminal for the full look; trenchscope still works without it.',
    });
  }

  // 2b. Coin images (task-1326): the protocol this terminal gets, judged from the environment alone (the
  // interactive run also asks the tty). Apple Terminal.app is the one known no-images terminal → warn + fix.
  {
    const p = protocolFromEnv(deps.env as never);
    const label = p.protocol === 'kitty' ? 'real pixels (kitty graphics)' : p.protocol === 'iterm' ? 'real pixels (iTerm2 inline images)' : p.protocol === 'sixel' ? 'real pixels (sixel)' : 'half-block art';
    if (p.protocol === 'blocks' && /apple terminal/i.test(p.reason)) {
      checks.push({ name: 'Coin images', status: 'warn', detail: `${label}: ${p.reason}`, fix: 'For real coin pictures use Ghostty (`brew install --cask ghostty`) or iTerm2 (`brew install --cask iterm2`); the block-art fallback still shows every coin here.' });
    } else {
      checks.push({ name: 'Coin images', status: 'pass', detail: `${label} (${p.reason})${p.protocol === 'blocks' ? '; --no-images turns them off' : ''}` });
    }
  }

  // 3. Claude CLI (the analyst). Not required to browse; required for the `a` analyst.
  const claude = await deps.claude();
  // 0.1.5: codex is the optional second engine; a missing claude is fine when codex can run the analyst.
  const codex = deps.codex ? await deps.codex() : null;
  const codexUsable = codex?.state === 'present';
  if (claude === 'missing' && codexUsable) {
    checks.push({
      name: 'Claude CLI', status: 'pass',
      detail: 'not found on PATH (optional now): the analyst runs on your codex CLI instead',
    });
  } else if (claude === 'missing') {
    checks.push({
      name: 'Claude CLI', status: 'warn',
      detail: 'not found on PATH; the analyst (a) is disabled, the rest of trenchscope works',
      fix: 'Install Claude Code (https://claude.com/claude-code) and run `claude` once to log in, or use Codex: `npm i -g @openai/codex && codex login`.',
    });
  } else {
    checks.push({
      name: 'Claude CLI', status: 'pass',
      detail: 'found on PATH (the analyst runs your local `claude`; log in once with `claude` if the analyst errors)',
    });
  }

  // 3b. Codex CLI (0.1.5): optional second analyst engine, the user's own codex login. Read-only lock needs >= CODEX_MIN_VERSION.
  if (codex) {
    const choice = parseEngineChoice(deps.analystEngine) ?? 'auto';
    const engine = resolveEngine(choice, (b) => b === 'claude' ? claude !== 'missing' : codexUsable);
    const eng = `analyst engine: ${engine}${choice === 'auto' ? ' (auto)' : ''}`;
    if (codex.state === 'missing') {
      checks.push({ name: 'Codex CLI', status: engine === 'codex' ? 'warn' : 'pass', detail: `not installed (optional second analyst engine) · ${eng}`, ...(engine === 'codex' ? { fix: 'npm i -g @openai/codex && codex login, or set analyst.engine to claude' } : {}) });
    } else if (codex.version && !versionAtLeast(codex.version, CODEX_MIN_VERSION)) {
      checks.push({ name: 'Codex CLI', status: 'warn', detail: `codex-cli ${codex.version} is older than ${CODEX_MIN_VERSION}; the read-only analyst lock needs ${CODEX_MIN_VERSION}+ · ${eng}`, fix: 'npm i -g @openai/codex@latest' });
    } else if (codex.loggedIn === false) {
      checks.push({ name: 'Codex CLI', status: 'warn', detail: `found${codex.version ? ` (codex-cli ${codex.version})` : ''}, not logged in · ${eng}`, fix: 'codex login' });
    } else {
      checks.push({ name: 'Codex CLI', status: 'pass', detail: `found${codex.version ? ` (codex-cli ${codex.version})` : ''}${codex.loggedIn ? ', logged in' : ''}; runs the analyst read-only on your own codex login (/engine codex) · ${eng}` });
    }
  }

  // 4b. Login with X (optional, task-1357): the user's own X app + login unlock X posts in the SOCIAL panel / TRENDING.
  {
    const xs = new XTokenStore({ env: deps.env });
    const meta = xs.meta();
    const modes = xs.modes();
    const clientId = xs.clientId(deps.env);
    if (meta.loggedIn) {
      const windows = deps.platform === 'win32';
      const loose = (modes.tokens !== null && modes.tokens !== 0o600) || (modes.dir !== null && modes.dir !== 0o700);
      const warning = windows ? ' · Windows ACL isolation is not verified' : loose ? ' · token file permissions are looser than 0600' : '';
      checks.push({ name: 'Login with X', status: windows || loose ? 'warn' : 'pass', detail: `logged in${meta.user ? ` as @${meta.user.username}` : ''} · scopes ${meta.scopes.join(' ') || '?'} · refresh ${meta.hasRefresh ? 'yes' : 'no'}${warning}`, ...(windows ? { fix: 'Review the token directory Security permissions in Windows; chmod does not enforce owner-only ACLs.' } : loose ? { fix: `chmod 700 ${xs.dir} && chmod 600 ${xs.tokensPath}` } : {}) });
    } else if (clientId) {
      checks.push({ name: 'Login with X', status: 'warn', detail: 'client id stored, not logged in — X posts stay off (keyless venues, news and on-chain rows still work)', fix: 'trenchscope x login' });
    } else {
      checks.push({ name: 'Login with X', status: 'pass', detail: 'not set up (optional) — X posts need your own X app: free Native App + `trenchscope x set-client-id` + `trenchscope x login`; see docs › Login with X' });
    }
  }

  // 4. Helius key (optional; the app is live and keyless without it, just with fewer holders/safety fields).
  const rpc = resolveRpcUrl({ env: deps.env, home: deps.env.HOME || undefined });
  if (rpc.provider === 'helius') {
    checks.push({ name: 'Helius RPC', status: 'pass', detail: `key configured (${rpc.basis}) — holders & safety enriched` });
  } else if (rpc.provider === 'custom') {
    checks.push({ name: 'RPC', status: 'pass', detail: 'custom endpoint via DEXTERM_RPC_URL' });
  } else {
    checks.push({
      name: 'Helius RPC', status: 'warn',
      detail: 'no key — trenchscope uses the public RPC (holders & some safety fields will show as "needs key")',
      fix: 'Free tier: make a key at https://dashboard.helius.dev, then `mkdir -p ~/.dexterm && printf %s "YOUR_KEY" > ~/.dexterm/helius.key && chmod 600 ~/.dexterm/helius.key`',
    });
  }

  // 4b. Solana Tracker key (optional): dev %, snipers, insiders, bundlers, LP burn and a rugged flag per token.
  const tracker = resolveTrackerKey({ env: deps.env, home: deps.env.HOME || undefined });
  const trackerFile = join(deps.env.HOME || homedir(), TRACKER_KEY_FILE);
  let trackerOpen = false; // readable by group/other on a POSIX system
  if (tracker && tracker.basis !== 'env DEXTERM_SOLANATRACKER_KEY' && process.platform !== 'win32') {
    try { trackerOpen = (statSync(trackerFile).mode & 0o077) !== 0; } catch { trackerOpen = false; }
  }
  if (tracker && trackerOpen) {
    checks.push({ name: 'Solana Tracker', status: 'warn', detail: 'key configured but the key file is readable by other users', fix: 'chmod 600 ~/.dexterm/solanatracker.key' });
  } else if (tracker) {
    checks.push({ name: 'Solana Tracker', status: 'pass', detail: `key configured (${tracker.basis}) — snipers, insiders, bundlers & dev % enriched` });
  } else {
    checks.push({ name: 'Solana Tracker', status: 'pass', detail: 'not set up (optional) — adds snipers, insiders, bundled % and dev %: save a key from solanatracker.io/data-api alone in ~/.dexterm/solanatracker.key' });
  }

  // 4c. Shrine key (optional): 1-second candles by mint for the token chart (GeckoTerminal stays the fallback).
  const shrine = resolveShrineKey({ env: deps.env, home: deps.env.HOME || undefined });
  const shrineFile = join(deps.env.HOME || homedir(), SHRINE_KEY_FILE);
  let shrineOpen = false; // readable by group/other on a POSIX system
  if (shrine && shrine.basis !== 'env DEXTERM_SHRINE_KEY' && process.platform !== 'win32') {
    try { shrineOpen = (statSync(shrineFile).mode & 0o077) !== 0; } catch { shrineOpen = false; }
  }
  if (shrine && shrineOpen) {
    checks.push({ name: 'Shrine', status: 'warn', detail: 'key configured but the key file is readable by other users', fix: 'chmod 600 ~/.dexterm/shrine.key' });
  } else if (shrine) {
    checks.push({ name: 'Shrine', status: 'pass', detail: `key configured (${shrine.basis}): token charts use 1-second Shrine candles, GeckoTerminal as fallback` });
  } else {
    checks.push({ name: 'Shrine', status: 'pass', detail: 'not set up (optional): adds 1-second candles for fresh coins: save a key alone in ~/.dexterm/shrine.key' });
  }

  // 5. Network + each data source
  if (deps.offline) {
    checks.push({
      name: 'Network', status: 'warn',
      detail: 'DEXTERM_OFFLINE is set; skipped the live source probes (use --fixtures / --replay for offline data)',
    });
  } else {
    const results = await Promise.all(DATA_SOURCES.map(async (s) => ({ s, r: await deps.probe(s.url) })));
    const down = results.filter((x) => !x.r.reachable);
    const hardDown = down.filter((x) => !x.s.soft);
    if (down.length === 0) {
      const slow = results.filter((x) => (x.r.ms ?? 0) > 2500).map((x) => x.s.name);
      checks.push({
        name: 'Data sources', status: 'pass',
        detail: `all ${results.length} reachable${slow.length ? ` (slow: ${slow.join(', ')})` : ''}`,
      });
    } else {
      checks.push({
        name: 'Data sources', status: hardDown.length ? 'fail' : 'warn',
        detail: `unreachable: ${down.map((x) => `${x.s.name} (${x.r.error ?? 'error'})`).join(', ')}`,
        fix: hardDown.length
          ? 'Check your internet connection / VPN / firewall. If only some hosts fail, they may be regionally blocked — try again or use a different network.'
          : 'New pairs (PumpPortal) is unreachable; the rest of trenchscope works. Check back later or your network may block its host.',
      });
    }
  }

  // 5b. task-1325: the native chart window (docked beside the terminal) vs the browser fallback
  if (deps.popupShell) {
    const sh = deps.popupShell();
    if (sh.built) checks.push({ name: 'Chart window', status: 'pass', detail: `native window ready (${sh.path}); C on a token opens it docked beside this terminal` });
    else checks.push({
      name: 'Chart window', status: 'warn',
      detail: `native window not built — C opens the chart in your browser instead`,
      fix: sh.cargo ? 'Run `npm run build:shell` in packages/popup (about a minute the first time).' : 'Install Rust (https://rustup.rs), then run `npm run build:shell` in packages/popup.',
    });
  }

  // 6. Writable DB path
  const dbPath = defaultDbPath(deps.env);
  const dbDir = dirname(dbPath);
  const werr = deps.checkWritable(dbDir);
  if (!werr) {
    checks.push({ name: 'Data directory', status: 'pass', detail: `${dbDir} is writable (cache, watchlist, credit meter)` });
  } else {
    checks.push({
      name: 'Data directory', status: 'fail',
      detail: `cannot write ${dbDir}: ${werr}`,
      fix: `Fix the permissions (\`mkdir -p ${dbDir} && chmod u+rwx ${dbDir}\`) or run with \`--db :memory:\` for a throwaway session.`,
    });
  }

  // 6b. task-1377: the user's KB / skill overlay. Warn-only: a bad user file is skipped and the bundled one stays in effect.
  if (deps.content) {
    try {
      const { kb, skills } = deps.content();
      const part = (label: string, m: MergedSet) => `${label} ${m.bundled} bundled · ${m.user} user (${m.overridden} overridden, ${m.added} new)${m.skipped.length ? ` · ${m.skipped.length} skipped` : ''}`;
      const detail = `${part('KB', kb)} · ${part('skills', skills)}`;
      const skipped = [...kb.skipped.map((s) => `kb ${s.id}: ${s.reason}`), ...skills.skipped.map((s) => `skill ${s.id}: ${s.reason}`)];
      if (skipped.length) {
        checks.push({ name: 'KB + skills', status: 'warn', detail: `${detail}; skipped ${skipped.slice(0, 3).join('; ')}`, fix: `Run \`trenchscope kb check\` / \`trenchscope skill check\` and fix the file, or \`trenchscope kb|skill reset <id>\` to go back to the bundled one.` });
      } else {
        checks.push({ name: 'KB + skills', status: 'pass', detail: `${detail} (yours: ${kb.dir}, ${skills.dir}; \`trenchscope kb|skill list\`)` });
      }
    } catch { /* an overlay problem must not break the doctor */ }
  }

  // 6c. The paper bot (`trenchscope bot`): informational only. It is paper, so it never warns or fails the doctor.
  if (deps.paperBot) {
    try {
      const b = deps.paperBot();
      if (!b) checks.push({ name: 'Paper bot', status: 'pass', detail: 'not run yet (optional: `trenchscope bot run` paper-trades the signals; never signs or sends)' });
      else {
        const last = b.lastAt ? `, last activity ${new Date(b.lastAt).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
        checks.push({ name: 'Paper bot', status: 'pass', detail: `${b.open} open, ${b.closed} closed paper trade(s)${last} (\`trenchscope bot stats\`; paper only)` });
      }
    } catch { /* a ledger problem must not break the doctor */ }
  }

  // 7. Voice mode (task-1282). Warn-only — voice always degrades to text, so it never fails the doctor.
  if (deps.voiceProbe) {
    try {
      const vc = voiceDoctor(await deps.voiceProbe());
      for (const c of vc) checks.push(c);
    } catch { /* a voice probe failure must not break the doctor */ }
  }

  const ok = !checks.some((c) => c.status === 'fail');
  return { checks, ok };
}

const GLYPH: Record<CheckStatus, string> = { pass: '✓', warn: '!', fail: '✗' };
const ANSI: Record<CheckStatus, string> = { pass: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m' };
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

/** Render the result as a plain pass/fail list. `color` adds ANSI; off for pipes / NO_COLOR. */
export function renderDoctor(result: DoctorResult, opts: { color?: boolean } = {}): string {
  const color = opts.color ?? false;
  const paint = (s: string, code: string) => (color ? code + s + RESET : s);
  const lines: string[] = [];
  lines.push(paint('trenchscope doctor', color ? BOLD : ''));
  lines.push('');
  const nameW = Math.max(...result.checks.map((c) => c.name.length));
  for (const c of result.checks) {
    const g = paint(GLYPH[c.status], color ? ANSI[c.status] : '');
    lines.push(`  ${g}  ${c.name.padEnd(nameW)}  ${c.detail}`);
    if (c.fix) lines.push(`     ${' '.repeat(nameW)}  ${paint('→ ' + c.fix, color ? DIM : '')}`);
  }
  lines.push('');
  const fails = result.checks.filter((c) => c.status === 'fail').length;
  const warns = result.checks.filter((c) => c.status === 'warn').length;
  if (result.ok && warns === 0) lines.push(paint('All checks passed — run `dexterm` to start.', color ? ANSI.pass : ''));
  else if (result.ok) lines.push(paint(`Ready to run (${warns} warning${warns === 1 ? '' : 's'} above are optional).`, color ? ANSI.warn : ''));
  else lines.push(paint(`${fails} check${fails === 1 ? '' : 's'} failed — fix the ✗ lines above, then re-run \`trenchscope doctor\`.`, color ? ANSI.fail : ''));
  return lines.join('\n');
}
