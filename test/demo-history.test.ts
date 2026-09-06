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
import fs from 'node:fs';
import { createDemoHistoryStore, DEMO_JOURNAL_DAYS, demoDayFactor, demoJournalDay } from '../src/demo-history.ts';
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
  assert.equal(week.days.length, 7, `a week of the demo journal covers ${week.days.length} days`);
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
  // A reading a minute, which is the cadence a real journal is written at: an hour of sixty and
  // an hour of six are drawn the same and are not the same fact, and a demo thinning its own
  // week would be showing every reader a serve that had been stopping and starting all week.
  const inner = week.hours.slice(1, -1);
  assert.ok(inner.every((h) => h.n === 60), `an hour of the invented week holds ${Math.min(...inner.map((h) => h.n))} readings`);

  // And a WHOLE day repeated, which is what the period is worth holding by. Play a fraction of
  // the day between two midnights instead and each of them is charged a fraction of a day's
  // work, while an actor born late in the day never appears at all — a week that still passes
  // every assertion above. Today is left out: it is the one day the past stops partway through.
  const whole = week.days.slice(0, -1);
  assert.ok(whole.every((d) => d.byProject.length === 5), `a full day of the week carries ${Math.min(...whole.map((d) => d.byProject.length))} projects, not the fleet's five`);
});

/** What a day of the invented journal cost, in whole dollars. */
const spend = (d: { byProject: Array<{ costUsd: number }> }): number =>
  Math.round(d.byProject.reduce((sum, p) => sum + p.costUsd, 0));

/** Every full day of a range — today is the one day the invented past stops partway through. */
const fullDays = (r: { days: Array<{ date: string; byProject: Array<{ costUsd: number }> }> }): Array<{ date: string; byProject: Array<{ costUsd: number }> }> =>
  r.days.slice(0, -1);

const weekday = (date: string): number => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
};

// A month, and not the week it used to be. The 30d pill answered the seven days the demo had,
// which is what a real journal younger than its retention does — and on a demo that meant the
// two long ranges drew the identical picture, seven columns stretched over both. What a reader
// opens `--demo` to see is the page full.
test('the demo journal is a month deep, so the 30d pill has a month to draw', async () => {
  const month = await demoStore().read('30d', NOW);

  assert.equal(DEMO_JOURNAL_DAYS, 30);
  assert.equal(month.days.length, 30, `the invented journal covers ${month.days.length} days`);
  assert.equal(month.coverage.daysRequested, 30);
  assert.equal(month.coverage.skipped, 0);
  assert.ok(month.days.every((d) => d.byProject.length > 0), 'a day of the invented month spent nothing');
});

// Six identical columns at $147 is a chart nobody believes. A month of them is worse: the whole
// point of the range is that a week has a shape — quiet weekends, a day something big shipped —
// and a flat one says the data is made up before the reader has read the axis.
test('the invented month has a shape: quiet weekends, ordinary weeks, and a day that went long', async () => {
  const days = fullDays(await demoStore().read('30d', NOW));
  const totals = days.map(spend);

  assert.ok(new Set(totals).size > 10, `the month has ${new Set(totals).size} distinct daily totals`);
  assert.ok(Math.min(...totals) >= 75 && Math.max(...totals) <= 240, `the month runs from $${Math.min(...totals)} to $${Math.max(...totals)}`);

  // The last two days are the RING's, unscaled, so they are left out of the shape: the ring's
  // own day costs what it costs, and if the demo is opened on a Sunday that is a weekend day at
  // a weekday's price. It is the one thing the two are allowed to disagree about — see the ring
  // check below, which is why they are unscaled at all.
  const scaled = days.slice(0, -1);
  const ends = scaled.filter((d) => weekday(d.date) === 0 || weekday(d.date) === 6).map(spend);
  const weeks = scaled.filter((d) => weekday(d.date) !== 0 && weekday(d.date) !== 6).map(spend);
  assert.ok(ends.length >= 8 && weeks.length >= 19, `the month holds ${ends.length} weekend days and ${weeks.length} weekdays`);
  assert.ok(Math.max(...ends) < Math.min(...weeks), `the quietest weekday costs $${Math.min(...weeks)} and the busiest weekend day $${Math.max(...ends)}`);
  assert.ok(totals.filter((t) => t > 200).length >= 1, 'no day of the month went long');
});

// The scale itself, held where it can be read rather than inferred from a month of totals: the
// day the ring holds is never touched, and no day of the past is scaled off the end of a chart.
test('the day behind the scrubber is never scaled, and no other day runs away with the axis', () => {
  assert.equal(demoDayFactor(0, 3), 1, 'the newest day is the ring’s own, minute for minute');

  for (let back = 0; back < DEMO_JOURNAL_DAYS; back++)
    for (const day of [0, 1, 2, 3, 4, 5, 6]) {
      const f = demoDayFactor(back, day);
      assert.ok(f >= 0.5 && f <= 1.6, `day ${back} of a ${day} came out ${f}x the ring's own`);
      assert.equal(f, demoDayFactor(back, day), 'the same day scaled two ways');
    }
});

// Deterministic, like everything else the demo invents: a screenshot taken twice is the same
// screenshot, and a suite that pins a shape needs the shape to hold still.
test('the shape of the month is the same shape twice', async () => {
  const [a, b] = await Promise.all([demoStore().read('30d', NOW), demoStore().read('30d', NOW)]);

  assert.deepEqual(fullDays(a).map(spend), fullDays(b).map(spend));
});

// A seven-day window climbing for a month straight would be an account four times over its
// plan. It rolls once a week, which is what a real one does and what makes the 30d quota chart
// four sawteeth rather than a line pinned to the floor for three weeks.
test('the invented month rolls its seven-day window once a week, and never daily', async () => {
  const month = await demoStore().read('30d', NOW);

  const seven = month.resets.filter((r) => r.limit === 'seven_day');
  assert.equal(seven.length, 4, `the month turned its weekly window over ${seven.length} times`);
  const readings = month.hours.map((h) => h.rateLimits.seven_day).filter((v): v is number => v !== null);
  assert.ok(readings.filter((v) => v === 0).length < month.hours.length / 8, 'the weekly window sat on the floor for most of the month');
  assert.ok(Math.max(...readings) > 35, `the weekly window never got past ${Math.max(...readings)}%`);
});

// The point of the whole exercise. A demo whose journal was invented separately would show a
// week that has nothing to do with the eight sessions on the other two views, and the day the
// two overlap is where that shows: the last day of the journal IS the ring, minute for minute.
// The invented account's seven-day window must climb across the invented week the way a real
// one does. The day repeats, and a `seven_day` that replayed its cycle-relative ramp fell 14
// points at every day boundary — six full-height "7d reset" lines on the 7d chart of a week in
// which the 24h ring shows the same window climbing cleanly. No real account turns its weekly
// window over daily; the demo may not either.
test('the invented week turns its seven-day window over nowhere', async () => {
  const week = await demoStore().read('7d', NOW);
  assert.deepEqual(
    week.resets.filter((r) => r.limit === 'seven_day'),
    [],
    'the invented week draws a "7d reset" line the ring knows nothing about',
  );
  assert.ok(week.resets.some((r) => r.limit === 'five_hour'), 'no window turned over at all');
  const seven = week.hours.map((h) => h.rateLimits.seven_day);
  assert.equal(seven.filter((v) => v === null).length, 0, 'an hour of the invented week has no seven-day reading');
  assert.ok(Math.min(...(seven as number[])) > 0, `the oldest hour of the week reads ${Math.min(...(seven as number[]))}%`);
});

test('the last day of the journal and the ring are the same readings', () => {
  const samples = demoHistory(DAY_START).read().samples;
  const newest = samples[samples.length - 1];
  const text = demoJournalDay(dayOf(NOW), DAY_START);

  assert.notEqual(text, null, 'the journal has no day for today');
  const records = text!.trim().split('\n').map((l) => JSON.parse(l) as { t: number });
  const same = records.find((r) => r.t === newest.t);
  assert.notEqual(same, undefined, `the journal has no reading for the ring's newest minute (${newest.t})`);
  assert.deepEqual(same, journalRecordOf(newest), 'the journal and the ring disagree about the same minute');
  // And it is the whole overlap, not one lucky minute.
  for (const s of samples.filter((x) => x.t >= records[0].t)) {
    assert.deepEqual(records.find((r) => r.t === s.t), journalRecordOf(s), `they disagree about ${new Date(s.t).toISOString()}`);
  }
  // Both directions. The loop above proves the journal holds every minute the ring holds; on its
  // own it says nothing about a journal that runs one minute PAST the ring, which is a reading of
  // the invented day after its last — a fleet nobody ever saw, dated a minute after the serve
  // started, and the exact thing the newest-minute bound exists to prevent.
  assert.equal(records[records.length - 1].t, newest.t, 'the journal carries a reading the ring never had');
});

// Both days of it, which is the half the check above cannot see.
//
// `dayStart` is `now - 24h`, so the ring covers TWO calendar days on any clock but midnight — the
// day it started on and the day it ends on — and only the newer of the two is the journal's
// newest day. A per-day scale applied to the older one writes most of the ring's minutes into the
// journal at another price: 719 of 1440 at noon, and 23 hours' worth for a demo opened at eleven
// at night. The chart then bills yesterday 14% above what the scrubber shows for the same minutes.
test('the journal and the ring agree about every minute they share, midnight included', () => {
  const samples = demoHistory(DAY_START).read().samples;
  const days = [dayOf(DAY_START), dayOf(NOW)];
  assert.notEqual(days[0], days[1], 'precondition: this ring does not straddle a midnight');

  const journal = new Map<number, unknown>();
  for (const date of days) {
    const text = demoJournalDay(date, DAY_START);
    assert.notEqual(text, null, `the journal has no day for ${date}`);
    for (const line of text!.trim().split('\n')) {
      const record = JSON.parse(line) as { t: number };
      journal.set(record.t, record);
    }
  }

  let shared = 0;
  const apart: string[] = [];
  for (const s of samples) {
    const same = journal.get(s.t);
    if (same === undefined) continue;
    shared += 1;
    if (JSON.stringify(same) !== JSON.stringify(journalRecordOf(s))) apart.push(new Date(s.t).toISOString());
  }
  assert.equal(shared, samples.length, `the journal is missing ${samples.length - shared} of the ring's minutes`);
  assert.deepEqual(apart, [], `${apart.length} of the ring's ${shared} minutes are journalled at another price, from ${apart[0]}`);
});

// A range answers the days it has and says which ones it was asked for. The month is full now;
// a week into a serve left open, it will not be, and the page under the pills says so rather
// than the chart pretending otherwise.
test('a range reports the days it was asked for beside the days it carries', async () => {
  const month = await demoStore().read('30d', NOW);

  assert.equal(month.range, '30d');
  assert.equal(month.coverage.daysRequested, 30);
  assert.equal(month.days.length, DEMO_JOURNAL_DAYS, 'the month invented days the demo does not carry');
});

// Two serves see the same past, and a demo serve's past does not move while it is open — the
// same promise the ring already keeps, which is why it runs no sampler.
//
// It is the clock that asks that makes this worth a test. Bounded by that clock, the journal
// went on inventing minutes for as long as the serve stayed up: past the last segment every
// actor has, so their costs climbed for ever, and past the newest minute of the ring, so the
// two stopped telling one story an hour in.
test('the past a demo serve started with is the past it keeps', async () => {
  const s = demoStore();

  const opened = await s.read('7d', NOW);
  const threeHoursLater = await s.read('7d', NOW + 3 * 3600_000);

  assert.equal(JSON.stringify(threeHoursLater), JSON.stringify(opened), 'the invented week grew while the serve was open');
  // Not vacuously: a week that answered nothing compares equal to another week of nothing.
  assert.ok(opened.coverage.lines > 6 * 1400, `a week of minutes is not ${opened.coverage.lines} readings`);
});

test('two demo serves of the same age see the same past', async () => {
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

// And the same red line held where it can be held rather than argued: the module has no way to
// reach a disk at all. The end-to-end check next door watches a served home and sees nothing
// appear in it, which is the consequence; this is the cause, and it is the assertion that
// survives somebody adding a cache "just for the demo".
test('nothing in the demo journal can open a file', () => {
  const src = fs.readFileSync(new URL('../src/demo-history.ts', import.meta.url), 'utf8');

  assert.equal(/from 'node:fs/.test(src), false, 'the demo journal imports a filesystem module');
});
