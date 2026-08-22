// P3 — the account's two windows.
//
// Every session on the page spends from the same two allowances, so they belong to the page
// and not to a node: five hours, and seven days. The statusline payload carries both, as a
// used percentage and the epoch each one rolls over at.
//
// This module reads a shape someone else versions, which is why it reads it the way
// `snapshots.ts` reads the context window: the PRESENCE of a key says whether a number was
// ever taken, and the value says what it was. A key that is gone, or holding something that is
// not a percentage, is a schema that moved — and neither one is 0%. There is exactly one thing
// a dashboard must never do with an account's limits, and that is report a window it could not
// read as a window with room to spare.
//
// The reset is turned into a stretch of time HERE, against the clock the reading was taken
// with, so that no renderer has to go and find a clock of its own: the live page subtracts from
// the moment it read the fleet, and a replay subtracts from the minute its sample was taken.
// Both then have one rule about what a negative answer means.

/** Which kind of missing a missing percentage is — the same two words for both windows. */
export type LimitWhy = 'absent' | 'drift';

export interface Gauge {
  /** The window's key in the payload, and the one thing here that is not ours to rename. */
  key: string;
  /** What the header prints beside the number. */
  label: string;
  /** The same window, spelled out for a reader who is hearing the page rather than seeing it. */
  said: string;
  /** The used percentage, or `null` when there is none to show. Never 0 for "unknown". */
  pct: number | null;
  /** Why there is no percentage, and `null` when there is one. */
  why: LimitWhy | null;
  /**
   * How long the window has left, out of the clock it was read with. Negative once the reset
   * is behind that clock — a real state, and the sign is the only thing that says the
   * percentage above it belongs to a window that has since rolled over.
   */
  resetsInMs: number | null;
}

/**
 * The two windows, in the order they are read. A table rather than two hand-written branches:
 * the page script draws the same pair in the browser for a replayed minute, and it is handed
 * this list rather than keeping a second copy of the vocabulary.
 */
export const LIMIT_WINDOWS: ReadonlyArray<{ key: string; label: string; said: string }> = [
  { key: 'five_hour', label: '5h', said: 'five-hour window' },
  { key: 'seven_day', label: '7d', said: 'seven-day window' },
];

/**
 * How far from the reading a reset may land and still be one.
 *
 * The same discipline the percentage gets, one field over: `used_percentage` outside 0-100 is
 * refused rather than drawn, and a `resets_at` outside a plausible distance is refused for the
 * same reason. The longest window here is seven days, so nothing this account resets at is more
 * than eight away — while the two ways this field can move are both far outside that: the same
 * number in milliseconds lands fifty thousand years out, and `0`, the sentinel an unset field so
 * often is, lands in 1970. Both were rendered with a straight face ("resets in 19656250d").
 */
export const RESET_HORIZON_MS = 8 * 24 * 3600 * 1000;

/** Both windows, always — a window that could not be read is a gauge that says so. */
export function readLimits(rateLimits: Record<string, any> | null | undefined, now: number): Gauge[] {
  return LIMIT_WINDOWS.map(({ key, label, said }) => {
    const w = windowAt(rateLimits, key);
    const has = w !== undefined && 'used_percentage' in w;
    const v = w?.used_percentage;
    // Present and null: a window whose number has not been taken yet. Absent, or holding
    // something that is not a percentage: the shape moved. The discriminant is the key.
    const pct = has && typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.floor(v) : null;
    const why: LimitWhy | null = pct !== null ? null : rateLimits == null || (has && v === null) ? 'absent' : 'drift';
    const at = has ? resetOf(w) : null;
    const resetsInMs = at === null ? null : at * 1000 - now;
    return {
      key,
      label,
      said,
      pct,
      why,
      resetsInMs: resetsInMs === null || Math.abs(resetsInMs) > RESET_HORIZON_MS ? null : resetsInMs,
    };
  });
}

/**
 * The windows two readings of the account describe DIFFERENTLY, by key, in the order above —
 * meaning two windows that are BOTH still open at `now` and are not the same window.
 *
 * A fleet holds one reading per session and only one of them can be drawn, so the question is
 * what the others were. It is settled on the reset and not the percentage: `resets_at` is where
 * a window ENDS, so two readings naming the same one are two ages of a single allowance — the
 * freshest is the one still true, and the age beside it says the rest. Percentages that differ
 * under one reset are that same number caught at two frames, the normal state of a fleet, and
 * warning about it would be a warning on every poll.
 *
 * The openness test is the other half, and without it this cries wolf every five hours. A
 * session that idles keeps the frame it last drew, and the five-hour window rolls over four or
 * five times a day: an overnight snapshot names the window it was taken in, which has since
 * ended. That is not two accounts, it is one reading being old — a fact the fleet already
 * prints, as that row's age and as the `!` beside it — so a window whose boundary is behind
 * `now` is left out of the comparison rather than raised as a disagreement.
 *
 * What survives both rules is the thing nothing else on either surface can say: two windows
 * open AT THE SAME TIME, which one allowance cannot have. Whether that is two accounts signed
 * in at once or something stranger is published nowhere tarmac reads, so this reports that the
 * readings are apart and never why.
 *
 * A reading that dates no window is not a reading that dates one differently: an absent
 * boundary is compared with nothing, exactly as an absent percentage is drawn as nothing. And
 * a boundary further out than `RESET_HORIZON_MS` is refused here as it is refused a countdown —
 * a reset fifty thousand years away is not a window this account is in.
 *
 * Known blind spot, and the reason it is left open: two accounts whose windows happen to end at
 * the same second read as one here, and their percentages then differ in silence. The only
 * thing that would catch it is treating a percentage as evidence — and the shape that takes is
 * "the fresher reading is lower than the older one", which cannot be true of one allowance and
 * would be a false alarm the day a number is ever revised downward. A missed collision costs a
 * warning nobody sees; the other rule costs a warning nobody can act on, on a fleet where
 * nothing is wrong.
 */
export function windowsApart(
  a: Record<string, any> | null | undefined,
  b: Record<string, any> | null | undefined,
  now: number,
): string[] {
  const apart: string[] = [];
  for (const { key } of LIMIT_WINDOWS) {
    const at = openBoundary(windowAt(a, key), now);
    const bt = openBoundary(windowAt(b, key), now);
    if (at !== null && bt !== null && at !== bt) apart.push(key);
  }
  return apart;
}

/** Whether this reading yielded a number for either window — a reading that measured something. */
export const measured = (rateLimits: Record<string, any> | null | undefined, now: number): boolean =>
  readLimits(rateLimits, now).some((g) => g.pct !== null);

/**
 * The epoch a window rolls over at, when that window is still OPEN at `now` — and `null` for
 * one that has already rolled over, one nothing dates, and one dated beyond the horizon.
 */
function openBoundary(w: Record<string, any> | undefined, now: number): number | null {
  const at = resetOf(w);
  if (at === null) return null;
  const inMs = at * 1000 - now;
  return inMs > 0 && inMs <= RESET_HORIZON_MS ? at : null;
}

/**
 * The window filed under `key`, or `undefined` when the payload carries nothing usable there.
 *
 * `rate_limits: []` and `rate_limits: "none"` are legal JSON and not a pair of windows, and
 * neither may reach an index or a property read as something to look inside.
 */
function windowAt(rateLimits: Record<string, any> | null | undefined, key: string): Record<string, any> | undefined {
  if (rateLimits === null || rateLimits === undefined || typeof rateLimits !== 'object' || Array.isArray(rateLimits)) return undefined;
  const w = rateLimits[key];
  return w !== null && typeof w === 'object' && !Array.isArray(w) ? w : undefined;
}

/** The epoch a window rolls over at, or `null` when this reading does not name one. */
const resetOf = (w: Record<string, any> | undefined): number | null =>
  w !== undefined && typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? w.resets_at : null;
