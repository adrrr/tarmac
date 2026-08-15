// P4 — the map's model.
//
// A view over the fleet `buildFleet` already produced. It opens no second source: every
// field below is derived from a row that is already on the page as a table line.

import type { Fleet, FleetRow } from './fleet.ts';

export type NodeState = 'busy' | 'idle' | 'unknown';

/**
 * How much a node's context reading may be believed. The state above and this are two
 * different clocks and are never merged: `busy` comes from `claude agents --json`, read at
 * collect time, while the percentage comes from a file the session's terminal wrote whenever
 * it last drew a frame. A busy session with a two-hour-old reading is both live and stale,
 * and the map has to say both.
 */
export type Reading = 'live' | 'stale' | 'undated' | 'none';

export interface MapNode {
  row: FleetRow;
  state: NodeState;
  reading: Reading;
  /** A frame landed for this session moments ago. The only animated thing on the page. */
  pulse: boolean;
}

export interface FleetMap {
  nodes: MapNode[];
}

/**
 * How recently a snapshot must have landed for its node to pulse. Two of the page's poll
 * intervals (5s): a session whose terminal keeps drawing frames keeps its heartbeat across
 * consecutive renders, and one that has stopped goes quiet within two of them.
 *
 * It is a display window, not a health threshold — `--stale-after` is the one that judges,
 * and it wins wherever the two disagree.
 */
export const PULSE_WITHIN_MS = 10_000;

export function buildMap({ rows }: Fleet, { pulseWithinMs = PULSE_WITHIN_MS } = {}): FleetMap {
  return {
    nodes: rows.map((row) => {
      const reading = readingOf(row);
      return {
        row,
        state: stateOf(row),
        reading,
        // `live` first, and not merely "young": a reading the fleet calls stale is one this
        // page may not animate as though it were breathing — and with `--stale-after 2s` a
        // three-second-old reading is both stale and inside the window below.
        pulse: reading === 'live' && row.snapshotAgeMs !== null && row.snapshotAgeMs <= pulseWithinMs,
      };
    }),
  };
}

/**
 * `stale` is not recomputed here — it is the collector's verdict, reached against the
 * threshold this run resolved (`--stale-after`, the environment, the config file). A second
 * opinion in this module would let the map and the table disagree about the same session on
 * the same page.
 */
function readingOf(r: FleetRow): Reading {
  if (r.snapshotAgeMs === null) return 'none';
  // A snapshot dated after the clock reading it: an NTP correction, a mount whose time runs
  // ahead. Its age is not a small number, it is not a number at all.
  if (r.snapshotAgeMs < 0) return 'undated';
  return r.stale ? 'stale' : 'live';
}

const stateOf = (r: FleetRow): NodeState => (r.busy === true ? 'busy' : r.busy === false ? 'idle' : 'unknown');
