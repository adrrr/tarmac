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
 * oldest reading. The DAY it plays is the 24 hours those minutes cover, and this is the period
 * the past repeats on.
 *
 * It decides the SHAPE of the past and never its density — a record is written every minute
 * whatever this says. A period shorter than the day plays the fleet arriving and going home
 * more than once between two midnights, which charges a fraction of a day's work to each of
 * them and can leave an actor born late in the day out of the week entirely. The suite holds
 * the consequence rather than the number: every full day of the invented week costs the same
 * and carries all five projects, which is true of a whole day repeated and of nothing else.
 *
 * What is NOT held, because it cannot be seen: whether an older cycle replays the day's last
 * minute or stops one short of it. Both tile the past exactly and both leave every day the same
 * length, the same cost and the same fleet. This is the day the ring covers, which makes it the
 * defensible choice rather than the pinned one.
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
 * The newest minute this journal has, which is the newest minute the RING has: the moment the
 * serve started, and the fleet the live view shows for as long as it is open.
 *
 * The journal stops there rather than at the clock that asked, for the reason the demo runs no
 * sampler at all — the record it was handed is the record it keeps. Bounded by `now` instead, a
 * serve open for three hours invented three hours of minutes past the end of its own day: past
 * the last segment every actor has, so their costs climbed for ever, and past the newest minute
 * of the ring, so the two stopped telling one story an hour in. It also made the answer depend
 * on when it was asked, which is the one thing a demo may not do.
 */
const endOfPast = (dayStart: number): number => dayStart + (DEMO_MINUTES - 1) * MINUTE;

/**
 * Which repetition of the invented day a moment falls in, given the day the ring is anchored on.
 *
 * The last one is the ring's own, unshifted, which is what makes the newest journal day and the
 * record behind the scrubber the same readings rather than two accounts of one fleet. Anything
 * earlier is that same day again, a whole number of days back — a fleet that arrives, works and
 * goes home, five projects at a time, for a week.
 *
 * The floor at zero is the ring's own last minute, `DEMO_MINUTES - 1`, which is a whole cycle
 * after `dayStart` and belongs to the cycle that started there rather than to the next one.
 * Nothing is ever asked past it: `endOfPast` above is where the journal stops.
 */
const cycleStartFor = (t: number, dayStart: number): number =>
  dayStart - Math.max(0, Math.ceil((dayStart - t) / CYCLE_MS)) * CYCLE_MS;

/**
 * One local day of the invented journal, as the file of that name would have read, or `null`
 * for a day this journal does not cover.
 *
 * The readings sit on the RING's minute grid rather than on the hour, so the day that overlaps
 * the ring carries the ring's own minutes and the two can be compared reading for reading.
 *
 * A function of `dayStart` and nothing else, the clock that asks included: a demo whose past
 * grew while somebody looked at it would be a screenshot nobody could re-take.
 */
export function demoJournalDay(date: string, dayStart: number): string | null {
  const midnight = midnightOf(date);
  if (midnight === null) return null;
  const last = endOfPast(dayStart);
  if (date < oldestDay(last, DEMO_JOURNAL_DAYS) || date > dayOf(last)) return null;

  // The next local midnight, which is 23, 24 or 25 hours along — calendar arithmetic, never a
  // 24-hour block, so the morning a clock shifts does not lose or double an hour of the day.
  const d = new Date(midnight);
  const end = Math.min(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1, last);
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
      // `now` decides which calendar days the range covers, as it does for a real journal; what
      // is IN each of them is the serve's own frozen past. So a demo left open loses a day off
      // the front at each midnight — six of seven the next morning, and nothing at all a week
      // in, which is the empty page this exists to remove, reached quietly. The alternative is
      // to date the range on the frozen past too, and then a serve open for three days draws a
      // week that ended three days ago under a live view dated now. Neither is right for a
      // process meant to be opened, looked at and closed; this one at least degrades the way a
      // real journal that stopped being written does.
      readRange({ dir: DEMO_HISTORY_DIR, range, now, readDay: async (date) => demoJournalDay(date, dayStart) }),
  };
}
