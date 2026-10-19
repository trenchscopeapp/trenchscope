#!/usr/bin/env node
// Unsigned SLSA provenance statement for a LOCAL dry run (scripts/release/provenance-statement.mjs).
//
//   node scripts/release/provenance-statement.mjs --dir <release dir> [--builder <id>]
//
// In CI the signed attestation comes from actions/attest-build-provenance (Sigstore-signed, stored in the
// GitHub attestations API, verified with `gh attestation verify`). That cannot run outside GitHub Actions:
// signing needs the workflow's OIDC identity. This script produces the same in-toto statement SHAPE
// (subjects = every line of SHA256SUMS, predicate = SLSA v1 build provenance) without a signature, so the
// dry run can show what the attestation will bind to and scan-results.mjs can be exercised end to end.
// The output is clearly marked unsigned and is never uploaded anywhere.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = parse(process.argv.slice(2));
if (!args.dir) { console.error('usage: provenance-statement.mjs --dir <release dir>'); process.exit(1); }
const DIR = resolve(args.dir);
const sums = readFileSync(join(DIR, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => { const [d, n] = l.split('  '); return { name: n, digest: { sha256: d } }; });
const info = JSON.parse(readFileSync(join(DIR, 'build-info.json'), 'utf8'));
const builder = args.builder || 'local-dry-run (UNSIGNED; CI uses https://github.com/actions/runner/github-hosted via actions/attest-build-provenance)';
const statement = {
  _type: 'https://in-toto.io/Statement/v1',
  subject: sums,
  predicateType: 'https://slsa.dev/provenance/v1',
  predicate: {
    buildDefinition: {
      buildType: 'https://actions.github.io/buildtypes/workflow/v1',
      externalParameters: { workflow: { ref: info.ci?.refName ? `refs/tags/${info.ci.refName}` : info.ref, repository: info.ci?.repository ? `https://github.com/${info.ci.repository}` : '<repository url pending>', path: '.github/workflows/release.yml' } },
      internalParameters: { github: { event_name: 'push' } },
      resolvedDependencies: [{ uri: `git+${info.ci?.repository ? 'https://github.com/' + info.ci.repository : '<repository url pending>'}@${info.ref}`, digest: { gitCommit: info.commit } }],
    },
    runDetails: { builder: { id: builder }, metadata: { invocationId: info.ci?.runUrl || 'local-dry-run', startedOn: info.builtAt } },
  },
  'x-dexterm': { unsigned: true, note: 'LOCAL DRY RUN. No signature, no Sigstore entry, not verifiable with gh attestation verify. The real attestation is produced by GitHub Actions.' },
};
writeFileSync(join(DIR, 'provenance.UNSIGNED.intoto.json'), JSON.stringify(statement, null, 2) + '\n');
console.log(`provenance.UNSIGNED.intoto.json: ${sums.length} subjects (${sums.map((s) => s.name).join(', ')})`);
function parse(argv) { const o = {}; for (let i = 0; i < argv.length; i++) { const k = argv[i].replace(/^--/, ''); const v = argv[i + 1]; if (v && !v.startsWith('--')) { o[k] = v; i++; } else o[k] = true; } return o; }
