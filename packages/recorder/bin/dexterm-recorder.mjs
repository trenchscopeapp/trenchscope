#!/usr/bin/env node
// trenchscope history recorder CLI (also reachable as `trenchscope recorder <cmd>`).
//   dexterm-recorder stats  [--db PATH]                      counts, labels, size, bytes per row
//   dexterm-recorder label  [--db PATH]                      run the labeler over every due t0 anchor now
//   dexterm-recorder prune  [--db PATH]                      run the retention job now
//   dexterm-recorder export [--db PATH] [--out FILE] [--since ISO|ms] [--until ISO|ms] [--labelled-only] [--limit N]
//                                                            JSON for the eval harness (stdout when --out is absent)
// The DB defaults to DEXTERM_DB_PATH, else the app's XDG path. Read-only except label/prune.
import { recorderCli } from '../src/cli.ts';

process.exitCode = await recorderCli(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env });
