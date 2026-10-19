// trenchscope — alert-channel credentials (task-1398). Bot tokens and webhook URLs are NEVER in config.json
// (the config schema has no key-shaped fields, by rule). They live in ~/.dexterm/<channel>.json, mode 0600,
// outside every repo, read only by the adapters. Nothing here ever prints a secret; `redactCreds()` scrubs
// a token / webhook out of any string before it could reach a log, a toast, a test fixture or an error.
import { readFileSync, writeFileSync, mkdirSync, statSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export interface TelegramCreds { token: string; chatId: string }
export interface DiscordCreds { webhook: string }
/** ntfy: the topic is the credential (anyone who knows it can read it); server defaults to https://ntfy.sh. */
export interface NtfyCreds { topic: string; server: string }
export const NTFY_DEFAULT_SERVER = 'https://ntfy.sh';

export const telegramCredsPath = (home: string): string => join(home, 'telegram.json');
export const discordCredsPath = (home: string): string => join(home, 'discord.json');
export const ntfyCredsPath = (home: string): string => join(home, 'ntfy.json');

function readJson(path: string): Record<string, unknown> | null {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

function writeJson(path: string, home: string, value: Record<string, unknown>): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  // rename is atomic; chmod again in case an old file had looser bits.
  try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
  renameSync(tmp, path);
}

export function readTelegramCreds(home: string): TelegramCreds | null {
  const j = readJson(telegramCredsPath(home));
  if (!j) return null;
  const token = typeof j.token === 'string' ? j.token.trim() : '';
  const chatId = typeof j.chatId === 'string' ? j.chatId.trim() : (typeof j.chatId === 'number' ? String(j.chatId) : '');
  if (!token || !chatId) return null;
  return { token, chatId };
}

export function writeTelegramCreds(home: string, creds: TelegramCreds): void {
  if (!creds.token.trim()) throw new Error('telegram token is empty');
  if (!/^-?\d{1,19}$/.test(creds.chatId.trim())) throw new Error('telegram chatId must be a numeric id (e.g. 123456789 or -1001234567890)');
  writeJson(telegramCredsPath(home), home, { token: creds.token.trim(), chatId: creds.chatId.trim() });
}

export function readDiscordCreds(home: string): DiscordCreds | null {
  const j = readJson(discordCredsPath(home));
  if (!j) return null;
  const webhook = typeof j.webhook === 'string' ? j.webhook.trim() : '';
  if (!webhook) return null;
  return { webhook };
}

export function writeDiscordCreds(home: string, creds: DiscordCreds): void {
  const w = creds.webhook.trim();
  if (!/^https:\/\/(?:[a-z0-9.-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/i.test(w)) {
    throw new Error('discord webhook must be a https://discord.com/api/webhooks/<id>/<token> URL');
  }
  writeJson(discordCredsPath(home), home, { webhook: w });
}

const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** A server is an https origin only (no path, query or credentials), so the topic is the only path segment. */
function ntfyServer(raw: string | undefined): string | null {
  const s = (raw ?? NTFY_DEFAULT_SERVER).trim().replace(/\/+$/, '');
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) return null;
    return u.origin;
  } catch { return null; }
}

export function readNtfyCreds(home: string): NtfyCreds | null {
  const j = readJson(ntfyCredsPath(home));
  if (!j) return null;
  const topic = typeof j.topic === 'string' ? j.topic.trim() : '';
  const server = ntfyServer(typeof j.server === 'string' ? j.server : undefined);
  if (!NTFY_TOPIC_RE.test(topic) || !server) return null;
  return { topic, server };
}

export function writeNtfyCreds(home: string, creds: { topic: string; server?: string }): void {
  const topic = creds.topic.trim();
  // short topics are guessable on the public server: require 8+ characters
  if (!NTFY_TOPIC_RE.test(topic)) throw new Error('ntfy topic must be 8-64 letters, digits, _ or - (pick something hard to guess)');
  const server = ntfyServer(creds.server);
  if (!server) throw new Error('ntfy server must be an https origin, e.g. https://ntfy.sh');
  writeJson(ntfyCredsPath(home), home, { topic, server });
}

/** True when the file exists with 0600-ish perms; a looser mode is reported so the user can tighten it. */
export function credsMode(path: string): number | null {
  try { return statSync(path).mode & 0o777; } catch { return null; }
}

const TELEGRAM_TOKEN_RE = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g;
const DISCORD_WEBHOOK_RE = /https:\/\/(?:[a-z0-9.-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi;
const NTFY_URL_RE = /https?:\/\/[^\s/]*ntfy[^\s/]*\/[A-Za-z0-9_-]+/gi;

/** Scrub any bot token / webhook URL out of a string before it could be logged or shown. Total; never throws. */
export function redactCreds(s: unknown): string {
  return String(s ?? '').replace(TELEGRAM_TOKEN_RE, 'bot[redacted]').replace(DISCORD_WEBHOOK_RE, '[redacted-webhook]').replace(NTFY_URL_RE, '[redacted-ntfy]');
}
