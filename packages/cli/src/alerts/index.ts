// trenchscope — alert delivery subsystem (task-1398). See DESIGN.md.
export * from './types.ts';
export * from './format.ts';
export * from './route.ts';
export * from './creds.ts';
export * from './notifier.ts';
export { createToastAdapter } from './adapters/toast.ts';
export { createDesktopAdapter, type DesktopDeps, type DesktopRunner } from './adapters/desktop.ts';
export { createTelegramAdapter, type TelegramDeps, type FetchLike } from './adapters/telegram.ts';
export { createNtfyAdapter, type NtfyDeps } from './adapters/ntfy.ts';
export { createDiscordAdapter, type DiscordDeps } from './adapters/discord.ts';
