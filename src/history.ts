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
import { isWaiting } from './sessions.ts';
import type { NodeState } from './map.ts';
import { accountLimits } from './fleet.ts';
import type { Fleet, RowCtxState } from './fleet.ts';

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
   * The same four words the map draws, out of the same function. A replay that reached its
   * own verdict about a session would be a second opinion on a fact the live view already
   * states, and the two would disagree the day either one changed.
   */
  state: NodeState;
  /**
   * Which human answer a `waiting` session was halted on, kept for the minute it was true of.
   * The one string off the source this record keeps beside the numbers, and it is kept for
   * the reason the NAMES are not: it is a closed vocabulary the surface documents — five
   * words about the fleet's own machinery — where a background session's name is the prompt
   * somebody typed. `null` on every other state, and on a waiting one that gave no reason.
   */
  waitingFor: string | null;
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
  /**
   * The oldest minute this record still covers — the serve's own start until the ring has
   * dropped something, and the oldest slot it holds from then on. It is what a page reads to
   * say what it covers, so it may not go on naming a moment the record has since forgotten.
   */
  since: number;
  cadence: number;
  samples: HistorySample[];
  /**
   * Slots inside that same span a reading was due for and never filled. A gap that says it is
   * a gap is not a gap — and counted for the life of the process instead, it would be a
   * second span in a payload that already has one.
   */
  missed: number;
}

export interface FleetHistory {
  record(fleet: Fleet): void;
  /** `t` is the tick's own clock: a reading that failed left no reading to date the slot by. */
  miss(t: number): void;
  read(): HistoryPayload;
}

export interface HistoryOptions {
  /** When this serve started keeping the record. */
  since: number;
  cadence: number;
}

/** A minute of the day this record covers: the reading taken, or the fact that none was. */
interface Slot {
  t: number;
  sample: HistorySample | null;
}

export function createHistory({ since, cadence }: HistoryOptions): FleetHistory {
  const slots: Slot[] = [];
  // Whether anything has aged out yet, which is the only thing that can move `since` off the
  // moment the serve started. A ring that is exactly full has dropped nothing.
  let dropped = false;

  const push = (slot: Slot): void => {
    slots.push(slot);
    // Trimmed on the way in and never on the way out: the array's own length is the
    // guarantee, so no reader has to be told the ring is bounded for it to be true.
    if (slots.length > HISTORY_SLOTS) {
      slots.splice(0, slots.length - HISTORY_SLOTS);
      dropped = true;
    }
  };

  return {
    record(fleet: Fleet): void {
      const sample = sampleOf(fleet);
      push({ t: sample.t, sample });
    },
    miss(t: number): void {
      push({ t, sample: null });
    },
    // Rebuilt per read, and never the ring itself: this is the only copy there is and no file
    // to restore it from, so a reader that spliced what it was handed would edit the record.
    read: (): HistoryPayload => {
      const samples = slots.filter((s) => s.sample !== null).map((s) => s.sample!);
      return {
        since: dropped ? slots[0].t : since,
        cadence,
        samples,
        missed: slots.length - samples.length,
      };
    },
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
      waitingFor: isWaiting(r) ? r.waitingFor : null,
      ctxState: r.ctxState,
      ctxPct: r.ctxPct,
      costUsd: r.costUsd,
    })),
    // The reading, without its age: the ring keeps each reading and never how old it was.
    rateLimits: accountLimits(rows, health.generatedAt)?.rateLimits ?? null,
  };
}
