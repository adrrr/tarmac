// The CHANGELOG's published sections, held against the tags that published them.
//
// A branch cut before a release commit carries its entry against the pre-release blob: the
// bullet sits under `## [Unreleased]`, and so does the heading the release later renamed. Git
// resolves that as a clean 3-way merge — no conflict, nothing to review — and parks the bullet
// inside the section the release just dated. The merged tree then claims a tarball that is
// already on the registry contains a change it does not. Twice in one morning (#78, #79), CI
// green both times, caught only by eye.
//
// Nothing else here can catch it. The suite reads the CHANGELOG nowhere, `npm pack` does not
// ship it, and a diff that adds a bullet to a released section is indistinguishable at a glance
// from one that adds a bullet to `Unreleased` — the heading is often off-screen. The tags are
// the only record of what each version actually said, so they are what this file compares
// against: for every `vX.Y.Z`, the section in the working tree must still be what
// `git show vX.Y.Z:CHANGELOG.md` says it was.
//
// Published sections are append-only in one direction only — a new one is added above them and
// they are never touched again. Editing history that has shipped is not a typo fix; it is a
// claim about a tarball nobody can change.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `git`, anchored on the repository rather than on the runner's working directory — `node
 * --test` is run from wherever the caller happens to stand, and a relative `git show` would
 * read a different repository, or none.
 *
 * Returns null on any failure, so the caller decides what a missing answer means. Every caller
 * here decides it is a failure: this file exists because a guard that cannot run is worth less
 * than no guard at all, having the shape of one.
 */
function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

/**
 * The section a version owns: its `## [x.y.z] — date` heading and everything under it, up to
 * the next `## ` heading or the end of the file.
 *
 * The heading is part of the section on purpose. Re-dating a release that has shipped is the
 * same lie as re-writing its bullets, and the date is the half a merge is least likely to
 * touch and a tidy-up most likely to.
 *
 * Compared after `trimEnd`: how many blank lines separate a section from the next heading is a
 * property of its neighbour, not of the release, and it changes whenever a new version is
 * added above. Every real artefact — a bullet added, removed, reworded, a date moved — survives
 * that trim.
 */
function section(changelog: string, version: string): string | null {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return null;
  const after = lines.slice(start + 1).findIndex((l) => l.startsWith('## '));
  const end = after === -1 ? lines.length : start + 1 + after;
  return lines.slice(start, end).join('\n').trimEnd();
}

/** The first line at which two sections part company, for a message that points at the edit. */
function firstDifference(tagged: string, current: string): string {
  const a = tagged.split('\n');
  const b = current.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}\n    tagged:  ${a[i] ?? '(section ends)'}\n    current: ${b[i] ?? '(section ends)'}`;
    }
  }
  return '(no differing line — the sections differ only in length)';
}

test('every published CHANGELOG section still says what it said when it was tagged', () => {
  const listed = git('tag', '--list', 'v*');
  assert.ok(
    listed !== null,
    'git could not list tags in this checkout, so this guard cannot compare anything — it fails rather than pass on nothing',
  );

  const versions = listed
    .split('\n')
    .map((l) => l.trim())
    .map((l) => /^v(\d+\.\d+\.\d+)$/.exec(l)?.[1])
    .filter((v): v is string => v !== undefined);

  // The failure this whole file is built to avoid, one level up. A shallow checkout has no
  // tags, every loop below runs zero times, and the run is green having asserted nothing —
  // a guard reporting success for the one reason it should report alarm. `actions/checkout`
  // fetches no tags by default, which is why the CI assertion below is not optional.
  assert.ok(
    versions.length > 0,
    'no vX.Y.Z tags in this checkout: the comparison below would pass on an empty list. Run `git fetch --tags` (a shallow clone has none) — this guard reads the tags or it fails.',
  );

  const current = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8');

  for (const version of versions) {
    const taggedFile = git('show', `v${version}:CHANGELOG.md`);
    assert.ok(taggedFile !== null, `v${version} has no CHANGELOG.md, so what it published cannot be read`);

    const was = section(taggedFile, version);
    const now = section(current, version);

    assert.ok(was !== null, `v${version} shipped without a \`## [${version}]\` section of its own — nothing records what it released`);
    assert.ok(
      now !== null,
      `the \`## [${version}]\` section has disappeared from the CHANGELOG, but v${version} is published and said something`,
    );
    // `ok` rather than `equal`: a section runs to fifty lines of prose, and the two that
    // `equal` prints bury the sentence that says what to do under six kilobytes of text that
    // reads as identical. The line named below is the whole of what a reader needs.
    assert.ok(
      now === was,
      `the \`## [${version}]\` section no longer matches what v${version} published — most likely an entry merged into a section that had already shipped (a branch cut before the release commit), so move it to \`## [Unreleased]\`. First difference at ${firstDifference(was, now)}`,
    );
  }
});

// The guard above reads tags, and `actions/checkout` fetches none: its default `fetch-depth: 1`
// downloads a single commit, and git's tag auto-following only picks up tags pointing at
// objects it downloaded — which, at depth 1, is none of them.
//
// `fetch-tags: true` does NOT fix that. With `fetch-depth` above zero, checkout builds a refspec
// for the requested branch alone and `fetch-tags` merely suppresses `--no-tags`, leaving the
// auto-follow that already reaches nothing. Only `fetch-depth: 0` swaps in the all-history
// refspec, which carries `+refs/tags/*:refs/tags/*` — the tags are fetched by name rather than
// hoped for. It costs nothing worth counting here: this repository's full history packs smaller
// than a depth-1 clone plus tags.
//
// Asserted rather than commented because the guard's silence would be the symptom, and the
// message on that silence would send the reader hunting through git rather than through a diff
// that removed one line from a workflow.
test('CI fetches the tags the guard above reads', () => {
  const ci = fs.readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8');
  const jobs = ci.split(/^jobs:$/m)[1] ?? '';
  const blocks = jobs.split(/^ {2}(?=[A-Za-z_])/m).slice(1);
  assert.ok(blocks.length > 0, 'no CI jobs matched — the assertion that follows would pass on nothing');

  const running = blocks.filter((b) => /run: npm test/.test(b));
  assert.ok(running.length > 0, 'no CI job runs `npm test` — the guard above never runs in CI');

  const shallow = running.filter((b) => !/fetch-depth: 0/.test(b)).map((b) => b.slice(0, b.indexOf(':')));
  assert.deepEqual(
    shallow,
    [],
    `CI jobs running the suite without \`fetch-depth: 0\` on their checkout: ${shallow.join(', ')} — with no tags fetched, the CHANGELOG guard compares nothing and passes`,
  );
});
