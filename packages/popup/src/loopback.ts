// The one URL pin every popup path goes through (task-1290 follow-up): a popup may only load, navigate to,
// or be launched in a browser at OUR loopback server origin, http://127.0.0.1:<port>/… — never a remote
// page (ROADMAP "no remote content"), never another local service.
//
// This is a parsed comparison, not a string prefix: `http://127.0.0.1:1@evil.example/` has host
// evil.example (the "127.0.0.1:1" is userinfo), so a prefix match on "http://127.0.0.1:" passes it and a
// parsed one refuses it. Any userinfo is refused outright, even to our own host, so the launched URL can
// never carry a credential-shaped prefix. The hostname must be exactly 127.0.0.1 after WHATWG
// normalisation (so `0x7f.1`, `2130706433`, `127.0.0.%31` and `HTTP://` all resolve to our host and
// pass — they ARE 127.0.0.1 — while `localhost`, `[::1]`, `127.0.0.1.evil.example` and `evil.example`
// are refused: the server only answers `Host: 127.0.0.1:<port>`). The port must equal the server's
// (an http:// URL with no explicit port means 80).
//
// The wry shell applies the same rule in Rust (shell/wry/src/main.rs `nav_allowed`) as defence in depth.

/** Why `raw` is not an allowed popup URL for the server on `port`, or null when it is allowed. */
export function loopbackUrlProblem(raw: string, port: number): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return `popup url is not a valid URL: ${raw}`; }
  if (u.protocol !== 'http:') return `popup url must be an http:// loopback url, got ${u.protocol}//`;
  if (u.username !== '' || u.password !== '') return 'popup url must not carry userinfo (user:pass@)';
  if (u.hostname !== '127.0.0.1') return `popup url host must be 127.0.0.1, got ${u.hostname || '(empty)'}`;
  if ((u.port || '80') !== String(port)) return `popup url port must be the popup server's (${port}), got ${u.port || '(default)'}`;
  return null;
}

/** The normalised URL when allowed (see loopbackUrlProblem); throws otherwise. */
export function assertLoopbackUrl(raw: string, port: number): string {
  const problem = loopbackUrlProblem(raw, port);
  if (problem) throw new Error(problem);
  return new URL(raw).toString();
}

/** True when `raw` is an http:// URL at exactly 127.0.0.1 with no userinfo (and on `port`, when given). */
export function isLoopbackUrl(raw: string, port?: number): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' || u.username !== '' || u.password !== '' || u.hostname !== '127.0.0.1') return false;
  return port === undefined || (u.port || '80') === String(port);
}
