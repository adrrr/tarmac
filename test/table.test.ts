// The terminal renderer, tested directly.
//
// It used to live inside `src/cli.ts`, a module that parses argv and runs a command the
// moment it is imported — so the one output every `tarmac list` user actually reads was the
// only renderer with no test at all. It is a pure function of a Fleet; it belongs next to
// the other renderer, where the suite can reach it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSettings, renderTable } from '../src/render.ts';
import { guardVersions } from '../src/schema.ts';
import type { Fleet, FleetHealth, FleetRow } from '../src/fleet.ts';

const NOW = 1786240000000;
const row = (over: Partial<FleetRow> = {}): FleetRow => ({
  sessionId: 's1',
  name: 'alpha-7a',
  project: 'alpha',
  cwd: '/Users/jane/alpha',
  pid: 42,
  status: 'idle',
  busy: false,
  uptimeMs: 3600_000,
  ctxState: 'ok',
  ctxPct: 26,
  ctxTokens: 256390,
  ctxWindow: null,
  model: 'Fable 5',
  effort: 'max',
  costUsd: 27.75,
  snapshotAgeMs: 1200,
  stale: false,
  rateLimits: null,
  ...over,
});
const health = (over: Partial<FleetHealth> = {}): FleetHealth => ({
  sessions: 1,
  covered: 1,
  drift: 0,
  stale: 0,
  discovered: 1,
  noSessionId: 0,
  schemaBroken: false,
  unknownStatus: 0,
  busy: 0,
  costUsd: 27.75,
  costReporting: 1,
  schemaGuard: guardVersions(['2.1.226']),
  staleAfterMs: 600_000,
  generatedAt: NOW,
  ...over,
});
const fleet = (rows: FleetRow[], h: Partial<FleetHealth> = {}): Fleet => ({ rows, health: health(h) });

test('prints a header, a row and the fleet summary', () => {
  const out = renderTable(fleet([row()]));
  assert.match(out, /PROJECT +STATE +CTX/);
  assert.match(out, /alpha +idle +26% /);
  assert.match(out, /1 sessions · 0 busy · \$27\.75/);
});

test('renders a missing measurement as a dash and its reason, never as a zero', () => {
  const out = renderTable(fleet([row({ ctxState: 'absent', ctxPct: null, model: null, costUsd: null, snapshotAgeMs: null })], { covered: 0, costUsd: null }));
  assert.match(out, /— absent/);
  assert.equal(/ 0% /.test(out), false);
  assert.equal(/\$0\.00/.test(out), false);
});

// I8: the qualifier counts the sessions that really carry a cost — not the ones that
// happen to have a snapshot. Here all three are covered and only one reports a cost.
test('qualifies the fleet cost by how many sessions really report one', () => {
  const out = renderTable(fleet([row()], { sessions: 3, covered: 3, costUsd: 27.75, costReporting: 1 }));
  assert.match(out, /\$27\.75 \(1\/3 reporting cost\)/);
});

// A `!` whose threshold is invisible is a mark the reader cannot argue with. Since the
// threshold moved, the warning has to say WHICH one it used, in the units it would be set in.
test('the stale warning names the threshold the readings were judged against', () => {
  const out = renderTable(fleet([row({ stale: true, snapshotAgeMs: 4 * 3600_000 })], { stale: 1, staleAfterMs: 90_000 }));
  assert.match(out, /90s/);
  assert.equal(/10m/.test(out), false, 'never the default when the fleet used another one');
});

test('leaves a complete fleet cost unqualified', () => {
  const out = renderTable(fleet([row()], { sessions: 1, covered: 1, costUsd: 27.75, costReporting: 1 }));
  assert.equal(/reporting cost/.test(out), false);
});

test('says no cost was measured rather than printing $0.00', () => {
  const out = renderTable(fleet([row({ costUsd: null })], { sessions: 1, covered: 1, costUsd: null, costReporting: 0 }));
  assert.match(out, /cost —/);
  assert.equal(/\$0\.00/.test(out), false);
});

test('a fleet that has genuinely cost nothing can still say $0.00', () => {
  const out = renderTable(fleet([row({ costUsd: 0 })], { sessions: 1, covered: 1, costUsd: 0, costReporting: 1 }));
  assert.match(out, /· \$0\.00/);
  assert.equal(/reporting cost/.test(out), false);
});

// I7: an unchecked Claude Code version is a reason to look, never a reason to stop
// reporting — the row stays, with all its telemetry, and the notice sits under it.
test('names an unchecked Claude Code version without hiding any telemetry', () => {
  const out = renderTable(fleet([row()], { schemaGuard: guardVersions(['2.2.0']) }));
  assert.match(out, /2\.2\.0/);
  assert.match(out, /never been checked/i);
  assert.match(out, /26%/, 'the readings are still there');
  assert.match(out, /\$27\.75/);
});

test('says nothing about a version it has checked', () => {
  const out = renderTable(fleet([row()], { schemaGuard: guardVersions(['2.1.226']) }));
  assert.equal(/never been checked/i.test(out), false);
});

test('warns when the statusline covers only part of the fleet', () => {
  const out = renderTable(fleet([row()], { sessions: 3, covered: 1 }));
  assert.match(out, /! statusline chained on 1\/3 sessions/);
});

// C1: `readSnapshots` has always counted the payloads it could not key to a session — a
// renamed `session_id` is exactly that — and no renderer read the count. The fleet then
// looked unchained, and the advice was "run tarmac install": already done, and powerless
// against a schema change. The count is the one thing that tells the two apart.
test('says how many snapshots it could not read, before saying nothing is chained', () => {
  const out = renderTable(fleet([row({ ctxState: 'absent', ctxPct: null })], { sessions: 2, covered: 0, snapshotsUnreadable: 2 }));
  assert.match(out, /! 2 snapshot/i);
  assert.match(out, /schema/i, 'names the cause, not just the count');
  assert.ok(out.indexOf('unreadable') < out.indexOf('chained on'), 'the cause leads, the symptom follows');
});

test('stays quiet about unreadable snapshots when there are none', () => {
  assert.equal(/unreadable/.test(renderTable(fleet([row()], { snapshotsUnreadable: 0 }))), false);
});

// M3: a snapshot dated in the future — a mount whose clock runs ahead, an NTP correction
// mid-frame. `now - mtime` goes negative, and the AS OF column rounded it to "0m": the
// freshest possible reading, printed for a file whose age is not knowable at all. `reap.ts`
// already anticipates this clock ("a file dated in the future is never reaped"); the
// renderer says the same thing instead of inventing a number.
test('a reading dated in the future is marked, never rounded to "just now"', () => {
  // −20s, not −2m: `age()` rounds to the nearest minute, so a two-minute skew used to print
  // "-2m" — visibly wrong, and refused by any assertion. The skew that produced the symptom
  // this fix is named for is the one INSIDE the rounding window, where "0m" reads as the
  // freshest number on the screen. A test fed −2m greens on `/ 0m /` without any fix at all.
  const out = renderTable(fleet([row({ snapshotAgeMs: -20_000 })]));
  assert.match(out, /ahead/i, 'the column says the clock is ahead');
  assert.equal(/ 0m /.test(out), false, 'and never dates it as brand new');
  assert.match(out, /future/i, 'with a line explaining it');
});

// The other side of the rounding window, where the pre-fix output was visibly negative.
test('a reading dated well into the future is marked too, never printed as a negative age', () => {
  const out = renderTable(fleet([row({ snapshotAgeMs: -4 * 3600_000 })]));
  assert.match(out, /ahead/i);
  assert.equal(/-\d/.test(out), false, 'no negative duration reaches the column');
});

test('says nothing about clock skew when every reading is in the past', () => {
  assert.equal(/ahead|future/i.test(renderTable(fleet([row()]))), false);
});

// ── the settings block ────────────────────────────────────────────────────────────────
// `serve` runs unattended for hours, so the run has to open by saying what it decided and
// on whose authority. A threshold whose origin is invisible is one nobody can correct.
test('the settings block states each effective value and where it came from', () => {
  const out = renderSettings(
    {
      staleAfterMs: { value: 90_000, source: 'flag' },
      port: { value: 8080, source: 'file' },
      snapshotsDir: { value: '/x/snaps', source: 'env' },
    },
    '/x/.claude/tarmac/config.json',
  );
  assert.match(out, /90s.*flag/, 'the value in the units it would be set in, and its source');
  assert.match(out, /8080.*file/);
  assert.match(out, /\/x\/snaps.*env/);
  assert.match(out, /\/x\/\.claude\/tarmac\/config\.json/, 'and where a config file would be read from');
});

test('a long snapshots path does not push the sources off the screen', () => {
  // Padding every value to the widest one padded `10m` and `4477` to the width of an absolute
  // path — putting the column that says WHERE the value came from past column 110.
  const out = renderSettings(
    {
      staleAfterMs: { value: 600_000, source: 'default' },
      port: { value: 4477, source: 'default' },
      snapshotsDir: { value: `/Users/someone/${'nested/'.repeat(12)}snapshots`, source: 'file' },
    },
    '/x/.claude/tarmac/config.json',
  );
  const portLine = out.split('\n').find((l) => l.includes('4477'))!;
  assert.ok(portLine.length < 40, `the port line rides on the path's width: ${portLine.length} chars`);
  assert.match(portLine, /default/, 'and still carries its source');
});

test('the settings block spells out the precedence it applied', () => {
  const out = renderSettings(
    {
      staleAfterMs: { value: 600_000, source: 'default' },
      port: { value: 4477, source: 'default' },
      snapshotsDir: { value: '/x/snaps', source: 'default' },
    },
    '/x/.claude/tarmac/config.json',
  );
  assert.match(out, /flag.*env.*file.*default/, 'the order, not just the winner');
});

// M4: two files claiming the same session id. The freshest is kept — and the reader is told
// there was a choice, because the other file is still sitting in the directory being read.
test('says when two snapshot files claimed the same session', () => {
  const out = renderTable(fleet([row()], { snapshotsDuplicates: 1 }));
  assert.match(out, /! 1 snapshot/i);
  assert.match(out, /same session|session id/i);
  assert.match(out, /freshest/i, 'and which one it kept');
});

test('stays quiet about duplicates when there are none', () => {
  assert.equal(/freshest/.test(renderTable(fleet([row()], { snapshotsDuplicates: 0 }))), false);
});
