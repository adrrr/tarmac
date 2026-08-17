// P3 — the join. Two contractual sources, one row per live session.
//
//   `claude agents --json`  → who exists, and whether it is busy   (the spine)
//   statusline snapshots    → context, model, effort, cost         (the flesh)
//
// The session list is the spine on purpose: a snapshot outlives its session (a recycled
// fleet leaves seven dead files behind), so a snapshot with no live session is a ghost and
// is dropped. The reverse — a session with no snapshot — is a real state and stays visible,
// with telemetry marked `absent` rather than zeroed.
//
// `now` is a parameter, never `Date.now()` inside: a suite whose fixtures are absolute and
// whose clock floats dies quietly the day it crosses a threshold.

import path from 'node:path';
import { DEFAULT_STALE_AFTER_MS } from './config.ts';
import { guardVersions } from './schema.ts';
import { isWaiting } from './sessions.ts';
import { SID_NAME } from './wrapper.ts';
import type { SchemaGuard } from './schema.ts';
import type { DiscoveryHealth, Session } from './sessions.ts';
import type { CtxState, Snapshot } from './snapshots.ts';

/** `absent` is the state of a live session no statusline ever wrote for. */
export type RowCtxState = CtxState | 'absent';

export interface FleetRow {
  sessionId: string | null;
  name: string | null;
  project: string | null;
  cwd: string | null;
  pid: number | null;
  /**
   * `interactive` for a terminal someone is sitting at, and whatever `claude agents --json`
   * calls the background sessions it also prints. Unknown to this module on purpose: it is
   * carried, never interpreted, and the map is the only reader that treats one differently.
   */
  kind: string | null;
  status: string | null;
  /** The reason a `waiting` session gives, carried for the two surfaces that caption it. */
  waitingFor: string | null;
  busy: boolean | null;
  uptimeMs: number | null;
  ctxState: RowCtxState;
  ctxPct: number | null;
  ctxTokens: number | null;
  ctxWindow: number | null;
  model: string | null;
  effort: string | null;
  costUsd: number | null;
  snapshotAgeMs: number | null;
  stale: boolean;
  rateLimits: Record<string, any> | null;
}

export interface FleetHealth {
  sessions: number;
  covered: number;
  /**
   * Live sessions whose id is not a shape the wrapper files a snapshot under, so their
   * telemetry is not late — it is never coming. Counted apart from `covered` because the
   * two states differ only in what the user should do about them.
   */
  unfilable: number;
  drift: number;
  stale: number;
  discovered: number;
  noSessionId: number;
  schemaBroken: boolean;
  unknownStatus: number;
  busy: number;
  costUsd: number | null;
  /** How many rows really carried a cost — the denominator the total must be read against. */
  costReporting: number;
  /** Whether the Claude Code writing to this fleet is one whose payloads we have ever seen. */
  schemaGuard: SchemaGuard;
  /**
   * The threshold `stale` was decided with. It travels with the data so every renderer names
   * the SAME one the rows were judged against — a `!` explained by a number the renderer
   * happened to keep for itself would be explained by the wrong number the day it moved.
   */
  staleAfterMs: number;
  generatedAt: number;
  // Filled in by the collector, which is the layer that knows where it read from.
  snapshotsError?: string | null;
  snapshotsUnreadable?: number;
  snapshotsDuplicates?: number;
  snapshotsDir?: string;
}

export interface Fleet {
  rows: FleetRow[];
  health: FleetHealth;
}

export interface BuildFleetInput {
  sessions: Session[];
  snapshots: Map<string, Snapshot>;
  now: number;
  staleAfterMs?: number;
  discovery?: DiscoveryHealth | null;
}

export function buildFleet({
  sessions,
  snapshots,
  now,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  discovery = null,
}: BuildFleetInput): Fleet {
  const rows: FleetRow[] = sessions.map((s) => {
    const t = (s.sessionId && snapshots.get(s.sessionId)) || null;
    return {
      sessionId: s.sessionId,
      name: s.name,
      project: s.cwd ? path.basename(s.cwd) : null,
      cwd: s.cwd,
      pid: s.pid,
      kind: s.kind,
      status: s.status,
      waitingFor: s.waitingFor,
      busy: s.busy,
      uptimeMs: typeof s.startedAt === 'number' ? now - s.startedAt : null,
      ctxState: t ? t.ctxState : 'absent',
      ctxPct: t ? t.ctxPct : null,
      ctxTokens: t ? t.ctxTokens : null,
      ctxWindow: t ? t.ctxWindow : null,
      model: t ? t.model : null,
      effort: t ? t.effort : null,
      costUsd: t ? t.costUsd : null,
      snapshotAgeMs: t ? t.ageMs : null,
      stale: t ? t.ageMs > staleAfterMs : false,
      rateLimits: t ? t.rateLimits : null,
    };
  });

  rows.sort((a, b) => rank(a) - rank(b) || (b.ctxPct ?? -1) - (a.ctxPct ?? -1));

  const covered = rows.filter((r) => r.ctxState !== 'absent').length;
  // Blind AND unfilable, in that order — this number exists to say how many of the blind will
  // stay blind, and both renderers subtract it from them. A session can be unfilable and
  // covered at the same time: a snapshot written by a pre-upgrade wrapper under a non-UUID
  // name is still READ, because the reader keys on the `session_id` inside the file rather
  // than on the filename. Counting that one would push this past the blind count and make the
  // renderers explain away someone else's missing telemetry.
  // A null id is `noSessionId`'s business — a discovery failure, not a naming one.
  const unfilable = rows.filter(
    (r) => r.ctxState === 'absent' && r.sessionId !== null && !SID_NAME.test(r.sessionId),
  ).length;
  const drift = rows.filter((r) => r.ctxState === 'drift').length;
  // Having a snapshot and having a cost are different facts, and only the second one is
  // allowed to feed the total.
  const costs = rows.map((r) => r.costUsd).filter((c): c is number => typeof c === 'number');
  // Versions from the LIVE snapshots only — the same `sessions`-is-the-spine rule as
  // everything else here. A recycled fleet leaves dead files behind, and a dead session's
  // Claude Code is not the one running now.
  const ccVersions = sessions
    .map((s) => (s.sessionId ? snapshots.get(s.sessionId) : undefined))
    .filter((t): t is Snapshot => t !== undefined)
    .map((t) => t.ccVersion);

  return {
    rows,
    health: {
      sessions: rows.length,
      covered,
      unfilable,
      drift,
      stale: rows.filter((r) => r.stale).length,
      // Discovery's own blind spots. Dropping them turns a renamed `sessionId` into the
      // cheerful "No Claude Code sessions found" — the exact lie the module forbids.
      discovered: discovery?.seen ?? rows.length,
      noSessionId: discovery?.noSessionId ?? 0,
      // All the telemetry we DO have is drifting: that is a schema change, not a hiccup.
      // Tested tolerance from the fleet: `fresh` never counts, or a recycled fleet would
      // raise this every single night.
      schemaBroken: covered > 0 && drift === covered,
      // Recomputed from the rows rather than taken from `discovery`, which may be null — so
      // the exemption the reader grants a waiting session has to be granted again here, or
      // the banner accuses a session both surfaces are drawing as waiting.
      unknownStatus: rows.filter((r) => r.busy === null && !isWaiting(r)).length,
      busy: rows.filter((r) => r.busy === true).length,
      // A sum over 3 of 7 sessions is not the fleet's cost. Same rule as `sumUsage` one
      // layer down: add only what is really a number, and count those — a payload with no
      // `cost` key used to contribute a confident 0 while counting as covered, which made a
      // partial sum print as a complete one. Null when nothing was measured; the renderers
      // qualify the total with `costReporting` whenever it is partial.
      costUsd: costs.length === 0 ? null : round2(costs.reduce((sum, c) => sum + c, 0)),
      costReporting: costs.length,
      schemaGuard: guardVersions(ccVersions),
      staleAfterMs,
      generatedAt: now,
    },
  };
}

/**
 * How many sessions are working RIGHT NOW while looking at a reading that has gone cold, on a
 * fleet where not one reading is fresh — and `0` whenever that whole picture does not hold.
 *
 * It exists because `health.stale` on its own is not news (#53). A statusline is written when
 * a terminal draws a frame, so a session that idles overnight keeps yesterday's number and
 * "N readings are stale" is what a resting fleet LOOKS like — the steady state, said again on
 * every poll. The rows and the map nodes already date each reading one by one; a page-wide
 * banner repeating it is wallpaper, and a warning nobody can ever act on trains the reader to
 * skip the ones they can.
 *
 * What is not the steady state is this shape:
 *
 *   • not one reading anywhere is fresh — so nothing is writing, rather than some sessions
 *     resting. A single fresh reading is proof the writer works, and ends the question.
 *   • and at least one of those cold readings belongs to a session that is BUSY. A busy
 *     session redraws its status line constantly, so its snapshot should be seconds old. Cold
 *     is the wrapper gone, the snapshot directory unwritable, a disk full — the writer, not
 *     the fleet.
 *
 * Both halves are needed. Busy-and-cold beside a fresh reading is one session's business — a
 * terminal in a tmux window nobody has selected draws no frames while its session works, so
 * its reading ages exactly like an idle one; everything cold with nobody busy is just the
 * night.
 *
 * Readings only — a session with no snapshot has nothing that could have gone cold, and is the
 * coverage warning's.
 *
 * Known window, and the reason there is no floor under it: a session that has just been given
 * something to do is `busy` on the spine before its first frame lands, so a fleet waking from
 * a quiet night can raise this for one poll. A grace period would be a second threshold
 * nobody set, and the honest reading of that moment is that the newest reading on the machine
 * is still hours old.
 */
export function busyOnStaleFleet(rows: FleetRow[]): number {
  // Every dated snapshot, INCLUDING one dated after the clock that read it. That is the whole
  // handling of clock skew here, and it is deliberate: such a reading is never `stale` (a
  // negative age is not greater than any threshold), so leaving it in the denominator makes
  // `every` below fail and the verdict come to nothing — which is the answer we want. A
  // snapshot the filesystem dates in the future may have been written a second ago, and that
  // is the one fact that would prove the writer is alive, so it must not be filtered into
  // silence. Excluding it was the first cut, and it let the page print "every context reading
  // is stale" directly above its own warning naming the reading that was not.
  //
  // Not the same call `accountLimits` below makes, which refuses a skewed reading so it cannot
  // WIN on freshness. The question there is which reading is youngest; here it is whether
  // anything wrote at all, and for that an unreadable date must not be allowed to accuse.
  const readings = rows.filter((r) => r.snapshotAgeMs !== null);
  // A fleet with no readings needs no clause of its own: nothing is what `every` is vacuously
  // true of, and nothing is also what the count below comes to.
  if (!readings.every((r) => r.stale)) return 0;
  // Strictly `true`: `null` is "tarmac cannot read this session's status", and a session that
  // may or may not be working is not evidence that anything stopped.
  return readings.filter((r) => r.busy === true).length;
}

export interface AccountReading {
  rateLimits: Record<string, any>;
  /**
   * How old the snapshot that carried them is. It travels because the reading is exactly as old
   * as that snapshot, while anything computed from a reset epoch is as young as the clock doing
   * the arithmetic — and a percentage frozen forty minutes ago beside a countdown that ticks
   * every five seconds is the page contradicting itself in one line.
   */
  ageMs: number;
}

/**
 * The account's rate limits, as this fleet's sessions report them.
 *
 * They belong to the ACCOUNT and not to any one session, but they arrive per snapshot — so the
 * rows do not carry contradicting numbers, they carry the same number at different ages, and
 * the youngest is the one still true. Same rule as everything else in this module: the freshest
 * reading wins.
 *
 * A snapshot dated AFTER the clock that read it is refused rather than believed, which is the
 * verdict `map.ts` reaches on the same value: an NTP correction or a mount whose time runs
 * ahead does not produce a small age, it produces something that is not an age at all — and
 * being negative it would beat every real reading for as long as the skew lasts.
 *
 * Here rather than in either of its readers: the ring samples it every minute and the page's
 * header draws it, and two copies of "which session's word counts" is two answers about one
 * account the day either one is touched.
 */
export function accountLimits(rows: FleetRow[]): AccountReading | null {
  let freshest: AccountReading | null = null;
  for (const r of rows) {
    if (r.rateLimits === null || r.snapshotAgeMs === null || r.snapshotAgeMs < 0) continue;
    if (freshest === null || r.snapshotAgeMs < freshest.ageMs) {
      freshest = { rateLimits: r.rateLimits, ageMs: r.snapshotAgeMs };
    }
  }
  return freshest;
}

// Blocked on a human first, then busy, then unknown (it might be busy), then idle.
//
// Waiting leads because it is the only rank that is work for the reader: everything below it
// is the fleet reporting on itself, while a waiting session has STOPPED and will not start
// again until someone answers it. Ranking it by how busy it is — the question the rest of this
// sort asks — is what filed it with `unknown`, one bucket under a fleet that is mostly busy,
// which on the map is under the fold. It costs the ranks below it almost nothing: a fleet has
// one or two of these at a time, so busy moves down a row or two, and losing sight of a busy
// session for a poll is not a thing that can go wrong. Losing sight of a waiting one is.
const rank = (r: FleetRow): number =>
  isWaiting(r) ? 0 : r.busy === true ? 1 : r.busy === null ? 2 : 3;
const round2 = (n: number): number => Math.round(n * 100) / 100;
