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
import { renderLimits, renderMap, renderPage } from '../src/render.ts';
import { mountPage, scriptOf, shellState } from './page-dom.ts';
import type { MountOptions } from './page-dom.ts';
import { health, row } from './fleet-fixtures.ts';
import type { HistoryPayload, HistorySession } from '../src/history.ts';

const PAGE = renderPage({ rows: [row()], health: health() }, 'map');
const SCRIPT = scriptOf(PAGE);
/**
 * The elements start where the served markup puts them — hidden, disabled — so that an
 * assertion the script REVEALED something is an assertion about the script. Without this the
 * fake DOM starts everything visible, and "the banner is up" passes on a page that never
 * raised it: a replay drawn with no banner at all, green.
 */
const SHELL = shellState(PAGE);

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
  waitingFor: null,
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
  return mountPage(SCRIPT, (_call, url) => (url.indexOf('/api/history') === 0 ? answerHistory() : live()), {
    shell: SHELL,
    ...options,
  });
}

// ── what the record says it covers ──────────────────────────────────────────────────────

// The scrubber appears only once there is something behind it, and the span it offers is the
// span the record answered with — never "a day", which is the size of the ring and not of
// what a serve started ten minutes ago has seen.
test('the record is fetched once at load, and the range says what it really covers', async () => {
  const page = mount(record(10));
  assert.equal(page.el('replay').hidden, true, 'nothing is offered before the record is in hand');
  await page.advance(0);
  assert.equal(page.el('replay').hidden, false, 'the handle appears');
  assert.equal(page.el('scrub').disabled, false, 'and it can be moved');
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

// The one case where `missed` is the only thing there is to say, and the only branch that
// dropped it: a serve whose collector has failed for ten hours holds no samples at all, and
// read as a serve that had just started.
test('a record empty because every reading failed says that, not that it just started', async () => {
  const page = mount({ since: CLOCK - 600 * MIN, cadence: MIN, samples: [], missed: 600 });
  await page.advance(0);
  assert.match(page.el('covers').textContent, /600 minute/, 'the failures are named');
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
  assert.equal(page.el('replaying').hidden, true, 'a page nobody has scrubbed claims no replay');
  page.el('scrub').drag(3);
  assert.equal(page.el('replaying').hidden, false, 'the banner is up');
  assert.equal(page.el('replay-view').hidden, false, 'and the past is on screen');
  assert.equal(page.el('replay-at').textContent, hhmm(CLOCK - 6 * MIN));
  assert.match(page.el('replay-map').innerHTML, /p3/);
  assert.equal(page.body.classes.has('replaying'), true, 'and the live map is hidden by the body class');
});

// The banner is a yellow box, which is nothing at all to the one audience that cannot see it.
// The handle's own value is an index — "3" — so the minute has to travel with it, or a reader
// can drag the fleet three hours into the past and be told a number that means nothing.
test('the minute travels with the handle, for a reader who cannot see the banner', async () => {
  const page = mount(record(10));
  await page.advance(0);
  page.el('scrub').drag(3);
  assert.equal(page.el('scrub').getAttribute('aria-valuetext'), hhmm(CLOCK - 6 * MIN));
  page.el('to-live').fire('click');
  assert.equal(page.el('scrub').getAttribute('aria-valuetext'), null, 'and goes when the past does');
});

// The arc's weight is the live map's channel for "how much this reading may be believed", and
// the ring keeps each reading but never how old it was. Drawn at the live default, every
// replayed dial asserted a confidence the record cannot support — so the markup carries the
// fact instead of leaving it to a grey sentence under the scrubber.
test('a replayed dial says in its markup that the record cannot date it', async () => {
  const page = mount(record(1, () => [session({ ctxPct: 62 })]));
  await page.advance(0);
  page.el('scrub').drag(0);
  assert.match(page.el('replay-map').innerHTML, /data-reading="undatable"/);
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
test('every value the record carries off the machine is escaped, never drawn', async () => {
  for (const field of ['project', 'kind'] as const) {
    const page = mount(record(1, () => [session({ [field]: '<img src=x onerror=alert(1)>' })]));
    await page.advance(0);
    page.el('scrub').drag(0);
    assert.doesNotMatch(page.el('replay-map').innerHTML, /<img/, field);
    assert.match(page.el('replay-map').innerHTML, /&lt;img/, field);
  }
});

// `state` and `ctxState` are looked up in the two tables the server hands over, and a bare
// property read on an object inherits from its prototype: `constructor` and `toString` passed
// the guard and reached the markup — one of them into an attribute, unescaped.
test('a state the vocabulary does not contain is unknown, even when Object has a key for it', async () => {
  const page = mount(record(1, () => [session({ state: 'constructor' as never, ctxState: 'toString' as never, ctxPct: null })]));
  await page.advance(0);
  page.el('scrub').drag(0);
  const html = page.el('replay-map').innerHTML;
  assert.match(html, /data-state="unknown"/);
  assert.doesNotMatch(html, /native code|function/, 'no function body reached the page');
});

// A waiting minute replays as a waiting minute. The caption is drawn from the sample's own
// field, out of the same branch the live map uses — a replay that showed the state without
// the reason would answer "what was it blocked on?" with the one word the reader already had.
test('a waiting session replays as waiting, with the reason it was waiting for', async () => {
  const page = mount(record(1, () => [session({ state: 'waiting', waitingFor: 'dialog open' })]));
  await page.advance(0);
  page.el('scrub').drag(0);
  const html = page.el('replay-map').innerHTML;
  assert.match(html, /data-state="waiting"/);
  assert.match(html, /waiting-for">dialog open</);
});

test('a replayed waiting session with no reason carries no caption', async () => {
  const page = mount(record(1, () => [session({ state: 'waiting', waitingFor: null })]));
  await page.advance(0);
  page.el('scrub').drag(0);
  assert.doesNotMatch(page.el('replay-map').innerHTML, /waiting-for/);
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

// Leaving mid-walk has to stop the walk. Without it the page re-enters the replay by itself a
// tenth of a second after the reader asked to leave — banner back up, live fleet hidden again.
test('going back to live while it is playing stops the walk', async () => {
  const page = mount(record(60, (i) => [session({ project: `p${i}` })]));
  await page.advance(0);
  page.el('play').fire('click');
  await page.advance(300);
  page.el('to-live').fire('click');
  await page.advance(2000);
  assert.equal(page.el('replaying').hidden, true, 'it stayed left');
  assert.equal(page.body.classes.has('replaying'), false);
  assert.equal(page.el('replay-map').innerHTML, '');
});

// Grabbing the handle mid-walk hands control back to the reader, rather than leaving a walk
// running under their hand with a button still reading "Pause".
test('grabbing the handle while it is playing stops the walk there', async () => {
  const page = mount(record(60, (i) => [session({ project: `p${i}` })]));
  await page.advance(0);
  page.el('play').fire('click');
  await page.advance(300);
  page.el('scrub').drag(40);
  assert.equal(page.el('play').textContent, 'Play', 'the button says what it now does');
  await page.advance(2000);
  assert.equal(page.el('scrub').value, '40', 'and nothing walked on from where they put it');
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

// The table has no scrubber — the stylesheet hides it — and a full ring is megabytes of
// session ids, projects and costs. The default view was fetching and parsing all of it to
// write a sentence into an element with display:none.
test('the table view never asks for the record it has nowhere to show', async () => {
  const script = scriptOf(renderPage({ rows: [row()], health: health() }, 'table'));
  const asked: string[] = [];
  const page = mountPage(
    script,
    (_call, url) => {
      asked.push(url);
      return ok('<div>the fleet now</div>');
    },
    { shell: SHELL },
  );
  await page.advance(6000);
  assert.ok(asked.length > 0, 'it still reads the fleet');
  assert.deepEqual(asked.filter((u) => u.indexOf('/api/history') === 0), [], 'and nothing else');
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

/**
 * A stalled second answer. The first load succeeds; every later one hangs until the test
 * releases it, which is the window between a tab regaining focus and its refetch landing —
 * the window a reader's hand arrives in.
 */
function stalling(first: HistoryPayload) {
  let release: ((answer: { ok: boolean; body: string }) => void) | null = null;
  let calls = 0;
  const answer = (): Promise<{ ok: boolean; body: string }> => {
    calls++;
    if (calls === 1) return ok(JSON.stringify(first));
    return new Promise((r) => {
      release = r;
    });
  };
  return { answer, land: (a: { ok: boolean; body: string }): void => release!(a) };
}

/** Tab away long enough for the refresh to be due, and come back. */
async function awayAndBack(page: { hide(): void; show(): Promise<void>; advance(ms: number): Promise<void> }) {
  page.hide();
  await page.advance(3 * MIN);
  await page.show();
}

// The guard the poll has had all along, which the record's own fetch did not: the `!replaying`
// test is read when the tab regains focus, and the reader's hand arrives AFTER that, while the
// answer is still in flight. Landing it then swapped the record under a live scrub — the handle
// pointing at one minute and the map drawing another, out of a record that no longer existed.
test('a record that lands after the reader has grabbed the handle is not swapped in under them', async () => {
  const serve = stalling(record(5, (i) => [session({ project: `old${i}` })]));
  const page = mount(serve.answer);
  await page.advance(0);
  await awayAndBack(page);

  page.el('scrub').drag(2);
  serve.land({ ok: true, body: JSON.stringify(record(90, (i) => [session({ project: `new${i}` })])) });
  await page.advance(0);

  assert.equal(page.el('scrub').max, '4', 'the record under their hand was left alone');
  assert.match(page.el('replay-map').innerHTML, /old2/, 'and the minute they are holding still exists');
});

// A refresh is not a first load. Failing one used to disable the scrubber and tell the reader
// the record could not be read — while the page was still holding a perfectly good one.
test('a refresh that fails leaves the reader the record the page already had', async () => {
  const serve = stalling(record(30));
  const page = mount(serve.answer);
  await page.advance(0);
  await awayAndBack(page);

  serve.land({ ok: false, body: 'the record is gone' });
  await page.advance(0);

  assert.equal(page.el('scrub').disabled, false, 'the handle still works');
  assert.equal(page.el('scrub').max, '29', 'over the record it already had');
  assert.doesNotMatch(page.el('covers').textContent, /could not be read/i);
});

// The same failure, arriving while the record is being played: it must not disable the
// controls under a walk that is still running, leaving a dead button reading "Pause".
test('a refresh that fails while the record is playing leaves the controls alive', async () => {
  const serve = stalling(record(60, (i) => [session({ project: `p${i}` })]));
  const page = mount(serve.answer);
  await page.advance(0);
  await awayAndBack(page);

  page.el('play').fire('click');
  serve.land({ ok: false, body: 'the record is gone' });
  await page.advance(300);

  assert.equal(page.el('play').disabled, false, 'the reader can still stop it');
  assert.equal(page.el('play').textContent, 'Pause', 'and the button says what it does');
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

// ── the account, as it stood that minute ────────────────────────────────────────────────
//
// The five-hour window draining and refilling across a day is the thing the record was always
// carrying and nothing was drawing. It is the one pair of numbers on this page that is about
// the account rather than a session, so a replay that left the LIVE pair standing in the header
// would be showing the fleet of three hours ago under the allowance of right now.

/** A record whose one sample is `t` old and carries the account as it stood then. */
const account = (agoMs: number, rateLimits: Record<string, any> | null): HistoryPayload => {
  const t = CLOCK - agoMs;
  return { since: t, cadence: MIN, samples: [{ t, sessions: [session()], rateLimits }], missed: 0 };
};

test('the replayed minute brings the account of that minute with it', async () => {
  const page = mount(account(0, { five_hour: { used_percentage: 63 }, seven_day: { used_percentage: 12 } }));
  await page.advance(0);
  assert.equal(page.el('replay-limits').hidden, true, 'a page nobody has scrubbed shows no past account');
  page.el('scrub').drag(0);
  assert.equal(page.el('replay-limits').hidden, false);
  assert.match(page.el('replay-limits').innerHTML, /63%/);
  assert.match(page.el('replay-limits').innerHTML, /12%/);
});

// The decision this feature turns on. A reset is a moment, and "how long is left" is a question
// about the minute being replayed: at 09:14 the five-hour window had two hours to run, and it
// had two hours to run whatever time it is now. Counted against the present instead, every
// reset in the record would read as long overdue the moment it aged past — the page announcing
// an account over its limit for a day that has already ended.
test('a replayed reset is counted from the sample own minute, never from now', async () => {
  const t = CLOCK - 180 * MIN;
  const page = mount(account(180 * MIN, { five_hour: { used_percentage: 63, resets_at: (t + 2 * 3600_000) / 1000 } }));
  await page.advance(0);
  page.el('scrub').drag(0);
  assert.match(page.el('replay-limits').innerHTML, /resets in 2h/);
  assert.doesNotMatch(page.el('replay-limits').innerHTML, /due/, 'not overdue against a clock it never ran on');
});

// This project's cardinal sin, in the past tense and at the top of the page.
test('a minute whose snapshots carried no rate limits replays as no reading, never as 0%', async () => {
  const page = mount(account(0, null));
  await page.advance(0);
  page.el('scrub').drag(0);
  const html = page.el('replay-limits').innerHTML;
  assert.match(html, /no reading/);
  assert.doesNotMatch(html, /\b0%/);
  assert.match(html, /rail unmeasured/);
});

test('back to live takes the replayed account down with the rest of the past', async () => {
  const page = mount(account(0, { five_hour: { used_percentage: 63 } }));
  await page.advance(0);
  page.el('scrub').drag(0);
  page.el('to-live').fire('click');
  assert.equal(page.el('replay-limits').hidden, true);
  assert.equal(page.el('replay-limits').innerHTML, '', 'and the past is not left lying in the page');
});

// The second duplication this feature could not avoid — the gauges are drawn in the browser now
// — pinned against the server's own render rather than left to drift. Character for character,
// over the shapes a payload nobody here owns can actually arrive in: the words, the dash, the
// rail and the arithmetic all come from one place, and this is what says so.
//
// One well-formed object would not have said it. The first version of this mirror answered
// `no reading` where the server answered `schema drift` for every rate_limits that was present
// but not a pair of windows — an array among them, which `extractTelemetry` lets through — so
// the same minute read one way live and the opposite way replayed.
for (const [what, rateLimits] of [
  ['both windows, one of them due to reset', { five_hour: { used_percentage: 63.7, resets_at: (CLOCK + 8040_000) / 1000 }, seven_day: { used_percentage: 42 } }],
  ['a window that has already reset', { five_hour: { used_percentage: 90, resets_at: (CLOCK - 1_200_000) / 1000 } }],
  ['nothing at all', null],
  ['an empty object', {}],
  ['an array', [] as any],
  ['an array of windows', [{ used_percentage: 9 }] as any],
  ['a string', 'none' as any],
  ['a number', 42 as any],
  ['a percentage not taken yet', { five_hour: { used_percentage: null, resets_at: (CLOCK + 60_000) / 1000 } }],
  ['a percentage of the wrong type', { five_hour: { used_percentage: '17%' } }],
  ['a percentage out of range', { five_hour: { used_percentage: 101 } }],
  ['a reset in milliseconds', { five_hour: { used_percentage: 17, resets_at: CLOCK } }],
  ['a reset at the epoch', { five_hour: { used_percentage: 17, resets_at: 0 } }],
  ['a window that is not an object', { five_hour: 'soon' as any }],
] as Array<[string, any]>) {
  test(`a replayed gauge is drawn exactly as the live header would draw it — ${what}`, async () => {
    const page = mount(account(0, rateLimits));
    await page.advance(0);
    page.el('scrub').drag(0);
    const server = renderLimits({
      rows: [row({ rateLimits, snapshotAgeMs: 1000 })],
      health: health({ generatedAt: CLOCK }),
    });
    assert.equal(page.el('replay-limits').innerHTML, server);
  });
}
