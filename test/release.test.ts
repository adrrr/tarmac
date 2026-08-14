// The release path, asserted where it is written down.
//
// Two guarantees this package sells cannot be checked by running the suite on one Mac, and
// both are enforced by configuration rather than by code — which is exactly the kind of
// thing that gets deleted in a tidy-up and is never noticed:
//
//   • dash. `test/portability.test.ts` SKIPS its POSIX assertion when dash is absent, and a
//     skip exits 0. Without `TARMAC_REQUIRE_DASH=1` on the paths where the claim has to hold
//     — CI and the publish — a green run proves nothing about the shell the wrapper targets.
//   • `dist/`. The suite runs `src/*.ts` through type stripping and never executes the
//     emitted JavaScript, which is the only thing `npx @adrrr/tarmac` runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => fs.readFileSync(path.join(repo, p), 'utf8');
const scripts = (): Record<string, string> => JSON.parse(read('package.json')).scripts as Record<string, string>;

test('the publish path builds, runs the suite with dash required, and executes the artefact', () => {
  const cmd = scripts()['prepublishOnly'] ?? '';
  assert.match(cmd, /TARMAC_REQUIRE_DASH=1/, 'a skipped dash test must not be able to green-light a release');
  assert.match(cmd, /npm test/);
  assert.match(cmd, /npm run build/, 'the artefact is built');
  assert.match(cmd, /dist\/cli\.js/, 'and then actually run — nothing else in the suite ever runs it');
});

test('CI requires dash rather than accepting a skip', () => {
  assert.match(read('.github/workflows/ci.yml'), /TARMAC_REQUIRE_DASH: '1'/);
});

// `engines` is a promise to a stranger's `npx`. The only evidence behind it is a job that
// runs the built CLI on that exact version.
test('CI runs the built CLI on the oldest Node the package claims to support', () => {
  const engines = JSON.parse(read('package.json')).engines as { node: string };
  const oldest = engines.node.match(/(\d+)/)![1];
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, new RegExp(`node-version: '${oldest}'`), `no job pins Node ${oldest}`);
  assert.match(ci, /node dist\/cli\.js --help/);
});
