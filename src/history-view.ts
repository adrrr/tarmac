// The third view: what moved, over a day, a week or a month.
//
// The table and the map are photographs. The questions people actually open a fleet dashboard
// with are questions of movement — is this context climbing fast enough that the session has
// to be recycled tonight, what did last week cost, which project burns the most, where the
// plan window stands. This draws those three, out of two sources the serve already has: the
// ring in memory for 24h, and the journal on disk for 7d and 30d.
//
// Canvas rather than SVG, and no library either way. Eight lines of 1440 points is eleven
// thousand DOM nodes an SVG would have to keep, and the page's own red line is zero runtime
// dependencies — so the drawing is a few hundred lines of 2d context and the SHAPES it draws
// are the part worth testing.
//
// Which is the arrangement below. Everything that decides something — which minute is a gap,
// which reading starts a new line, what an hour cost when the wire carries a running total,
// what order the stack is built in — is an exported function here, tested directly by
// `test/history-view`, and shipped to the browser as its own source through `String`. The
// page runs the function the suite ran. Everything below `historyScript` is pixels: geometry,
// labels and hit-testing, which no assertion can read and none pretends to.

import { INTERACTIVE } from './map.ts';

/** How many hues the palette has before it starts again. Eight is what a legend can be read at. */
const SLOTS = 8;

/**
 * How far apart two readings may be for the turnover between them to be one somebody watched.
 *
 * The journal writes a line a minute, so a window that rolled while the serve was up is dated
 * to the minute. A gap wider than this means the serve was off across the turnover and the
 * marker sits where the RECORD resumes, not where the window actually rolled — the chart says
 * so rather than drawing a precise line through a moment nobody measured.
 */
const RESET_WATCHED_MS = 600000;

const MIN = 60000;
const HOUR = 3600000;

/** One drawable line: a project's colour, a clock, and one reading per step. */
export interface Series {
  name: string | null;
  slot: number;
  t0: number;
  step: number;
  v: (number | null)[];
}

/**
 * One session's line, which carries a fact about the session that the drawing does not need
 * and the legend cannot work without.
 *
 * `v` cannot say when a session was last around. A null in it is both a minute the session was
 * not in the sample and a minute it was there with nothing readable, and those two are the
 * whole difference between the cases the legend has to tell apart: a session recycled at three
 * stops appearing, a session that was never chained keeps appearing and never reads. Both end
 * in a run of nulls.
 */
export interface Line extends Series {
  /** The last step the session was SEEN at, whether or not that minute had a reading. */
  lastAt: number;
}

/** A project and the colour it keeps for the whole range. */
export interface Slot {
  name: string | null;
  slot: number;
}

/** Bars: one bucket a column, every column carrying the same projects in the same order. */
export interface CostSeries {
  projects: Slot[];
  /**
   * `n` is what makes an empty column readable. Every hour of the span gets a column, so the
   * axis does not close a gap up; an hour with `n` of 0 had no reading in it at all, and the
   * difference between that and an hour the fleet sat idle in is the whole of the page's rule
   * about a number nobody measured.
   */
  buckets: { t: number; span: number; n: number; by: number[] }[];
  /** Per project, whether any reading in the range carried a cost for it. */
  measured: boolean[];
}

export interface LegendKey {
  name: string | null;
  slot: number;
  k: number;
  /** `null` where nothing was ever measured, which is not the same as nothing was ever spent. */
  total: number | null;
}

export interface QuotaSeries {
  t0: number;
  step: number;
  five: (number | null)[];
  seven: (number | null)[];
  resets: { limit: string; t: number; watched: boolean }[];
}

// ── the transforms, which are also the source the browser runs ───────────────────────────
//
// Written in the page script's own dialect — `var`, plain functions, no destructuring — for
// one reason: they are handed to the browser through `String`, and what is read back has to
// be what a browser executes, under type stripping here and after `tsc` in the published
// output alike. Nothing in them may close over anything this module does not also emit.

/**
 * Who gets which hue, decided once for a whole range and used by all three charts.
 *
 * Sorted rather than first-seen: a project's colour may not depend on which minute of the
 * range it happened to appear in, or a reader coming back to the same week would find their
 * fleet repainted. A project with no name sorts last and keeps a slot of its own — it is a
 * real reading, and dropping it would make a cost chart that does not add up.
 */
export function rosterOf(names: (string | null)[]): Slot[] {
  var seen: (string | null)[] = [];
  var i;
  for (i = 0; i < names.length; i++) if (seen.indexOf(names[i]) === -1) seen.push(names[i]);
  seen.sort(function (a, b) {
    if (a === null) return b === null ? 0 : 1;
    if (b === null) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  var out: Slot[] = [];
  for (i = 0; i < seen.length; i++) out.push({ name: seen[i], slot: (i % SLOTS) + 1 });
  return out;
}

/** The hue a project was given, or the first one if this range never saw it. */
export function slotIn(roster: Slot[], name: string | null): number {
  for (var i = 0; i < roster.length; i++) if (roster[i].name === name) return roster[i].slot;
  return 1;
}

/**
 * One reading per pixel of plot, and the reading kept is the HIGHEST in the bucket.
 *
 * A ring is 1441 points and a phone plot is three hundred pixels wide: taking every fifth
 * point would drop the peak a context curve exists to show. A bucket holding a minute nobody
 * read stays a gap — a recycle must read as a break in the line and never as a fall to zero,
 * which is what averaging or skipping the hole would draw.
 */
export function decimate(v: (number | null)[], want: number): { v: (number | null)[]; step: number } {
  // A plot with no pixels to spend still has to answer with a series and a step somebody can
  // multiply by. Asked for none, it hands back one bucket rather than a step of Infinity, which
  // turns every x it is used to compute into NaN.
  if (!(want >= 1)) want = 1;
  var step = Math.max(1, Math.floor(v.length / want));
  if (step === 1) return { v: v, step: 1 };
  var out: (number | null)[] = [];
  for (var i = 0; i < v.length; i += step) {
    var m: number | null = null;
    var gap = false;
    for (var j = i; j < i + step && j < v.length; j++) {
      if (v[j] === null) gap = true;
      else if (m === null || (v[j] as number) > m) m = v[j] as number;
    }
    out.push(gap ? null : m);
  }
  return { v: out, step: step };
}

/**
 * How many slots a grid running from `t0` to `tLast` in steps of `step` has, or 0.
 *
 * Zero when the step is not a positive finite number, and the callers draw nothing rather than
 * anything at all. This is not defensiveness for its own sake: `Math.round(x / 0)` is Infinity,
 * and an array of that length throws — one field of one answer, and the whole view is a blank
 * page instead of a chart. The page's own rule about the account's windows applies here too:
 * nothing off the wire may throw in a dashboard.
 */
export function gridLen(t0: number, tLast: number, step: number): number {
  if (typeof step !== 'number' || !isFinite(step) || step <= 0) return 0;
  if (!isFinite(t0) || !isFinite(tLast)) return 0;
  var n = Math.round((tLast - t0) / step) + 1;
  return isFinite(n) && n >= 1 ? n : 1;
}

/** The last reading a line actually took, which is the number its label carries. */
export function lastOf(v: (number | null)[]): number | null {
  for (var i = v.length - 1; i >= 0; i--) if (v[i] !== null) return v[i];
  return null;
}

/**
 * Climbing: fifteen points or more gained over the last three hours.
 *
 * The one judgement this view makes about a session, and it is the question the whole context
 * chart exists to answer — a fleet of eight lines says nothing until the two that are going
 * somewhere are picked out of it. Both ends have to be readings: a line whose last three hours
 * are a gap has not climbed, it has been unwatched.
 */
export function rising(s: { v: (number | null)[]; step: number }): boolean {
  var last = lastOf(s.v);
  if (last === null || !(s.step > 0)) return false;
  // The OLDEST reading inside the window, not the reading at its edge. A session that started
  // after breakfast and is already at 90 is the one this chart exists to surface, and measured
  // against the minute exactly three hours back it is invisible: three hours ago it did not
  // exist, so its own age hides it. The window is a ceiling on how long the gain may have
  // taken, which is the rule as written; where it began inside the window is not the question.
  var from = Math.max(0, s.v.length - 1 - Math.round((3 * HOUR) / s.step));
  for (var i = from; i < s.v.length; i++) {
    var back = s.v[i];
    if (back !== null) return last - back >= 15;
  }
  // Nothing inside the window is a reading. That is a line nobody watched, not a line climbing.
  return false;
}

/** A number the page may plot, or null. Anything else on the wire is a reading nobody took. */
export function pctOf(v: any): number | null {
  return typeof v === 'number' && isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

/**
 * 24h context: one line per SESSION, on the ring's own minute grid.
 *
 * Keyed by session id and never by project, because that is what breaks the line: a session
 * recycled at three in the morning is a different session, and joining its successor's 4% to
 * its own 88% would draw a cliff that never happened. Both lines wear the project's colour —
 * it is the same work continuing, and the break is the thing that says the session did not.
 *
 * A minute the collector missed is a hole in every line at once. The grid is the ring's, so a
 * sample that never arrived is an index nobody filled rather than a point nobody drew.
 */
export function ctxLines(samples: any[], cadence: number, roster: Slot[]): Line[] {
  if (samples.length === 0) return [];
  var t0 = samples[0].t;
  var n = gridLen(t0, samples[samples.length - 1].t, cadence);
  if (n === 0) return [];
  // The live map's own rule, in the copy of it that ships to the browser: nothing counts as a
  // background agent until something in the range calls itself interactive, or a fleet of
  // agents alone would draw an empty chart.
  var anchored = false;
  var i, j;
  for (i = 0; i < samples.length; i++)
    for (j = 0; j < samples[i].sessions.length; j++)
      if (samples[i].sessions[j].kind === INTERACTIVE) anchored = true;
  var keys: string[] = [];
  var lines: Line[] = [];
  for (i = 0; i < samples.length; i++) {
    var idx = Math.round((samples[i].t - t0) / cadence);
    if (idx < 0 || idx >= n) continue;
    for (j = 0; j < samples[i].sessions.length; j++) {
      var s = samples[i].sessions[j];
      // No id, not followed: two readings that both lost theirs cannot be told apart, and a
      // line drawn through them would join two sessions into one.
      if (typeof s.sid !== 'string' || s.sid === '') continue;
      if (anchored && s.kind !== null && s.kind !== undefined && s.kind !== INTERACTIVE) continue;
      var k = keys.indexOf(s.sid);
      if (k === -1) {
        k = keys.length;
        keys.push(s.sid);
        var v: (number | null)[] = [];
        for (var z = 0; z < n; z++) v.push(null);
        lines.push({ name: s.project, slot: slotIn(roster, s.project), t0: t0, step: cadence, v: v, lastAt: idx });
      } else if (idx > lines[k].lastAt) lines[k].lastAt = idx;
      lines[k].v[idx] = pctOf(s.ctxPct);
    }
  }
  return lines;
}

/**
 * 7d and 30d context: one row per PROJECT, on the journal's hour grid.
 *
 * Eight sessions a day over a month is hundreds of lines on one plot, which is a wall and not
 * a chart. The question at this range is about the project, so the sessions inside an hour are
 * reduced to the highest any of them reached — the same reduction the reader already made,
 * one level up.
 *
 * An hour nobody wrote a line in is absent from the reader's answer, so the grid is rebuilt
 * from the clocks rather than from the array's length: a serve that was off for a day leaves a
 * day-wide hole, not a day the chart quietly closes up.
 */
export function ctxRows(hours: any[], roster: Slot[]): Series[] {
  if (hours.length === 0) return [];
  var t0 = hours[0].t;
  var n = gridLen(t0, hours[hours.length - 1].t, HOUR);
  if (n === 0) return [];
  var anchored = false;
  var i, j;
  for (i = 0; i < hours.length; i++)
    for (j = 0; j < hours[i].sessions.length; j++) if (hours[i].sessions[j].kind === INTERACTIVE) anchored = true;
  var rows: Series[] = [];
  for (i = 0; i < roster.length; i++) {
    var v: (number | null)[] = [];
    for (var z = 0; z < n; z++) v.push(null);
    rows.push({ name: roster[i].name, slot: roster[i].slot, t0: t0, step: HOUR, v: v });
  }
  for (i = 0; i < hours.length; i++) {
    var idx = Math.round((hours[i].t - t0) / HOUR);
    if (idx < 0 || idx >= n) continue;
    for (j = 0; j < hours[i].sessions.length; j++) {
      var s = hours[i].sessions[j];
      if (anchored && s.kind !== null && s.kind !== undefined && s.kind !== INTERACTIVE) continue;
      var pct = pctOf(s.ctxPct);
      if (pct === null) continue;
      for (var k = 0; k < roster.length; k++) {
        if (roster[k].name !== s.project) continue;
        var held = rows[k].v[idx];
        if (held === null || pct > held) rows[k].v[idx] = pct;
      }
    }
  }
  // A project the range has no context for at all gets no band. The roster is every project
  // that spent anything, and a background agent spends without ever drawing a statusline
  // frame: a row of nothing under its name is a band that says the reader is missing data
  // rather than that there was never any to have.
  var kept: Series[] = [];
  for (i = 0; i < rows.length; i++) if (lastOf(rows[i].v) !== null) kept.push(rows[i]);
  return kept;
}

/** The start of the local hour a moment falls in. */
export function hourOf(t: number): number {
  var d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/**
 * 24h cost: what each project spent in each HOUR, out of a wire that carries running totals.
 *
 * `costUsd` in the ring only ever climbs — it is a session's total so far — so an hour's spend
 * is the difference between the ends of that hour, per session id. Three rules make that
 * honest, and each of them is a test:
 *
 *   • The baseline is a session's FIRST reading inside the range, not zero. A session that was
 *     already running when the window opened carries hours of spending nobody in this chart
 *     watched, and charging it to the first bar would put a spike at the left edge of every
 *     ring that has been up less than the session it is watching.
 *   • A new session id starts its own baseline. The nightly recycle replaces a session that
 *     had spent forty dollars with one that has spent fifty cents, and a total shared across
 *     the pair reads as a refund of thirty-nine and a half.
 *   • The floor is zero. A running total is not supposed to fall; a payload is not supposed to
 *     lie either, and a negative bar is a chart claiming money came back.
 *
 * Background agents ARE counted here, unlike on the context chart above: they have no terminal
 * and so no context to draw, but they spend from the same account.
 */
export function costHourly(samples: any[], roster: Slot[]): CostSeries {
  var buckets: { t: number; span: number; n: number; by: number[] }[] = [];
  var measured: boolean[] = [];
  var seen: any = {};
  var i, j, k;
  for (k = 0; k < roster.length; k++) measured.push(false);
  var mk = function (t: number): number {
    for (var b = 0; b < buckets.length; b++) if (buckets[b].t === t) return b;
    var by: number[] = [];
    for (var z = 0; z < roster.length; z++) by.push(0);
    buckets.push({ t: t, span: HOUR, n: 0, by: by });
    return buckets.length - 1;
  };
  // The whole span gets a column, so an hour the fleet was idle is a gap in the bars rather
  // than an hour the chart leaves out and the axis silently closes up.
  if (samples.length > 0) {
    var first = hourOf(samples[0].t);
    var last = hourOf(samples[samples.length - 1].t);
    for (var t = first; t <= last; t += HOUR) mk(hourOf(t));
  }
  for (i = 0; i < samples.length; i++) {
    var b = mk(hourOf(samples[i].t));
    for (j = 0; j < samples[i].sessions.length; j++) {
      var s = samples[i].sessions[j];
      if (typeof s.sid !== 'string' || s.sid === '') continue;
      if (typeof s.costUsd !== 'number' || !isFinite(s.costUsd)) continue;
      var col = -1;
      for (k = 0; k < roster.length; k++) if (roster[k].name === s.project) col = k;
      if (col === -1) continue;
      // Counted on the reading that carries a cost, not on the sample: a minute in which the
      // fleet was read but nobody published a cost has measured the fleet, not the spending.
      buckets[b].n += 1;
      measured[col] = true;
      var held = Object.prototype.hasOwnProperty.call(seen, s.sid) ? seen[s.sid] : null;
      // The first reading of a session is its baseline, never a bar: what it carries was
      // spent before this window opened, and the hour it lands in did not see it.
      if (held === null) seen[s.sid] = s.costUsd;
      else if (s.costUsd > held) {
        buckets[b].by[col] += s.costUsd - held;
        seen[s.sid] = s.costUsd;
      }
      // A total that fell is not spending, and not a refund either: the baseline stays at the
      // high water mark, so the next real climb is measured from something that was true.
    }
  }
  return { projects: roster, buckets: buckets, measured: measured };
}

/**
 * 7d and 30d cost: one bar a day, out of the per-day sums the journal reader already made.
 *
 * Those arrive most expensive first, which is the LEGEND's order and not the stack's. The
 * stack is built in the palette's order — the same order every day of the range — so a slab
 * keeps its colour and its place in the column from Monday to Sunday and can be followed
 * across the week. A stack sorted by rank would have every project moving up and down the
 * column as its day went, which is a chart nobody can read sideways.
 */
export function costDaily(days: any[], roster: Slot[]): CostSeries {
  var buckets: { t: number; span: number; n: number; by: number[] }[] = [];
  var measured: boolean[] = [];
  var z;
  for (z = 0; z < roster.length; z++) measured.push(false);
  for (var i = 0; i < days.length; i++) {
    var by: number[] = [];
    var n = 0;
    for (z = 0; z < roster.length; z++) by.push(0);
    var list = days[i].byProject || [];
    for (var j = 0; j < list.length; j++)
      for (var k = 0; k < roster.length; k++)
        if (roster[k].name === list[j].project && typeof list[j].costUsd === 'number' && isFinite(list[j].costUsd)) {
          by[k] += list[j].costUsd;
          measured[k] = true;
          n += 1;
        }
    var t = dayStart(days[i].date);
    // A day nothing can date has no place on an axis. It is dropped rather than drawn at NaN,
    // where it would take the whole plot's geometry with it: the reader names its files after
    // local days, and a directory can hold something the reader did not put there.
    if (!isFinite(t)) continue;
    buckets.push({ t: t, span: 86400000, n: n, by: by });
  }
  return { projects: roster, buckets: buckets, measured: measured };
}

/**
 * `YYYY-MM-DD` as the LOCAL day it names.
 *
 * `Date.parse` reads that spelling as midnight UTC, which is the previous afternoon or the
 * following morning depending on where the reader is — and the journal names its files after
 * the local day, because a local day is the thing a person means by "yesterday".
 */
export function dayStart(date: string): number {
  var p = String(date).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 0, 0, 0, 0).getTime();
}

/**
 * The ranking the stack refuses to draw: most expensive first, colours unmoved.
 *
 * This is where "which project burns the most" is actually answered. The stack keeps a project
 * in one place so it can be followed; the legend puts it in its place so it can be judged.
 */
export function legendByCost(cost: CostSeries): LegendKey[] {
  var keys: LegendKey[] = [];
  for (var k = 0; k < cost.projects.length; k++) {
    var total = 0;
    for (var b = 0; b < cost.buckets.length; b++) total += cost.buckets[b].by[k];
    // A project nothing ever published a cost for spent an unknown amount, not nothing. Ranked
    // at the bottom because it cannot be ranked at all, and printed as a dash rather than as
    // the zero it would otherwise be indistinguishable from.
    keys.push({
      name: cost.projects[k].name,
      slot: cost.projects[k].slot,
      k: k,
      total: cost.measured[k] ? total : null,
    });
  }
  keys.sort(function (a, b) {
    return (b.total === null ? -1 : b.total) - (a.total === null ? -1 : a.total);
  });
  return keys;
}

/** The pair of percentages inside one `rate_limits`, or a pair of nulls. */
export function windowsOf(rl: any): { five: number | null; seven: number | null } {
  var ok = rl !== null && rl !== undefined && typeof rl === 'object' && !(rl instanceof Array);
  var read = function (key: string): number | null {
    if (!ok) return null;
    var w = rl[key];
    if (w === null || w === undefined || typeof w !== 'object' || w instanceof Array) return null;
    return pctOf(w.used_percentage);
  };
  return { five: read('five_hour'), seven: read('seven_day') };
}

/** 24h quota, off the ring: the account's two windows on the ring's own minute grid. */
export function quotaOfSamples(samples: any[], cadence: number): QuotaSeries {
  var out: QuotaSeries = { t0: 0, step: cadence, five: [], seven: [], resets: [] };
  if (samples.length === 0) return out;
  out.t0 = samples[0].t;
  var n = gridLen(out.t0, samples[samples.length - 1].t, cadence);
  if (n === 0) return out;
  for (var z = 0; z < n; z++) {
    out.five.push(null);
    out.seven.push(null);
  }
  for (var i = 0; i < samples.length; i++) {
    var idx = Math.round((samples[i].t - out.t0) / cadence);
    if (idx < 0 || idx >= n) continue;
    var w = windowsOf(samples[i].rateLimits);
    out.five[idx] = w.five;
    out.seven[idx] = w.seven;
  }
  // No markers at this range, and not an omission: the reader hands back turnovers for the
  // journal only, and the five-hour sawtooth on a day of minutes shows its own cliffs. A
  // second drop rule living in the browser would be a second opinion about a fact the server
  // already states, and the two would disagree the day either one changed.
  return out;
}

/**
 * 7d and 30d quota: the hour maxima, and the turnovers the reader found in the journal.
 *
 * A marker whose two readings are far apart is a turnover nobody watched — the serve was off
 * across it, and the marker sits where the record resumes. That is what `sinceMs` is for, and
 * the chart draws such a marker faint and says "about": a firm line through a moment nobody
 * measured is the one thing this view must not draw.
 */
export function quotaOfHours(hours: any[], resets: any[]): QuotaSeries {
  var out: QuotaSeries = { t0: 0, step: HOUR, five: [], seven: [], resets: [] };
  if (hours.length === 0) return out;
  out.t0 = hours[0].t;
  var n = gridLen(out.t0, hours[hours.length - 1].t, HOUR);
  if (n === 0) return out;
  for (var z = 0; z < n; z++) {
    out.five.push(null);
    out.seven.push(null);
  }
  for (var i = 0; i < hours.length; i++) {
    var idx = Math.round((hours[i].t - out.t0) / HOUR);
    if (idx < 0 || idx >= n) continue;
    var rl = hours[i].rateLimits || {};
    out.five[idx] = pctOf(rl.five_hour);
    out.seven[idx] = pctOf(rl.seven_day);
  }
  var list = resets || [];
  for (var j = 0; j < list.length; j++)
    out.resets.push({
      limit: String(list[j].limit),
      t: list[j].t,
      watched: typeof list[j].sinceMs === 'number' && list[j].sinceMs <= RESET_WATCHED_MS,
    });
  return out;
}

/**
 * The context legend, which is per PROJECT where the chart is per session.
 *
 * The chart has to break a line at every recycle or it draws a cliff that never happened, so a
 * project that was recycled at three in the morning owns two lines by lunchtime and four by
 * Friday. A legend that followed it would print the same name four times with four numbers,
 * three of them about sessions that no longer exist. One key a project instead, carrying the
 * reading of the session that was around LAST, and climbing if any of them is: tapping it
 * isolates every line of that project, which is what a reader means by "just show me
 * portfolio".
 *
 * The two halves of a key answer different questions on purpose. The value is where the
 * project is now, so it comes from one line, the last one still there. The arrow is whether
 * anything of this project climbed across the window, so it comes from all of them: a session
 * that ran to 90 and was recycled at three is still the reason a reader looks. A key can
 * therefore read "— ↑", no reading and climbing, and both halves are true of the night it
 * describes.
 */
export function ctxKeys(series: Line[]): { name: string | null; slot: number; v: number | null; up: boolean }[] {
  var out: { name: string | null; slot: number; v: number | null; up: boolean }[] = [];
  // Index-aligned with `out`: which step each key's value was last seen at. Kept beside the
  // answer rather than inside it, so the shape the legend renders carries nothing it cannot use.
  var at: number[] = [];
  for (var i = 0; i < series.length; i++) {
    var k = -1;
    for (var j = 0; j < out.length; j++) if (out[j].name === series[i].name) k = j;
    var last = lastOf(series[i].v);
    var up = rising(series[i]);
    if (k === -1) {
      out.push({ name: series[i].name, slot: series[i].slot, v: last, up: up });
      at.push(series[i].lastAt);
    } else {
      // Newest by when the session was last SEEN, never by where its line sits in the array.
      // The array is ordered by first appearance, and `buildFleet` sorts each sample by state
      // and only then by context (fleet.ts:137): a session that has never been chained can be
      // first or last of its project depending on whether it is busy, so neither end of the
      // array means "the newer one".
      //
      // Seen later wins, even with nothing to report: a session recycled overnight reads null
      // until its first turn, and keeping the dead session's number then prints a context for
      // a session that no longer exists.
      //
      // Seen at the same step is not newer, it is beside. There the reading decides: a line
      // that has one takes the key from a line that has none, and between two readings the
      // line already holding it keeps it, which is the highest of them since that is the order
      // `buildFleet` puts equals in. A tie settled by arrival alone hands the key to whichever
      // of the two happened to be busy, and prints a dash over a project reading 53%.
      if (series[i].lastAt > at[k] || (series[i].lastAt === at[k] && out[k].v === null && last !== null)) {
        out[k].v = last;
        at[k] = series[i].lastAt;
      }
      out[k].up = out[k].up || up;
    }
  }
  return out;
}

/**
 * How solid a filled area is drawn, which is not the same answer in both schemes.
 *
 * A saturated slab that reads as colour on white glares on the near-black this page uses at
 * night, and eight of them stacked in a column glare together. Backing the fills off lets the
 * page's own background through and puts them back at the weight the light scheme has. Only
 * FILLS: a line is a hair wide and needs every bit of its colour to be seen at all.
 */
export function fillAlpha(dark: boolean): number {
  return dark ? 0.55 : 1;
}

/** Every transform above, in the order the script needs them declared. */
const PURE = [
  rosterOf,
  slotIn,
  decimate,
  lastOf,
  rising,
  pctOf,
  ctxLines,
  ctxRows,
  hourOf,
  costHourly,
  costDaily,
  dayStart,
  legendByCost,
  windowsOf,
  quotaOfSamples,
  gridLen,
  quotaOfHours,
  ctxKeys,
  fillAlpha,
];

// ── the sheet ────────────────────────────────────────────────────────────────────────────

/**
 * The palette, eight hues that stay apart in both schemes and are not any of the four the page
 * already spends on state. Categorical: nothing here is ordered, so nothing here is a ramp.
 */
export const HISTORY_PALETTE = `
  :root { --s1:#2563eb; --s2:#ea580c; --s3:#0d9488; --s4:#d97706; --s5:#ec4899; --s6:#166534; --s7:#7c3aed; --s8:#dc2626; }
  @media (prefers-color-scheme: dark) { :root {
    --s1:#3b82f6; --s2:#ea580c; --s3:#0d9488; --s4:#d97706; --s5:#ec4899; --s6:#16a34a; --s7:#8b5cf6; --s8:#ef4444; } }
`;

export const HISTORY_CSS = `
  /* ── the history view ────────────────────────────────────────────────────────────────
     Three charts, each in the berth's frame: a hairline and a caption in the page's grey, so
     the loud thing in the frame is the data. A laptop gets the context across the top and the
     two account-wide charts side by side under it; the phone block stacks them, one chart to
     a screen. */
  .view-history { display:grid; grid-template-columns:1fr 1fr; gap:1rem; align-items:start; }
  #ctx, .hist-off, .hist-empty, .view-history > .note { grid-column:1 / -1; }
  .view-history > .note { margin-top:0; }
  .chart { border:1px solid var(--line); border-radius:12px; padding:.65rem .8rem .7rem; min-width:0; }
  /* The margin is what the way-back-to-now's tap target is drawn into. That overlay reaches
     .85rem below the button, and anything of it past this margin lands on the canvas and
     swallows taps meant for the top of the plot. The two numbers are the same on purpose. */
  .chart-head { display:flex; align-items:baseline; gap:.3rem .6rem; flex-wrap:wrap; margin-bottom:.85rem; }
  .chart-name { font-size:.72rem; font-weight:700; letter-spacing:.07em; text-transform:uppercase; color:var(--dim); }
  .chart-sub { color:var(--dim); font-size:.78rem; }
  /* The minute under the reader's finger takes the subtitle's place, in the page's ink: the
     numbers on the card are then about THAT minute, and the words beside them say so. */
  .chart-sub.at { color:var(--fg); font-weight:600; font-variant-numeric:tabular-nums; }
  /* The one number a chart leads with, in the gauge's weight. Never a hero: the fleet is
     the subject, this is its total. */
  .chart-stat { margin-left:auto; font-variant-numeric:tabular-nums; font-weight:650; font-size:.9rem; white-space:nowrap; }
  .to-now { font:inherit; font-size:.72rem; font-weight:600; color:var(--fg); background:transparent;
            border:1px solid var(--line); border-radius:99px; padding:.02rem .6rem; cursor:pointer; }
  /* pan-y rather than none: a drag along the chart moves the cursor, and a drag up the page
     still scrolls it. Taking both would trap a reader inside a canvas that fills their screen. */
  .chart canvas { display:block; width:100%; touch-action:pan-y; }
  /* The legend is the second half of every chart here, and on the cost chart it IS the
     answer: sorted by what each project spent, top first. Buttons, because a tap on a key
     isolates its series. Under a tapped minute the values are that minute's.

     The row gap is not taste: a key is a target, its overlay reaches half of 44px above and
     below it, and two rows closer together than that overlap — a tap meant for one project
     isolating the one beneath it. The key's own padding plus this gap is the sum that
     test/phone-view adds up. */
  .legend:not([hidden]) { display:grid; grid-template-columns:repeat(auto-fill,minmax(9.6rem,1fr)); gap:1rem .7rem; margin-top:.45rem; }
  .key { display:flex; align-items:center; gap:.45rem; font:inherit; font-size:.8rem; color:var(--fg);
         background:transparent; border:0; border-radius:6px; padding:.3rem .3rem; text-align:left; cursor:pointer; min-width:0; }
  /* k- on all four, and the prefix is not decoration. This sheet is one flat namespace: the
     map's dial centre is a bare .val { position:absolute; inset:0 }, and a legend value wearing
     that name was laid out absolutely over the whole key, name and swatch under it. Every rule
     read correctly on its own and the browser resolved them against each other. */
  .key .k-sw { width:.7rem; height:.7rem; border-radius:2px; flex:none; }
  .key .k-ln { width:1rem; height:2px; border-radius:1px; flex:none; }
  .key .k-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .key .k-val { font-variant-numeric:tabular-nums; color:var(--dim); white-space:nowrap; }
  .key.up .k-val, .legend.at .key .k-val { color:var(--fg); font-weight:600; }
  .key[aria-pressed="true"] { background:color-mix(in srgb, var(--line) 45%, transparent); }
  .legend.muted .key:not([aria-pressed="true"]) { opacity:.45; }
  /* The range, in the scrubber's clothes: a name for the pills, pills sized for a thumb, and
     beside them the sentence saying where each range comes from and how much of it exists.
     Last in the markup, because that is the only place a sticky bottom offset does anything:
     it shifts a box UP to the foot of the viewport and holds it there until its own place in
     the flow catches up, so a bar that is already above the fold is never moved at all. A
     laptop has no thumb and puts the controls above what they change, which is the one thing
     on this page order is spent on besides the table's line break. */
  .hist-range { order:-1; grid-column:1 / -1; display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
  .hist-range .range-name { font-size:.7rem; font-weight:700; letter-spacing:.07em; text-transform:uppercase; color:var(--dim); margin-right:.2rem; }
  .hist-range button { font:inherit; font-size:.8rem; color:var(--fg); background:transparent; border:1px solid var(--line);
            border-radius:99px; padding:.15rem .8rem; cursor:pointer; font-variant-numeric:tabular-nums; }
  .hist-range button[aria-pressed="true"] { font-weight:600; background:color-mix(in srgb, var(--line) 55%, transparent); border-color:var(--dim); }
  .hist-range button:disabled { opacity:.4; cursor:default; }
  .hist-range .covers { color:var(--dim); font-size:.75rem; margin-left:.4rem; }
  /* Off is not a fault, so it is not a .warn: a framed sentence in the page's own ink, with
     the one key that turns it on. */
  .hist-off { border:1px solid var(--line); border-radius:8px; padding:.5rem .7rem; font-size:.8rem; line-height:1.5; }
  /* Same frame as "off" above, and for the same reason: a serve that has been running a minute
     is not a fault either. It sits directly over the charts it is about, because "where are my
     curves" is a question asked while looking at the place they will be. */
  .hist-empty { border:1px solid var(--line); border-radius:8px; padding:.5rem .7rem; font-size:.8rem; line-height:1.5; }
  .hist-off code, .hist-empty code, .view-history .note code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.95em; }
  /* The other two views are in the shell on every address — the tabs between them are meant to
     cost nothing — so the one being read hides the pair it stands in front of. History is the
     exception and ships only on its own address: it carries a script and three canvases, and a
     reader on the table has no use for either. */
  body[data-view="history"] .view-table, body[data-view="history"] .view-map { display:none; }
  /* No scrubber here, ever: the record this view draws IS the past, and a second control
     saying so would be two pasts on one page. */
  body[data-view="history"] #replay, body[data-view="history"] #replay-view { display:none; }
`;

/**
 * The phone's half, kept OUT of a media block of its own.
 *
 * `map-view` and `phone-view` read the phone's rules by finding `@media (max-width: 46rem)` and
 * balancing its braces, which answers with the first one in the sheet — so a second block is a
 * place for a rule to hide from every test that looks. This is spliced into the one that
 * already exists, like the coarse-pointer rules below it.
 */
export const HISTORY_PHONE_CSS = `
    /* One chart to a screen. align-items goes back to stretch with it: the grid above sets
       start, which on a column is the CROSS axis — every chart shrink-wrapped to its own
       caption, in a column down the left of the phone. */
    .view-history { display:flex; flex-direction:column; align-items:stretch; }
    /* Back where the markup put it, which is where the sticky rule below can reach it. */
    .hist-range { order:0; }
    .hist-range .covers { flex-basis:100%; margin-left:0; }
    /* Pinned under the thumb for the same reason the scrubber is: the charts it changes are
       several screens tall, and a range switched blind is a chart nobody sees change.
       Opaque and above what passes under it, or the charts scroll through the pills changing
       them. The negative margin gives it the page's own gutters back, so the bar reaches the
       edges of the phone. */
    .view-history .hist-range { position:sticky; bottom:0; z-index:3; background:var(--bg);
         border-top:1px solid var(--line); padding:.55rem .75rem .7rem; margin:.2rem -.75rem 0; }
`;

/**
 * The finger's half of the sheet, kept beside the page's own coarse-pointer block.
 *
 * Same bargain as the tabs: the TAPPABLE box grows to 44px and the drawn one does not, through
 * an overlay that exists only where the pointer is coarse. The keys get a smaller inset than
 * the pills because they are stacked in a grid two columns wide — at the pills' .7rem two rows
 * of keys overlap, and a tap meant for one project isolates the one below it.
 */
export const HISTORY_TOUCH_CSS = `
    .hist-range button::after { content:''; position:absolute; inset:-.7rem 0; }
    .to-now::after { content:''; position:absolute; inset:-.85rem 0; }
    .key::after { content:''; position:absolute; inset:-.5rem 0; }
`;

// ── the markup ───────────────────────────────────────────────────────────────────────────

export interface HistoryViewOptions {
  /** Whether `history.days` is set, which the SERVER knows and the page would have to ask for. */
  historyEnabled: boolean;
}

const chart = (id: string, name: string, sub: string): string =>
  `<section class="chart" id="${id}" role="group" aria-label="${name}">
    <div class="chart-head"><span class="chart-name">${name}</span><span class="chart-sub" id="${id}-sub">${sub}</span><span class="chart-stat" id="${id}-stat"></span><button type="button" class="to-now" id="${id}-now" hidden>Back to now</button></div>
    <canvas id="${id}-canvas" aria-label="${name} chart, tap to read a value"></canvas>
    <div class="legend" id="${id}-legend"></div>
  </section>`;

/**
 * The view, rendered by the server like the two beside it.
 *
 * Whether there is a journal is a fact about the config, and the config is the server's — so
 * the sentence about it and the two disabled pills are in the markup rather than written by a
 * script after a round trip. A reader with no journal never sees a range flicker from live to
 * refused, and a browser with no JavaScript still gets told why the page is empty.
 */
export function renderHistoryView({ historyEnabled }: HistoryViewOptions): string {
  const off = !historyEnabled;
  return `<div class="view view-history">
${
  off
    ? `  <div class="hist-off" id="hist-off" role="status"><strong>History is off.</strong> The last 24h live in memory while <code>tarmac serve</code> runs and go when it stops; nothing is written to disk. To keep 7 and 30 days, add <code>{"history": {"days": 30}}</code> to <code>~/.claude/tarmac/config.json</code> and start <code>serve</code> again.</div>\n`
    : ''
}  <div class="hist-empty" id="hist-empty" role="status" hidden><strong>Nothing recorded yet.</strong> <code>tarmac serve</code> reads the fleet once a minute, so the context lines start within a minute or two, the cost bars fill an hour at a time, and the quota curve needs a few readings before it has a shape. Leave the serve running and come back. To see all three full right now, without waiting: <code>tarmac serve --demo</code>.</div>
${chart('ctx', 'Context', 'per session &middot; 24h')}
${chart('cost', 'Cost', 'per project &middot; hourly &middot; 24h')}
${chart('quota', 'Quota', 'account &middot; 24h')}
  <p class="note">Recorded once a minute, only while <code>tarmac serve</code> runs. A minute it was not running is a minute with no reading, drawn as a gap and never as a zero. A session recycled overnight comes back as a new line from its first frame.${
    off ? '' : ' The journal keeps the same fields as the ring, no names and no paths.'
  }</p>
  <div class="hist-range" role="group" aria-label="range">
    <span class="range-name">Range</span>
    <button type="button" id="range-24h" data-range="24h" aria-pressed="true">24h</button>
    <button type="button" id="range-7d" data-range="7d" aria-pressed="false"${off ? ' disabled' : ''}>7d</button>
    <button type="button" id="range-30d" data-range="30d" aria-pressed="false"${off ? ' disabled' : ''}>30d</button>
    <div class="covers" id="hist-covers">${
      off
        ? '24h from memory &middot; 7d and 30d need the journal, which is off'
        : '24h from memory &middot; 7d and 30d from the journal on disk'
    }</div>
  </div>
</div>`;
}

// ── the script ───────────────────────────────────────────────────────────────────────────

/** How tall each chart is drawn, phone and laptop. Canvas has no intrinsic height to inherit. */
const HEIGHTS = { ctx24: [270, 300], ctxRows: [330, 340], cost: [250, 280], quota: [210, 280] };

/**
 * The browser's half: the transforms above, verbatim, and the pixels that read them.
 *
 * `String` rather than a copy kept in step by hand. The suite calls `decimate` and the page
 * runs the same characters — under type stripping here, after `tsc` in the published output —
 * so a rule that changes in one place cannot go on being true in the other. Nothing in `PURE`
 * may close over anything this function does not also emit: the constants below are that list.
 */
export function historyScript(): string {
  return `
(function () {
  var INTERACTIVE = ${JSON.stringify(INTERACTIVE)};
  var SLOTS = ${SLOTS}, RESET_WATCHED_MS = ${RESET_WATCHED_MS}, MIN = ${MIN}, HOUR = ${HOUR};
  var H = ${JSON.stringify(HEIGHTS)};
  var DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

${PURE.map((fn) => String(fn)).join('\n\n')}

  // ── the page around them ────────────────────────────────────────────────────────────
  var ids = ['ctx', 'cost', 'quota'], RANGES = ['24h', '7d', '30d'];
  var el = function (id) { return document.getElementById(id); };
  var covers = el('hist-covers');
  // What the SERVER wrote about the ring, kept rather than written again here. It is one of
  // two sentences depending on whether there is a journal at all, which is the config's answer
  // and not this page's — and a copy of both, kept in step by hand, is how the two come to
  // disagree.
  var covers24 = covers.textContent;
  var state = { range: '24h', data: null, err: null, iso: {}, cursor: {}, loading: false, gen: 0 };
  // Which series a chart is isolated on, or null. Read through a function and compared against
  // null rather than tested for truth: path.basename('/') is the empty string, so a project
  // really can be named '', and a falsy key is a key that isolates nothing while its own button
  // says it is pressed.
  var isoOf = function (id) { var v = state.iso[id]; return v === undefined ? null : v; };

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hhmm(t) { var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function dayWord(t) { var d = new Date(t); return DOW[d.getDay()] + ' ' + d.getDate(); }
  function monWord(t) { var d = new Date(t); return MON[d.getMonth()] + ' ' + d.getDate(); }
  function money(v) { return '$' + v.toFixed(2); }
  function startOfDay(t) { var d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
  // The next local midnight, which is 23, 24 or 25 hours along. Calendar arithmetic, never
  // 24-hour blocks: history-range walks the day files by this rule and the axis under them has
  // to walk by the same one. Stepped by 86400000 instead, the morning a clock falls back lands
  // back inside the day it just left — an eighth tick in a week of seven, the same name twice,
  // and every column after it labelled with the day before.
  function nextDay(t) { var d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime(); }
  function cssVar(name) {
    if (typeof getComputedStyle !== 'function' || !document.documentElement) return '#888';
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  }
  function slotColor(slot) { return cssVar('--s' + slot); }
  var ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) { return String(v === null || v === undefined ? '\\u2014' : v).replace(/[&<>"']/g, function (c) { return ENT[c]; }); }
  var PHONE = typeof matchMedia === 'function' ? matchMedia('(max-width: 46rem)') : { matches: false };
  var DARK = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : { matches: false };
  var fill = function () { return fillAlpha(!!DARK.matches); };
  var phone = function () { return !!PHONE.matches; };
  function height(kind) { return H[kind][phone() ? 0 : 1]; }

  // ── the ink ─────────────────────────────────────────────────────────────────────────
  var FONT = 'ui-sans-serif, -apple-system, "Segoe UI", sans-serif';
  function setup(canvas, h) {
    var dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    var w = canvas.clientWidth || 360;
    canvas.style.height = h + 'px';
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    var c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { c: c, w: w, h: h, fg: cssVar('--fg'), dim: cssVar('--dim'), line: cssVar('--line'), bg: cssVar('--bg') };
  }
  function plotBox(g) { return { l: 8, r: g.w - 8, t: 12, b: g.h - 18 }; }
  function hair(g, x1, y1, x2, y2, color, alpha) {
    g.c.save(); g.c.globalAlpha = alpha == null ? 1 : alpha; g.c.strokeStyle = color; g.c.lineWidth = 1;
    g.c.beginPath(); g.c.moveTo(Math.round(x1) + .5, Math.round(y1) + .5); g.c.lineTo(Math.round(x2) + .5, Math.round(y2) + .5); g.c.stroke(); g.c.restore();
  }
  function label(g, text, x, y, o) {
    o = o || {};
    g.c.save(); g.c.font = (o.weight || 400) + ' ' + (o.size || 10) + 'px ' + FONT; g.c.textAlign = o.align || 'left'; g.c.textBaseline = 'alphabetic';
    // A halo of the page's own background, so a label crossing a line is still readable
    // without a filled box hiding the data under it.
    if (o.halo !== false) { g.c.lineWidth = 3; g.c.strokeStyle = g.bg; g.c.lineJoin = 'round'; g.c.strokeText(text, x, y); }
    g.c.fillStyle = o.color || g.dim; g.c.fillText(text, x, y); g.c.restore();
  }
  function pctGrid(g, b) {
    [0, 25, 50, 75, 100].forEach(function (v) {
      var y = b.b - (v / 100) * (b.b - b.t); hair(g, b.l, y, b.r, y, g.line);
      if (v === 50 || v === 100) label(g, v + '%', b.l + 2, y - 3);
    });
  }
  function timeTicks(g, b, t0, t1, range) {
    var ticks = [], x, d;
    if (t1 <= t0) t1 = t0 + 1;
    if (range === '24h') {
      var t = new Date(t0); t.setMinutes(0, 0, 0);
      for (x = t.getTime(); x <= t1; x += HOUR) if (new Date(x).getHours() % 6 === 0 && x >= t0) ticks.push({ t: x, text: hhmm(x) });
    } else if (range === '7d') {
      // The name is centred over the day, so it is given the day's own width rather than a flat
      // twenty-four hours: the column a clock changed in is an hour wider or narrower than the
      // six beside it, and a centre measured off the wrong width sits in its neighbour.
      for (d = startOfDay(t0); d < t1; d = nextDay(d)) if (d >= t0) ticks.push({ t: d, text: dayWord(d), center: nextDay(d) - d });
    } else {
      for (d = startOfDay(t0); d < t1; d = nextDay(d)) if (d >= t0 && new Date(d).getDate() % 5 === 0) ticks.push({ t: d, text: monWord(d) });
    }
    ticks.forEach(function (tk) {
      var xx = b.l + ((tk.t - t0) / (t1 - t0)) * (b.r - b.l);
      hair(g, xx, b.b, xx, b.b + 3, g.dim, .8);
      if (tk.center) {
        var x2 = Math.min(b.r, b.l + ((tk.t + tk.center - t0) / (t1 - t0)) * (b.r - b.l));
        label(g, tk.text, (xx + x2) / 2, b.b + 13, { align: 'center', halo: false });
      } else label(g, tk.text, xx, b.b + 13, { align: tk.t === t0 ? 'left' : 'center', halo: false });
    });
    hair(g, b.l, b.b, b.r, b.b, g.dim, .6);
  }
  function dot(g, x, y, color, r) {
    g.c.save(); g.c.beginPath(); g.c.arc(x, y, (r || 4) + 2, 0, 7); g.c.fillStyle = g.bg; g.c.fill();
    g.c.beginPath(); g.c.arc(x, y, r || 4, 0, 7); g.c.fillStyle = color; g.c.fill(); g.c.restore();
  }
  // The pen lifts at every gap, which is what makes a recycle a break and not a cliff.
  function polyline(g, s, b, t0, t1, yOf) {
    var dec = decimate(s.v, Math.max(2, b.r - b.l)), v = dec.v, pen = false, end = null;
    var span = t1 - t0 || 1;
    g.c.beginPath();
    for (var i = 0; i < v.length; i++) {
      if (v[i] === null) { pen = false; continue; }
      var x = b.l + ((i * dec.step * s.step) / span) * (b.r - b.l), y = yOf(v[i]);
      if (!pen) { g.c.moveTo(x, y); pen = true; } else g.c.lineTo(x, y);
      end = { x: x, y: y };
    }
    g.c.stroke(); return end;
  }
  function xOf(b, cur) { return b.l + cur * (b.r - b.l); }

  // ── the head and the legend ─────────────────────────────────────────────────────────
  function head(id, sub, stat, tapped) {
    var s = el(id + '-sub');
    s.textContent = sub;
    s.classList.toggle('at', !!tapped);
    el(id + '-stat').textContent = stat;
    el(id + '-now').hidden = !tapped;
  }
  // innerHTML and one delegated listener, like the replay's map next door: a legend rebuilt
  // node by node is a second DOM dialect in one page for no gain.
  function legend(id, items, tapped) {
    var box = el(id + '-legend'), html = '';
    box.hidden = false;
    box.classList.toggle('muted', isoOf(id) !== null);
    box.classList.toggle('at', !!tapped);
    items.forEach(function (it) {
      var key = it.id === undefined ? String(it.name) : it.id;
      html += '<button type="button" class="key' + (it.up ? ' up' : '') + '" data-key="' + esc(key) + '"'
        + ' aria-pressed="' + (state.iso[id] === key ? 'true' : 'false') + '">'
        + (it.line ? '<i class="k-ln"' : '<i class="k-sw"') + ' aria-hidden="true" style="background:' + esc(it.color) + '"></i>'
        + '<span class="k-name">' + esc(it.name) + '</span>'
        + '<span class="k-val">' + esc(it.v) + '</span></button>';
    });
    box.innerHTML = html;
  }

  // ── the three charts ────────────────────────────────────────────────────────────────
  function roster() {
    var names = [], d = state.data, i, j;
    if (!d) return [];
    if (d.samples) for (i = 0; i < d.samples.length; i++) for (j = 0; j < d.samples[i].sessions.length; j++) names.push(d.samples[i].sessions[j].project);
    if (d.hours) for (i = 0; i < d.hours.length; i++) for (j = 0; j < d.hours[i].sessions.length; j++) names.push(d.hours[i].sessions[j].project);
    if (d.days) for (i = 0; i < d.days.length; i++) for (j = 0; j < d.days[i].byProject.length; j++) names.push(d.days[i].byProject[j].project);
    return rosterOf(names);
  }

  function drawCtx() {
    var d = state.data, r = roster(), live = state.range === '24h';
    var series = live ? ctxLines(d.samples, d.cadence || MIN, r) : ctxRows(d.hours, r);
    if (series.length === 0) return blank('ctx', live ? 'per session · 24h' : 'per session · hour max · ' + state.range);
    var g = setup(el('ctx-canvas'), height(live ? 'ctx24' : 'ctxRows')), b = plotBox(g);
    var t0 = series[0].t0, t1 = t0 + (series[0].v.length - 1) * series[0].step;
    var cur = state.cursor.ctx, idx = cur == null ? null : Math.round(cur * (series[0].v.length - 1));
    var iso = isoOf('ctx'), climbing = 0, i;
    for (i = 0; i < series.length; i++) if (rising(series[i])) climbing++;
    if (live) {
      var yOf = function (v) { return b.b - (v / 100) * (b.b - b.t); }, ends = [];
      pctGrid(g, b); timeTicks(g, b, t0, t1, state.range);
      // Climbing last, so the lines the reader came for are drawn over the rest of the fleet.
      series.slice().sort(function (a, c) { return (rising(a) ? 1 : 0) - (rising(c) ? 1 : 0); }).forEach(function (s) {
        var up = rising(s), on = iso !== null ? iso === String(s.name) : up, color = slotColor(s.slot);
        g.c.save(); g.c.strokeStyle = color; g.c.lineWidth = on ? 2 : 1.5; g.c.globalAlpha = on ? 1 : (iso !== null ? .2 : .45);
        g.c.lineJoin = 'round'; g.c.lineCap = 'round';
        var end = polyline(g, s, b, t0, t1, yOf); g.c.restore();
        if (end) ends.push({ s: s, x: end.x, y: end.y, v: lastOf(s.v), on: on });
      });
      ends.forEach(function (e) { g.c.save(); g.c.globalAlpha = e.on ? 1 : .45; dot(g, e.x, e.y, slotColor(e.s.slot), e.on ? 4 : 3); g.c.restore(); });
      var prevY = -99;
      ends.filter(function (e) { return e.on; }).sort(function (a, c) { return a.y - c.y; }).forEach(function (e) {
        var y = Math.max(e.y - 7, prevY + 12, b.t + 8);
        label(g, (e.s.name === null ? '—' : e.s.name) + ' ' + Math.round(e.v) + '%', b.r - 12, y, { align: 'right', weight: 600, size: 11, color: g.fg });
        prevY = y;
      });
      if (idx !== null) {
        var x = xOf(b, cur); hair(g, x, b.t, x, b.b, g.fg, .5);
        series.forEach(function (s) { if (s.v[idx] !== null) dot(g, x, yOf(s.v[idx]), slotColor(s.slot), 3.5); });
      }
      head('ctx', idx === null ? 'per session · 24h' : hhmm(t0 + idx * series[0].step), climbing ? climbing + ' climbing' : 'nothing climbing', idx !== null);
      var pct = function (v) { return v === null ? '—' : Math.round(v) + '%'; };
      // Under a tapped minute the number is that minute's, and it is the highest any of the
      // project's lines was reading then: the same reduction the week's chart makes an hour at
      // a time, so the two ranges do not answer the same question two ways.
      var atMinute = {};
      if (idx !== null) series.forEach(function (s) {
        var v = s.v[idx], key = String(s.name);
        if (v !== null && (atMinute[key] === undefined || atMinute[key] === null || v > atMinute[key])) atMinute[key] = v;
      });
      legend('ctx', ctxKeys(series).map(function (kk) {
        var v = idx === null ? kk.v : (atMinute[String(kk.name)] === undefined ? null : atMinute[String(kk.name)]);
        return { name: kk.name === null ? '—' : kk.name, line: true, color: slotColor(kk.slot),
                 v: pct(v) + (idx === null && kk.up ? ' ↑' : ''), up: kk.up };
      }), idx !== null);
    } else {
      // Eight lines on one plot over a month is a wall. One band per project instead, each on
      // its own 0–100 scale with its name and its last reading on it, so no legend is needed.
      var n = series.length, rowH = (b.b - b.t) / n;
      timeTicks(g, b, t0, t1, state.range);
      series.forEach(function (s, i2) {
        var top = b.t + i2 * rowH, base = top + rowH - 2, up = rising(s), color = slotColor(s.slot);
        var rowY = function (v) { return base - (v / 100) * (rowH - 12); };
        hair(g, b.l, base, b.r, base, g.line);
        g.c.save(); g.c.strokeStyle = color; g.c.lineWidth = up ? 2 : 1.5; g.c.lineJoin = 'round'; g.c.lineCap = 'round';
        var end = polyline(g, s, b, t0, t1, rowY); g.c.restore();
        if (end) dot(g, end.x, end.y, color, up ? 3.5 : 2.5);
        label(g, s.name === null ? '—' : s.name, b.l + 2, top + 9, { size: 9.5 });
        var v = idx === null ? lastOf(s.v) : s.v[idx];
        label(g, (v === null ? '—' : Math.round(v) + '%') + (idx === null && up ? ' ↑' : ''), b.r - 2, top + 9, { align: 'right', size: 10, weight: 600, color: g.fg });
        if (idx !== null && s.v[idx] !== null) dot(g, xOf(b, cur), rowY(s.v[idx]), color, 3);
      });
      if (idx !== null) { var x2 = xOf(b, cur); hair(g, x2, b.t, x2, b.b, g.fg, .5); }
      head('ctx', idx === null ? 'per session · hour max · ' + state.range : dayWord(t0 + idx * HOUR) + ' ' + hhmm(t0 + idx * HOUR),
           climbing ? climbing + ' climbing' : 'nothing climbing', idx !== null);
      el('ctx-legend').hidden = true;
    }
  }

  function drawCost() {
    var d = state.data, r = roster(), live = state.range === '24h';
    var cost = live ? costHourly(d.samples, r) : costDaily(d.days, r);
    var buckets = cost.buckets, n = buckets.length;
    if (n === 0) return blank('cost', 'per project · ' + (live ? 'hourly · 24h' : 'daily · ' + state.range));
    var g = setup(el('cost-canvas'), height('cost')), b = plotBox(g);
    var totals = buckets.map(function (bk) { return bk.by.reduce(function (a, v) { return a + v; }, 0); });
    var max = Math.max.apply(null, totals) || 1;
    var stepC = [.5, 1, 2, 5, 10, 20, 50, 100, 250, 1000].filter(function (s) { return max / s <= 4; })[0] || 1000;
    var ymax = Math.ceil((max * 1.08) / stepC) * stepC || stepC;
    for (var v = 0; v <= ymax; v += stepC) {
      var y = b.b - (v / ymax) * (b.b - b.t); hair(g, b.l, y, b.r, y, g.line);
      if (v > 0) label(g, '$' + (v < 1 ? v.toFixed(1) : v), b.l + 2, y - 3);
    }
    var slotW = (b.r - b.l) / n, barW = Math.min(24, slotW * .72);
    var cur = state.cursor.cost, iso = isoOf('cost');
    var sel = cur == null ? null : Math.min(n - 1, Math.floor(cur * n));
    buckets.forEach(function (bk, i) {
      var x = b.l + i * slotW + (slotW - barW) / 2, acc = 0, yTop = b.b, top = -1;
      bk.by.forEach(function (val, k) { if (val > 0) top = k; });
      bk.by.forEach(function (val, k) {
        if (val <= 0) return;
        var hgt = (val / ymax) * (b.b - b.t), y0 = b.b - (acc * (b.b - b.t)) / ymax, y1 = y0 - hgt; acc += val;
        var faded = (sel !== null && sel !== i) || (iso !== null && iso !== String(cost.projects[k].name));
        var gap = hgt > 3 ? 1 : 0, yy0 = y0 - gap, yy1 = y1 + gap; if (yy0 - yy1 < 1) yy1 = yy0 - 1;
        g.c.save(); g.c.globalAlpha = (faded ? .3 : 1) * fill(); g.c.fillStyle = slotColor(cost.projects[k].slot);
        if (k === top && hgt > 5) {
          var rr = Math.min(4, barW / 2);
          g.c.beginPath(); g.c.moveTo(x, yy0); g.c.lineTo(x, yy1 + rr); g.c.arcTo(x, yy1, x + rr, yy1, rr);
          g.c.lineTo(x + barW - rr, yy1); g.c.arcTo(x + barW, yy1, x + barW, yy1 + rr, rr); g.c.lineTo(x + barW, yy0); g.c.closePath(); g.c.fill();
        } else g.c.fillRect(x, yy1, barW, yy0 - yy1);
        g.c.restore(); yTop = y1;
      });
      // The column's own total on its cap, only where a week of them has the room.
      if (n <= 7 && totals[i] > 0) label(g, '$' + totals[i].toFixed(totals[i] >= 100 ? 0 : 1), x + barW / 2, yTop - 5, { align: 'center', color: g.fg, weight: 600 });
    });
    timeTicks(g, b, buckets[0].t, buckets[n - 1].t + buckets[n - 1].span, state.range);
    var total = totals.reduce(function (a, v) { return a + v; }, 0);
    var keys = legendByCost(cost), bk2 = sel === null ? null : buckets[sel];
    // A bucket nobody read is not a bucket that cost nothing. The bars already draw it as the
    // gap it is; under a tap it has to say so in words too, or the one place the number is
    // spelled out is the one place it reads as a measurement.
    var read = sel === null || buckets[sel].n > 0;
    head('cost', sel === null
      ? 'per project · ' + (live ? 'hourly · 24h' : 'daily · ' + state.range)
      : (live ? hhmm(bk2.t) + '–' + hhmm(bk2.t + HOUR) : dayWord(bk2.t)),
      read ? money(sel === null ? total : totals[sel]) : 'no reading', sel !== null);
    legend('cost', keys.map(function (kk) {
      return { name: kk.name === null ? '—' : kk.name, line: false, color: slotColor(kk.slot),
               v: sel !== null ? (read ? money(bk2.by[kk.k]) : '—')
                 : kk.total === null ? '—'
                 : '$' + Math.round(kk.total) + (total > 0 ? ' · ' + Math.round((100 * kk.total) / total) + '%' : '') };
    }), sel !== null);
  }

  function drawQuota() {
    var d = state.data, live = state.range === '24h';
    var q = live ? quotaOfSamples(d.samples, d.cadence || MIN) : quotaOfHours(d.hours, d.resets);
    var n = q.five.length;
    if (n === 0) return blank('quota', 'account · ' + state.range);
    var g = setup(el('quota-canvas'), height('quota')), b = plotBox(g);
    var t0 = q.t0, t1 = t0 + (n - 1) * q.step;
    var yOf = function (v) { return b.b - (v / 100) * (b.b - b.t); };
    var xAt = function (t) { return b.l + ((t - t0) / (t1 - t0 || 1)) * (b.r - b.l); };
    var iso = isoOf('quota'), a5 = iso !== null && iso !== '5h' ? .25 : 1, a7 = iso !== null && iso !== '7d' ? .25 : 1;
    pctGrid(g, b); timeTicks(g, b, t0, t1, state.range);
    // The seven-day turnover is the event of the week and gets a full line with its name. The
    // five-hour one does not: there are five a day, so a week is thirty lines and a month a
    // hundred and fifty — a picket fence over the chart, each one labelled the same thing. It
    // is drawn instead as what it already is, the right edge of a window in the skyline below.
    //
    // One the serve watched happen is a firm line; one it slept through is faint and says
    // "about" — the marker sits where the RECORD resumed, not where the window rolled, and a
    // firm line there would be a lie about a moment nobody measured.
    q.resets.forEach(function (rs) {
      if (rs.limit !== 'seven_day') return;
      var x = xAt(rs.t);
      hair(g, x, b.t, x, b.b, g.dim, rs.watched ? .8 : .3);
      // The name is dropped at a month, where four of them say it four times over. The tilde is
      // not: a marker the serve did not watch happen is dated where the record resumed, and that
      // qualifier is exactly the thing a month of them must not lose.
      // Beside its own line, and never off the plot: a window that turned over in the last hour
      // of the range draws its line against the right edge, and three pixels further right is
      // where the whole name renders as its first letter. Nine-point sans runs about five
      // pixels a character, which is close enough to keep the last one whole without measuring
      // text the page has not laid out yet.
      var name = state.range !== '30d' ? '7d reset' + (rs.watched ? '' : ' ≈') : rs.watched ? '' : '≈';
      if (name !== '') label(g, name, Math.min(x + 3, b.r - (name.length * 5 + 2)), b.t + 8, { size: 9, halo: false });
    });
    if (live) {
      // One closed shape per run of readings, and never one shape over the lot: skipping a
      // null without lifting the pen draws a floor straight across a minute nobody read, under
      // a line that correctly shows the hole.
      g.c.save(); g.c.globalAlpha = a5 * .1; g.c.fillStyle = g.dim;
      var run = -1;
      for (var i = 0; i <= n; i++) {
        var here = i < n ? q.five[i] : null;
        if (here !== null) { if (run < 0) { run = i; g.c.beginPath(); g.c.moveTo(xAt(t0 + i * q.step), b.b); } g.c.lineTo(xAt(t0 + i * q.step), yOf(here)); continue; }
        if (run < 0) continue;
        g.c.lineTo(xAt(t0 + (i - 1) * q.step), b.b); g.c.closePath(); g.c.fill(); run = -1;
      }
      g.c.restore();
      g.c.save(); g.c.globalAlpha = a5; g.c.strokeStyle = g.dim; g.c.lineWidth = 2; g.c.lineJoin = 'round';
      polyline(g, { v: q.five, step: q.step }, b, t0, t1, yOf); g.c.restore();
    } else {
      // A hundred and fifty sawtooth windows in a month is a wall: each window is drawn as
      // its own high instead, a bar as wide as the window, its right edge the reset.
      var bounds = [t0], w;
      for (w = 0; w < q.resets.length; w++) if (q.resets[w].limit === 'five_hour') bounds.push(q.resets[w].t);
      bounds.push(t1);
      for (w = 0; w < bounds.length - 1; w++) {
        var i0 = Math.round((bounds[w] - t0) / q.step), i1 = Math.round((bounds[w + 1] - t0) / q.step), peak = null;
        // The hour a window turns over in belongs to BOTH windows, ten minutes to the one that
        // ended and fifty to the one that started, and the figure recorded for it is the hour's
        // MAXIMUM, which is the old window's high. So it is left with the window that ended and
        // taken off the one that began: counted in both, the pre-reset high was drawn again as
        // the bar of a window that never reached it, an account shown near its ceiling for five
        // hours it spent nowhere near it. What the new window did in the rest of that hour is
        // not separable from what the old one did, so it is not claimed for either.
        var from = w > 0 ? i0 + 1 : i0;
        for (var k = from; k <= i1 && k < n; k++) if (k >= 0 && q.five[k] !== null && (peak === null || q.five[k] > peak)) peak = q.five[k];
        if (peak === null) continue;
        var x0 = xAt(bounds[w]), x1 = xAt(bounds[w + 1]);
        g.c.save(); g.c.globalAlpha = a5 * .4 * fill(); g.c.fillStyle = g.dim; g.c.fillRect(x0 + .5, yOf(peak), Math.max(1, x1 - x0 - 1), b.b - yOf(peak)); g.c.restore();
      }
    }
    g.c.save(); g.c.globalAlpha = a7; g.c.strokeStyle = g.fg; g.c.lineWidth = 2; g.c.lineJoin = 'round';
    polyline(g, { v: q.seven, step: q.step }, b, t0, t1, yOf); g.c.restore();
    var e5 = lastOf(q.five), e7 = lastOf(q.seven);
    if (e5 !== null && live) dot(g, b.r, yOf(e5), g.dim);
    if (e7 !== null) dot(g, b.r, yOf(e7), g.fg);
    var cur = state.cursor.quota, idx = cur == null ? null : Math.round(cur * (n - 1));
    if (idx !== null) {
      var x3 = xOf(b, cur); hair(g, x3, b.t, x3, b.b, g.fg, .5);
      if (live && q.five[idx] !== null) dot(g, x3, yOf(q.five[idx]), g.dim, 3.5);
      if (q.seven[idx] !== null) dot(g, x3, yOf(q.seven[idx]), g.fg, 3.5);
    }
    var v5 = idx === null ? e5 : q.five[idx], v7 = idx === null ? e7 : q.seven[idx];
    // Floored, like the header's gauges (readLimits): 87.9 printed as 88 beside a gauge
    // saying 87 is one page disagreeing with itself about one minute.
    var say = function (v) { return v === null ? '—' : Math.floor(v) + '%'; };
    var at = idx === null ? null : t0 + idx * q.step;
    head('quota', idx === null ? 'account · ' + state.range : (live ? hhmm(at) : dayWord(at) + ' ' + hhmm(at)),
         '5h ' + say(v5) + ' · 7d ' + say(v7), idx !== null);
    legend('quota', [
      { name: live ? '5h window' : '5h window highs', id: '5h', line: live, color: g.dim, v: idx === null ? '' : say(v5) },
      { name: '7d window', id: '7d', line: true, color: g.fg, v: idx === null ? '' : say(v7) }
    ], idx !== null);
  }

  /** A chart with nothing to draw says so, rather than showing an empty frame. */
  function blank(id, sub) {
    var g = setup(el(id + '-canvas'), 64), b = plotBox(g);
    // "No readings in this range" is a verdict, and a range still being read has not earned one.
    var why = state.loading ? 'reading ' + state.range + '…' : state.err || 'no readings in this range';
    label(g, why, (b.l + b.r) / 2, (b.t + b.b) / 2, { align: 'center', size: 12 });
    head(id, sub, '', false);
    el(id + '-legend').hidden = true;
  }

  /*
   * Whether this is a serve with nothing recorded yet, which is what a first run is (#151).
   *
   * The ring only. An empty 7d is a journal that was not running for a week, and this block's
   * answer, wait a minute and the lines will come, is not true of that. The canvas goes on
   * saying "no readings in this range" there, which is the honest verdict.
   *
   * Neither loading nor an error counts: both are states in which nothing has been read yet,
   * and a block raised over a request still in flight would be answering a question the
   * record is about to answer itself. Same rule the blank canvas applies one function up.
   */
  function firstRun() {
    if (state.range !== '24h' || state.loading || state.err !== null) return false;
    return !state.data || !state.data.samples || state.data.samples.length === 0;
  }

  var draw = { ctx: drawCtx, cost: drawCost, quota: drawQuota };
  function redraw() {
    covers.textContent = coversText();
    el('hist-empty').hidden = !firstRun();
    if (!state.data) { ids.forEach(function (id) { blank(id, state.range); }); return; }
    ids.forEach(function (id) { draw[id](); });
  }

  // ── the reader's hand ───────────────────────────────────────────────────────────────
  ids.forEach(function (id) {
    var canvas = el(id + '-canvas'), down = false;
    var at = function (ev) {
      var r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, width: canvas.clientWidth || 360 };
      return Math.max(0, Math.min(1, (ev.clientX - r.left - 8) / ((r.width || 360) - 16)));
    };
    // A tap, not a hover: there is no pointer on a phone to hover with, and the cursor stays
    // where the finger left it so the numbers beside it can be read after letting go.
    canvas.addEventListener('pointerdown', function (ev) { down = true; state.cursor[id] = at(ev); redraw(); });
    canvas.addEventListener('pointermove', function (ev) { if (down) { state.cursor[id] = at(ev); redraw(); } });
    canvas.addEventListener('pointerup', function () { down = false; });
    canvas.addEventListener('pointercancel', function () { down = false; });
    el(id + '-now').addEventListener('click', function () { state.cursor[id] = null; redraw(); });
    el(id + '-legend').addEventListener('click', function (ev) {
      var t = ev && ev.target, key = null;
      while (t && key === null) { if (t.getAttribute) key = t.getAttribute('data-key'); t = t.parentNode; }
      if (key === null) return;
      state.iso[id] = isoOf(id) === key ? null : key;
      redraw();
    });
  });

  // ── the range ───────────────────────────────────────────────────────────────────────
  function coversText() {
    var d = state.data;
    // Ahead of everything else. The charts draw a reason on a canvas, which is ink nobody can
    // select, search or hear read out; this line is the only prose under the pills, and a page
    // that answered nothing while still printing where its ranges come from would be stating a
    // provenance for data it does not have.
    if (state.err !== null) return state.err;
    if (state.loading) return 'reading ' + state.range + '…';
    if (state.range === '24h') return covers24;
    if (!d || !d.coverage) return state.range + ' from the journal';
    var c = d.coverage, said = state.range + ' from the journal · ' + d.days.length + ' of ' + c.daysRequested + ' days on disk';
    // Said once and quietly: a journal that stopped at its cap, and readings the reader could
    // not use. Neither is a fault to shout about, and both change what the charts above mean.
    if (c.capped) said += ' · journal capped';
    if (c.skipped > 0 || c.droppedSessions > 0) said += ' · ' + (c.skipped + c.droppedSessions) + ' unreadable';
    return said;
  }

  function setRange(r) {
    var btn = el('range-' + r);
    if (btn.disabled) return;
    // The payload goes with the range, in the same statement. Held while the next one is in
    // flight, it is a week's answer being read by a month's branch: hours where days are
    // expected, and the first property lookup throws and takes the whole view down for as long
    // as the read takes. A month of files is documented as being read a file at a time, so that
    // is not a window measured in microseconds, and a resize or a finger is all it takes.
    state.range = r; state.data = null; state.err = null; state.loading = true;
    state.cursor = {}; state.iso = {};
    RANGES.forEach(function (x) { el('range-' + x).setAttribute('aria-pressed', x === r ? 'true' : 'false'); });
    redraw();
    load();
  }

  function load() {
    var mine = ++state.gen, url = state.range === '24h' ? '/api/history' : '/api/history?range=' + state.range;
    state.err = null; state.loading = true;
    return fetch(url, { cache: 'no-store' }).then(function (res) {
      // The same refusal the fleet poll makes: loopback proves where bytes came from, not who
      // wrote them, and what comes back is parsed and drawn into this page.
      if (!res.headers.get('X-Tarmac')) throw new Error('The answer on this port did not come from tarmac.');
      return res.text().then(function (body) {
        if (!res.ok) throw new Error(body.split('\\n').filter(Boolean).join(' ').slice(0, 200));
        var got = JSON.parse(body);
        if (mine !== state.gen) return;
        state.loading = false;
        // Off is not an empty week. The server said so at render time and the pills are
        // already refused; this is the same answer arriving the other way.
        if (got && got.enabled === false) { state.data = null; state.err = 'history is off — set history.days to keep more than 24h'; }
        else { state.data = got; }
        covers.textContent = coversText();
        redraw();
      });
    }).catch(function (e) {
      if (mine !== state.gen) return;
      state.loading = false;
      state.data = null;
      state.err = String((e && e.message) || e).slice(0, 200);
      covers.textContent = coversText();
      redraw();
    });
  }

  RANGES.forEach(function (r) { el('range-' + r).addEventListener('click', function () { setRange(r); }); });
  if (typeof addEventListener === 'function') addEventListener('resize', redraw);
  if (PHONE.addEventListener) PHONE.addEventListener('change', redraw);
  if (DARK.addEventListener) DARK.addEventListener('change', redraw);
  load();
})();
`;
}
