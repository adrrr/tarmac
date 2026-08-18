// The release path, asserted where it is written down.
//
// Two guarantees this package sells cannot be checked by running the suite on one Mac —
// and, beside them, one piece of suite hygiene (what the runner is and is not allowed to
// pass, #27 and #63). All are enforced by configuration rather than by code — which is
// exactly the kind of thing that gets deleted in a tidy-up and is never noticed:
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
// a test that hangs outlives the run instead of failing it — two runners were found 25 hours
// old, orphaned to PID 1 (#27). The deadline stays, and generous is the point: the slowest
// test here costs a few seconds, so the floor below cannot be what fails a loaded runner.
//
// `--test-force-exit` shipped beside it and does NOT stay, which is what the second assertion
// is for (#63). The runner passes it down to the per-file child it spawns, and that child's
// stdout is a pipe back to the runner. A pipe is written asynchronously on macOS, so the
// `process.exit()` the flag performs throws away whatever is still queued — the tail of that
// file's report. The runner tallies what reached it, finds no failure in what it never
// received, and prints a smaller total under exit 0. Measured here with the runner held busy:
// `test/fleet.test.ts` delivered 34 of its 45 tests and the run stayed green.
//
// That is the one failure a suite may not have, and it is strictly worse than the hang the
// flag was bought to prevent, because a hang is loud. The deadline reddens the hangs it can
// see; the CI job deadline asserted below fails the job for the ones it cannot.
test('the suite runs under a deadline, and never under a force-exit', () => {
  const t = scripts()['test'] ?? '';
  const ms = Number(t.match(/--test-timeout[= ](\d+)/)?.[1]);
  assert.ok(ms >= 60_000, 'no generous --test-timeout on the runner: either a hang lives forever, or a floor so low it fails a loaded runner');
  assert.doesNotMatch(t, /--test-force-exit/, '--test-force-exit truncates a busy child\'s report: the run under-counts and still exits 0 (#63)');
});

// The other half of that trade. Without the force-exit a leaked handle hangs the run rather
// than ending it, which is only "loud" where something is watching the clock — and a hung CI
// job that nobody fails waits out the runner's own six-hour ceiling.
test('every CI job carries a deadline, so a hang fails instead of waiting', () => {
  const jobs = read('.github/workflows/ci.yml').split(/^jobs:$/m)[1] ?? '';
  const names = jobs.match(/^ {2}[a-z][\w-]*:$/gm) ?? [];
  const deadlines = jobs.match(/^ {4}timeout-minutes: \d+$/gm) ?? [];
  assert.ok(names.length > 0, 'no CI jobs matched — the count that follows would pass on nothing');
  assert.equal(deadlines.length, names.length, `${names.length} CI jobs, ${deadlines.length} with timeout-minutes: a job without one waits out a hang instead of failing it`);
});
