// @dexterm/recorder public surface (lane R-01).
export * from './schema.ts';
export * from './snapshot.ts';
export * from './labels.ts';
export * from './sweep.ts';
export * from './recorder.ts';
export * from './export.ts';
export * from './open.ts';
export * from './verdicts.ts';
export * from './schedule.ts';
export * from './dev-history.ts';
export { recorderCli, RECORDER_HELP, type CliIo } from './cli.ts';

/** `--no-recorder` / `DEXTERM_RECORDER=0` resolution: the recorder is on in live mode unless either says no. */
export function recorderEnabled(env: NodeJS.ProcessEnv, flagOff: boolean): boolean {
  if (flagOff) return false;
  const v = env.DEXTERM_RECORDER;
  if (v === undefined || v === '') return true;
  return !(v === '0' || v.toLowerCase() === 'off' || v.toLowerCase() === 'false' || v.toLowerCase() === 'no');
}
