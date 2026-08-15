// The map, as markup.
//
// The model next door decides what a node IS; these are the rules about what reaches the
// screen — that a percentage nobody measured never becomes a ring, that a stale reading is
// not drawn like a live one, and that a session name is escaped before it is drawn.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMap, renderPage } from '../src/render.ts';
import { health, row } from './fleet-fixtures.ts';
import type { Fleet, FleetHealth, FleetRow } from '../src/fleet.ts';

const fleet = (rows: FleetRow[], h: Partial<FleetHealth> = {}): Fleet => ({ rows, health: health(h) });
const one = (r: Partial<FleetRow> = {}): string => renderMap(fleet([row(r)]));

test('a node carries its project, its session name and its context', () => {
  const html = one({ project: 'apollo', name: 'alpha-7a', ctxPct: 62 });
  assert.match(html, /apollo/);
  assert.match(html, /alpha-7a/);
  assert.match(html, /62/);
});

// The arc is the percentage. Drawn with pathLength="100", so the two numbers in the dash
// array read as "62 filled, 38 empty" instead of a slice of some circumference.
test('the ring is drawn to the size of the reading', () => {
  assert.match(one({ ctxPct: 62 }), /pathLength="100"[^>]*stroke-dasharray="62 38"/);
});

test('a session with no reading gets a dash and the reason, never a ring', () => {
  const html = one({ ctxPct: null, ctxState: 'absent', snapshotAgeMs: null });
  assert.match(html, /not chained/);
  assert.match(html, /&mdash;|—/);
  assert.doesNotMatch(html, /stroke-dasharray="0 100"/, 'an empty arc would read as a measured 0%');
});

test('the two other kinds of missing keep their own words', () => {
  assert.match(one({ ctxPct: null, ctxState: 'fresh', snapshotAgeMs: null }), /no turn yet/);
  assert.match(one({ ctxPct: null, ctxState: 'drift', snapshotAgeMs: null }), /schema drift/);
});

// The red line: a reading four hours old may not be drawn as though it were live.
test('a stale node says so, and is marked as stale in its own markup', () => {
  const html = one({ ctxPct: 47, snapshotAgeMs: 3 * 3600_000, stale: true });
  assert.match(html, /data-reading="stale"/);
  assert.match(html, /! 3h ago/);
});

test('a live node is not marked stale and carries no age', () => {
  const html = one({ ctxPct: 47, snapshotAgeMs: 4000, stale: false });
  assert.match(html, /data-reading="live"/);
  assert.doesNotMatch(html, /ago/);
});

// Same refusal as the table's "— ahead": an age that cannot be told is not a fresh one.
test('a reading dated in the future is shown undated', () => {
  const html = one({ ctxPct: 19, snapshotAgeMs: -4000 });
  assert.match(html, /data-reading="undated"/);
  assert.match(html, /undated/);
});

// The halo is the pulse: it is drawn only for a reading that just landed, so a node the
// fleet calls stale has nothing on it that can animate.
test('a reading that just landed pulses, and a stale one never does', () => {
  assert.match(one({ snapshotAgeMs: 1000, stale: false }), /class="halo"/);
  assert.doesNotMatch(one({ snapshotAgeMs: 4 * 3600_000, stale: true }), /class="halo"/);
});

test('a busy session is marked busy, and an unknown status is not marked idle', () => {
  assert.match(one({ busy: true }), /data-state="busy"/);
  assert.match(one({ busy: null, status: 'compacting' }), /data-state="unknown"/);
});

test('a background agent is drawn as an agent, and names what it is', () => {
  const html = renderMap(
    fleet([
      row({ sessionId: 'a', kind: 'interactive', cwd: '/w', name: 'apollo-7a' }),
      row({ sessionId: 'b', kind: 'background', cwd: '/w', name: 'sweep-01' }),
    ]),
  );
  assert.match(html, /data-role="agent"/);
  assert.match(html, /background/);
  assert.match(html, /sweep-01/);
});

test('an empty fleet says so rather than drawing nothing', () => {
  assert.match(renderMap(fleet([], { sessions: 0, covered: 0 })), /No Claude Code sessions found/);
});

// Everything on this page comes off a machine whose directories and session names are
// someone else's strings.
test('a session name is escaped, not drawn', () => {
  const html = one({ name: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

// ── the page around it ───────────────────────────────────────────────────────────────────

test('the page carries both views, so one refresh feeds them both', () => {
  const html = renderPage(fleet([row()]), 'map');
  assert.match(html, /<table/, 'the table is still rendered');
  assert.match(html, /class="map"/);
});

test('the page opens on the view that was asked for', () => {
  assert.match(renderPage(fleet([row()]), 'map'), /<body data-view="map"/);
  assert.match(renderPage(fleet([row()]), 'table'), /<body data-view="table"/);
});

// The tabs are links, not script: the view survives a refresh, a bookmark and a browser with
// JavaScript turned off — the same page the noscript banner promises is still readable.
test('the tabs are links, and the current one says so', () => {
  const html = renderPage(fleet([row()]), 'map');
  assert.match(html, /<a href="\/"[^>]*>Table<\/a>/);
  assert.match(html, /<a href="\/map" aria-current="page">Map<\/a>/);
});
