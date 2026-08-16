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

/** Both windows, always — a window that could not be read is a gauge that says so. */
export function readLimits(rateLimits: Record<string, any> | null | undefined, now: number): Gauge[] {
  // `rate_limits: []` and `rate_limits: "none"` are legal JSON and not a pair of windows.
  // Neither may reach the lookup below as something to index.
  const ok = rateLimits !== null && typeof rateLimits === 'object' && !Array.isArray(rateLimits);
  return LIMIT_WINDOWS.map(({ key, label, said }) => {
    const w = ok ? (rateLimits as Record<string, any>)[key] : undefined;
    const has = w !== null && typeof w === 'object' && !Array.isArray(w) && 'used_percentage' in w;
    const v = has ? w.used_percentage : undefined;
    // Present and null: a window whose number has not been taken yet. Absent, or holding
    // something that is not a percentage: the shape moved. The discriminant is the key.
    const pct = has && typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.floor(v) : null;
    const why: LimitWhy | null = pct !== null ? null : rateLimits == null || (has && v === null) ? 'absent' : 'drift';
    const at = has && typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? w.resets_at : null;
    return { key, label, said, pct, why, resetsInMs: at === null ? null : at * 1000 - now };
  });
}
