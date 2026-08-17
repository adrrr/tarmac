// The release path, asserted where it is written down.
//
// Two guarantees this package sells cannot be checked by running the suite on one Mac —
// and, beside them, one piece of suite hygiene (the runner's deadline and force-exit, #27).
// All are enforced by configuration rather than by code — which is exactly the kind of
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

// A test that never resolves is not a slow test. `node --test` has no deadline of its own, so
// a spawned serve that does not exit, or a pipe that never closes, leaves a runner behind that
// outlives the run rather than failing it — two were found 25 hours old, orphaned to PID 1
// (#27). Two flags, two halves: the deadline turns the hang into a red test, and the
// force-exit turns the run into one that ends — a deadline alone does not buy a report
// (test/bounded.ts:24), and on Node 24/26 the runner it leaves behind is the very orphan
// above. Generous is the point: the slowest test here costs a few seconds, so the floor
// below cannot be what fails a loaded runner.
test('the suite runs under a deadline and a force-exit: a hung test is red, and the run ends', () => {
  const t = scripts()['test'] ?? '';
  const ms = Number(t.match(/--test-timeout[= ](\d+)/)?.[1]);
  assert.ok(ms >= 60_000, 'no generous --test-timeout on the runner: either a hang lives forever, or a floor so low it fails a loaded runner');
  assert.match(t, /--test-force-exit/, 'no --test-force-exit: the deadline reddens a hang, but the runner it leaves behind still outlives the run (#27)');
});
