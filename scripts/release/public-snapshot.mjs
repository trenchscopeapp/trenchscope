#!/usr/bin/env node
// Publish the current commit to the public repo as one new commit with a neutral author.
//
// The private repo keeps its full history. The public repo (remote `public`, trenchscopeapp/trenchscope) gets
// one commit per publish: the exact tree of HEAD, authored and committed as "trenchscope", parented on the
// public branch's last commit, so its history is linear and carries no private author, email or message.
//
//   node scripts/release/public-snapshot.mjs -m "trenchscope 0.1.6"         publish HEAD
//   node scripts/release/public-snapshot.mjs -m "..." --dry                  show what would be pushed
//   options: --remote public  --branch main  --url git@github.com:trenchscopeapp/trenchscope.git
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const dry = argv.includes('--dry');
const remote = opt('--remote', 'public');
const branch = opt('--branch', 'main');
const url = opt('--url', 'git@github.com:trenchscopeapp/trenchscope.git');
const message = opt('-m', null);
if (!message) { console.error('public-snapshot: give a commit message with -m "..."'); process.exit(2); }

const AUTHOR = { GIT_AUTHOR_NAME: 'trenchscope', GIT_AUTHOR_EMAIL: 'trenchscopeapp@users.noreply.github.com' };
// UTC dates: a local offset (e.g. -0600) would say roughly where the publisher lives
const NOW = `${Math.floor(Date.now() / 1000)} +0000`;
const IDENT = { ...AUTHOR, GIT_COMMITTER_NAME: AUTHOR.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: AUTHOR.GIT_AUTHOR_EMAIL, GIT_AUTHOR_DATE: NOW, GIT_COMMITTER_DATE: NOW };
const git = (args, env = {}) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
const tryGit = (args) => { try { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

if (git(['status', '--porcelain', '--untracked-files=no'])) { console.error('public-snapshot: commit or stash your changes first (the snapshot is HEAD, not the working tree)'); process.exit(1); }
if (tryGit(['remote', 'get-url', remote]) === null) { git(['remote', 'add', remote, url]); console.log(`added remote ${remote} -> ${url}`); }
tryGit(['fetch', '--quiet', remote, branch]);
const parent = tryGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]);
const tree = git(['rev-parse', 'HEAD^{tree}']);
if (parent && git(['rev-parse', `${parent}^{tree}`]) === tree) { console.log(`${remote}/${branch} already has this exact tree; nothing to publish`); process.exit(0); }

// --no-gpg-sign: a signature would tie the public commit to whoever's key signed it
const sha = git(['commit-tree', '--no-gpg-sign', tree, ...(parent ? ['-p', parent] : []), '-m', message], IDENT);
console.log(`snapshot ${sha.slice(0, 12)} of ${git(['rev-parse', '--short', 'HEAD'])} as ${AUTHOR.GIT_AUTHOR_NAME} <${AUTHOR.GIT_AUTHOR_EMAIL}>${parent ? ` on ${parent.slice(0, 12)}` : ' (first commit)'}`);
if (dry) { console.log(`dry run: would push ${sha.slice(0, 12)} to ${remote} ${branch}`); process.exit(0); }
git(['push', remote, `${sha}:refs/heads/${branch}`]);
console.log(`pushed to ${remote} ${branch}`);
