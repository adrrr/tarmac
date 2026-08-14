// Wrapper hygiene — the litter, which is one of the two things tarmac deletes (the other is
// the wrapper's own amortized prune of dead sessions' snapshots, see `src/wrapper.ts`).
//
// The generated wrapper writes `<dir>/.tarmac-<session_id>.<pid>.tmp` and renames it over
// `<session_id>.json`, so the snapshot a reader sees is never half-written. Kill the
// terminal in the gap between the two and the temp file survives its process — one per
// interrupted frame, forever.
//
// Two rules, and the first one is the whole design:
//   • only what we WROTE — not "what looks like something we might have written".
//     `.<sid>.<pid>.tmp` is the temp-file convention of half the world, including the
//     production statusline script this tool is documented as being pointed at. So the
//     wrapper signs its temp files with `TEMP_PREFIX`, and the match below is built from
//     that same constant: writer and deleter cannot drift apart.
//   • only what is finished. A frame takes milliseconds; anything recent may be a write
//     in flight, and deleting it would be the reaper causing the corruption it prevents.

import fs from 'node:fs';
import path from 'node:path';
import { SID_GLOB, TEMP_PREFIX } from './wrapper.ts';

/** Exported so a test can build the same expectation from the same constant, escaped. */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `<TEMP_PREFIX><sid>.<pid>.tmp` — the pid is what `$$` emits, and the sid is the wrapper's
// own rule, read from the constant rather than transcribed: a set of its own is how this
// matcher came to accept names the writer had stopped producing (#7).
//
// `SID_GLOB` goes in RAW, unlike the prefix: it is a shell pattern made of bracket
// expressions and literal `-`, which is already valid regex meaning the same set. Escaping
// it would turn the classes into literal brackets and match nothing at all.
const TEMP_NAME = new RegExp(`^${escapeRe(TEMP_PREFIX)}${SID_GLOB}\\.\\d+\\.tmp$`);

/** An hour is orders of magnitude beyond any real frame, and cheap to be wrong about. */
const DEFAULT_OLDER_THAN_MS = 60 * 60_000;

export interface ReapOptions {
  now?: number;
  olderThanMs?: number;
}

export interface ReapResult {
  reaped: number;
  /** Files we matched but could not remove — counted so a caller can say so. */
  failed: number;
}

/**
 * Best-effort, and best-effort means it never throws: hygiene must not be the reason a
 * command fails. A directory we cannot read reports nothing here — `readSnapshots` is the
 * one that raises that alarm, and raising it twice would only teach the user to ignore it.
 *
 * Known limit: the age test trusts the filesystem's clock. A file dated in the future is
 * never reaped, which is the safe direction; a mount whose clock runs an hour behind could
 * make a fresh temp file look stale. Both need a broken clock to reach, and the worst case
 * is one lost frame — the wrapper's `mv` then fails into its existing `rm -f` branch.
 */
export function reapOrphanedTemps(
  dir: string,
  { now = Date.now(), olderThanMs = DEFAULT_OLDER_THAN_MS }: ReapOptions = {},
): ReapResult {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { reaped: 0, failed: 0 };
  }

  let reaped = 0;
  let failed = 0;
  for (const name of entries) {
    if (!TEMP_NAME.test(name)) continue;
    const file = path.join(dir, name);
    try {
      // `lstat`, not `stat`: `unlink` removes the link, so the link's own age is the one
      // that decides. Following the target made a dangling symlink throw ENOENT and get
      // reported as "could not remove" — a false alarm about a file unlink handles fine.
      if (now - fs.lstatSync(file).mtimeMs < olderThanMs) continue;
      fs.unlinkSync(file);
      reaped += 1;
    } catch {
      failed += 1;
    }
  }
  return { reaped, failed };
}
