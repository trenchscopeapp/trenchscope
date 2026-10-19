// @dexterm/data — PKCE (RFC 7636, S256) + opaque state for the Login with X flow (task-1357).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Pkce { verifier: string; challenge: string; method: 'S256' }

const b64url = (b: Buffer) => b.toString('base64url');

/** 64-char verifier (48 random bytes) and its S256 challenge (43 chars). */
export function pkce(rand: (n: number) => Buffer = randomBytes): Pkce {
  const verifier = b64url(rand(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()), method: 'S256' };
}

/** 32-char opaque state (24 random bytes). */
export function oauthState(rand: (n: number) => Buffer = randomBytes): string {
  return b64url(rand(24));
}

/** Constant-time string equality (length leak is fine: the lengths are public). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What the mock server (and any PKCE verifier) checks: S256(verifier) === challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  return safeEqual(b64url(createHash('sha256').update(verifier).digest()), challenge);
}
