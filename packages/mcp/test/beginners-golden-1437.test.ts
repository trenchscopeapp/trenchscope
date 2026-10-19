// task-1437 — beginner-only deterministic retrieval. These questions are answered by the beginner guide,
// without a model. Each query must rank the guide's exact section first in the generated docs KB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDocsKb, searchDocs } from '../src/app-help.ts';

const BEGINNER_GOLDEN: Array<[string, string]> = [
  ['I have never used a terminal, what is a terminal and shell', 'docs-beginners-terminal-shell-prompt-command-output-and-path'],
  ['what does a shell mean for a complete beginner', 'docs-beginners-terminal-shell-prompt-command-output-and-path'],
  ['what is the prompt in a terminal window', 'docs-beginners-terminal-shell-prompt-command-output-and-path'],
  ['what is command output in a terminal', 'docs-beginners-terminal-shell-prompt-command-output-and-path'],
  ['what does PATH mean in a shell', 'docs-beginners-terminal-shell-prompt-command-output-and-path'],
  ['how should a beginner copy and paste commands safely', 'docs-beginners-copy-and-paste-without-surprises'],
  ['where do I find the terminal application on macOS', 'docs-beginners-macos'],
  ['how do I open a terminal on Linux', 'docs-beginners-linux'],
  ['where is the Start menu step for opening Windows Terminal', 'docs-beginners-windows'],
  ['which Node.js version do I install before dexterm', 'docs-beginners-install-node-js-first'],
  ['how does a beginner install trenchscope with npm on macOS or Linux', 'docs-beginners-macos-or-linux-npm'],
  ['how do I install trenchscope with Homebrew on macOS', 'docs-beginners-macos-homebrew'],
  ['how do I install trenchscope from PowerShell on Windows', 'docs-beginners-windows-powershell-experimental'],
  ['what does trenchscope doctor check after installation', 'docs-beginners-check-the-installation-with-doctor'],
  ['how does the ten minute beginner walkthrough start dexterm', 'docs-beginners-1-start-dexterm'],
  ['how does the beginner walkthrough open a real coin by contract address', 'docs-beginners-2-open-a-real-coin-by-contract-address'],
  ['how should a beginner read the on-chain safety panel', 'docs-beginners-3-read-the-safety-panel'],
  ['how should a beginner understand the holder panel and top 10', 'docs-beginners-4-read-the-holder-panel'],
  ['how can a beginner optionally ask the analyst about the panels', 'docs-beginners-5-optionally-ask-the-analyst'],
  ['how does the beginner walkthrough export or share the result', 'docs-beginners-6-export-or-share-what-you-see'],
  ['how does a beginner quit trenchscope safely', 'docs-beginners-7-quit-safely'],
  ['how do I reopen trenchscope another day', 'docs-beginners-reopen-dexterm-later'],
  ['what should a beginner do when trenchscope says command not found', 'docs-beginners-if-dexterm-says-command-not-found'],
  ['what should I do if the terminal screen looks broken', 'docs-beginners-if-the-screen-looks-broken'],
  ['what does unavailable or stale data mean for a beginner', 'docs-beginners-if-data-says-unavailable-stale-or-rate-limited'],
  ['what if optional help is unavailable for a beginner', 'docs-beginners-if-optional-help-is-unavailable'],
  ['what safety rules apply before experimental trading', 'docs-beginners-before-any-experimental-trading'],
];

test(`beginner guide golden set: ${BEGINNER_GOLDEN.length} questions retrieve the exact section without a model`, () => {
  const docs = loadDocsKb();
  const misses: string[] = [];
  for (const [query, expected] of BEGINNER_GOLDEN) {
    const top = searchDocs(query, 1, docs)[0];
    if (top?.id !== expected) misses.push(`"${query}" -> expected ${expected}, got ${top?.id ?? 'nothing'}`);
  }
  assert.equal(misses.length, 0, `beginner retrieval misses:\n  ${misses.join('\n  ')}`);
});

test('beginner golden set has at least twenty unique questions and beginner-only targets', () => {
  assert.ok(BEGINNER_GOLDEN.length >= 20);
  assert.equal(new Set(BEGINNER_GOLDEN.map(([query]) => query)).size, BEGINNER_GOLDEN.length);
  for (const [, id] of BEGINNER_GOLDEN) assert.match(id, /^docs-beginners-/);
});
