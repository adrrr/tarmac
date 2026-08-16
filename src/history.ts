// P5 — what the serve already read, kept for a day.
//
// The dashboard reads the whole fleet on every request and forgets it on the next one, so a
// number that moved is a number nobody can point at afterwards. This is that reading, held.
//
// In memory and nowhere else, by design. A fleet journal on disk is the one file this tool
// promised never to write — it would outlive the process that made it, sit in someone's home
// carrying session ids, working directories and costs, and turn "tarmac reads, it does not
// keep" into a sentence with an asterisk. What a serve remembers therefore starts when that
// serve started, which is exactly what `since` says out loud.
//
// The ring is bounded before it is anything else: a serve is left open for days, and one
// sample a minute for a day is a size, while "everything since Tuesday" is a leak with a
// nicer name.

import { stateOf } from './map.ts';
import type { NodeState } from './map.ts';
import type { Fleet, FleetRow, RowCtxState } from './fleet.ts';

/** One sample a minute. Not a setting: see `HISTORY_SLOTS`. */
export const HISTORY_CADENCE_MS = 60_000;

/**
 * 24 hours of them. One minute and one day are the product — a cadence knob would let a
 * reader ask this process to spawn `claude agents --json` every second, and a retention knob
 * would let them ask it to hold a week of fleets in RAM. A page that needs to say what it
 * covers reads `since`.
 */
export const HISTORY_SLOTS = 1440;

/** A session as a replay needs it: what it was, how full it was, what it had cost. */
export interface HistorySession {
  sid: string | null;
  project: string | null;
  kind: string | null;
  /**
   * The same three words the map draws, out of the same function. A replay that reached its
   * own verdict about a session would be a second opinion on a fact the live view already
   * states, and the two would disagree the day either one changed.
   */
  state: NodeState;
  ctxState: RowCtxState;
  ctxPct: number | null;
  costUsd: number | null;
}

export interface HistorySample {
  /** When the fleet was read — the reading's own clock, not the timer's. */
  t: number;
  sessions: HistorySession[];
  /** The account's, as the payload carries them. */
  rateLimits: Record<string, any> | null;
}

export interface HistoryPayload {
  since: number;
  cadence: number;
  samples: HistorySample[];
  /** Slots a reading was due for and never filled. A gap that says so is not a gap. */
  missed: number;
}

export interface FleetHistory {
  record(fleet: Fleet): void;
  miss(): void;
  read(): HistoryPayload;
}

export interface HistoryOptions {
  /** When this serve started keeping the record. */
  since: number;
  cadence: number;
}

export function createHistory({ since, cadence }: HistoryOptions): FleetHistory {
  const samples: HistorySample[] = [];
  let missed = 0;

  return {
    record(fleet: Fleet): void {
      samples.push(sampleOf(fleet));
      // Trimmed on the way in and never on the way out: the array's own length is the
      // guarantee, so no reader has to be told the ring is bounded for it to be true.
      if (samples.length > HISTORY_SLOTS) samples.splice(0, samples.length - HISTORY_SLOTS);
    },
    miss(): void {
      missed++;
    },
    // A copy: this ring is the only one there is, and no file to rebuild it from. A reader
    // that spliced what it was handed would edit the record itself.
    read: (): HistoryPayload => ({ since, cadence, samples: [...samples], missed }),
  };
}

/**
 * A fleet reading, reduced to what a replay reads back.
 *
 * The names are the omission that matters, and it is not an oversight to be commented — it is
 * pinned by a test. `claude agents --json` names a background session after the PROMPT it was
 * given, so a fleet's names are a record of what its agents were told to do. The live view may
 * show that, because someone is looking at their own screen in the present tense; a day of
 * them, retained by a process and served back on a route, is a different object. No name for
 * anyone, so there is no rule about kinds to get wrong later.
 */
function sampleOf({ rows, health }: Fleet): HistorySample {
  return {
    t: health.generatedAt,
    sessions: rows.map((r) => ({
      sid: r.sessionId,
      project: r.project,
      kind: r.kind,
      state: stateOf(r),
      ctxState: r.ctxState,
      ctxPct: r.ctxPct,
      costUsd: r.costUsd,
    })),
    rateLimits: rateLimitsOf(rows),
  };
}

/**
 * One account, read at whatever moment each session last drew a frame — so the rows do not
 * carry contradicting numbers, they carry the same number at different ages, and the youngest
 * is the one still true. A row with no snapshot has no age and cannot be the youngest.
 */
function rateLimitsOf(rows: FleetRow[]): Record<string, any> | null {
  let freshest: FleetRow | null = null;
  for (const r of rows) {
    if (r.rateLimits === null) continue;
    if (freshest === null || age(r) < age(freshest)) freshest = r;
  }
  return freshest === null ? null : freshest.rateLimits;
}

const age = (r: FleetRow): number => r.snapshotAgeMs ?? Infinity;
