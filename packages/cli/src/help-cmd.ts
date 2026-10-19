// `trenchscope help [topic]` (task-1413) — the app-help knowledge base from the command line, backed by the
// same generated entries as the analyst's `app_help` MCP tool. No network, no model.
//   trenchscope help                 list the topics
//   trenchscope help export          show the best-matching topic (exact key/command + how-to)
//   trenchscope help screen token    multi-word query
import { loadAppHelp, searchAppHelp, getAppHelp, type AppHelpEntry } from '@dexterm/mcp';

interface Io { stdout: { write(s: string): void }; stderr: { write(s: string): void } }

function show(e: AppHelpEntry, io: Io): void {
  io.stdout.write(`\n${e.title}  (${e.id})\n`);
  io.stdout.write(`${'─'.repeat(Math.min(60, e.title.length + e.id.length + 4))}\n`);
  if (e.keys.length) io.stdout.write(`Keys:     ${e.keys.join('  ')}\n`);
  if (e.commands.length) io.stdout.write(`Commands: ${e.commands.map((c) => `trenchscope ${c}`).join('  ')}\n`);
  if (e.flags.length) io.stdout.write(`Flags:    ${e.flags.join('  ')}\n`);
  io.stdout.write(`\n${e.body}\n`);
}

export function helpCommand(argv: string[], io: Io): number {
  const entries = loadAppHelp();
  if (!entries.length) { io.stderr.write('no app-help entries found\n'); return 1; }

  const query = argv.join(' ').trim();
  if (!query) {
    io.stdout.write('trenchscope help <topic> — how the app works. Topics:\n\n');
    for (const e of entries) io.stdout.write(`  ${e.id.padEnd(26)} ${e.title}\n`);
    io.stdout.write('\nExamples: trenchscope help export · trenchscope help voice speed · trenchscope help screener\n');
    return 0;
  }

  // Exact id wins; otherwise the best retrieval match, with near-misses listed.
  const exact = getAppHelp(query.replace(/\s+/g, '-'), entries) ?? getAppHelp(query, entries);
  if (exact) { show(exact, io); return 0; }

  const results = searchAppHelp(query, 5, entries);
  if (!results.length) {
    io.stdout.write(`No app-help topic matches "${query}". Run \`trenchscope help\` to list topics.\n`);
    return 1;
  }
  show(results[0], io);
  if (results.length > 1) {
    io.stdout.write(`\nRelated: ${results.slice(1).map((r) => r.id).join(', ')}\n`);
  }
  return 0;
}
