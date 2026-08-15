// P3 — reading the telemetry the wrapper dropped.
//
// The snapshot is a verbatim copy of Claude Code's own statusLine payload, so this module
// reads a DOCUMENTED shape — no transcript resummation, no window size hardcoded, no regex
// over terminal pixels.
//
// The one rule everything else leans on: "no value" is never rendered as 0. `ctxPct: null`
// means "not measured"; a 0 could only ever mean "measured at 0". And "not measured" has
// two opposite causes that must not be confused:
//   fresh — the key is present and null: a session that has taken no turn yet. Normal,
//           transient, true of a whole fleet for a few minutes after a nightly recycle.
//   drift — the key is gone or changed type: a Claude Code release moved the schema and
//           the context reading of the entire fleet just died, snapshots still flowing.
// The discriminant is the PRESENCE of the key, never its value.

import fs from 'node:fs';
import path from 'node:path';

/**
 * The statusline payload is external, versioned by someone else, and the whole point of
 * this module is to interrogate a shape that may have moved. Typing it as anything firmer
 * than "some JSON object" would let the compiler assert what only the runtime guards below
 * can actually establish.
 */
type Payload = Record<string, any>;

export type CtxState = 'ok' | 'fresh' | 'drift';

export interface Telemetry {
  sessionId: string | null;
  ctxState: CtxState;
  ctxPct: number | null;
  ctxTokens: number | null;
  ctxWindow: number | null;
  model: string | null;
  modelId: string | null;
  effort: string | null;
  costUsd: number | null;
  ccVersion: string | null;
  rateLimits: Record<string, any> | null;
}

/** A telemetry reading plus where it came from and how old it is. */
export interface Snapshot extends Telemetry {
  ageMs: number;
  file: string;
}

export interface ReadSnapshotsResult {
  snapshots: Map<string, Snapshot>;
  dirError: string | null;
  unreadable: number;
  /**
   * How many files claimed a session id another file had already claimed. `preferred` below
   * decides which one is shown, and the count travels: a silent `Map.set` would let readdir
   * order decide, with nothing on screen saying a choice was ever made.
   */
  duplicates: number;
  /**
   * The directory is not there. Whether that is innocent depends on who chose it, which is
   * knowledge this layer does not have — so it reports the fact and lets the caller judge.
   */
  dirMissing: boolean;
}

export function extractTelemetry(payload: unknown): Telemetry {
  const p = payload as Payload | null | undefined;
  const cw = p?.context_window;
  let ctxState: CtxState = 'drift';
  let ctxPct: number | null = null;

  if (cw && typeof cw === 'object' && !Array.isArray(cw) && 'used_percentage' in cw) {
    const v = cw.used_percentage;
    if (v === null) ctxState = 'fresh';
    // A number by TYPE is not yet a percentage. `1e999` is legal JSON and parses to
    // `Infinity`, which printed as "Infinity%" in the terminal and as a bar clamped to 100%
    // on the page; a negative one reached that bar as `width:-3%`, an element that renders as
    // nothing at all beside a confident "-3%". Both are values no reading can have, so they
    // are treated as what they are — a shape that moved — rather than shown to anyone.
    else if (Number.isFinite(v) && v >= 0 && v <= 100) {
      ctxState = 'ok';
      ctxPct = Math.floor(v);
    }
  }

  // Same rule as above, one level down: sum only what is really a number, and return null
  // when NONE of the four expected keys is one. Coercing absent keys to 0 would turn a
  // renamed schema into a confident `ctxTokens: 0` sitting next to a healthy `ctxState`.
  const ctxTokens = sumUsage(cw?.current_usage);

  return {
    sessionId: str(p?.session_id),
    ctxState,
    ctxPct,
    ctxTokens,
    ctxWindow: typeof cw?.context_window_size === 'number' ? cw.context_window_size : null,
    model: str(p?.model?.display_name),
    modelId: str(p?.model?.id),
    effort: str(p?.effort?.level),
    costUsd: typeof p?.cost?.total_cost_usd === 'number' ? p.cost.total_cost_usd : null,
    ccVersion: str(p?.version),
    rateLimits: p?.rate_limits && typeof p.rate_limits === 'object' ? p.rate_limits : null,
  };
}

const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];

function sumUsage(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  let sum = 0;
  let seen = false;
  for (const k of USAGE_KEYS) {
    const v = (usage as Payload)[k];
    if (typeof v === 'number') {
      sum += v;
      seen = true;
    }
  }
  return seen ? sum : null;
}

/**
 * Read-only sweep of a snapshot directory, keyed by the session id found INSIDE each
 * payload. `now` is an argument so tests can pin the clock.
 *
 * "Nothing there" and "I was not allowed to look" must not answer alike: the first is a
 * fleet that has not been chained yet, the second is a permission bug that would otherwise
 * render as "0/7 chained — run tarmac install", blaming the user for our own blindness.
 */
export function readSnapshots(dir: string, { now = Date.now() }: { now?: number } = {}): ReadSnapshotsResult {
  const snapshots = new Map<string, Snapshot>();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      snapshots,
      dirError: code === 'ENOENT' ? null : `${code}: ${dir}`,
      unreadable: 0,
      duplicates: 0,
      dirMissing: code === 'ENOENT',
    };
  }

  let unreadable = 0;
  let duplicates = 0;
  for (const name of entries) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const file = path.join(dir, name);
    let payload: unknown;
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
      payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // ENOENT: a name listed a moment ago that resolves to nothing now. Almost always the
      // sweep, deleting a cold snapshot out of the very directory we are reading — its job,
      // and a race with our own housekeeping rather than a payload we failed to parse.
      // Counting it made tarmac drive its own format-drift warning (up to 2675 phantom
      // unreadable on one read of a 20k directory, and `list --watch` and `serve` redraw
      // often enough to be inside that window).
      //
      // The cost, said out loud: `statSync` follows symlinks, so a DANGLING one named like a
      // snapshot is ENOENT too, and it goes silent forever — a permanent state skipped as if
      // it were a passing race. Deliberate. There is no payload behind a dead link either,
      // and telling the two apart (an `lstat` first) buys a warning about a file `ls` already
      // shows. Note it is the opposite call from `reap.ts:75`, which lstats PRECISELY so a
      // dead link is not ENOENT: it deletes, and `unlink` takes a link away just fine. Reader
      // and reaper ask different questions of the same shape.
      //
      // ENOENT only. A file we were not ALLOWED to open still counts, and must.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        unreadable += 1; // corrupt, half-written or unreadable: skip, but never forget
      continue;
    }
    const t = extractTelemetry(payload);
    if (!t.sessionId) {
      unreadable += 1;
      continue;
    }
    const snapshot: Snapshot = { ...t, ageMs: Math.round(now - mtimeMs), file };
    const already = snapshots.get(t.sessionId);
    if (already) duplicates += 1;
    snapshots.set(t.sessionId, already ? preferred(already, snapshot) : snapshot);
  }
  return { snapshots, dirError: null, unreadable, duplicates, dirMissing: false };
}

/**
 * Which of two snapshots claiming one session a reader is shown.
 *
 * Freshest first — but "freshest" decides nothing when the two carry the same mtime, and
 * that is precisely the case this rule exists for: `cp -p`, `rsync -a` and `tar -x` all
 * preserve mtime, so a snapshot copied between directories arrives as a perfect twin. The
 * loser of a tie was then whichever one readdir happened to hand over first — an order no
 * filesystem promises (ext4 with dir_index and APFS both answer in hash order), so the SAME
 * two files could show a different number on two machines, silently.
 *
 * The filename breaks the tie because it is the only thing left that both files carry and
 * neither shares. Which one it picks matters far less than that it picks the same one every
 * time, everywhere.
 */
export const preferred = (a: Snapshot, b: Snapshot): Snapshot =>
  a.ageMs !== b.ageMs ? (a.ageMs < b.ageMs ? a : b) : a.file <= b.file ? a : b;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
