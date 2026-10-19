// `trenchscope workspace <list|show|remove|init> …` (task-1358 Tier 1): the workspace files under
// ~/.dexterm/workspaces/ (DEXTERM_HOME overrides). No network, no model, never touches a key file.
//   list            built-ins + files, with errors for files that do not validate
//   show <name>     print the workspace JSON (a built-in prints its generated form)
//   remove <name>   delete a user file (built-ins cannot be removed)
//   init            write `default` as an editable file with the shipped layout trees, if it does not exist
import { listWorkspaces, readWorkspace, removeWorkspace, writeWorkspace, dextermHome, builtinScreens, defaultWorkspace, workspacesDir } from '@dexterm/custom';

export interface WorkspaceIo { stdout: { write(s: string): unknown }; stderr: { write(s: string): unknown }; env: NodeJS.ProcessEnv }

export const WORKSPACE_USAGE = `usage: trenchscope workspace list | show <name> | remove <name> | init
  files: ~/.dexterm/workspaces/<name>.json (DEXTERM_HOME overrides); in the app: ctrl+w then w/n/N/s/m/o/d/1-9, or --workspace <name>`;

export async function workspaceCommand(argv: string[], io: WorkspaceIo): Promise<number> {
  const home = dextermHome(io.env);
  const [cmd, name] = argv;
  const bad = (s: string): number => { io.stderr.write(`trenchscope workspace: ${s}\n${WORKSPACE_USAGE}\n`); return 2; };
  switch (cmd) {
    case undefined: case 'list': {
      const list = listWorkspaces(home);
      io.stdout.write(`${workspacesDir(home)}\n`);
      for (const w of list) {
        const tag = w.builtin ? 'built-in' : 'file';
        const what = w.error ? `⚠ ${w.error}` : [w.workspace.description, w.workspace.start ? `starts on ${w.workspace.start}` : null, w.workspace.theme ? `theme ${w.workspace.theme}` : null, w.workspace.popups?.length ? `${w.workspace.popups.length} popup(s): ${w.workspace.popups.map((p) => p.kind).join(', ')}` : null].filter(Boolean).join(' · ');
        io.stdout.write(`  ${w.name.padEnd(24)} ${tag.padEnd(9)} ${what}\n`);
      }
      return 0;
    }
    case 'show': {
      if (!name) return bad('show needs a name');
      const ws = readWorkspace(home, name);
      if (!ws) { io.stderr.write(`trenchscope workspace: no workspace "${name}" (see: trenchscope workspace list)\n`); return 1; }
      io.stdout.write(JSON.stringify(ws, null, 2) + '\n');
      return 0;
    }
    case 'remove': {
      if (!name) return bad('remove needs a name');
      const entry = listWorkspaces(home).find((w) => w.name === name);
      if (!entry) { io.stderr.write(`trenchscope workspace: no workspace "${name}"\n`); return 1; }
      if (entry.builtin) { io.stderr.write(`trenchscope workspace: "${name}" is built in; it cannot be removed (save a file with that name to override it)\n`); return 1; }
      if (!removeWorkspace(home, name)) { io.stderr.write(`trenchscope workspace: could not remove ${entry.path}\n`); return 1; }
      io.stdout.write(`removed ${entry.path}\n`);
      return 0;
    }
    case 'init': {
      const existing = listWorkspaces(home).find((w) => w.name === 'default' && !w.builtin);
      if (existing) { io.stdout.write(`${existing.path} already exists\n`); return 0; }
      const path = writeWorkspace(home, { ...defaultWorkspace(), description: 'The shipped layout as editable pane trees (trenchscope workspace init)', screens: builtinScreens() });
      io.stdout.write(`wrote ${path}\n  edit the trees (weight / fixed / priority / collapseBelow), then ctrl+w d in the app or --workspace default\n`);
      return 0;
    }
    default: return bad(`unknown subcommand "${cmd}"`);
  }
}
