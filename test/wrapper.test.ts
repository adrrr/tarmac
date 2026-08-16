import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  PRUNE_EVERY_MIN,
  PRUNE_MARKER,
  renderWrapper,
  SID_GLOB,
  SNAPSHOT_GLOB,
  SNAPSHOT_NAME,
  SNAPSHOT_TTL_MIN,
  TEMP_PREFIX,
} from '../src/wrapper.ts';
import { tempDir } from './sandbox.ts';
import { wideningLocale } from './locales.ts';
import { settle, waitFor } from './sweep.ts';

// `find` and the shell share a libc, so the locale that widens a range for `/bin/sh` — the
// interpreter the generated wrapper declares — is the one that would widen it for `find`.
// Measured, never named: `C.UTF-8` is UTF-8 and collates by code point, so asking under it
// proves nothing at all.
const WIDENING = wideningLocale('/bin/sh');

const SID = 'ea6a607c-42e0-4773-af4d-ae5f5938d819';
const payload = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    session_id: SID,
    model: { id: 'claude-fable-5', display_name: 'Fable 5' },
    context_window: { used_percentage: 26 },
    ...over,
  });

function sandbox(): { root: string; snapDir: string } {
  const root = tempDir('tarmac-wrap-');
  return { root, snapDir: path.join(root, 'snapshots') };
}

interface RunWrapperOptions {
  root: string;
  snapDir: string;
  chain?: string;
  input: string;
}

/** Writes the wrapper to disk and runs it with `input` on stdin. Returns its stdout. */
function runWrapper({ snapDir, chain, input, root }: RunWrapperOptions): string {
  const file = path.join(root, 'statusline.sh');
  fs.writeFileSync(file, renderWrapper({ snapshotDir: snapDir, chainCommand: chain ?? null }));
  fs.chmodSync(file, 0o755);
  const stdout = execFileSync(file, { input, encoding: 'utf8' });
  return stdout;
}


/**
 * Everything in the snapshot dir except the prune marker — subtracted by NAME, not by
 * "it starts with a dot": a stray `.tarmac-<sid>.<pid>.tmp` left inside is exactly what
 * these assertions exist to catch, and a dotfile filter would hide it.
 */
const contents = (dir: string): string[] => fs.readdirSync(dir).filter((n) => n !== PRUNE_MARKER).sort();

test('drops the payload under <dir>/<session_id>.json', () => {
  const { root, snapDir } = sandbox();
  runWrapper({ root, snapDir, input: payload() });
  const written = fs.readFileSync(path.join(snapDir, `${SID}.json`), 'utf8');
  assert.deepEqual(JSON.parse(written), JSON.parse(payload()));
});

test('calls the chained command and prints its output — the existing display survives', () => {
  const { root, snapDir } = sandbox();
  const out = runWrapper({ root, snapDir, chain: "sed 's/.*/EXISTING-STATUSLINE/'", input: payload() });
  assert.match(out, /EXISTING-STATUSLINE/);
});

test('feeds the payload to the chained command on stdin, unmodified', () => {
  const { root, snapDir } = sandbox();
  const sink = path.join(root, 'seen.json');
  runWrapper({ root, snapDir, chain: `cat > ${sink}`, input: payload() });
  assert.deepEqual(JSON.parse(fs.readFileSync(sink, 'utf8')), JSON.parse(payload()));
});

// Rule 1 of the fleet's proven wrapper: never break the display, whatever fails.
test('a chained command that fails still leaves exit code 0', () => {
  const { root, snapDir } = sandbox();
  const out = runWrapper({ root, snapDir, chain: 'echo partial; exit 3', input: payload() });
  assert.match(out, /partial/);
});

test('a chained command that does not exist still leaves exit code 0', () => {
  const { root, snapDir } = sandbox();
  runWrapper({ root, snapDir, chain: '/nonexistent/statusline.sh', input: payload() });
  assert.ok(fs.existsSync(path.join(snapDir, `${SID}.json`)), 'telemetry still captured');
});

test('with no chained command it still prints something — the model name', () => {
  const { root, snapDir } = sandbox();
  const out = runWrapper({ root, snapDir, input: payload() });
  assert.match(out, /Fable 5/);
});

test('an unwritable snapshot dir does not break the display', () => {
  const { root } = sandbox();
  const blocked = path.join(root, 'blocked');
  fs.writeFileSync(blocked, 'i am a file, not a dir');
  const out = runWrapper({ root, snapDir: blocked, chain: 'echo STILL-RENDERED', input: payload() });
  assert.match(out, /STILL-RENDERED/);
});

// The session_id comes from outside and becomes a filename. Refused, not sanitised.
test('a session_id with path traversal writes nothing at all', () => {
  const { root, snapDir } = sandbox();
  const out = runWrapper({ root, snapDir, chain: 'echo OK', input: payload({ session_id: '../../evil' }) });
  assert.match(out, /OK/);
  assert.equal(fs.existsSync(path.join(root, '..', 'evil.json')), false);
  assert.equal(fs.existsSync(snapDir) && fs.readdirSync(snapDir).length > 0, false);
});

// …and the test above passes for the wrong reason: delete the charset guard and it stays
// green, because what actually stops `../../evil` is that `<dir>/.tarmac-..` does not
// exist, so the `printf` redirection fails. That is the filesystem's accident, not our
// invariant — a directory of that name is one `mkdir` away, and RULE 2 has to hold with
// the trapdoor propped open. Defence in depth is only depth if each layer holds alone.
test('the charset guard refuses traversal by itself, with the directory it would need in place', () => {
  const { root } = sandbox();
  // Nested, so an escape lands inside the sandbox rather than in the shared temp dir.
  const snapDir = path.join(root, 'nested', 'snapshots');
  fs.mkdirSync(path.join(snapDir, `${TEMP_PREFIX}..`), { recursive: true });
  const escaped = path.resolve(snapDir, '..', '..', 'evil.json');
  assert.equal(fs.existsSync(escaped), false, 'sanity: nothing is there yet');

  const out = runWrapper({ root, snapDir, chain: 'echo OK', input: payload({ session_id: '../../evil' }) });

  assert.match(out, /OK/, 'the display still renders');
  assert.equal(fs.existsSync(escaped), false, 'nothing was written outside the snapshot dir');
  assert.deepEqual(contents(snapDir), [`${TEMP_PREFIX}..`], 'and nothing was written inside it');
});

// I8: the extraction is positional — it takes the FIRST occurrence. If the payload ever
// gains a nested id (a parent/subagent block), the file would be named after the wrong
// session and read back as if it were certain — and a second session would clobber it.
// Not reachable with today's payload; refused rather than guessed.
test('a payload carrying two session_ids writes nothing at all', () => {
  const { root, snapDir } = sandbox();
  const two = JSON.stringify({
    parent: { session_id: 'aaaaaaaa-1111-2222-3333-444444444444' },
    session_id: SID,
    model: { display_name: 'Fable 5' },
  });
  const out = runWrapper({ root, snapDir, chain: 'echo OK', input: two });
  assert.match(out, /OK/, 'the display still renders');
  assert.equal(fs.existsSync(snapDir) && fs.readdirSync(snapDir).length > 0, false);
});

test('a payload with no session_id writes nothing and still renders', () => {
  const { root, snapDir } = sandbox();
  const out = runWrapper({ root, snapDir, chain: 'echo OK', input: '{"model":{"display_name":"X"}}' });
  assert.match(out, /OK/);
  assert.equal(fs.existsSync(snapDir) && fs.readdirSync(snapDir).length > 0, false);
});

// The sid the WRAPPER accepts, the sid the SWEEP unlinks and the sid the REAPER matches are
// one contract written in three languages — a shell `case` pattern, a shell glob and a JS
// regex. They used to be three DIFFERENT sets (#7), which is a bug in both directions at
// once, so each side is pinned here on its own: shared constant or not, only a test proves
// that what is written can be taken away, and that nothing else can.
const SIDS: Array<{ what: string; sid: string; accepted: boolean }> = [
  { what: 'the session id Claude Code emits', sid: SID, accepted: true },
  { what: 'the same id upper-cased — hex has two spellings', sid: SID.toUpperCase(), accepted: true },
  { what: 'a sid shorter than a UUID', sid: 'abcdefgh', accepted: false },
  { what: 'a sid longer than a UUID', sid: 'a'.repeat(64), accepted: false },
  { what: 'a UUID-shaped sid carrying a character that is not hex', sid: 'ea6a607g-42e0-4773-af4d-ae5f5938d819', accepted: false },
  { what: 'a UUID with a group one character short', sid: 'ea6a607c-42e0-4773-af4d-ae5f5938d81', accepted: false },
  { what: 'a sid carrying a character outside the set', sid: 'abcd_efgh', accepted: false },
];

for (const { what, sid, accepted } of SIDS) {
  test(`${what} is ${accepted ? 'written' : 'refused, and nothing is written'}`, () => {
    const { root, snapDir } = sandbox();
    const out = runWrapper({ root, snapDir, chain: 'echo OK', input: payload({ session_id: sid }) });
    assert.match(out, /OK/, 'the display renders either way');
    assert.deepEqual(fs.existsSync(snapDir) ? contents(snapDir) : [], accepted ? [`${sid}.json`] : []);
  });
}

test('a snapshot dir path containing spaces and quotes is handled', () => {
  const { root } = sandbox();
  const weird = path.join(root, "od d's dir");
  runWrapper({ root, snapDir: weird, input: payload() });
  assert.ok(fs.existsSync(path.join(weird, `${SID}.json`)));
});

// ── the amortized prune ───────────────────────────────────────────────────────────────
// Nothing else ever removes a snapshot: `reap.ts` collects the wrapper's own temp litter
// and refuses to touch a `<sid>.json`. A fleet that recycles its sessions every night
// therefore leaves one dead file behind per session per night, forever (#19).
//
// A live session rewrites its snapshot on EVERY frame, so mtime is what separates the dead
// from the living — and the sweep is amortized, because this code sits in the render path.
//
// Since #8 it is also DETACHED: the frame starts the sweep and returns, so nothing below may
// read the directory the instant `runWrapper` comes back. What the sweep did is waited for;
// what it must NOT do is asserted behind a barrier, and the barrier is a cold snapshot the
// sweep is bound to take: once the canary is gone, the `rm` that was going to take it has
// run, and what is still there was kept on purpose. That holds because these fixtures are a
// handful of files. `-exec … +` fills an argv buffer and execs MID-WALK — one exec per
// ~ARG_MAX BYTES, not per fixed count of names, so the split moves with how long the paths
// are — and a fixture of thousands of cold files would run several batches, at which point
// the canary stops meaning "the walk is over". Keep them small, or make the canary the last
// name `find` reaches. Only the cases where NO sweep may start at all have
// nothing to wait for, and those use `settle()`.

const DEAD = 'ffffffff-1111-2222-3333-444444444444';
const QUIET = 'ffffffff-5555-6666-7777-888888888888';
const MIN = 60_000;

/** Backdates files into `dir` — ages in minutes, the unit the wrapper's `find` speaks. */
function seed(dir: string, files: Record<string, number>): void {
  for (const [name, ageMin] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}');
    const when = new Date(Date.now() - ageMin * MIN);
    fs.utimesSync(file, when, when);
  }
}


const deadFile = (dir: string): string => path.join(dir, `${DEAD}.json`);

test('removes the snapshot of a session that stopped rendering more than 48h ago', async () => {
  const { root, snapDir } = sandbox();
  seed(snapDir, { [`${DEAD}.json`]: SNAPSHOT_TTL_MIN + 60 });
  runWrapper({ root, snapDir, input: payload() });
  await waitFor(() => !fs.existsSync(deadFile(snapDir)), 'the dead session to be swept');
  assert.equal(fs.existsSync(path.join(snapDir, `${SID}.json`)), true, "and this frame's own snapshot is not");
});

// The whole risk of a sweep: deleting a session that is merely quiet. A frame rewrites the
// file, so anything inside the window is presumed alive — the same rule the temp reaper
// applies to a write in flight, one timescale up.
test('keeps a snapshot younger than 48h — that is what a live session looks like', async () => {
  const { root, snapDir } = sandbox();
  seed(snapDir, { [`${QUIET}.json`]: SNAPSHOT_TTL_MIN - 60, [`${DEAD}.json`]: SNAPSHOT_TTL_MIN + 60 });
  runWrapper({ root, snapDir, input: payload() });
  await waitFor(() => !fs.existsSync(deadFile(snapDir)), 'the sweep to finish, which is when the quiet one has survived it');
  assert.equal(fs.existsSync(path.join(snapDir, `${QUIET}.json`)), true);
});

// Amortization is not an optimization here, it is the reason this can live in the render
// path at all: a sweep on every frame would put a directory walk between Claude Code and
// its status line, dozens of times a minute.
test('does not sweep again while the marker is fresh — one sweep per hour, not one per frame', async () => {
  const { root, snapDir } = sandbox();
  seed(snapDir, { [`${DEAD}.json`]: 5 * 24 * 60, [PRUNE_MARKER]: 0 });
  runWrapper({ root, snapDir, input: payload() });
  await settle();
  assert.equal(fs.existsSync(deadFile(snapDir)), true, 'the frame paid one `find` on one file and nothing else');
});

test('sweeps once the marker is older than the window, and restamps it', async () => {
  const { root, snapDir } = sandbox();
  seed(snapDir, { [`${DEAD}.json`]: 5 * 24 * 60, [PRUNE_MARKER]: PRUNE_EVERY_MIN + 60 });
  const marker = path.join(snapDir, PRUNE_MARKER);
  const before = fs.statSync(marker).mtimeMs;
  runWrapper({ root, snapDir, input: payload() });
  // The stamp is the FRAME's, so it is there the moment the frame returns; the sweep it
  // started is the thing that has to be waited for.
  assert.ok(fs.statSync(marker).mtimeMs > before, 'the next hour starts now');
  await waitFor(() => !fs.existsSync(deadFile(snapDir)), 'the sweep to run');
});

// `*.json` at the top level is the whole contract, so it is worth pinning from BOTH sides —
// these decoys are all non-`.json`, and every one of them is excluded by the glob before any
// other test in this file gets a say.
test('never touches a file that is not a *.json, however old', async () => {
  const { root, snapDir } = sandbox();
  const others = {
    [`${TEMP_PREFIX}${DEAD}.999.tmp`]: 5 * 24 * 60,
    '.DS_Store': 5 * 24 * 60,
    'notes.txt': 5 * 24 * 60,
    'fleet.json.bak': 5 * 24 * 60,
  };
  seed(snapDir, { ...others, [`${DEAD}.json`]: 5 * 24 * 60 });
  runWrapper({ root, snapDir, input: payload() });
  await waitFor(() => !fs.existsSync(deadFile(snapDir)), 'ours to be swept — the barrier for what follows');
  assert.deepEqual(contents(snapDir), [...Object.keys(others), `${SID}.json`].sort());
});

// …and the other side of the same glob, which is where a sweep earns or loses its right to
// exist. `reap.ts` states the house rule for the temp files: "only what we WROTE — not what
// looks like something we might have written". A `*.json` glob breaks that rule one file
// down, on a strictly more destructive operation: `reap.ts` deletes litter, this deletes
// data. So the sweep is narrowed to the shape the wrapper actually writes.
//
// `abcdefgh.json` and `fleet-config.json` are the two fixtures that say why #7 was closed by
// narrowing the WRITER rather than by widening this glob to the writer's old charset: every
// stem of 8..64 characters of `[0-9A-Za-z-]` would then be deletable, from a directory the
// docs invite you to share with a production statusline and that people keep in git.
test('never removes a *.json that is not shaped like a session id', async () => {
  const { root, snapDir } = sandbox();
  const foreign = {
    'config.json': 5 * 24 * 60,
    'fleet.json': 5 * 24 * 60,
    'package.json': 5 * 24 * 60,
    'abcdefgh.json': 5 * 24 * 60,
    'fleet-config.json': 5 * 24 * 60,
  };
  seed(snapDir, { ...foreign, [`${DEAD}.json`]: 5 * 24 * 60 });
  runWrapper({ root, snapDir, input: payload() });
  await waitFor(() => !fs.existsSync(deadFile(snapDir)), 'ours to be swept — the barrier for what follows');
  assert.deepEqual(contents(snapDir), [...Object.keys(foreign), `${SID}.json`].sort());
});

// The collation property, asserted on the CONSTANT rather than on behaviour — because the
// behavioural version of it (`test/portability.test.ts`) can only run where the machine has a
// locale under which some shell reads `a-f` past ASCII, and a minimal image carrying only `C`
// and `C.UTF-8` has none. There the behavioural test honestly skips, and a range spelling
// would sail through. This one cannot skip: a range is a range on every machine there is, and
// the rule may not contain one. The `-` between GROUPS is the separator of the UUID itself and
// is checked to be exactly where the shape says.
test('the sid rule enumerates its characters and never ranges over them', () => {
  const groups = SID_GLOB.split('-');
  assert.deepEqual(
    groups.map((g) => g.length / '[0123456789abcdefABCDEF]'.length),
    [8, 4, 4, 4, 12],
    'the 8-4-4-4-12 shape, in whole character classes',
  );
  for (const group of groups) {
    assert.equal(
      group.replaceAll('[0123456789abcdefABCDEF]', ''),
      '',
      'every class is the sixteen digits spelled out — a range here is collated by the locale, ' +
        'so the same string would mean one set to bash and another to the regex derived from it',
    );
  }
});

// `SNAPSHOT_GLOB` and `SNAPSHOT_NAME` are both built from `SID_GLOB`, which is why they can
// agree at all — a bracket expression means the same set to fnmatch and to a regex, and `-`
// is literal in both. But sharing a source is not the same as meaning the same thing. Two
// ways they can still part: put a `?` back into `SID_GLOB` and it is "any one character" to
// `find` and "the previous atom is optional" to a regex — not a widening or a narrowing but a
// different set, in the two places that delete; or spell the extension `.json` in the regex,
// where the `.` is a wildcard, rather than `\.json`. So the two are run against the same
// names — the real `find`, with the real glob — instead of being trusted to correspond.
test('the glob the shell deletes by and the regex TypeScript deletes by are one set', () => {
  const { root: dir } = sandbox();
  const names = [
    `${SID}.json`,
    `${SID.toUpperCase()}.json`,
    `.${SID.slice(1)}.json`,
    'ea6a607g-42e0-4773-af4d-ae5f5938d819.json',
    'ea6a607c-42e0-4773-af4d-ae5f5938d81.json',
    'ea6a607c42e04773af4dae5f5938d819.json',
    `${SID}.jsonx`,
    `x${SID}.json`,
    // The one character each side has to spell in its own language. Unescape it in the regex
    // and every other name here still agrees — a regex `.` matches the glob's literal `.` —
    // while `<sid>Xjson` becomes a snapshot to TypeScript and a stranger to `find`.
    `${SID}Xjson`,
    // …and the one character class it must NOT touch: an enumeration, so no locale can pull
    // a non-ASCII character into the set on one side of the pair and not the other.
    'éa6a607c-42e0-4773-af4d-ae5f5938d819.json',
    'abcdefgh.json',
    'fleet-config.json',
    `${TEMP_PREFIX}${SID}.42.tmp`,
    PRUNE_MARKER,
  ];
  for (const name of names) fs.writeFileSync(path.join(dir, name), '{}');
  // What landed, not what was asked for: on a case-insensitive filesystem the two spellings
  // of the same id are one file, and the question here is whether the two matchers agree
  // about a DIRECTORY — whichever directory the host actually built.
  const onDisk = fs.readdirSync(dir);

  // Under a locale that really does widen a range, where one exists: `é` would collate INTO
  // `a-f` here — in BSD `find` as much as in bash — while the regex never would. Asked under
  // the ambient locale, or under a code-point one, that half of the pair cannot fail at all.
  const found = execFileSync(
    'find',
    [`${dir}/.`, '!', '-name', '.', '-prune', '-name', SNAPSHOT_GLOB, '-type', 'f'],
    { encoding: 'utf8', env: { ...process.env, ...(WIDENING ? { LC_ALL: WIDENING } : {}) } },
  )
    .split('\n')
    .filter(Boolean)
    .map((f) => path.basename(f))
    .sort();

  assert.deepEqual(found, onDisk.filter((n) => SNAPSHOT_NAME.test(n)).sort());
  assert.ok(found.length > 0, 'sanity: a matcher that matches nothing agrees with anything');
});

// #7, second direction. `?` matches a leading dot — `find`'s fnmatch is not called with
// FNM_PERIOD — so the UUID glob reached names the writer's charset can never produce, and a
// `.bcdefgh-….json` that anything at all had dropped in there was unlinked by a status line.
// That is the sweep exceeding "only what we wrote", on the more destructive side of the trade.
// Bracket expressions cannot match a `.`, so the hole closes with the shared rule itself
// rather than with a second `-name` term nobody would remember to keep in step.
test('never removes a dotfile wearing a session id name — the writer cannot emit one', async () => {
  const { root, snapDir } = sandbox();
  const dotfile = `.${DEAD.slice(1)}.json`;
  seed(snapDir, { [dotfile]: 5 * 24 * 60, [`${DEAD}.json`]: 5 * 24 * 60 });
  runWrapper({ root, snapDir, input: payload() });
  await waitFor(() => !fs.existsSync(deadFile(snapDir)), 'ours to be swept — the barrier for what follows');
  assert.equal(fs.existsSync(path.join(snapDir, dotfile)), true, 'a name we could never write is not');
});

// The accord that matters is not between two strings, it is between what the wrapper WRITES
// and what the sweep TAKES AWAY — the same pairing `reap.test.ts` makes for the temp files.
// Two real frames: the first files a snapshot, the second sweeps it once it is old enough.
//
// #7, first direction: run for EVERY sid the writer accepts, not just the one this file uses
// everywhere. The writer took any 8..64 characters of `[0-9A-Za-z-]` while the sweep knew
// only UUIDs, so `abcdefgh.json` was filed and then invisible — #19 back for that session,
// for good, with the whole suite green.
for (const { what, sid } of SIDS.filter((s) => s.accepted)) {
  test(`the sweep removes the very file the wrapper writes, once it goes cold (${what})`, async () => {
    const { root, snapDir } = sandbox();
    runWrapper({ root, snapDir, input: payload({ session_id: sid }) });
    const written = path.join(snapDir, `${sid}.json`);
    assert.equal(fs.existsSync(written), true, 'sanity: the first frame filed it');
    const old = new Date(Date.now() - 5 * 24 * 60 * MIN);
    fs.utimesSync(written, old, old);
    fs.utimesSync(path.join(snapDir, PRUNE_MARKER), old, old);

    runWrapper({ root, snapDir, input: payload({ session_id: DEAD }) });

    await waitFor(() => !fs.existsSync(written), 'the sweep to recognise what the writer emits');
  });
}

// `-type f`: delete it from the expression and the whole suite still passes. A directory and
// a symlink can both carry a session id's name, and neither is a snapshot.
test('never removes a directory or a symlink that carries a session id name', async () => {
  const { root, snapDir } = sandbox();
  seed(snapDir, { [`${DEAD}.json`]: 5 * 24 * 60 });
  const victim = path.join(root, 'victim');
  fs.writeFileSync(victim, 'not yours');
  const asDir = path.join(snapDir, 'aaaaaaaa-1111-2222-3333-444444444444.json');
  const asLink = path.join(snapDir, 'bbbbbbbb-1111-2222-3333-444444444444.json');
  fs.mkdirSync(asDir);
  fs.symlinkSync(victim, asLink);
  const old = new Date(Date.now() - 5 * 24 * 60 * MIN);
  fs.utimesSync(asDir, old, old);
  fs.lutimesSync(asLink, old, old);

  runWrapper({ root, snapDir, input: payload() });

  await waitFor(() => !fs.existsSync(deadFile(snapDir)), 'the real snapshot to be swept — the barrier for what follows');
  assert.equal(fs.existsSync(asDir), true, 'a directory is not a snapshot');
  assert.equal(fs.existsSync(asLink), true, 'nor is a symlink');
  assert.equal(fs.existsSync(victim), true, 'and what it pointed at is untouched');
});

test('does not descend into a subdirectory of the snapshot dir', async () => {
  const { root, snapDir } = sandbox();
  // The cold snapshot at the top level is the barrier: it is what the sweep is bound to take,
  // and its removal is what says the walk is over and the nested one was left alone.
  seed(snapDir, { [path.join('archive', `${DEAD}.json`)]: 5 * 24 * 60, [`${QUIET}.json`]: 5 * 24 * 60 });
  runWrapper({ root, snapDir, input: payload() });
  await waitFor(() => !fs.existsSync(path.join(snapDir, `${QUIET}.json`)), 'the top-level sweep to finish');
  assert.equal(fs.existsSync(path.join(snapDir, 'archive', `${DEAD}.json`)), true);
});

// RULE 1, applied to the new code: a directory we cannot stamp is a directory we do not
// sweep. Marker first, sweep second — otherwise a sweep that cannot finish is retried on
// every single frame, which is the cost this whole design exists to avoid.
test('a snapshot dir it cannot write to is never swept, and still renders', async (t) => {
  // 0555 does not stop root, so under a root container this fixture is not the state it
  // claims to build. Saying that out loud beats a green tick that proved nothing.
  if (process.getuid?.() === 0) {
    t.skip('running as root: 0555 does not deny anything, the case cannot be built here');
    return;
  }
  const { root, snapDir } = sandbox();
  seed(snapDir, { [`${DEAD}.json`]: 5 * 24 * 60 });
  fs.chmodSync(snapDir, 0o555);
  try {
    const out = runWrapper({ root, snapDir, chain: 'echo STILL-RENDERED', input: payload() });
    assert.match(out, /STILL-RENDERED/);
    await settle();
    assert.equal(fs.existsSync(deadFile(snapDir)), true);
  } finally {
    fs.chmodSync(snapDir, 0o755);
  }
});

// RULE 2, through the one file the prune WRITES. `touch` follows symlinks: a marker that is
// a dangling link makes it create the link's target — a file outside the snapshot dir, from
// inside a status line. A name we did not write is not ours to stamp.
test('refuses to stamp a marker that is a symlink, and writes nothing outside the dir', async () => {
  const { root, snapDir } = sandbox();
  seed(snapDir, { [`${DEAD}.json`]: 5 * 24 * 60 });
  const outside = path.join(root, 'escaped');
  fs.symlinkSync(outside, path.join(snapDir, PRUNE_MARKER));

  const out = runWrapper({ root, snapDir, chain: 'echo OK', input: payload() });

  assert.match(out, /OK/, 'the display still renders');
  await settle();
  assert.equal(fs.existsSync(outside), false, 'nothing was created outside the snapshot dir');
  assert.equal(fs.existsSync(deadFile(snapDir)), true, 'and a marker we refuse is a sweep we skip');
});

// The same refusal, one shape further out. `touch` SUCCEEDS on a directory, so a marker that
// is a directory reads as "stamped" on every frame while `-mmin` never has a regular file to
// judge: the sweep runs on every single frame and the amortization this whole design is
// built around is silently gone. Anything at that name that is not a plain file is refused.
//
// The marker directory is BACKDATED, and that is the whole test: `find -mmin` answers for a
// directory as readily as for a file, so a marker created just now is refused by its AGE
// whatever the `-f` guard says — the fixture would pass with the guard deleted, which is the
// one edit it exists to catch. Dated past the window, only the guard can still refuse it.
test('refuses a marker that is not a regular file, rather than sweeping every frame', async () => {
  const { root, snapDir } = sandbox();
  seed(snapDir, { [`${DEAD}.json`]: 5 * 24 * 60 });
  const marker = path.join(snapDir, PRUNE_MARKER);
  fs.mkdirSync(marker);
  const due = new Date(Date.now() - (PRUNE_EVERY_MIN + 60) * MIN);
  fs.utimesSync(marker, due, due);

  const out = runWrapper({ root, snapDir, chain: 'echo OK', input: payload() });

  assert.match(out, /OK/, 'the display still renders');
  await settle();
  assert.equal(fs.existsSync(deadFile(snapDir)), true, 'no sweep ran');
});

// A payload the wrapper refuses writes nothing — and "nothing" has to include the marker,
// or a refused session leaves a directory behind that tarmac then reports as chained.
test('a payload it refuses does not create the snapshot dir just to stamp it', () => {
  const { root, snapDir } = sandbox();
  runWrapper({ root, snapDir, chain: 'echo OK', input: '{"model":{"display_name":"X"}}' });
  assert.equal(fs.existsSync(snapDir), false);
});
