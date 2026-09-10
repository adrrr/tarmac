// The rule CLAUDE.md states and nothing enforced: nothing here links to private infrastructure
// or carries a tool-session URL. One such trailer already reached a squashed merge before
// anything looked; published history keeps it, so the guard is for the next one.
//
// The check itself is a shell script, not code in this suite: CI has to run it over the range a
// pull request adds, on a checkout where nothing is built yet. What runs here is that script,
// against throwaway repositories built below, never against this one.
//
// That last part is deliberate. Running it over this repository would look like the stronger
// promise and would be a trap: `squash_merge_commit_message` is COMMIT_MESSAGES here, so a
// branch whose commits carry a trailer lands it in main's message, and every leg of the matrix
// would then go red for a reason that has nothing to do with the code — `prepublishOnly` runs
// this suite, so it would block publishing until somebody wrote an empty commit. The job in
// `ci.yml` is where the rule is enforced, at the one moment it can still be acted on.
//
// Every offending string below is assembled from fragments on purpose. This file is tracked, and
// the tracked-file half of the script would otherwise report its own fixtures.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './sandbox.ts';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(repoRoot, 'scripts', 'no-session-links.sh');

const LINK = ['https://claude', '.ai/code/', 'session_', '01ABCdef'].join('');
const TRAILER = `${['Claude', '-Session:'].join('')} ${LINK}`;

/**
 * The three shapes the check is made of, each carrying ONE of them. A fixture holding all three
 * at once — the trailer above, which is what actually slipped through — cannot tell which of the
 * three caught it: dropping a branch of the pattern left the suite green under it.
 */
const ALONE = {
  'a bare link': ['https://claude', '.ai/code/', 'x'].join(''),
  'a session id': ['session_', '01ABCdef'].join(''),
  'a trailer with no URL in it': ['Claude', '-Session: internal'].join(''),
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

/** A repository of its own, one clean commit in it, owing nothing to the caller's git config. */
function repo(): string {
  const dir = tempDir('tarmac-hygiene-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  commit(dir, 'README.md', 'nothing to see here\n', 'first commit');
  return dir;
}

function commit(dir: string, file: string, body: string, message: string): string {
  fs.writeFileSync(path.join(dir, file), body);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

/**
 * The script, under `sh` — which is dash on the Ubuntu leg of CI, bash on macOS. The same job
 * runs shellcheck over it in dash mode, so the one shell that matters is checked twice.
 */
function run(cwd: string, range?: string, pathPrefix?: string): { status: number | null; out: string } {
  const r = spawnSync('sh', range === undefined ? [SCRIPT] : [SCRIPT, range], {
    cwd,
    encoding: 'utf8',
    env: pathPrefix ? { ...process.env, PATH: `${pathPrefix}:${process.env.PATH}` } : process.env,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

test('a range of clean commits passes', () => {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  commit(dir, 'notes.md', 'a plain sentence\n', 'say something plain');
  const { status, out } = run(dir, `${base}..HEAD`);
  assert.equal(status, 0, out);
});

test('a session trailer in a commit message fails, naming the sha and the line', () => {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  const bad = commit(dir, 'notes.md', 'a plain sentence\n', `say something plain\n\n${TRAILER}\n`);

  const { status, out } = run(dir, `${base}..HEAD`);
  assert.equal(status, 1, out);
  assert.match(out, new RegExp(bad), 'the sha to look at');
  assert.match(out, /^ +3:/m, 'and the line of the message that made it fail');
});

test('each of the three shapes fails on its own', () => {
  for (const [what, text] of Object.entries(ALONE)) {
    const dir = repo();
    const base = git(dir, 'rev-parse', 'HEAD').trim();
    const bad = commit(dir, 'notes.md', 'a plain sentence\n', `say something plain\n\n${text}\n`);

    const { status, out } = run(dir, `${base}..HEAD`);
    assert.equal(status, 1, `${what}: ${out}`);
    assert.match(out, new RegExp(bad), what);
  }
});

// The two halves are independent, and CI only ever exercises them together: it always passes a
// range. Each is therefore asserted in the OTHER half's configuration too — a range whose commits
// are clean, and no range at all — or a script that answered for one and skipped the other would
// still have looked green here.
test('the commits in the middle of a range are read, not just its tip', () => {
  const dir = repo();
  const base = git(dir, 'rev-parse', 'HEAD').trim();
  const bad = commit(dir, 'a.md', 'one\n', `first\n\n${TRAILER}\n`);
  commit(dir, 'b.md', 'two\n', 'second');
  commit(dir, 'c.md', 'three\n', 'third');

  const { status, out } = run(dir, `${base}..HEAD`);
  assert.equal(status, 1, out);
  assert.match(out, new RegExp(bad));
});

test('with no range, the last commit is still read', () => {
  const dir = repo();
  const bad = commit(dir, 'notes.md', 'a plain sentence\n', `say something plain\n\n${TRAILER}\n`);
  const { status, out } = run(dir);
  assert.equal(status, 1, out);
  assert.match(out, new RegExp(bad));
});

test('a tracked file carrying the link fails, naming the file, range or no range', () => {
  for (const range of [undefined, 'HEAD~1..HEAD']) {
    const dir = repo();
    commit(dir, 'notes.md', `see ${LINK}\n`, 'add a note');
    const { status, out } = run(dir, range);
    assert.equal(status, 1, `${range}: ${out}`);
    assert.match(out, /notes\.md/);
  }
});

// What is committed is what is published, and it is not always what is on disk: a file can be
// committed with the link and cleaned in the working tree afterwards, and `working-tree-encoding`
// can hand a reader something other than the blob. The index is what a push carries, so the index
// is what is read.
test('a link committed and then cleaned in the working tree still fails', () => {
  const dir = repo();
  commit(dir, 'notes.md', `see ${LINK}\n`, 'add a note');
  fs.writeFileSync(path.join(dir, 'notes.md'), 'nothing to see here\n');

  const { status, out } = run(dir);
  assert.equal(status, 1, out);
  assert.match(out, /notes\.md/);
});

// A range can name a commit the checkout does not have, and erroring out there would skip the
// check at exactly the moment history is being rewritten. Two ways in, and they are not the same
// one: the first push to a branch has no base and the payload carries a null sha, while after a
// force-push the base is a real sha whose object is unreachable and therefore never fetched.
// Either way the last commit is read instead.
test('an unresolvable range falls back to the last commit rather than passing', () => {
  const dir = repo();
  const bad = commit(dir, 'notes.md', 'a plain sentence\n', `say something plain\n\n${TRAILER}\n`);
  const nul = '0'.repeat(40);

  const { status, out } = run(dir, `${nul}..HEAD`);
  assert.equal(status, 1, out);
  assert.match(out, new RegExp(bad));
});

// The line the script's own comment calls the point of the exercise: a guard that reports a clean
// tree because it could not read one is worth less than no guard at all. Nothing else here can
// ask for it, so the search is made to fail from outside, by a git that refuses that one verb.
test('a search that could not run is exit 2, never a clean tree', () => {
  const dir = repo();
  const bin = tempDir('tarmac-hygiene-bin-');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/sh\nif [ "$1" = grep ]; then exit 128; fi\nexec ${realGit} "$@"\n`,
    { mode: 0o755 },
  );

  const { status, out } = run(dir, undefined, bin);
  assert.equal(status, 2, out);
  assert.match(out, /could not read/);
});
