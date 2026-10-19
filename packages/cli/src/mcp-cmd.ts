// `trenchscope mcp …` — the read-only MCP server plus one-command setup for any agent (task-1405).
//
//   trenchscope mcp                         run the read-only MCP server on stdio (what the analyst uses and
//                                       what `claude mcp add trenchscope -- trenchscope mcp` wires up)
//   trenchscope mcp install <client>        write/print the MCP config for a client (claude-code, claude-desktop,
//                                       cursor, codex, generic). Shows the exact change, asks first,
//                                       is idempotent, and backs the file up before editing.
//   trenchscope mcp doctor                  spawn the server over stdio, do the MCP handshake, and list the tools,
//                                       prompts and resources the agent sees — proof the connection works.
//
// install writes nothing without consent: it prints the target file and the exact snippet, then (unless
// --yes) asks on a TTY; a non-TTY run without --yes prints the plan and stops. --print never writes. The
// config dir is resolved from the environment; --config FILE overrides it (tests point this at a temp dir),
// so this command NEVER has to touch the real ~/.claude, Cursor or Claude Desktop config to be exercised.

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import type { Io } from './main.ts';

function flag(rest: string[], name: string): string | undefined { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; }
function has(rest: string[], name: string): boolean { return rest.includes(name); }

/** The stdio command a client should run to reach this server. `trenchscope mcp` once trenchscope is on PATH. */
export interface McpCommand { command: string; args: string[] }

export function defaultCommand(env: NodeJS.ProcessEnv, useNode: boolean): McpCommand {
  if (!useNode) return { command: 'dexterm', args: ['mcp'] };
  // Fallback for when trenchscope is not on PATH: run this repo's server bin with the current node.
  return { command: process.execPath, args: [mcpBinPath(), 'mcp'] };
}

/** Where this repo's standalone MCP server bin lives (used by the --node command and by `doctor`). */
export function mcpBinPath(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/src
  return resolve(here, '..', '..', 'mcp', 'bin', 'dexterm-mcp.mjs');
}

type Format = 'json' | 'toml' | 'print';

interface ClientSpec {
  id: string;
  label: string;
  /** How the config is stored. 'print' = location varies, so we print the snippet unless --config is given. */
  format: Format;
  /** The JSON key that holds the server map (json clients) / the TOML table prefix (toml clients). */
  keyPath: string;
  /** Resolve the default config file, or null when the location is not well-known (print-only). */
  path(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null;
  note?: string;
}

function home(env: NodeJS.ProcessEnv): string { return env.HOME || env.USERPROFILE || homedir(); }

function appSupport(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, app: string): string {
  if (platform === 'darwin') return join(home(env), 'Library', 'Application Support', app);
  if (platform === 'win32') return join(env.APPDATA || join(home(env), 'AppData', 'Roaming'), app);
  return join(env.XDG_CONFIG_HOME || join(home(env), '.config'), app);
}

export const CLIENTS: readonly ClientSpec[] = [
  {
    id: 'claude-code', label: 'Claude Code', format: 'json', keyPath: 'mcpServers',
    path: (env) => join(env.DEXTERM_CWD || process.cwd(), '.mcp.json'),
    note: 'project-scoped .mcp.json in the current directory; or run `claude mcp add trenchscope -- trenchscope mcp`.',
  },
  {
    id: 'claude-desktop', label: 'Claude Desktop', format: 'json', keyPath: 'mcpServers',
    path: (env, platform) => join(appSupport(env, platform, 'Claude'), 'claude_desktop_config.json'),
    note: 'restart Claude Desktop after editing so it re-reads the config.',
  },
  {
    id: 'cursor', label: 'Cursor', format: 'json', keyPath: 'mcpServers',
    path: (env) => join(home(env), '.cursor', 'mcp.json'),
    note: 'global Cursor MCP config (~/.cursor/mcp.json); a project .cursor/mcp.json works too.',
  },
  {
    id: 'codex', label: 'Codex CLI', format: 'toml', keyPath: 'mcp_servers',
    path: (env) => join(env.CODEX_HOME || join(home(env), '.codex'), 'config.toml'),
    note: 'Codex reads MCP servers from the [mcp_servers.*] tables in ~/.codex/config.toml.',
  },
  {
    id: 'generic', label: 'Generic (print the snippet)', format: 'print', keyPath: 'mcpServers',
    path: () => null,
    note: 'the standard stdio mcpServers entry most agents take; paste it where your agent reads MCP servers, or pass --config FILE to write a JSON file.',
  },
] as const;

export function clientById(id: string): ClientSpec | undefined { return CLIENTS.find((c) => c.id === id); }

/** The JSON object a json-format client expects under its server map, for `dexterm`. */
export function serverEntryJson(cmd: McpCommand): Record<string, unknown> {
  return { command: cmd.command, args: cmd.args };
}

/** The TOML block a codex-style client expects. */
export function serverEntryToml(cmd: McpCommand): string {
  const args = cmd.args.map((a) => JSON.stringify(a)).join(', ');
  return `[mcp_servers.dexterm]\ncommand = ${JSON.stringify(cmd.command)}\nargs = [${args}]\n`;
}

/** Plan a JSON merge: returns the new file text and whether anything changes. Preserves every other key. */
export function planJson(existingText: string | null, keyPath: string, entry: Record<string, unknown>): { text: string; changed: boolean; was: 'absent' | 'same' | 'different' } {
  let obj: Record<string, unknown> = {};
  if (existingText && existingText.trim()) {
    try { const parsed = JSON.parse(existingText); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>; }
    catch { throw new Error('the existing config is not valid JSON — fix or move it, then re-run'); }
  }
  const map = (obj[keyPath] && typeof obj[keyPath] === 'object' && !Array.isArray(obj[keyPath])) ? obj[keyPath] as Record<string, unknown> : {};
  const prev = map.dexterm;
  const was: 'absent' | 'same' | 'different' = prev === undefined ? 'absent' : JSON.stringify(prev) === JSON.stringify(entry) ? 'same' : 'different';
  const next = { ...obj, [keyPath]: { ...map, dexterm: entry } };
  return { text: JSON.stringify(next, null, 2) + '\n', changed: was !== 'same', was };
}

/** Plan a TOML merge: append the trenchscope block when there is no [mcp_servers.dexterm] yet; never clobber. */
export function planToml(existingText: string | null, block: string): { text: string; changed: boolean; was: 'absent' | 'same' | 'different'; conflict: boolean } {
  const cur = existingText ?? '';
  if (cur.includes(block.trim())) return { text: cur, changed: false, was: 'same', conflict: false };
  if (/\[mcp_servers\.dexterm\]/.test(cur)) return { text: cur, changed: false, was: 'different', conflict: true };
  const sep = cur.length && !cur.endsWith('\n\n') ? (cur.endsWith('\n') ? '\n' : '\n\n') : '';
  return { text: cur + sep + block, changed: true, was: 'absent', conflict: false };
}

function readLineYesNo(io: Io, prompt: string): Promise<boolean> {
  const stdin = io.stdin;
  if (!stdin || !stdin.isTTY) return Promise.resolve(false);
  return new Promise((res) => {
    const rl = readline.createInterface({ input: stdin, output: io.stdout });
    rl.question(prompt, (ans) => { rl.close(); res(/^y(es)?$/i.test(ans.trim())); });
  });
}

function backupPath(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${file}.bak-${stamp}`;
}

async function install(rest: string[], io: Io): Promise<number> {
  const out = (s: string) => io.stdout.write(s + '\n');
  const errOut = (s: string) => io.stderr.write(s + '\n');
  const id = rest.find((a) => !a.startsWith('-'));
  const spec = id ? clientById(id) : undefined;
  if (!spec) {
    errOut(`usage: trenchscope mcp install <${CLIENTS.map((c) => c.id).join('|')}> [--config FILE] [--print] [--node] [--yes]`);
    if (id) errOut(`unknown client "${id}". known: ${CLIENTS.map((c) => c.id).join(', ')}`);
    return 2;
  }
  const printOnly = has(rest, '--print');
  const useNode = has(rest, '--node');
  const yes = has(rest, '--yes') || has(rest, '-y');
  const cmd = defaultCommand(io.env, useNode);
  const override = flag(rest, '--config');
  const target = override ? resolve(override) : spec.path(io.env, process.platform);
  const forcePrint = spec.format === 'print' && !override;

  // The snippet we would add, always shown.
  const snippet = spec.format === 'toml' ? serverEntryToml(cmd) : JSON.stringify({ [spec.keyPath]: { dexterm: serverEntryJson(cmd) } }, null, 2);
  out(`trenchscope MCP server for ${spec.label}:`);
  out('');
  out(indent(snippet));
  out('');
  if (spec.note) out(`note: ${spec.note}`);

  if (printOnly || forcePrint) {
    if (forcePrint && !printOnly) out('(this client has no single well-known config file — paste the snippet above, or pass --config FILE to write it.)');
    return 0;
  }
  if (!target) { out('pass --config FILE to write this to a specific file.'); return 0; }

  const existed = existsSync(target);
  const existingText = existed ? readFileSync(target, 'utf8') : null;

  let plan: { text: string; changed: boolean; was: 'absent' | 'same' | 'different'; conflict?: boolean };
  try {
    plan = spec.format === 'toml'
      ? planToml(existingText, serverEntryToml(cmd))
      : planJson(existingText, spec.keyPath, serverEntryJson(cmd));
  } catch (e) { errOut(`trenchscope mcp install: ${(e as Error).message} (${target})`); return 1; }

  out('');
  out(`target: ${target}${existed ? '' : ' (new file)'}`);
  if (plan.conflict) {
    out('a [mcp_servers.dexterm] section already exists and differs; not modifying it. Review it by hand, or edit it to match the snippet above.');
    return 0;
  }
  if (!plan.changed) { out('already configured — nothing to change (idempotent).'); return 0; }
  out(plan.was === 'different' ? 'this UPDATES the existing trenchscope entry.' : existed ? 'this ADDS a trenchscope entry (your other servers are preserved).' : 'this CREATES the config file with a trenchscope entry.');

  if (!yes) {
    const ok = await readLineYesNo(io, 'write this change? [y/N] ');
    if (!ok) { out(io.stdin?.isTTY ? 'cancelled; nothing was written.' : 'not a TTY and --yes was not given; nothing written. Re-run with --yes to write, or --print to just print.'); return io.stdin?.isTTY ? 0 : 0; }
  }

  try {
    mkdirSync(dirname(target), { recursive: true });
    if (existed) { const bak = backupPath(target); copyFileSync(target, bak); out(`backed up: ${bak}`); }
    writeFileSync(target, plan.text, { mode: 0o600 });
    out(`wrote ${target}.`);
    out(`verify it: trenchscope mcp doctor`);
    return 0;
  } catch (e) { errOut(`trenchscope mcp install: could not write ${target}: ${(e as Error).message}`); return 1; }
}

function indent(s: string): string { return s.split('\n').map((l) => '  ' + l).join('\n'); }

// ---------------------------------------------------------------------------
// doctor: spawn the server on stdio, do the handshake, list what the agent sees.

interface Rpc { jsonrpc: '2.0'; id: number; method: string; params?: Record<string, unknown> }

async function doctor(rest: string[], io: Io): Promise<number> {
  const out = (s: string) => io.stdout.write(s + '\n');
  const errOut = (s: string) => io.stderr.write(s + '\n');
  // Prefer the command install writes (`trenchscope mcp`); fall back to this repo's node bin when trenchscope is
  // not on PATH (e.g. a dev checkout). Either way this is a real stdio child, not an in-process shortcut.
  const useNode = has(rest, '--node');
  const cmd = useNode ? defaultCommand(io.env, true) : { command: 'dexterm', args: ['mcp'] };
  out(`trenchscope mcp doctor — spawning: ${cmd.command} ${cmd.args.join(' ')}`);

  const result = await probe(cmd, io.env).catch((e) => ({ error: (e as Error).message }));
  if ('error' in result && !useNode && /ENOENT|not found|spawn/i.test(result.error)) {
    // trenchscope not on PATH: retry with the bundled node bin so doctor still verifies the server.
    out(`(trenchscope not on PATH; retrying with this checkout's server)`);
    const fallback = defaultCommand(io.env, true);
    out(`trenchscope mcp doctor — spawning: ${fallback.command} ${fallback.args.join(' ')}`);
    const r2 = await probe(fallback, io.env).catch((e) => ({ error: (e as Error).message }));
    return report(r2, out, errOut);
  }
  return report(result, out, errOut);
}

type ProbeResult = { error: string } | { serverInfo: Record<string, unknown>; tools: string[]; prompts: string[]; resources: number };

function report(r: ProbeResult, out: (s: string) => void, errOut: (s: string) => void): number {
  if ('error' in r) { errOut(`✗ could not reach the MCP server: ${r.error}`); return 1; }
  const info = r.serverInfo as { name?: string; version?: string };
  out(`✓ connected to ${info?.name ?? 'dexterm'} ${info?.version ?? ''} over stdio (MCP initialize ok)`);
  out(`tools (${r.tools.length}): ${r.tools.join(', ')}`);
  out(`prompts/skills (${r.prompts.length}): ${r.prompts.join(', ') || '(none)'}`);
  out(`resources: ${r.resources}`);
  out('the connection works; add it to your agent with `trenchscope mcp install <client>`.');
  return 0;
}

function probe(cmd: McpCommand, env: NodeJS.ProcessEnv): Promise<ProbeResult> {
  return new Promise((res, rej) => {
    const child = spawn(cmd.command, cmd.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, DEXTERM_OFFLINE: '1', NO_COLOR: '1' } });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } rej(new Error('timed out waiting for the server (10s)')); }, 10_000);
    let stderr = '';
    child.on('error', (e) => { clearTimeout(timer); rej(e); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const rl = readline.createInterface({ input: child.stdout });
    const pending = new Map<number, (v: Record<string, unknown>) => void>();
    let seq = 0;
    const send = (method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const id = ++seq;
      const msg: Rpc = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
      return new Promise((r) => { pending.set(id, r); child.stdin.write(JSON.stringify(msg) + '\n'); });
    };
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: { id?: number; result?: Record<string, unknown> };
      try { msg = JSON.parse(line); } catch { return; }
      if (typeof msg.id === 'number' && pending.has(msg.id)) { const r = pending.get(msg.id)!; pending.delete(msg.id); r(msg.result ?? {}); }
    });
    (async () => {
      try {
        const init = await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dexterm-doctor', version: '1' } });
        const toolsRes = await send('tools/list');
        const promptsRes = await send('prompts/list');
        const resRes = await send('resources/list');
        clearTimeout(timer);
        try { child.stdin.end(); } catch { /* ignore */ }
        try { child.kill(); } catch { /* ignore */ }
        const tools = Array.isArray(toolsRes.tools) ? (toolsRes.tools as Array<{ name?: string }>).map((t) => String(t.name)) : [];
        const prompts = Array.isArray(promptsRes.prompts) ? (promptsRes.prompts as Array<{ name?: string }>).map((p) => String(p.name)) : [];
        const resources = Array.isArray(resRes.resources) ? resRes.resources.length : 0;
        res({ serverInfo: (init.serverInfo as Record<string, unknown>) ?? {}, tools, prompts, resources });
      } catch (e) {
        clearTimeout(timer);
        rej(new Error(`${(e as Error).message}${stderr ? ` · server stderr: ${stderr.slice(0, 200)}` : ''}`));
      }
    })();
  });
}

const USAGE = `trenchscope mcp [<command>]
  (no command)              run the read-only MCP server on stdio (claude mcp add trenchscope -- trenchscope mcp)
  install <client>          write/print the MCP config for a client and verify what changes
                            clients: ${CLIENTS.map((c) => c.id).join(', ')}
                            --config FILE  write to a specific file (instead of the client's default)
                            --print        only print the snippet, never write
                            --node         emit a "node <path> mcp" command (when trenchscope is not on PATH)
                            --yes          write without the confirmation prompt
  doctor                    spawn the server, do the MCP handshake, and list the tools/prompts/resources`;

/** `trenchscope mcp …`. With no subcommand (or an arg the server consumes, e.g. --replay) it runs the server. */
export async function runMcp(rest: string[], io: Io): Promise<number> {
  const sub = rest[0];
  if (sub === 'install') return install(rest.slice(1), io);
  if (sub === 'doctor') return doctor(rest.slice(1), io);
  if (sub === 'help' || sub === '--help' || sub === '-h') { io.stdout.write(USAGE + '\n'); return 0; }
  // Anything else (no args, or server flags like --replay) → the stdio server, unchanged.
  const { runStdioServer } = await import('@dexterm/mcp');
  await runStdioServer({ argv: rest });
  return 0;
}
