import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { waitForOutput } from './bounded.ts';
import { escapeRe, reapOrphanedTemps } from '../src/reap.ts';
import { PRUNE_MARKER, renderWrapper, TEMP_PREFIX } from '../src/wrapper.ts';
import { tempDir } from './sandbox.ts';

const NOW = 1786240000000;
const HOUR = 3600_000;

/** A snapshot dir whose files are backdated to a chosen age. */
function snapDir(files: Record<string, number>): string {
  const dir = tempDir('tarmac-reap-');
  for (const [name, ageMs] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, '{}');
    const when = new Date(NOW - ageMs);
    fs.utimesSync(file, when, when);
  }
  return dir;
}

const SID = 'ea6a607c-42e0-4773-af4d-ae5f5938d819';
const TEMP = `.tarmac-${SID}.66956.tmp`;
// `.<sid>.<pid>.tmp` is a convention, not a signature. The fleet's own production
// statusline wrapper writes exactly this — same charset, same 8..64 bounds, same shape —
// and docs/MANUAL.md documents pointing `--snapshots-dir` straight at its directory.
// Matching on shape would delete another program's files and call them our litter.
const FOREIGN = `.${SID}.66956.tmp`;

// The wrapper writes `<dir>/.<sid>.<pid>.tmp` then renames it. Kill the terminal between
// the two and the temp file stays forever — one per interrupted frame.
test('removes a wrapper temp file left behind long ago', () => {
  const dir = snapDir({ [TEMP]: 4 * HOUR });
  const res = reapOrphanedTemps(dir, { now: NOW });
  assert.equal(res.reaped, 1);
  assert.equal(fs.existsSync(path.join(dir, TEMP)), false);
});

// The whole risk of a reaper: deleting a write that is still in flight. A statusline frame
// takes milliseconds, so anything recent is presumed alive.
test('leaves a temp file that is younger than the threshold — it may be a write in flight', () => {
  const dir = snapDir({ [TEMP]: 5000 });
  const res = reapOrphanedTemps(dir, { now: NOW });
  assert.equal(res.reaped, 0);
  assert.equal(fs.existsSync(path.join(dir, TEMP)), true);
});

test('never removes a real snapshot, however old it is', () => {
  const dir = snapDir({ [`${SID}.json`]: 30 * 24 * HOUR });
  const res = reapOrphanedTemps(dir, { now: NOW });
  assert.equal(res.reaped, 0);
  assert.equal(fs.existsSync(path.join(dir, `${SID}.json`)), true);
});

// Same house rule as the wrapper's own session_id check: a name we do not recognise is
// refused, not guessed at. This directory is the user's, and only what we wrote is ours.
test('never removes a dotfile that is not shaped like our own temp file', () => {
  const dir = snapDir({ '.last-prune': 4 * HOUR, '.DS_Store': 4 * HOUR, '.notes.tmp': 4 * HOUR });
  const res = reapOrphanedTemps(dir, { now: NOW });
  assert.equal(res.reaped, 0);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.DS_Store', '.last-prune', '.notes.tmp']);
});

// The prune marker begins with TEMP_PREFIX — it IS `.tarmac-last-prune` — and `serve` reaps
// this directory on every start. `TEMP_NAME` refuses it today because it demands a
// `.<pid>.tmp` tail, but nothing said so out loud: the wrapper's paperwork and the reaper's
// matcher live in different files, and the assertions elsewhere that subtract the marker by
// name cannot tell "still there" from "the reaper ate it".
test('never removes the prune marker, which shares our own temp prefix', () => {
  const dir = snapDir({ [PRUNE_MARKER]: 30 * 24 * HOUR, [TEMP]: 4 * HOUR });
  const res = reapOrphanedTemps(dir, { now: NOW });
  assert.equal(res.reaped, 1, 'our own orphan is still reaped');
  assert.deepEqual(fs.readdirSync(dir), [PRUNE_MARKER], 'and the marker is not litter');
});

// A matcher is only as good as what it REFUSES, and refusals were the blind half of this
// suite: every negative fixture above fails on the FIRST character, so five weakenings of
// TEMP_NAME — drop `^`, drop `$`, drop `escapeRe`, `\d+`→`.+`, widen `{8,64}` — all
// survived green while each one would have eaten a file below. One fixture per weakening,
// each a name another program could plausibly own.
const FOREIGN_FIXTURES: Array<{ label: string; name: string; guards: string }> = [
  {
    label: 'a foreign name whose MIDDLE is our prefix',
    name: `notes.tarmac-abcdefgh.123.tmp`,
    guards: 'the `^` anchor',
  },
  {
    label: 'our shape with something appended to its TAIL',
    name: `.tarmac-abcdefgh.123.tmp.KEEP-ME`,
    guards: 'the `$` anchor',
  },
  {
    label: 'a prefix that differs only in its first character',
    name: `Xtarmac-abcdefgh.123.tmp`,
    guards: 'escaping the `.` of the prefix instead of letting it be a wildcard',
  },
  {
    label: 'our shape with a word where the pid goes',
    name: `.tarmac-abcdefgh.important-backup.tmp`,
    guards: '`\\d+` — a pid is digits',
  },
  // The sid half of the matcher, one fixture per weakening — and since #7 the sid is a rule
  // of one fixed length rather than a range, so the two fixtures that used to guard "the
  // bounds of {8,64}" collapse into one. `abc` is hex throughout: it survives only because
  // its LENGTH is wrong, which is what a sid widened to `[0-9a-fA-F-]+` would stop noticing.
  {
    label: 'a sid of the right characters and the wrong length',
    name: `.tarmac-abc.7.tmp`,
    guards: 'the fixed length of the sid rule',
  },
  // …and the reaper had a sid set of its OWN before #7 — 8..64 of `[0-9A-Za-z-]`, hand-copied
  // from a rule the wrapper has since narrowed. Wider than the writer is the same divergence
  // the snapshot sweep was carrying, one file down: a name we can no longer produce, unlinked
  // because it resembles one we used to.
  {
    label: 'a sid the wrapper accepted before #7 and can no longer write',
    name: `.tarmac-abcdefgh.7.tmp`,
    guards: 'the sid rule the wrapper enforces before it writes anything',
  },
  {
    label: 'a UUID-shaped sid carrying a character that is not hex',
    name: `.tarmac-ea6a607g-42e0-4773-af4d-ae5f5938d819.7.tmp`,
    guards: 'the hex classes of the sid rule',
  },
];

for (const { label, name, guards } of FOREIGN_FIXTURES) {
  test(`never removes ${label} — guards ${guards}`, () => {
    // Ours sits next to it: a reaper that reaps nothing at all would pass otherwise.
    const dir = snapDir({ [name]: 30 * 24 * HOUR, [TEMP]: 4 * HOUR });
    const res = reapOrphanedTemps(dir, { now: NOW });
    assert.equal(res.reaped, 1, 'our own orphan is still reaped');
    assert.deepEqual(fs.readdirSync(dir), [name], 'and nothing else was touched');
  });
}

test('removes every stale temp file and counts them', () => {
  const dir = snapDir({
    [`.tarmac-${SID}.1.tmp`]: 4 * HOUR,
    [`.tarmac-${SID}.2.tmp`]: 4 * HOUR,
    [`.tarmac-${SID}.3.tmp`]: 1000,
    [`${SID}.json`]: 4 * HOUR,
  });
  const res = reapOrphanedTemps(dir, { now: NOW });
  assert.equal(res.reaped, 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`.tarmac-${SID}.3.tmp`, `${SID}.json`]);
});

// C1 from review. `.<sid>.<pid>.tmp` is what half the world's atomic writers emit, and
// specifically what the fleet's own production statusline wrapper emits into a directory
// docs/MANUAL.md tells you to point `--snapshots-dir` at. A shape is not a signature:
// the only thing that proves we wrote a file is a name only we write.
test('never removes another tool\'s temp file that happens to share the convention', () => {
  const dir = snapDir({ [FOREIGN]: 4 * HOUR, '.mydatabase-backup.9912.tmp': 30 * 24 * HOUR });
  const res = reapOrphanedTemps(dir, { now: NOW });
  assert.equal(res.reaped, 0, 'not ours, not our business');
  assert.equal(res.failed, 0, 'and not an error either');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['.mydatabase-backup.9912.tmp', FOREIGN].sort());
});

// The reaper's regex and the wrapper's temp name are one fact, so they come from one
// constant. Two independently-maintained conventions drift, and the drift is silent:
// either orphans accumulate forever, or we delete something we did not write.
test('the wrapper writes temp files under the very prefix the reaper matches', () => {
  const src = renderWrapper({ snapshotDir: '/tmp/s', chainCommand: null });
  // `escapeRe`, not raw interpolation: unescaped, the `.` of `.tarmac-` is a wildcard and
  // a wrapper emitting `Xtarmac-` satisfies this assertion — the drift this test exists to
  // catch is exactly the one it would let through.
  assert.match(src, new RegExp(`tmp="\\$TARMAC_DIR/${escapeRe(TEMP_PREFIX)}\\$sid\\.\\$\\$\\.tmp"`));
  assert.equal(TEMP_PREFIX.startsWith('.'), true, 'a temp file stays hidden');
});

// …and the source is still only a source. The accord that matters is between what the
// wrapper LEAVES BEHIND and what the reaper TAKES AWAY, so this one runs the real script
// and reproduces the crash it cleans up after: a `mv` that reports success without moving
// is the terminal dying in the gap between the write and the rename.
// Run at both spellings the sid contract has: since #7 that contract IS the UUID, and hex
// has two of them. What the wrapper leaves behind is what the reaper takes away, in either.
for (const { what, sid } of [
  { what: 'a UUID', sid: SID },
  { what: 'the same id upper-cased', sid: SID.toUpperCase() },
])
test(`the reaper removes the very file an interrupted wrapper leaves behind (${what})`, () => {
  const root = tempDir('tarmac-accord-');
  const snapDir = path.join(root, 'snapshots');
  const script = path.join(root, 'statusline.sh');
  fs.writeFileSync(script, renderWrapper({ snapshotDir: snapDir, chainCommand: null }));
  fs.chmodSync(script, 0o755);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'mv'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(bin, 'mv'), 0o755);

  execFileSync(script, {
    input: JSON.stringify({ session_id: sid, model: { display_name: 'Fable 5' } }),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });

  // Minus the prune marker: the same frame also stamps the amortized sweep, which is
  // bookkeeping the reaper has no opinion about.
  const left = fs.readdirSync(snapDir).filter((n) => n !== PRUNE_MARKER);
  assert.deepEqual(left.length, 1, `the interrupted frame left one temp file, saw ${left.join(', ')}`);
  const orphan = path.join(snapDir, left[0]!);
  const old = new Date(NOW - 4 * HOUR);
  fs.utimesSync(orphan, old, old);

  const res = reapOrphanedTemps(snapDir, { now: NOW });
  assert.equal(res.reaped, 1, `the reaper does not recognise "${left[0]}" as one of its own`);
  assert.deepEqual(fs.readdirSync(snapDir).filter((n) => n !== PRUNE_MARKER), []);
});

// I3 from review. `statSync` follows symlinks, `unlinkSync` does not: a dangling link shaped
// like our temp file made `statSync` throw ENOENT and get counted as "could not remove",
// printing a false alarm on every single `serve` — about a file `unlinkSync` removes fine.
test('removes a dangling symlink instead of reporting a failure it did not have', () => {
  const dir = tempDir('tarmac-reap-');
  const link = path.join(dir, TEMP);
  fs.symlinkSync('/nonexistent/target', link);
  const old = new Date(NOW - 4 * HOUR);
  fs.lutimesSync(link, old, old);
  const res = reapOrphanedTemps(dir, { now: NOW });
  assert.equal(res.failed, 0, 'nothing failed');
  assert.equal(res.reaped, 1);
  assert.deepEqual(fs.readdirSync(dir), []);
});

// The mirror case: the link is ancient, its target is fresh. Judging by the target's mtime
// keeps the orphan forever — the age of OUR file is the age of our file.
test('judges a symlink by its own age, not its target\'s', () => {
  const dir = tempDir('tarmac-reap-');
  const target = path.join(dir, 'fresh-target');
  fs.writeFileSync(target, '{}');
  const link = path.join(dir, TEMP);
  fs.symlinkSync(target, link);
  const old = new Date(NOW - 4 * HOUR);
  fs.lutimesSync(link, old, old);
  assert.equal(reapOrphanedTemps(dir, { now: NOW }).reaped, 1);
  assert.equal(fs.existsSync(target), true, 'the target it pointed at is untouched');
});

test('honours a caller-supplied age threshold', () => {
  const dir = snapDir({ [TEMP]: 90_000 });
  assert.equal(reapOrphanedTemps(dir, { now: NOW, olderThanMs: 60_000 }).reaped, 1);
});

// Hygiene is best-effort by definition: it must never be the reason a command fails.
test('a directory that does not exist is not an error', () => {
  const res = reapOrphanedTemps('/nonexistent/tarmac-snaps', { now: NOW });
  assert.equal(res.reaped, 0);
  assert.equal(res.failed, 0);
});

test('counts a file it could not delete instead of throwing', (t) => {
  // 0555 does not stop root, so under a root container this fixture is not the state it
  // claims to build. Saying that out loud beats a green tick that proved nothing.
  if (process.getuid?.() === 0) {
    t.skip('running as root: 0555 does not deny anything, the case cannot be built here');
    return;
  }
  const dir = snapDir({ [TEMP]: 4 * HOUR });
  fs.chmodSync(dir, 0o555); // removing an entry needs write on the directory
  try {
    const res = reapOrphanedTemps(dir, { now: NOW });
    assert.equal(res.reaped, 0);
    assert.equal(res.failed, 1, 'a failure is counted, never swallowed');
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

// ── wiring ────────────────────────────────────────────────────────────────────────────
// A reaper nothing calls is a reaper that never runs. `serve` is the call site: it is the
// long-lived command, and the one the user reaches for when looking at the fleet.

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Starts the real CLI and resolves once it says it is listening — bounded, so a marker that
 * never comes fails this file instead of stopping it. See `test/bounded.ts`.
 */
async function serve(snapshotsDir: string): Promise<ChildProcess> {
  const cli = path.join(here, '..', 'src', 'cli.ts');
  const child = spawn(process.execPath, [cli, 'serve', '--port', '0', '--snapshots-dir', snapshotsDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForOutput(child, /tarmac serving/);
  return child;
}

test('serve reaps orphaned temp files before it starts listening', async () => {
  // Real clock here: the CLI does not take a `now`, so the fixtures must be really old.
  const dir = tempDir('tarmac-serve-');
  const stale = path.join(dir, `.tarmac-${SID}.111.tmp`);
  const inflight = path.join(dir, `.tarmac-${SID}.222.tmp`);
  const snapshot = path.join(dir, `${SID}.json`);
  for (const f of [stale, inflight, snapshot]) fs.writeFileSync(f, '{}');
  const old = new Date(Date.now() - 4 * HOUR);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(snapshot, old, old);

  const child = await serve(dir);
  try {
    assert.equal(fs.existsSync(stale), false, 'the orphan is gone');
    assert.equal(fs.existsSync(inflight), true, 'a write in flight survives');
    assert.equal(fs.existsSync(snapshot), true, 'the telemetry survives');
  } finally {
    child.kill('SIGKILL');
  }
});
