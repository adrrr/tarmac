// The map's model: what a node IS, before anything draws it.
//
// Every rule the map's honesty rests on lives here rather than in the markup — a node that
// may not be drawn as live is a fact about the reading, not about a stylesheet.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMap, PULSE_WITHIN_MS } from '../src/map.ts';
import { health, row } from './fleet-fixtures.ts';
import type { Fleet, FleetHealth, FleetRow } from '../src/fleet.ts';

const fleet = (rows: FleetRow[], h: Partial<FleetHealth> = {}): Fleet => ({ rows, health: health(h) });

const only = (r: Partial<FleetRow>): ReturnType<typeof buildMap>['nodes'][number] =>
  buildMap(fleet([row(r)])).nodes[0];

test('a busy session becomes a busy node', () => {
  const { nodes } = buildMap(fleet([row({ busy: true })]));
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
// dispatched it. So the map gives every entry a node of its own and merely PLACES the agents
// next to the session sharing their working directory — the one field both carry. Nesting
// one inside the other would be an edge the source never published, and it would let the map
// show a smaller fleet than the table on the same page.

// The invariant the whole view is checked against.
test('every session in the fleet is a node on the map, whatever its kind', () => {
  const rows = [
    row({ sessionId: 'a', kind: 'interactive', cwd: '/x' }),
    row({ sessionId: 'b', kind: 'background', cwd: '/x' }),
    row({ sessionId: 'c', kind: 'something-new', cwd: '/x' }),
    row({ sessionId: 'd', kind: null, cwd: null }),
  ];
  assert.equal(buildMap(fleet(rows)).nodes.length, rows.length);
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
  const { nodes } = buildMap(
    fleet([
      row({ sessionId: 'a', kind: 'terminal', cwd: '/x', name: 'a' }),
      row({ sessionId: 'b', kind: 'terminal', cwd: '/y', name: 'b' }),
    ]),
  );
  assert.deepEqual(nodes.map((n) => n.role), ['session', 'session']);
});

test('one interactive session is enough to read the other kinds as agents', () => {
  const { nodes } = buildMap(
    fleet([
      row({ sessionId: 'a', kind: 'interactive', cwd: '/x', name: 'a' }),
      row({ sessionId: 'b', kind: 'background', cwd: '/x', name: 'b' }),
    ]),
  );
  assert.deepEqual(nodes.map((n) => n.role), ['session', 'agent']);
});

test('an agent is placed right after the session sharing its working directory', () => {
  const { nodes } = buildMap(
    fleet([
      row({ sessionId: 'a', kind: 'interactive', cwd: '/Users/jane/apollo', name: 'apollo-7a' }),
      row({ sessionId: 'b', kind: 'interactive', cwd: '/Users/jane/orion', name: 'orion-11' }),
      row({ sessionId: 'c', kind: 'background', cwd: '/Users/jane/apollo', name: 'sweep-01' }),
    ]),
  );
  assert.deepEqual(nodes.map((n) => n.row.name), ['apollo-7a', 'sweep-01', 'orion-11']);
});

test('an agent whose directory matches no session comes last, and is still there', () => {
  const { nodes } = buildMap(
    fleet([
      row({ sessionId: 'a', kind: 'background', cwd: '/Users/jane/gone', name: 'orphan-01' }),
      row({ sessionId: 'b', kind: 'interactive', cwd: '/Users/jane/apollo', name: 'apollo-7a' }),
    ]),
  );
  assert.deepEqual(nodes.map((n) => n.row.name), ['apollo-7a', 'orphan-01']);
});

// Two directories nobody could read are not the same directory.
test('an unknown working directory places nothing next to anything', () => {
  const { nodes } = buildMap(
    fleet([
      row({ sessionId: 'a', kind: 'interactive', cwd: null, name: 'a' }),
      row({ sessionId: 'b', kind: 'background', cwd: null, name: 'nowhere-01' }),
      row({ sessionId: 'c', kind: 'interactive', cwd: '/Users/jane/apollo', name: 'c' }),
    ]),
  );
  assert.deepEqual(nodes.map((n) => n.row.name), ['a', 'c', 'nowhere-01']);
});

test('the fleet decides the order of the sessions, and the map keeps it', () => {
  const { nodes } = buildMap(
    fleet([row({ sessionId: 'a', name: 'first' }), row({ sessionId: 'b', name: 'second' })]),
  );
  assert.deepEqual(nodes.map((n) => n.row.name), ['first', 'second']);
});
