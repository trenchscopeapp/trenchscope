// Copies the static site into public/, the directory Vercel serves. Server source,
// manifests, dependencies, provenance sidecars and dotfiles never enter it.
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'public');
// A fixed target beneath this checkout, never an environment-supplied delete path.
if (path.dirname(output) !== root || path.basename(output) !== 'public') throw new Error('Invalid output path');

const skipDirs = new Set(['api', 'node_modules', 'public', 'server', 'test']);
const skipFiles = new Set(['package.json', 'package-lock.json', 'vercel.json']);
const served = new Set(['.html', '.css', '.js', '.json', '.webmanifest', '.png', '.ico', '.svg', '.webp', '.woff2', '.md']);
// *.webp.json, *.svg.json and og.png.json record how a raster was made; they are not served.
const sidecar = name => /\.(png|svg|webp)\.json$/.test(name);

const keep = (relative, isDir) => {
  const parts = relative.split(path.sep);
  if (parts.some(part => part.startsWith('.'))) return false;
  if (isDir) return !skipDirs.has(parts[0]);
  const name = parts.at(-1);
  if (parts.length === 1 && skipFiles.has(name)) return false;
  return served.has(path.extname(name)) && !sidecar(name);
};

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
let count = 0;
for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
  if (!entry.isFile()) continue;
  const relative = path.relative(root, path.join(entry.parentPath, entry.name));
  const dirs = path.dirname(relative);
  if (dirs !== '.' && !keep(dirs, true)) continue;
  if (!keep(relative, false)) continue;
  await mkdir(path.join(output, dirs), { recursive: true });
  await cp(path.join(root, relative), path.join(output, relative));
  count += 1;
}
console.log(`public/: ${count} files`);
