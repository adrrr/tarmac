// P4 — the map's model.
//
// A view over the fleet `buildFleet` already produced. It opens no second source: every
// field below is derived from a row that is already on the page as a table line.

import { isWaiting } from './sessions.ts';
import type { Fleet, FleetRow } from './fleet.ts';

export type NodeState = 'busy' | 'waiting' | 'idle' | 'unknown';

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
  /**
   * Whether there is a number at all — a different question from how old the snapshot is,
   * and the markup is not allowed to answer it from `reading`. `fresh` and `drift` both
   * carry a snapshot file, so both are as current as a reading gets, and neither has a
   * percentage: derived from freshness, those two drew as a full, confident, empty ring,
   * which is this project's cardinal sin wearing the dial of the one before it.
   */
  measured: boolean;
  /** A reading landed for this session moments ago. The only animated thing on the page. */
  pulse: boolean;
}

/**
 * The nodes read in one working directory, and the exact extent of what that grouping claims.
 *
 * `claude agents --json` prints interactive sessions and background ones in one array and
 * publishes NOTHING that ties an agent to whoever dispatched it. The working directory is the
 * only field every kind of node carries, so it is the only thing a frame is allowed to be
 * drawn around — and the label says the directory, never a parentage. A berth holding two
 * sessions and two agents makes no claim about which of the four asked for which: no order,
 * no position and no line inside it means "dispatched by".
 *
 * The day the source does publish that relation, it is drawn INSIDE a berth — between nodes
 * that are already side by side — without moving a frame or redrawing the page.
 */
export interface Berth {
  /**
   * The project, which is the directory's basename — so every node of one berth agrees on it
   * and the first one can be asked. Not unique: two checkouts of `atlas` are two berths with
   * one label, which is the truth about a machine that has two of them. The full path is not
   * printed here any more than anywhere else on this page.
   *
   * Never empty, and that is load-bearing rather than tidy: the renderer answers an absent
   * value with a dash ELEMENT, and a frame is named through an `aria-label`, where a span
   * carrying quotes of its own is markup in a slot that takes a string.
   */
  label: string;
  /** Drawn as cards, side by side. */
  sessions: MapNode[];
  /** Drawn as strips, docked under the cards of the same berth. */
  agents: MapNode[];
}

export interface FleetMap {
  berths: Berth[];
}

/**
 * What a berth is labelled when the source published no working directory for it. In the
 * vocabulary the dials already use for a reading they do not have (`not chained`, `no turn
 * yet`): a kind of nothing, named, rather than an empty frame that reads as a bug.
 */
const NO_DIRECTORY = 'no directory';

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
 * Where a node goes, and why that is a grouping rather than a link.
 *
 * `claude agents --json` prints interactive and background sessions in one array, and
 * publishes nothing that ties an agent to whoever dispatched it. The working directory is
 * the only field both carry, so it is the only thing nodes are grouped BY — they share a
 * berth, and nothing is ever nested inside anything. Nesting would assert a parentage the
 * source does not contain, and it would let this page show a smaller fleet than the table
 * beside it.
 *
 * One pass, in the fleet's own order, and each berth takes its place at its FIRST node: the
 * rank that lifts a session halted on a human above everything else lifts the frame around it
 * too, whether the node that earned it is a session or an agent. An agent whose directory
 * matches no session is a berth of its own, ordered like any other — being last was the flat
 * grid's arrangement of it, never the data's.
 */
export function buildMap({ rows }: Fleet, { pulseWithinMs = PULSE_WITHIN_MS } = {}): FleetMap {
  // Whether this fleet still speaks the kind we know. If NOTHING calls itself `interactive`,
  // the word moved rather than every terminal on the machine going background at once — and
  // the map says so by drawing them all as what they almost certainly still are. It is the
  // tolerance `buildFleet` already applies to telemetry: a signal true of every row is a
  // change in the source.
  const anchored = rows.some((r) => r.kind === INTERACTIVE);
  const roleOf = (r: FleetRow): NodeRole =>
    !anchored || r.kind === null || r.kind === INTERACTIVE ? 'session' : 'agent';

  const node = (row: FleetRow): MapNode => {
    const reading = readingOf(row);
    return {
      row,
      role: roleOf(row),
      state: stateOf(row),
      reading,
      measured: row.ctxPct !== null,
      // Three conditions, and each one is a way the halo could otherwise lie. `live` first,
      // and not merely "young": a reading the fleet calls stale may not be animated as
      // though it were breathing, and with `--stale-after 2s` a three-second-old reading is
      // both stale and inside the window below. `measured` last: a file landing is not a
      // reading landing, and a drifted fleet still writes a snapshot every frame.
      pulse:
        reading === 'live' &&
        row.ctxPct !== null &&
        row.snapshotAgeMs !== null &&
        row.snapshotAgeMs <= pulseWithinMs,
    };
  };

  const berths: Berth[] = [];
  const byCwd = new Map<string, Berth>();
  for (const r of rows) {
    const n = node(r);
    // Two directories nobody could read are not the same directory, so an absent cwd joins no
    // key: it opens a berth of its own every time, which is the one honest frame around it.
    let berth = r.cwd === null ? undefined : byCwd.get(r.cwd);
    if (berth === undefined) {
      // The project, the directory itself, then the words — and the middle one is not a page
      // that prints paths. `path.basename` answers the empty string for exactly one directory,
      // the root, so a fleet with a session in `/` had a project of `''`: not the absent cwd
      // above, and no name either. The fallback names it `/`, which is what was read.
      berth = { label: r.project || r.cwd || NO_DIRECTORY, sessions: [], agents: [] };
      berths.push(berth);
      if (r.cwd !== null) byCwd.set(r.cwd, berth);
    }
    (n.role === 'session' ? berth.sessions : berth.agents).push(n);
  }
  return { berths };
}

/**
 * The kind a terminal calls itself, and the anchor this module reasons from. A background
 * entry has since been seen beside them — `kind: 'background'`, no `pid`, its word under
 * `state` rather than `status` — so the two are no longer a reading of that CLI's help. It is
 * still the anchor and never the list: one observed alternative is not the vocabulary, and the
 * heuristic above asks only whether anything on this machine still calls itself `interactive`.
 *
 * An ABSENT kind is not evidence of an agent either: the same rule the session status follows
 * one module down, where unrecognised means unknown, never "the quiet one". The two mistakes
 * are not the same size — an agent drawn as a session is a node in the wrong shape, while a
 * session drawn as an agent is a terminal someone is working in, reduced to a footnote of a
 * directory it merely shares.
 */
export const INTERACTIVE = 'interactive';

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

/**
 * The four words a node can be, out of a boolean that only has three answers.
 *
 * `waiting` is asked BEFORE the boolean's `null`, and that order is the point: a session
 * halted until a human answers carries `busy: null` — "is it working" has no honest answer —
 * which is the same null an unrecognised word gets. Left to the boolean alone, the one
 * session that is blocked on YOU drew as the amber "tarmac does not know this word".
 */
export const stateOf = (r: FleetRow): NodeState =>
  r.busy === true ? 'busy' : isWaiting(r) ? 'waiting' : r.busy === false ? 'idle' : 'unknown';
