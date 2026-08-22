import test from 'node:test';
import assert from 'node:assert/strict';
import { accountLimits, buildFleet, busyOnStaleFleet } from '../src/fleet.ts';
import { row } from './fleet-fixtures.ts';
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
  waitingFor: null,
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

// `claude agents --json` prints "active sessions (interactive and background)", and `kind`
// is the only thing in the payload that tells the two apart. Dropping it made every
// background agent look like a terminal someone is sitting at.
test('carries the session kind, so a background agent is not read as a terminal', () => {
  const sessions = [session({ sessionId: 'a' }), session({ sessionId: 'b', kind: 'background' })];
  const { rows } = buildFleet({ sessions, snapshots: new Map(), now: NOW });
  assert.deepEqual(rows.map((r) => r.kind).sort(), ['background', 'interactive']);
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

// The sort decides one thing: what is on screen without scrolling. A waiting session used to
// be filed with `unknown` — one bucket below busy, on a fleet where busy is most of the rows —
// which put the only session that has STOPPED for a human under the fold of the map that #46
// gave it a hue on. It goes first: it is the one row that is work for the reader, and there
// are never many of it, so the sessions it displaces move down by a row or two.
test('sorts the session blocked on a human first, then busy, then unknown, then idle', () => {
  const sessions = [
    session({ sessionId: 'idle', busy: false, cwd: '/idle' }),
    session({ sessionId: 'unknown', busy: null, status: 'compacting', cwd: '/unknown' }),
    session({ sessionId: 'busy', busy: true, status: 'busy', cwd: '/busy' }),
    session({ sessionId: 'waiting', busy: null, status: 'waiting', waitingFor: 'permission prompt', cwd: '/waiting' }),
  ];
  // The percentages run the other way on purpose: each session is above the one it must sort
  // below, so a rank that ties any pair together hands the tiebreak the wrong order.
  const snapshots = new Map([
    ['idle', telemetry({ sessionId: 'idle', ctxPct: 90 })],
    ['unknown', telemetry({ sessionId: 'unknown', ctxPct: 70 })],
    ['busy', telemetry({ sessionId: 'busy', ctxPct: 50 })],
    ['waiting', telemetry({ sessionId: 'waiting', ctxPct: 10 })],
  ]);
  const { rows } = buildFleet({ sessions, snapshots, now: NOW });
  assert.deepEqual(rows.map((r) => r.sessionId), ['waiting', 'busy', 'unknown', 'idle']);
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
  const sessions = [session({ status: 'transmogrifying', busy: null })];
  const { rows, health } = buildFleet({ sessions, snapshots: new Map(), now: NOW });
  assert.equal(rows[0].busy, null);
  assert.equal(health.unknownStatus, 1);
});

// The reason travels with the row, because the row is what both surfaces draw from. The
// reader already refuses to answer the boolean for a waiting session; this is the other half
// of not answering it — the field that says what would answer it.
test('a waiting session brings the reason it is waiting onto its row', () => {
  const sessions = [session({ status: 'waiting', waitingFor: 'permission prompt', busy: null })];
  const { rows } = buildFleet({ sessions, snapshots: new Map(), now: NOW });
  assert.equal(rows[0].status, 'waiting');
  assert.equal(rows[0].waitingFor, 'permission prompt');
});

// This count is what raises "N session(s) report a status tarmac does not know" on both
// surfaces, and it is recomputed here from the rows rather than taken from discovery — so a
// waiting session excused one module down would be accused again one module up.
test('a waiting session is not one of the statuses tarmac does not know', () => {
  const sessions = [
    session({ sessionId: 'a', status: 'waiting', waitingFor: 'input needed', busy: null }),
    session({ sessionId: 'b', status: 'transmogrifying', busy: null }),
  ];
  const { health } = buildFleet({ sessions, snapshots: new Map(), now: NOW });
  assert.equal(health.unknownStatus, 1, 'the transmogrifying one, and only it');
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

// ── the account, out of sessions that disagree about it ─────────────────────────────────
//
// One account, read at whatever moment each session last drew a frame — so the rows usually do
// not carry contradicting numbers, they carry the same number at different ages, and the
// youngest is the one still true. Three readers depend on this rule: the ring, which samples it
// every minute, the header gauges, and the line under `tarmac list`.

/** A window still open at the fleet's clock, so nothing here is judged as rolled over. */
const open = (secondsOut: number): number => NOW / 1000 + secondsOut;

test('the account limits are the freshest reading that carried them', () => {
  const limits = accountLimits(
    [
      row({ snapshotAgeMs: 90_000, rateLimits: { five_hour: { used_percentage: 17 } } }),
      row({ sessionId: 's2', snapshotAgeMs: 1200, rateLimits: { five_hour: { used_percentage: 42 } } }),
    ],
    NOW,
  );
  assert.equal(limits!.rateLimits.five_hour.used_percentage, 42);
  assert.equal(limits!.ageMs, 1200, 'and it carries the age of the reading it came from');
});

// The same value `map.ts` refuses to call an age: a snapshot dated after the clock that read
// it (an NTP correction, a mount running ahead) is not the youngest reading, and letting it
// win would misreport the account's limits for as long as the skew lasts.
test('a snapshot dated in the future does not get to be the freshest reading', () => {
  const limits = accountLimits(
    [
      row({ snapshotAgeMs: -600_000, rateLimits: { five_hour: { used_percentage: 3 } } }),
      row({ sessionId: 's2', snapshotAgeMs: 1200, rateLimits: { five_hour: { used_percentage: 91 } } }),
    ],
    NOW,
  );
  assert.equal(limits!.rateLimits.five_hour.used_percentage, 91);
});

test('a fleet whose snapshots carry no rate limits reports the account as absent, never as zero', () => {
  assert.equal(accountLimits([row(), row({ sessionId: 's2' })], NOW), null);
});

// An undated reading is not a young one. A row with no snapshot at all has no age to be
// judged by, and it carries no limits either — but the pair must not be reachable.
test('a row with no snapshot age cannot be the freshest reading', () => {
  const limits = accountLimits(
    [
      row({ snapshotAgeMs: null, rateLimits: { five_hour: { used_percentage: 5 } } }),
      row({ sessionId: 's2', snapshotAgeMs: 60_000, rateLimits: { five_hour: { used_percentage: 88 } } }),
    ],
    NOW,
  );
  assert.equal(limits!.rateLimits.five_hour.used_percentage, 88);
});

// Freshest AND measured, in that order — a session that has just started is guaranteed to be
// the youngest snapshot on the machine, and it is the one most likely to carry a window whose
// number has not been taken yet. Letting it win blanked an account three other sessions were
// reporting: "no reading" said of a fleet that had one.
test('a fresher reading that measured nothing does not blank an account the fleet did read', () => {
  const limits = accountLimits(
    [
      row({ snapshotAgeMs: 500, rateLimits: { five_hour: { used_percentage: null }, seven_day: { used_percentage: null } } }),
      row({ sessionId: 's2', snapshotAgeMs: 60_000, rateLimits: { five_hour: { used_percentage: 88 } } }),
    ],
    NOW,
  );
  assert.equal(limits!.rateLimits.five_hour.used_percentage, 88);
  assert.equal(limits!.ageMs, 60_000, 'and it is dated as the reading it really is');
});

test('a fleet where nothing was measured still reports its freshest reading, so the surfaces can say so', () => {
  const limits = accountLimits([row({ snapshotAgeMs: 500, rateLimits: { five_hour: { used_percentage: null } } })], NOW);
  assert.equal(limits!.readings, 0, 'nothing measured the account');
  assert.equal(limits!.ageMs, 500);
});

// Which reading was drawn is half the story; the other half is whether the ones behind it
// were about the same windows. A percentage that moved between two frames is not a
// disagreement — a window open at the same time as another one is, and it is the shape both a
// second account and a clock nobody can explain arrive in. Silently keeping the youngest was
// this function's whole contract, and it is what the header would have gone on doing over two
// accounts.
test('readings that name the same windows are one account read twice, and nothing is apart', () => {
  const rl = (pct: number): Record<string, any> => ({
    five_hour: { used_percentage: pct, resets_at: open(8040) },
    seven_day: { used_percentage: 42, resets_at: open(300_000) },
  });
  const limits = accountLimits(
    [row({ snapshotAgeMs: 90_000, rateLimits: rl(17) }), row({ sessionId: 's2', snapshotAgeMs: 1200, rateLimits: rl(61) })],
    NOW,
  );
  assert.equal(limits!.apart, 0);
  assert.deepEqual(limits!.apartWindows, []);
  assert.equal(limits!.readings, 2, 'and it says how many readings stood behind the one shown');
});

// One reading disagreeing on BOTH windows, because that is the shape a second account arrives
// in — a login of its own has a five-hour and a seven-day boundary, and neither is this one's.
// It is still ONE reading apart: the count is of readings, the windows are a set beside it, and
// a count that moved with the windows would read as two sessions where there is one.
test('a reading that names other windows, open at the same time, is one reading apart and each window named', () => {
  const limits = accountLimits(
    [
      row({
        snapshotAgeMs: 90_000,
        rateLimits: { five_hour: { used_percentage: 17, resets_at: open(600) }, seven_day: { used_percentage: 33, resets_at: open(150_000) } },
      }),
      row({
        sessionId: 's2',
        snapshotAgeMs: 1200,
        rateLimits: { five_hour: { used_percentage: 61, resets_at: open(8040) }, seven_day: { used_percentage: 42, resets_at: open(300_000) } },
      }),
    ],
    NOW,
  );
  assert.equal(limits!.rateLimits.five_hour.used_percentage, 61, 'the freshest is still the one shown');
  assert.equal(limits!.apart, 1, 'one reading, however many of its windows are elsewhere');
  assert.equal(limits!.apartWindows.length, 2, 'and both of them are named');
  assert.deepEqual(limits!.apartWindows, ['five_hour', 'seven_day']);
  assert.equal(limits!.readings, 2);
});

// The fleet shape this must stay quiet on, or it is a warning every night: a session that has
// not drawn a frame since before the window rolled over carries the window it was taken in.
test('a reading whose window has rolled over is not counted apart, however far behind it is', () => {
  const limits = accountLimits(
    [
      row({ snapshotAgeMs: 6 * 3600_000, rateLimits: { five_hour: { used_percentage: 91, resets_at: open(-3600) } } }),
      row({ sessionId: 's2', snapshotAgeMs: 1200, rateLimits: { five_hour: { used_percentage: 12, resets_at: open(8040) } } }),
    ],
    NOW,
  );
  assert.equal(limits!.apart, 0);
  assert.equal(limits!.readings, 2, 'it is still a reading, and still counted as one');
});

// One window named differently by two sessions is one fact, not two — the count is of
// READINGS, and the windows they are apart on are a set.
test('two readings apart on one window are two readings, and the window is said once', () => {
  const other = { five_hour: { used_percentage: 17, resets_at: open(600) } };
  const limits = accountLimits(
    [
      row({ snapshotAgeMs: 90_000, rateLimits: other }),
      row({ sessionId: 's2', snapshotAgeMs: 80_000, rateLimits: other }),
      row({ sessionId: 's3', snapshotAgeMs: 1200, rateLimits: { five_hour: { used_percentage: 61, resets_at: open(8040) } } }),
    ],
    NOW,
  );
  assert.equal(limits!.apart, 2);
  assert.deepEqual(limits!.apartWindows, ['five_hour']);
  assert.equal(limits!.readings, 3);
});

// The denominator is what it says it is: how many readings measured the account. A payload
// carrying `[]`, `{}` or a pair of nulls measured nothing, and counting it turns "1 of 2
// readings disagree" — a coin flip — into a reassuring "1 of 4".
test('readings that measured nothing are not in the count the surfaces publish', () => {
  const limits = accountLimits(
    [
      row({ snapshotAgeMs: 90_000, rateLimits: { five_hour: { used_percentage: 17, resets_at: open(600) } } }),
      row({ sessionId: 's2', snapshotAgeMs: 50_000, rateLimits: {} }),
      row({ sessionId: 's3', snapshotAgeMs: 40_000, rateLimits: [] as any }),
      row({ sessionId: 's4', snapshotAgeMs: 1200, rateLimits: { five_hour: { used_percentage: 61, resets_at: open(8040) } } }),
    ],
    NOW,
  );
  assert.equal(limits!.readings, 2);
  assert.equal(limits!.apart, 1);
});

// The tie `snapshots.ts` already refuses to leave to chance one module over: two files of the
// same age had their order decided by whatever `claude agents --json` printed first, and BOTH
// the number drawn and the count published moved with it.
test('two readings of the same age settle the same way, whichever order the sessions arrive in', () => {
  const rows = [
    row({ sessionId: 'aaa', snapshotAgeMs: 5000, rateLimits: { five_hour: { used_percentage: 12, resets_at: open(600) } } }),
    row({ sessionId: 'bbb', snapshotAgeMs: 5000, rateLimits: { five_hour: { used_percentage: 88, resets_at: open(8040) } } }),
    row({ sessionId: 'ccc', snapshotAgeMs: 5000, rateLimits: { five_hour: { used_percentage: 50, resets_at: open(4000) } } }),
  ];
  const forwards = accountLimits(rows, NOW);
  const backwards = accountLimits([...rows].reverse(), NOW);
  assert.equal(forwards!.rateLimits.five_hour.used_percentage, backwards!.rateLimits.five_hour.used_percentage);
  assert.equal(forwards!.apart, backwards!.apart);
});

// A measured window is a measured window: `why` exists to name a missing number, and a page
// that reads it without checking `pct` first must not find a word there.
test('a lone reading counts itself, and is apart from nothing', () => {
  const limits = accountLimits([row({ snapshotAgeMs: 1200, rateLimits: { five_hour: { used_percentage: 17, resets_at: open(600) } } })], NOW);
  assert.equal(limits!.readings, 1);
  assert.equal(limits!.apart, 0);
});

// The same two exclusions the winner is picked under. A snapshot dated after the clock that
// read it, or one with no age at all, cannot win on freshness — so it cannot lose on
// disagreement either, or the page would count a reading it refuses to date.
test('readings nothing can date are counted neither among the readings nor among the apart', () => {
  const limits = accountLimits(
    [
      row({ snapshotAgeMs: -600_000, rateLimits: { five_hour: { used_percentage: 3, resets_at: open(600) } } }),
      row({ sessionId: 's2', snapshotAgeMs: null, rateLimits: { five_hour: { used_percentage: 5, resets_at: open(700) } } }),
      row({ sessionId: 's3', snapshotAgeMs: 1200, rateLimits: { five_hour: { used_percentage: 91, resets_at: open(8040) } } }),
    ],
    NOW,
  );
  assert.equal(limits!.readings, 1);
  assert.equal(limits!.apart, 0);
});

// ── the fleet-wide freshness verdict ──────────────────────────────────────────────────
//
// #53: a statusline is only written when a terminal draws a frame, so on a fleet that mostly
// idles "N readings are stale" is the steady state, not an event. What is NOT the steady
// state is a session that is working right now and whose reading has gone cold anyway, on a
// fleet where nothing else is fresh either — that is the writer having stopped, not the
// fleet resting. These tests pin both directions of that predicate.

test('a fleet where nothing is fresh and a busy session is among the stale readings reports the busy ones', () => {
  const rows = [
    row({ sessionId: 'a', busy: true, stale: true, snapshotAgeMs: 4 * 3600_000 }),
    row({ sessionId: 'b', busy: false, stale: true, snapshotAgeMs: 5 * 3600_000 }),
  ];
  assert.equal(busyOnStaleFleet(rows), 1);
});

// The wallpaper case the issue is about: seven idle sessions past the threshold overnight is
// what an idle fleet LOOKS like, and the rows already say it one by one.
test('an idle fleet whose every reading has gone stale says nothing', () => {
  const rows = [
    row({ sessionId: 'a', busy: false, stale: true, snapshotAgeMs: 4 * 3600_000 }),
    row({ sessionId: 'b', busy: false, stale: true, snapshotAgeMs: 5 * 3600_000 }),
  ];
  assert.equal(busyOnStaleFleet(rows), 0);
});

// One reading anyone wrote recently is proof the writer works. A busy session cold beside it
// is that session's business — a background agent draws no frames — not the fleet's.
test('one fresh reading anywhere clears the fleet, busy stragglers included', () => {
  const rows = [
    row({ sessionId: 'a', busy: true, stale: true, snapshotAgeMs: 4 * 3600_000 }),
    row({ sessionId: 'b', busy: false, stale: false, snapshotAgeMs: 30_000 }),
  ];
  assert.equal(busyOnStaleFleet(rows), 0);
});

// A fleet nothing has ever written for has no readings to judge — and its own warning
// already ("statusline chained on 0/N"), which is about installing, not about a stall.
test('a fleet with no readings at all is not a stalled writer', () => {
  const rows = [
    row({ sessionId: 'a', busy: true, ctxState: 'absent', ctxPct: null, snapshotAgeMs: null, stale: false }),
    row({ sessionId: 'b', busy: false, ctxState: 'absent', ctxPct: null, snapshotAgeMs: null, stale: false }),
  ];
  assert.equal(busyOnStaleFleet(rows), 0);
});

// A busy session with no snapshot at all is the coverage warning's, not this one's: there is
// no reading of its to have gone cold.
test('a busy session that was never written for does not accuse the writer', () => {
  const rows = [
    row({ sessionId: 'a', busy: true, ctxState: 'absent', ctxPct: null, snapshotAgeMs: null, stale: false }),
    row({ sessionId: 'b', busy: false, stale: true, snapshotAgeMs: 4 * 3600_000 }),
  ];
  assert.equal(busyOnStaleFleet(rows), 0);
});

// One session is a fleet. Nothing here is a proportion, so a fleet of one busy session whose
// reading is hours old is the same verdict as a fleet of seven.
test('a lone busy session on a cold reading is enough', () => {
  assert.equal(busyOnStaleFleet([row({ busy: true, stale: true, snapshotAgeMs: 3 * 3600_000 })]), 1);
});

// An empty fleet accuses nobody. The explicit empty-fleet clause was removed for leaning on
// every()'s vacuity; this pins the behaviour the removal leaned on.
test('an empty fleet is not a dead writer', () => {
  assert.equal(busyOnStaleFleet([]), 0);
});

// A snapshot dated AFTER the clock that read it has no age at all, and this verdict is an
// accusation. Leaving it out of the denominator instead would let the page say "every reading
// is stale" one box above the warning naming the reading that is not — and a file dated in the
// future may have been written a second ago, which is the opposite of the evidence this banner
// claims to hold. So it ENDS the question rather than sitting it out.
test('a reading dated in the future clears the fleet rather than leaving the denominator', () => {
  const rows = [
    row({ sessionId: 'a', busy: true, stale: true, snapshotAgeMs: 4 * 3600_000 }),
    row({ sessionId: 'b', busy: false, stale: false, snapshotAgeMs: -1 }),
  ];
  assert.equal(busyOnStaleFleet(rows), 0, 'one millisecond ahead is still ahead');
});

// The number is printed in the banner, so it has to be a count. A predicate that answered
// "yes, at least one" would tell a fleet of four that 1 session is busy.
test('counts every busy session on a cold reading, not just the first', () => {
  const rows = [
    row({ sessionId: 'a', busy: true, stale: true, snapshotAgeMs: 4 * 3600_000 }),
    row({ sessionId: 'b', busy: true, stale: true, snapshotAgeMs: 5 * 3600_000 }),
    row({ sessionId: 'c', busy: false, stale: true, snapshotAgeMs: 6 * 3600_000 }),
  ];
  assert.equal(busyOnStaleFleet(rows), 2);
});

// A snapshot written in the same millisecond as the collect is the freshest reading there can
// be. Dropping it from the denominator would make a fleet with something demonstrably writing
// to it read as a fleet where nothing is.
test('a reading dated this very millisecond is a reading, and clears the fleet', () => {
  const rows = [
    row({ sessionId: 'a', busy: true, stale: true, snapshotAgeMs: 4 * 3600_000 }),
    row({ sessionId: 'b', busy: false, stale: false, snapshotAgeMs: 0 }),
  ];
  assert.equal(busyOnStaleFleet(rows), 0);
});

// `busy: null` is "tarmac does not know what this session is doing", and a session that may
// or may not be working cannot be the evidence that the writer stopped.
test('a session whose status tarmac cannot read is not counted as busy', () => {
  const rows = [
    row({ sessionId: 'a', busy: null, status: 'transmogrifying', stale: true, snapshotAgeMs: 4 * 3600_000 }),
    row({ sessionId: 'b', busy: false, stale: true, snapshotAgeMs: 5 * 3600_000 }),
  ];
  assert.equal(busyOnStaleFleet(rows), 0);
});
