// The shapes the history view draws, and the page it draws them on.
//
// The charts themselves are pixels and no test can read them. What every one of them IS
// readable as is the series handed to the drawing: eight lines with a hole in them, a stack
// of bars in a fixed order, a pair of quota windows. Those are decisions — which minute is a
// gap, which reading starts a new line, what an hour cost when the number on the wire is a
// running total — and they are what this file pins.
//
// So the transforms live in TypeScript, are tested here directly, and are shipped to the
// browser as their own source (`historyScript` writes them out with `String`). The page runs
// the function this file just called, not a copy of it kept in step by hand.
//
// Every clock is built by the test. A local day is what the journal names its files after and
// what a bar on the cost chart covers, so a fixture parsed as UTC would draw the wrong day in
// half the world.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  costDaily,
  costHourly,
  ctxKeys,
  ctxLines,
  ctxRows,
  decimate,
  fillAlpha,
  gridLen,
  historyScript,
  legendByCost,
  quotaOfHours,
  quotaOfSamples,
  renderHistoryView,
  rising,
  rosterOf,
} from '../src/history-view.ts';
import { HISTORY_CSS, HISTORY_PHONE_CSS } from '../src/history-view.ts';
import { renderPage } from '../src/render.ts';
import { health, row } from './fleet-fixtures.ts';
import type { Fleet, FleetRow } from '../src/fleet.ts';

const MIN = 60_000;
const HOUR = 3_600_000;

/** Noon on a named local day, so no fixture sits within an hour of a DST shift. */
const at = (y: number, m: number, d: number, h = 12, min = 0): number =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime();

interface SessionIn {
  sid?: string | null;
  project?: string | null;
  kind?: string | null;
  ctxPct?: number | null;
  costUsd?: number | null;
  state?: string | null;
}

/** One ring sample, with only the fields the view reads spelled out. */
const sample = (t: number, sessions: SessionIn[], rateLimits: unknown = null): any => ({
  t,
  sessions: sessions.map((s) => ({
    sid: 'sid' in s ? s.sid : 'a',
    project: s.project ?? 'alpha',
    kind: s.kind ?? 'interactive',
    state: s.state ?? 'idle',
    waitingFor: null,
    ctxState: 'fresh',
    ctxPct: s.ctxPct ?? null,
    costUsd: s.costUsd ?? null,
  })),
  rateLimits,
});

/** One hour off the journal reader, same reduction. */
const hour = (t: number, sessions: SessionIn[], five: number | null = null, seven: number | null = null): any => ({
  t,
  n: 60,
  sessions: sessions.map((s) => ({
    sid: s.sid ?? 'a',
    project: s.project ?? 'alpha',
    kind: s.kind ?? 'interactive',
    ctxPct: s.ctxPct ?? null,
    costUsd: s.costUsd ?? null,
    state: s.state ?? 'idle',
  })),
  rateLimits: { five_hour: five, seven_day: seven },
});

const windows = (five: number | null, seven: number | null): unknown => ({
  five_hour: five === null ? null : { used_percentage: five },
  seven_day: seven === null ? null : { used_percentage: seven },
});

// ── the roster: who gets which colour ────────────────────────────────────────────────────

test('the palette is handed out in one fixed order, so a project keeps its colour', () => {
  const r = rosterOf(['zulu', 'alpha', 'mike', 'alpha']);
  assert.deepEqual(
    r.map((p) => p.name),
    ['alpha', 'mike', 'zulu'],
  );
  assert.deepEqual(
    r.map((p) => p.slot),
    [1, 2, 3],
  );
});

test('a ninth project wraps back onto the first colour rather than falling off the palette', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
  const r = rosterOf(names);
  assert.equal(r.length, 9);
  assert.equal(r[8].slot, 1);
});

test('a session with no project is kept, and sorts last', () => {
  const r = rosterOf(['beta', null, 'alpha']);
  assert.deepEqual(
    r.map((p) => p.name),
    ['alpha', 'beta', null],
  );
});

// ── decimation ───────────────────────────────────────────────────────────────────────────

test('decimation keeps the highest reading in each pixel, never the first one it met', () => {
  const v = [10, 90, 12, 11, 13, 14];
  assert.deepEqual(decimate(v, 2).v, [90, 14]);
});

test('a bucket holding a minute nobody read is a gap, not the max of the rest', () => {
  const v = [10, null, 12, 11, 13, 14];
  assert.deepEqual(decimate(v, 2).v, [null, 14]);
});

test('a series already shorter than the plot is handed over untouched', () => {
  const v = [1, 2, 3];
  const out = decimate(v, 500);
  assert.equal(out.step, 1);
  assert.deepEqual(out.v, v);
});

// ── nothing off the wire may throw ───────────────────────────────────────────────────────
//
// The account's gauges have carried this rule since they were written: a dashboard may not be
// blanked by one field of one answer. The grids here are where that rule bites, because the
// arithmetic that sizes them is a division, and `Math.round(x / 0)` is Infinity, and an array
// of that length throws before anything is drawn at all.

test('a cadence nothing can be divided by draws nothing, rather than throwing', () => {
  const t0 = at(2026, 8, 29, 10, 0);
  const two = [sample(t0, [{ ctxPct: 40 }]), sample(t0 + MIN, [{ ctxPct: 44 }])];
  assert.deepEqual(ctxLines(two, 0, rosterOf(['alpha'])), []);
  assert.deepEqual(quotaOfSamples(two, 0).five, []);
  assert.equal(gridLen(t0, t0 + MIN, 0), 0);
  assert.equal(gridLen(t0, t0 + MIN, -1), 0);
  assert.equal(gridLen(t0, t0 + MIN, MIN), 2);
});

test('a day whose name is not a date is dropped, never drawn at NaN', () => {
  const c = costDaily(
    [
      { date: 'readme.txt', byProject: [{ project: 'alpha', costUsd: 5 }] },
      { date: '2026-08-29', byProject: [{ project: 'alpha', costUsd: 3 }] },
    ],
    rosterOf(['alpha']),
  );
  assert.equal(c.buckets.length, 1);
  assert.equal(c.buckets[0].t, at(2026, 8, 29, 0, 0));
});

test('a plot with no pixels to spend still answers with a step a caller can multiply by', () => {
  const out = decimate([1, 2, 3, 4], 0);
  assert.equal(Number.isFinite(out.step), true);
  assert.equal(out.step, 4);
});

// ── context, 24h: one line a session ─────────────────────────────────────────────────────

test('a minute with no reading is a hole in every line, never a fall to zero', () => {
  const t0 = at(2026, 8, 29, 10, 0);
  const lines = ctxLines(
    [sample(t0, [{ ctxPct: 40 }]), sample(t0 + 2 * MIN, [{ ctxPct: 44 }])],
    MIN,
    rosterOf(['alpha']),
  );
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].v, [40, null, 44]);
});

test('a recycled session is a second line, so the curve breaks where the session did', () => {
  const t0 = at(2026, 8, 29, 3, 0);
  const lines = ctxLines(
    [
      sample(t0, [{ sid: 'old', project: 'alpha', ctxPct: 88 }]),
      sample(t0 + MIN, [{ sid: 'new', project: 'alpha', ctxPct: 4 }]),
    ],
    MIN,
    rosterOf(['alpha']),
  );
  assert.equal(lines.length, 2);
  // Each line is a hole where the other one was reading: nothing joins 88 to 4.
  assert.deepEqual(
    lines.map((l) => l.v),
    [
      [88, null],
      [null, 4],
    ],
  );
  // And both wear the project's own colour, because both are that project working.
  assert.deepEqual(new Set(lines.map((l) => l.slot)), new Set([1]));
});

test('a background agent is left off the context chart — it has no terminal to draw a frame', () => {
  const t0 = at(2026, 8, 29, 10, 0);
  const lines = ctxLines(
    [sample(t0, [{ sid: 'a', ctxPct: 40 }, { sid: 'b', kind: 'background', project: 'beta', ctxPct: 70 }])],
    MIN,
    rosterOf(['alpha', 'beta']),
  );
  assert.deepEqual(
    lines.map((l) => l.name),
    ['alpha'],
  );
});

test('a reading with no session id is not followed across minutes', () => {
  const t0 = at(2026, 8, 29, 10, 0);
  const lines = ctxLines([sample(t0, [{ sid: null, ctxPct: 40 }])], MIN, rosterOf(['alpha']));
  assert.deepEqual(lines, []);
});

test('climbing is fifteen points over three hours, and fourteen is not', () => {
  const over = (gain: number): (number | null)[] => {
    const v: (number | null)[] = [];
    for (let i = 0; i <= 180; i++) v.push(50 + (i / 180) * gain);
    return v;
  };
  // Both sides of the line, one point apart. A fixture that only climbs and a fixture that only
  // sits still pin "somewhere between one and fifteen", which is not the number written down.
  assert.equal(rising({ v: over(15), step: MIN }), true);
  assert.equal(rising({ v: over(14), step: MIN }), false);
  assert.equal(rising({ v: over(0), step: MIN }), false);
});

// The chart exists to answer "what has to be recycled tonight", and the session that most needs
// answering is the one that started after breakfast and is already at 90. Measured against the
// reading exactly three hours back it is invisible: three hours ago it did not exist.
test('a session younger than three hours can climb, and is not hidden by its own age', () => {
  const young: (number | null)[] = new Array(110).fill(null);
  for (let i = 0; i <= 90; i++) young.push(i);
  assert.equal(rising({ v: young, step: MIN }), true);
});

test('a line whose last three hours are a gap has not climbed, it has been unwatched', () => {
  const gone: (number | null)[] = [];
  for (let i = 0; i <= 90; i++) gone.push(i);
  for (let i = 0; i < 200; i++) gone.push(null);
  assert.equal(rising({ v: gone, step: MIN }), false);
});

test('the legend names a project once, whatever a night of recycling did to its sessions', () => {
  const t0 = at(2026, 8, 29, 3, 0);
  const lines = ctxLines(
    [
      sample(t0, [{ sid: 'old', project: 'alpha', ctxPct: 88 }]),
      sample(t0 + MIN, [{ sid: 'new', project: 'alpha', ctxPct: 4 }]),
    ],
    MIN,
    rosterOf(['alpha']),
  );
  const keys = ctxKeys(lines);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].name, 'alpha');
  // The newer session's reading, not the dead one's 88: "where is alpha now" is the question.
  assert.equal(keys[0].v, 4);
});

// The same night, one step earlier. A session recycled at three reports no context at all until
// its first turn: `used_percentage` comes through present and null, which is the fleet table's
// "no turn yet". Leaving the previous session's reading in place because the newer one has none
// is the key saying 88% about a session that no longer exists — on every project the recycle
// touched, every night, until somebody typed something.
test('a session that has taken no turn blanks its project’s key, rather than keeping the dead one’s', () => {
  const t0 = at(2026, 8, 29, 3, 0);
  const lines = ctxLines(
    [
      sample(t0, [{ sid: 'old', project: 'alpha', ctxPct: 88 }]),
      sample(t0 + MIN, [{ sid: 'new', project: 'alpha', ctxPct: null }]),
    ],
    MIN,
    rosterOf(['alpha']),
  );
  const keys = ctxKeys(lines);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].v, null, 'the newer session is still the one a reader means by "where is alpha now"');
});

// "The newest session" cannot mean "the last line in the array". `buildFleet` sorts every
// sample by state and then by context descending, with `?? -1` (fleet.ts:137), so a session
// that reports no context at all sorts last in every sample for as long as it runs. A project
// with one chained session and one that was never chained has the blind one as its last line,
// beside the live one rather than after it, from the first minute to the last.
test('a session that never reports a context does not blank the live one beside it', () => {
  const t0 = at(2026, 8, 29, 9, 0);
  const lines = ctxLines(
    [0, 1, 2].map((i) =>
      sample(t0 + i * MIN, [
        { sid: 'chained', project: 'alpha', ctxPct: 50 + i },
        { sid: 'blind', project: 'alpha', ctxPct: null },
      ]),
    ),
    MIN,
    rosterOf(['alpha']),
  );
  assert.equal(ctxKeys(lines)[0].v, 52);
});

// And the blind one is first at least as often. `rank` (fleet.ts:381) orders on STATE before
// context: waiting, then busy, then unknown, then idle. A session that is busy and has never
// been chained ranks 1 and a chained session sitting idle ranks 3, so the blind one leads the
// sample and takes line 0. Seen at the same steps, neither is newer, and a tie that goes to
// whoever got there first is a tie that goes to the line with nothing to say.
test('at a tie the line with a reading takes the key, whichever of them came first', () => {
  const t0 = at(2026, 8, 29, 9, 0);
  const lines = ctxLines(
    [0, 1, 2].map((i) =>
      sample(t0 + i * MIN, [
        { sid: 'blind', project: 'alpha', ctxPct: null },
        { sid: 'chained', project: 'alpha', ctxPct: 51 + i },
      ]),
    ),
    MIN,
    rosterOf(['alpha']),
  );
  assert.equal(ctxKeys(lines)[0].v, 53);
});

test('a project is climbing if any of its lines is, so a fresh session cannot hide the old one', () => {
  const t0 = at(2026, 8, 29, 6, 0);
  const climb: (number | null)[] = [];
  for (let i = 0; i <= 180; i++) climb.push(50 + (i / 180) * 20);
  // The fresh one was seen last, so it owns the key's value. The arrow is the other question,
  // asked of every line: something of alpha's climbed across this window.
  const keys = ctxKeys([
    { name: 'alpha', slot: 1, t0, step: MIN, v: climb, lastAt: 178 },
    { name: 'alpha', slot: 1, t0, step: MIN, v: [3, 4], lastAt: 180 },
  ]);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].v, 4);
  assert.equal(keys[0].up, true);
});

// ── context, 7d and 30d: one row a project ───────────────────────────────────────────────

test('an hour keeps the highest a project reached in it, not the last it was seen at', () => {
  const t0 = at(2026, 8, 29, 9, 0);
  const rows = ctxRows(
    [hour(t0, [{ sid: 'a', ctxPct: 91 }, { sid: 'b', ctxPct: 20 }])],
    rosterOf(['alpha']),
  );
  assert.deepEqual(rows[0].v, [91]);
});

test('an hour nobody wrote is a gap in the row, and the hours around it stay where they are', () => {
  const t0 = at(2026, 8, 29, 9, 0);
  const rows = ctxRows([hour(t0, [{ ctxPct: 30 }]), hour(t0 + 2 * HOUR, [{ ctxPct: 50 }])], rosterOf(['alpha']));
  assert.deepEqual(rows[0].v, [30, null, 50]);
});

test('a project the range has no context for at all gets no band of its own', () => {
  const t0 = at(2026, 8, 29, 9, 0);
  const rows = ctxRows(
    [hour(t0, [{ sid: 'a', project: 'alpha', ctxPct: 30 }, { sid: 'b', project: 'beta', ctxPct: null }])],
    rosterOf(['alpha', 'beta']),
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    ['alpha'],
  );
});

test('a background agent is left off the bands too, not only off the 24h lines', () => {
  const t0 = at(2026, 8, 29, 9, 0);
  const rows = ctxRows(
    [hour(t0, [{ sid: 'a', ctxPct: 30 }, { sid: 'b', kind: 'background', project: 'beta', ctxPct: 90 }])],
    rosterOf(['alpha', 'beta']),
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    ['alpha'],
  );
});

// The columns are the SPAN, not the hours that had readings. An hour the fleet was quiet in has
// to keep its place on the axis, or a week with a dead Sunday in it draws Monday next to
// Saturday and the shape of the week is a shape that never happened.
test('every hour of the span gets a column, so the axis never closes a gap up', () => {
  const t0 = at(2026, 8, 29, 9, 0);
  const c = costHourly(
    [sample(t0, [{ costUsd: 1 }]), sample(t0 + 4 * HOUR, [{ costUsd: 9 }])],
    rosterOf(['alpha']),
  );
  assert.equal(c.buckets.length, 5, 'five hours between the two readings, inclusive');
  assert.deepEqual(
    c.buckets.map((b) => new Date(b.t).getHours()),
    [9, 10, 11, 12, 13],
  );
});

// ── cost ─────────────────────────────────────────────────────────────────────────────────

test('the ring carries a running total, so an hour is the difference between its ends', () => {
  const t0 = at(2026, 8, 29, 9, 0);
  const c = costHourly(
    [
      sample(t0, [{ costUsd: 1 }]),
      sample(t0 + 30 * MIN, [{ costUsd: 3 }]),
      sample(t0 + HOUR, [{ costUsd: 3.5 }]),
      sample(t0 + HOUR + 30 * MIN, [{ costUsd: 9 }]),
    ],
    rosterOf(['alpha']),
  );
  // The first reading is the baseline, never a spike: what it carries was spent before the
  // window opened, and the hour it lands in did not see it.
  assert.deepEqual(
    c.buckets.map((b) => b.by[0]),
    [2, 6],
  );
});

test('a running total that goes backwards buys nothing — the floor is zero, never a refund', () => {
  const t0 = at(2026, 8, 29, 9, 0);
  const c = costHourly(
    [sample(t0, [{ costUsd: 5 }]), sample(t0 + 30 * MIN, [{ costUsd: 9 }]), sample(t0 + HOUR, [{ costUsd: 2 }])],
    rosterOf(['alpha']),
  );
  assert.deepEqual(
    c.buckets.map((b) => b.by[0]),
    [4, 0],
  );
});

test('a new session starts its own total, so a recycle is not a refund of what came before', () => {
  const t0 = at(2026, 8, 29, 2, 30);
  const c = costHourly(
    [
      sample(t0, [{ sid: 'old', costUsd: 40 }]),
      sample(t0 + 20 * MIN, [{ sid: 'old', costUsd: 44 }]),
      sample(t0 + 40 * MIN, [{ sid: 'new', costUsd: 0.5 }]),
      sample(t0 + 80 * MIN, [{ sid: 'new', costUsd: 2.5 }]),
    ],
    rosterOf(['alpha']),
  );
  // 02:00 saw four dollars of the old session and nothing of the new one's first reading;
  // 03:00 saw two. A baseline shared across the pair would have read minus forty-three.
  assert.deepEqual(
    c.buckets.map((b) => b.by[0]),
    [4, 2],
  );
});

test('a background agent is counted in the cost even though it is off the context chart', () => {
  const t0 = at(2026, 8, 29, 9, 0);
  const c = costHourly(
    [
      sample(t0, [{ sid: 'b', kind: 'background', project: 'beta', costUsd: 1 }]),
      sample(t0 + 30 * MIN, [{ sid: 'b', kind: 'background', project: 'beta', costUsd: 4 }]),
    ],
    rosterOf(['beta']),
  );
  assert.equal(c.buckets[0].by[0], 3);
});

test('a day is read as the local day it names, not as the UTC instant that spelling is', () => {
  const c = costDaily([{ date: '2026-08-29', byProject: [{ project: 'alpha', costUsd: 3 }] }], rosterOf(['alpha']));
  assert.equal(c.buckets[0].t, at(2026, 8, 29, 0, 0));
});

test('the stack is built in the palette order and never in the day’s own ranking', () => {
  const roster = rosterOf(['alpha', 'beta']);
  const c = costDaily(
    [
      // The reader hands them back most expensive first, which is the legend's order and not
      // the stack's: a slab that changed height AND place from one day to the next could not
      // be followed across the week.
      { date: '2026-08-29', byProject: [{ project: 'beta', costUsd: 9 }, { project: 'alpha', costUsd: 1 }] },
      { date: '2026-08-30', byProject: [{ project: 'alpha', costUsd: 7 }, { project: 'beta', costUsd: 2 }] },
    ],
    roster,
  );
  assert.deepEqual(
    c.projects.map((p) => p.name),
    ['alpha', 'beta'],
  );
  assert.deepEqual(
    c.buckets.map((b) => b.by),
    [
      [1, 9],
      [7, 2],
    ],
  );
});

test('the legend is the ranking the stack refuses: most expensive first, colours unmoved', () => {
  const roster = rosterOf(['alpha', 'beta']);
  const c = costDaily(
    [
      { date: '2026-08-29', byProject: [{ project: 'beta', costUsd: 9 }, { project: 'alpha', costUsd: 1 }] },
      { date: '2026-08-30', byProject: [{ project: 'alpha', costUsd: 7 }, { project: 'beta', costUsd: 2 }] },
    ],
    roster,
  );
  const keys = legendByCost(c);
  assert.deepEqual(
    keys.map((k) => k.name),
    ['beta', 'alpha'],
  );
  assert.deepEqual(
    keys.map((k) => k.total),
    [11, 8],
  );
  // The rank moved; the colour did not.
  assert.deepEqual(
    keys.map((k) => k.slot),
    [2, 1],
  );
});

test('an hour nobody read is not an hour that cost nothing', () => {
  const t0 = at(2026, 8, 29, 9, 0);
  const c = costHourly(
    [sample(t0, [{ costUsd: 1 }]), sample(t0 + 30 * MIN, [{ costUsd: 3 }]), sample(t0 + 2 * HOUR, [{ costUsd: 5 }])],
    rosterOf(['alpha']),
  );
  // The empty hour keeps its column, so the axis does not close the gap up. What it may not do
  // is claim the fleet spent nothing: no reading is not a measurement of zero.
  assert.deepEqual(
    c.buckets.map((b) => b.n),
    [2, 0, 1],
  );
});

test('a project whose cost was never measured is not a project that spent nothing', () => {
  const c = costDaily([{ date: '2026-08-29', byProject: [{ project: 'alpha', costUsd: 3 }] }], rosterOf(['alpha', 'ghost']));
  const keys = legendByCost(c);
  assert.deepEqual(
    keys.map((k) => [k.name, k.total]),
    [
      ['alpha', 3],
      ['ghost', null],
    ],
  );
});

test('a running total that never arrived leaves the hour unmeasured, not at zero', () => {
  const t0 = at(2026, 8, 29, 9, 0);
  const c = costHourly([sample(t0, [{ costUsd: null }])], rosterOf(['alpha']));
  assert.equal(c.buckets[0].n, 0, 'a reading with no cost in it is not a reading of the cost');
  assert.deepEqual(legendByCost(c).map((k) => k.total), [null]);
});

// ── quota ────────────────────────────────────────────────────────────────────────────────

test('a window nobody could read is a gap in the quota line, never a zero', () => {
  const t0 = at(2026, 8, 29, 9, 0);
  const q = quotaOfSamples(
    [sample(t0, [{}], windows(40, 12)), sample(t0 + MIN, [{}], null), sample(t0 + 2 * MIN, [{}], windows(45, 12))],
    MIN,
  );
  assert.deepEqual(q.five, [40, null, 45]);
  assert.deepEqual(q.seven, [12, null, 12]);
});

test('a minute the collector missed is a gap in the quota line too, on the ring’s own grid', () => {
  const t0 = at(2026, 8, 29, 9, 0);
  const q = quotaOfSamples([sample(t0, [{}], windows(40, 12)), sample(t0 + 3 * MIN, [{}], windows(52, 12))], MIN);
  assert.deepEqual(q.five, [40, null, null, 52]);
  assert.equal(q.step, MIN);
});

test('a reading whose windows are not a pair of percentages is a gap, not a shape to guess at', () => {
  const t0 = at(2026, 8, 29, 9, 0);
  const q = quotaOfSamples([sample(t0, [{}], [1, 2]), sample(t0 + MIN, [{}], windows(101, -3))], MIN);
  assert.deepEqual(q.five, [null, null]);
  assert.deepEqual(q.seven, [null, null]);
});

test('a turnover the serve watched happen is drawn as one, and one it slept through is not', () => {
  const t0 = at(2026, 8, 29, 9, 0);
  const q = quotaOfHours(
    [hour(t0, [{}], 80, 30), hour(t0 + HOUR, [{}], 4, 30)],
    [
      { limit: 'five_hour', t: t0 + HOUR, from: 80, to: 4, sinceMs: 60_000 },
      { limit: 'seven_day', t: t0 + HOUR, from: 90, to: 2, sinceMs: 9 * HOUR },
    ],
  );
  assert.deepEqual(
    q.resets.map((r) => [r.limit, r.watched]),
    [
      ['five_hour', true],
      ['seven_day', false],
    ],
  );
  assert.deepEqual(q.five, [80, 4]);
  assert.deepEqual(q.seven, [30, 30]);
});

// ── the page ─────────────────────────────────────────────────────────────────────────────

const fleet = (rows: FleetRow[] = [row()]): Fleet => ({ rows, health: health() });
const page = (view: 'table' | 'map' | 'history' = 'history', historyEnabled = true): string =>
  renderPage(fleet(), view, { historyEnabled });
/** The sheet the browser is served, with its prose cut out. */
const sheet = (): string =>
  /<style>([\s\S]*?)<\/style>/.exec(page())![1].replace(/\/\*[\s\S]*?\*\//g, '');

test('the third tab is on every view, and only the one being read is current', () => {
  assert.match(page('history'), /<a href="\/history" aria-current="page">History<\/a>/);
  assert.match(page('table'), /<a href="\/history">History<\/a>/);
  assert.match(page('map'), /<a href="\/history">History<\/a>/);
});

test('with no journal the page says so in its own words, and names the key that turns it on', () => {
  const off = page('history', false);
  assert.match(off, /History is off/);
  assert.match(off, /history/);
  assert.match(off, /days/);
  // Not a warning: an option nobody switched on is not a fault.
  assert.equal(/<div class="warn[^"]*"[^>]*>[^<]*History is off/.test(off), false);
});

test('with no journal the two ranges that need one are refused, and 24h is not', () => {
  const off = page('history', false);
  assert.match(off, /id="range-7d"[^>]*\bdisabled\b/);
  assert.match(off, /id="range-30d"[^>]*\bdisabled\b/);
  assert.equal(/id="range-24h"[^>]*\bdisabled\b/.test(off), false);
  assert.match(off, /id="range-24h"[^>]*aria-pressed="true"/);
});

// The sentence under the pills is one of two, and which one is the config's answer. The script
// switches it per range and must not write the 24h one itself: told to, it printed "7d and 30d
// from the journal on disk" under two pills it had just greyed out.
test('the page keeps the server’s own sentence about the ring rather than writing a second one', () => {
  assert.match(page('history', false), /24h from memory[^<]*need the journal, which is off/);
  assert.match(page('history', true), /24h from memory[^<]*from the journal on disk/);
  const script = historyScript();
  assert.match(script, /var covers24 = covers\.textContent;/, 'the server’s sentence is not kept');
  assert.match(script, /state\.range === '24h'\) return covers24;/, 'and it is not what 24h answers with');
  assert.equal(script.includes('from the journal on disk'), false, 'the script carries a copy of it');
  assert.equal(script.includes('which is off'), false, 'the script carries a copy of the other one');
});

// #151. The first screen of a fresh install is three charts with nothing in them, and the only
// thing on the page about that used to be "no readings in this range" painted onto a canvas.
// The block ships in the markup and hidden, the way the replay banner does: the script raises
// it once it has looked at a record, so a page whose script never runs does not stand there
// claiming a verdict nobody reached.
test('the view ships the first-run block, hidden, saying what is coming and how to skip the wait', () => {
  const html = page('history');
  assert.match(html, /id="hist-empty"[^>]*\bhidden\b/, 'the block is not there, or is not hidden until raised');
  const block = html.slice(html.indexOf('id="hist-empty"'), html.indexOf('</div>', html.indexOf('id="hist-empty"')));
  assert.match(block, /minute/, 'it does not say how long the first readings take');
  assert.match(block, /serve --demo/, 'it does not point at the one way to see this full without waiting');
});

// A demo serve keeps a journal it invented in memory, and the sentence under the pills is the
// server's word on where those ranges come from. "On disk" there is a claim about a process that
// has just reported, in the terminal, that it writes nothing (#156). The demo may invent a fleet;
// it may not report a measurement of a directory it never opened.
test('a demo names the journal it invented, and never a disk it did not open', () => {
  const demo = renderPage(fleet(), 'history', { historyEnabled: true, demo: true });

  assert.match(demo, /24h from memory[^<]*invented in memory/);
  assert.equal(/7d and 30d from the journal on disk/.test(demo), false, 'the demo claims a disk');
  // The script rebuilds this line per range and counts the days it got, so it needs the same
  // fact. Carried on the element the sentence is already read off rather than fetched.
  assert.match(demo, /id="hist-covers"[^>]*data-days="days invented"/);
  assert.equal(/id="hist-covers"[^>]*data-days/.test(page('history', true)), false, 'a serve with a real journal carries the demo-s word for its days');
});

test('with a journal nothing is refused and nothing says it is off', () => {
  const on = page('history', true);
  assert.equal(/History is off/.test(on), false);
  assert.equal(/id="range-7d"[^>]*\bdisabled\b/.test(on), false);
});

test('the view ships the three charts the pitch asks for, in the order it asks for them', () => {
  const html = page('history');
  const order = ['id="ctx"', 'id="cost"', 'id="quota"'].map((id) => html.indexOf(id));
  assert.equal(
    order.every((i) => i > 0),
    true,
  );
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

// ── the dark scheme ──────────────────────────────────────────────────────────────────────

// A stack of saturated slabs that reads as colour on white glares on the near-black this page
// uses at night. The fills come back off so the page's own background shows through them;
// lines keep every bit of their colour, because a hairline at 55% is a hairline nobody sees.
test('a filled area is drawn back at night, and a light scheme is left alone', () => {
  assert.equal(fillAlpha(true), 0.55);
  assert.equal(fillAlpha(false), 1);
});

test('and the two charts that fill anything actually spend it', () => {
  const script = historyScript();
  assert.equal((script.match(/\* fill\(\)/g) ?? []).length, 2, 'the bars and the quota skyline');
  assert.match(script, /prefers-color-scheme: dark/);
});

test('the shipped script carries the transforms this file just tested, not a copy of them', () => {
  const script = historyScript();
  for (const fn of [decimate, ctxLines, ctxRows, costHourly, costDaily, legendByCost, quotaOfSamples, quotaOfHours, rising, rosterOf, fillAlpha]) {
    assert.equal(script.includes(String(fn)), true, `${fn.name} is not the source the page runs`);
  }
});

test('the view is markup the shell can hide, like the two views beside it', () => {
  assert.match(renderHistoryView({ historyEnabled: true }), /class="view view-history"/);
});

// ── one sheet, one namespace ─────────────────────────────────────────────────────────────
//
// This is here because it happened. The legend printed its value in a `<span class="val">`,
// which read fine, and the map's dial centre is a bare `.val { position:absolute; inset:0 }`,
// which reads fine too — so the value was laid out absolutely over the whole key with the name
// and the swatch underneath it. Every rule was right and the browser resolved them against each
// other; no assertion in the suite could see it, because the bug is not in either file.
//
// So: a class this view puts on the page may not be one an unscoped rule elsewhere claims. The
// deliberate borrowings are named — the view wants the page's own footnote and warning styling
// — and everything else carries a name of its own.
const BORROWED = new Set(['view', 'note', 'covers']);

/** Every class the view's markup and its legend actually emit. */
function classesUsed(): Set<string> {
  const out = new Set<string>();
  for (const source of [renderHistoryView({ historyEnabled: false }), historyScript()]) {
    for (const [, list] of source.matchAll(/class="([a-z][\w -]*)"/g)) {
      for (const c of list.split(/\s+/).filter(Boolean)) out.add(c);
    }
  }
  return out;
}

/** Every bare-class rule the history view's own two sheets declare. */
function ownRules(): Set<string> {
  const own = new Set<string>();
  const css = (HISTORY_CSS + HISTORY_PHONE_CSS).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, raw] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const selector of raw.split(',').map((x) => x.trim())) if (/^\.[\w-]+$/.test(selector)) own.add(selector);
  }
  return own;
}

test('every class the history view names is one no other rule in the sheet claims', () => {
  const css = sheet();
  const mine = [...classesUsed()].filter((c) => !BORROWED.has(c));
  assert.ok(mine.length >= 10, `only ${mine.length} classes found — the scan stopped working`);
  // Named, because these four are the ones the collision was in and the ones a scan is likeliest
  // to lose: they are written by the legend builder rather than by the server's markup.
  for (const key of ['k-sw', 'k-ln', 'k-name', 'k-val']) {
    assert.ok(mine.includes(key), `${key} is not among the classes the scan found`);
  }
  const own = ownRules();
  for (const [, raw] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    const block = raw.slice(raw.lastIndexOf('}') + 1);
    for (const selector of block.split(',').map((x) => x.trim()).filter(Boolean)) {
      // A bare class, with nothing in front of it: the one shape that reaches an element this
      // view put on the page without ever naming the view.
      const bare = /^\.([\w-]+)$/.exec(selector);
      if (!bare || !mine.includes(bare[1])) continue;
      assert.ok(own.has(selector), `.${bare[1]} is styled by a rule outside the history view`);
    }
  }
});
