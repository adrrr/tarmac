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

/**
 * A terminal someone is sitting at, or a background agent `claude agents --json` printed
 * beside it. Drawn differently, counted the same.
 */
export type NodeRole = 'session' | 'agent';

export interface MapNode {
  row: FleetRow;
  role: NodeRole;
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

/**
 * Where an agent is placed, and why it is a placement rather than a link.
 *
 * `claude agents --json` prints interactive and background sessions in one array, and
 * publishes nothing that ties an agent to whoever dispatched it. The working directory is
 * the only field both carry, so it is what an agent is placed BY — it lands next to the
 * session sharing its directory, and nothing is ever nested inside anything. Nesting would
 * assert a parentage the source does not contain, and it would let this page show a smaller
 * fleet than the table beside it.
 *
 * The agents are gathered separately because the fleet sorts busy sessions first, so one can
 * arrive before the session it belongs beside. An agent whose directory matches no session
 * keeps a node of its own, at the end.
 */
export function buildMap({ rows }: Fleet, { pulseWithinMs = PULSE_WITHIN_MS } = {}): FleetMap {
  const node = (row: FleetRow): MapNode => {
    const reading = readingOf(row);
    return {
      row,
      role: roleOf(row),
      state: stateOf(row),
      reading,
      // `live` first, and not merely "young": a reading the fleet calls stale is one this
      // page may not animate as though it were breathing — and with `--stale-after 2s` a
      // three-second-old reading is both stale and inside the window below.
      pulse: reading === 'live' && row.snapshotAgeMs !== null && row.snapshotAgeMs <= pulseWithinMs,
    };
  };

  const agents = rows.filter((r) => roleOf(r) === 'agent');
  const placed = new Set<FleetRow>();
  const seen = new Set<string>();
  const nodes: MapNode[] = [];
  for (const r of rows) {
    if (roleOf(r) !== 'session') continue;
    nodes.push(node(r));
    // Only the first session of a directory collects them, or two sessions in one checkout
    // would each grow a copy of the same agents.
    if (r.cwd === null || seen.has(r.cwd)) continue;
    seen.add(r.cwd);
    for (const a of agents) {
      // Two directories nobody could read are not the same directory.
      if (a.cwd === null || a.cwd !== r.cwd) continue;
      nodes.push(node(a));
      placed.add(a);
    }
  }
  for (const a of agents) if (!placed.has(a)) nodes.push(node(a));
  return { nodes };
}

/**
 * A terminal someone is sitting at, or something else `claude agents --json` is printing.
 *
 * An ABSENT kind is not evidence of an agent, so it reads as a session: the same rule the
 * session status follows one module down, where unrecognised means unknown, never "the quiet
 * one". The two mistakes are not the same size either — an agent drawn as a session is a
 * node in the wrong shape, while a session drawn as an agent is a terminal someone is
 * working in, reduced to a footnote of a directory it merely shares.
 */
const roleOf = (r: FleetRow): NodeRole => (r.kind === null || r.kind === 'interactive' ? 'session' : 'agent');

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
