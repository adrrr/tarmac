// The journal on disk, which exists only because someone asked for it.
//
// Everything here is about a promise the README used to make without an asterisk: nothing of
// the fleet is written down. A reader who sets `history.days` lifts that for their own machine,
// and what they get has to be exactly what was advertised: the same fields the in-memory ring
// keeps, no name and no working directory, bounded by an age AND by a hard cap, and never a
// reason for `serve` to fall over.
//
// The clock is injected in every test here. A store judged by the wall clock has a retention
// test that is green today and red at midnight, and a cap test that depends on the hour it ran.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireJournalLock, createHistoryStore, historyDirFor, HISTORY_MAX_BYTES } from '../src/history-store.ts';
import type { HistorySample } from '../src/history.ts';
import { tempDir } from './sandbox.ts';

/** Noon on a named calendar day, local. Noon so no test sits within an hour of a DST shift. */
const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h, 0, 0, 0).getTime();

/**
 * The day a moment falls on, restated rather than imported: a file name checked with the
 * function that produced it is a file name nothing checks.
 */
function dayOf(t: number): string {
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const sample = (t: number, over: Partial<HistorySample> = {}): HistorySample => ({
  t,
  sessions: [
    {
      sid: 's1',
      project: 'alpha',
      kind: 'interactive',
      state: 'idle',
      waitingFor: null,
      ctxState: 'ok',
      ctxPct: 26,
      costUsd: 27.75,
    },
  ],
  rateLimits: { five_hour: { used_percentage: 17 } },
  ...over,
});

/** A store whose clock the test moves by hand. */
function store(dir: string, days: number, clock: { now: number }, maxBytes?: number) {
  return createHistoryStore({ dir, days, now: () => clock.now, maxBytes });
}

const lines = (dir: string, day: string): string[] =>
  fs
    .readFileSync(path.join(dir, `${day}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l !== '');

// ── what lands on disk ────────────────────────────────────────────────────────────────

test('a sample is one JSON line in the file for the local day it was read on', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 30, clock);

  s.append(sample(clock.now));

  const written = lines(dir, '2026-08-07');
  assert.equal(written.length, 1, 'one line, one reading');
  // The seven fields spelled out, rather than compared against the fixture that produced them:
  // the journal is an ALLOWLIST of the ring's record, so a shape-to-shape assertion would have
  // to be edited into agreement with whatever the ring grows next, and would agree.
  assert.deepEqual(JSON.parse(written[0]), {
    t: clock.now,
    sessions: [
      { sid: 's1', project: 'alpha', kind: 'interactive', state: 'idle', ctxState: 'ok', ctxPct: 26, costUsd: 27.75 },
    ],
    rateLimits: { five_hour: { used_percentage: 17 } },
  });
});

test('the directory is made when it is not there yet', () => {
  const root = tempDir('tarmac-hist-');
  const dir = path.join(root, 'history');
  const clock = { now: at(2026, 8, 7) };
  assert.equal(fs.existsSync(dir), false, 'nothing on disk before a reader asked for any');

  store(dir, 30, clock).append(sample(clock.now));

  assert.ok(fs.existsSync(path.join(dir, '2026-08-07.jsonl')));
});

test('a second reading is appended, never written over the first', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 30, clock);

  s.append(sample(clock.now));
  clock.now = at(2026, 8, 7, 13);
  s.append(sample(clock.now));

  const written = lines(dir, '2026-08-07');
  assert.equal(written.length, 2);
  assert.equal((JSON.parse(written[0]) as HistorySample).t, at(2026, 8, 7));
  assert.equal((JSON.parse(written[1]) as HistorySample).t, at(2026, 8, 7, 13));
});

test('a reading taken on the next day opens the file for the next day', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 30, clock);

  s.append(sample(clock.now));
  clock.now = at(2026, 8, 8);
  s.append(sample(clock.now));

  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-08-07.jsonl', '2026-08-08.jsonl']);
});

// The privacy line is NOT asserted here, and that is deliberate. This store writes the object
// it is handed, so a fixture invented in this file could only ever prove that `JSON.stringify`
// invents no keys: a leak in `sampleOf` would leave every assertion in this file green. What
// the journal actually carries is held one level up, over the real sampler, in
// `test/server.test.ts` ("a background agent's name never reaches the journal either").

// ── retention ─────────────────────────────────────────────────────────────────────────

/** Days already on disk when the store opens, as a restarted `serve` finds them. */
function given(dir: string, days: string[]): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const day of days) fs.writeFileSync(path.join(dir, `${day}.jsonl`), '{"t":0,"sessions":[],"rateLimits":null}\n');
}

// `days: 30` is thirty days of journal, today included. A store that kept thirty-one would be
// off by a day against the number a reader wrote in their own config file.
test('a prune keeps the last `days` days and removes what fell out of them', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  given(dir, ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']);

  const { removed, failed } = store(dir, 3, clock).prune();

  assert.equal(removed, 2);
  assert.equal(failed, 0);
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    ['2026-08-05.jsonl', '2026-08-06.jsonl', '2026-08-07.jsonl'],
    'three days, the third of them today',
  );
});

// The prune a restarted `serve` runs before it has written anything: the retention is a
// property of the directory, not of what this process happens to have appended to it.
test('a startup prune reaches days no reading of this run ever touched', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  given(dir, ['2026-03-01', '2026-08-07']);

  assert.deepEqual(store(dir, 30, clock).prune(), { removed: 1, failed: 0 });
  assert.deepEqual(fs.readdirSync(dir), ['2026-08-07.jsonl']);
});

// Only what we wrote. The same rule `reap.ts` states for the temp files, and the reason the
// journal lives in a directory of its own: a sweep that deleted by age alone would be a tool
// deleting a stranger's file out of the user's own home.
test('a prune leaves a file this store did not write, whatever its age', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 1, clock);
  s.append(sample(clock.now));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours\n');
  fs.writeFileSync(path.join(dir, '2020-01-01.jsonl.bak'), 'not our name\n');

  s.prune();

  assert.deepEqual(fs.readdirSync(dir).sort(), ['2020-01-01.jsonl.bak', '2026-08-07.jsonl', 'notes.txt']);
});

// `serve` runs for weeks. Pruning only at startup would let a machine left up since March hold
// every day since March, under a config file that says thirty.
test('the store prunes itself once the local day has turned over', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 2, clock);

  s.append(sample(clock.now));
  clock.now = at(2026, 8, 8);
  s.append(sample(clock.now));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-08-07.jsonl', '2026-08-08.jsonl'], 'both still inside two days');

  clock.now = at(2026, 8, 9);
  s.append(sample(clock.now));

  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-08-08.jsonl', '2026-08-09.jsonl'], 'the 7th aged out on its own');
});

// ── the hard cap ──────────────────────────────────────────────────────────────────────

test('the cap is 256 MB, and it is a constant nobody can set from outside', () => {
  assert.equal(HISTORY_MAX_BYTES, 268_435_456);
});

// An age limit alone is not a bound: a fleet of two hundred sessions writes a hundred times
// what the startup line quoted. Past the cap the journal stops rather than fills the disk.
test('past the cap nothing more is written, and the store says why', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 30, clock, 400);

  for (let i = 0; i < 20; i++) {
    clock.now = at(2026, 8, 7, 12) + i * 60_000;
    s.append(sample(clock.now));
  }

  const stats = s.stats();
  assert.ok(stats.bytes <= 400, `the cap held: ${stats.bytes} bytes`);
  assert.ok(stats.stopped !== null, 'and the reason is there to be printed');
  assert.match(stats.stopped!, /cap/i);
  assert.equal(stats.capped, true, 'and the cap says so as a fact, not as a string to be read');
  assert.ok(lines(dir, '2026-08-07').length < 20, 'the later readings were refused, not written');
});

// A reader who empties the directory by hand, which is what the README tells them to do to
// erase it, is a reader the cap has to notice too. `stopped` is recomputed on the write it
// would refuse, so a journal writing again cannot go on announcing that it is full.
test('a journal that has room again stops saying it is at its cap', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 30, clock, 400);
  for (let i = 0; i < 20; i++) {
    clock.now = at(2026, 8, 7, 12) + i * 60_000;
    s.append(sample(clock.now));
  }
  assert.ok(s.stats().stopped !== null, 'at the cap first, or this proves nothing');

  fs.rmSync(path.join(dir, '2026-08-07.jsonl'));
  s.append(sample(clock.now));

  assert.equal(s.stats().stopped, null, 'writing again, and no longer saying otherwise');
  assert.equal(lines(dir, '2026-08-07').length, 1);
});

// The cap is a stop, not a death sentence: the retention that made room is the retention that
// lets the journal resume, and a store that stayed stopped would need a restart to notice.
test('a prune that frees space lets the journal write again', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 2, clock, 400);

  for (let i = 0; i < 20; i++) {
    clock.now = at(2026, 8, 7, 12) + i * 60_000;
    s.append(sample(clock.now));
  }
  assert.ok(s.stats().stopped !== null, 'stopped first, or this proves nothing');

  clock.now = at(2026, 8, 12);
  s.prune();

  assert.equal(s.stats().stopped, null, 'the days that filled it are gone');
  s.append(sample(clock.now));
  assert.equal(lines(dir, '2026-08-12').length, 1);
});

// ── best effort, always ───────────────────────────────────────────────────────────────

// Hygiene must never be the reason `serve` falls over: it runs unattended for hours, and a
// throw out of the sampler is an unhandled rejection. A write that fails costs a line.
test('a write that cannot happen is counted, never thrown', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  fs.mkdirSync(dir, { recursive: true });
  // A directory wearing the day's name: every write to it fails, on every platform, with no
  // permission games a root-running CI would sail through.
  fs.mkdirSync(path.join(dir, '2026-08-07.jsonl'));
  const s = store(dir, 30, clock);

  assert.doesNotThrow(() => s.append(sample(clock.now)));
  assert.doesNotThrow(() => s.append(sample(clock.now)));

  assert.equal(s.stats().misses, 2, 'both of them, counted for whoever prints the line');
});

test('a directory that cannot be read reports no journal rather than throwing', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 30, clock);

  assert.deepEqual(s.stats(), { files: 0, bytes: 0, misses: 0, stopped: null, capped: false });
  assert.deepEqual(s.prune(), { removed: 0, failed: 0 });
});

test('the stats count the files on disk and what they weigh', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 30, clock);

  s.append(sample(clock.now));
  clock.now = at(2026, 8, 8);
  s.append(sample(clock.now));

  const stats = s.stats();
  assert.equal(stats.files, 2);
  assert.equal(
    stats.bytes,
    fs.statSync(path.join(dir, '2026-08-07.jsonl')).size + fs.statSync(path.join(dir, '2026-08-08.jsonl')).size,
  );
  assert.equal(stats.misses, 0);
  assert.equal(stats.stopped, null);
});

// ── where it lives ────────────────────────────────────────────────────────────────────

// A sibling of the snapshots, never a child of them. Three things already delete files under
// that directory (`reap.ts`, the wrapper's own sweep, the legacy purge in `install.ts`), and
// each of them decides by NAME: a journal sitting among the payloads would be one rename away
// from being somebody else's litter.
test('the journal is a sibling of the snapshots directory, on the same frozen base', () => {
  assert.equal(historyDirFor('/home/u/.local/state/tarmac/snapshots'), '/home/u/.local/state/tarmac/history');
  assert.equal(historyDirFor('/home/u/.local/state/tarmac/snapshots/'), '/home/u/.local/state/tarmac/history');
});

test('the file name rolls over with the year, not just with the day', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 12, 31, 23) };
  const s = store(dir, 30, clock);

  s.append(sample(clock.now));
  clock.now = at(2027, 1, 1, 1);
  s.append(sample(clock.now));

  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-12-31.jsonl', '2027-01-01.jsonl']);
  assert.equal(dayOf(at(2027, 1, 1, 1)), '2027-01-01', 'the year rolled over with the day');
});

// A retention so large the calendar cannot express it: `new Date(y, m, d - 100000000)` is an
// Invalid Date, its day reads `NaN-NaN-NaN`, and every real file name sorts BELOW that string.
// The prune then deleted the whole journal, which is the exact opposite of what the number
// asked for, in silence. A cutoff nothing can compute is a cutoff nothing is deleted by.
test('a retention too large for the calendar keeps everything, rather than deleting everything', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  given(dir, ['2020-01-01', '2026-08-06', '2026-08-07']);

  assert.deepEqual(store(dir, 300_000_000, clock).prune(), { removed: 0, failed: 0 });

  assert.equal(fs.readdirSync(dir).length, 3, 'a journal asked to be kept for a million years is kept');
});

// ── one owner ─────────────────────────────────────────────────────────────────────────

// The retention is a property of the DIRECTORY and the process that applies it is whichever
// `serve` started last: a `--history-days 1` started to try the setting out swept twenty-nine
// days a thirty-day serve had kept, in four seconds, and both then wrote a line a minute into
// the same files (#133). The lock is what gives the directory one owner.

const lockFile = (dir: string): string => path.join(dir, '.lock');

/** The mtime the filesystem really gave a file, which is the heartbeat the lock is read by. */
const beat = (dir: string): number => fs.statSync(lockFile(dir)).mtimeMs;

/** The lock as another serve, alive and beating at that instant, would have left it. */
const takenBy = (dir: string, pid: number, when: number): void => {
  fs.writeFileSync(lockFile(dir), `${pid}\n`);
  fs.utimesSync(lockFile(dir), when / 1000, when / 1000);
};

test('the first serve takes the directory, and the lock says which pid holds it', () => {
  const dir = path.join(tempDir('tarmac-lock-'), 'history');
  const clock = { now: at(2026, 8, 7) };

  const { lock, heldBy } = acquireJournalLock({ dir, now: () => clock.now });

  assert.equal(heldBy, null, 'nobody held it');
  assert.ok(lock, 'so this serve does');
  assert.equal(fs.readFileSync(lockFile(dir), 'utf8').trim(), String(process.pid), 'and it is on disk to be read');
});

test('a second serve is refused, and told the pid that holds the directory', () => {
  const dir = path.join(tempDir('tarmac-lock-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const first = acquireJournalLock({ dir, now: () => clock.now });
  assert.ok(first.lock);

  const second = acquireJournalLock({ dir, now: () => clock.now });

  assert.equal(second.lock, null, 'it journals nothing, so it sweeps nothing');
  assert.equal(second.heldBy, process.pid, 'and it can name the process to go and look at');
});

// The ordinary way a lock outlives its owner: a machine that lost power, a `kill -9`. Nothing
// released it, so the file is there and its heartbeat is as fresh as the moment it died. Only
// the pid says the truth, and a journal nobody can ever write again is not a fix.
test('a lock left behind by a dead pid is taken over', () => {
  const dir = path.join(tempDir('tarmac-lock-'), 'history');
  // A pid that really is gone: spawnSync returns having waited for it and reaped it.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockFile(dir), `${dead}\n`);
  // Pinned to the heartbeat it just wrote, so age cannot be what reclaims this one.
  const clock = { now: beat(dir) };

  const { lock, heldBy } = acquireJournalLock({ dir, now: () => clock.now });

  assert.equal(heldBy, null);
  assert.ok(lock);
  assert.equal(fs.readFileSync(lockFile(dir), 'utf8').trim(), String(process.pid), 'and the new owner signed it');
});

// The case the pid check cannot see, and the reason the heartbeat exists: pids are reused, so
// the number in a lock file abandoned last week can name a stranger who is very much alive and
// has never heard of this directory. Five minutes of silence is what settles it.
test('a heartbeat five minutes old is taken over, however alive the pid in it is', () => {
  const dir = path.join(tempDir('tarmac-lock-'), 'history');
  fs.mkdirSync(dir, { recursive: true });
  // This process: alive by any test the lock can make, and not refreshing anything.
  fs.writeFileSync(lockFile(dir), `${process.pid}\n`);
  const clock = { now: beat(dir) + 5 * 60_000 + 1 };

  const { lock, heldBy } = acquireJournalLock({ dir, now: () => clock.now });

  assert.equal(heldBy, null);
  assert.ok(lock);
});

test('a released lock leaves the directory free for the next serve', () => {
  const dir = path.join(tempDir('tarmac-lock-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const first = acquireJournalLock({ dir, now: () => clock.now });
  assert.ok(first.lock);

  first.lock.release();

  assert.equal(fs.existsSync(lockFile(dir)), false, 'nothing left to reclaim');
  assert.ok(acquireJournalLock({ dir, now: () => clock.now }).lock, 'and the next serve walks in');
});

// Without this, a serve that has been up for an hour is a serve whose lock reads as abandoned,
// and the next `serve` on the machine takes the directory off it and sweeps it.
test('every append pushes the heartbeat forward, so a long run keeps what it holds', () => {
  const dir = path.join(tempDir('tarmac-lock-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const { lock } = acquireJournalLock({ dir, now: () => clock.now });
  const s = createHistoryStore({ dir, days: 30, now: () => clock.now, lock });

  clock.now = at(2026, 8, 7, 18);
  s.append(sample(clock.now));

  assert.equal(beat(dir), clock.now, 'six hours later, and the lock says so');
});

// `DAY_FILE` is the name the writer uses and nothing else, which is what makes a directory of
// its own worth having. Asserted rather than trusted: the lock is the first file to live in
// there that the store did not write, and both the prune and the cap read that directory.
test('the lock is not journal data: the prune leaves it and it weighs nothing', () => {
  const dir = path.join(tempDir('tarmac-lock-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  acquireJournalLock({ dir, now: () => clock.now });
  given(dir, ['2026-08-07']);

  clock.now = at(2026, 9, 7);
  const pruned = store(dir, 1, clock).prune();

  assert.deepEqual(pruned, { removed: 1, failed: 0 }, 'the day file fell out of the retention');
  assert.ok(fs.existsSync(lockFile(dir)), 'the lock is not a day the retention may delete');
  assert.deepEqual(store(dir, 1, clock).stats(), { files: 0, bytes: 0, misses: 0, stopped: null, capped: false }, 'nor a file the cap counts');
});

// The other way a serve ends up with no lock, and it names nobody: a directory it cannot create
// or write in. Refusing there rather than journaling anyway costs nothing, since the day files
// would not go in either, and it is said at startup instead of once the first write has failed.
test('a directory it cannot write in leaves a serve with no lock and no pid to name', (t) => {
  if (process.getuid?.() === 0) {
    t.skip('running as root: 0555 denies nothing, the case cannot be built here');
    return;
  }
  const base = tempDir('tarmac-lock-');
  const dir = path.join(base, 'history');
  fs.chmodSync(base, 0o555);

  try {
    const { lock, heldBy } = acquireJournalLock({ dir, now: () => at(2026, 8, 7) });

    assert.equal(lock, null, 'no lock, so no store, so nothing swept and nothing written');
    assert.equal(heldBy, null, 'and no process to send the reader to look at');
  } finally {
    // Restored here, or the sandbox cannot remove what this test built.
    fs.chmodSync(base, 0o755);
  }
});

// Taking the directory at startup is half the promise; the other half is noticing it is gone.
// A serve whose lock was reclaimed while it was quiet kept writing into a directory that is now
// somebody else's, and swept it with a retention nobody there set, which is #133 arriving one
// heartbeat later. Ownership is therefore re-read on every append, not assumed from startup.
test('a store that lost its directory writes nothing more and sweeps nothing', () => {
  const dir = path.join(tempDir('tarmac-lock-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const { lock } = acquireJournalLock({ dir, now: () => clock.now });
  const s = createHistoryStore({ dir, days: 1, now: () => clock.now, lock });
  s.append(sample(clock.now));
  given(dir, ['2026-07-01']);

  clock.now = at(2026, 9, 7);
  // Pid 1 is alive on any machine this runs on and it is not us, and the heartbeat is this
  // instant: the directory belongs to a serve that is very much there.
  takenBy(dir, 1, clock.now);
  s.append(sample(clock.now));

  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort(), ['2026-07-01.jsonl', '2026-08-07.jsonl']);
  assert.match(String(s.stats().stopped), /\bpid 1\b/, 'and it says who has it, once, through the line serve already prints');
});

// The other way a lock stops being ours, and the opposite answer: `rm -rf history/` is what the
// manual tells a reader to do to erase the journal. Nobody took the directory, so this serve
// takes its own lock back rather than falling silent until it is restarted.
test('a store whose directory was erased takes its lock back and carries on', () => {
  const dir = path.join(tempDir('tarmac-lock-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const { lock } = acquireJournalLock({ dir, now: () => clock.now });
  const s = createHistoryStore({ dir, days: 30, now: () => clock.now, lock });
  s.append(sample(clock.now));

  fs.rmSync(dir, { recursive: true, force: true });
  s.append(sample(clock.now));

  assert.equal(fs.readFileSync(lockFile(dir), 'utf8').trim(), String(process.pid), 'the lock is ours again');
  assert.equal(lines(dir, '2026-08-07').length, 1, 'and the journal picked up where the erasure left it');
});

test('a lock another serve has taken is not one this process releases', () => {
  const dir = path.join(tempDir('tarmac-lock-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const { lock } = acquireJournalLock({ dir, now: () => clock.now });
  assert.ok(lock);
  fs.writeFileSync(lockFile(dir), '1\n');

  lock.release();

  assert.equal(fs.readFileSync(lockFile(dir), 'utf8').trim(), '1', 'the new owner keeps its directory');
});

// A pid this user may not signal is a pid that exists: `kill(pid, 0)` answers EPERM there, and
// reading that as "no such process" would hand a running serve's directory to the next one.
test('a lock naming a process this user may not signal is a lock that is held', () => {
  const dir = path.join(tempDir('tarmac-lock-'), 'history');
  fs.mkdirSync(dir, { recursive: true });
  // Pid 1 is the one process every machine has, and on any of them but a root shell it is the
  // one this user may not signal.
  fs.writeFileSync(lockFile(dir), '1\n');
  const clock = { now: beat(dir) };

  const { lock, heldBy } = acquireJournalLock({ dir, now: () => clock.now });

  assert.equal(lock, null);
  assert.equal(heldBy, 1);
});

// Taking the lock is `open(O_CREAT|O_EXCL)` and then a write, and between the two the file
// exists and is EMPTY. A second serve arriving in that window read no pid, so nothing looked
// held, and it removed the lock of a serve that was in the middle of taking it: two owners, on a
// window that is one syscall wide (11 rounds in 100 with two processes off a barrier). A fresh
// heartbeat holds the directory whether or not the pid can be read yet.
test('a lock still being written holds the directory, pid or no pid', () => {
  for (const [what, write] of [
    ['a file created and not yet written', (f: string) => fs.closeSync(fs.openSync(f, 'wx'))],
    ['a file that says nothing a pid can be read from', (f: string) => fs.writeFileSync(f, '\n')],
  ] as const) {
    const dir = path.join(tempDir('tarmac-lock-'), 'history');
    fs.mkdirSync(dir, { recursive: true });
    write(lockFile(dir));
    const clock = { now: beat(dir) };

    const { lock, heldBy } = acquireJournalLock({ dir, now: () => clock.now });

    assert.equal(lock, null, `${what}: the directory is somebody's`);
    assert.equal(heldBy, null, `${what}: and there is no pid to name yet`);
    assert.ok(fs.existsSync(lockFile(dir)), `${what}: the lock is still theirs`);
  }
});

// The other side of that rule, so an unreadable lock is not an unbreakable one: a file nobody
// can read a pid from is reclaimed on the heartbeat alone, five minutes after it went quiet.
test('an unreadable lock nobody has touched for five minutes is taken over', () => {
  const dir = path.join(tempDir('tarmac-lock-'), 'history');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockFile(dir), 'not a pid\n');
  const clock = { now: beat(dir) + 5 * 60_000 + 1 };

  const { lock } = acquireJournalLock({ dir, now: () => clock.now });

  assert.ok(lock, 'a corrupted lock costs five minutes, not a journal');
  assert.equal(fs.readFileSync(lockFile(dir), 'utf8').trim(), String(process.pid));
});

// The startup sweep runs on `listening`, before the first tick, and it is the destructive half
// of #133: `prune` is reached by two paths and only one of them passed through `append`.
test('a store that lost its directory prunes nothing, on the path that does not go through append', () => {
  const dir = path.join(tempDir('tarmac-lock-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const { lock } = acquireJournalLock({ dir, now: () => clock.now });
  const s = createHistoryStore({ dir, days: 1, now: () => clock.now, lock });
  given(dir, ['2026-07-01', '2026-07-02']);
  takenBy(dir, 1, clock.now);

  assert.deepEqual(s.prune(), { removed: 0, failed: 0 });

  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).length, 2, 'both days are somebody else\'s');
});

// The reclaim reads the lock twice: once to judge it abandoned, once to check that nothing
// arrived in between. Standing inside that window from a test takes the injected clock, which is
// called exactly once between the two reads: a lock that appeared there is not ours to remove.
test('a lock that changed since it was judged is not the lock a reclaim removes', () => {
  const dir = path.join(tempDir('tarmac-lock-'), 'history');
  fs.mkdirSync(dir, { recursive: true });
  // Abandoned by a process that really is gone, so this acquire sets out to reclaim it.
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(lockFile(dir), `${dead}\n`);
  const judged = beat(dir);
  let arrived = false;
  const now = (): number => {
    // Another serve gets there first, between the judgement and the unlink.
    if (!arrived) takenBy(dir, 1, judged + 1000);
    arrived = true;
    return judged;
  };

  const { lock, heldBy } = acquireJournalLock({ dir, now });

  assert.equal(lock, null, 'the lock that arrived in the window is not the one that was judged');
  assert.equal(heldBy, 1, 'and the serve that owns it now is the one to name');
});

// `stopped` is a sentence for a reader and it now has two causes; `capped` is the one a machine
// reads. `/api/history` carries it into `coverage.capped`, which a page renders as "journal
// capped": a serve that lost its directory has not filled anything, and must not say it has.
test('a store that lost its directory says it stopped, and never that it was capped', () => {
  const dir = path.join(tempDir('tarmac-lock-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const { lock } = acquireJournalLock({ dir, now: () => clock.now });
  const s = createHistoryStore({ dir, days: 30, now: () => clock.now, lock });
  takenBy(dir, 1, clock.now);

  s.append(sample(clock.now));

  assert.match(String(s.stats().stopped), /\bpid 1\b/);
  assert.equal(s.stats().capped, false, 'nothing here is full');
});

// ── reading its own journal back ──────────────────────────────────────────────────────────
//
// The store owns both ends of the directory it holds: it writes the lines and it answers the
// range reads off them. That is one seam rather than two, and it is what lets a journal exist
// that nothing ever wrote — `serve --demo` hands the server a store with a week of invented
// days behind it, and the server asks it the same question it asks a real one (#156).

test('a store answers a range read off the days it wrote, and carries its own cap into it', async () => {
  const dir = path.join(tempDir('tarmac-store-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 30, clock);
  s.append(sample(clock.now));

  const week = await s.read('7d', clock.now);

  assert.equal(week.range, '7d');
  assert.equal(week.coverage.lines, 1, 'the store did not read the line it had just written');
  assert.deepEqual(week.days.map((d) => d.date), [dayOf(clock.now)]);
  assert.equal(week.coverage.capped, false);

  // A store stopped at its ceiling has the shape of a fleet that went quiet, and only the writer
  // knows which it is. Reading through the store is what carries that fact to the reader.
  const full = store(dir, 30, clock, 1);
  full.append(sample(clock.now));
  assert.equal((await full.read('7d', clock.now)).coverage.capped, true, 'the cap did not reach the range');
});
