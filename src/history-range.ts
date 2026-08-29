// Reading the journal back. The store writes and never reads; this reads and never writes.
//
// `history-store.ts` appends one line a minute and is the only thing that touches those files.
// This is the other half: given a directory and a range, it hands back the three shapes the
// questions in #3 are actually asked in. What a context reached, hour by hour. What a project
// spent, day by day. When the plan window turned over. The raw minute stays on disk, so the
// aggregation lives here, on the reading side, where changing it costs nothing already written.
//
// Two rules run through all of it.
//
// It never throws. A journal is a file on someone's machine, and a full volume tears a line in
// half: `appendFileSync` loops on `writeSync`, so a disk that filled mid-record leaves the
// front of it behind and the next minute glues itself on (#134). A reader that failed the whole
// month on one bad byte would be a reader nobody keeps a journal for. A line that will not
// parse, or that parses into something that is not a reading, is counted and stepped over, and
// the count is served with the answer so nobody has to guess what they are looking at.
//
// It reads a file at a time, asynchronously, and `list` never comes here. `serve` samples the
// fleet on a timer of its own and answers requests between ticks; thirty days of journal is
// tens of megabytes, and reading them synchronously would stop the sampler mid-range.

import fs from 'node:fs/promises';
import path from 'node:path';
import { readLimits } from './limits.ts';

/** The ranges this reads. `24h` is not one of them: that is the ring, in memory, and it is served
 * without touching the disk. */
export const HISTORY_RANGES = ['7d', '30d'] as const;

export type HistoryRange = (typeof HISTORY_RANGES)[number];

/** How many local days each range covers, today included, exactly as the store's retention counts. */
const RANGE_DAYS: Record<HistoryRange, number> = { '7d': 7, '30d': 30 };

/**
 * How far a window has to fall between two readings to be a window that turned over.
 *
 * A rolling allowance sags as the oldest usage in it ages out, a point or two at a time, and
 * calling that a reset would put a turnover marker on the curve several times an hour. What a
 * real reset looks like is a cliff: the window ends, everything in it goes, and the next reading
 * is near zero. Five points is comfortably above the sag and far below the cliff.
 */
const RESET_DROP_POINTS = 5;

/** One session inside one hour, as that hour left it. */
export interface RangeHourSession {
  /**
   * Never null. A reading whose session id was missing cannot be told apart from the next one,
   * so it is not followed across minutes at all: see `sessionsOf`.
   */
  sid: string;
  project: string | null;
  /**
   * Interactive or background, as the last reading that could say it said. The view draws a
   * context curve a reader wants the background agents out of, and this is what it filters on.
   */
  kind: string | null;
  /**
   * The highest it reached in the hour, not the last it was seen at. A session compacted at
   * ten to the hour still went to 91, and that is the fact a curve about recycling is drawn on.
   */
  ctxPct: number | null;
  /** The last one measured in the hour: cost only ever climbs, so the last is the total so far. */
  costUsd: number | null;
  /**
   * The last state it was seen in. Free text as it came off the source, never mapped: a word
   * `claude agents --json` prints that tarmac has no boolean for is shown as it was written.
   */
  state: string | null;
}

export interface RangeHour {
  /** The start of the local hour, which is the hour the reader was awake for. */
  t: number;
  sessions: RangeHourSession[];
  /**
   * Readings this hour was built from. An hour of sixty and an hour of one are drawn the same
   * and are not the same fact: the second is a serve that was starting, stopping, or asleep.
   */
  n: number;
  /** The highest each window reached in the hour, `null` where nothing readable was written. */
  rateLimits: { five_hour: number | null; seven_day: number | null };
}

export interface RangeProjectCost {
  project: string | null;
  costUsd: number;
}

export interface RangeDay {
  /** The local day, `YYYY-MM-DD`: the name of the file these records came out of. */
  date: string;
  /** Most expensive first. */
  byProject: RangeProjectCost[];
}

export interface RangeReset {
  limit: string;
  /** The reading AFTER the fall, which is the first minute the new window was true of. */
  t: number;
  from: number;
  to: number;
  /**
   * How long since the reading `from` was taken. A minute means a turnover that was watched
   * happening; a day means the serve was off across it and this marker is where the record
   * resumes, not where the window actually rolled.
   */
  sinceMs: number;
}

/** What the range was asked for against what it found, so a thin answer can be read as one. */
export interface RangeCoverage {
  daysRequested: number;
  /** Records read and used. How many days had a file is `days.length`. */
  lines: number;
  /**
   * Lines that would not parse, or that parsed into something that is not a reading. This is
   * #134's number, and it is kept for that: a torn line is a filesystem event worth seeing.
   */
  skipped: number;
  /** Lines that read cleanly and carry a clock outside the range. A different fact, counted apart. */
  outOfRange: number;
  /** Session entries dropped inside readings that were kept: no id of their own, or not an object. */
  droppedSessions: number;
  /** Whether the journal had stopped at its cap. See `ReadRangeOptions`. */
  capped: boolean;
}

export interface RangeHistory {
  range: HistoryRange;
  /** Oldest first, and only the hours something was written in. An hour nobody read the fleet
   * in is absent rather than a row of zeroes. */
  hours: RangeHour[];
  /** Oldest first, and only the days there is a file for. */
  days: RangeDay[];
  resets: RangeReset[];
  coverage: RangeCoverage;
}

export interface ReadRangeOptions {
  /** The journal directory, `historyDirFor(snapshotsDir)`. */
  dir: string;
  range: HistoryRange;
  /**
   * The moment the range ends at, injected. A range judged by the wall clock is a test that
   * changes its answer at midnight, and a serve that has been up for a week has to keep asking
   * what "the last seven days" means rather than deciding it once at startup.
   */
  now: number;
  /**
   * Whether the store has stopped writing, which only the writer knows. A journal at its cap
   * has the shape of a fleet that went quiet, files and lines and then nothing, and the reader
   * cannot tell those apart from the disk alone.
   */
  capped?: boolean;
}

/** A reading as it comes back off the disk: checked for shape, and nothing more. */
interface Record_ {
  t: number;
  sessions: SessionRead[];
  rateLimits: Record<string, any> | null;
  /** Entries of `sessions` that were not objects, counted here so a kept record can report them. */
  dropped: number;
}

interface SessionRead {
  sid: string | null;
  project: string | null;
  kind: string | null;
  ctxPct: number | null;
  costUsd: number | null;
  state: string | null;
}

interface HourSessionAcc {
  project: string | null;
  kind: string | null;
  ctxPct: number | null;
  costUsd: number | null;
  /** When the cost above was read, so the LAST one wins whatever order the lines arrived in. */
  costAt: number;
  state: string | null;
  lastAt: number;
}

interface HourAcc {
  n: number;
  sessions: Map<string, HourSessionAcc>;
  five: number | null;
  seven: number | null;
}

/** What one session spent on one day: the highest reading of it, less the lowest. */
interface DaySessionAcc {
  project: string | null;
  min: number;
  max: number;
}

/**
 * The journal, aggregated over a range of local days.
 *
 * Sequential on purpose, a file at a time: `serve` answers this on the same thread it samples
 * the fleet on, and thirty files opened at once is thirty buffers of a day each in memory for
 * an answer that is a few hundred rows.
 */
export async function readRange({ dir, range, now, capped = false }: ReadRangeOptions): Promise<RangeHistory> {
  const daysRequested = RANGE_DAYS[range];
  const coverage: RangeCoverage = { daysRequested, lines: 0, skipped: 0, outOfRange: 0, droppedSessions: 0, capped };
  const hours = new Map<number, HourAcc>();
  const days = new Map<string, Map<string, DaySessionAcc>>();
  const resets: RangeReset[] = [];
  // The last percentage each window was seen at, carried across files: a reset at four in the
  // morning is a fall from the last reading of one day to the first of the next. It is never
  // cleared, so a serve that was off for four days reports the fall across the gap as one
  // turnover on the morning it came back, which is where the record resumes rather than where
  // the window actually rolled. A reset in the first minute of the oldest day has nothing to
  // fall from and is not reported at all, so `7d` and `30d` can disagree about that one day.
  const previous = new Map<string, { pct: number; t: number }>();
  // The window a reading has to fall in to be aggregated at all. The day files are named by the
  // writer's clock and each line carries the reading's own, so the two can disagree: a torn line
  // that still parses, a clock corrected by NTP between the two. Bucketing that by its `t` puts
  // an hour in 1970 on a chart that says "the last seven days", and a `t` past what a Date can
  // express buckets to `NaN`, which serialises as `null` and takes the ordering with it.
  const days_ = calendarDays(now, daysRequested);
  const windowStart = startOfDay(now, daysRequested - 1);
  const windowEnd = startOfDay(now, -1);

  for (const date of days_) {
    let text: string;
    try {
      text = await fs.readFile(path.join(dir, `${date}.jsonl`), 'utf8');
    } catch {
      // A day with no file is the normal case: `serve` was not running. A day whose file cannot
      // be read is the same answer for this reader, and `serve` is not the process that fixes it.
      continue;
    }

    // The day a record is CHARGED to is the file it is in, and the hour it falls in is its own
    // clock. The file name is the day the writer decided on, so a reading taken a second before
    // midnight stays on the day it was journalled to rather than moving under the reader.
    const spent = days.get(date) ?? new Map<string, DaySessionAcc>();
    days.set(date, spent);

    for (const line of text.split('\n')) {
      if (line === '') continue;
      const record = recordOf(line);
      if (record === null) {
        coverage.skipped += 1;
        continue;
      }
      // A reading nobody can date is a reading nothing can be charged to, hours and cost alike.
      // `NaN` fails both comparisons, which is the point. Counted apart from the torn lines:
      // one is a filesystem that failed, the other a clock that disagrees with a file name.
      if (!(record.t >= windowStart && record.t < windowEnd)) {
        coverage.outOfRange += 1;
        continue;
      }
      coverage.lines += 1;
      coverage.droppedSessions += record.dropped;

      const hour = hourOf(record.t);
      const acc = hours.get(hour) ?? { n: 0, sessions: new Map<string, HourSessionAcc>(), five: null, seven: null };
      acc.n += 1;
      hours.set(hour, acc);

      for (const s of record.sessions) {
        // No id, no history. Two nameless readings a minute apart are not knowably one session,
        // and folding them together would invent a cost nobody spent. They are in the file, and
        // the live views still show them: what cannot be done is follow them through time.
        if (s.sid === null) {
          coverage.droppedSessions += 1;
          continue;
        }

        const held = acc.sessions.get(s.sid);
        if (held === undefined) {
          acc.sessions.set(s.sid, {
            project: s.project,
            kind: s.kind,
            ctxPct: s.ctxPct,
            costUsd: s.costUsd,
            // Dated by the reading that MEASURED it, so a first reading carrying no cost cannot
            // date an absence and refuse every earlier reading that had one.
            costAt: s.costUsd === null ? -Infinity : record.t,
            state: s.state,
            lastAt: record.t,
          });
        } else {
          if (s.ctxPct !== null && (held.ctxPct === null || s.ctxPct > held.ctxPct)) held.ctxPct = s.ctxPct;
          // A reading that measured no cost does not erase the one before it: what is wanted is
          // the last cost that was MEASURED, and a snapshot that never landed measured nothing.
          if (s.costUsd !== null && record.t >= held.costAt) {
            held.costUsd = s.costUsd;
            held.costAt = record.t;
          }
          if (record.t >= held.lastAt) {
            held.lastAt = record.t;
            held.state = s.state;
          }
          // A project and a kind are identities, not measurements: a reading that could not name
          // one has not renamed anything, and letting the last one win moved a whole session
          // under a nameless heading because the minute it was last seen in was a thin one.
          if (s.project !== null) held.project = s.project;
          if (s.kind !== null) held.kind = s.kind;
        }

        if (s.costUsd === null) continue;
        const day = spent.get(s.sid);
        if (day === undefined) spent.set(s.sid, { project: s.project, min: s.costUsd, max: s.costUsd });
        else {
          if (s.project !== null) day.project = s.project;
          if (s.costUsd < day.min) day.min = s.costUsd;
          if (s.costUsd > day.max) day.max = s.costUsd;
        }
      }

      // The account's two windows, read through the same parser the gauges are drawn from, so a
      // percentage this refuses is a percentage the live view refuses too. The clock is only
      // used for how long a window has left, which nothing here asks.
      for (const gauge of readLimits(record.rateLimits, record.t)) {
        if (gauge.pct === null) continue;
        const before = previous.get(gauge.key);
        if (before !== undefined && before.pct - gauge.pct > RESET_DROP_POINTS) {
          resets.push({ limit: gauge.key, t: record.t, from: before.pct, to: gauge.pct, sinceMs: record.t - before.t });
        }
        previous.set(gauge.key, { pct: gauge.pct, t: record.t });
        if (gauge.key === 'five_hour' && (acc.five === null || gauge.pct > acc.five)) acc.five = gauge.pct;
        if (gauge.key === 'seven_day' && (acc.seven === null || gauge.pct > acc.seven)) acc.seven = gauge.pct;
      }
    }
  }

  return {
    range,
    hours: [...hours.entries()]
      .sort(([a], [b]) => a - b)
      .map(([t, acc]) => ({
        t,
        sessions: [...acc.sessions.entries()]
          .sort(([a], [b]) => compare(a, b))
          .map(([sid, s]) => ({
            sid,
            project: s.project,
            kind: s.kind,
            ctxPct: s.ctxPct,
            costUsd: s.costUsd,
            state: s.state,
          })),
        n: acc.n,
        rateLimits: { five_hour: acc.five, seven_day: acc.seven },
      })),
    // Already oldest first: the map is filled in the order `calendarDays` walks, and a day is
    // read once. A sort here would be a line nothing could ever put in the wrong order.
    days: [...days.entries()].map(([date, spent]) => ({ date, byProject: byProject(spent) })),
    resets,
    coverage,
  };
}

/**
 * What each project spent on a day: for every session id, the highest cost it was read at less
 * the lowest, summed.
 *
 * A difference rather than a total, because a total is wrong twice. A session recycled at three
 * in the morning is two ids under one project, and adding their final costs counts the night's
 * work twice; a session left open across midnight starts the new day carrying everything it
 * spent on the old one, and charging that to the new day bills yesterday again. What each id
 * spent WITHIN the day is the only quantity both cases agree on.
 *
 * Highest less lowest, and deliberately not last less first. Cost comes off the statusline
 * payload, which nobody promised would only ever climb: a counter that drops mid-day would then
 * make a NEGATIVE day, and negative money in a total is worse than a day billed as though it had
 * only climbed. It is a floor either way: whatever was spent between the last reading of one day
 * and the first of the next belongs to neither, which is a minute of drift and never a session.
 */
function byProject(spent: Map<string, DaySessionAcc>): RangeProjectCost[] {
  const totals = new Map<string, { project: string | null; costUsd: number }>();
  for (const { project, min, max } of spent.values()) {
    // Keyed on a string so a project nobody could name has a bucket of its own rather than
    // sharing one with the first project whose name happens to be missing too. NUL is the
    // sentinel because it is the one string a project name cannot be: `path.basename('/')` is
    // the empty string, so `''` would be a real bucket. Written as an escape, never as the byte
    // itself, which turns this file and the `dist/` it compiles to into `file`-classified data.
    const key = project ?? '\u0000';
    const held = totals.get(key) ?? { project, costUsd: 0 };
    held.costUsd += max - min;
    totals.set(key, held);
  }
  // Ties broken by name, and by code point rather than by locale: `localeCompare` answers out of
  // the ICU data the process happens to have, so two serves on one machine could order the same
  // two projects differently. Nothing else in this file sorts strings any other way.
  return [...totals.values()].sort((a, b) => b.costUsd - a.costUsd || compare(a.project ?? '', b.project ?? ''));
}

/** The local days a range covers, oldest first, today included. */
function calendarDays(now: number, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(dayOf(startOfDay(now, i)));
  return out;
}

/**
 * Midnight `back` local days before the day `now` falls on. `back: -1` is the midnight that ends
 * today, which is what bounds the range at the near end.
 *
 * Calendar arithmetic, never 24-hour blocks: two of those cross a DST boundary as 47 or 49 hours
 * and move the oldest day by one, on the one morning a year a clock shifted. This is the store's
 * own rule for its retention, and the two have to name the same files.
 */
function startOfDay(now: number, back: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const pad = (n: number): string => String(n).padStart(2, '0');

const dayOf = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** The start of the local hour a moment falls in. Local, so a bucket is an hour of someone's day. */
function hourOf(t: number): number {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/**
 * One line, checked for the shape a reading has, or `null` for the caller to count.
 *
 * Strict about the frame and forgiving inside it. A record has to have a clock that is a number
 * and a list of sessions, because everything downstream buckets on those two; a session has to
 * be an object, and every field it carries is taken if it is the right type and dropped if it is
 * not. That is the same discipline the live views apply to the payload: a value that will not
 * read is absent, never a zero, and never a reason to throw away the reading around it.
 */
function recordOf(line: string): Record_ | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // The torn line of #134, and anything else a filesystem did to this file.
    return null;
  }
  if (!isObject(parsed)) return null;
  const t = parsed.t;
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  if (!Array.isArray(parsed.sessions)) return null;
  // Not a reason to refuse the line. `rate_limits: []` is legal JSON, `limits.ts` names it as a
  // shape the source sends, and `snapshots.ts` lets it through because `typeof [] === 'object'`,
  // so it can be in the file. The live gauges read it as two windows nobody measured; refusing
  // it here would blank every cost, context and project of every minute it appears in.
  const rateLimits = isObject(parsed.rateLimits) ? (parsed.rateLimits as Record<string, any>) : null;

  const sessions: SessionRead[] = [];
  let dropped = 0;
  for (const entry of parsed.sessions) {
    // Same rule one level down: what cannot be read is dropped, never the readings beside it.
    if (!isObject(entry)) {
      dropped += 1;
      continue;
    }
    sessions.push({
      // The empty string is not an id. It is what a payload writes where a session had none,
      // and one bucket named `''` would fold every nameless reading into a single session.
      sid: typeof entry.sid === 'string' && entry.sid !== '' ? entry.sid : null,
      project: typeof entry.project === 'string' ? entry.project : null,
      kind: typeof entry.kind === 'string' ? entry.kind : null,
      ctxPct: number(entry.ctxPct),
      costUsd: number(entry.costUsd),
      state: typeof entry.state === 'string' ? entry.state : null,
    });
  }
  return { t, sessions, rateLimits, dropped };
}

const isObject = (v: unknown): v is { [k: string]: unknown } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const number = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
