// The week of journal `serve --demo` shows, invented in memory.
//
// Why it ships. `/history` was the one page of the demo that showed the product switched off:
// "History is off.", the 7d and 30d pills greyed out, nothing for the range charts or the
// scrubber to draw — on exactly the surface they were built for (#156). A demo serve has a past
// now, and it is a past nothing wrote down.
//
// Where it plugs in, and why THERE. It is a `HistoryStore`, the same object a real journal hands
// the server, so the range route asks it the question it asks any store and never learns where
// the days came from. Underneath, the days go through `readRange` — the one place that turns
// records into hours, project costs and window turnovers — via the day seam that reader takes.
// So there is no second aggregation and no second rendering path: what the demo shows is what a
// real journal of the same records would show, arrived at by the same code.
//
// What it may not do, held by `test/demo-history.test.ts` and by the end-to-end check in
// `test/demo.test.ts`: touch a disk. Nothing here opens, creates or removes a file. The
// directory it names is under the invented home, for the same reason every other demo path is,
// and it exists to be reported and never to be opened.
//
// One story, not two. Every record is `demoFleetAt` played through the same `record` a real
// sampler calls and then through the store's own allowlist, so the last day of the journal and
// the ring behind the scrubber are the same readings, minute for minute.

import { demoFleetAt, DEMO_HOME, DEMO_MINUTES } from './demo.ts';
import { createHistory } from './history.ts';
import { readRange } from './history-range.ts';
import type { HistoryRange, RangeHistory } from './history-range.ts';
import { journalRecordOf } from './history-store.ts';
import type { HistoryPruned, HistoryStats, HistoryStore } from './history-store.ts';

/**
 * How many local days of it there are, today included.
 *
 * Seven and not thirty. A month is four times the work for a page that says what it covers
 * anyway, and a `30d` that answers the week it has is a range showing what exists — which beats
 * one invented badly, and is what a real journal younger than its retention already does.
 */
export const DEMO_JOURNAL_DAYS = 7;

/**
 * Where the journal would live if there were one. Named because a store names its directory,
 * never opened by anything here — and under the invented home, so a capture of a demo carries
 * no path off the machine that took it.
 */
export const DEMO_HISTORY_DIR = `${DEMO_HOME}/.local/state/tarmac/history`;

const MINUTE = 60_000;

/**
 * How long the invented day is, as a span rather than as a slot count.
 *
 * `DEMO_MINUTES` is one more than the ring holds, so that the record dates itself by its own
 * oldest reading; the DAY it plays is the 24 hours those minutes cover, and repeating it on that
 * period tiles the past exactly. A period of `DEMO_MINUTES` would leave a minute-wide hole
 * between one day and the next, once a day, for ever.
 */
const CYCLE_MS = (DEMO_MINUTES - 1) * MINUTE;

const pad = (n: number): string => String(n).padStart(2, '0');

/** The local day a moment falls on, `YYYY-MM-DD` — the name a journal file carries. */
const dayOf = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Local midnight of a named day, which is the inverse of the name above. */
function midnightOf(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) return null;
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * The oldest day this journal answers for, today included: the same calendar arithmetic a real
 * retention uses, so the demo's week is a week the way a reader's is and not 168 hours.
 */
const oldestDay = (now: number, days: number): string => {
  const d = new Date(now);
  return dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime());
};

/**
 * Which repetition of the invented day a moment falls in, given the day the ring is anchored on.
 *
 * The last one is the ring's own, unshifted, which is what makes the newest journal day and the
 * record behind the scrubber the same readings rather than two accounts of one fleet. Anything
 * earlier is that same day again, a whole number of days back — a fleet that arrives, works and
 * goes home, five projects at a time, for a week.
 */
const cycleStartFor = (t: number, dayStart: number): number =>
  dayStart - Math.max(0, Math.ceil((dayStart - t) / CYCLE_MS)) * CYCLE_MS;

/**
 * One local day of the invented journal, as the file of that name would have read, or `null`
 * for a day this journal does not cover.
 *
 * The readings sit on the RING's minute grid rather than on the hour, so the day that overlaps
 * the ring carries the ring's own minutes and the two can be compared reading for reading. It
 * stops at `now`: a demo that journalled the rest of today would be showing readings taken in
 * the future, which `readRange` would drop as out of range and a reader would be right to
 * disbelieve.
 */
export function demoJournalDay(date: string, dayStart: number, now: number): string | null {
  const midnight = midnightOf(date);
  if (midnight === null) return null;
  if (date < oldestDay(now, DEMO_JOURNAL_DAYS) || date > dayOf(now)) return null;

  // The next local midnight, which is 23, 24 or 25 hours along — calendar arithmetic, never a
  // 24-hour block, so the morning a clock shifts does not lose or double an hour of the day.
  const d = new Date(midnight);
  const end = Math.min(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1, now);
  const from = Math.ceil((midnight - dayStart) / MINUTE);
  const to = Math.floor((end - dayStart) / MINUTE);
  if (to < from) return null;

  // The sampler's own path: `record` is what a real serve calls once a minute, and the sample it
  // hands back is what the journal writes. The ring it fills on the way is thrown away with this
  // call — what is wanted is the reduction, and a second copy of that reduction here would be
  // the one thing this module exists not to be.
  const ring = createHistory({ since: dayStart, cadence: MINUTE });
  let text = '';
  for (let k = from; k <= to; k++) {
    const t = dayStart + k * MINUTE;
    const cycleStart = cycleStartFor(t, dayStart);
    const minute = Math.round((t - cycleStart) / MINUTE);
    text += `${JSON.stringify(journalRecordOf(ring.record(demoFleetAt(minute, cycleStart, t))))}\n`;
  }
  return text;
}

/**
 * The store `serve --demo` hands the server in place of a real journal.
 *
 * Everything a writing store does is a no-op here, and none of them is ever called: a demo runs
 * no sampler, so nothing appends, and it takes no directory, so nothing sweeps. They are written
 * out rather than thrown from, because a store that threw would turn a tick into a 500 the day
 * something did call one.
 */
export function createDemoHistoryStore({ dayStart }: { dayStart: number }): HistoryStore {
  return {
    dir: DEMO_HISTORY_DIR,
    days: DEMO_JOURNAL_DAYS,
    heartbeat(): void {
      // No directory, no lock, nothing to keep alive.
    },
    append(): void {
      // A demo serve records nothing, and this is the guarantee rather than the consequence.
    },
    prune: (): HistoryPruned => ({ removed: 0, failed: 0 }),
    // Zeroes that are measurements: there is no file and no byte, which is a fact and not an
    // absence. `capped` is false for the same reason — nothing here can fill.
    stats: (): HistoryStats => ({ files: 0, bytes: 0, misses: 0, stopped: null, capped: false }),
    read: (range: HistoryRange, now: number): Promise<RangeHistory> =>
      readRange({ dir: DEMO_HISTORY_DIR, range, now, readDay: async (date) => demoJournalDay(date, dayStart, now) }),
  };
}
