// The fleet the README's screenshots and GIF are taken of — a whole invented day of it.
//
//   node scripts/demo-fleet.ts [port]
//
// Why this exists at all: "Nothing real enters the repo" (CLAUDE.md) is easy to hold for a
// fixture, which someone reads, and hard to hold for a screenshot, which nobody diffs. A
// capture taken of the maintainer's own machine carries working directories, session names —
// which for a background session is the prompt somebody typed — and a cost. So the pixels in
// `docs/media/` are taken of THIS, every value of it written down here, and
// `test/demo-fleet.test.ts` is what it is held to.
//
// What is NOT invented is anything downstream of the two sources. This serves the real
// `createFleetServer`, reading through the real `collectFleet`, off a real `claude agents
// --json` (a shell script, exactly as CI's artefact job does it) and real payload files on
// disk. Every pixel a capture keeps was rendered by src/render.ts from a fleet that went
// through every join the product has. The demo replaces the two documented surfaces and
// nothing above them.
//
// How the captures in `docs/media/` are taken off it, so the other half of the recipe is not
// in one person's shell history: Chrome headless over the DevTools protocol on `/map`, a 1100
// CSS-pixel viewport at device scale 2, and `prefers-color-scheme` emulated for each theme.
// The stills also emulate `prefers-reduced-motion: reduce`, where the page draws the halo at
// rest — it is a 1.6s one-shot otherwise, so a still taken at any other moment has none. The
// GIF's frames are the scrubber stepped across the record by assigning `#scrub.value` through
// the native setter and dispatching `input`, which is what the page listens to, then scaled
// down to 1100 and quantised to one palette for the whole animation.
//
// Dev tooling: not in `files`, so it never ships. It writes only inside a temp directory of
// its own, removes it on the way out, and reads nothing from the home it runs in.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectFleet } from '../src/collect.ts';
import { createFleetServer, listenFleetServer } from '../src/server.ts';
import { HISTORY_SLOTS } from '../src/history.ts';
import type { Fleet } from '../src/fleet.ts';

/** The invented home every path in this file hangs off. Never `os.homedir()`, ever. */
export const DEMO_HOME = '/Users/jane';

/**
 * How many minutes of fleet the demo plays out. One more than the ring holds (1440), so the
 * record served to the scrubber has dropped a slot and reports the span it really covers
 * rather than the moment the process started.
 */
export const DEMO_MINUTES = 1441;

/** The Claude Code whose payload shapes this repo has fixtures for, so nothing is unchecked. */
const CC_VERSION = '2.1.232';

/** The five-hour window, in minutes — the thing the GIF is really about. */
const WINDOW_MINUTES = 300;

/** How full each successive five-hour window gets. A day is not four identical afternoons. */
const WINDOW_PEAKS = [62, 88, 74, 55, 79];

export interface DemoSnapshot {
  /**
   * A statusline payload: the keys tarmac reads, spelled as
   * `fixtures/statusline-payload-2.1.232-live.json` froze them. A subset of that file and
   * never a superset — a key no capture has ever carried would be this repo inventing the
   * shape it claims only to have observed.
   */
  payload: Record<string, unknown>;
  /** How old the file is at this minute — a session's terminal draws when it draws. */
  ageMs: number;
}

export interface DemoSources {
  agents: Record<string, unknown>[];
  snapshots: DemoSnapshot[];
}

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
  /** The minute it appears, and the minute it is gone — a fleet that never moves is a still. */
  born: number;
  dies: number;
  /** Context percent at its first turn, and how fast the window fills while it works. */
  ctxFrom: number;
  ctxPerBusyMinute: number;
  /** Dollars per minute of work. Cost accrues while a session is working and not otherwise. */
  costPerBusyMinute: number;
  /** How old its snapshot is whenever it is read — a terminal nobody is looking at draws less. */
  ageMs: number;
  segments: Segment[];
  /**
   * A minute range this session has taken no turn in — `used_percentage: null`, the "no turn
   * yet" dial. One session recycles mid-day so the replay has one to walk past.
   */
  fresh?: { from: number; to: number };
}

// Five sessions, two of which are not there at midnight, and one of which is a background
// agent placed beside the session sharing its directory. The names are the fixtures' standard:
// invented projects under an invented home, and an agent named after the prompt it was given.
const ACTORS: Actor[] = [
  {
    sid: '3a91c7d2-5e48-4f06-8b13-97d40a62e5f1',
    cwd: `${DEMO_HOME}/harbor`,
    name: 'harbor-3f',
    kind: 'interactive',
    pid: 30412,
    model: { id: 'claude-fable-5', display_name: 'Fable 5' },
    effort: 'max',
    born: 0,
    dies: DEMO_MINUTES,
    ctxFrom: 6,
    ctxPerBusyMinute: 0.14,
    costPerBusyMinute: 0.052,
    ageMs: 2_000,
    // The recycle at 700 is why the ramp restarts: a compacted session is a new window.
    fresh: { from: 700, to: 707 },
    segments: [
      { from: 0, status: 'idle' },
      { from: 95, status: 'busy' },
      { from: 700, status: 'idle' },
      { from: 712, status: 'busy' },
      { from: 1051, status: 'idle' },
      { from: 1181, status: 'busy' },
    ],
  },
  {
    sid: 'c48b2d19-7f0a-4c65-9b3e-5da0117c8e44',
    cwd: `${DEMO_HOME}/projects/atlas`,
    name: 'atlas-90',
    kind: 'interactive',
    pid: 31877,
    model: { id: 'claude-opus-5', display_name: 'Opus 5' },
    effort: 'high',
    born: 0,
    dies: DEMO_MINUTES,
    ctxFrom: 12,
    ctxPerBusyMinute: 0.09,
    costPerBusyMinute: 0.031,
    ageMs: 96_000,
    segments: [
      { from: 0, status: 'idle' },
      { from: 260, status: 'busy' },
      { from: 421, status: 'idle' },
      { from: 901, status: 'busy' },
      { from: 1011, status: 'idle' },
    ],
  },
  {
    sid: '2f5c8a04-6d31-42f7-b0aa-9e7c4415d8b1',
    cwd: `${DEMO_HOME}/harbor`,
    name: 'sweep the flaky specs',
    kind: 'background',
    pid: null,
    model: { id: 'claude-fable-5', display_name: 'Fable 5' },
    effort: 'max',
    born: 300,
    dies: DEMO_MINUTES,
    ctxFrom: 4,
    ctxPerBusyMinute: 0.05,
    costPerBusyMinute: 0.018,
    ageMs: 4_000,
    segments: [{ from: 300, status: 'working' }],
  },
  {
    // The one that is gone by the end: an agent finishes and leaves the fleet, which is a
    // thing a replay can show and a screenshot cannot.
    sid: 'b6042ae7-3c15-49d8-8f7a-0c2b5e91d374',
    cwd: `${DEMO_HOME}/projects/atlas`,
    name: 'rewrite the changelog entry',
    kind: 'background',
    pid: null,
    model: { id: 'claude-opus-5', display_name: 'Opus 5' },
    effort: 'high',
    born: 611,
    dies: 883,
    ctxFrom: 5,
    ctxPerBusyMinute: 0.07,
    costPerBusyMinute: 0.021,
    ageMs: 6_000,
    segments: [{ from: 611, status: 'working' }],
  },
  {
    sid: '8c1f6b70-49d2-4e83-a5c7-b21e0f9d3a64',
    cwd: `${DEMO_HOME}/beacon`,
    name: 'beacon-8c',
    kind: 'interactive',
    pid: 42713,
    model: { id: 'claude-opus-5', display_name: 'Opus 5' },
    effort: 'medium',
    born: 521,
    dies: DEMO_MINUTES,
    ctxFrom: 3,
    ctxPerBusyMinute: 0.08,
    costPerBusyMinute: 0.027,
    ageMs: 41_000,
    segments: [
      { from: 521, status: 'busy' },
      // The one state that is work for the reader, and the only one that captions itself.
      { from: 1291, status: 'waiting', waitingFor: 'permission prompt' },
    ],
  },
  {
    sid: '5d7e0a36-1b84-4c92-af03-6e8d21b7c405',
    cwd: `${DEMO_HOME}/quay`,
    name: 'quay-5d',
    kind: 'interactive',
    pid: 44120,
    model: { id: 'claude-fable-5', display_name: 'Fable 5' },
    effort: 'high',
    born: 1103,
    dies: DEMO_MINUTES,
    ctxFrom: 2,
    ctxPerBusyMinute: 0.11,
    costPerBusyMinute: 0.044,
    ageMs: 3_000,
    segments: [
      { from: 1103, status: 'idle' },
      { from: 1150, status: 'busy' },
      // A word `claude agents --json` prints and tarmac has no boolean for. It draws as
      // `unknown`, never as idle, and the page says so above the fleet — which is the whole
      // promise of the tool, so the capture shows it rather than a fleet with nothing to say.
      { from: 1241, status: 'compacting' },
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
 * The account's two windows at `minute`. The five-hour one is the reason the GIF exists: it
 * fills, rolls over at the boundary and starts again, four or five times in a day, and a
 * replay counts its reset from the minute being shown rather than from now.
 */
function rateLimits(minute: number, dayStart: number): Record<string, unknown> {
  const window = Math.floor(minute / WINDOW_MINUTES);
  const elapsed = minute % WINDOW_MINUTES;
  const peak = WINDOW_PEAKS[window % WINDOW_PEAKS.length];
  return {
    five_hour: {
      used_percentage: Math.round((peak * elapsed) / WINDOW_MINUTES),
      resets_at: Math.round((dayStart + (window + 1) * WINDOW_MINUTES * 60_000) / 1000),
    },
    seven_day: {
      used_percentage: Math.round(31 + (12 * minute) / DEMO_MINUTES),
      // Mid-week: far enough out that the day above never rolls it over.
      resets_at: Math.round((dayStart + 5.5 * 24 * 3600 * 1000) / 1000),
    },
  };
}

/**
 * Both documented surfaces, as they would read at one minute of the invented day.
 *
 * Pure, and separate from the writing below, because it is what the suite holds to the red
 * line: a demo is only worth having if what it publishes can be asserted.
 */
export function demoMinute(minute: number, dayStart: number): DemoSources {
  const live = ACTORS.filter((a) => minute >= a.born && minute < a.dies);
  const limits = rateLimits(minute, dayStart);

  const agents = live.map((a) => {
    const segment = segmentAt(a, minute);
    const startedAt = dayStart + a.born * 60_000;
    // A background agent carries no `status` and no `pid`: its word lives under `state`, and
    // its id is echoed short. Both shapes are the ones frozen in `fixtures/`.
    return a.kind === 'background'
      ? { id: a.sid.slice(0, 8), cwd: a.cwd, kind: a.kind, startedAt, sessionId: a.sid, name: a.name, state: segment.status }
      : {
          pid: a.pid,
          cwd: a.cwd,
          kind: a.kind,
          startedAt,
          sessionId: a.sid,
          name: a.name,
          status: segment.status,
          ...(segment.waitingFor === undefined ? {} : { waitingFor: segment.waitingFor }),
        };
  });

  const snapshots = live.map((a) => {
    const recycled = a.fresh !== undefined && minute >= a.fresh.from;
    const since = recycled ? busyMinutes(a, a.fresh!.from) : 0;
    // A session that has taken no turn since its recycle has the KEY, holding null. That is
    // "no turn yet" — a dotted dial — and it is not the same nothing as a missing key.
    const noTurnYet = a.fresh !== undefined && minute >= a.fresh.from && minute < a.fresh.to;
    const pct = noTurnYet
      ? null
      : Math.min(97, Math.round(a.ctxFrom + a.ctxPerBusyMinute * (busyMinutes(a, minute) - since)));
    const tokens = pct === null ? null : Math.round((pct / 100) * 1_000_000);
    return {
      ageMs: a.ageMs,
      payload: {
        session_id: a.sid,
        transcript_path: `${DEMO_HOME}/.claude/projects/${a.cwd.replaceAll('/', '-')}/${a.sid}.jsonl`,
        cwd: a.cwd,
        effort: { level: a.effort },
        session_name: a.name,
        model: a.model,
        workspace: { current_dir: a.cwd, project_dir: a.cwd, added_dirs: [] },
        version: CC_VERSION,
        output_style: { name: 'default' },
        cost: { total_cost_usd: round2(a.costPerBusyMinute * busyMinutes(a, minute)) },
        context_window: {
          context_window_size: 1_000_000,
          // `null`, not `{}`: it is what the frozen "no turn yet" payload carries, and the two
          // only reach `sumUsage` alike by accident.
          current_usage:
            tokens === null
              ? null
              : {
                  input_tokens: 4,
                  output_tokens: 2048,
                  cache_creation_input_tokens: 1948,
                  cache_read_input_tokens: Math.max(0, tokens - 4000),
                },
          used_percentage: pct,
        },
        rate_limits: limits,
      },
    };
  });

  return { agents, snapshots };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ── the serve ─────────────────────────────────────────────────────────────────────────────

/**
 * How fast the demo plays the day into the ring. The cadence a real serve samples at is one
 * minute and deliberately not a knob (history.ts), so a day of it is a day of waiting; the
 * server takes an interval as a dependency for exactly this reason, and the suite uses the
 * same seam. Comfortably longer than a collect takes, because a tick that finds the previous
 * read still running costs a slot and the record would come out with holes it never had.
 */
const PRIME_EVERY_MS = 45;

async function main(): Promise<void> {
  const asked = process.argv[2];
  const port = Number(asked ?? 4478);
  if (!Number.isInteger(port) || port < 1 || port > 65535) die(`not a port: ${asked}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-demo-'));
  // Ctrl-C is how this ends, and a demo that leaves an invented fleet on disk every time it is
  // run is the kind of litter nobody goes looking for.
  process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));
  const snapshotsDir = path.join(root, 'snapshots');
  fs.mkdirSync(snapshotsDir);
  const agentsFile = path.join(root, 'agents.json');
  const claudeBin = path.join(root, 'claude');
  // The same one-line stand-in CI's artefact job uses. `claude agents --json` is a documented
  // surface, so a script that prints one is a legitimate implementation of it.
  fs.writeFileSync(claudeBin, `#!/bin/sh\nexec cat ${JSON.stringify(agentsFile)}\n`);
  fs.chmodSync(claudeBin, 0o755);

  // The day ends now, so the last minute of the record is the fleet the live view is showing.
  const dayStart = Date.now() - (DEMO_MINUTES - 1) * 60_000;
  const publish = (minute: number, clock: number): void => {
    const { agents, snapshots } = demoMinute(minute, dayStart);
    fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
    for (const { payload, ageMs } of snapshots) {
      const file = path.join(snapshotsDir, `${payload.session_id as string}.json`);
      fs.writeFileSync(file, JSON.stringify(payload, null, 2));
      // The age is the whole point of a snapshot: it is what decides stale, and the halo.
      const at = (clock - ageMs) / 1000;
      fs.utimesSync(file, at, at);
    }
  };

  let minute = 0;
  let priming = true;
  const collect = async (): Promise<Fleet> => {
    // Clamped, and that is not belt and braces. The sampler and the watcher below are two
    // timers 5ms apart, so a tick lands past the end about half the time — and minute 1441 is
    // a day after every actor's last, which is a fleet with nothing in it. It would go into
    // the ring as the newest thing there, and the right-hand end of the scrubber would be an
    // empty map. Nothing was watching, which is the other half of the bug.
    const m = priming ? Math.min(minute, DEMO_MINUTES - 1) : DEMO_MINUTES - 1;
    // While priming, every read the sampler takes is one minute later than the last. Once the
    // day is in, the fleet stops moving and is dated by the real clock, so the live view is
    // honestly fresh — halos and all — while the record behind the scrubber holds still.
    const clock = priming ? dayStart + m * 60_000 : Date.now();
    publish(m, clock);
    if (priming) minute += 1;
    return collectFleet({ claudeBin, snapshotsDir, now: clock });
  };

  const server = createFleetServer({ collect, sampleEveryMs: PRIME_EVERY_MS });
  // A port nobody chose may walk, exactly as `serve`'s does: 4478 is only "not the port a real
  // serve is on", and refusing to start because a demo was left running is not worth the
  // refusal. A port typed on the command line is a decision, and decisions are honoured.
  const listening = await listenFleetServer(server, { port, source: asked === undefined ? 'default' : 'flag' });

  process.stderr.write(`demo-fleet: playing ${DEMO_MINUTES} minutes into the record…\n`);
  await new Promise<void>((resolve) => {
    const done = setInterval(() => {
      if (minute < DEMO_MINUTES) return;
      clearInterval(done);
      priming = false;
      // The record stops here, and this is how. `close` is the only shutdown `createFleetServer`
      // documents, and its handler clears the sampler without touching the socket — so the serve
      // goes on answering a fleet that no longer moves. Left running, the ring would eat its own
      // oldest minutes at a slot every 45ms while a capture was being taken, and the two
      // screenshots would disagree with the sentence printed under them.
      server.emit('close');
      resolve();
    }, 50);
  });

  const record = (await fetch(`http://127.0.0.1:${listening.port}/api/history`).then((r) => r.json())) as {
    since: number;
    samples: { t: number; sessions: unknown[] }[];
    missed: number;
  };
  // Checked rather than assumed. Each of these has been wrong at least once while this file was
  // being written, and none of them is visible in a screenshot: a record with holes in it, a
  // record that stopped short of a day, and a newest minute nobody lives in.
  if (record.samples.length !== HISTORY_SLOTS || record.missed !== 0) {
    die(`the record came out as ${record.samples.length} readings and ${record.missed} missed, not a clean ${HISTORY_SLOTS}`);
  }
  const newest = record.samples[record.samples.length - 1];
  if (newest.sessions.length === 0) die('the newest minute in the record holds no sessions');
  const covered = Math.round((newest.t - record.since) / 60_000);
  process.stderr.write(`demo-fleet: ${record.samples.length} readings covering ${covered} minutes, none missed\n`);
  process.stdout.write(`tarmac serving http://127.0.0.1:${listening.port}\n`);
}

function die(message: string): never {
  process.stderr.write(`demo-fleet: ${message}\n`);
  process.exit(1);
}

// Importable for the suite, runnable for a capture: only a direct run starts a server.
// `pathToFileURL` rather than a template literal: the difference between running and silently
// doing nothing from a path with a space in it.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => die(e instanceof Error ? e.message : String(e)));
}
