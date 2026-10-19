// Regenerate the app-help KB entries (task-1413). Run after a keymap / MCP-tool / CLI change:
//   node packages/cli/scripts/gen-app-help-kb.ts
// It writes assets/kb/app-help/*.md in @dexterm/mcp from the app's own keymap/overlay/tools/CLI.
// The drift test (packages/cli/test/app-help-drift-1413.test.ts) fails until the committed files match a re-run.
import fs from 'node:fs';
import path from 'node:path';
import { buildAppHelpEntries, serializeEntry } from '../src/app-help-gen.ts';
import { APP_HELP_DIR } from '@dexterm/mcp';

const entries = buildAppHelpEntries();
fs.mkdirSync(APP_HELP_DIR, { recursive: true });

// Remove stale entries (an id that no longer exists).
const want = new Set(entries.map((e) => `${e.id}.md`));
for (const f of fs.readdirSync(APP_HELP_DIR)) {
  if (f.endsWith('.md') && !want.has(f)) { fs.rmSync(path.join(APP_HELP_DIR, f)); process.stdout.write(`removed stale ${f}\n`); }
}
for (const e of entries) fs.writeFileSync(path.join(APP_HELP_DIR, `${e.id}.md`), serializeEntry(e), { mode: 0o644 });

process.stdout.write(`wrote ${entries.length} app-help entries to ${APP_HELP_DIR}\n`);
