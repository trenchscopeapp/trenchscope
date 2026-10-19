// trenchscope — `trenchscope alerts …` (task-1398): configure WHERE rule alerts are delivered. No model, and the
// only network is an explicit `trenchscope alerts test`. Enable flags + the per-channel `levels` filter live in
// config.json (user-only path); the Telegram bot token / Discord webhook URL are SECRETS and never touch
// config.json, argv or a log — they come from an env var or stdin and are written to ~/.dexterm/<channel>.json
// (0600). The command echoes only how many characters were stored, never the value.
//
//   trenchscope alerts [status] | enable|disable <toast|desktop|telegram|discord> | levels <channel> <list|all>
//                  | proposals <on|off> | set-telegram --chat <id> | set-discord | unset-telegram|unset-discord | test [channel]
import { dextermHome, loadConfig, applyAndJournal, type AlertsConfig, type DextermConfig } from '@dexterm/custom';
import {
  readTelegramCreds, writeTelegramCreds, readDiscordCreds, writeDiscordCreds,
  telegramCredsPath, discordCredsPath, credsMode, readNtfyCreds, writeNtfyCreds, ntfyCredsPath,
} from './alerts/creds.ts';
import { buildNotifier, type Notifier } from './alerts/notifier.ts';
import { CHANNELS, type ChannelName, type AlertDelivery } from './alerts/types.ts';
import { unlinkSync } from 'node:fs';

export interface AlertsIo { stdout: { write(s: string): void }; stderr: { write(s: string): void }; env: NodeJS.ProcessEnv; stdin?: NodeJS.ReadStream }
export interface AlertsDeps { notifier?: Notifier; readSecret?: (prompt: string) => Promise<string | null> }

export const ALERTS_USAGE = `usage: trenchscope alerts [status]
       trenchscope alerts enable|disable <toast|desktop|telegram|discord|ntfy>
       trenchscope alerts levels <channel> <up,down,info,warn | all>
       trenchscope alerts proposals <on|off>
       trenchscope alerts set-telegram --chat <id>   (token from $DEXTERM_TELEGRAM_TOKEN or stdin; never on argv)
       trenchscope alerts set-discord                (webhook from $DEXTERM_DISCORD_WEBHOOK or stdin; never on argv)
       trenchscope alerts set-ntfy [--server https://ntfy.sh]  (topic from $DEXTERM_NTFY_TOPIC or stdin; never on argv)
       trenchscope alerts unset-telegram | unset-discord | unset-ntfy
       trenchscope alerts test [channel]             (send a sample alert through the enabled channels)

  Credentials are stored in ~/.dexterm/telegram.json / discord.json / ntfy.json (0600), never in config.json or a log.
  ntfy: install the ntfy app on your phone and subscribe to the same topic; the topic is the secret.
`;

const LEVELS = ['up', 'down', 'info', 'warn'] as const;
const isChannel = (s: string): s is ChannelName => (CHANNELS as readonly string[]).includes(s);

/** Read a secret from an env var, else one line of stdin. Never printed. Returns null when neither is available. */
async function defaultReadSecret(io: AlertsIo, envVar: string): Promise<string | null> {
  const fromEnv = io.env[envVar];
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  const stdin = io.stdin;
  if (!stdin || stdin.isTTY) {
    io.stderr.write(`trenchscope alerts: set ${envVar} or pipe the value on stdin (never pass a secret on the command line)\n`);
    return null;
  }
  return new Promise<string | null>((resolve) => {
    let buf = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (c: string) => { buf += c; });
    stdin.on('end', () => resolve(buf.split('\n')[0].trim() || null));
    stdin.on('error', () => resolve(null));
  });
}

/** Patch config.alerts as a whole (so a missing /alerts section is created, not a missing-parent error). */
function setAlerts(home: string, mutate: (a: AlertsConfig) => AlertsConfig, why: string): DextermConfig {
  const loaded = loadConfig(home);
  const cur: AlertsConfig = loaded.config.alerts ? structuredClone(loaded.config.alerts) : {};
  const next = mutate(cur);
  const op = loaded.config.alerts === undefined ? 'add' : 'replace';
  const { config } = applyAndJournal(home, [{ op, path: '/alerts', value: next }], { actor: 'user', why });
  return config;
}

function renderStatus(home: string, cfg: AlertsConfig | undefined, io: AlertsIo): void {
  io.stdout.write('alerts — delivery channels\n');
  const ch = cfg?.channels ?? {};
  for (const name of CHANNELS) {
    const c = ch[name];
    const on = name === 'toast' ? c?.enabled !== false : c?.enabled === true;
    const levels = c?.levels && c.levels.length ? ` [${c.levels.join(',')}]` : '';
    let detail = '';
    if (name === 'telegram') { const creds = readTelegramCreds(home); detail = creds ? ` chat ${creds.chatId}, token set` : ' (no token — set-telegram)'; }
    else if (name === 'discord') { const creds = readDiscordCreds(home); detail = creds ? ' webhook set' : ' (no webhook — set-discord)'; }
    else if (name === 'ntfy') { const creds = readNtfyCreds(home); detail = creds ? ` topic set (${creds.server})` : ' (no topic: set-ntfy)'; }
    else if (name === 'desktop') detail = process.platform === 'darwin' ? ' (osascript)' : process.platform === 'linux' ? ' (notify-send)' : ' (unsupported OS)';
    io.stdout.write(`  ${on ? '●' : '○'} ${name.padEnd(9)}${on ? 'on ' : 'off'}${levels}${detail}\n`);
  }
  io.stdout.write(`  proposals: ${cfg?.proposals ? 'delivered' : 'in-app only'}\n`);
  for (const [label, p] of [['telegram.json', telegramCredsPath(home)], ['discord.json', discordCredsPath(home)], ['ntfy.json', ntfyCredsPath(home)]] as const) {
    const mode = credsMode(p);
    // Windows has no POSIX modes (every file reads 0666); file ACLs govern there, so the check is POSIX-only
    if (process.platform !== 'win32' && mode !== null && mode !== 0o600) io.stdout.write(`  ⚠ ${label} is mode 0${mode.toString(8)} (should be 0600; chmod 600 it)\n`);
  }
}

export async function alertsCommand(argv: string[], io: AlertsIo, deps: AlertsDeps = {}): Promise<number> {
  const home = dextermHome(io.env);
  const cmd = argv[0] ?? 'status';
  if (cmd === '--help' || cmd === '-h') { io.stdout.write(ALERTS_USAGE); return 0; }

  try {
    switch (cmd) {
      case 'status': renderStatus(home, loadConfig(home).config.alerts, io); return 0;

      case 'enable': case 'disable': {
        const name = argv[1];
        if (!name || !isChannel(name)) { io.stderr.write(`trenchscope alerts: ${cmd} <${CHANNELS.join('|')}>\n`); return 2; }
        const on = cmd === 'enable';
        if (on && name === 'telegram' && !readTelegramCreds(home)) io.stderr.write('note: telegram has no token yet — run `trenchscope alerts set-telegram --chat <id>`\n');
        if (on && name === 'discord' && !readDiscordCreds(home)) io.stderr.write('note: discord has no webhook yet — run `trenchscope alerts set-discord`\n');
        if (on && name === 'ntfy' && !readNtfyCreds(home)) io.stderr.write('note: ntfy has no topic yet: run `trenchscope alerts set-ntfy`\n');
        setAlerts(home, (a) => { const ch = { ...(a.channels ?? {}) }; ch[name] = { ...(ch[name] ?? {}), enabled: on }; return { ...a, channels: ch }; }, `${cmd} alerts ${name}`);
        io.stdout.write(`${name} ${on ? 'enabled' : 'disabled'}\n`);
        return 0;
      }

      case 'levels': {
        const name = argv[1]; const spec = argv[2];
        if (!name || !isChannel(name) || !spec) { io.stderr.write('trenchscope alerts: levels <channel> <up,down,info,warn | all>\n'); return 2; }
        let levels: typeof LEVELS[number][] | undefined;
        if (spec !== 'all') {
          const parts = spec.split(',').map((s) => s.trim()).filter(Boolean);
          const bad = parts.filter((p) => !(LEVELS as readonly string[]).includes(p));
          if (bad.length || !parts.length) { io.stderr.write(`trenchscope alerts: bad levels "${spec}" (use ${LEVELS.join(',')} or all)\n`); return 2; }
          levels = parts as typeof LEVELS[number][];
        }
        setAlerts(home, (a) => { const ch = { ...(a.channels ?? {}) }; const c = { ...(ch[name] ?? {}) }; if (levels) c.levels = levels; else delete c.levels; ch[name] = c; return { ...a, channels: ch }; }, `alerts levels ${name}`);
        io.stdout.write(`${name} levels: ${levels ? levels.join(',') : 'all'}\n`);
        return 0;
      }

      case 'proposals': {
        const v = argv[1];
        if (v !== 'on' && v !== 'off') { io.stderr.write('trenchscope alerts: proposals <on|off>\n'); return 2; }
        setAlerts(home, (a) => ({ ...a, proposals: v === 'on' }), `alerts proposals ${v}`);
        io.stdout.write(`proposal delivery ${v === 'on' ? 'on' : 'off'}\n`);
        return 0;
      }

      case 'set-telegram': {
        const ci = argv.indexOf('--chat');
        const chatId = ci >= 0 ? argv[ci + 1] : undefined;
        if (!chatId) { io.stderr.write('trenchscope alerts: set-telegram --chat <id>\n'); return 2; }
        const token = await (deps.readSecret ? deps.readSecret('telegram bot token') : defaultReadSecret(io, 'DEXTERM_TELEGRAM_TOKEN'));
        if (!token) return 2;
        writeTelegramCreds(home, { token, chatId });
        io.stdout.write(`telegram token stored (${token.length} chars) for chat ${chatId} in ~/.dexterm/telegram.json (0600)\n`);
        return 0;
      }

      case 'set-discord': {
        const webhook = await (deps.readSecret ? deps.readSecret('discord webhook url') : defaultReadSecret(io, 'DEXTERM_DISCORD_WEBHOOK'));
        if (!webhook) return 2;
        writeDiscordCreds(home, { webhook });
        io.stdout.write(`discord webhook stored (${webhook.length} chars) in ~/.dexterm/discord.json (0600)\n`);
        return 0;
      }

      case 'set-ntfy': {
        const si = argv.indexOf('--server');
        const server = si >= 0 ? argv[si + 1] : undefined;
        const topic = await (deps.readSecret ? deps.readSecret('ntfy topic') : defaultReadSecret(io, 'DEXTERM_NTFY_TOPIC'));
        if (!topic) return 2;
        writeNtfyCreds(home, { topic, server });
        io.stdout.write(`ntfy topic stored (${topic.trim().length} chars) in ~/.dexterm/ntfy.json (0600); enable it with: trenchscope alerts enable ntfy\n`);
        return 0;
      }

      case 'unset-ntfy': { try { unlinkSync(ntfyCredsPath(home)); } catch { /* ignore */ } io.stdout.write('ntfy topic removed\n'); return 0; }

      case 'unset-telegram': { try { unlinkSync(telegramCredsPath(home)); } catch { /* ignore */ } io.stdout.write('telegram credentials removed\n'); return 0; }
      case 'unset-discord': { try { unlinkSync(discordCredsPath(home)); } catch { /* ignore */ } io.stdout.write('discord credentials removed\n'); return 0; }

      case 'test': {
        const only = argv[1];
        if (only && !isChannel(only)) { io.stderr.write(`trenchscope alerts: test [<${CHANNELS.join('|')}>]\n`); return 2; }
        const cfg = loadConfig(home).config.alerts;
        const notifier = deps.notifier ?? buildNotifier(home, cfg, { toastSink: (line) => io.stdout.write(`toast: ${line}\n`) });
        const sample: AlertDelivery = {
          kind: 'alert', level: 'info', title: 'trenchscope ⚑ test', body: 'alert delivery test — if you see this, the channel works.',
          spoken: 'trenchscope test alert', symbol: 'dexterm', mint: '', source: 'user', rule: 'alerts-test', at: Date.now(),
        };
        const results = await notifier.deliver(sample);
        const shown = only ? results.filter((r) => r.channel === only) : results;
        if (!shown.length) { io.stdout.write('no channel routed this alert (enable one first)\n'); return 0; }
        for (const r of shown) io.stdout.write(`  ${r.ok ? '✓' : r.skipped ? '–' : '✗'} ${r.channel}${r.reason ? `: ${r.reason}` : ''}\n`);
        return shown.every((r) => r.ok || r.skipped) ? 0 : 1;
      }

      default:
        io.stderr.write(`trenchscope alerts: unknown subcommand "${cmd}"\n\n${ALERTS_USAGE}`);
        return 2;
    }
  } catch (e) {
    io.stderr.write(`trenchscope alerts: ${(e as Error).message}\n`);
    return 1;
  }
}
