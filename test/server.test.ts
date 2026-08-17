import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderLive, renderPage, servingLine } from '../src/render.ts';
import { createFleetServer, listenFleetServer, PORT_FALLBACK_TRIES } from '../src/server.ts';
import { guardVersions } from '../src/schema.ts';
import { buildFleet } from '../src/fleet.ts';
import { parseAgents } from '../src/sessions.ts';
import { health, row } from './fleet-fixtures.ts';
import { rawGet } from './bounded.ts';
import { HISTORY_CADENCE_MS } from '../src/history.ts';
import type { HistoryPayload } from '../src/history.ts';
import type { Fleet, FleetRow } from '../src/fleet.ts';

// ── render ────────────────────────────────────────────────────────────────────────────
test('renders a row with its project, context and model', () => {
  const html = renderPage({ rows: [row()], health: health() });
  assert.match(html, /alpha/);
  assert.match(html, /26%/);
  assert.match(html, /Fable 5/);
});

test('escapes values that come from the filesystem', () => {
  const html = renderPage({ rows: [row({ project: '<script>alert(1)</script>' })], health: health() });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /&lt;script&gt;/);
});

test('shows a dash where telemetry is missing, never a zero', () => {
  const html = renderPage({
    rows: [row({ ctxState: 'absent', ctxPct: null, model: null, costUsd: null })],
    health: health({ covered: 0 }),
  });
  assert.equal(/>0%</.test(html), false);
  assert.match(html, /—/);
});

test('warns when the fleet has sessions the statusline does not cover', () => {
  const html = renderPage({ rows: [row({ ctxState: 'absent' })], health: health({ covered: 0, sessions: 1 }) });
  assert.match(html, /0\/1 sessions/i);
});

test('warns loudly when every snapshot drifted — the schema moved', () => {
  const html = renderPage({ rows: [row({ ctxState: 'drift', ctxPct: null })], health: health({ drift: 1, schemaBroken: true }) });
  assert.match(html, /schema/i);
});

// I7: the same notice as the terminal, in the same words — one guard, two surfaces.
test('names an unchecked Claude Code version on the dashboard too', () => {
  const html = renderPage({ rows: [row()], health: health({ schemaGuard: guardVersions(['2.2.0']) }) });
  assert.match(html, /2\.2\.0/);
  assert.match(html, /never been checked/i);
  assert.match(html, /26%/, 'nothing is suppressed');
});

test('says nothing on the dashboard about a version it has checked', () => {
  const html = renderPage({ rows: [row()], health: health({ schemaGuard: guardVersions(['2.1.226']) }) });
  assert.equal(/never been checked/i.test(html), false);
});

// I1: the defect the first live demo shipped with — four hours-old numbers rendered
// exactly like a five-minute-old one.
test('the page names the freshness threshold it used, so a dated reading is arguable', () => {
  const html = renderPage({ rows: [row({ stale: true, snapshotAgeMs: 4 * 3600_000 })], health: health({ stale: 1, staleAfterMs: 7_200_000 }) });
  assert.match(html, /2h/);
});

test('shows how old a stale reading is, next to the reading', () => {
  const html = renderPage({
    rows: [row({ stale: true, snapshotAgeMs: 4 * 3600_000 })],
    health: health({ stale: 1 }),
  });
  assert.match(html, /26%/, 'the value is still shown');
  assert.match(html, /4h ago/, 'and dated');
});

// Scoped to the region that holds rows: the page chrome now dates ITSELF ("updated 3s ago"),
// which is a different clock — how old the reading is, versus how old the whole view is.
test('does not date a fresh reading', () => {
  const live = renderLive({ rows: [row({ stale: false, snapshotAgeMs: 30_000 })], health: health() });
  assert.equal(/ago/.test(live), false);
});

// I2: sessions discovery could not identify must not vanish into "no sessions found".
test('warns when discovery returned entries it could not identify', () => {
  const html = renderPage({ rows: [], health: health({ sessions: 0, covered: 0, discovered: 7, noSessionId: 7, costUsd: null }) });
  assert.match(html, /7/);
  assert.match(html, /identif/i);
  assert.equal(/No Claude Code sessions found/i.test(html), false, 'never claims the fleet is empty');
});

// I3: a permission error must not be rendered as "you have not installed tarmac".
test('reports an unreadable snapshot directory instead of blaming the user', () => {
  const html = renderPage({
    rows: [row({ ctxState: 'absent', ctxPct: null })],
    health: health({ covered: 0, costUsd: null, snapshotsError: 'EACCES: /some/dir' }),
  });
  assert.match(html, /EACCES/);
  assert.equal(/tarmac install/.test(html), false);
});

// C1: snapshots ARE arriving and none of them can be keyed to a session — the payload's
// `session_id` moved. The page used to render that as "chained on 0/N, run tarmac install":
// an install that is already done, advised for a schema change it cannot fix.
test('names snapshots it could not read, rather than sending the user to reinstall', () => {
  const html = renderPage({
    rows: [row({ ctxState: 'absent', ctxPct: null })],
    health: health({ sessions: 2, covered: 0, costUsd: null, snapshotsUnreadable: 2 }),
  });
  assert.match(html, /2 snapshot/i, 'how many were there and unreadable');
  assert.match(html, /schema/i, 'and the cause worth checking');
  assert.ok(
    html.indexOf('unreadable') < html.indexOf('tarmac install'),
    'the drift is stated before the install advice, not after it',
  );
});

// M3, on the page: the same clock the terminal reports on.
test('the page reports a reading dated in the future rather than showing it as fresh', () => {
  const html = renderPage({ rows: [row({ snapshotAgeMs: -120_000 })], health: health() });
  assert.match(html, /future/i);
});

// I5
test('shows no fleet cost when nothing is covered', () => {
  const html = renderPage({ rows: [row({ ctxState: 'absent', costUsd: null })], health: health({ covered: 0, costUsd: null }) });
  assert.equal(/\$0\.00/.test(html), false);
});

// I8: three sessions covered, one carrying a cost — the qualifier counts the costs, not
// the snapshots, and the total is never presented as the whole fleet's.
test('qualifies a partial fleet cost by the sessions that really report one', () => {
  const html = renderPage({ rows: [row()], health: health({ sessions: 3, covered: 3, costUsd: 27.75, costReporting: 1 }) });
  assert.match(html, /\$27\.75/);
  assert.match(html, /1\/3 reporting cost/);
});

// Read, not shipped: the page also carries the replay's renderer, which qualifies a partial
// sum in the very same words — deliberately, since two surfaces are not allowed to word one
// fact two ways. What this test is about is the sentence a reader sees.
const visible = (html: string): string => html.replace(/<script>[\s\S]*?<\/script>/g, '');

test('leaves a complete fleet cost unqualified', () => {
  const html = renderPage({ rows: [row()], health: health({ sessions: 1, covered: 1, costUsd: 27.75, costReporting: 1 }) });
  assert.equal(/reporting cost/.test(visible(html)), false);
});

test('a fleet that has genuinely cost nothing still says $0.00', () => {
  const html = renderPage({ rows: [row({ costUsd: 0 })], health: health({ costUsd: 0, costReporting: 1 }) });
  assert.match(html, /\$0\.00/);
});

test('says so plainly when the fleet is empty', () => {
  const html = renderPage({ rows: [], health: health({ sessions: 0, covered: 0, costUsd: 0 }) });
  assert.match(html, /No Claude Code sessions/i);
});

test('marks a busy session as busy and an unknown status as unknown', () => {
  const html = renderPage({
    rows: [row({ busy: true, status: 'busy' }), row({ sessionId: 's2', busy: null, status: 'transmogrifying' })],
    health: health({ sessions: 2, busy: 1, unknownStatus: 1 }),
  });
  assert.match(html, /busy/i);
  assert.match(html, /transmogrifying/);
});

// ── the three ways a fleet can be partly uncovered ────────────────────────────────────
// One `else if` with three outcomes, and until these existed all three could be collapsed
// into the pre-#7 sentence with the whole suite still green. The distinction is not cosmetic:
// `tarmac install` is the fix for a session that has drawn no frame yet, and is meaningless
// for one whose id the wrapper declines to file — the second reads as "you have not installed
// tarmac" when tarmac is installed and working exactly as designed.
test('sends an uncovered fleet to install when a frame is all that is missing', () => {
  const live = renderLive({
    rows: [row({ ctxState: 'absent', ctxPct: null })],
    health: health({ sessions: 2, covered: 1, unfilable: 0 }),
  });
  assert.match(live, /tarmac install/, 'a frame away, and the advice works');
  assert.equal(/never|no frame will ever/i.test(live), false, 'nothing here is permanent');
});

test('never sends a session to install when no frame could ever file it', () => {
  const live = renderLive({
    rows: [row({ ctxState: 'absent', ctxPct: null })],
    health: health({ sessions: 2, covered: 1, unfilable: 1 }),
  });
  assert.match(live, /no frame will ever produce one/, 'says the telemetry is not late, it is not coming');
  assert.match(live, /Installing again will not change that/, 'and says the obvious next move is not one');
});

// The mixed case, which is where getting `unfilable` wrong actually costs something: one
// session a frame away, one that will never be filed. Both sentences have to be there, or
// whichever session is left out is the one whose problem goes unexplained.
test('tells the two uncovered kinds apart when the fleet has both', () => {
  const live = renderLive({
    rows: [row({ ctxState: 'absent', ctxPct: null }), row({ sessionId: 's2', ctxState: 'absent', ctxPct: null })],
    health: health({ sessions: 3, covered: 1, unfilable: 1 }),
  });
  assert.match(live, /1 of them will never be filed/, 'the permanent one is named, and counted');
  assert.match(live, /For the others, run `tarmac install`/, 'and the fixable one still gets its advice');
});

// The whole pipeline, on a payload captured off a real machine: a terminal and the background
// agent it dispatched, which reports its state under `state` rather than `status`. Every layer
// in between is real, because the bug this pins was invisible at each of them on its own —
// the parser handed back a `null` that was faithful to what it read, and the page turned it
// into an alarm about a fleet where nothing at all was wrong.
test('a finished background agent raises no banner about an unknown status', () => {
  const { sessions, health: discovery } = parseAgents(
    JSON.stringify([
      { pid: 62489, cwd: '/w', kind: 'interactive', startedAt: 1, sessionId: 'a', name: 'alpha-7a', status: 'idle' },
      { id: 'b0', cwd: '/w', kind: 'background', startedAt: 2, sessionId: 'b', name: 'sweep', state: 'done' },
    ]),
  );
  const fleet = buildFleet({ sessions, snapshots: new Map(), now: 1786240000000, discovery });
  assert.equal(fleet.health.unknownStatus, 0);
  const live = renderLive(fleet);
  assert.doesNotMatch(live, /does not know/);
  assert.doesNotMatch(live, /data-state="unknown"/);
});

// ── what is amber, and what is a footnote ─────────────────────────────────────────────
//
// #53: the top of the page carried two amber boxes on a perfectly healthy fleet — one saying
// readings were older than the threshold (the steady state of a fleet that idles, since a
// statusline is only written when a terminal draws a frame), one naming Claude Code versions
// no fixture covers (true, and a maintainer's job, not the reader's). A banner that is always
// there is not a warning, it is wallpaper, and it teaches the reader to skip the amber boxes
// that DO need them. Amber is kept for the failing refresh, the moved schema, the column that
// is hiding something; the rest went to a footnote below the fleet.

/** The amber boxes the fragment itself raises — the shell's own (offline, replay) are not here. */
const amber = (fragment: string): string[] =>
  [...fragment.matchAll(/<div class="warn">([\s\S]*?)<\/div>/g)].map((m) => m[1]!);

/** The quiet line under the fleet: the same facts, at the weight they are worth. */
const footnotes = (fragment: string): string[] =>
  [...fragment.matchAll(/<div class="note">([\s\S]*?)<\/div>/g)].map((m) => m[1]!);

test('an idle fleet past the freshness threshold raises no banner at all', () => {
  const live = renderLive({
    rows: [
      row({ sessionId: 'a', busy: false, stale: true, snapshotAgeMs: 4 * 3600_000 }),
      row({ sessionId: 'b', busy: false, stale: true, snapshotAgeMs: 5 * 3600_000 }),
    ],
    health: health({ sessions: 2, covered: 2, stale: 2 }),
  });
  assert.deepEqual(amber(live), [], 'nothing amber on a fleet that is merely resting');
  assert.match(live, /4h ago/, 'and the rows still carry their own dates, which is the point');
});

// The one shape that means something: nothing anywhere is fresh, and a session that is
// working right now is looking at a cold number too. That is the writer stopped.
test('raises a banner when nothing is fresh and a busy session is among the cold readings', () => {
  const live = renderLive({
    rows: [
      row({ sessionId: 'a', busy: true, stale: true, snapshotAgeMs: 4 * 3600_000 }),
      row({ sessionId: 'b', busy: false, stale: true, snapshotAgeMs: 5 * 3600_000 }),
    ],
    health: health({ sessions: 2, covered: 2, stale: 2, busy: 1 }),
  });
  assert.equal(amber(live).length, 1, 'and it is amber — this one is worth the reader');
  assert.match(amber(live)[0]!, /busy/i);
  assert.match(amber(live)[0]!, /1 session/, 'how many are working on a cold reading');
});

// The banner says "every context reading is stale". A reading dated in the future is one the
// page names, in its own box, as NOT being datable at all — so the two boxes together would
// have the page contradicting itself in the space of two lines. The skew warning stands; the
// stall banner stands down.
test('never claims every reading is stale beside a warning that names one which is not', () => {
  const live = renderLive({
    rows: [
      row({ sessionId: 'a', busy: true, stale: true, snapshotAgeMs: 4 * 3600_000 }),
      row({ sessionId: 'b', busy: false, stale: false, snapshotAgeMs: -600_000 }),
    ],
    health: health({ sessions: 2, covered: 2, stale: 1, busy: 1 }),
  });
  assert.equal(amber(live).length, 1, 'one box, not two that disagree');
  assert.match(amber(live)[0]!, /dated in the future/, 'and it is the skew one that survives');
  assert.equal(/Every context reading is stale/.test(live), false);
});

// The banner already names the threshold. Printing the footnote under it too puts the alarm
// and its own excuse on the same screen — "the writer looks stopped" over "an idle session's
// number is as of its last frame", which is the reading it is telling you not to accept.
test('does not repeat the threshold footnote under the banner that already names it', () => {
  const live = renderLive({
    rows: [
      row({ sessionId: 'a', busy: true, stale: true, snapshotAgeMs: 4 * 3600_000 }),
      row({ sessionId: 'b', busy: false, stale: true, snapshotAgeMs: 5 * 3600_000 }),
    ],
    health: health({ sessions: 2, covered: 2, stale: 2, busy: 1 }),
  });
  assert.match(amber(live)[0]!, /10m/, 'the banner carries the threshold');
  assert.equal(/freshness threshold are dated where they sit/.test(live), false, 'and the footnote stands down');
});

// A `!` whose threshold is invisible is a mark the reader cannot argue with — the rule the
// terminal table has always kept. Demoting the banner must not take the number with it.
test('names the freshness threshold in the footnote whenever a reading is dated', () => {
  const live = renderLive({
    rows: [row({ stale: true, snapshotAgeMs: 4 * 3600_000 })],
    health: health({ stale: 1, staleAfterMs: 7_200_000 }),
  });
  assert.match(footnotes(live).join(' '), /2h/, 'the threshold the reading was judged against');
  assert.deepEqual(amber(live), [], 'said quietly, not in a box');
});

test('says nothing about a threshold nothing was judged past', () => {
  const live = renderLive({ rows: [row()], health: health() });
  assert.equal(/--stale-after/.test(live), false, 'no legend where there is no mark to explain');
});

// The maintainer's line: true, useful, and up for every user of a released tarmac until the
// next one ships the fixture. It keeps every word — and loses the amber box.
test('an unchecked Claude Code version is a footnote, never a banner', () => {
  const live = renderLive({ rows: [row()], health: health({ schemaGuard: guardVersions(['2.9.9']) }) });
  const quiet = footnotes(live).join(' ');
  assert.match(quiet, /2\.9\.9/, 'the version it is actually being fed');
  assert.match(quiet, /never been checked/i, 'in the same words as before');
  assert.match(quiet, /github\.com\/adrrr\/tarmac\/issues/, 'and where to send it');
  assert.deepEqual(amber(live), [], 'no amber for a fleet where nothing is wrong');
});

// Below the fleet, not above it: a reader scanning for what their sessions are doing must
// reach the sessions first, and a maintainer looking for this knows to go to the bottom.
test('puts the footnote under the fleet, where a scan ends rather than starts', () => {
  const live = renderLive({ rows: [row()], health: health({ schemaGuard: guardVersions(['2.9.9']) }) });
  assert.ok(live.indexOf('<div class="note">') > live.indexOf('<table'), 'after the rows');
  assert.ok(live.indexOf('<div class="note">') > live.indexOf('class="view view-map"'), 'and after the map');
});

// The banners that stay: a schema that has moved is hiding a column, and no per-node dating
// says that. #53 demotes two, and only two.
test('keeps the amber for a schema that moved under the page', () => {
  const live = renderLive({
    rows: [row({ ctxState: 'drift', ctxPct: null })],
    health: health({ drift: 1, schemaBroken: true }),
  });
  assert.equal(amber(live).length, 1);
  assert.match(amber(live)[0]!, /schema/i);
});

// ── weight: busy first, and visible as such from across a room ────────────────────────
// The sort is already right. What was missing is that a busy row and an idle one weighed
// the same on screen, and that the difference between them was a colour — which is no
// difference at all to a reader who cannot separate those two colours.
test('a row carries its state in the markup, not only in a colour', () => {
  const live = renderLive({
    rows: [row({ busy: true, status: 'busy' }), row({ sessionId: 's2', busy: false }), row({ sessionId: 's3', busy: null, status: 'transmogrifying' })],
    health: health({ sessions: 3, busy: 1, unknownStatus: 1 }),
  });
  assert.match(live, /data-state="busy"/);
  assert.match(live, /data-state="idle"/);
  assert.match(live, /data-state="unknown"/);
});

test('each state pill carries a shape as well as a word', () => {
  const busy = renderLive({ rows: [row({ busy: true, status: 'busy' })], health: health({ busy: 1 }) });
  const idle = renderLive({ rows: [row({ busy: false })], health: health() });
  const unknown = renderLive({ rows: [row({ busy: null, status: 'transmogrifying' })], health: health({ unknownStatus: 1 }) });
  // The mapping itself, not just its distinctness: a character class plus a uniqueness check
  // went green with idle wearing the alarm triangle, and "readable in one glance from across
  // a room" IS the mapping.
  assert.match(busy, /●\s*busy/);
  assert.match(idle, /○\s*idle/);
  assert.match(unknown, /▲\s*transmogrifying/);
});

// The row an operator is looking for. It used to draw as the amber "tarmac does not know this
// word", beside a banner saying so — over the one session where nothing is wrong with the
// tool and something is wanted from the reader.
test('a waiting row is a state of its own, and says what it is waiting for', () => {
  const live = renderLive({
    rows: [row({ busy: null, status: 'waiting', waitingFor: 'dialog open' })],
    health: health(),
  });
  assert.match(live, /<tr data-state="waiting">/);
  assert.match(live, /◐\s*waiting · dialog open/);
  assert.doesNotMatch(live, /data-state="unknown"/);
  assert.doesNotMatch(live, /does not know/, 'and no banner about an unrecognised status');
});

// The reason is read off the entry as it came, and it is the WORD that decides the state. An
// entry carrying both a reason and some other status is a source that has moved; drawing the
// leftover would caption a working session with what it was blocked on a moment ago.
test('a reason left beside another state is not drawn on either surface', () => {
  const live = renderLive({
    rows: [row({ busy: true, status: 'busy', waitingFor: 'dialog open' })],
    health: health({ busy: 1 }),
  });
  assert.doesNotMatch(live, /dialog open/);
});

// The pill is one string, so an absent reason has to be absent from it rather than appended:
// "waiting · " is a sentence cut off, and "waiting · null" is worse.
test('a waiting row that gave no reason carries the word alone', () => {
  const live = renderLive({ rows: [row({ busy: null, status: 'waiting', waitingFor: null })], health: health() });
  assert.match(live, /◐\s*waiting<\/span>/);
});

// ── a phone-width viewport ────────────────────────────────────────────────────────────
// Where the columns stack, a value with no header above it is a number with no name — and
// "—" with no name is exactly the missing measurement the product refuses to render as 0.
test('every cell names its column, for the width where the table stacks', () => {
  const live = renderLive({ rows: [row()], health: health() });
  for (const label of ['Project', 'Session', 'State', 'Context', 'Model', 'Effort', 'Cost', 'Uptime']) {
    assert.match(live, new RegExp(`data-label="${label}"`), `${label} cell is unlabelled`);
  }
});

// Seen on a 390px viewport: a cell holding "63%" and "11h ago" as two siblings had them
// pushed to opposite ends of the card, the number stranded under the label of the row above
// it. Stacked, a cell is a label and ONE value — whatever that value is made of.
test('every cell holds its value as a single element, so the stacked layout cannot strand it', () => {
  const live = renderLive({ rows: [row({ stale: true, snapshotAgeMs: 4 * 3600_000 })], health: health({ stale: 1 }) });
  for (const cell of live.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []) {
    const inner = cell.replace(/^<td[^>]*>/, '').replace(/<\/td>$/, '').trim();
    assert.match(inner, /^<span[^>]*>[\s\S]*<\/span>$/, `cell is not a single value: ${cell}`);
  }
});

// The correction the spike review forced. An age in the same quiet grey as the session name
// is decoration; the terminal marks a dated reading with "!" and the page has to mean it too.
test('a stale reading is marked, not merely dated', () => {
  const live = renderLive({ rows: [row({ stale: true, snapshotAgeMs: 4 * 3600_000 })], health: health({ stale: 1 }) });
  assert.match(live, /class="stale"/);
  assert.match(live, /!\s*4h ago/);
});

test('the page has a narrow-viewport layout and a dark one', () => {
  const html = renderPage({ rows: [row()], health: health() });
  assert.match(html, /@media[^{]*max-width/);
  assert.match(html, /prefers-color-scheme:\s*dark/);
});

// ── the degraded rows ─────────────────────────────────────────────────────────────────
// Three different reasons a context reading is missing, and they are not interchangeable:
// one is normal and transient, one is a schema that moved under the whole fleet, one is a
// session nothing ever wrote for.
test('the three reasons a context is missing read differently', () => {
  const why = (ctxState: FleetRow['ctxState']): string =>
    renderLive({ rows: [row({ ctxState, ctxPct: null, ctxTokens: null })], health: health({ covered: 0, costUsd: null }) });
  assert.match(why('fresh'), /no turn yet/);
  assert.match(why('drift'), /schema drift/);
  assert.match(why('absent'), /not chained/);
});

// Exit criterion: a session carrying null in every optional field.
test('a row with nothing measured renders no zero and no empty cell', () => {
  const live = renderLive({
    rows: [
      {
        sessionId: null, name: null, project: null, cwd: null, pid: null, kind: null, status: null,
        waitingFor: null, busy: null,
        uptimeMs: null, ctxState: 'absent', ctxPct: null, ctxTokens: null, ctxWindow: null, model: null,
        effort: null, costUsd: null, snapshotAgeMs: null, stale: false, rateLimits: null,
      },
    ],
    health: health({ sessions: 1, covered: 0, costUsd: null, costReporting: 0, unknownStatus: 1 }),
  });
  assert.equal(/>\s*0%/.test(live), false, 'no context of zero');
  assert.equal(/\$0\.00/.test(live), false, 'no cost of zero');
  assert.equal(/>\s*0[hmd]\s*</.test(live), false, 'no uptime of zero');
  assert.equal(/<td[^>]*>\s*<\/td>/.test(live), false, 'no cell left blank');
});

// ── the refresh: one region, rendered once, replaced in place ─────────────────────────
test('the page carries a live region the refresh can replace', () => {
  assert.match(renderPage({ rows: [row()], health: health() }), /id="live"/);
});

test('the live fragment is the page without its shell', () => {
  const fleet = { rows: [row()], health: health() };
  const fragment = renderLive(fleet);
  assert.match(fragment, /alpha/, 'it carries the fleet');
  assert.equal(/<!doctype/i.test(fragment), false, 'and none of the shell');
  assert.equal(renderPage(fleet).includes(fragment), true, 'the page ships exactly it');
});

// The page treats an empty fragment as a failed refresh, because a truncated response that
// blanked the table and dated it "0s ago" would be the product's own lie with a green dot on
// it. That rule is only safe because the server has nothing empty to say: a fleet of zero
// sessions still renders words. If this ever returns "", the page will call the server broken.
test('the live fragment is never empty, whatever the fleet', () => {
  const empty = renderLive({ rows: [], health: health({ sessions: 0, covered: 0, costUsd: null, costReporting: 0 }) });
  assert.notEqual(empty.trim(), '');
  assert.match(empty, /No Claude Code sessions/i);
});

// The cardinal rule, in the one place a non-null assertion was standing in for it: `stale`
// and a known age are coupled in `buildFleet`, a module away, and the assertion rendered
// `duration(null)` as `0m` — a missing measurement as a zero, and a self-contradicting one,
// since the "!" claims the reading is past the threshold while "0m" reads as brand new.
test('a stale reading whose age is unknown is dashed, never dated zero', () => {
  const live = renderLive({ rows: [row({ stale: true, snapshotAgeMs: null })], health: health({ stale: 1 }) });
  assert.equal(/0m ago/.test(live), false);
  assert.equal(/!\s*0/.test(live), false);
});

// A meta refresh cannot render its own failure: when the server dies the browser replaces
// the page with an error page, and the honest "I have not heard from it in 40s" goes with it.
test('the page refreshes itself by asking for the fragment, never by reloading', () => {
  const html = renderPage({ rows: [row()], health: health() });
  assert.match(html, /fetch\([^)]*\/live/);
  assert.equal(/http-equiv=["']?refresh/i.test(html), false);
});

// Scoped INSIDE the element, not merely "somewhere in the document" — the script also
// contains the word "updated", so a looser regex would go green on a page whose header had
// lost the element entirely.
test('the page says how long ago it last heard from the server', () => {
  const html = renderPage({ rows: [row()], health: health() });
  assert.match(html, /<span id="age">[^<]*updated[^<]*<\/span>/i);
});

// The one lie the product exists to kill: numbers that sit there looking alive while the
// thing that produced them is gone. The words ship WITH the page, so they are here to assert
// — the script only unhides them.
test('the page carries the words for a failing refresh before it ever fails', () => {
  const html = renderPage({ rows: [row()], health: health() });
  // In the banner, not merely in the script that unhides it: the whole point of putting the
  // words in the document is that they are server-rendered and therefore assertable.
  assert.match(html, /<div[^>]*id="offline"[^>]*>[\s\S]*?refresh failing[\s\S]*?<\/div>/i);
});

test('a reader without JavaScript is told the page will not refresh itself', () => {
  assert.match(renderPage({ rows: [row()], health: health() }), /<noscript>[\s\S]*refresh[\s\S]*<\/noscript>/i);
});

// ── server ────────────────────────────────────────────────────────────────────────────
async function withServer(
  collect: () => Promise<Fleet>,
  fn: (base: string) => Promise<void>,
  opts: { sampleEveryMs?: number } = {},
): Promise<void> {
  const server = createFleetServer({ collect, ...opts });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', () => r());
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((r) => {
      server.close(() => r());
    });
  }
}

const collectOk = async (): Promise<Fleet> => ({ rows: [row()], health: health() });

test('GET / serves the dashboard page', async () => {
  await withServer(collectOk, async (base) => {
    const res = await fetch(base + '/', { signal: AbortSignal.timeout(4000) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /text\/html/);
    assert.match(await res.text(), /alpha/);
  });
});

test('GET /api/fleet serves the same data as JSON', async () => {
  await withServer(collectOk, async (base) => {
    const res = await fetch(base + '/api/fleet', { signal: AbortSignal.timeout(4000) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Fleet;
    assert.equal(body.rows[0].ctxPct, 26);
    assert.equal(body.health.sessions, 1);
  });
});

// The page is bound to loopback, but a DNS-rebinding page in the user's browser could
// still reach it and read cwd paths, session ids and costs. Only loopback Hosts are served.
// `fetch` refuses to set Host (forbidden header), so this goes through node:http — the
// test must exercise the header it claims to exercise. `rawGet` lives in `test/bounded.ts`
// with the deadline that keeps a server which accepts and never answers from hanging this
// file, and with the test that proves that deadline fires.

test('refuses a request whose Host is not loopback', async () => {
  await withServer(collectOk, async (base) => {
    assert.equal(await rawGet(new URL(base).port, 'evil.example.com'), 403);
  });
});

test('serves a request with a loopback Host and a port', async () => {
  await withServer(collectOk, async (base) => {
    const port = new URL(base).port;
    assert.equal(await rawGet(port, `localhost:${port}`), 200);
  });
});

// What the open page asks for every few seconds. It must be the fragment and nothing else:
// re-serving the shell would replace the running script with a copy of itself.
test('GET /live serves the fragment the page swaps in', async () => {
  await withServer(collectOk, async (base) => {
    const res = await fetch(base + '/live', { signal: AbortSignal.timeout(4000) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /text\/html/);
    const body = await res.text();
    assert.match(body, /alpha/);
    assert.equal(/<!doctype/i.test(body), false);
  });
});

// The refresh endpoint carries the same cwd paths and costs as the page — the same door.
test('refuses a /live request whose Host is not loopback', async () => {
  await withServer(collectOk, async (base) => {
    assert.equal(await rawGet(new URL(base).port, 'evil.example.com', '/live'), 403);
  });
});

// The page shows this text to the user. A refresh that fails silently is the one lie the
// product exists to kill, so the reason has to survive the trip.
test('a failing collector answers /live with the reason too', async () => {
  const boom = async (): Promise<Fleet> => {
    throw new Error('claude: not found');
  };
  await withServer(boom, async (base) => {
    const res = await fetch(base + '/live', { signal: AbortSignal.timeout(4000) });
    assert.equal(res.status, 500);
    assert.match(await res.text(), /claude: not found/);
  });
});

// The collector's failure was a 500 and the renderer's failure was a dead daemon: headers
// went out before the body was built, so a throw in a renderer became an unhandled rejection
// and took `tarmac serve` down. It runs unattended for hours; the two must be symmetrical.
test('a renderer that throws is a 500, and the server is still there afterwards', async () => {
  // The reviewer's own trigger: `new Date(NaN).toISOString()` throws RangeError.
  const cursed = async (): Promise<Fleet> => ({ rows: [row()], health: health({ generatedAt: NaN }) });
  await withServer(cursed, async (base) => {
    // Bounded on purpose: before the fix this did not fail, it HUNG — the 200 headers were
    // already on the wire and the body never came, so the browser waits forever.
    const res = await fetch(base + '/', { signal: AbortSignal.timeout(4000) });
    assert.equal(res.status, 500);
    assert.match(await res.text(), /tarmac could not/i);
    const again = await fetch(base + '/', { signal: AbortSignal.timeout(4000) });
    assert.equal(again.status, 500, 'still answering, not gone');
  });
});

// Not a data leak — CORS keeps the answer from being read — but any page the user visits can
// make `tarmac` spawn `claude` by fetching this port no-cors, as fast as it likes. Browsers
// label those requests; non-browser clients send no label and are left alone.
test('a request a browser labels cross-site is refused before it can spawn anything', async () => {
  let collected = 0;
  const counting = async (): Promise<Fleet> => {
    collected++;
    return { rows: [row()], health: health() };
  };
  await withServer(counting, async (base) => {
    const port = new URL(base).port;
    assert.equal(await rawGet(port, `localhost:${port}`, '/api/fleet', { 'sec-fetch-site': 'cross-site' }), 403);
    assert.equal(collected, 0, 'and nothing was spawned');
    assert.equal(await rawGet(port, `localhost:${port}`, '/api/fleet', { 'sec-fetch-site': 'same-origin' }), 200);
    assert.equal(await rawGet(port, `localhost:${port}`, '/api/fleet'), 200, 'curl sends no such header');
  });
});

// The second surface, on its own address: the tab is a link, so the view has to survive a
// reload and a bookmark.
test('GET /map serves the page opened on the map', async () => {
  await withServer(collectOk, async (base) => {
    const res = await fetch(base + '/map', { signal: AbortSignal.timeout(4000) });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<!doctype/i, 'the shell, not the fragment');
    assert.match(body, /<body data-view="map"/);
  });
});

test('an unknown path is a 404, not the dashboard', async () => {
  await withServer(collectOk, async (base) => {
    assert.equal((await fetch(base + '/nope', { signal: AbortSignal.timeout(4000) })).status, 404);
  });
});

test('a failing collector answers 500 with the reason, not a blank page', async () => {
  const boom = async (): Promise<Fleet> => {
    throw new Error('claude: not found');
  };
  await withServer(boom, async (base) => {
    const res = await fetch(base + '/', { signal: AbortSignal.timeout(4000) });
    assert.equal(res.status, 500);
    assert.match(await res.text(), /claude: not found/);
  });
});

// The page swaps what this port answers straight into `innerHTML`. Loopback is not proof of
// identity: another local process on the port after tarmac exits, or a proxy in front of it,
// answers 200 with whatever it likes. The header is what the page checks before the bytes
// reach the DOM, so it has to be on EVERY answer — including the failures, whose text the
// page quotes as its own reason.
test('every answer identifies itself as tarmac, refusals and failures included', async () => {
  await withServer(collectOk, async (base) => {
    for (const p of ['/', '/live', '/api/fleet', '/api/history']) {
      const res = await fetch(base + p, { signal: AbortSignal.timeout(4000) });
      assert.equal(res.headers.get('x-tarmac'), '1', p);
      await res.text();
    }
    const missing = await fetch(base + '/nope', { signal: AbortSignal.timeout(4000) });
    assert.equal(missing.headers.get('x-tarmac'), '1', '404');
    await missing.text();
  });

  const boom = async (): Promise<Fleet> => {
    throw new Error('claude: not found');
  };
  await withServer(boom, async (base) => {
    const res = await fetch(base + '/live', { signal: AbortSignal.timeout(4000) });
    assert.equal(res.headers.get('x-tarmac'), '1', 'a 500 the page will quote');
    await res.text();
  });
});

// M4, on the page: same fact, same words as the terminal.
test('the page says when two snapshot files claimed the same session', () => {
  const html = renderPage({ rows: [row()], health: health({ snapshotsDuplicates: 1 }) });
  assert.match(html, /1 snapshot/i);
  assert.match(html, /freshest/i);
});

// ── history ───────────────────────────────────────────────────────────────────────────
// The serve reads the whole fleet on every request and used to forget it on the next one.
// A sampler on its own timer keeps a day of those readings in memory, and `/api/history`
// hands the ring back. Every wait below is bounded: a sampler that never fires must be a
// failure with a message, not a file that hangs.

/**
 * Polls the record until `pred` holds, and throws at the deadline — `bounded.ts`'s rule for
 * the network waits, applied to a timer. The payload is in the message because a poll that
 * gives up carries no other clue about which half of the sampler never arrived.
 */
async function historyUntil(
  base: string,
  pred: (h: HistoryPayload) => boolean,
  what: string,
  timeoutMs = 4000,
): Promise<HistoryPayload> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(base + '/api/history', { signal: AbortSignal.timeout(4000) });
    const h = (await res.json()) as HistoryPayload;
    if (pred(h)) return h;
    if (Date.now() >= deadline) throw new Error(`waited ${timeoutMs}ms for ${what}, and got ${JSON.stringify(h)}`);
    await sleep(10);
  }
}

// Asking what happened must not read the present: a route that collected would let a scrubber
// spawn `claude agents --json` on every drag.
test('GET /api/history serves the record without reading the fleet to do it', async () => {
  let collected = 0;
  const counting = async (): Promise<Fleet> => {
    collected++;
    return { rows: [row()], health: health() };
  };
  const started = Date.now();
  await withServer(counting, async (base) => {
    const res = await fetch(base + '/api/history', { signal: AbortSignal.timeout(4000) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type')!, /application\/json/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const h = (await res.json()) as HistoryPayload;
    assert.deepEqual(h.samples, [], 'a serve that just started has nothing to replay yet');
    assert.equal(h.missed, 0);
    assert.equal(h.cadence, HISTORY_CADENCE_MS);
    assert.ok(h.since >= started && h.since <= Date.now(), 'the record starts when the serve does');
    assert.equal(collected, 0, 'and the past was served without reading the present');
  });
});

test('the sampler fills the record on its own timer, one reading per slot', async () => {
  await withServer(
    collectOk,
    async (base) => {
      const h = await historyUntil(base, (x) => x.samples.length >= 2, 'two samples');
      assert.equal(h.samples[0].sessions[0].ctxPct, 26);
      assert.equal(h.samples[0].sessions[0].sid, 's1');
      assert.equal(h.missed, 0);
    },
    { sampleEveryMs: 20 },
  );
});

// The privacy line the ring exists behind. `claude agents --json` names a background session
// after the PROMPT it was given, and tarmac carries that verbatim onto the page and into
// /api/fleet — the present tense, on a screen someone is looking at. A day of them, retained
// by a process and served on a route, is a different object, so no name goes in at all.
test("a background agent's name never enters the record", async () => {
  const PROMPT = 'audit the payroll export for the Q3 board memo';
  const withAgent = async (): Promise<Fleet> => ({
    rows: [row(), row({ sessionId: 's2', name: PROMPT, kind: 'background', status: 'running', busy: true })],
    health: health({ sessions: 2, busy: 1 }),
  });
  await withServer(
    withAgent,
    async (base) => {
      await historyUntil(base, (x) => x.samples.length >= 1, 'a sample');
      const raw = await (await fetch(base + '/api/history', { signal: AbortSignal.timeout(4000) })).text();
      assert.equal(raw.includes(PROMPT), false, 'not under any field');
      assert.equal(raw.includes('payroll'), false, 'nor a word of it');
      // The agent is IN the record — this is an omitted field, not an omitted session, and
      // the fleet route still carries the name, so the difference is the history's own.
      const h = JSON.parse(raw) as HistoryPayload;
      assert.equal(h.samples[0].sessions.length, 2);
      assert.equal(h.samples[0].sessions[1].sid, 's2');
      assert.equal(h.samples[0].sessions[1].kind, 'background');
      const fleet = await (await fetch(base + '/api/fleet', { signal: AbortSignal.timeout(4000) })).text();
      assert.ok(fleet.includes(PROMPT), 'the live reading still says it');
    },
    { sampleEveryMs: 20 },
  );
});

// A collector that throws is the normal weather here — `claude` missing, a machine asleep.
// It costs a slot and nothing else: not the timer, not the process, not the record.
test('a reading that fails is a counted slot, and the sampler keeps going', async () => {
  const boom = async (): Promise<Fleet> => {
    throw new Error('claude: not found');
  };
  await withServer(
    boom,
    async (base) => {
      const h = await historyUntil(base, (x) => x.missed >= 2, 'two missed slots');
      assert.deepEqual(h.samples, []);
    },
    { sampleEveryMs: 20 },
  );
});

// `claude agents --json` has a 15s deadline of its own, which is longer than a slot. Ticking
// into a read that has not come back would spawn a second one, and a third — a hung fleet
// answering with a queue of processes instead of one missed minute.
test('a tick that finds the previous reading still running is a missed slot, not a second spawn', async () => {
  let started = 0;
  const wedged = (): Promise<Fleet> => {
    started++;
    return new Promise<Fleet>(() => {});
  };
  await withServer(
    wedged,
    async (base) => {
      const h = await historyUntil(base, (x) => x.missed >= 2, 'two ticks that found a read in flight');
      assert.equal(started, 1, 'and only one read was ever started');
      assert.deepEqual(h.samples, []);
    },
    { sampleEveryMs: 20 },
  );
});

// A server object that was made and never bound serves nobody, so there is nobody to keep a
// record for. The sampler starting at construction meant a `createFleetServer` whose `listen`
// refused — a port named on the command line that is taken — went on spawning `claude agents
// --json` once a minute into a ring no request could ever reach.
test('a server that never listened never samples, and starts when it begins serving', async () => {
  let collected = 0;
  const counting = async (): Promise<Fleet> => {
    collected++;
    return { rows: [row()], health: health() };
  };
  const server = createFleetServer({ collect: counting, sampleEveryMs: 20 });
  await sleep(200);
  assert.equal(collected, 0, 'ten slots went by and nothing was read');
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', () => r());
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await historyUntil(base, (h) => h.samples.length >= 1, 'the first sample once it was serving');
  } finally {
    await new Promise<void>((r) => {
      server.close(() => r());
    });
  }
});

// The timer is unref'd — it may not be what keeps `node --test` or a Ctrl-C'd serve alive —
// but an unref'd timer that is never cleared still SPAWNS: a suite that starts and stops
// servers would leave a sampler per test reading the fleet behind it.
test('closing the serve stops its sampler', async () => {
  let collected = 0;
  const counting = async (): Promise<Fleet> => {
    collected++;
    return { rows: [row()], health: health() };
  };
  const server = createFleetServer({ collect: counting, sampleEveryMs: 20 });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', () => r());
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await historyUntil(base, (h) => h.samples.length >= 1, 'a first sample');
  await new Promise<void>((r) => {
    server.close(() => r());
  });
  const after = collected;
  await sleep(200);
  assert.equal(collected, after, 'ten slots later, nothing was read');
});

// ── binding ───────────────────────────────────────────────────────────────────────────
// From a user who ran `tarmac serve` and got "cannot listen on port 4477 (the default) —
// already in use", full stop. Two failures in one line: it named no way out — `--port`
// exists and the message never said so — and a collision on a port NOBODY CHOSE should not
// have been fatal at all. So the default walks, and only the default: a port asked for by
// flag, environment or config file is a decision, and a decision that cannot be honoured is
// a refusal, not an invitation to bind something else and let the user find out later.
//
// Every port here is drawn at random from a high band. 4477 is deliberately never touched:
// these tests must not fail because someone on the machine is running the real thing.

/**
 * Binds a port, or resolves `null` if something already holds it.
 *
 * It hangs up on whoever connects, and that is not decoration. A holder that ACCEPTS and then
 * says nothing is a black hole: a stray request lands on it and waits forever, and — worse —
 * `close()` then waits for that connection before its callback fires, so the whole file hangs
 * instead of reporting the failure that sent the request to the wrong port in the first place.
 * Hanging up turns that into an immediate connection error, which is a test result.
 */
function bind(port: number, host = '127.0.0.1'): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const s = net.createServer((sock) => sock.destroy());
    s.once('error', () => resolve(null));
    s.listen(port, host, () => resolve(s));
  });
}

const close = (s: net.Server | Server): Promise<void> => new Promise((r) => s.close(() => r()));

/**
 * `n` consecutive free ports, held all at once before being released together: checking them
 * one at a time would happily return a base whose neighbours were never simultaneously free.
 *
 * The band matters. It sat in 20000-60000 for one run, which overlaps the ephemeral range
 * both Linux (32768-60999) and macOS (49152-65535) draw OUTBOUND source ports from — so a
 * port held here for a few hundred milliseconds took one another test file needed to connect
 * FROM, and `fetch` failed with EADDRNOTAVAIL in a test that has nothing to do with ports.
 * Below 32768 is under both, and above anything a developer is likely to be running.
 */
async function freeBlock(n: number): Promise<number> {
  for (let tries = 0; tries < 50; tries++) {
    const base = 20_000 + Math.floor(Math.random() * 10_000);
    const held: net.Server[] = [];
    for (let i = 0; i < n; i++) {
      const s = await bind(base + i);
      if (s === null) break;
      held.push(s);
    }
    const found = held.length === n;
    await Promise.all(held.map(close));
    if (found) return base;
  }
  throw new Error(`could not find ${n} consecutive free ports`);
}

async function occupy(port: number): Promise<net.Server> {
  const s = await bind(port);
  assert.ok(s, `port ${port} was free a moment ago`);
  return s;
}

test('a free port is bound as asked, with no move to report', async () => {
  const base = await freeBlock(1);
  const server = createFleetServer({ collect: collectOk });
  try {
    const bound = await listenFleetServer(server, { port: base, source: 'default' });
    assert.equal(bound.port, base);
    assert.equal(bound.movedFrom, null, 'nothing happened worth telling the user about');
    assert.equal((server.address() as AddressInfo).port, base, 'and it is really there');
    // The dashboard carries cwd paths, session ids and costs, and this change turned the
    // address into a PARAMETER. The Host check in the handler above is a second lock on a
    // door, not the door: `Host` is whatever the client types, so a plain curl from the LAN
    // sets it to `localhost` and walks through. Binding loopback is the barrier, and until
    // this line nothing in the suite failed if it stopped being loopback.
    assert.equal((server.address() as AddressInfo).address, '127.0.0.1', 'loopback, never the wildcard');
  } finally {
    await close(server);
  }
});

// Port 0 is legal and documented: it means "pick a free one", and `serve` uses it. The first
// cut of this returned the number it was ASKED for, so the socket was on 54321 and the line
// under it invited the user to http://127.0.0.1:0. (The settings block above it still reports
// `port 0 (env)`, and should: that block says what was ASKED for, and by whom.)
test('port 0 reports the port the kernel gave, not the zero it was asked for', async () => {
  const server = createFleetServer({ collect: collectOk });
  try {
    const bound = await listenFleetServer(server, { port: 0, source: 'env' });
    assert.ok(bound.port > 0, `a real port, got ${bound.port}`);
    assert.equal(bound.port, (server.address() as AddressInfo).port, 'the one on the socket');
    assert.equal(bound.movedFrom, null, 'and asking for any free port is not a move');
  } finally {
    await close(server);
  }
});

test('a default port that is taken moves to the next port that is free', async () => {
  const base = await freeBlock(3);
  const busy = [await occupy(base), await occupy(base + 1)];
  const server = createFleetServer({ collect: collectOk });
  try {
    const bound = await listenFleetServer(server, { port: base, source: 'default' });
    assert.equal(bound.port, base + 2, 'it walked past both');
    assert.equal(bound.movedFrom, base, 'and remembers what it was asked for, so serve can say so');
    assert.equal((server.address() as AddressInfo).port, base + 2, 'really bound where it says');
  } finally {
    await close(server);
    await Promise.all(busy.map(close));
  }
});

// The bound named in the requirement, asserted where it actually lives — on the socket. The
// "gives up" test below cannot see it: its message is built from `port` and `last`, arithmetic
// that reads the same whether the walk tried eleven ports or three. A review mutated the loop
// to stop one short and the whole suite stayed green. This is the test that kills that mutant.
test('the tenth move is still made — the corridor is ten wide, not nine', async () => {
  const base = await freeBlock(PORT_FALLBACK_TRIES + 1);
  const busy: net.Server[] = [];
  for (let i = 0; i < PORT_FALLBACK_TRIES; i++) busy.push(await occupy(base + i));
  const server = createFleetServer({ collect: collectOk });
  try {
    const bound = await listenFleetServer(server, { port: base, source: 'default' });
    assert.equal(bound.port, base + PORT_FALLBACK_TRIES, 'the last port it is allowed to reach');
    assert.equal(bound.movedFrom, base);
  } finally {
    await close(server);
    await Promise.all(busy.map(close));
  }
});

// Every attempt reuses the same `http.Server` object, and a bind that fails leaves internal
// state behind. `address()` reporting a port only proves the socket opened — the object that
// walked has to still be the dashboard, or `serve` comes up on a port that answers nothing.
test('the server it walked to still serves the dashboard', async () => {
  const base = await freeBlock(3);
  const busy = [await occupy(base), await occupy(base + 1)];
  const server = createFleetServer({ collect: collectOk });
  try {
    const bound = await listenFleetServer(server, { port: base, source: 'default' });
    // Bounded, for the same reason line 419 is: the ports this test occupies are bare TCP
    // servers that accept a connection and answer nothing. If the walk ever fails to happen,
    // an unbounded fetch here lands on one of them and waits forever — turning a test that
    // should go red into a suite that never finishes.
    const res = await fetch(`http://127.0.0.1:${bound.port}/api/fleet`, { signal: AbortSignal.timeout(4000) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-tarmac'), '1');
    assert.equal(((await res.json()) as Fleet).rows[0].project, 'alpha');
  } finally {
    await close(server);
    await Promise.all(busy.map(close));
  }
});

test('a port asked for by flag does not move — it names the knob that would move it', async () => {
  const base = await freeBlock(2);
  const busy = await occupy(base);
  const server = createFleetServer({ collect: collectOk });
  try {
    await assert.rejects(
      () => listenFleetServer(server, { port: base, source: 'flag' }),
      (e: Error) => {
        assert.match(e.message, new RegExp(`\\b${base}\\b`), 'the port it could not have');
        assert.match(e.message, /already in use/);
        assert.match(e.message, /--port/, 'the way out the original message never mentioned');
        return true;
      },
    );
    const next = await bind(base + 1);
    assert.ok(next, 'and it never crept onto the next port behind the user');
    await close(next);
  } finally {
    // If the refusal above ever stops happening, the bind SUCCEEDED and this is what keeps
    // the failure a failure — an unclosed socket makes `node --test` hang instead of report.
    await close(server);
    await close(busy);
  }
});

test('a port pinned in a config file does not move either — pinning it was the choice', async () => {
  const base = await freeBlock(2);
  const busy = await occupy(base);
  const server = createFleetServer({ collect: collectOk });
  try {
    await assert.rejects(
      () => listenFleetServer(server, { port: base, source: 'file' }),
      (e: Error) => {
        assert.match(e.message, /config file/, 'who asked for it');
        assert.match(e.message, /--port/, 'and what overrides it for one run');
        return true;
      },
    );
    const next = await bind(base + 1);
    assert.ok(next, 'no silent move');
    await close(next);
  } finally {
    await close(server);
    await close(busy);
  }
});

// The third rung. `TARMAC_PORT` is how a shell wrapper or a launchd plist pins the port, and
// it is a choice exactly like the other two — the README sells "flag > env > file > default"
// as four sources of one decision, not three decisions and a suggestion. Without this test a
// mutant that let `env` walk kept the whole suite green.
test('a port set in the environment does not move either', async () => {
  const base = await freeBlock(2);
  const busy = await occupy(base);
  const server = createFleetServer({ collect: collectOk });
  try {
    await assert.rejects(
      () => listenFleetServer(server, { port: base, source: 'env' }),
      (e: Error) => {
        assert.match(e.message, /the environment/, 'who asked for it');
        assert.match(e.message, /--port/, 'and what overrides it for one run');
        return true;
      },
    );
    const next = await bind(base + 1);
    assert.ok(next, 'no silent move');
    await close(next);
  } finally {
    await close(server);
    await close(busy);
  }
});

test('it gives up after ten moves, naming the whole range it tried and the flag that ends it', async () => {
  // Eleven ports: the one it was asked for, plus the ten it is allowed to try.
  const span = PORT_FALLBACK_TRIES + 1;
  const base = await freeBlock(span + 1);
  const busy: net.Server[] = [];
  for (let i = 0; i < span; i++) busy.push(await occupy(base + i));
  const server = createFleetServer({ collect: collectOk });
  try {
    await assert.rejects(
      () => listenFleetServer(server, { port: base, source: 'default' }),
      (e: Error) => {
        assert.match(e.message, new RegExp(`${base}-${base + PORT_FALLBACK_TRIES}\\b`), 'the range it tried');
        assert.match(e.message, /--port/, 'and the one knob that gets the user out of it');
        return true;
      },
    );
    const beyond = await bind(base + span);
    assert.ok(beyond, 'it stopped at ten rather than marching up the range');
    await close(beyond);
  } finally {
    await close(server);
    await Promise.all(busy.map(close));
  }
});

/**
 * A server that fails each `listen` the way the test scripts it to: one entry per attempt,
 * an errno code to refuse with or `null` to accept.
 *
 * The kernel takes no instructions, so a real socket cannot be made to refuse the first port
 * for being BUSY and the second for something else — and that pair is precisely the case
 * whose message used to lie, naming a port the walk had picked as one "the default" chose.
 * Injecting the collaborator is how this project reaches its other unreachable states already
 * (`createFleetServer({ collect })`, `runWatch({ … })`).
 */
function scriptedServer(outcomes: Array<string | null>): Server {
  let attempt = 0;
  const on: Record<string, Array<(e?: unknown) => void>> = { error: [], listening: [] };
  const api = {
    once(event: string, fn: (e?: unknown) => void) {
      on[event]?.push(fn);
      return api;
    },
    removeListener(event: string, fn: (e?: unknown) => void) {
      on[event] = (on[event] ?? []).filter((f) => f !== fn);
      return api;
    },
    listen(_port: number, _host: string) {
      const code = outcomes[attempt++];
      // SYNCHRONOUSLY, and this matters: production calls `listen` inside a promise executor,
      // so a throw here rejects that promise and the test goes red. Raising it from the
      // microtask below instead left the promise unsettled — a mutant that walked one attempt
      // too far hung the file rather than failing it, which is the failure mode this whole
      // round of review is about.
      if (code === undefined) throw new Error(`scriptedServer: attempt ${attempt} was not scripted`);
      // The reply itself is async, like the real one: `listen` reports on an event, which is
      // why the production code has to unhook itself between attempts at all.
      queueMicrotask(() => {
        const fire = code === null ? on.listening.splice(0) : on.error.splice(0);
        const e = code === null ? undefined : Object.assign(new Error(`listen ${code}`), { code });
        for (const fn of fire) fn(e);
      });
      return api;
    },
    address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 4478 }),
  };
  return api as unknown as Server;
}

test('a failure met mid-walk names the port that failed, not the one the default chose', async () => {
  // 4477 is busy, so the walk starts; 4478 then fails for a reason no further port can fix.
  const server = scriptedServer(['EADDRINUSE', 'EACCES']);
  await assert.rejects(
    () => listenFleetServer(server, { port: 4477, source: 'default' }),
    (e: Error) => {
      assert.match(e.message, /port 4478\b/, 'the port that actually failed');
      assert.match(e.message, /EACCES/, 'and the reason it gave');
      // The lie this replaced: 4478 is a port THIS MODULE picked. Attributing it to "the
      // default" sends someone editing a setting that says 4477.
      assert.match(e.message, /from 4477/, 'where the walk started');
      assert.match(e.message, /the default/, 'whose choice 4477 was');
      return true;
    },
  );
});

test('a walk that succeeds after a busy port never mentions a source it did not come from', async () => {
  const server = scriptedServer(['EADDRINUSE', null]);
  const bound = await listenFleetServer(server, { port: 4477, source: 'default' });
  assert.equal(bound.movedFrom, 4477);
  assert.equal(bound.port, 4478, 'read off the socket, not counted');
});

// The one line a user reads when this feature fires, and the one thing in the whole change
// that has no other witness.
//
// `tarmac serving ` is not decoration: `test/cli-config.test.ts` and `test/reap.test.ts` both
// start `serve` and block until that exact substring appears, with no timeout and no failure
// path. A moved line that opens differently does not fail those harnesses — it hangs them,
// on the first day 4477 happens to be busy. The marker leads; the move is the tail.
test('the serving line always opens with the marker, moved or not', () => {
  assert.equal(servingLine({ port: 4477, movedFrom: null }), 'tarmac serving http://127.0.0.1:4477');
  assert.match(servingLine({ port: 4478, movedFrom: 4477 }), /^tarmac serving http:\/\/127\.0\.0\.1:4478\b/);
});

test('a moved serving line still says which port it could not have', () => {
  const line = servingLine({ port: 4478, movedFrom: 4477 });
  assert.match(line, /4477/, 'the port that was taken');
  assert.match(line, /in use/, 'and why it is not the one in the URL');
  assert.equal(line.includes('\n'), false, 'one line');
});

// The walk is for one failure only. An address that is not this machine's, a privileged
// port, a descriptor limit — none of them get better ten ports later, and reporting any of
// them as "ports 4477-4487 all in use" would send the user hunting for a process that was
// never there.
test('a failure that is not a busy port is reported as itself, without walking the range', async () => {
  const base = await freeBlock(1);
  const server = createFleetServer({ collect: collectOk });
  try {
    await assert.rejects(
      // TEST-NET-3, assigned to no interface anywhere: EADDRNOTAVAIL, every time.
      () => listenFleetServer(server, { port: base, source: 'default', host: '203.0.113.1' }),
      (e: Error) => {
        // The port it was ASKED for, named as the port that failed. The looser `\b${base}\b`
        // this used to assert was satisfied by "walked to from <base>" too, so a mutant that
        // walked on EVERY error — eleven doomed binds instead of one — kept the suite green.
        assert.match(e.message, new RegExp(`port ${base}\\b`), 'the port it was asked for, and no other');
        assert.equal(/walked to from/.test(e.message), false, 'it never started walking');
        assert.equal(/all in use/.test(e.message), false, 'never blamed on ports that were free');
        return true;
      },
    );
  } finally {
    // The premise is that the bind FAILS, so there is normally nothing to close. A host with
    // `ip_nonlocal_bind=1` binds it anyway: without this the assertion above fails, the socket
    // stays open, and `node --test` — which has no per-file timeout — hangs instead of saying so.
    await close(server);
  }
});
