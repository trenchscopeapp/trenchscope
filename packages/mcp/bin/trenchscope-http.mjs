#!/usr/bin/env node
import { createPublicMcp } from '../src/http.ts';
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
const server = createPublicMcp({ revision: process.env.RAILWAY_GIT_COMMIT_SHA });
server.listen(port, '0.0.0.0', () => process.stderr.write(`trenchscope MCP listening on port ${port}\n`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 10_000).unref(); });
