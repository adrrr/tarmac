// The CHANGELOG's published sections, held against the tags that published them.
//
// A release does not rename `## [Unreleased]`; it inserts a dated heading beneath it, and the
// `### Changed` block below stays exactly where it was — the bullets do not move, they simply
// come to belong to a new section. So a branch cut before that commit, which appends its own
// bullet after the very same `### Changed`, merges against unchanged context: git resolves it
// as a clean 3-way merge, no conflict, nothing to review, and the bullet lands inside the
// section the release just dated. The merged tree then claims a tarball that is already on the
// registry contains a change it does not. Twice in one morning (#78, #79), CI green both times,
// caught only by eye.
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
//
// The guard is worth exactly the tags it can see, which is why the second test below is not a
// nicety: a checkout carrying SOME of them would quietly check some of the sections and report
// success. It compares the dated sections against the tags that ought to exist, and the version
// tagging began at is written down rather than measured — measuring it from the tags present is
// circular, and would excuse exactly the partial fetch it is meant to catch.
//
// `0.1.0`, `0.1.1` and `0.1.2` shipped before this repository tagged anything, and they are the
// one thing here nothing can vouch for: there is no record of what they said. They sit below the
// floor, deliberately and in writing, rather than being quietly skipped.
//
// One limit of WHEN it runs, since the merge is the moment the damage is done: on a pull request
// CI reads the merge ref — main with the branch folded in, which is the tree that would land — so
// a bullet parked in a published section is caught before it lands rather than after. What is not
// caught there is a merge nothing ran on: the resolution is then judged on main's push, red after
// the fact. Never later than that, though — `prepublishOnly` runs this suite again, so no tarball
// leaves with a rewritten section behind it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => fs.readFileSync(path.join(repo, p), 'utf8');

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
 * Which lines are section headings, which is not the same question as which lines start with
 * `## `.
 *
 * A `## ` inside a code fence is not a heading. No entry carries a fence today, but the day one
 * quotes a markdown sample the boundary would move — identically in both trees, which is the bad
 * way for it to be wrong: the sections would still compare equal while everything below the
 * fence went unread. `###` is not a boundary either; it is the `Added`/`Changed`/`Fixed` level.
 *
 * `fenceLeftOpen` is reported rather than ignored because the failure it causes is a lie: one
 * unclosed fence hides every heading after it, and a section that is plainly there is then
 * reported as having disappeared.
 */
function scan(changelog: string): { lines: string[]; isHeading: boolean[]; fenceLeftOpen: boolean } {
  const lines = changelog.split('\n');
  const isHeading: boolean[] = [];
  let fenced = false;
  for (const line of lines) {
    // A fence marker is never a heading, and flips what the lines after it are.
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      isHeading.push(false);
      fenced = !fenced;
      continue;
    }
    // `## [` and not `## `: a non-version H2 (a "Migration notes" someone adds one day) would
    // be a section boundary in BOTH trees — cutting the comparison symmetrically, the same
    // silent truncation the fence handling above exists to prevent.
    isHeading.push(!fenced && line.startsWith('## ['));
  }
  return { lines, isHeading, fenceLeftOpen: fenced };
}

/**
 * The section a version owns: its `## [x.y.z] — date` heading and everything under it, up to
 * the next heading or the end of the file.
 *
 * The heading is part of the section on purpose. Re-dating a release that has shipped is the
 * same lie as re-writing its bullets, and the date is the half a merge is least likely to
 * touch and a tidy-up most likely to.
 *
 * Compared after `trimEnd`: how many blank lines separate a section from the next heading is a
 * property of its neighbour, not of the release, and it changes whenever a new version is
 * added above. Every real artefact — a bullet added, removed, reworded, a date moved — survives
 * that trim.
 *
 * `findIndex` takes the FIRST heading a version owns, so a second copy of one — what a botched
 * merge or a revert leaves behind — is never read, and an edit sitting in it never compared.
 * Nothing here closes that; the duplicate-heading assertion in the second test below is what
 * does. Weaken that one and this reader silently gets its blind spot back.
 */
function section(changelog: string, version: string): string | null {
  const { lines, isHeading } = scan(changelog);
  const start = lines.findIndex((l, i) => isHeading[i] && l.startsWith(`## [${version}]`));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isHeading[i]) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

/** Every version that owns a dated section, in the order the file gives them. */
function datedVersions(changelog: string): string[] {
  const { lines, isHeading } = scan(changelog);
  return lines
    .filter((_, i) => isHeading[i])
    .map((l) => /^## \[(\d+\.\d+\.\d+)\]/.exec(l)?.[1])
    .filter((v): v is string => v !== undefined);
}

/** Numeric precedence, so `0.10.0` sorts above `0.9.0` rather than below it. */
function atLeast(a: string, b: string): boolean {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
}

/**
 * The tags that name a release, each kept beside the version it spells: one is what `git show`
 * is given, the other is what the heading says, and they are not the same string.
 *
 * Releases only — a prerelease documents itself under the version it is a candidate for, so
 * `v1.0.0-rc.1` has no section of its own to compare.
 */
function taggedReleases(): { tag: string; version: string }[] {
  const listed = git('tag', '--list');
  assert.ok(
    listed !== null,
    'git could not list tags in this checkout, so this guard cannot compare anything — it fails rather than pass on nothing',
  );
  return listed
    .split('\n')
    .map((l) => l.trim())
    .map((tag) => ({ tag, version: /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1] }))
    .filter((r): r is { tag: string; version: string } => r.version !== undefined);
}

/**
 * The first line at which two sections part company, for a message that points at the edit.
 *
 * The walk runs to the LONGER of the two, so a section that was simply truncated parts company
 * where the shorter one ends — `undefined` against a line, reported as `(section ends)`. There
 * is therefore no "same, only shorter" case for the loop to fall through on, whatever the older
 * message below used to claim: what reaches the last line is two sections that are equal, and
 * every caller has already ruled that out before asking.
 */
function firstDifference(tagged: string, current: string): string {
  const a = tagged.split('\n');
  const b = current.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return `line ${i + 1}\n    tagged:  ${a[i] ?? '(section ends)'}\n    current: ${b[i] ?? '(section ends)'}`;
    }
  }
  return '(no differing line — the sections are identical)';
}

test('every published CHANGELOG section still says what it said when it was tagged', () => {
  const releases = taggedReleases();

  // The failure this whole file is built to avoid, one level up. A shallow checkout has no
  // tags, the loop below runs zero times, and the run is green having asserted nothing — a
  // guard reporting success for the one reason it should report alarm.
  assert.ok(
    releases.length > 0,
    'no vX.Y.Z tags in this checkout: the comparison below would pass on an empty list. Run `git fetch --tags` (a shallow clone has none) — this guard reads the tags or it fails.',
  );

  const current = read('CHANGELOG.md');
  assert.ok(
    !scan(current).fenceLeftOpen,
    'the CHANGELOG leaves a code fence open: every heading after it stops being read as one, so the sections below would be reported as missing when they are plainly there',
  );

  for (const { tag, version } of releases) {
    const taggedFile = git('show', `${tag}:CHANGELOG.md`);
    assert.ok(taggedFile !== null, `${tag} has no CHANGELOG.md, so what it published cannot be read`);

    const was = section(taggedFile, version);
    const now = section(current, version);

    assert.ok(was !== null, `${tag} shipped without a \`## [${version}]\` section of its own — nothing records what it released`);
    assert.ok(
      now !== null,
      `the \`## [${version}]\` section has disappeared from the CHANGELOG, but ${tag} is published and said something`,
    );
    // `ok` rather than `equal`: a section runs to fifty lines of prose, and the two that
    // `equal` prints bury the sentence that says what to do under six kilobytes of text that
    // reads as identical. The line named below is the whole of what a reader needs.
    assert.ok(
      now === was,
      `the \`## [${version}]\` section no longer matches what ${tag} published — most likely an entry merged into a section that had already shipped (a branch cut before the release commit), so move it to \`## [Unreleased]\`. First difference at ${firstDifference(was, now)}`,
    );
  }
});

// What the comparison above cannot say for itself: it checks the versions it finds tags for, and
// is silent about the rest. One tag present is enough to satisfy its floor, and four sections
// then go unread while the suite reports success.
//
// That is not a hypothesis. `fetch-tags: true` at `fetch-depth: 1` delivers exactly the tag on
// the commit it downloaded — which, on a push to `main` straight after a release, is the tag just
// created. The cheap-looking workflow fix would therefore have produced this state, and it is
// worse than fetching nothing: zero tags fails loudly, one tag passes quietly.
test('every dated section since tagging began carries the tag that published it', () => {
  const releases = taggedReleases();
  assert.ok(releases.length > 0, 'no vX.Y.Z tags in this checkout, so nothing can be said about which sections are covered');

  const current = read('CHANGELOG.md');
  const dated = datedVersions(current);
  assert.ok(dated.length > 0, 'no dated sections in the CHANGELOG — the assertions that follow would pass on nothing');

  // A duplicated heading is broken for a reader whatever this file thinks, and it also splits a
  // version in two, of which only the first is ever compared — a merge or a revert can leave
  // exactly that, with the pristine copy on top and the rewritten one below. This assertion is
  // the only thing standing in front of that: `section()` reads the first heading and stops, so
  // weakening the line below hands the test above a blind spot rather than a failure.
  const counted = new Map<string, number>();
  for (const v of dated) counted.set(v, (counted.get(v) ?? 0) + 1);
  const duplicated = [...counted].filter(([, n]) => n > 1).map(([v]) => v);
  assert.deepEqual(duplicated, [], `versions with more than one dated section: ${duplicated.join(', ')} — only the first is ever read`);

  // The floor is a fact about this project's history, not about this checkout, and that is the
  // whole point. Deriving it from the tags present would be circular: a checkout carrying only
  // `v0.5.0` would set the floor at 0.5.0, excuse the four sections below it, and report success
  // on precisely the partial fetch this test exists to catch. Written down, it cannot move when
  // the evidence does. It only ever needs lowering — a version released after 0.2.0 is covered
  // by construction.
  const TAGGING_BEGAN_AT = '0.2.0';
  const tagged = new Set(releases.map((r) => r.version));
  const unvouched = dated.filter((v) => atLeast(v, TAGGING_BEGAN_AT) && !tagged.has(v));
  assert.deepEqual(
    unvouched,
    [],
    `dated sections at or above ${TAGGING_BEGAN_AT} with no matching tag: ${unvouched.join(', ')} — nothing records what they published, so the comparison above skips them in silence. Either the tag is missing from this checkout (\`git fetch --tags\`), or you are mid-release — the changelog is dated and \`npm version\` has not run yet (finish the release) — or the release was never tagged.`,
  );
});

// The tests above read tags, and `actions/checkout` fetches none by default: at `fetch-depth: 1`
// it passes `--no-tags`, so not one arrives.
//
// `fetch-tags: true` is the obvious cheaper fix and it is the wrong one. Above depth zero
// checkout builds a refspec for the requested branch alone and `fetch-tags` only suppresses
// `--no-tags`, leaving git's tag auto-following — which picks up tags pointing at objects it
// downloaded. At depth 1 that is one commit: nothing on a normal push, and precisely the new tag
// on the push that follows a release. A single tag is worse than none, because none is loud.
// Only `fetch-depth: 0` swaps in the all-history refspec, which names `+refs/tags/*:refs/tags/*`
// and fetches them all by name rather than hoping. It costs nothing worth counting here: this
// repository's full history packs smaller than a depth-1 clone plus its tags.
//
// Asserted rather than commented because the guard's silence would be the symptom, and the
// message on that silence would send the reader hunting through git rather than through a diff
// that removed one line from a workflow.
test('CI fetches the tags the guards above read', () => {
  const jobs = read('.github/workflows/ci.yml').split(/^jobs:$/m)[1] ?? '';
  const blocks = jobs.split(/^ {2}(?=[A-Za-z_])/m).slice(1);
  assert.ok(blocks.length > 0, 'no CI jobs matched — the assertion that follows would pass on nothing');

  // `- run: npm test` on one line is how this workflow spells it, and the only spelling read: a
  // block scalar (`run: |`, the command on the next line) is invisible here — the shape the same
  // workflow already uses for its longer steps. Narrow rather than broken today, because ONE job
  // runs the suite: rewrite that one and the assertion below fires. A SECOND job, added in block
  // form, is what would slip past the fetch-depth check in silence.
  const running = blocks.filter((b) => /run: npm (run )?test\b/.test(b));
  assert.ok(running.length > 0, 'no CI job runs the suite — the guards above never run in CI');

  // Read per step, not per job, and anchored to a whole line. Both matter, and both were found
  // by mutating this assertion rather than the workflow: a substring search over the job is
  // answered by the comment that explains the setting, and a job-wide search is answered by
  // `fetch-depth: 0` sitting under `setup-node`, where it is silently ignored. What has to be
  // true is narrower than either — the checkout step itself carries it.
  const shallow = running
    .filter((b) => {
      const steps = b.split(/^ {6}- /m).slice(1);
      // `m` and leading whitespace on the uses-matcher: a NAMED checkout step (`- name: …`
      // first, `uses:` indented below — the style this very file uses elsewhere) is not a
      // violation, and without the flag the guard goes red on a perfectly correct workflow.
      return !steps.some((s) => /^\s*uses: actions\/checkout/m.test(s) && /^\s*fetch-depth: 0\s*$/m.test(s));
    })
    .map((b) => b.slice(0, b.indexOf(':')));
  assert.deepEqual(
    shallow,
    [],
    `CI jobs running the suite whose \`actions/checkout\` step has no \`fetch-depth: 0\`: ${shallow.join(', ')} — with no tags fetched, the CHANGELOG guard compares nothing and passes`,
  );
});

// The one line a reader of the first failure is given. `ok` prints the message and nothing else,
// so a line number that points at the wrong place sends them through fifty lines of prose by
// hand — and a truncated section is the case where that is easiest to get wrong: walking to the
// SHORTER of the two finds no difference at all and reports the two as parting company nowhere.
test('the first difference names the line, and a section that stops early ends there', () => {
  const tagged = '## [9.9.9] — 2026-01-01\n- a bullet\n- another';

  assert.match(firstDifference(tagged, '## [9.9.9] — 2026-01-01\n- a BULLET\n- another'), /^line 2\n/);
  assert.match(firstDifference(tagged, '## [9.9.9] — 2026-01-02\n- a bullet\n- another'), /^line 1\n/);

  const lost = firstDifference(tagged, '## [9.9.9] — 2026-01-01\n- a bullet');
  assert.match(lost, /^line 3\n/);
  assert.match(lost, /current: \(section ends\)/);
  assert.match(firstDifference('## [9.9.9] — 2026-01-01\n- a bullet', tagged), /tagged: {2}\(section ends\)/);
});
