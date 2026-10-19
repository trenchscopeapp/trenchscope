// trenchscope paper bot: THE paper-only guard. The bot must never import or reach the signer, the live
// executor, the fast wallet, the Phantom bridge or any build/sign/send path. This test parses every module the
// bot can load (static imports, re-exports and dynamic import() with a literal, following workspace package
// exports maps) and fails if any forbidden file is reachable. `import type` is skipped (erased at runtime);
// `import { type X }` still counts (the module loads). A negative control proves the walker does see the
// signer from the app entry, and a positive control proves it really walked the bot's graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = resolve(HERE, '..', '..');
const CLI = join(PACKAGES, 'cli');
const rel = (f: string): string => relative(PACKAGES, f).split(sep).join('/');

/** Every specifier a module LOADS at runtime: value imports, side-effect imports, re-exports, literal import(). */
function loadedSpecifiers(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && !n.importClause?.isTypeOnly) out.push(n.moduleSpecifier.text);
    else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && !n.isTypeOnly) out.push(n.moduleSpecifier.text);
    else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) out.push(a.text);
      else out.push('<non-literal dynamic import>');
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

const exportsCache = new Map<string, Record<string, string>>();
function resolveSpecifier(spec: string, from: string): string | { external: string } | null {
  if (spec.startsWith('node:')) return null;
  if (spec.startsWith('.')) return resolve(dirname(from), spec);
  const m = /^@dexterm\/([a-z]+)(\/.+)?$/.exec(spec);
  if (m) {
    const pkg = m[1];
    if (!exportsCache.has(pkg)) exportsCache.set(pkg, JSON.parse(readFileSync(join(PACKAGES, pkg, 'package.json'), 'utf8')).exports);
    const target = exportsCache.get(pkg)![m[2] ? `.${m[2]}` : '.'];
    if (!target) return { external: spec };
    return resolve(PACKAGES, pkg, target);
  }
  return { external: spec };
}

/** The transitive runtime import graph from `entries`: module -> the module that first imported it. */
function importGraph(entries: string[]): { modules: Map<string, string | null>; externals: Set<string> } {
  const modules = new Map<string, string | null>();
  const externals = new Set<string>();
  const stack: Array<[string, string | null]> = entries.map((e) => [e, null]);
  while (stack.length) {
    const [file, parent] = stack.pop()!;
    if (modules.has(file)) continue;
    modules.set(file, parent);
    assert.ok(existsSync(file), `unresolvable import ${rel(file)} (from ${parent ? rel(parent) : 'entry'})`);
    for (const s of loadedSpecifiers(file)) {
      const r = resolveSpecifier(s, file);
      if (r === null) continue;
      if (typeof r === 'object') { externals.add(`${r.external} (in ${rel(file)})`); continue; }
      stack.push([r, file]);
    }
  }
  return { modules, externals };
}

function chain(modules: Map<string, string | null>, f: string): string {
  const out = [rel(f)];
  for (let p = modules.get(f); p; p = modules.get(p)) out.push(rel(p));
  return out.reverse().join(' -> ');
}

/** Sign / send / live-execution files. The bot may reach none of them, nor the data barrel that re-exports them. */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/^data\/src\/trade\/signer\//, 'the signer (incl. fast-wallet.ts)'],
  [/^data\/src\/trade\/plans\/executor-live\.ts$/, 'the live plan executor'],
  [/^data\/src\/trade\/bridge\.ts$/, 'the Phantom bridge'],
  [/^data\/src\/trade\/rpc-exec\.ts$/, 'the rpc send path'],
  [/^data\/src\/trade\/swap-build\.ts$/, 'the swap build path'],
  [/^data\/src\/trade\/executor\.ts$/, 'the live trade executor'],
  [/^data\/src\/trade\//, 'any trade module'],
  [/^data\/src\/index\.ts$/, 'the @dexterm/data barrel (it re-exports the signer)'],
  [/^cli\/src\/main\.ts$/, 'the interactive app (it builds signers)'],
  [/^cli\/src\/live\/trade\.ts$/, 'the live ticket/trade wiring'],
];

const BOT_ENTRIES = [join(CLI, 'src', 'bot-cmd.ts'), join(CLI, 'src', 'bot', 'live.ts')];

test('the paper bot module graph reaches no signer / live executor / bridge / fast wallet / send path', () => {
  const { modules, externals } = importGraph(BOT_ENTRIES);
  const hits: string[] = [];
  for (const f of modules.keys()) {
    const r = rel(f);
    for (const [re, what] of FORBIDDEN) if (re.test(r)) hits.push(`${what}: ${chain(modules, f)}`);
  }
  assert.deepEqual(hits, [], `the paper bot can reach a forbidden module:\n  ${hits.join('\n  ')}`);
  assert.deepEqual([...externals], [], 'the bot imports only node: builtins and workspace packages (zero third-party runtime deps)');
});

test('positive control: the walker really followed the bot graph (feed, paper fill pricing, quote, notifier, config)', () => {
  const { modules } = importGraph(BOT_ENTRIES);
  const have = new Set([...modules.keys()].map(rel));
  for (const must of [
    'cli/src/bot/engine.ts', 'cli/src/bot/strategy.ts', 'cli/src/bot/store.ts', 'cli/src/bot/stats.ts', 'cli/src/bot/live.ts',
    'cli/src/feed.ts', 'cli/src/screener/verdict.ts', 'cli/src/screener/rug.ts', 'cli/src/alerts/notifier.ts',
    'data/src/core.ts', 'data/src/layer.ts', 'data/src/paper.ts', 'data/src/sources/jupiter-swap.ts', 'packs/src/rug-model.ts', 'custom/src/index.ts',
  ]) assert.ok(have.has(must), `expected the bot graph to include ${must} (walker bug or the wiring changed)`);
  assert.ok(modules.size >= 60, `suspiciously small bot graph (${modules.size} modules)`);
});

test('negative control: from the app entry the same walker does reach the signer', () => {
  const { modules } = importGraph([join(CLI, 'src', 'main.ts')]);
  const rs = [...modules.keys()].map(rel);
  assert.ok(rs.some((r) => r.startsWith('data/src/trade/signer/')), 'the walker should see the signer from main.ts');
  assert.ok(rs.includes('data/src/trade/swap-build.ts'));
});

test('the bin shims route `bot` to bot-cmd.ts before the app (and its trade modules) loads', () => {
  for (const bin of ['trenchscope.mjs', 'dexterm.mjs']) {
    const src = readFileSync(join(CLI, 'bin', bin), 'utf8');
    const botAt = src.indexOf("process.argv[2] === 'bot'");
    const mainAt = src.indexOf("import('../src/main.ts')");
    assert.ok(botAt > 0 && mainAt > botAt, `${bin}: the bot branch must come before main.ts is imported`);
    assert.match(src.slice(botAt, mainAt), /import\('\.\.\/src\/bot-cmd\.ts'\)/);
    // no static import of the app at all (a static import would load before the branch)
    assert.doesNotMatch(src, /^\s*import\s[^(]*from\s*['"]\.\.\/src\/main\.ts['"]/m);
  }
});

test('no sign / send / arm identifier appears in the bot sources', () => {
  const BAD = /\b(SignerClient|SignerService|LivePlanExecutor|LiveExecutor|FastWallet|signTransaction|signAllTransactions|sendTransaction|sendRawTransaction|armMandate|buildSwap|swapBuild|Keypair)\b/;
  const files = [join(CLI, 'src', 'bot-cmd.ts'), ...['config', 'strategy', 'store', 'engine', 'stats', 'alerts', 'live'].map((f) => join(CLI, 'src', 'bot', `${f}.ts`))];
  for (const f of files) {
    const code = readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const hit = BAD.exec(code);
    assert.equal(hit, null, `${rel(f)} references "${hit?.[1]}"`);
  }
});
