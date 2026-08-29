// The journal, and the only file in this project that exists because someone asked for it.
//
// `history.ts` states the rule this module is the exception to: a fleet journal on disk would
// outlive the process that made it and sit in a home directory carrying session ids and costs,
// so `serve` keeps its day in memory and writes nothing. That default does not move. What moves
// is that a reader can now set `history.days` and get a journal on their own machine, in
// writing, having been told what goes in it and how big it gets.
//
// Three properties make that opt-in something other than the file the README refused:
//   • the line is the RING's sample, produced by the ring's own serialiser. No name, no working
//     directory, and no second shape to keep true. What `/api/history` serves is what lands.
//   • it is bounded twice. By age, which the reader set, and by a hard cap they did not, so a
//     fleet ten times the size of the one the startup line quoted cannot fill a disk quietly.
//   • it is best effort. A write that fails is counted and never thrown: `serve` runs
//     unattended for hours, and a throw out of the sampler is an unhandled rejection.
//
// One owner, and that is why the directory is a SIBLING of `snapshots/` rather than a file
// inside it. Three things already delete under the snapshots directory (`reap.ts`, the
// wrapper's own sweep, the legacy purge in `install.ts`) and each of them decides by name.
// A journal living among the payloads would be one glob away from being someone else's litter.

import fs from 'node:fs';
import path from 'node:path';
import type { HistorySample, HistorySession } from './history.ts';

/**
 * The ceiling nobody can raise. The age limit is the reader's number and it is not a bound on
 * its own: it prices a fleet of eight sessions at about a megabyte a day, and a fleet of two
 * hundred writes a hundred times that. This is what stands between a forgotten config key and
 * a full disk, which is why it is a constant and not a second knob.
 */
export const HISTORY_MAX_BYTES = 256 * 1024 * 1024;

/**
 * A day this store wrote, and nothing else. Built from the name the writer uses rather than
 * from `*.jsonl`: only what we wrote gets deleted, which is the rule `reap.ts` states for the
 * temp files and the reason a journal in a directory of its own is worth the directory.
 */
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** The date half of that name, which is also the shape a computed cutoff has to have. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Where the journal lives, given where the snapshots are read from: beside them, never among
 * them. Same base, so a reader who moved the snapshots moved the journal with them, and #11
 * (the installed path frozen at install time) covers both by covering one.
 */
export const historyDirFor = (snapshotsDir: string): string => path.join(path.dirname(snapshotsDir), 'history');

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The local day a moment falls on, `YYYY-MM-DD`.
 *
 * Local and not UTC, because a file called `2026-08-07.jsonl` is read by a person who was awake
 * on the 7th. It also makes the name sort as the date does, which is what lets the prune below
 * compare file names instead of parsing them.
 */
const dayOf = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * The oldest day a retention of `days` still covers, today included: `days: 1` keeps today
 * alone, `days: 30` keeps today and the 29 before it.
 *
 * Counted on the CALENDAR rather than by subtracting 24-hour blocks. Two of those cross a DST
 * boundary as 47 or 49 hours, which moves the answer by a day for anyone whose clock shifted
 * that night: the one morning a year when the retention a reader set is not the one they get.
 */
const oldestKept = (now: number, days: number): string => {
  const d = new Date(now);
  return dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime());
};

/**
 * A session as the journal keeps it: the ring's record, minus the reason a halted one gave.
 *
 * `waitingFor` is the one string off `claude agents --json` the ring carries, and it stays out
 * of here. `history.ts` keeps it on the grounds that it is a closed vocabulary the surface
 * publishes; it is not, it is free text, and what Claude Code writes there names the command a
 * permission prompt is asking about. Live, on loopback, dying with the process, that is someone
 * reading their own screen. Thirty days of it in a file is a different object, and the one this
 * store was allowed to create was the file that carries no free text at all.
 */
export type JournalSession = Omit<HistorySession, 'waitingFor'>;

export interface JournalRecord extends Omit<HistorySample, 'sessions'> {
  sessions: JournalSession[];
}

/**
 * The reading, reduced to what goes on disk.
 *
 * An ALLOWLIST, spelled field by field, and deliberately not a spread with a delete: a field
 * added to `HistorySession` tomorrow does not compile here until somebody has decided whether
 * it belongs in a file that outlives the process. The omission that has to survive every future
 * edit cannot be written as a subtraction from a shape that is free to grow.
 */
const lineOf = ({ t, sessions, rateLimits }: HistorySample): JournalRecord => ({
  t,
  sessions: sessions.map(
    ({ sid, project, kind, state, ctxState, ctxPct, costUsd }): JournalSession => ({
      sid,
      project,
      kind,
      state,
      ctxState,
      ctxPct,
      costUsd,
    }),
  ),
  rateLimits,
});

/** Bytes as the cap is spoken about, so a refusal reads like the number that caused it. */
const size = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${bytes} bytes`;

/** What is on disk, plus what this process could not put there. */
export interface HistoryStats {
  files: number;
  bytes: number;
  /**
   * Readings a write was ATTEMPTED for and failed on: a full disk, a read-only mount, a name
   * taken by something that is not a file. Not what the cap refused, which is `stopped` below
   * and a different fact to report.
   */
  misses: number;
  /** Why nothing more is being written, in words fit to print. `null` while it is. */
  stopped: string | null;
}

export interface HistoryPruned {
  removed: number;
  /** Files past the retention that would not go. Counted rather than retried. */
  failed: number;
}

export interface HistoryStore {
  /** Where it writes. Reported by `serve` on startup, so a reader can go and look. */
  readonly dir: string;
  readonly days: number;
  append(sample: HistorySample): void;
  prune(): HistoryPruned;
  stats(): HistoryStats;
}

export interface HistoryStoreOptions {
  dir: string;
  /** How many local days of journal to keep, today included. At least 1: the parser holds it. */
  days: number;
  /** Injected so a retention test is not a test that changes its answer at midnight. */
  now?: () => number;
  /** For the suite. The product's ceiling is `HISTORY_MAX_BYTES` and nothing sets it. */
  maxBytes?: number;
}

export function createHistoryStore({
  dir,
  days,
  now = Date.now,
  maxBytes = HISTORY_MAX_BYTES,
}: HistoryStoreOptions): HistoryStore {
  let misses = 0;
  let stopped: string | null = null;
  // The last local day a prune ran for, so the store keeps its own retention while `serve` runs
  // for weeks. `null` until the first append or the startup prune: a store that has never
  // written has nothing to prune, and inventing a day here would make the first append sweep.
  let prunedDay: string | null = null;

  /**
   * What the directory holds right now, read rather than remembered.
   *
   * A running total would be faster and would be a second truth: this directory is also the
   * one a reader is invited to `rm -rf` when they change their mind, and a cached size would
   * then refuse to write into a directory that is empty. Once a minute, over the handful of
   * files a retention allows, the readdir costs nothing worth a cache.
   */
  const measure = (): { files: number; bytes: number } => {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      // No directory yet, or one we may not read. Either way there is no journal to report on,
      // and `append` raises the alarm that matters by failing to write and counting it.
      return { files: 0, bytes: 0 };
    }
    let files = 0;
    let bytes = 0;
    for (const name of entries) {
      if (!DAY_FILE.test(name)) continue;
      try {
        const s = fs.statSync(path.join(dir, name));
        if (!s.isFile()) continue;
        files += 1;
        bytes += s.size;
      } catch {
        // A file that vanished between the readdir and the stat weighs nothing.
      }
    }
    return { files, bytes };
  };

  const prune = (): HistoryPruned => {
    prunedDay = dayOf(now());
    const keep = oldestKept(now(), days);
    let removed = 0;
    let failed = 0;
    // A cutoff nothing can compute is a cutoff nothing is deleted by. `days` is only bounded
    // below, and a retention past what the calendar can express (about 274 000 years) makes an
    // Invalid Date, whose day reads `NaN-NaN-NaN`. Every real file name sorts BELOW that
    // string, so the comparison further down turned "keep this for ever" into "delete all of
    // it", silently. The absurd number is not the danger; the inversion is.
    if (!DAY.test(keep)) return { removed, failed };
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return { removed, failed };
    }
    for (const name of entries) {
      if (!DAY_FILE.test(name)) continue;
      // The name IS the date, zero-padded, so a string comparison is the date comparison.
      if (name.slice(0, 10) >= keep) continue;
      try {
        fs.unlinkSync(path.join(dir, name));
        removed += 1;
      } catch {
        failed += 1;
      }
    }
    // The cap is a stop, not a verdict: the retention that made room is what lifts it, and a
    // store that stayed stopped until the next restart would keep a promise nobody made.
    if (stopped !== null && measure().bytes < maxBytes) stopped = null;
    return { removed, failed };
  };

  return {
    dir,
    days,
    append(sample: HistorySample): void {
      const day = dayOf(now());
      // Its own retention, kept as the day turns rather than only at startup. A machine left up
      // since March would otherwise hold every day since March under a config that says thirty.
      if (prunedDay !== null && prunedDay !== day) prune();
      else if (prunedDay === null) prunedDay = day;

      // One line, one reading, terminated: a reader tailing this file sees whole records, and a
      // process killed between two appends leaves the last one complete.
      const line = JSON.stringify(lineOf(sample)) + '\n';
      const bytes = Buffer.byteLength(line);
      const held = measure().bytes;
      if (held + bytes > maxBytes) {
        stopped = `the journal is at its ${size(maxBytes)} cap, in ${dir}`;
        return;
      }
      stopped = null;

      try {
        fs.mkdirSync(dir, { recursive: true });
        // `a`, so two writers cannot interleave a partial line and a restart cannot truncate
        // what is already there. This process is the only writer, and the flag says so anyway.
        fs.appendFileSync(path.join(dir, `${day}.jsonl`), line, { flag: 'a' });
      } catch {
        // A full disk, a read-only mount, a directory someone replaced with a file. None of
        // them are worth a dead `serve`, and none of them may pass in silence either.
        misses += 1;
      }
    },
    prune,
    stats(): HistoryStats {
      const { files, bytes } = measure();
      return { files, bytes, misses, stopped };
    },
  };
}
