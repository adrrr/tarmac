// P3 — one call, both contractual sources, one fleet view. Strictly read-only.

import { SOURCE_PHRASE } from './config.ts';
import type { Source } from './config.ts';
import { discoverSessions } from './discover.ts';
import { readSnapshots } from './snapshots.ts';
import { buildFleet } from './fleet.ts';
import type { Fleet } from './fleet.ts';

export interface CollectOptions {
  claudeBin?: string;
  snapshotsDir: string;
  now?: number;
  staleAfterMs?: number;
  /** Who chose that directory — the difference between "not chained yet" and "points nowhere". */
  snapshotsDirSource?: Source;
  /**
   * Is there an install here whose wrapper writes to it? Since #20 the DEFAULT is the path
   * that install froze — chosen, and created, by a run that happened — so its absence is no
   * longer the zero-config case.
   */
  installed?: boolean;
}

export async function collectFleet({
  claudeBin,
  snapshotsDir,
  now = Date.now(),
  staleAfterMs,
  snapshotsDirSource = 'default',
  installed = false,
}: CollectOptions): Promise<Fleet> {
  const { sessions, health: discovery } = await discoverSessions({ claudeBin });
  const { snapshots, dirError, unreadable, duplicates, dirMissing } = readSnapshots(snapshotsDir, { now });
  const fleet = buildFleet({ sessions, snapshots, now, discovery, staleAfterMs });
  // Both blind spots travel with the data: a directory we could not read and files we
  // could not parse are OUR failures to report, not silence to render as "all clear".
  //
  // An absent directory is judged HERE, because this is the layer that knows who chose it.
  // A path someone typed — flag, environment, or a config file edited months ago — that is
  // not there is a setting pointing at nothing; rendered as "not chained yet" it sends the
  // user to run `tarmac install`, which cannot fix it: install writes where install writes.
  //
  // Exactly ONE case is innocent, and it is narrower than it used to be: no install here at
  // all. Since #20 the default is the path the install FROZE into the wrapper — a directory
  // that was chosen and created by a run that happened — so its absence means the writer and
  // the reader have parted company, which renders as a healthy, empty fleet. That is the one
  // failure this tool may not have.
  fleet.health.snapshotsError = !dirMissing
    ? dirError
    : snapshotsDirSource !== 'default'
      ? `ENOENT: ${snapshotsDir} does not exist — set by ${SOURCE_PHRASE[snapshotsDirSource]}`
      : installed
        ? `ENOENT: ${snapshotsDir} does not exist — the installed wrapper writes there`
        : dirError;
  fleet.health.snapshotsUnreadable = unreadable;
  fleet.health.snapshotsDuplicates = duplicates;
  fleet.health.snapshotsDir = snapshotsDir;
  return fleet;
}
