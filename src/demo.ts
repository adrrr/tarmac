// P6 — the fleet `tarmac serve --demo` shows.
//
// Why it ships. A first run is one session and no record: a table of one row and three charts
// with nothing in them, which is the screen that sells this tool to everybody who has not
// installed it yet (#150). `--demo` puts a plausible fleet and a day of its history in front of
// that reader instead, and says on the page that it is invented.
//
// Where it plugs in, and why THERE. The product's pitch is that it parses no internal format:
// it reads `claude agents --json` and the statusline payload, both documented, and joins them.
// So this module feeds the structures those two are already PARSED into — `Session[]` and a map
// of `Snapshot` — and hands them to the same `buildFleet` the real collector calls. It writes no
// JSON for anyone to read back, prints no `claude agents --json` for anyone to parse, and there
// is therefore no second parsing path to keep in step with the first. A demo built the other way
// round — a fake CLI whose output the real reader re-parses — would be a copy of the one surface
// this repo cannot afford to have two of.
//
// What it may not do, held by `test/demo.test.ts`: read this machine's FLEET, spawn anything, or
// write a byte. Every path below hangs off an invented home, and the end-to-end checks run the
// real `serve --demo` with no `claude` on the box and no snapshot directory anywhere.
//
// "Its fleet", precisely, and not "nothing at all": `serve` still resolves its settings, so a
// config file naming a port or a trusted host is read under `--demo` exactly as it always was.
// What is never opened is the snapshot directory, `claude`, and the journal.

import { DEFAULT_STALE_AFTER_MS } from './config.ts';
import { buildFleet } from './fleet.ts';
import { createHistory, HISTORY_CADENCE_MS, HISTORY_SLOTS } from './history.ts';
import type { FleetHistory } from './history.ts';
import type { Fleet } from './fleet.ts';
import type { DiscoveryHealth, Session } from './sessions.ts';
import type { Snapshot } from './snapshots.ts';

/**
 * The invented home every path here hangs off. Never `os.homedir()`, ever — a demo that
 * borrowed one string off the machine it runs on would put somebody's directory names into
 * every screenshot taken of it.
 */
export const DEMO_HOME = '/Users/jane';

/** Where the invented sessions are working. Ordinary names, belonging to nobody. */
const WORK = `${DEMO_HOME}/work`;

/** How many sessions the shown minute holds. Eight is a fleet; one is the screen #150 is about. */
export const DEMO_SESSIONS = 8;

/**
 * How many minutes of fleet the demo plays. One more than the ring holds, so the record served
 * to the scrubber has dropped a slot and dates itself by its own oldest reading rather than by
 * the moment the process started — which would be a day later than the day it is showing.
 */
export const DEMO_MINUTES = HISTORY_SLOTS + 1;

/** The Claude Code whose payload shapes this repo has fixtures for, so nothing reads unchecked. */
const CC_VERSION = '2.1.232';

/** The context window every invented session is filling. */
const CTX_WINDOW = 1_000_000;

/** The five-hour window, in minutes, and how full each successive one gets. */
const WINDOW_MINUTES = 300;
const WINDOW_PEAKS = [58, 84, 71, 49, 77];

const OPUS = { id: 'claude-opus-5', display_name: 'Opus 5' };
const FABLE = { id: 'claude-fable-5', display_name: 'Fable 5' };

/** A stretch of the day a session spends in one state, given as the minute it starts. */
interface Segment {
  from: number;
  status: string;
  /** Only a `waiting` segment has one, and only some of those. */
  waitingFor?: string;
}

interface Actor {
  sid: string;
  cwd: string;
  name: string;
  kind: 'interactive' | 'background';
  pid: number | null;
  model: { id: string; display_name: string };
  effort: string;
  /** The minute it appears. Every actor is still there at the end: the shown minute is eight. */
  born: number;
  /** Context percent at its first turn, and how fast the window fills while it works. */
  ctxFrom: number;
  ctxPerBusyMinute: number;
  /** Dollars per minute of work. Cost accrues while a session works and not otherwise. */
  costPerBusyMinute: number;
  /** How old its reading is whenever it is taken — a terminal nobody is looking at draws less. */
  ageMs: number;
  segments: Segment[];
  /**
   * A minute range this session has taken no turn in — the `used_percentage: null` dial. One
   * session recycles mid-day so a reader scrubbing the record walks past the state this whole
   * project exists to get right: no turn yet is not a window at zero.
   */
  fresh?: { from: number; to: number };
}

/**
 * The eight. Ordinary project names under an invented home, and the two background agents are
 * named after their prompt, which is what `claude agents --json` calls one.
 *
 * They arrive across the day rather than all at midnight — three at the start, eight by the end
 * — because a record whose every minute holds the same fleet is a scrubber with nothing behind
 * it, and flat charts are the thing #150 is replacing.
 */
const ACTORS: Actor[] = [
  {
    sid: '4e91c0a7-1d35-4b82-9f60-3a7c58d2e014',
    cwd: `${WORK}/api-gateway`,
    name: 'api-refactor',
    kind: 'interactive',
    pid: 30412,
    model: OPUS,
    effort: 'high',
    born: 0,
    ctxFrom: 8,
    // Steep enough that this one ends the day near a compact. A fleet whose fullest window is
    // two thirds is a fleet with nothing at stake, and the number most people install this to
    // watch is the one that is about to run out.
    ctxPerBusyMinute: 0.147,
    costPerBusyMinute: 0.038,
    ageMs: 2_000,
    // The recycle at 642 is why its ramp restarts: a compacted session is a new window.
    fresh: { from: 642, to: 654 },
    segments: [
      { from: 0, status: 'idle' },
      { from: 126, status: 'busy' },
      { from: 488, status: 'idle' },
      { from: 654, status: 'busy' },
      { from: 1088, status: 'idle' },
      { from: 1297, status: 'busy' },
    ],
  },
  {
    sid: '9b2f47d1-6c08-4a53-8e19-2d4b70f6c385',
    cwd: `${WORK}/docs-site`,
    name: 'docs-site',
    kind: 'interactive',
    pid: 31877,
    model: FABLE,
    effort: 'medium',
    born: 0,
    ctxFrom: 5,
    ctxPerBusyMinute: 0.07,
    costPerBusyMinute: 0.019,
    ageMs: 68_000,
    segments: [
      { from: 0, status: 'idle' },
      { from: 318, status: 'busy' },
      { from: 536, status: 'idle' },
      { from: 1120, status: 'busy' },
      { from: 1392, status: 'idle' },
    ],
  },
  {
    sid: '6a04d92e-8b17-4c60-95f3-0e2a6b48d1c7',
    cwd: `${WORK}/data-pipeline`,
    name: 'data-pipeline',
    kind: 'interactive',
    pid: 44120,
    model: FABLE,
    effort: 'max',
    born: 0,
    ctxFrom: 11,
    ctxPerBusyMinute: 0.06,
    costPerBusyMinute: 0.041,
    ageMs: 3_000,
    segments: [
      { from: 0, status: 'busy' },
      { from: 74, status: 'idle' },
      { from: 412, status: 'busy' },
      { from: 869, status: 'idle' },
      { from: 1013, status: 'busy' },
    ],
  },
  {
    sid: '1c58e3b6-4f70-49a2-b3d8-6e015a9c7f24',
    cwd: `${WORK}/auth-service`,
    name: 'bugfix-auth',
    kind: 'interactive',
    pid: 42713,
    model: OPUS,
    effort: 'high',
    born: 214,
    ctxFrom: 4,
    ctxPerBusyMinute: 0.09,
    costPerBusyMinute: 0.033,
    ageMs: 5_000,
    segments: [
      { from: 214, status: 'idle' },
      { from: 266, status: 'busy' },
      { from: 702, status: 'idle' },
      { from: 1204, status: 'busy' },
      // The one state that is work for the READER, and the only one that captions itself.
      { from: 1398, status: 'waiting', waitingFor: 'permission prompt' },
    ],
  },
  {
    sid: '8e15fa03-7d62-4b91-83c0-5b9e14d6a07f',
    cwd: `${WORK}/api-gateway`,
    name: 're-run the payments suite until it is green',
    kind: 'background',
    pid: null,
    model: FABLE,
    effort: 'max',
    born: 483,
    ctxFrom: 4,
    ctxPerBusyMinute: 0.05,
    costPerBusyMinute: 0.017,
    ageMs: 4_000,
    segments: [{ from: 483, status: 'working' }],
  },
  {
    sid: '3d76b18f-5029-4e74-a6c1-84f037b9e2d5',
    cwd: `${WORK}/docs-site`,
    name: 'release-notes',
    kind: 'interactive',
    pid: 46308,
    model: OPUS,
    effort: 'medium',
    born: 908,
    ctxFrom: 3,
    ctxPerBusyMinute: 0.08,
    costPerBusyMinute: 0.024,
    ageMs: 9_000,
    segments: [
      { from: 908, status: 'idle' },
      { from: 1004, status: 'busy' },
      // A word `claude agents --json` prints and tarmac has no boolean for. It draws as
      // `unknown`, never as idle, and the page names it above the fleet — which is the whole
      // promise of the tool, so the demo shows it rather than a fleet with nothing to say.
      { from: 1376, status: 'compacting' },
    ],
  },
  {
    sid: '2b90c47a-3e58-4fd6-9107-6ca85f2b0d93',
    cwd: `${WORK}/data-pipeline`,
    name: 'draft the migration notes',
    kind: 'background',
    pid: null,
    model: OPUS,
    effort: 'high',
    born: 1017,
    ctxFrom: 6,
    ctxPerBusyMinute: 0.06,
    costPerBusyMinute: 0.022,
    ageMs: 7_000,
    segments: [{ from: 1017, status: 'working' }],
  },
  {
    sid: '5f8a63d0-9c14-4720-b8e5-71d3062fa4c8',
    cwd: `${WORK}/storefront`,
    name: 'checkout-flow',
    kind: 'interactive',
    pid: 47122,
    model: FABLE,
    effort: 'high',
    born: 1183,
    ctxFrom: 2,
    ctxPerBusyMinute: 0.12,
    costPerBusyMinute: 0.046,
    ageMs: 47_000,
    segments: [
      { from: 1183, status: 'idle' },
      { from: 1251, status: 'busy' },
      { from: 1424, status: 'idle' },
    ],
  },
];

/** Whether a status word means the session is spending tokens right now. */
const working = (status: string): boolean => status === 'busy' || status === 'working';

/** Which segment an actor is in at `minute`. */
function segmentAt(actor: Actor, minute: number): Segment {
  let current = actor.segments[0];
  for (const s of actor.segments) if (s.from <= minute) current = s;
  return current;
}

/** How many minutes of work an actor has done by `minute` — what fills a window and costs money. */
function busyMinutes(actor: Actor, minute: number): number {
  let total = 0;
  for (let i = 0; i < actor.segments.length; i++) {
    const s = actor.segments[i];
    if (!working(s.status)) continue;
    const until = Math.min(actor.segments[i + 1]?.from ?? Infinity, minute + 1);
    total += Math.max(0, until - s.from);
  }
  return total;
}

/**
 * The account's two windows at `minute`. The five-hour one is what the replay is really about:
 * it fills, rolls over at the boundary and fills again, four or five times in a day.
 *
 * Both resets are measured from `now`, the clock that took the reading, and not from the start
 * of the invented day. For a seeded minute the two are the same instant and this changes
 * nothing. For the live view they are not: it answers the last minute of the day for as long as
 * the serve is open, so a reset pinned to `dayStart` fell into the past about an hour in, and
 * the header then read "reset was due 4h ago" over a percentage that had not moved. That phrase
 * is this codebase's own way of saying the number beside it belongs to a window that is gone,
 * and a demo has no business showing it about an account nobody has.
 */
function rateLimits(minute: number, now: number): Record<string, unknown> {
  const window = Math.floor(minute / WINDOW_MINUTES);
  const elapsed = minute % WINDOW_MINUTES;
  const peak = WINDOW_PEAKS[window % WINDOW_PEAKS.length];
  return {
    five_hour: {
      used_percentage: Math.round((peak * elapsed) / WINDOW_MINUTES),
      resets_at: Math.round((now + (WINDOW_MINUTES - elapsed) * 60_000) / 1000),
    },
    seven_day: {
      used_percentage: Math.round(29 + (14 * minute) / DEMO_MINUTES),
      // Mid-week: far enough out that the five-hour window above never rolls it over.
      resets_at: Math.round((now + 4.5 * 24 * 3600 * 1000) / 1000),
    },
  };
}

/** How full an actor's window is at `minute`, and `null` for one that has taken no turn yet. */
function contextAt(actor: Actor, minute: number): number | null {
  if (actor.fresh !== undefined && minute >= actor.fresh.from && minute < actor.fresh.to) return null;
  // A recycle does not reset the WORK an actor has done, so the ramp is measured from the
  // minute it was recycled rather than from midnight — otherwise a compacted session comes back
  // fuller than it was before, which is the opposite of what compacting does.
  const since = actor.fresh !== undefined && minute >= actor.fresh.from ? busyMinutes(actor, actor.fresh.from) : 0;
  return Math.min(97, Math.round(actor.ctxFrom + actor.ctxPerBusyMinute * (busyMinutes(actor, minute) - since)));
}

/**
 * One minute of the invented day, as the two sources would have been PARSED into it.
 *
 * `now` is what dates the reading, and it is separate from the minute being played: the live
 * view always shows the last minute of the day, dated by the clock that asked for it, so two
 * captures taken an hour apart are the same picture.
 */
export function demoFleetAt(minute: number, dayStart: number, now: number = dayStart + minute * 60_000): Fleet {
  const live = ACTORS.filter((a) => minute >= a.born);

  const sessions: Session[] = live.map((a) => {
    const segment = segmentAt(a, minute);
    return {
      sessionId: a.sid,
      pid: a.pid,
      cwd: a.cwd,
      name: a.name,
      kind: a.kind,
      startedAt: dayStart + a.born * 60_000,
      status: segment.status,
      waitingFor: segment.waitingFor ?? null,
      // The same rule the parser applies, spelled here rather than borrowed: a word it does not
      // recognise is `null`, never `false`, and `compacting` below is exactly such a word.
      busy: working(segment.status) ? true : segment.status === 'idle' || segment.status === 'done' ? false : null,
    };
  });

  const limits = rateLimits(minute, now);
  const snapshots = new Map<string, Snapshot>();
  for (const a of live) {
    const pct = contextAt(a, minute);
    snapshots.set(a.sid, {
      sessionId: a.sid,
      // The discriminant is the PRESENCE of the key, never its value: a session that has taken
      // no turn reads `fresh` and reports no percentage, which is not a session at zero.
      ctxState: pct === null ? 'fresh' : 'ok',
      ctxPct: pct,
      ctxTokens: pct === null ? null : Math.round((pct / 100) * CTX_WINDOW),
      ctxWindow: CTX_WINDOW,
      model: a.model.display_name,
      modelId: a.model.id,
      effort: a.effort,
      costUsd: round2(a.costPerBusyMinute * busyMinutes(a, minute)),
      ccVersion: CC_VERSION,
      rateLimits: limits,
      ageMs: a.ageMs,
      file: `${DEMO_HOME}/.local/state/tarmac/snapshots/${a.sid}.json`,
    });
  }

  // Discovery's own health, which a shortcut here would drop: without it `discovered` and
  // `noSessionId` are computed from the rows alone, and the page would report on a discovery
  // that never happened rather than on the one the demo is standing in for.
  const discovery: DiscoveryHealth = {
    seen: sessions.length,
    noSessionId: 0,
    unknownStatus: sessions.filter((s) => s.busy === null && s.status !== 'waiting').length,
  };

  const fleet = buildFleet({ sessions, snapshots, now, staleAfterMs: DEFAULT_STALE_AFTER_MS, discovery });
  // What the collector fills in, filled in here for the same reason it does it there: these
  // four are how the page tells "nothing to report" from "we could not look", and leaving them
  // undefined would render the second as the first.
  fleet.health.snapshotsError = null;
  fleet.health.snapshotsUnreadable = 0;
  fleet.health.snapshotsDuplicates = 0;
  fleet.health.snapshotsDir = `${DEMO_HOME}/.local/state/tarmac/snapshots`;
  return fleet;
}

/** The day ends now, so its last minute is the fleet the live view shows. */
export const demoDayStart = (now: number = Date.now()): number => now - (DEMO_MINUTES - 1) * 60_000;

/**
 * The record behind the scrubber, played in whole at startup.
 *
 * The same fleets the live view is built from, through the same `record` a real sampler calls —
 * so the replay is a reduction of the demo rather than a second account of it, kept in step by
 * hand. Nothing here touches disk: this is the in-memory ring, which is where a real serve's
 * last 24 hours live too.
 */
export function demoHistory(dayStart: number, cadence: number = HISTORY_CADENCE_MS): FleetHistory {
  const history = createHistory({ since: dayStart, cadence });
  for (let minute = 0; minute < DEMO_MINUTES; minute++) history.record(demoFleetAt(minute, dayStart));
  return history;
}

/**
 * What `serve --demo` reads instead of the machine.
 *
 * Always the last minute of the invented day, dated by the clock that asked: the fleet does not
 * walk on while a serve is open, so a screenshot of it now and one taken in an hour show the
 * same eight sessions doing the same things, with the account's two windows counting down from
 * whenever they were read rather than from a reset that has since gone past.
 *
 * The record behind the scrubber holds still too: a demo serve runs no sampler, so the day
 * seeded below is the day it keeps for as long as it is open.
 */
export function demoCollector(dayStart: number, now: () => number = Date.now): () => Promise<Fleet> {
  return () => Promise.resolve(demoFleetAt(DEMO_MINUTES - 1, dayStart, now()));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
