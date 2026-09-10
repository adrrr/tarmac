// The rule CLAUDE.md states and nothing enforced: nothing here links to private infrastructure
// or carries a tool-session URL. One such trailer already reached a squashed merge before
// anything looked; published history keeps it, so the guard is for the next one.
//
// The check itself is a shell script, not code in this suite: CI has to run it over the range a
// pull request adds, on a checkout where nothing is built yet. What runs here is that script,
// against throwaway repositories built below — a clean one, one whose commit message carries the
// trailer, one whose tracked file carries the link — plus this repository itself, so that a
// trailer written into a local commit is red before it is pushed rather than after.
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
function run(cwd: string, range?: string): { status: number | null; out: string } {
  const r = spawnSync('sh', range === undefined ? [SCRIPT] : [SCRIPT, range], {
    cwd,
    encoding: 'utf8',
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

test('a tracked file carrying the link fails, naming the file', () => {
  const dir = repo();
  commit(dir, 'notes.md', `see ${LINK}\n`, 'add a note');
  const { status, out } = run(dir);
  assert.equal(status, 1, out);
  assert.match(out, /notes\.md/);
});

// A first push and a force-push both hand the workflow the null sha as a base, and a range
// naming a commit the checkout does not have would make the script error out — skipping the
// check at exactly the moment history is being rewritten. It reads the last commit instead.
test('an unresolvable range falls back to the last commit rather than passing', () => {
  const dir = repo();
  const bad = commit(dir, 'notes.md', 'a plain sentence\n', `say something plain\n\n${TRAILER}\n`);
  const nul = '0'.repeat(40);

  const { status, out } = run(dir, `${nul}..HEAD`);
  assert.equal(status, 1, out);
  assert.match(out, new RegExp(bad));
});

test('this repository is clean by it', () => {
  const { status, out } = run(repoRoot);
  assert.equal(status, 0, out);
});
