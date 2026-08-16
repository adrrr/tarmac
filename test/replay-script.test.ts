// The scrubber, driven.
//
// The map's rules are enforced on the server, where this suite can reach them — but a replay
// is drawn in the browser out of samples the page already holds, which is the one thing the
// issue asks for and the one place a second copy of those rules could quietly disagree with
// the first. So these run the string the page actually ships, against a record it is handed.
//
// What is being defended, in one line: a page replaying the past must never be mistakable for
// a page showing the present.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMap, renderPage } from '../src/render.ts';
import { mountPage, scriptOf } from './page-dom.ts';
import type { MountOptions } from './page-dom.ts';
import { health, row } from './fleet-fixtures.ts';
import type { HistoryPayload, HistorySession } from '../src/history.ts';

const SCRIPT = scriptOf(renderPage({ rows: [row()], health: health() }, 'map'));

/** The harness's own clock, which is what the page reads as "now". */
const CLOCK = 1_700_000_000_000;
const MIN = 60_000;

const hhmm = (t: number): string => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const session = (over: Partial<HistorySession> = {}): HistorySession => ({
  sid: 's1',
  project: 'alpha',
  kind: 'interactive',
  state: 'idle',
  ctxState: 'ok',
  ctxPct: 26,
  costUsd: 1.5,
  ...over,
});

/** A record of `n` minutes ending now, one reading a minute. */
const record = (n: number, at: (i: number) => HistorySession[] = () => [session()]): HistoryPayload => ({
  since: CLOCK - n * MIN,
  cadence: MIN,
  samples: Array.from({ length: n }, (_, i) => ({ t: CLOCK - (n - 1 - i) * MIN, sessions: at(i), rateLimits: null })),
  missed: 0,
});

const ok = (body: string): Promise<{ ok: boolean; body: string }> => Promise.resolve({ ok: true, body });

/** A page whose server answers the fleet now, and the day behind it. */
function mount(
  hist: HistoryPayload | (() => Promise<{ ok: boolean; body: string; headers?: Record<string, string> }>),
  live: () => Promise<{ ok: boolean; body: string }> = () => ok('<div>the fleet now</div>'),
  options: MountOptions = {},
) {
  const answerHistory = typeof hist === 'function' ? hist : () => ok(JSON.stringify(hist));
  return mountPage(SCRIPT, (_call, url) => (url.indexOf('/api/history') === 0 ? answerHistory() : live()), options);
}

// ── what the record says it covers ──────────────────────────────────────────────────────

// The scrubber appears only once there is something behind it, and the span it offers is the
// span the record answered with — never "a day", which is the size of the ring and not of
// what a serve started ten minutes ago has seen.
test('the record is fetched once at load, and the range says what it really covers', async () => {
  const page = mount(record(10));
  await page.advance(0);
  assert.equal(page.el('replay').hidden, false, 'the handle appears');
  assert.equal(page.el('scrub').max, '9', 'one position per reading held');
  assert.match(page.el('covers').textContent, new RegExp(hhmm(CLOCK - 10 * MIN)), 'from when this serve started');
  assert.match(page.el('covers').textContent, new RegExp(hhmm(CLOCK)), 'to the last reading it took');
  assert.match(page.el('covers').textContent, /10 reading/);
});

// A gap that says it is a gap is not a gap — but a scrubber whose positions are readings and
// not minutes owes the reader that difference, or the walk it offers is not the walk it makes.
test('minutes the record missed are named, not smoothed over', async () => {
  const page = mount({ ...record(4), missed: 7 });
  await page.advance(0);
  assert.match(page.el('covers').textContent, /7 .*no reading/);
});

test('a record with nothing in it yet says so, and leaves no dead handle', async () => {
  const page = mount({ since: CLOCK, cadence: MIN, samples: [], missed: 0 });
  await page.advance(0);
  assert.equal(page.el('scrub').disabled, true);
  assert.equal(page.el('play').disabled, true);
  assert.match(page.el('covers').textContent, /nothing recorded yet/i);
});

test('a record that cannot be read says why, instead of offering a handle that does nothing', async () => {
  const page = mount(() => Promise.resolve({ ok: false, body: 'the record is gone' }));
  await page.advance(0);
  assert.equal(page.el('scrub').disabled, true);
  assert.match(page.el('covers').textContent, /could not be read/i);
});

// Loopback says where an answer came from, never who wrote it — the same rule the fragment
// already follows, and this answer is parsed and drawn into the page just as it is.
test('a record that cannot prove it is tarmac is never drawn', async () => {
  const page = mount(() => Promise.resolve({ ok: true, body: JSON.stringify(record(3)), headers: {} }));
  await page.advance(0);
  assert.equal(page.el('scrub').disabled, true);
  assert.match(page.el('covers').textContent, /tarmac/i);
});

// ── the replay itself ───────────────────────────────────────────────────────────────────

test('dragging the handle draws that minute, and the page says which minute it is', async () => {
  const page = mount(record(10, (i) => [session({ project: `p${i}`, ctxPct: i * 10 })]));
  await page.advance(0);
  page.el('scrub').drag(3);
  assert.equal(page.el('replaying').hidden, false, 'the banner is up');
  assert.equal(page.el('replay-at').textContent, hhmm(CLOCK - 6 * MIN));
  assert.match(page.el('replay-map').innerHTML, /p3/);
  assert.equal(page.body.classes.has('replaying'), true, 'and the live map is hidden by the body class');
});

// The whole point of holding the day in the page: a drag is a lookup, not a request. A
// scrubber that asked per position would spawn `claude agents --json` on every pixel.
test('scrubbing asks the server nothing', async () => {
  const page = mount(record(30));
  await page.advance(0);
  const before = page.calls;
  for (let i = 0; i < 30; i++) page.el('scrub').drag(i);
  assert.equal(page.calls, before, 'not one request left the page');
});

// The rule that separates a replay from a fabrication: what was not there is not drawn.
test('a session absent from a sample is absent from the map, not a dial at zero', async () => {
  const page = mount(
    record(2, (i) =>
      i === 0 ? [session({ sid: 'a', project: 'alpha' }), session({ sid: 'b', project: 'beta' })] : [session({ sid: 'a', project: 'alpha' })],
    ),
  );
  await page.advance(0);
  page.el('scrub').drag(0);
  assert.equal((page.el('replay-map').innerHTML.match(/<article/g) ?? []).length, 2);
  page.el('scrub').drag(1);
  const html = page.el('replay-map').innerHTML;
  assert.equal((html.match(/<article/g) ?? []).length, 1);
  assert.doesNotMatch(html, /beta/, 'the session that had gone is gone');
});

// The halo means "a frame landed moments ago", which is never true of a sample. It is the one
// thing on the live map that moves, and the replay is the one place it would be a lie.
test('nothing in a replay pulses', async () => {
  const page = mount(record(3));
  await page.advance(0);
  page.el('scrub').drag(1);
  assert.doesNotMatch(page.el('replay-map').innerHTML, /halo|just landed/);
});

// This project's cardinal sin, in the past tense: a percentage nobody took must not become a
// confident empty ring — which is what a session measured at 0% wears.
test('a reading nobody took keeps its dotted dial and its reason in the past too', async () => {
  const page = mount(record(1, () => [session({ ctxPct: null, ctxState: 'absent' })]));
  await page.advance(0);
  page.el('scrub').drag(0);
  const html = page.el('replay-map').innerHTML;
  assert.match(html, /class="track unmeasured"/);
  assert.doesNotMatch(html, /class="arc"/);
  assert.match(html, /not chained/);
});

// The one duplication this feature could not avoid — the arc is drawn in the browser now —
// pinned against the server's own arithmetic rather than left to drift.
test('a replayed arc is drawn to exactly the size the live map would draw it', async () => {
  const page = mount(record(1, () => [session({ ctxPct: 62 })]));
  await page.advance(0);
  page.el('scrub').drag(0);
  const server = /stroke-dasharray="[\d. ]+"/.exec(renderMap({ rows: [row({ ctxPct: 62 })], health: health() }))![0];
  assert.match(page.el('replay-map').innerHTML, new RegExp(server.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

// Everything in the record came off someone else's machine: a directory name is a string
// tarmac does not own, and it is written into this page with innerHTML.
test('a project name off the machine is escaped, never drawn', async () => {
  const page = mount(record(1, () => [session({ project: '<img src=x onerror=alert(1)>' })]));
  await page.advance(0);
  page.el('scrub').drag(0);
  assert.doesNotMatch(page.el('replay-map').innerHTML, /<img/);
  assert.match(page.el('replay-map').innerHTML, /&lt;img/);
});

// A background agent replays as what the ring holds: what kind of thing it was and what it
// had cost. The ring stores no name, because a background session is named after its prompt.
test('an agent replays as a kind and its numbers', async () => {
  const page = mount(
    record(1, () => [session({ sid: 'a' }), session({ sid: 'b', kind: 'background', project: 'alpha', costUsd: 0.42 })]),
  );
  await page.advance(0);
  page.el('scrub').drag(0);
  const html = page.el('replay-map').innerHTML;
  assert.match(html, /data-role="agent"/);
  assert.match(html, /background/);
  assert.match(html, /\$0\.42/);
});

test('the replay counts the fleet of that minute, not of this one', async () => {
  const page = mount(
    record(1, () => [session({ sid: 'a', state: 'busy', costUsd: 2 }), session({ sid: 'b', state: 'idle', costUsd: 3 })]),
  );
  await page.advance(0);
  page.el('scrub').drag(0);
  assert.match(page.el('replay-meta').textContent, /2 sessions/);
  assert.match(page.el('replay-meta').textContent, /1 busy/);
  assert.match(page.el('replay-meta').textContent, /\$5\.00/);
});

// ── the present, still running underneath ───────────────────────────────────────────────

// A page left on replay must not rot: the poll goes on, so the way back is instant rather than
// a reload — and the header's age keeps counting, which is what proves it.
test('the live poll keeps running under a replay, and one gesture returns to it', async () => {
  const page = mount(record(5), () => ok('<div>the fleet now</div>'));
  await page.advance(0);
  page.el('scrub').drag(2);
  const before = page.calls;
  await page.advance(11_000);
  assert.ok(page.calls > before, 'the present was still being read');
  assert.equal(page.el('live').innerHTML, '<div>the fleet now</div>', 'and swapped in underneath');

  page.el('to-live').fire('click');
  assert.equal(page.el('replaying').hidden, true);
  assert.equal(page.el('replay-view').hidden, true);
  assert.equal(page.body.classes.has('replaying'), false);
  assert.equal(page.el('replay-map').innerHTML, '', 'and the past is not left lying in the page');
});

// The reason all of this lives in the shell. A poll swaps the fragment under the reader's
// hand; what the reader is holding is not in the fragment.
test('a poll landing mid-replay does not repaint what the reader is holding', async () => {
  const page = mount(record(5, (i) => [session({ project: `p${i}` })]));
  await page.advance(0);
  page.el('scrub').drag(1);
  const shown = page.el('replay-map').innerHTML;
  await page.advance(11_000);
  assert.equal(page.el('replay-map').innerHTML, shown, 'the replayed minute is untouched');
  assert.equal(page.el('replaying').hidden, false, 'and the page still says it is replaying');
});

// The handle stays where it was let go of, so what it shows and what play would do next are
// the same thing. Resetting the position while leaving the handle at half past two made the
// next press of play jump to the start for no reason the page had given.
test('leaving the replay leaves the handle where the reader left it, and play resumes there', async () => {
  const page = mount(record(10, (i) => [session({ project: `p${i}` })]));
  await page.advance(0);
  page.el('scrub').drag(6);
  page.el('to-live').fire('click');
  assert.equal(page.el('scrub').value, '6');
  page.el('play').fire('click');
  assert.match(page.el('replay-map').innerHTML, /p6/, 'it picked up where the handle was');
});

// ── play ────────────────────────────────────────────────────────────────────────────────

test('play walks the record forward and stops at the end rather than looping', async () => {
  const page = mount(record(4, (i) => [session({ project: `p${i}` })]));
  await page.advance(0);
  page.el('play').fire('click');
  await page.advance(2000);
  assert.match(page.el('replay-map').innerHTML, /p3/, 'it reached the last reading');
  assert.equal(page.el('play').textContent, 'Play', 'and handed the button back');
  await page.advance(5000);
  assert.match(page.el('replay-map').innerHTML, /p3/, 'and stayed there');
});

test('play can be stopped mid-record, and the handle is where it stopped', async () => {
  const page = mount(record(60, (i) => [session({ project: `p${i}` })]));
  await page.advance(0);
  page.el('play').fire('click');
  await page.advance(500);
  page.el('play').fire('click');
  const held = page.el('scrub').value;
  await page.advance(5000);
  assert.equal(page.el('scrub').value, held, 'nothing moved after it was paused');
});

// Motion is the first thing a reader who asked for less of it stops getting — but the button
// is the feature, so it slows down rather than going away.
test('play is calm for a reader who asked for less motion, and still plays', async () => {
  const page = mount(record(60, (i) => [session({ project: `p${i}` })]), undefined, { reducedMotion: true });
  await page.advance(0);
  page.el('play').fire('click');
  await page.advance(1000);
  assert.equal(page.el('scrub').value, '1', 'one reading a second, not ten');
  await page.advance(3000);
  assert.equal(page.el('scrub').value, '4', 'and it is still walking');
});

// ── the record, later ───────────────────────────────────────────────────────────────────

// A page opened at nine and looked at again at four holds a record that stops at nine. It is
// asked again on the way back in — once, on waking, and never while a reader is scrubbing it.
test('a tab that comes back later picks up the minutes it missed', async () => {
  let served = record(5);
  const page = mount(() => ok(JSON.stringify(served)));
  await page.advance(0);
  assert.equal(page.el('scrub').max, '4');
  served = record(90);
  page.hide();
  await page.advance(3 * MIN);
  await page.show();
  assert.equal(page.el('scrub').max, '89', 'the record it offers is the one the serve has now');
});

test('the record is not pulled again under a reader who is scrubbing it', async () => {
  let served = record(5);
  const page = mount(() => ok(JSON.stringify(served)));
  await page.advance(0);
  page.el('scrub').drag(1);
  served = record(90);
  page.hide();
  await page.advance(3 * MIN);
  await page.show();
  assert.equal(page.el('scrub').max, '4', 'what the reader is holding is left alone');
});
