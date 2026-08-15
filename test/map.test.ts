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

test('a background session is an agent node', () => {
  assert.equal(only({ kind: 'background' }).role, 'agent');
});

// The same rule the session status follows one module down: unrecognised means unknown,
// never "the quiet one". A kind that is missing is not evidence of a background agent, and
// demoting it would hide a terminal someone is sitting at.
test('a session with no kind at all is a session node', () => {
  assert.equal(only({ kind: null }).role, 'session');
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
