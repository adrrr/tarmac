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
// That owner is literal as well as architectural: `acquireJournalLock` below gives the directory
// one writing `serve`, and a second one journals nothing rather than sweeping files it did not
// write (#133).

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

/** The lock, named so `DAY_FILE` cannot mistake it for a day and delete it. */
const LOCK_FILE = '.lock';

/**
 * How long a lock may go without a heartbeat before the next `serve` takes the directory.
 *
 * The pid answers the ordinary death (a `kill -9`, a machine that lost power) and it cannot
 * answer the other one: pids are REUSED, so the number in a file abandoned last week can name a
 * stranger who is alive and has never heard of this directory. Five minutes is four missed
 * heartbeats, which a laptop that slept or a fleet read that took its whole deadline can spend,
 * and short enough that nobody who rebooted sits waiting for their journal to come back.
 */
const LOCK_STALE_MS = 5 * 60_000;

export interface JournalLock {
  /** The file that holds the directory, so whoever refuses can point at something. */
  readonly file: string;
  /**
   * The heartbeat, pushed forward on every tick, answering whether this process still holds the
   * directory. It reads the file rather than trusting the take: a blind `utimes` succeeds on a
   * lock somebody else has since taken, which would refresh THEIR heartbeat and leave this
   * process writing into a directory it no longer owns.
   */
  touch(): boolean;
  /** Given back on the way out, and only if it is still ours. */
  release(): void;
}

export interface JournalLockResult {
  /** The lock this process took, `null` when it took none, which is when it journals nothing. */
  lock: JournalLock | null;
  /** The live pid that holds the directory, when that is the reason. `null` otherwise. */
  heldBy: number | null;
}

/** The pid a lock file names, or `null` for one that is gone or says something else. */
const lockPid = (file: string): number | null => {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
};

/** Whether a pid is a process. `EPERM` is one this user may not signal, which is still one. */
const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * One owner for the directory, taken at startup and given back on the way out.
 *
 * Retention is a property of the DIRECTORY and the process applying it was whichever `serve`
 * started last: a `serve --history-days 1` started to try the setting out swept twenty-nine days
 * a thirty-day serve had kept, in four seconds, and both then wrote a line a minute into the
 * same files. That is not a contract this ships, and a second serve is now told to journal
 * nothing rather than arbitrated with (#133).
 *
 * `wx`, so taking it is one atomic filesystem operation rather than a read followed by a write
 * that a second serve can land inside. Everything else here is about the locks nobody released:
 * a dead pid, or five minutes of silence from a live one.
 */
export function acquireJournalLock({ dir, now = Date.now }: { dir: string; now?: () => number }): JournalLockResult {
  const file = path.join(dir, LOCK_FILE);
  const touch = (): boolean => {
    if (lockPid(file) !== process.pid) return false;
    const t = now() / 1000;
    try {
      fs.utimesSync(file, t, t);
      return true;
    } catch {
      // Gone between the read and the write. Not ours either way, and the caller stops.
      return false;
    }
  };
  const release = (): void => {
    // Ours only. A process the kernel stopped for five minutes has its lock legitimately taken
    // off it; removing the new owner's file on the way out would hand the directory to a third.
    try {
      if (lockPid(file) === process.pid) fs.unlinkSync(file);
    } catch {
      // A directory already gone, or one we may no longer write. Either way it is not held.
    }
  };
  const take = (): JournalLock | null => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
      return { file, touch, release };
    } catch {
      return null;
    }
  };

  const taken = take();
  if (taken !== null) return { lock: taken, heldBy: null };

  const pid = lockPid(file);
  let beat: number | null;
  try {
    beat = fs.statSync(file).mtimeMs;
  } catch {
    // No file to read a heartbeat off, so nothing holds this: it went between the two calls.
    beat = null;
  }
  // A fresh heartbeat holds the directory whether or not the pid can be read, and that order
  // matters: taking the lock is `open(O_CREAT|O_EXCL)` and THEN a write, so between the two the
  // file exists and is empty. Reading no pid as "nothing holds this" let a second serve remove
  // the lock of a serve in the middle of taking it, which is two owners on a window one syscall
  // wide. An unreadable lock is not unbreakable either: with no heartbeat for five minutes it
  // goes the same way a dead pid's does.
  if (beat !== null && now() - beat <= LOCK_STALE_MS && (pid === null || running(pid))) return { lock: null, heldBy: pid };

  // Only the file that was JUDGED, never whatever is there now: two serves reclaiming the same
  // abandoned lock together would otherwise both remove one and both create one, and the second
  // create is the one on disk. Re-reading the pid and the heartbeat costs two syscalls and takes
  // that from six rounds in twelve to none, measured on eight processes released off a barrier.
  //
  // It is a narrowing and not a proof: the read and the unlink are still two operations. What
  // closes it is one level up, where every tick re-reads the lock before writing, so a directory
  // that ended up with two owners has one again within the minute.
  try {
    if (lockPid(file) === pid && fs.statSync(file).mtimeMs === beat) fs.unlinkSync(file);
  } catch {
    // Already gone, or not ours to remove. The retry below is what decides either way.
  }
  const reclaimed = take();
  // A lock we could not take and could not reclaim. `heldBy` is read again rather than
  // remembered: the serve that won the race in between is the one worth naming.
  return reclaimed !== null ? { lock: reclaimed, heldBy: null } : { lock: null, heldBy: lockPid(file) };
}

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
  /**
   * Whether THE CAP is what stopped it. `stopped` is a sentence with two causes now (the cap, and
   * a directory that turned out to belong to another serve) and `/api/history` carries this one
   * into `coverage.capped`, which a page renders as "journal capped". A serve that lost its
   * directory has filled nothing, and a reader must not be sent looking at a 256 MB ceiling for it.
   */
  capped: boolean;
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
  /**
   * The tick, whether or not a reading came back. It is what keeps the directory's lock alive,
   * and the lock is about this PROCESS being here: a `claude` that has been missing for five
   * minutes must not cost a running serve the journal it is holding.
   */
  heartbeat(): void;
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
  /**
   * The directory's lock, held by whoever built this store. Refreshed on every append, which is
   * the whole heartbeat: a serve that has been up for an hour and never touched it reads as
   * abandoned, and the next `serve` on the machine takes the directory and sweeps it.
   */
  lock?: JournalLock | null;
}

export function createHistoryStore({
  dir,
  days,
  now = Date.now,
  maxBytes = HISTORY_MAX_BYTES,
  lock = null,
}: HistoryStoreOptions): HistoryStore {
  let misses = 0;
  let stopped: string | null = null;
  // The cause behind `stopped`, when it is the ceiling. Kept apart from the sentence because one
  // of them is read by a page and the other by a person.
  let capped = false;
  // Reassigned when the directory is erased under a running serve and this store takes its own
  // lock back, which is the one case where losing it is not losing the journal.
  let held = lock;
  // The last local day a prune ran for, so the store keeps its own retention while `serve` runs
  // for weeks. `null` until the first append or the startup prune: a store that has never
  // written has nothing to prune, and inventing a day here would make the first append sweep.
  let prunedDay: string | null = null;

  /**
   * Whether this store still owns its directory, and the heartbeat that says it is alive.
   *
   * Read on every tick rather than trusted from startup, because both ways of losing a directory
   * are silent. Another `serve` reclaims a lock this one let go quiet, and a blind writer then
   * appends into somebody else's journal and sweeps it with a retention nobody there set: #133,
   * one heartbeat later. Or the reader erases the directory, which the manual invites them to do,
   * and the lock goes with it; nobody took anything, so the lock is simply taken back. The
   * acquire is what tells the two apart, since it refuses one a live process is touching.
   */
  const owns = (): boolean => {
    // No lock is the suite, and a store nobody gave a directory to has none to lose.
    if (held === null) return true;
    if (held.touch()) return true;
    const { lock: again, heldBy } = acquireJournalLock({ dir, now });
    if (again === null) {
      stopped = heldBy === null ? `the lock in ${dir} could not be taken back` : `another serve (pid ${heldBy}) holds ${dir}`;
      return false;
    }
    held = again;
    return true;
  };

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
    // Here as well as in `append`, because this is the OTHER path to a deletion: the startup
    // sweep runs on `listening`, before any tick, and it is the destructive half of #133.
    if (!owns()) return { removed: 0, failed: 0 };
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
    if (stopped !== null && capped && measure().bytes < maxBytes) {
      stopped = null;
      capped = false;
    }
    return { removed, failed };
  };

  return {
    dir,
    days,
    heartbeat(): void {
      void owns();
    },
    append(sample: HistorySample): void {
      // Before the day-turn prune below and before any write: a store that no longer owns its
      // directory may not sweep it, and the sweep is the destructive half of #133.
      if (!owns()) return;
      const day = dayOf(now());
      // Its own retention, kept as the day turns rather than only at startup. A machine left up
      // since March would otherwise hold every day since March under a config that says thirty.
      if (prunedDay !== null && prunedDay !== day) prune();
      else if (prunedDay === null) prunedDay = day;

      // One line, one reading, terminated: a reader tailing this file sees whole records, and a
      // process killed between two appends leaves the last one complete.
      const line = JSON.stringify(lineOf(sample)) + '\n';
      const bytes = Buffer.byteLength(line);
      const onDisk = measure().bytes;
      if (onDisk + bytes > maxBytes) {
        stopped = `the journal is at its ${size(maxBytes)} cap, in ${dir}`;
        capped = true;
        return;
      }
      stopped = null;
      capped = false;

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
      return { files, bytes, misses, stopped, capped };
    },
  };
}
