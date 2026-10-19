// Voice model downloader (task-1408). The whisper.cpp base.en model and the Piper en_GB-alan-medium
// voice are NOT shipped (free-forever rule: no bundled large binaries, no keys). trenchscope downloads them
// on request, and ONLY on request:
//   - from the OFFICIAL source (the ggml-org / rhasspy repositories on Hugging Face),
//   - after EXPLICIT user confirmation (never a silent auto-download),
//   - and verified against a checksum pinned here from the upstream LFS pointer, so a corrupted or
//     tampered download is rejected and never written into place.
//
// This module is pure logic + injected fetch/confirm/log, so it is unit-testable with a fake registry
// and never touches the real network in tests. The CLI (`trenchscope voice download …`) wires the real
// global fetch, a readline y/N prompt, and stdout.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { once } from 'node:events';

/** One file that makes up a model (a model may be several files, e.g. Piper's .onnx + .onnx.json). */
export interface ModelFile {
  url: string;
  dest: string;
  /** Expected sha256 (lowercase hex) from the upstream LFS pointer. Omitted for a tiny config we JSON-validate instead. */
  sha256?: string;
  /** Expected byte size from the upstream LFS pointer (a cheap extra guard). */
  size?: number;
  /** When true, the file is validated by parsing it as JSON rather than by checksum (small configs). */
  validateJson?: boolean;
}

export interface ModelSpec {
  id: string;
  label: string;
  /** One-line note shown in the confirmation prompt (what it is, how big, the license). */
  note: string;
  files: ModelFile[];
}

/** Total download size of a spec, in whole MB (for the prompt). */
export function specSizeMB(spec: ModelSpec): number {
  return Math.round(spec.files.reduce((n, f) => n + (f.size ?? 0), 0) / (1024 * 1024));
}

/**
 * The downloadable voice models, keyed by id. `home` is the trenchscope home (~/.dexterm) so tests can
 * point it at a temp dir. Checksums are pinned from the upstream Hugging Face LFS pointers (verified
 * 2026-10-16): ggerganov/whisper.cpp and rhasspy/piper-voices@v1.0.0.
 */
export function modelRegistry(home: string = join(homedir(), '.dexterm')): Record<string, ModelSpec> {
  const models = join(home, 'models');
  return {
    whisper: {
      id: 'whisper',
      label: 'whisper.cpp base.en (speech-to-text)',
      note: 'whisper.cpp base.en — on-device speech recognition, ~141 MB, MIT (ggml-org/whisper.cpp)',
      files: [{
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
        dest: join(models, 'ggml-base.en.bin'),
        sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
        size: 147964211,
      }],
    },
    'piper-voice': {
      id: 'piper-voice',
      label: 'Piper en_GB-alan-medium (neural voice)',
      note: 'Piper en_GB-alan-medium — British male neural voice, ~61 MB, MIT (rhasspy/piper-voices)',
      files: [
        {
          url: 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/alan/medium/en_GB-alan-medium.onnx',
          dest: join(models, 'en_GB-alan-medium.onnx'),
          sha256: '0a309668932205e762801f1efc2736cd4b0120329622adf62be09e56339d3330',
          size: 63201294,
        },
        {
          url: 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/alan/medium/en_GB-alan-medium.onnx.json',
          dest: join(models, 'en_GB-alan-medium.onnx.json'),
          validateJson: true,
        },
      ],
    },
  };
}

export interface DownloadDeps {
  /** fetch implementation (defaults to global fetch; injected in tests). */
  fetchImpl?: typeof fetch;
  /** Ask the user to confirm the download. Returns true to proceed. Called ONCE, before any download. */
  confirm: (promptText: string) => Promise<boolean>;
  /** Progress / status lines (CLI writes to stdout). */
  log?: (s: string) => void;
}

export type DownloadStatus = 'ok' | 'already' | 'cancelled';

export interface DownloadResult {
  status: DownloadStatus;
  /** Destination paths that are present on disk after the call (verified). */
  files: string[];
}

/** sha256 of an existing file, or null if it cannot be read. */
async function fileSha256(path: string): Promise<string | null> {
  try {
    const h = createHash('sha256');
    h.update(await readFile(path));
    return h.digest('hex');
  } catch { return null; }
}

/** True when `file` is already present AND valid (checksum match, or parses as JSON for config files). */
async function isPresentAndValid(file: ModelFile): Promise<boolean> {
  if (!existsSync(file.dest)) return false;
  if (file.validateJson) {
    try { JSON.parse(await readFile(file.dest, 'utf8')); return true; } catch { return false; }
  }
  if (file.sha256) return (await fileSha256(file.dest)) === file.sha256.toLowerCase();
  return true;
}

/**
 * Download and verify one file. Streams to a `.part` temp alongside the destination (bounded memory),
 * verifies size + sha256 (or JSON), then atomically renames into place. On ANY failure the temp is
 * removed and nothing is written to the destination.
 */
async function downloadFile(file: ModelFile, fetchImpl: typeof fetch, log: (s: string) => void): Promise<void> {
  await mkdir(dirname(file.dest), { recursive: true });
  const tmp = `${file.dest}.part`;
  await rm(tmp, { force: true });
  log(`  ↓ ${file.url}`);
  let res: Response;
  try { res = await fetchImpl(file.url, { redirect: 'follow' }); }
  catch (e) { throw new Error(`download failed (${file.url}): ${(e as Error).message}`); }
  if (!res.ok || !res.body) throw new Error(`download failed (${file.url}): HTTP ${res.status}`);

  const hash = createHash('sha256');
  const out = createWriteStream(tmp);
  let bytes = 0;
  try {
    for await (const chunk of Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])) {
      const buf = chunk as Buffer;
      bytes += buf.length;
      hash.update(buf);
      if (!out.write(buf)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
  } catch (e) {
    out.destroy();
    await rm(tmp, { force: true });
    throw new Error(`download failed (${file.url}): ${(e as Error).message}`);
  }

  // Verify before anything lands at the real path.
  try {
    if (file.size !== undefined && bytes !== file.size) {
      throw new Error(`size mismatch: got ${bytes} bytes, expected ${file.size}`);
    }
    if (file.sha256) {
      const got = hash.digest('hex');
      if (got !== file.sha256.toLowerCase()) throw new Error(`checksum mismatch: got ${got}, expected ${file.sha256}`);
    } else if (file.validateJson) {
      JSON.parse(await readFile(tmp, 'utf8'));
    }
  } catch (e) {
    await rm(tmp, { force: true });
    throw new Error(`verification failed (${file.url}): ${(e as Error).message}`);
  }

  await rename(tmp, file.dest);
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  log(`  ✓ ${file.dest} (${mb} MB${file.sha256 ? ', sha256 ok' : ', json ok'})`);
}

/**
 * Download a model after explicit confirmation. If every file is already present and valid, returns
 * `already` WITHOUT prompting or touching the network. Otherwise it builds a one-prompt summary of what
 * will be fetched and where, calls `confirm()`, and only then downloads + verifies each missing file.
 */
export async function downloadModel(spec: ModelSpec, deps: DownloadDeps): Promise<DownloadResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? (() => {});

  const presence = await Promise.all(spec.files.map(isPresentAndValid));
  const missing = spec.files.filter((_, i) => !presence[i]);
  if (missing.length === 0) {
    log(`${spec.label} is already installed and verified.`);
    return { status: 'already', files: spec.files.map((f) => f.dest) };
  }

  const dir = dirname(spec.files[0].dest);
  const prompt = [
    `Download ${spec.note}`,
    `  from the official source to ${dir}`,
    `  ${missing.length} file${missing.length === 1 ? '' : 's'}, ~${specSizeMB(spec)} MB, checksum-verified. Proceed?`,
  ].join('\n');

  if (!(await deps.confirm(prompt))) {
    log('Cancelled — nothing downloaded.');
    return { status: 'cancelled', files: spec.files.filter((_, i) => presence[i]).map((f) => f.dest) };
  }

  for (const f of missing) await downloadFile(f, fetchImpl, log);
  log(`${spec.label} installed.`);
  return { status: 'ok', files: spec.files.map((f) => f.dest) };
}

/** Which model files exist and verify right now (for a status report; never touches the network). */
export async function modelStatus(spec: ModelSpec): Promise<{ installed: boolean; files: { dest: string; ok: boolean }[] }> {
  const files = await Promise.all(spec.files.map(async (f) => ({ dest: f.dest, ok: await isPresentAndValid(f) })));
  return { installed: files.every((f) => f.ok), files };
}
