---
id: docs-getting-started-running-the-tests
title: Getting started › Install › Running the tests
kind: docs
page: getting-started
page_title: Getting started
heading: Running the tests
anchor: running-the-tests
url: https://dexterm.xyz/docs/getting-started#running-the-tests
tags:
  - docs
  - getting-started
  - running
  - tests
  - install
  - getting
  - started
confidence: high
owner: maintainers
origin: docs-generated
reviewed_by: generated@2026-10-16
generated_from: dexterm/site content/docs (task-1420)
sources:
  - site/content/docs/getting-started.md
date: 2026-10-16
---

From a source checkout, `npm install` and then `npm test` runs the typecheck and three test lanes, in order (from 0.1.4, not in a release yet):

- **parallel**: every `packages/*/test/*.test.ts` file at once, one process each.
- **serial** (`npm run test:serial`, `packages/*/test/serial/`): the tests that drive a real terminal through a pty, run the real binary, or assert a wall-clock bound (the under-a-second quit, the 50 ms filter fuzz). They run one file at a time after the parallel lane, so they never share the CPU with it.
- **perf** (`npm run test:perf`, `packages/*/test/perf/`): the render budget, p95 under 16 ms per frame. It is asserted on the main thread's CPU time every run, and on wall-clock time whenever no other process held the core during the measurement.

A serial or perf test that fails gets one automatic retry, and the retry is never hidden: the run prints the first failure in full and ends with a list of every test that needed it. A test that fails twice fails the run. Set `DEXTERM_TEST_NO_RETRY=1` to turn the retry off. The pty tests open a throwaway cache database, never the one in your data directory.
