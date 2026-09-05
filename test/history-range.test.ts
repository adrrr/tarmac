// Reading the journal back, which is the half of it a person actually looks at.
//
// The store writes one line a minute and never reads; this reads a week or a month of those
// lines and answers the three questions the journal exists for: did this context climb, what
// did the week cost and where, when did the plan window turn over. Everything here is about
// two properties of that read. It aggregates the way the maintainer said it does, and it
// survives a file that is not entirely well formed: a full disk tears a line in half and the
// next append glues itself behind it (#134), so one bad byte may not cost a reader the range.
//
// The clock is injected in every test, and every fixture is written by the test itself. A
// range judged by the wall clock is a suite that changes its answer at midnight, and a range
// read off a real journal is a suite that reads someone's session ids.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readRange } from '../src/history-range.ts';
import { waitForSettled } from './bounded.ts';
import { tempDir } from './sandbox.ts';

/** Noon on a named calendar day, local. Noon so no fixture sits within an hour of a DST shift. */
const at = (y: number, m: number, d: number, h = 12, min = 0): number =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime();

/** The start of the local hour a moment falls in, which is what an hour bucket is dated by. */
function hourOf(t: number): number {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

interface SessionFields {
  sid?: string | null;
  project?: string | null;
  kind?: string | null;
  state?: string | null;
  ctxState?: string;
  ctxPct?: number | null;
  costUsd?: number | null;
}

const sess = (over: SessionFields = {}): SessionFields => ({
  sid: 's1',
  project: 'alpha',
  kind: 'interactive',
  state: 'idle',
  ctxState: 'ok',
  ctxPct: 26,
  costUsd: 1,
  ...over,
});

const pct = (five: number | null, seven: number | null): Record<string, unknown> => ({
  five_hour: { used_percentage: five },
  seven_day: { used_percentage: seven },
});

const rec = (
  t: number,
  sessions: SessionFields[],
  rateLimits: Record<string, unknown> | null = null,
): Record<string, unknown> => ({ t, sessions, rateLimits });

/** A journal directory nobody else writes to, empty until a test puts a day in it. */
function journal(): string {
  const dir = path.join(tempDir('tarmac-range-'), 'history');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A FIFO where a day file should be, carrying the name the store itself would write.
 *
 * `mkfifo` rather than a node call, there being none: making one is POSIX and the two runners
 * this suite is built for are Linux and macOS. A failure to make it is asserted rather than
 * skipped — a skip here would be a green run that proved nothing about the read it exists for.
 */
function fifoDay(dir: string, date: string): string {
  const file = path.join(dir, `${date}.jsonl`);
  const made = spawnSync('mkfifo', [file]);
  assert.equal(made.status, 0, `mkfifo ${file}: ${made.error?.message ?? made.stderr}`);
  return file;
}

/**
 * Opens the write end of a FIFO a reader may be blocked on, and closes it: the blocked open
 * returns, the read sees end of file, and the thread it was holding goes back. Non-blocking, so
 * where there is no reader this is `ENXIO` and nothing at all — which is the passing case.
 */
function unblock(fifo: string): void {
  try {
    fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
  } catch {
    // ENXIO: nobody was blocked, which is what a fixed reader leaves behind.
  }
}

/** Appends a day file exactly as the store does: one record a line, each line terminated. */
function day(dir: string, date: string, records: Array<Record<string, unknown> | string>): void {
  const text = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
  fs.appendFileSync(path.join(dir, `${date}.jsonl`), text);
}

// ── which files a range reads ─────────────────────────────────────────────────────────

test('a range reads the days it covers and passes over the days no serve was running', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [rec(at(2026, 8, 7, 9), [sess()]), rec(at(2026, 8, 7, 10), [sess()])]);
  // Nothing for the 6th: the machine was off, and a day with no file is not a day with no cost.
  day(dir, '2026-08-05', [rec(at(2026, 8, 5, 9), [sess()])]);

  const range = await readRange({ dir, range: '7d', now });

  assert.deepEqual(range.coverage, {
    daysRequested: 7,
    lines: 3,
    skipped: 0,
    outOfRange: 0,
    droppedSessions: 0,
    capped: false,
  });
  assert.deepEqual(
    range.days.map((d) => d.date),
    ['2026-08-05', '2026-08-07'],
    'the days that were there, oldest first, and no empty day invented between them',
  );
});

test('a 7d range stops at seven days where a 30d range keeps reading', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [rec(at(2026, 8, 7, 9), [sess()])]);
  day(dir, '2026-07-28', [rec(at(2026, 7, 28, 9), [sess()])]);

  const week = await readRange({ dir, range: '7d', now });
  const month = await readRange({ dir, range: '30d', now });

  assert.equal(week.days.length, 1, 'the 28th is ten days back');
  assert.equal(week.coverage.daysRequested, 7);
  assert.equal(month.days.length, 2);
  assert.equal(month.coverage.daysRequested, 30);
});

test('a directory that is not there yet reads as an empty range, and never as a failure', async () => {
  const range = await readRange({ dir: path.join(tempDir('tarmac-range-'), 'nothing'), range: '7d', now: at(2026, 8, 7) });

  assert.deepEqual(range.coverage, {
    daysRequested: 7,
    lines: 0,
    skipped: 0,
    outOfRange: 0,
    droppedSessions: 0,
    capped: false,
  });
  assert.deepEqual(range.hours, []);
  assert.deepEqual(range.days, []);
  assert.deepEqual(range.resets, []);
});

// The journal directory belongs to whoever owns the machine, and a day file is opened by the
// name the store would have written — so what is behind that name is not this reader's to
// assume. `fs.readFile` on a FIFO blocks until someone writes to the other end, which hung the
// range read, the request waiting on it, and every request that joined the cached read behind
// it (#136). The wait below is bounded for the same reason the fix is: a test of a read that
// hangs, waited on with nothing to stop it, does not fail — it stops the file.
test('a day file that is not a regular file is counted and stepped over, never opened', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  const fifo = fifoDay(dir, '2026-08-07');
  day(dir, '2026-08-06', [rec(at(2026, 8, 6, 9), [sess()])]);

  try {
    const range = await waitForSettled(readRange({ dir, range: '7d', now }), 'a range read over a FIFO');

    assert.equal(range.coverage.lines, 1, 'the day beside it is read as it always was');
    assert.equal(range.coverage.skipped, 1, 'and the one that is not a file is counted, not swallowed');
    assert.deepEqual(
      range.days.map((d) => d.date),
      ['2026-08-06'],
      'a name nothing could be read from is not a day this range covers',
    );
  } finally {
    // Releases a read that IS blocked, so a failing run reports and then ends: an open that
    // never returns holds a libuv thread, and the file would never exit to print the failure.
    // On a passing run nothing is blocked and the open finds no reader — ENXIO, and nothing
    // to release.
    unblock(fifo);
  }
});

// ── the hour ──────────────────────────────────────────────────────────────────────────

test('an hour keeps the highest context it saw and the last cost and state it was left in', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 10, 5), [sess({ ctxPct: 20, costUsd: 1, state: 'idle' })]),
    rec(at(2026, 8, 7, 10, 40), [sess({ ctxPct: 55, costUsd: 2, state: 'busy' })]),
    // The peak is not the end of the hour: a session compacted at 10:50 is still a session that
    // reached 55, which is the whole reason to keep a maximum rather than the last reading.
    rec(at(2026, 8, 7, 10, 50), [sess({ ctxPct: 30, costUsd: 3, state: 'waiting' })]),
    rec(at(2026, 8, 7, 11, 5), [sess({ ctxPct: 31, costUsd: 4, state: 'idle' })]),
  ]);

  const { hours } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(
    hours.map((h) => h.t),
    [hourOf(at(2026, 8, 7, 10)), hourOf(at(2026, 8, 7, 11))],
    'one entry an hour, dated by the start of the local hour',
  );
  assert.deepEqual(hours[0].sessions, [
    { sid: 's1', project: 'alpha', kind: 'interactive', ctxPct: 55, costUsd: 3, state: 'waiting' },
  ]);
  assert.equal(hours[1].sessions[0].ctxPct, 31);
});

test('an hour that measured nothing carries no number, rather than a zero', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [rec(at(2026, 8, 7, 10, 5), [sess({ ctxPct: null, costUsd: null })])]);

  const { hours } = await readRange({ dir, range: '7d', now });

  assert.equal(hours[0].sessions[0].ctxPct, null);
  assert.equal(hours[0].sessions[0].costUsd, null);
  assert.deepEqual(hours[0].rateLimits, { five_hour: null, seven_day: null });
});

test('a reading with no session id is not followed from one minute to the next', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 10, 5), [sess({ sid: null, costUsd: 5 }), sess({ sid: 's2', costUsd: 1 })]),
    rec(at(2026, 8, 7, 10, 6), [sess({ sid: null, costUsd: 9 }), sess({ sid: 's2', costUsd: 2 })]),
  ]);

  const { hours, days } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(
    hours[0].sessions.map((s) => s.sid),
    ['s2'],
    'two nameless readings are not one session, and merging them would invent a cost',
  );
  assert.deepEqual(days[0].byProject, [{ project: 'alpha', costUsd: 1 }]);
});

// ── the day, and what a project cost on it ────────────────────────────────────────────

test('a project costs what its sessions spent that day, not what they had already spent', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 9), [sess({ costUsd: 10 })]),
    rec(at(2026, 8, 7, 17), [sess({ costUsd: 14 })]),
  ]);

  const { days } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(days, [{ date: '2026-08-07', byProject: [{ project: 'alpha', costUsd: 4 }] }]);
});

// The nightly recycle, in the middle of a day: one project, two session ids, and a total that
// is the sum of what each of them spent. Charging the last reading of each would count the
// first session's whole life twice over.
test('a session recycled during the day is two ids and one project total', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 9), [sess({ sid: 'before', costUsd: 2 })]),
    rec(at(2026, 8, 7, 11), [sess({ sid: 'before', costUsd: 5 })]),
    rec(at(2026, 8, 7, 15), [sess({ sid: 'after', costUsd: 1 })]),
    rec(at(2026, 8, 7, 19), [sess({ sid: 'after', costUsd: 6 })]),
  ]);

  const { days } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(days[0].byProject, [{ project: 'alpha', costUsd: 8 }], '3 spent before, 5 after');
});

// A session left open overnight carries its whole cost into the next morning's first reading.
// Charged as a total it would bill the 7th for everything the 6th spent.
test('a session that crosses midnight is charged to each day for what it spent on it', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-06', [
    rec(at(2026, 8, 6, 9), [sess({ costUsd: 1 })]),
    rec(at(2026, 8, 6, 23), [sess({ costUsd: 4 })]),
  ]);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 1), [sess({ costUsd: 4 })]),
    rec(at(2026, 8, 7, 9), [sess({ costUsd: 9 })]),
  ]);

  const { days } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(days, [
    { date: '2026-08-06', byProject: [{ project: 'alpha', costUsd: 3 }] },
    { date: '2026-08-07', byProject: [{ project: 'alpha', costUsd: 5 }] },
  ]);
});

test('the projects of a day come back with the most expensive first', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 9), [
      sess({ sid: 'a', project: 'alpha', costUsd: 0 }),
      sess({ sid: 'b', project: 'beta', costUsd: 0 }),
      sess({ sid: 'c', project: 'gamma', costUsd: 0 }),
    ]),
    rec(at(2026, 8, 7, 17), [
      sess({ sid: 'a', project: 'alpha', costUsd: 2 }),
      sess({ sid: 'b', project: 'beta', costUsd: 7 }),
      sess({ sid: 'c', project: 'gamma', costUsd: 5 }),
    ]),
  ]);

  const { days } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(days[0].byProject, [
    { project: 'beta', costUsd: 7 },
    { project: 'gamma', costUsd: 5 },
    { project: 'alpha', costUsd: 2 },
  ]);
});

// ── the plan window ───────────────────────────────────────────────────────────────────

test('an hour keeps the highest each window reached in it', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 10, 5), [sess()], pct(17, 40)),
    rec(at(2026, 8, 7, 10, 40), [sess()], pct(63, 41)),
    rec(at(2026, 8, 7, 10, 50), [sess()], pct(58, 39)),
  ]);

  const { hours } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(hours[0].rateLimits, { five_hour: 63, seven_day: 41 });
});

test('a five-hour window that fell away is the moment it turned over', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 13, 58), [sess()], pct(78, 40)),
    rec(at(2026, 8, 7, 13, 59), [sess()], pct(3, 40)),
  ]);

  const { resets } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(resets, [
    { limit: 'five_hour', t: at(2026, 8, 7, 13, 59), from: 78, to: 3, sinceMs: 60_000 },
  ]);
});

// A rolling window sags as the oldest usage in it ages out, a point or two at a time. Calling
// that a reset would draw a turnover marker on the curve several times an hour.
test('a window that sagged by a couple of points has not turned over', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 13, 58), [sess()], pct(40, 62)),
    rec(at(2026, 8, 7, 13, 59), [sess()], pct(38, 60)),
  ]);

  const { resets } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(resets, []);
});

test('the seven-day window turns over too, and says which window it was', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 8), [sess()], pct(20, 91)),
    rec(at(2026, 8, 7, 9), [sess()], pct(21, 12)),
  ]);

  const { resets } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(resets, [
    { limit: 'seven_day', t: at(2026, 8, 7, 9), from: 91, to: 12, sinceMs: 3_600_000 },
  ]);
});

// ── a file that is not entirely well formed (#134) ────────────────────────────────────

// `appendFileSync` loops on `writeSync`, so a full volume leaves half a record behind and the
// next append glues itself to it. Reproduced on a full disk as
// `{"t":1,"sessi{"t":1787994757062,…`. One torn line may not cost a reader the month.
test('a line torn in half by a full disk is counted, and the rest of the file is read', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  const good = rec(at(2026, 8, 7, 10), [sess({ costUsd: 1 })]);
  const glued = '{"t":17879947,"sessi' + JSON.stringify(rec(at(2026, 8, 7, 11), [sess({ costUsd: 2 })]));
  day(dir, '2026-08-07', [good, glued, rec(at(2026, 8, 7, 12), [sess({ costUsd: 3 })])]);

  const range = await readRange({ dir, range: '7d', now });

  assert.equal(range.coverage.lines, 2, 'the two whole records');
  assert.equal(range.coverage.skipped, 1, 'and the torn one, counted rather than swallowed');
  assert.deepEqual(
    range.hours.map((h) => h.t),
    [hourOf(at(2026, 8, 7, 10)), hourOf(at(2026, 8, 7, 12))],
    'the hours the file could still speak for',
  );
});

test('a line that parses but is not a record is skipped, not read as an empty fleet', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  const t = at(2026, 8, 7, 11);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 10), [sess()]),
    // Valid JSON, none of it a reading, and every clock here is one the range would have taken:
    // no clock at all, a clock that is not a number, sessions that are not a list, and two
    // records that are not records.
    '{"sessions":[]}',
    `{"t":"just now","sessions":[]}`,
    `{"t":${t},"sessions":{}}`,
    '[1,2,3]',
    'null',
    rec(at(2026, 8, 7, 12), [sess()]),
  ]);

  const range = await readRange({ dir, range: '7d', now });

  assert.equal(range.coverage.lines, 2);
  assert.equal(range.coverage.skipped, 5);
});

// ── forgiving inside the frame ────────────────────────────────────────────────────────
// A record needs a clock and a list of sessions, because everything is bucketed on those.
// Everything else is a value that may be missing, and a value that will not read is absent,
// never a reason to throw away the reading it was written beside.

// `rate_limits: []` is legal JSON, `src/limits.ts` names it as a shape the source can send,
// and `src/snapshots.ts` lets it through because `typeof [] === 'object'`. The live gauges
// read it as two windows nobody measured. Refusing the line here would blank a whole month
// of costs, contexts and projects the day Claude Code sends one.
test('a rate limits field that is not two windows costs the windows, never the reading', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    { t: at(2026, 8, 7, 10), sessions: [sess({ costUsd: 1 })], rateLimits: [] },
    { t: at(2026, 8, 7, 11), sessions: [sess({ costUsd: 4 })], rateLimits: 'none' },
  ]);

  const range = await readRange({ dir, range: '7d', now });

  assert.equal(range.coverage.skipped, 0, 'neither line was thrown away');
  assert.equal(range.coverage.lines, 2);
  assert.deepEqual(range.hours[0].rateLimits, { five_hour: null, seven_day: null });
  assert.deepEqual(range.days[0].byProject, [{ project: 'alpha', costUsd: 3 }], 'and the fleet is still there');
});

test('a session entry that is not an object costs that entry, never the ones beside it', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    { t: at(2026, 8, 7, 10), sessions: [sess({ sid: 's1' }), 's2', sess({ sid: 's3' })], rateLimits: null },
  ]);

  const range = await readRange({ dir, range: '7d', now });

  assert.equal(range.coverage.lines, 1);
  assert.equal(range.coverage.droppedSessions, 1, 'the entry that was not an object, counted');
  assert.deepEqual(
    range.hours[0].sessions.map((s) => s.sid),
    ['s1', 's3'],
  );
});

// The store appends in the order it reads, so a file is normally chronological. A clock that
// jumps backwards (an NTP correction, a machine resumed from sleep) writes one that is not,
// and an hour is a bucket of a clock, never of a file offset.
test('records out of order in a file are read by their own clock', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 10, 50), [sess({ ctxPct: 30, costUsd: 3, state: 'waiting' })]),
    rec(at(2026, 8, 7, 10, 5), [sess({ ctxPct: 20, costUsd: 1, state: 'idle' })]),
    rec(at(2026, 8, 7, 9, 5), [sess({ ctxPct: 10, costUsd: 0, state: 'idle' })]),
  ]);

  const { hours } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(
    hours.map((h) => h.t),
    [hourOf(at(2026, 8, 7, 9)), hourOf(at(2026, 8, 7, 10))],
    'oldest hour first, whatever order the lines arrived in',
  );
  assert.equal(hours[1].sessions[0].costUsd, 3, 'the cost of the latest reading, not of the last line');
  assert.equal(hours[1].sessions[0].state, 'waiting');
});

// The five-hour window rolls over four or five times a day, and one of those turns is at
// four in the morning: a reader that started its comparison afresh with each file would miss
// every reset that happens while nobody is awake.
test('a window that turns over in the night is a reset, across two day files', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-06', [rec(at(2026, 8, 6, 23, 58), [sess()], pct(78, 40))]);
  day(dir, '2026-08-07', [rec(at(2026, 8, 7, 0, 2), [sess()], pct(3, 40))]);

  const { resets } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(resets, [
    { limit: 'five_hour', t: at(2026, 8, 7, 0, 2), from: 78, to: 3, sinceMs: 4 * 60_000 },
  ]);
});

test('five points is a window sagging, six is a window that turned over', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 9), [sess()], pct(40, 10)),
    rec(at(2026, 8, 7, 10), [sess()], pct(35, 10)),
    rec(at(2026, 8, 7, 11), [sess()], pct(29, 10)),
  ]);

  const { resets } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(resets, [
    { limit: 'five_hour', t: at(2026, 8, 7, 11), from: 35, to: 29, sinceMs: 3_600_000 },
  ]);
});

// The store names the file with its own clock and the line carries the reading's, so the two
// can disagree: a torn line that still parses, or a clock that jumped, dates a record in 1970
// or in the year 41000. An hour outside the range asked for is an hour on somebody's chart.
test('a reading dated outside the range it was found in is skipped, not drawn in 1970', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(17879947, [sess()]),
    rec(1e300, [sess()]),
    rec(at(2026, 8, 7, 10), [sess()]),
  ]);

  const range = await readRange({ dir, range: '7d', now });

  assert.equal(range.coverage.lines, 1);
  assert.equal(range.coverage.outOfRange, 2);
  assert.equal(range.coverage.skipped, 0, 'neither of them is a torn line');
  assert.deepEqual(
    range.hours.map((h) => h.t),
    [hourOf(at(2026, 8, 7, 10))],
    'one hour, inside the week that was asked for',
  );
});

test('the project of a day survives a last reading that could not name it', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 9), [sess({ project: 'alpha', costUsd: 1 })]),
    rec(at(2026, 8, 7, 17), [sess({ project: 'alpha', costUsd: 3 })]),
    rec(at(2026, 8, 7, 17, 30), [sess({ project: null, costUsd: 5 })]),
  ]);

  const { days, hours } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(days[0].byProject, [{ project: 'alpha', costUsd: 4 }], 'not moved under a nameless heading');
  assert.equal(hours[1].sessions[0].project, 'alpha', 'and the same inside the hour');
});

// ── what the hour carries for a curve to be drawn from ────────────────────────────────

// The promise is "the last cost that was MEASURED", and a reading that measured none is not a
// measurement. Seeded with the clock of a reading that carried no cost, the guard that keeps
// the latest one refused every earlier reading that did.
test('a reading with no cost does not bury an earlier one that had one', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 9, 30), [sess({ ctxPct: 40, costUsd: null })]),
    rec(at(2026, 8, 7, 9, 10), [sess({ ctxPct: 41, costUsd: 7 })]),
  ]);

  const { hours } = await readRange({ dir, range: '7d', now });

  assert.equal(hours[0].sessions[0].costUsd, 7);
  assert.equal(hours[0].sessions[0].ctxPct, 41, 'and the highest of the hour, either way round');
});

// `claude agents --json` reports sessions it could not name an id for, and the ring writes them
// down with `sid: null`. A payload that writes an empty string instead is the same fact wearing
// a different type, and one bucket named "" would fold every one of them into a single session.
test('an empty session id is no more an identity than a missing one', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 10), [sess({ sid: '', costUsd: 5 }), sess({ sid: 's2', costUsd: 1 })]),
    rec(at(2026, 8, 7, 11), [sess({ sid: '', costUsd: 9 }), sess({ sid: 's2', costUsd: 2 })]),
  ]);

  const { hours, days, coverage } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(
    hours[0].sessions.map((s) => s.sid),
    ['s2'],
  );
  assert.deepEqual(days[0].byProject, [{ project: 'alpha', costUsd: 1 }]);
  assert.equal(coverage.droppedSessions, 2, 'and the two that were dropped are counted');
});

// A window tarmac cannot read is not a window at zero, and it is not a window that moved. Taken
// as either, the two minutes an unreadable payload lasts would put a turnover marker on the
// curve and then hide the real one behind it.
test('a window that could not be read is not a step in the fall around it', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 9), [sess()], pct(90, 10)),
    { t: at(2026, 8, 7, 10), sessions: [sess()], rateLimits: [] },
    rec(at(2026, 8, 7, 11), [sess()], pct(null, 10)),
    rec(at(2026, 8, 7, 12), [sess()], pct(2, 10)),
  ]);

  const { resets } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(resets.map(({ limit, t, from, to }) => ({ limit, t, from, to })), [
    { limit: 'five_hour', t: at(2026, 8, 7, 12), from: 90, to: 2 },
  ]);
});

// The view has to be able to leave the background agents out of a context curve, and the kind
// is in the file already. Like the project it is an identity rather than a measurement: a
// minute that could not name it has not turned an agent into an interactive session.
test('an hour says what kind each session was, and a reading that could not say does not unsay it', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 10, 5), [sess({ kind: 'interactive' })]),
    rec(at(2026, 8, 7, 10, 20), [sess({ kind: 'background' })]),
    rec(at(2026, 8, 7, 10, 50), [sess({ kind: null })]),
  ]);

  const { hours } = await readRange({ dir, range: '7d', now });

  assert.equal(hours[0].sessions[0].kind, 'background');
});

// An hour built from one reading and an hour built from sixty are drawn the same and mean
// different things: the first is a serve that was starting or stopping, or a laptop asleep.
test('an hour says how many readings it was built from', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 10, 5), [sess()]),
    rec(at(2026, 8, 7, 10, 20), [sess()]),
    rec(at(2026, 8, 7, 10, 50), [sess()]),
    rec(at(2026, 8, 7, 11, 5), [sess()]),
  ]);

  const { hours } = await readRange({ dir, range: '7d', now });

  assert.deepEqual(
    hours.map((h) => h.n),
    [3, 1],
  );
});

// A reset is dated by the reading AFTER the fall, so a turnover that happened while the serve
// was off is dated at the moment it came back. The gap says which of the two this is.
test('a reset says how long since the reading it fell from', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-05', [rec(at(2026, 8, 5, 20), [sess()], pct(78, 40))]);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 9), [sess()], pct(3, 40)),
    rec(at(2026, 8, 7, 9, 1), [sess()], pct(9, 40)),
    rec(at(2026, 8, 7, 9, 2), [sess()], pct(1, 40)),
  ]);

  const { resets } = await readRange({ dir, range: '7d', now });

  assert.equal(resets.length, 2);
  assert.equal(resets[0].sinceMs, at(2026, 8, 7, 9) - at(2026, 8, 5, 20), 'a day and a half of serve that was off');
  assert.equal(resets[1].sinceMs, 60_000, 'and a minute for the one that was watched');
});

// A journal that stopped at its cap has the shape of a fleet that went quiet: files, lines,
// and then nothing. The reader cannot see the difference, so the answer carries what the writer
// knows about itself.
test('a range says when the journal it read had stopped writing', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [rec(at(2026, 8, 7, 10), [sess()])]);

  const open = await readRange({ dir, range: '7d', now });
  const full = await readRange({ dir, range: '7d', now, capped: true });

  assert.equal(open.coverage.capped, false);
  assert.equal(full.coverage.capped, true);
});

// #134 is about a torn line, and a reader that filed a line dated in 1970 under the same count
// would make its own number useless for the thing it was added for.
test('a line nobody could parse and a line dated elsewhere are counted apart', async () => {
  const dir = journal();
  const now = at(2026, 8, 7);
  day(dir, '2026-08-07', [
    rec(at(2026, 8, 7, 10), [sess()]),
    '{"t":' + at(2026, 8, 7, 11) + ',"sessi',
    rec(17879947, [sess()]),
  ]);

  const { coverage } = await readRange({ dir, range: '7d', now });

  assert.equal(coverage.lines, 1);
  assert.equal(coverage.skipped, 1, 'the torn one');
  assert.equal(coverage.outOfRange, 1, 'the one dated outside the week');
});
