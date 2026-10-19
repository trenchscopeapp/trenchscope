// @dexterm/agents — public surface (task-1345). Nothing in this package can arm, sign, confirm, send,
// raise a cap, change the confirmation gate, or touch a wallet, a mandate or the signer: the tier table
// has no such tool and the gate refuses the shape of such a request before any lookup.
export * from './tiers.ts';
export * from './identity.ts';
export * from './audit.ts';
export * from './schema.ts';
export * from './gate.ts';
// tier 2 (task-1345): transports — the tool table, the loopback WebSocket, the bus, the executor/feed,
// the proposal store. The SDK is a separate entry point (./sdk) so an external agent imports only it.
export * from './tools.ts';
export * from './ws.ts';
export * from './executor.ts';
export * from './proposals.ts';
export * from './bus.ts';
// task-1406 "watch the agent cook": the spectator event model + redaction + save/replay, the local
// follow-mode controller (pause / take over / kill), and the read-only loopback spectator stream.
export * from './spectator.ts';
export * from './follow.ts';
export * from './spectator-server.ts';
