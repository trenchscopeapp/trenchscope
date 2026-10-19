// `trenchscope voice …` (task-1408, task-1416): inspect the voice engines on this machine, download the two
// optional voice models — whisper.cpp base.en (speech-in) and the Piper en_GB-alan-medium voice (neural
// speech-out) — and SET UP the managed neural voice on macOS. Network use is OFF by default: this is the
// only place trenchscope fetches a model or installs a runtime, it asks before it does, and it verifies the
// voice model against a pinned checksum from the official source. Nothing here runs the signer, touches
// keys, or changes trading behaviour.
//
// No new dependencies: the confirm prompt is node:readline, downloads use global fetch, `voice setup`
// shells out to the system python/pip, and the checksum/stream/venv logic lives in @dexterm/voice.

import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  modelRegistry, downloadModel, modelStatus, resolvePiperBin, pickPlayer,
  PIPER_MODEL, DEFAULT_PIPER_VOICE,
  setupPiperRuntime, uninstallPiperRuntime, piperRuntimeStatus,
  type ModelSpec, type RunResult,
} from '@dexterm/voice';
import { dextermHome } from '@dexterm/custom';

export interface VoiceCmdIo {
  stdin: NodeJS.ReadStream & { isTTY?: boolean };
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
}

export const VOICE_USAGE = [
  'usage:',
  '  trenchscope voice [status]                 show the voice engines + which models are installed',
  '  trenchscope voice setup [--yes]            set up the neural voice (Piper) on this machine (asks first)',
  '  trenchscope voice uninstall [--purge-model] remove the managed neural-voice runtime',
  '  trenchscope voice download <model> [--yes] download a voice model (asks first; checksum-verified)',
  '',
  '  models: whisper        whisper.cpp base.en  (speech-to-text, off macOS this is the default)',
  '          piper-voice    Piper en_GB-alan-medium (neural speech-out, the default speaking voice)',
  '          all            both of the above',
].join('\n');

/** Run a command, capture its output, and resolve a RunResult (never rejects). Used by `voice setup`. */
function runCmd(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ code: 127, stdout: '', stderr: (e as Error).message }); return; }
    let stdout = '', stderr = '';
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: stderr || e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function onPath(bin: string, env: NodeJS.ProcessEnv): boolean {
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const p of (env.PATH ?? '').split(sep)) {
    if (p && existsSync(join(p, bin))) return true;
  }
  return false;
}

/** y/N prompt on a TTY. Without a TTY (piped/CI) it returns false — the caller tells the user to pass --yes. */
function askYesNo(io: VoiceCmdIo, question: string): Promise<boolean> {
  if (!io.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: io.stdin, output: io.stdout as NodeJS.WritableStream });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (ans) => { rl.close(); resolve(/^y(es)?$/i.test(ans.trim())); });
  });
}

async function printStatus(io: VoiceCmdIo): Promise<number> {
  const home = dextermHome(io.env);
  const reg = modelRegistry(home);
  const lines: string[] = ['trenchscope voice', ''];

  if (process.platform === 'darwin') {
    const rt = await piperRuntimeStatus(home);
    const player = pickPlayer();
    const piperReady = rt.installed && player !== null;
    if (piperReady) {
      lines.push(`  speech-out  Piper ready (${DEFAULT_PIPER_VOICE}, neural, plays via ${player}) · fallback: macOS \`say\``);
    } else if (rt.pythonPresent || rt.modelInstalled) {
      lines.push(`  speech-out  Piper partly set up (${rt.pythonPresent ? 'runtime ok' : 'no runtime'}, ${rt.modelInstalled ? 'model ok' : 'no model'}) — finish with \`trenchscope voice setup\` · now using macOS \`say\``);
    } else {
      lines.push('  speech-out  macOS `say` (built-in) · neural voice: run `trenchscope voice setup` · see `trenchscope doctor` for the resolved voice');
    }
    lines.push('  speech-in   Apple Speech (swiftc) preferred, else whisper.cpp');
  } else {
    const piperBin = resolvePiperBin();
    const player = pickPlayer();
    const piperReady = piperBin !== null && existsSync(PIPER_MODEL) && player !== null;
    lines.push(`  speech-out  Piper ${piperReady ? `ready (${DEFAULT_PIPER_VOICE}, plays via ${player})` : 'not ready'}${piperReady ? '' : ` · espeak-ng ${onPath('espeak-ng', io.env) || onPath('espeak', io.env) ? 'ready (baseline)' : 'not installed'}`}`);
    lines.push(`  speech-in   whisper.cpp (default off macOS) · mic tool ${['arecord', 'sox', 'rec', 'ffmpeg'].find((b) => onPath(b, io.env)) ?? 'none found'}`);
  }

  lines.push('', '  models:');
  for (const spec of Object.values(reg)) {
    const st = await modelStatus(spec);
    lines.push(`    ${st.installed ? '✓' : '·'} ${spec.id.padEnd(12)} ${spec.label}${st.installed ? ' (installed)' : ''}`);
  }
  lines.push('', `  download a model: trenchscope voice download <whisper|piper-voice|all>`);
  io.stdout.write(lines.join('\n') + '\n');
  return 0;
}

async function runDownload(io: VoiceCmdIo, which: string, yes: boolean): Promise<number> {
  const home = dextermHome(io.env);
  const reg = modelRegistry(home);
  const ids = which === 'all' ? Object.keys(reg) : [which];
  const specs: ModelSpec[] = [];
  for (const id of ids) {
    const spec = reg[id];
    if (!spec) { io.stderr.write(`trenchscope voice: unknown model ${JSON.stringify(id)}\n${VOICE_USAGE}\n`); return 2; }
    specs.push(spec);
  }
  if (!yes && !io.stdin.isTTY) {
    io.stderr.write('trenchscope voice download: no interactive terminal to confirm; re-run with --yes to approve the download.\n');
    return 2;
  }

  let anyFailed = false;
  for (const spec of specs) {
    try {
      const res = await downloadModel(spec, {
        confirm: (prompt) => (yes ? Promise.resolve(true) : askYesNo(io, `\n${prompt}`)),
        log: (s) => io.stdout.write(s + '\n'),
      });
      if (res.status === 'cancelled') return 1; // the user said no — stop here
    } catch (e) {
      io.stderr.write(`trenchscope voice download ${spec.id}: ${(e as Error).message}\n`);
      anyFailed = true;
    }
  }
  return anyFailed ? 1 : 0;
}

/** `trenchscope voice setup`: build the managed neural-voice runtime (venv + model) on this machine. */
async function runSetup(io: VoiceCmdIo, yes: boolean): Promise<number> {
  const home = dextermHome(io.env);
  if (!yes && !io.stdin.isTTY) {
    io.stderr.write('trenchscope voice setup: no interactive terminal to confirm; re-run with --yes to approve the setup.\n');
    return 2;
  }
  // Let the user point setup at a specific interpreter (e.g. a pyenv/homebrew python) via DEXTERM_PYTHON.
  const candidates = io.env.DEXTERM_PYTHON ? [io.env.DEXTERM_PYTHON] : undefined;
  const res = await setupPiperRuntime({
    home,
    run: runCmd,
    confirm: (prompt) => (yes ? Promise.resolve(true) : askYesNo(io, `\n${prompt}`)),
    log: (s) => io.stdout.write(s + '\n'),
    pythonCandidates: candidates,
  });
  if (res.status === 'ok' || res.status === 'already') return 0;
  if (res.status === 'cancelled') return 1;
  // no-python / failed: print the exact fix line.
  io.stderr.write(`trenchscope voice setup: ${res.status === 'no-python' ? 'no suitable Python 3 found' : 'setup failed'}.\n`);
  if (res.fix) io.stderr.write(`  fix: ${res.fix}\n`);
  return 1;
}

/** `trenchscope voice uninstall`: remove the managed neural-voice runtime. */
async function runUninstall(io: VoiceCmdIo, purgeModel: boolean): Promise<number> {
  const home = dextermHome(io.env);
  const res = await uninstallPiperRuntime(home, { purgeModel });
  if (res.status === 'absent') { io.stdout.write('No managed neural-voice runtime to remove.\n'); return 0; }
  io.stdout.write(`Removed the managed neural-voice runtime${purgeModel ? ' and voice model' : ' (voice model kept — remove with --purge-model)'}.\n`);
  return 0;
}

/** `trenchscope voice …`. Returns the process exit code. */
export async function voiceCommand(argv: string[], io: VoiceCmdIo): Promise<number> {
  const yes = argv.includes('--yes') || argv.includes('-y');
  const purgeModel = argv.includes('--purge-model');
  const rest = argv.filter((a) => a !== '--yes' && a !== '-y' && a !== '--purge-model');
  const sub = rest[0];

  if (sub === undefined || sub === 'status') return printStatus(io);
  if (sub === 'setup') return runSetup(io, yes);
  if (sub === 'uninstall' || sub === 'remove') return runUninstall(io, purgeModel);
  if (sub === 'download') {
    const which = rest[1];
    if (!which) { io.stderr.write(`trenchscope voice download: name a model.\n${VOICE_USAGE}\n`); return 2; }
    return runDownload(io, which, yes);
  }
  if (sub === '--help' || sub === '-h' || sub === 'help') { io.stdout.write(VOICE_USAGE + '\n'); return 0; }
  io.stderr.write(`trenchscope voice: unknown subcommand ${JSON.stringify(sub)}\n${VOICE_USAGE}\n`);
  return 2;
}
