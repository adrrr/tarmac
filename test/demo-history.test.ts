// The week of journal `serve --demo` shows, which is the one page of the demo that used to be
// the product switched off.
//
// `/history` under `--demo` said "History is off." with the 7d and 30d pills greyed out — on
// exactly the surface the range charts and the scrubber were built for (#156). The demo now
// carries a journal, invented in memory, answered through the same `HistoryStore` seam a real
// one goes through. What this file holds is the three properties that makes it worth having:
// the days are derived from the same actors as the ring, so the last day of the journal and the
// ring tell one story; two reads of the same clock are the same answer; and a range the demo
// cannot fill shows what it has rather than inventing the rest.
//
// The clock is pinned in every test. A demo journal judged by the wall clock is a suite whose
// day count changes at midnight.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoHistoryStore, DEMO_JOURNAL_DAYS, demoJournalDay } from '../src/demo-history.ts';
import { DEMO_HOME, demoDayStart, demoHistory } from '../src/demo.ts';
import { journalRecordOf } from '../src/history-store.ts';

/** Noon on a named calendar day, local. Noon so no fixture sits within an hour of a DST shift. */
const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h, 0, 0, 0).getTime();

/** The moment every read below is dated by, and the day the invented one ends on. */
const NOW = at(2026, 8, 7);
const DAY_START = demoDayStart(NOW);

/** The local day a moment falls on, restated here rather than imported from what produced it. */
function dayOf(t: number): string {
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const demoStore = (): ReturnType<typeof createDemoHistoryStore> => createDemoHistoryStore({ dayStart: DAY_START });

test('a demo serve has a week of journal behind it, and the pills have something to answer', async () => {
  const week = await demoStore().read('7d', NOW);

  assert.equal(week.range, '7d');
  assert.equal(week.days.length, DEMO_JOURNAL_DAYS, `the demo journal covers ${week.days.length} days`);
  assert.equal(week.coverage.daysRequested, 7);
  assert.ok(week.coverage.lines > 6 * 1400, `a week of minutes is not ${week.coverage.lines} readings`);
  assert.equal(week.coverage.skipped, 0, 'a line the reader could not parse: the two shapes disagree');
  assert.ok(week.hours.length > 150, `a week of hours is not ${week.hours.length}`);
  // The three charts each need their own field, and a week that draws two of them is a demo
  // with a blank panel in it.
  assert.ok(week.days.every((d) => d.byProject.length > 0), 'a day of the invented week spent nothing');
  assert.ok(
    week.hours.some((h) => h.sessions.some((s) => s.ctxPct !== null)) && week.hours.some((h) => h.rateLimits.five_hour !== null),
    'the week carries no context or no window reading',
  );
  assert.ok(week.resets.length > 0, 'a week of five-hour windows turned over nowhere');
});

// The point of the whole exercise. A demo whose journal was invented separately would show a
// week that has nothing to do with the eight sessions on the other two views, and the day the
// two overlap is where that shows: the last day of the journal IS the ring, minute for minute.
test('the last day of the journal and the ring are the same readings', () => {
  const samples = demoHistory(DAY_START).read().samples;
  const newest = samples[samples.length - 1];
  const text = demoJournalDay(dayOf(NOW), DAY_START, NOW);

  assert.notEqual(text, null, 'the journal has no day for today');
  const records = text!.trim().split('\n').map((l) => JSON.parse(l) as { t: number });
  const same = records.find((r) => r.t === newest.t);
  assert.notEqual(same, undefined, `the journal has no reading for the ring's newest minute (${newest.t})`);
  assert.deepEqual(same, journalRecordOf(newest), 'the journal and the ring disagree about the same minute');
  // And it is the whole overlap, not one lucky minute.
  for (const s of samples.filter((x) => x.t >= records[0].t)) {
    assert.deepEqual(records.find((r) => r.t === s.t), journalRecordOf(s), `they disagree about ${new Date(s.t).toISOString()}`);
  }
});

// A range that shows what exists beats one invented badly: the demo seeds a week, and a month
// asked of it answers the week, says it was asked for thirty days, and leaves the page to say
// so under the pills.
test('a month asked of the demo answers the days it has, and reports the ones it was asked for', async () => {
  const month = await demoStore().read('30d', NOW);

  assert.equal(month.range, '30d');
  assert.equal(month.coverage.daysRequested, 30);
  assert.equal(month.days.length, DEMO_JOURNAL_DAYS, 'the month invented days the demo does not carry');
});

// Two serves see the same past. A screenshot of the demo's week is one anybody can re-take.
test('two demo stores answer a range identically', async () => {
  const [a, b] = await Promise.all([demoStore().read('7d', NOW), demoStore().read('7d', NOW)]);

  assert.equal(JSON.stringify(a), JSON.stringify(b), 'the invented week moved between two stores');
});

// The red line the rest of the demo already keeps: no path here is a path on this machine, and
// the directory the store names is one nothing opens.
test('the demo journal names an invented directory and reports nothing on a disk', () => {
  const s = demoStore();

  assert.ok(s.dir.startsWith(`${DEMO_HOME}/`), `the demo store names a directory off this machine: ${s.dir}`);
  assert.deepEqual(s.stats(), { files: 0, bytes: 0, misses: 0, stopped: null, capped: false });
  assert.deepEqual(s.prune(), { removed: 0, failed: 0 });
});
