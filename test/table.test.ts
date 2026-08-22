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
import { health, row, NOW } from './fleet-fixtures.ts';
import type { Fleet, FleetHealth, FleetRow } from '../src/fleet.ts';

const fleet = (rows: FleetRow[], h: Partial<FleetHealth> = {}): Fleet => ({ rows, health: health(h) });

test('prints a header, a row and the fleet summary', () => {
  const out = renderTable(fleet([row()]));
  assert.match(out, /PROJECT +STATE +CTX/);
  assert.match(out, /alpha +idle +26% /);
  assert.match(out, /1 sessions · 0 busy · \$27\.75/);
});

// `?` is this column's word for "a status tarmac does not recognise", and it may not lead the
// one status tarmac now knows by name. The reason travels beside the word rather than being
// left to the page: `list` is the whole product for someone who never starts a serve.
test('a waiting session is named in the state column, with what it is waiting for', () => {
  const out = renderTable(fleet([row({ busy: null, status: 'waiting', waitingFor: 'permission prompt' })]));
  assert.match(out, /waiting · permission prompt/);
  assert.equal(/\?waiting/.test(out), false, 'not a word the tool failed to recognise');
});

// The state comes from the word, never from the presence of its caption — and a column that
// widens for a reason nobody gave is a column of trailing spaces.
test('a waiting session that gave no reason is still named waiting', () => {
  assert.match(renderTable(fleet([row({ busy: null, status: 'waiting', waitingFor: null })])), /alpha +waiting +26%/);
});

// "" is not a reason either. Both copies of the rule check truthiness, not null — an empty
// string once printed the separator with nothing after it.
test('a waiting session with an empty reason is named waiting alone', () => {
  const out = renderTable(fleet([row({ busy: null, status: 'waiting', waitingFor: '' })]));
  assert.doesNotMatch(out, /waiting ·/);
  assert.match(out, /alpha +waiting +26%/);
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

// The same shape as the `unreadable` warning below: a count is what tells two identical-looking
// causes apart. Since #7 a session whose id is not the UUID the wrapper files under reports no
// context FOREVER, and the bare coverage line reads as "run install" — advice that is already
// done and cannot work. The number has to travel, or the honest half of that trade is invisible.
test('says how many sessions carry an id it will never file, next to the coverage', () => {
  const out = renderTable(fleet([row({ ctxState: 'absent', ctxPct: null })], { sessions: 3, covered: 1, unfilable: 2 }));
  // The literal sentence, not a loose pattern: `/2 .*(never|cannot|not)/i` passed against the
  // pre-#7 line too, so it pinned nothing at all.
  assert.match(out, /! statusline chained on 1\/3 sessions — 2 session\(s\) with an id tarmac never files/);
});

test('says nothing about unfilable ids when every uncovered session is a frame away', () => {
  const out = renderTable(fleet([row()], { sessions: 3, covered: 1, unfilable: 0 }));
  assert.match(out, /! statusline chained on 1\/3 sessions$/m, 'the bare line, with nothing appended');
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

// #49: four of the eight columns carry a string nothing bounds at the source, and one long
// value in any of them stretched every row of the table past 190 columns — on a terminal
// wrapping at 80, an unreadable fleet. The worst case a fleet can hand this renderer, in one
// row: the row has to fit, and the cut has to be visible where it happened.
const WIDEST = row({
  project: 'a'.repeat(60),
  busy: null,
  status: 'waiting',
  waitingFor: 'b'.repeat(60),
  model: 'c'.repeat(60),
  effort: 'd'.repeat(60),
  costUsd: 98765.43,
  uptimeMs: 999 * 3600_000,
});

test('caps every column a fleet could stretch, and marks where it cut', () => {
  const out = renderTable(fleet([WIDEST], { costUsd: 98765.43 }));
  const table = out.split('\n').slice(0, 2);
  for (const l of table) assert.ok(l.length <= 120, `a row ${l.length} columns wide: ${l}`);
  for (const cut of ['a', 'b', 'c', 'd']) assert.match(out, new RegExp(`${cut}+…`), `${cut} is cut, and says so`);
});

// The ellipsis is inside the cap, not added past it — otherwise the widest cell is one
// character wider than the column that was supposed to hold it.
test('an unknown status word is cut too, and never past its column', () => {
  const out = renderTable(fleet([row({ busy: null, status: 'z'.repeat(80) })], { unknownStatus: 1 }));
  assert.match(out, /\?z+…/);
  assert.ok(out.split('\n')[1].length <= 120);
});

// The same property pinned to the character: nineteen glyphs, the ellipsis, then padding. An
// off-by-one in the cut (slice(0, cap) instead of cap - 1) moves the … one column right, and
// the ≤ 120 assert above has too much slack to see one character.
test('spends the ellipsis out of the cap, never past it', () => {
  const out = renderTable(fleet([row({ project: 'p'.repeat(60) })]));
  assert.match(out.split('\n')[1], /^p{19}… {2}/);
});

// "Cut by code point" is a claim about astral glyphs, so it is tested with one: a name of
// rockets must never come back ending in half a surrogate pair.
test('cuts by code point — never half a surrogate pair', () => {
  const out = renderTable(fleet([row({ project: '🚀'.repeat(60) })]));
  assert.doesNotMatch(out, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

// A cap that bites a fleet nobody would call wide is a cap that hides the fleet. Every value
// of the fixture fits its column, and none of them may come out marked.
test('leaves an ordinary fleet whole', () => {
  assert.doesNotMatch(renderTable(fleet([row(), row({ project: 'mercury-dashboard', model: 'Opus 5' })])), /…/);
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

// ── the account's two windows ───────────────────────────────────────────────────────────
//
// The one pair of numbers in `list` that is not about a session: every session in the table
// spends from the same five-hour and seven-day allowance, so it is printed once under the
// fleet rather than in a column beside each row. The rules are the page's, in the terminal's
// words — a window nobody read is never 0%, and the reading carries the age of the snapshot it
// came from, exactly like the AS OF column above it.

/** An account read a moment ago: 17% of five hours, 42% of seven days. */
const limits = (over: Record<string, any> = {}): Record<string, any> => ({
  five_hour: { used_percentage: 17, resets_at: NOW / 1000 + 8040 },
  seven_day: { used_percentage: 42, resets_at: NOW / 1000 + 300_000 },
  ...over,
});

test('prints the account line under the fleet, with both windows and what is left of each', () => {
  const out = renderTable(fleet([row({ rateLimits: limits() })]));
  assert.match(out, /account +5h 17% resets in 2h 14m · 7d 42% resets in 3d 11h/);
});

test('the account is said once for the fleet, not once per session', () => {
  const rl = limits();
  const out = renderTable(fleet([row({ rateLimits: rl }), row({ sessionId: 's2', rateLimits: rl })], { sessions: 2 }));
  assert.equal((out.match(/5h 17%/g) ?? []).length, 1);
});

// The rule the AS OF column follows, one line down: the percentage is as old as the snapshot
// that carried it, and a fleet where every terminal idles is a fleet of yesterday's numbers.
test('the account reading carries the age of the snapshot it came from', () => {
  assert.match(renderTable(fleet([row({ rateLimits: limits(), snapshotAgeMs: 120_000 })])), /as of 2m$/m);
});

test('an account reading past the freshness threshold wears the same mark the rows do', () => {
  const out = renderTable(fleet([row({ rateLimits: limits(), snapshotAgeMs: 40 * 60_000, stale: true })], { stale: 1 }));
  assert.match(out, /as of 40m !$/m);
});

// This project's cardinal sin, in the terminal: a fleet whose snapshots carry no rate limits
// has not told us the account is empty.
test('a fleet with no rate limits says so in both windows, and never prints 0%', () => {
  const out = renderTable(fleet([row()]));
  assert.match(out, /account +5h — no reading · 7d — no reading/);
  assert.equal(/0%/.test(out), false);
});

test('a window whose shape moved says drift, and the other one is still printed', () => {
  const out = renderTable(fleet([row({ rateLimits: { five_hour: { used_percentage: '17%' }, seven_day: { used_percentage: 42 } } })]));
  assert.match(out, /5h — schema drift/);
  assert.match(out, /7d 42%/);
});

// The half of this the freshest-wins rule cannot answer on its own. Two sessions naming
// different resets are not one allowance read twice, and the number printed is one of them —
// so the line says how many readings it speaks for instead of presenting a picked winner as
// the account.
test('readings that name a different window are counted, and the window is named', () => {
  const out = renderTable(
    fleet(
      [
        row({ rateLimits: limits({ five_hour: { used_percentage: 91, resets_at: NOW / 1000 + 60 } }), snapshotAgeMs: 90_000 }),
        row({ sessionId: 's2', rateLimits: limits(), snapshotAgeMs: 1200 }),
      ],
      { sessions: 2 },
    ),
  );
  assert.match(out, /! the 5h window is read differently by 1 of 2 readings — the freshest is shown/);
  assert.match(out, /5h 17%/, 'the freshest is still printed — there is nothing better to print');
});

test('a fleet whose readings agree says nothing about disagreement', () => {
  const rl = limits();
  const out = renderTable(fleet([row({ rateLimits: rl }), row({ sessionId: 's2', rateLimits: rl, snapshotAgeMs: 90_000 })], { sessions: 2 }));
  assert.doesNotMatch(out, /read differently/);
});

// The fleet this used to warn about every night, and the reason the openness rule exists: a
// session that idles keeps the frame it last drew, and the five-hour window rolls over four or
// five times a day. Its snapshot names the window it was taken in, which has ended — a fact
// the AS OF column and the stale warning already carry between them.
test('a session whose window rolled over hours ago is old, and is not called a disagreement', () => {
  const out = renderTable(
    fleet(
      [
        row({ rateLimits: limits(), snapshotAgeMs: 1200 }),
        row({
          sessionId: 's2',
          snapshotAgeMs: 6 * 3600_000,
          stale: true,
          rateLimits: limits({ five_hour: { used_percentage: 91, resets_at: NOW / 1000 - 3600 } }),
        }),
      ],
      { sessions: 2, stale: 1 },
    ),
  );
  assert.doesNotMatch(out, /read differently/);
  assert.match(out, /5h 17%/, 'the freshest is still the account line');
});

// The sentence qualifies a number. A window the line under it prints as `— schema drift` has no
// number to qualify, and "the freshest is shown" said of it promises one that is not there.
test('the split names only a window the account line actually prints a number for', () => {
  const drifted = { five_hour: { used_percentage: '17%', resets_at: NOW / 1000 + 600 }, seven_day: { used_percentage: 42, resets_at: NOW / 1000 + 300_000 } };
  const other = { five_hour: { used_percentage: 61, resets_at: NOW / 1000 + 8040 }, seven_day: { used_percentage: 42, resets_at: NOW / 1000 + 300_000 } };
  const out = renderTable(fleet([row({ rateLimits: drifted, snapshotAgeMs: 1200 }), row({ sessionId: 's2', rateLimits: other, snapshotAgeMs: 90_000 })], { sessions: 2 }));
  assert.match(out, /5h — schema drift/);
  assert.doesNotMatch(out, /read differently/);
});
