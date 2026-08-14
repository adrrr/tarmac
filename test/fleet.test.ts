import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFleet } from '../src/fleet.ts';
import type { Session } from '../src/sessions.ts';
import type { Snapshot } from '../src/snapshots.ts';

const NOW = 1786240000000;
const session = (over: Partial<Session> = {}): Session => ({
  sessionId: 's1',
  pid: 1,
  cwd: '/Users/jane/alpha',
  name: 'alpha-7a',
  kind: 'interactive',
  startedAt: NOW - 3600_000,
  status: 'idle',
  busy: false,
  ...over,
});
// A full Snapshot, not a subset of one: the join reads every field, so a fixture missing
// half of them would let a rename slip past this suite.
const telemetry = (over: Partial<Snapshot> = {}): Snapshot => ({
  sessionId: 's1',
  ctxState: 'ok',
  ctxPct: 26,
  ctxTokens: 256390,
  ctxWindow: null,
  model: 'Fable 5',
  modelId: null,
  effort: 'max',
  costUsd: 27.7,
  ccVersion: null,
  rateLimits: null,
  ageMs: 1000,
  file: '/tmp/snapshots/s1.json',
  ...over,
});

// The threshold is an opinion, and the one number that decides which readings get a `!`.
// It travels in `health` so that every renderer — table, page, /api/fleet — names the SAME
// threshold as the one the rows were judged against, instead of each keeping its own idea.
test('the threshold every "!" was judged against travels with the fleet', () => {
  const args = { sessions: [session()], snapshots: new Map([['s1', telemetry({ ageMs: 120_000 })]]), now: NOW };
  const dflt = buildFleet(args);
  assert.equal(dflt.health.staleAfterMs, 600_000, 'the constant that used to be private to this module');
  assert.equal(dflt.rows[0].stale, false);

  const tight = buildFleet({ ...args, staleAfterMs: 90_000 });
  assert.equal(tight.health.staleAfterMs, 90_000);
  assert.equal(tight.rows[0].stale, true, 'and the rows were judged against it');
  assert.equal(tight.health.stale, 1);
});

test('joins a session to its snapshot on sessionId', () => {
  const { rows } = buildFleet({ sessions: [session()], snapshots: new Map([['s1', telemetry()]]), now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ctxPct, 26);
  assert.equal(rows[0].model, 'Fable 5');
  assert.equal(rows[0].costUsd, 27.7);
  assert.equal(rows[0].busy, false);
});

test('derives a short project name from the working directory', () => {
  const { rows } = buildFleet({ sessions: [session()], snapshots: new Map(), now: NOW });
  assert.equal(rows[0].project, 'alpha');
});

test('computes uptime against the clock it is given, never Date.now()', () => {
  const { rows } = buildFleet({ sessions: [session()], snapshots: new Map(), now: NOW });
  assert.equal(rows[0].uptimeMs, 3600_000);
});

test('a session with no snapshot keeps its status and reports telemetry as absent', () => {
  const { rows } = buildFleet({ sessions: [session({ busy: true, status: 'busy' })], snapshots: new Map(), now: NOW });
  assert.equal(rows[0].busy, true);
  assert.equal(rows[0].ctxState, 'absent');
  assert.equal(rows[0].ctxPct, null, 'never a fabricated 0');
  assert.equal(rows[0].model, null);
});

test('a snapshot with no live session is dropped — dead sessions leave files behind', () => {
  const { rows } = buildFleet({ sessions: [], snapshots: new Map([['ghost', telemetry({ sessionId: 'ghost' })]]), now: NOW });
  assert.equal(rows.length, 0);
});

test('sorts busy sessions first, then by context descending', () => {
  const sessions = [
    session({ sessionId: 'a', busy: false, cwd: '/a' }),
    session({ sessionId: 'b', busy: false, cwd: '/b' }),
    session({ sessionId: 'c', busy: true, status: 'busy', cwd: '/c' }),
  ];
  const snapshots = new Map([
    ['a', telemetry({ sessionId: 'a', ctxPct: 10 })],
    ['b', telemetry({ sessionId: 'b', ctxPct: 80 })],
    ['c', telemetry({ sessionId: 'c', ctxPct: 5 })],
  ]);
  const { rows } = buildFleet({ sessions, snapshots, now: NOW });
  assert.deepEqual(rows.map((r) => r.sessionId), ['c', 'b', 'a']);
});

test('summarises coverage so a blind sensor is visible, not silent', () => {
  const sessions = [session({ sessionId: 'a' }), session({ sessionId: 'b' }), session({ sessionId: 'c' })];
  const snapshots = new Map([
    ['a', telemetry({ sessionId: 'a', ctxState: 'ok' })],
    ['b', telemetry({ sessionId: 'b', ctxState: 'drift', ctxPct: null })],
  ]);
  const { health } = buildFleet({ sessions, snapshots, now: NOW });
  assert.equal(health.sessions, 3);
  assert.equal(health.covered, 2);
  assert.equal(health.drift, 1);
});

// Since #7 the wrapper files a snapshot only for a session id shaped like the UUID Claude
// Code emits, so "no telemetry" now has two causes that look identical on the row and are
// opposite in what the user should do: a frame not yet drawn, which one frame fixes, and an
// id this tool will never file, which no install and no frame will ever fix. Counting them
// apart is what stops `list` from printing remediation that cannot work.
test('counts the live sessions whose id it can never file a snapshot for', () => {
  const sessions = [
    session({ sessionId: 'ea6a607c-42e0-4773-af4d-ae5f5938d819' }),
    session({ sessionId: 'test-session-abc' }),
    session({ sessionId: null }),
  ];
  const { health } = buildFleet({ sessions, snapshots: new Map(), now: NOW });
  assert.equal(health.covered, 0, 'none of them has telemetry');
  assert.equal(health.unfilable, 1, 'and exactly one of them never will');
});

// …and it counts only the ones that are actually BLIND. A session can be unfilable and
// covered at once: the residue `docs/MANUAL.md` documents — a snapshot filed by a pre-upgrade
// wrapper under a non-UUID name — is still read, because the reader keys on the `session_id`
// inside the file, not on the filename. Counted without that clause, such a session inflates
// `unfilable` past the number of blind ones, and the renderers — which read the two as
// "how many of the blind will never be filed" — then explain away a DIFFERENT session's
// missing telemetry and drop the `tarmac install` advice from the one session it was for.
test('does not count a session whose legacy snapshot is still being read', () => {
  const sessions = [session({ sessionId: 'ea6a607c-42e0-4773-af4d-ae5f5938d819' }), session({ sessionId: 'test-session-abc' })];
  const snapshots = new Map([['test-session-abc', telemetry({ sessionId: 'test-session-abc', ctxState: 'ok' })]]);
  const { health } = buildFleet({ sessions, snapshots, now: NOW });
  assert.equal(health.covered, 1, 'the legacy file still reads');
  assert.equal(health.unfilable, 0, 'so nothing here is blind for want of a filable id');
});

test('flags total drift as a schema break, not a per-session hiccup', () => {
  const sessions = [session({ sessionId: 'a' }), session({ sessionId: 'b' })];
  const snapshots = new Map([
    ['a', telemetry({ sessionId: 'a', ctxState: 'drift', ctxPct: null })],
    ['b', telemetry({ sessionId: 'b', ctxState: 'drift', ctxPct: null })],
  ]);
  const { health } = buildFleet({ sessions, snapshots, now: NOW });
  assert.equal(health.schemaBroken, true);
});

test('a fleet of fresh sessions is not a schema break', () => {
  const sessions = [session({ sessionId: 'a' }), session({ sessionId: 'b' })];
  const snapshots = new Map([
    ['a', telemetry({ sessionId: 'a', ctxState: 'fresh', ctxPct: null })],
    ['b', telemetry({ sessionId: 'b', ctxState: 'fresh', ctxPct: null })],
  ]);
  assert.equal(buildFleet({ sessions, snapshots, now: NOW }).health.schemaBroken, false);
});

test('an unknown status counts as unknown, and is never reported as idle', () => {
  const sessions = [session({ status: 'working', busy: null })];
  const { rows, health } = buildFleet({ sessions, snapshots: new Map(), now: NOW });
  assert.equal(rows[0].busy, null);
  assert.equal(health.unknownStatus, 1);
});

// I1: the number is only ever "as of" the last TUI frame. A live session whose terminal
// stopped drawing keeps its last value on screen, indistinguishable from a fresh one —
// four of seven numbers in the first live demo were hours old and unmarked.
test('marks a context reading older than the staleness threshold', () => {
  const snapshots = new Map([['s1', telemetry({ ageMs: 4 * 3600_000 })]]);
  const { rows } = buildFleet({ sessions: [session()], snapshots, now: NOW, staleAfterMs: 600_000 });
  assert.equal(rows[0].stale, true);
  assert.equal(rows[0].ctxPct, 26, 'the value is still reported — with its age, not hidden');
});

test('does not mark a fresh reading as stale', () => {
  const snapshots = new Map([['s1', telemetry({ ageMs: 30_000 })]]);
  const { rows } = buildFleet({ sessions: [session()], snapshots, now: NOW, staleAfterMs: 600_000 });
  assert.equal(rows[0].stale, false);
});

test('counts the stale readings so the header can say so', () => {
  const sessions = [session({ sessionId: 'a' }), session({ sessionId: 'b' })];
  const snapshots = new Map([
    ['a', telemetry({ sessionId: 'a', ageMs: 4 * 3600_000 })],
    ['b', telemetry({ sessionId: 'b', ageMs: 1000 })],
  ]);
  const { health } = buildFleet({ sessions, snapshots, now: NOW, staleAfterMs: 600_000 });
  assert.equal(health.stale, 1);
});

// I2: parseAgents counts entries it could not identify; dropping that count on the floor
// turns a renamed `sessionId` into "No Claude Code sessions found".
test('carries the discovery blind spots into the fleet health', () => {
  const { health } = buildFleet({
    sessions: [session()],
    snapshots: new Map(),
    now: NOW,
    discovery: { seen: 8, noSessionId: 7, unknownStatus: 0 },
  });
  assert.equal(health.noSessionId, 7);
  assert.equal(health.discovered, 8);
});

test('reports no discovery blind spots when there are none', () => {
  const { health } = buildFleet({ sessions: [session()], snapshots: new Map(), now: NOW });
  assert.equal(health.noSessionId, 0);
});

// I5: a sum over 3 of 7 sessions is not the fleet's cost.
test('reports no fleet cost at all when nothing is covered', () => {
  const { health } = buildFleet({ sessions: [session()], snapshots: new Map(), now: NOW });
  assert.equal(health.costUsd, null);
});

test('totals the fleet cost from the snapshots that have one', () => {
  const sessions = [session({ sessionId: 'a' }), session({ sessionId: 'b' })];
  const snapshots = new Map([
    ['a', telemetry({ sessionId: 'a', costUsd: 1.5 })],
    ['b', telemetry({ sessionId: 'b', costUsd: 2.25 })],
  ]);
  const { health } = buildFleet({ sessions, snapshots, now: NOW });
  assert.equal(health.costUsd, 3.75);
  assert.equal(health.costReporting, 2, 'both sessions really carried a cost');
});

// I8: having a snapshot and having a cost are different facts. A payload with no `cost`
// key was contributing a confident 0 to the total AND counting as covered, so the header
// printed the sum unqualified — a partial sum presented as the fleet's cost.
test('a session whose payload carries no cost adds nothing and is not counted as reporting', () => {
  const sessions = [session({ sessionId: 'a' }), session({ sessionId: 'b' })];
  const snapshots = new Map([
    ['a', telemetry({ sessionId: 'a', costUsd: 12.5 })],
    ['b', telemetry({ sessionId: 'b', costUsd: null })],
  ]);
  const { health } = buildFleet({ sessions, snapshots, now: NOW });
  assert.equal(health.costUsd, 12.5);
  assert.equal(health.costReporting, 1, 'one of the two sessions reported a cost');
  assert.equal(health.covered, 2, 'both are still covered — coverage is about telemetry, not cost');
});

test('reports no fleet cost when a covered session carries none — never $0.00', () => {
  const { health } = buildFleet({
    sessions: [session()],
    snapshots: new Map([['s1', telemetry({ costUsd: null })]]),
    now: NOW,
  });
  assert.equal(health.costUsd, null, '"no cost was measured" is not "$0.00"');
  assert.equal(health.costReporting, 0);
});

// The opposite mistake would be as bad: a session that has genuinely cost nothing yet must
// still be able to say so.
test('a measured zero is a measurement and is reported as one', () => {
  const { health } = buildFleet({
    sessions: [session()],
    snapshots: new Map([['s1', telemetry({ costUsd: 0 })]]),
    now: NOW,
  });
  assert.equal(health.costUsd, 0);
  assert.equal(health.costReporting, 1);
});

// I7: the guard reads the version off the LIVE snapshots — the ones actually joined to a
// session. A recycled fleet leaves dead files behind, and a dead file's version is not the
// fleet's.
test('carries a schema guard built from the versions the live sessions report', () => {
  const { health } = buildFleet({
    sessions: [session()],
    snapshots: new Map([['s1', telemetry({ ccVersion: '2.2.0' })]]),
    now: NOW,
  });
  assert.equal(health.schemaGuard.state, 'unchecked');
  assert.deepEqual(health.schemaGuard.versions, ['2.2.0']);
});

test('a ghost snapshot from a version nobody runs cannot raise the guard', () => {
  const { health } = buildFleet({
    sessions: [],
    snapshots: new Map([['ghost', telemetry({ sessionId: 'ghost', ccVersion: '9.9.9' })]]),
    now: NOW,
  });
  assert.equal(health.schemaGuard.state, 'nothing');
});

test('reports nothing reporting when no session is covered at all', () => {
  const { health } = buildFleet({ sessions: [session()], snapshots: new Map(), now: NOW });
  assert.equal(health.costReporting, 0);
});
