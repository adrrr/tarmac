// The map's model: what a node IS, before anything draws it.
//
// Every rule the map's honesty rests on lives here rather than in the markup — a node that
// may not be drawn as live is a fact about the reading, not about a stylesheet.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFleet } from '../src/fleet.ts';
import { buildMap, PULSE_WITHIN_MS } from '../src/map.ts';
import { NOW, health, row } from './fleet-fixtures.ts';
import type { Fleet, FleetHealth, FleetRow } from '../src/fleet.ts';
import type { FleetMap, MapNode } from '../src/map.ts';
import type { Session } from '../src/sessions.ts';

const fleet = (rows: FleetRow[], h: Partial<FleetHealth> = {}): Fleet => ({ rows, health: health(h) });

/**
 * Every node the map holds, in the order it is drawn — the berths in theirs, and inside each
 * one the cards before the strips. The count these flatten to is the invariant the whole view
 * is checked against: whatever the frames do with an entry, none of them may swallow one.
 */
const nodesOf = (map: FleetMap): MapNode[] => map.berths.flatMap((b) => [...b.sessions, ...b.agents]);
const names = (map: FleetMap): (string | null)[] => nodesOf(map).map((n) => n.row.name);
const labels = (map: FleetMap): string[] => map.berths.map((b) => b.label);

const only = (r: Partial<FleetRow>): MapNode => nodesOf(buildMap(fleet([row(r)])))[0];

test('a busy session becomes a busy node', () => {
  const nodes = nodesOf(buildMap(fleet([row({ busy: true })])));
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].state, 'busy');
});

// The fleet's first rule, carried through: a status nobody recognised is not a calm one.
test('an unrecognised status is unknown, never idle', () => {
  assert.equal(only({ busy: null, status: 'compacting' }).state, 'unknown');
});

// A state of its own, and the reason it cannot be read off the boolean: `busy` is null for a
// waiting session — the same null an unrecognised word has — so a map that asked only the
// boolean drew the one session blocked on a human as the amber "we have no idea".
test('a session halted on a human is waiting, not unknown', () => {
  assert.equal(only({ busy: null, status: 'waiting', waitingFor: 'permission prompt' }).state, 'waiting');
});

// The word is what makes it waiting, never the caption: the reason is a field the entry may
// simply not carry, and a session with no reason is not thereby a session with no state.
test('a waiting session with no reason is still waiting', () => {
  assert.equal(only({ busy: null, status: 'waiting', waitingFor: null }).state, 'waiting');
});

test('a reading inside the freshness threshold is live', () => {
  assert.equal(only({ snapshotAgeMs: 1200, stale: false }).reading, 'live');
});

// The red line of the whole view. `stale` is decided by the collector, against the threshold
// the user set; the map re-deciding it with a number of its own is how the two surfaces
// start disagreeing about the same session.
test('a stale reading is stale, whatever its age says', () => {
  assert.equal(only({ snapshotAgeMs: 3600_000, stale: true }).reading, 'stale');
});

test('a session no statusline ever wrote for has no reading at all', () => {
  assert.equal(only({ snapshotAgeMs: null, ctxPct: null, ctxState: 'absent' }).reading, 'none');
});

// Same refusal as the table's "— ahead": an age that cannot be told is not a small one.
test('a reading dated in the future is undated, not brand new', () => {
  assert.equal(only({ snapshotAgeMs: -5000, stale: false }).reading, 'undated');
});

// ── measured, or not ─────────────────────────────────────────────────────────────────────
// `reading` answers "how old is the snapshot", `measured` answers "is there a number in it".
// They part company on exactly the two states that matter most: a session that has taken no
// turn yet and one whose payload drifted BOTH have a snapshot file, so both are as fresh as
// a reading gets — and neither has a percentage. Deriving one from the other drew those two
// as a full, confident, empty ring.

test('a session with a percentage is measured', () => {
  assert.equal(only({ ctxPct: 26, ctxState: 'ok' }).measured, true);
});

test('a session that has taken no turn is not measured, however fresh its snapshot', () => {
  const node = only({ ctxPct: null, ctxState: 'fresh', snapshotAgeMs: 1200 });
  assert.equal(node.reading, 'live', 'the file itself is current');
  assert.equal(node.measured, false);
});

test('a drifted payload is not measured, however fresh its snapshot', () => {
  const node = only({ ctxPct: null, ctxState: 'drift', snapshotAgeMs: 1200 });
  assert.equal(node.reading, 'live');
  assert.equal(node.measured, false);
});

// The one that must stay distinguishable from the two above.
test('a context window measured at zero is measured', () => {
  assert.equal(only({ ctxPct: 0, ctxState: 'ok' }).measured, true);
});

// ── the pulse ────────────────────────────────────────────────────────────────────────────
// The one moving thing on the page, and the only claim it makes: a frame landed for this
// session a moment ago. It is a fact about the snapshot's timing — the third documented
// source — and never about the session being interesting.

test('a reading that just landed pulses', () => {
  assert.equal(only({ snapshotAgeMs: 2000, stale: false }).pulse, true);
});

test('a reading older than the pulse window does not pulse', () => {
  assert.equal(only({ snapshotAgeMs: PULSE_WITHIN_MS + 1, stale: false }).pulse, false);
});

// The window is a promise the manual makes in seconds; asserting it against itself would let
// it move to a minute with the whole suite still green.
test('the pulse window is ten seconds', () => {
  assert.equal(PULSE_WITHIN_MS, 10_000);
  assert.equal(only({ snapshotAgeMs: 9_000, stale: false }).pulse, true);
  assert.equal(only({ snapshotAgeMs: 11_000, stale: false }).pulse, false);
});

// A file landing is not a reading landing. A fleet whose payloads all drifted still writes a
// snapshot every frame, and a halo on every one of those dials is a fleet of empty rings
// beating steadily — the calm, wrong answer this tool exists to refuse.
test('a snapshot with nothing measured in it does not pulse', () => {
  assert.equal(only({ ctxPct: null, ctxState: 'drift', snapshotAgeMs: 1200 }).pulse, false);
  assert.equal(only({ ctxPct: null, ctxState: 'fresh', snapshotAgeMs: 1200 }).pulse, false);
});

// The threshold is the user's, and it can be set below the pulse window (`--stale-after 2s`).
// A node the fleet calls stale is one the map may not animate as though it were breathing.
test('a stale reading never pulses, however young the pulse window thinks it is', () => {
  assert.equal(only({ snapshotAgeMs: 3000, stale: true }).pulse, false);
});

test('an undated reading never pulses', () => {
  assert.equal(only({ snapshotAgeMs: -1000, stale: false }).pulse, false);
});

test('a session with no reading never pulses', () => {
  assert.equal(only({ snapshotAgeMs: null, ctxState: 'absent' }).pulse, false);
});

// ── agents in flight ─────────────────────────────────────────────────────────────────────
// `claude agents --json` prints interactive sessions and background ones in the same array,
// with `kind` as the only thing separating them and no field linking an agent to whoever
// dispatched it. So the map gives every entry a node of its own and merely GROUPS the nodes
// read in one working directory — the one field both carry — into a berth. Nesting one node
// inside another would be an edge the source never published, and it would let the map show a
// smaller fleet than the table on the same page.

// The invariant the whole view is checked against.
test('every session in the fleet is a node on the map, whatever its kind', () => {
  const rows = [
    row({ sessionId: 'a', kind: 'interactive', cwd: '/x' }),
    row({ sessionId: 'b', kind: 'background', cwd: '/x' }),
    row({ sessionId: 'c', kind: 'something-new', cwd: '/x' }),
    row({ sessionId: 'd', kind: null, cwd: null }),
  ];
  assert.equal(nodesOf(buildMap(fleet(rows))).length, rows.length);
});

test('an interactive session is a session node', () => {
  assert.equal(only({ kind: 'interactive' }).role, 'session');
});

// Alone on the machine it is not demoted — the guard below cannot tell a fleet of agents
// from a renamed kind, and it errs towards the session. What it is still gets printed; see
// the view suite.
test('a background session with no terminal beside it is not demoted on its own', () => {
  assert.equal(only({ kind: 'background' }).role, 'session');
});

// The same rule the session status follows one module down: unrecognised means unknown,
// never "the quiet one". A kind that is missing is not evidence of a background agent, and
// demoting it would hide a terminal someone is sitting at.
test('a session with no kind at all is a session node', () => {
  assert.equal(only({ kind: null }).role, 'session');
});

// The expensive mistake, and the guard against it. `interactive` is the only kind any
// captured payload has ever contained, so the day Claude Code renames it every terminal on
// the machine would become a footnote of a directory it merely shares — a map disagreeing
// with the table beside it about every row on the page.
//
// Same tolerance `buildFleet` applies to schema drift: a signal that fires for EVERY row is a
// change in the source, not a fleet that suddenly went dark.
test('a fleet with no interactive session is read as a renamed kind, not as a fleet of agents', () => {
  const map = buildMap(
    fleet([
      row({ sessionId: 'a', kind: 'terminal', cwd: '/x', name: 'a' }),
      row({ sessionId: 'b', kind: 'terminal', cwd: '/y', name: 'b' }),
    ]),
  );
  assert.deepEqual(nodesOf(map).map((n) => n.role), ['session', 'session']);
});

test('one interactive session is enough to read the other kinds as agents', () => {
  const map = buildMap(
    fleet([
      row({ sessionId: 'a', kind: 'interactive', cwd: '/x', name: 'a' }),
      row({ sessionId: 'b', kind: 'background', cwd: '/x', name: 'b' }),
    ]),
  );
  assert.deepEqual(nodesOf(map).map((n) => n.role), ['session', 'agent']);
});

// ── the berth ────────────────────────────────────────────────────────────────────────────
//
// One frame per working directory, and that is the WHOLE of what the frame claims: these
// nodes were read in one directory. Not that one dispatched another, not that a session owns
// the agents beside it — `claude agents --json` publishes no such field, and a berth holding
// two sessions and two agents says nothing about which of the four asked for which.

test('nodes read in one directory share a berth, labelled with the project', () => {
  const map = buildMap(
    fleet([
      row({ sessionId: 'a', kind: 'interactive', cwd: '/Users/jane/apollo', project: 'apollo', name: 'apollo-7a' }),
      row({ sessionId: 'b', kind: 'background', cwd: '/Users/jane/apollo', project: 'apollo', name: 'sweep-01' }),
    ]),
  );
  assert.deepEqual(labels(map), ['apollo']);
  assert.deepEqual(map.berths[0].sessions.map((n) => n.row.name), ['apollo-7a']);
  assert.deepEqual(map.berths[0].agents.map((n) => n.row.name), ['sweep-01']);
});

test('two directories are two berths, and neither borrows the other project', () => {
  const map = buildMap(
    fleet([
      row({ sessionId: 'a', kind: 'interactive', cwd: '/Users/jane/apollo', project: 'apollo', name: 'apollo-7a' }),
      row({ sessionId: 'b', kind: 'interactive', cwd: '/Users/jane/orion', project: 'orion', name: 'orion-11' }),
      row({ sessionId: 'c', kind: 'background', cwd: '/Users/jane/apollo', project: 'apollo', name: 'sweep-01' }),
    ]),
  );
  assert.deepEqual(labels(map), ['apollo', 'orion']);
  assert.deepEqual(names(map), ['apollo-7a', 'sweep-01', 'orion-11']);
});

// Two sessions in one checkout collected the same agents twice while the map was a flat list
// and each session gathered its own. A berth is a group, and an agent belongs to one.
test('two sessions in one directory share one berth, and the agents in it are not doubled', () => {
  const map = buildMap(
    fleet([
      row({ sessionId: 'a', kind: 'interactive', cwd: '/w', project: 'harbor', name: 'harbor-3f' }),
      row({ sessionId: 'b', kind: 'interactive', cwd: '/w', project: 'harbor', name: 'harbor-9k' }),
      row({ sessionId: 'c', kind: 'background', cwd: '/w', project: 'harbor', name: 'sweep-01' }),
    ]),
  );
  assert.equal(map.berths.length, 1);
  assert.deepEqual(names(map), ['harbor-3f', 'harbor-9k', 'sweep-01']);
});

// The berths are in the fleet's own order, taken at the FIRST node of each — so this one runs
// through `buildFleet`, which is where that order is decided. The sort puts a session halted
// on a human above everything else (#47), and a frame drawn around it that filed it three rows
// down would have undone the one rank that exists for the reader rather than for the fleet.
test('a waiting session pulls its berth to the front, through the fleet that sorted it', () => {
  const session = (over: Partial<Session>): Session => ({
    sessionId: 's',
    pid: 1,
    cwd: '/Users/jane/apollo',
    name: 'apollo-7a',
    kind: 'interactive',
    startedAt: null,
    status: 'idle',
    waitingFor: null,
    busy: false,
    ...over,
  });
  const map = buildMap(
    buildFleet({
      sessions: [
        session({ sessionId: 'a' }),
        session({
          sessionId: 'b',
          cwd: '/Users/jane/orion',
          name: 'orion-11',
          status: 'waiting',
          waitingFor: 'permission prompt',
          busy: null,
        }),
      ],
      snapshots: new Map(),
      now: NOW,
    }),
  );
  assert.deepEqual(labels(map), ['orion', 'apollo']);
});

// An orphan is not demoted to the end any more: it has a frame of its own, so it is a berth
// like any other and the fleet's sort decides where it comes. Which is what a waiting one
// needs — the shape that used to file it last was the flat grid, not the data.
test('an agent whose directory matches no session gets a berth of its own', () => {
  const map = buildMap(
    fleet([
      row({ sessionId: 'a', kind: 'background', cwd: '/Users/jane/gone', project: 'gone', name: 'orphan-01' }),
      row({ sessionId: 'b', kind: 'interactive', cwd: '/Users/jane/apollo', project: 'apollo', name: 'apollo-7a' }),
    ]),
  );
  assert.deepEqual(labels(map), ['gone', 'apollo']);
  assert.deepEqual(map.berths[0].sessions, [], 'a berth with nothing but the agent in it');
  assert.deepEqual(map.berths[0].agents.map((n) => n.row.name), ['orphan-01']);
});

// Two directories nobody could read are not the same directory, so a frame around both would
// be the one claim this whole shape exists to refuse.
test('an unknown working directory is never a directory two nodes share', () => {
  const map = buildMap(
    fleet([
      row({ sessionId: 'a', kind: 'interactive', cwd: null, project: null, name: 'a' }),
      row({ sessionId: 'b', kind: 'background', cwd: null, project: null, name: 'nowhere-01' }),
    ]),
  );
  assert.equal(map.berths.length, 2);
  assert.deepEqual(names(map), ['a', 'nowhere-01']);
});

// And it says which kind of nothing it is, in words — the vocabulary the dials use for a
// reading they do not have. An empty frame label is a frame that looks like a bug.
test('a berth whose directory nobody could read says so', () => {
  const map = buildMap(fleet([row({ cwd: null, project: null })]));
  assert.deepEqual(labels(map), ['no directory']);
});

test('the fleet decides the order of the sessions, and the map keeps it', () => {
  const map = buildMap(fleet([row({ sessionId: 'a', name: 'first' }), row({ sessionId: 'b', name: 'second' })]));
  assert.deepEqual(names(map), ['first', 'second']);
});
