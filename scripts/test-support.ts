// Host-portable test seams. Nothing here is imported by production code.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { after, mock, type TestContext } from 'node:test';

/** Keep the exact POSIX assertion, explicitly unsupported on NTFS (not an ACL test).
 * Only this subtest is skipped; callers still run all content/security/behavior checks. */
export async function posixPermissions(t: TestContext, check: () => void): Promise<void> {
  await t.test('POSIX permission bits (NTFS ACL isolation is not verified by chmod)', {
    skip: process.platform === 'win32' ? 'NTFS has no POSIX owner/group/other mode bits; ACL isolation remains unverified' : false,
  }, check);
}

/** Run only the named fake scripts through Node. Windows does not execute a Unix shebang.
 * Real pipes, argv, exit codes and termination still go through child_process.spawn;
 * no shell and no broad replacement of unrelated commands. */
export function useNodeScripts(scripts: Record<string, string>): void {
  const original = childProcess.spawn;
  const replacement = ((command: string, ...rest: unknown[]) => {
    const script = scripts[command];
    if (!script) return Reflect.apply(original, childProcess, [command, ...rest]);
    const args = Array.isArray(rest[0]) ? rest[0] : [];
    const options = Array.isArray(rest[0]) ? rest[1] : rest[0];
    return Reflect.apply(original, childProcess, [process.execPath, [script, ...args], options]);
  }) as typeof childProcess.spawn;
  const stub = mock.method(childProcess, 'spawn', replacement);
  syncBuiltinESMExports();
  after(() => { stub.mock.restore(); syncBuiltinESMExports(); });
}

/** Wait for a real child's handles to close before deleting its SQLite files (Windows).
 * Fail on a leaked child, rather than retrying rm until a broken lifecycle goes unnoticed. */
export async function closeTestSigner(client: { close(): void }): Promise<void> {
  const child = (client as unknown as { child: childProcess.ChildProcess | null }).child;
  if (!child || child.exitCode !== null || child.signalCode !== null) { client.close(); return; }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('signer did not close within 5 seconds')), 5000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    client.close();
  });
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'child actually exited');
}

/** Tests which build a service in-process must release the stores they asked it to open. */
export function closeTestSignerStores(service: unknown): void {
  const stores = service as { d: { ledger: { close(): void } }; liveLedger: { close(): void } | null };
  stores.d.ledger.close();
  stores.liveLedger?.close();
}
