// task-1401: the coin-target parser lives in @dexterm/data (shared with the MCP server); re-exported for the CLI.
export { parseMintTarget, parseCoinTarget, resolveCoinTarget, isBareOpen, MINT_RE, type CoinTarget, type CoinVia } from '@dexterm/data';
