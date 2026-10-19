#!/usr/bin/env node
// Cron-ready local entry point. It produces drafts/cards only and has no posting or scheduling path.
import { larpDetectedCommand } from '../packages/cli/src/larp-detected.ts';

process.exitCode = await larpDetectedCommand(process.argv.slice(2), process);
