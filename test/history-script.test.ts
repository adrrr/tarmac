// The history view's script, executed.
//
// `history-view` next door tests the transforms, which is most of the thinking but none of the
// wiring. What is left is the part only a browser runs: a fetch per range, a cursor under a
// finger, a legend key that isolates, and the state machine holding those together. That was
// four hundred lines nothing executed, and the bug it hid was not subtle — clicking a range
// swapped the range before the data, so anything that redrew in between read the wrong shape
// and threw, taking the whole view down until the answer landed.
//
// It runs the string the browser is actually served, extracted from `renderPage`'s output, on
// the same eighty-line DOM the replay's script is executed on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../src/render.ts';
import { historyScriptOf, mountPage, shellState } from './page-dom.ts';
import type { Page } from './page-dom.ts';
import { health, row } from './fleet-fixtures.ts';

const MIN = 60_000;
const HOUR = 3_600_000;
const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h, 0, 0, 0).getTime();
const T0 = at(2026, 8, 29, 9);

const session = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  sid: 'a',
  project: 'alpha',
  kind: 'interactive',
  state: 'idle',
  waitingFor: null,
  ctxState: 'fresh',
  ctxPct: 40,
  costUsd: 1,
  ...o,
});

/** The ring, as `/api/history` answers with no range. */
const ring = (): unknown => ({
  since: T0,
  cadence: MIN,
  missed: 0,
  samples: [0, 1, 2, 3].map((i) => ({
    t: T0 + i * MIN,
    sessions: [session({ ctxPct: 40 + i * 5, costUsd: 1 + i })],
    rateLimits: { five_hour: { used_percentage: 30 + i }, seven_day: { used_percentage: 12 } },
  })),
});

/**
 * The window a seven-day range answers for, as the reader states it: seven local midnights, the
 * last of them the one that closes today. The charts are drawn over THIS and not over the days
 * that happen to be in the answer, so a fixture without it is a fixture nothing can be plotted
 * against.
 */
const WEEK = { from: at(2026, 8, 23, 0), to: at(2026, 8, 30, 0) };

/** The journal, as `/api/history?range=` answers. A different shape entirely. */
const journal = (range: string): unknown => ({
  enabled: true,
  range,
  ...WEEK,
  hours: [0, 1, 2].map((i) => ({
    t: T0 + i * HOUR,
    n: 60,
    sessions: [session({ ctxPct: 20 + i * 10 })],
    rateLimits: { five_hour: 40 + i, seven_day: 20 },
  })),
  days: [{ date: '2026-08-29', byProject: [{ project: 'alpha', costUsd: 4 }] }],
  resets: [{ limit: 'seven_day', t: T0 + HOUR, from: 90, to: 3, sinceMs: MIN }],
  coverage: { daysRequested: 7, lines: 180, skipped: 0, outOfRange: 0, droppedSessions: 0, capped: false },
});

const page = (historyEnabled = true, demo = false): string => renderPage({ rows: [row()], health: health() }, 'history', { historyEnabled, demo });

interface Mounted {
  p: Page;
  urls: string[];
  /** Hold the next answer back, so a test can look at the page mid-flight. */
  hold: (on: boolean) => void;
  release: () => void;
  /** Answer the next reads with a refusal, the way a serve that has gone away does. */
  fail: (on: boolean) => void;
}

function mount(
  historyEnabled = true,
  body: (url: string) => unknown = (u) => (u === '/api/history' ? ring() : journal(u.slice(-2))),
  demo = false,
): Mounted {
  const html = page(historyEnabled, demo);
  const urls: string[] = [];
  let held: (() => void) | null = null;
  let holding = false;
  let failing = false;
  const p = mountPage(
    historyScriptOf(html),
    async (_call, url) => {
      urls.push(url);
      if (holding) await new Promise<void>((r) => (held = r));
      if (failing) return { ok: false, body: 'boom' };
      return { ok: true, body: JSON.stringify(body(url)) };
    },
    { shell: shellState(html) },
  );
  return {
    p,
    urls,
    hold: (on: boolean): void => {
      holding = on;
    },
    release: (): void => {
      held?.();
      held = null;
    },
    fail: (on: boolean): void => {
      failing = on;
    },
  };
}

const settle = (m: Mounted): Promise<void> => m.p.advance(1);

// ── it draws at all ──────────────────────────────────────────────────────────────────────

test('the view asks for the ring on load, and draws the three charts out of it', async () => {
  const m = mount();
  await settle(m);
  assert.deepEqual(m.urls, ['/api/history'], 'the ring, and no file opened for it');
  assert.match(m.p.el('ctx-sub').textContent, /per session · 24h/);
  assert.match(m.p.el('cost-sub').textContent, /per project · hourly · 24h/);
  assert.match(m.p.el('quota-sub').textContent, /account · 24h/);
  assert.match(m.p.el('ctx-legend').innerHTML, /class="k-name">alpha</);
});

test('a range pill asks the journal for that range, and only for that one', async () => {
  const m = mount();
  await settle(m);
  m.p.el('range-7d').fire('click');
  await settle(m);
  assert.deepEqual(m.urls, ['/api/history', '/api/history?range=7d']);
  assert.equal(m.p.el('range-7d').getAttribute('aria-pressed'), 'true');
  assert.equal(m.p.el('range-24h').getAttribute('aria-pressed'), 'false');
  assert.match(m.p.el('hist-covers').textContent, /7d from the journal · 1 of 7 days on disk/);
});

test('a pill the journal cannot answer for is not asked at all', async () => {
  const m = mount(false);
  await settle(m);
  m.p.el('range-7d').fire('click');
  await settle(m);
  assert.deepEqual(m.urls, ['/api/history'], 'a disabled pill sends no request');
  assert.match(m.p.el('hist-covers').textContent, /need the journal, which is off/);
});

// ── the bug this file exists for ─────────────────────────────────────────────────────────
//
// The range and the data it was fetched for are two facts, and for the length of a request
// they disagree. A month of files is documented as taking a while to read, and anything that
// redraws in that window — a resize, the system going dark, a finger on a chart — used to
// reach the new range's branch with the old range's payload and throw.

test('a redraw between asking for a range and being answered does not take the view down', async () => {
  const m = mount();
  await settle(m);
  m.hold(true);
  m.p.el('range-30d').fire('click');
  await settle(m);
  // Mid-flight: the pill is pressed, the answer is not in. A tap on every chart, which is what
  // a reader scrolling to look at them does.
  for (const id of ['ctx', 'cost', 'quota']) {
    m.p.el(id + '-canvas').fire('pointerdown', { clientX: 100 });
  }
  await settle(m);
  m.hold(false);
  m.release();
  await settle(m);
  assert.deepEqual(m.urls, ['/api/history', '/api/history?range=30d']);
  assert.match(m.p.el('hist-covers').textContent, /30d from the journal/, 'and the answer still lands');
  // The cursor those taps left is kept, because the reader put it there. Cleared, the chart
  // goes back to naming the range it is now holding.
  m.p.el('ctx-now').fire('click');
  await settle(m);
  assert.match(m.p.el('ctx-sub').textContent, /hour max · 30d/);
});

test('while a range is in flight the view claims nothing about what it holds', async () => {
  const m = mount();
  await settle(m);
  m.hold(true);
  m.p.el('range-7d').fire('click');
  await settle(m);
  // Said at once, not when the answer lands: the line under the pills is the only prose on the
  // view, and left holding the previous range's sentence it states a provenance for data the
  // page no longer has.
  assert.match(m.p.el('hist-covers').textContent, /reading 7d/);
  // And not "no readings in this range", which is a verdict on a range nobody has read yet.
  assert.equal(/no readings in this range/.test(m.p.el('cost-stat').textContent), false);
  m.hold(false);
  m.release();
  await settle(m);
});

// ── the reader's hand ────────────────────────────────────────────────────────────────────

test('a tap puts a cursor on one chart, and the way back to now appears with it', async () => {
  const m = mount();
  await settle(m);
  assert.equal(m.p.el('ctx-now').hidden, true, 'nothing to go back from yet');
  m.p.el('ctx-canvas').fire('pointerdown', { clientX: 200 });
  await settle(m);
  assert.equal(m.p.el('ctx-now').hidden, false);
  // One chart at a time: the cost chart was not tapped and says nothing about a moment.
  assert.equal(m.p.el('cost-now').hidden, true);
  m.p.el('ctx-now').fire('click');
  await settle(m);
  assert.equal(m.p.el('ctx-now').hidden, true);
  assert.match(m.p.el('ctx-sub').textContent, /per session · 24h/);
});

test('a tap on a legend key isolates its series, and a second tap lets the fleet back', async () => {
  const m = mount();
  await settle(m);
  const legend = m.p.el('ctx-legend');
  assert.match(legend.innerHTML, /data-key="alpha" aria-pressed="false"/);
  const key = { getAttribute: (n: string): string | null => (n === 'data-key' ? 'alpha' : null), parentNode: null };
  legend.fire('click', { target: key });
  await settle(m);
  assert.match(legend.innerHTML, /data-key="alpha" aria-pressed="true"/);
  assert.equal(legend.classes.has('muted'), true, 'and the rest of the fleet is dimmed');
  legend.fire('click', { target: key });
  await settle(m);
  assert.match(legend.innerHTML, /data-key="alpha" aria-pressed="false"/);
  assert.equal(legend.classes.has('muted'), false);
});

// ── what comes back off the wire ─────────────────────────────────────────────────────────

test('an answer that did not come from tarmac is not drawn', async () => {
  const html = page();
  const p = mountPage(historyScriptOf(html), async () => ({ ok: true, body: JSON.stringify(ring()), headers: {} }), {
    shell: shellState(html),
  });
  await p.advance(1);
  assert.match(p.el('hist-covers').textContent, /did not come from tarmac/);
});

test('a journal that is off is said in words, not drawn as an empty week', async () => {
  const m = mount(true, (url) => (url === '/api/history' ? ring() : { enabled: false, range: '7d' }));
  await settle(m);
  m.p.el('range-7d').fire('click');
  await settle(m);
  assert.match(m.p.el('hist-covers').textContent, /history is off/);
});

test('a refusal is quoted rather than swallowed, and the charts stop claiming a fleet', async () => {
  const html = page();
  const p = mountPage(historyScriptOf(html), async () => ({ ok: false, body: 'tarmac could not read the fleet journal\n' }), {
    shell: shellState(html),
  });
  await p.advance(1);
  assert.match(p.el('hist-covers').textContent, /could not read the fleet journal/);
});

// ── what the ink actually says ───────────────────────────────────────────────────────────
//
// No assertion can read a pixel, but every number a chart draws goes through `fillText`, and
// every bar through `fillRect`. That is enough to pin the three things about this drawing that
// are claims rather than decoration.

/** The 2d context a chart drew on, with its calls. */
const ctx = (p: Page, id: string): { names: string[]; argsOf(name: string): unknown[][] } =>
  p.el(id + '-canvas').getContext('2d') as never;
const words = (p: Page, id: string): string[] => ctx(p, id).argsOf('fillText').map((a) => String(a[0]));

// The account's gauges floor (`readLimits`), so the chart floors. 87.9 printed as 88 beside a
// header saying 87 is one page disagreeing with itself about one minute.
test('the quota chart floors its percentages, the way the header gauges do', async () => {
  const m = mount(true, () => ({
    since: T0,
    cadence: MIN,
    missed: 0,
    samples: [{ t: T0, sessions: [session()], rateLimits: { five_hour: { used_percentage: 87.9 }, seven_day: { used_percentage: 3.9 } } }],
  }));
  await settle(m);
  assert.equal(m.p.el('quota-stat').textContent, '5h 87% · 7d 3%');
  assert.equal(/88%/.test(m.p.el('quota-stat').textContent), false);
});

// A window's bar is its own high. The reading a reset is dated by is the first minute the NEW
// window was true of, so counting it in both drew the window that ended again as the bar of the
// window that started: an account shown near its ceiling for hours it spent nowhere near it.
test('a window the account barely touched is not drawn at the height of the one before it', async () => {
  // The hour the window turns over in records the OLD window's high, because the figure kept
  // for an hour is its maximum and the fall happened inside it.
  // The window climbs late, so its high lives in the very hour it turns over in and nowhere
  // else. That is what makes the two mistakes tell apart: claiming the hour for the new window
  // draws the second bar at 95, and taking it off the old one draws the first at 12.
  const hours = [10, 12, 95, 4, 6].map((five, i) => ({
    t: T0 + i * HOUR,
    n: 60,
    sessions: [session()],
    rateLimits: { five_hour: five, seven_day: 20 },
  }));
  const m = mount(true, (url) =>
    url === '/api/history'
      ? ring()
      : {
          enabled: true,
          range: '7d',
          ...WEEK,
          hours,
          days: [],
          // Dated inside the third hour, whose recorded high is 95 and whose last fifty minutes
          // belong to the window that has just started.
          resets: [{ limit: 'five_hour', t: T0 + 2 * HOUR, from: 95, to: 4, sinceMs: MIN }],
          coverage: { daysRequested: 7, lines: 240, skipped: 0, outOfRange: 0, droppedSessions: 0, capped: false },
        },
  );
  await settle(m);
  m.p.el('range-7d').fire('click');
  await settle(m);
  // Two bars, one per window. A taller bar has a smaller y: the first peaked at 95 and the
  // second at 6, so the second's top sits far BELOW the first's. Counted in both windows, the
  // 95 of the turnover hour becomes the second bar too and the pair comes out level.
  const bars = ctx(m.p, 'quota').argsOf('fillRect');
  assert.equal(bars.length, 2, `two windows, ${bars.length} bars`);
  const [first, second] = bars.map((a) => ({ y: Number(a[1]), h: Number(a[3]) }));
  assert.ok(second.y > first.y + 20, `the second window's top is at ${second.y}, the first at ${first.y}`);
  // 95 against 6 is a ratio of nearly sixteen. Trimmed off the window that ended as well, the
  // first bar would be its 12 and the ratio would be two.
  assert.ok(first.h > second.h * 8, `the first window is drawn ${(first.h / second.h).toFixed(1)}x the second, not ~16x`);
});

// The stroked line lifts its pen at a minute nobody read. The shaded area under it used to walk
// straight across, so the fill claimed coverage the line was correctly showing a hole in.
test('the shaded area under the quota line breaks where the line breaks', async () => {
  const gap = (five: number | null): unknown => (five === null ? null : { five_hour: { used_percentage: five }, seven_day: { used_percentage: 10 } });
  const m = mount(true, () => ({
    since: T0,
    cadence: MIN,
    missed: 1,
    samples: [30, 40, null, 50, 60].map((v, i) => ({ t: T0 + i * MIN, sessions: [session()], rateLimits: gap(v) })),
  }));
  await settle(m);
  // Two runs of readings, so two closed shapes. One closePath would be one shape bridging the
  // hole; the count is what tells them apart.
  const closes = ctx(m.p, 'quota').names.filter((n) => n === 'closePath').length;
  assert.ok(closes >= 2, `the area was closed ${closes} time(s), so it bridged the gap`);
});

// An hour nobody read is not an hour that cost nothing, and the bars already draw it as the gap
// it is. Under a tap it has to say so in words too, or the one place the number is spelled out
// is the one place it reads as a measurement.
test('tapping an hour with no readings says so, rather than pricing it at zero', async () => {
  const m = mount(true, () => ({
    since: T0,
    cadence: MIN,
    missed: 60,
    // Two readings an hour apart, and nothing at all in the hour between them.
    samples: [0, 2].map((i) => ({ t: T0 + i * HOUR, sessions: [session({ costUsd: 1 + i })], rateLimits: null })),
  }));
  await settle(m);
  // The middle of three columns is the empty hour.
  m.p.el('cost-canvas').fire('pointerdown', { clientX: 180 });
  await settle(m);
  assert.equal(m.p.el('cost-stat').textContent, 'no reading');
  assert.match(m.p.el('cost-legend').innerHTML, /class="k-val">—</);
  assert.equal(/\$0\.00/.test(m.p.el('cost-legend').innerHTML), false, 'nobody read it, so it did not cost nothing');
});

// The stack is built in the palette's order so a slab keeps its place in the column all week.
// `history-view` pins that in the numbers `costDaily` hands over, which is a different claim
// from the one made in paint: stacked in each day's own ranking instead, the data is identical
// and the picture is not. The project on the floor changes from column to column, and following
// one colour sideways is the whole reason the chart is stacked rather than grouped.
test('the same project floors every column, whatever each day’s own ranking was', async () => {
  const day = (date: string, alpha: number, zulu: number): unknown => ({
    date,
    byProject: [{ project: 'alpha', costUsd: alpha }, { project: 'zulu', costUsd: zulu }],
  });
  const m = mount(true, (url) =>
    url === '/api/history'
      ? ring()
      : {
          enabled: true,
          range: '7d',
          ...WEEK,
          hours: [],
          // Opposite rankings, same pair and same total: alpha owns Thursday, zulu owns Friday.
          days: [day('2026-08-27', 30, 5), day('2026-08-28', 5, 30)],
          resets: [],
          coverage: { daysRequested: 7, lines: 240, skipped: 0, outOfRange: 0, droppedSessions: 0, capped: false },
        },
  );
  await settle(m);
  m.p.el('range-7d').fire('click');
  await settle(m);
  // Only the slab under the cap is drawn as a rectangle — the top one is a rounded path — so
  // one rectangle a column, and where it sits is which project was laid down first. Both feet
  // on the axis is alpha on the floor twice; the heights are then alpha's own two days, thirty
  // against five, and not the taller of whichever pair the day happened to hold.
  const slabs = ctx(m.p, 'cost')
    .argsOf('fillRect')
    .map((a) => ({ x: Number(a[0]), foot: Number(a[1]) + Number(a[3]), h: Number(a[3]) }))
    .sort((a, b) => a.x - b.x);
  assert.equal(slabs.length, 2, `two columns, ${slabs.length} rectangle(s)`);
  assert.equal(Math.round(slabs[0].foot), Math.round(slabs[1].foot), `floored at ${slabs[0].foot} and ${slabs[1].foot}`);
  assert.ok(slabs[0].h > slabs[1].h * 4, `alpha's two days came out ${(slabs[0].h / slabs[1].h).toFixed(1)}x apart, not 6x`);
});

// ── the domain of a long range (#168) ────────────────────────────────────────────────────
//
// A serve whose journal is younger than the range being asked of it drew ONE column, alone in
// the middle of an empty plot — and the identical picture at 7d and at 30d, one day being one
// column either way. The axis is the window the reader answered for now: every day of it has a
// slot, a day nobody wrote in draws nothing in its own place, and the empty stretch in front of
// the record says once, quietly, where the record begins.

/** Every day name the cost axis printed. */
const dayNames = (p: Page): string[] =>
  ctx(p, 'cost')
    .argsOf('fillText')
    .map((a) => String(a[0]))
    .filter((t) => /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}$/.test(t));

/** The one day of journal a serve started yesterday has, in a range that asked for more. */
const thin = (range: string, window: { from: number; to: number }): unknown => ({
  enabled: true,
  range,
  ...window,
  hours: [{ t: T0, n: 60, sessions: [session()], rateLimits: { five_hour: 30, seven_day: 20 } }],
  // Seven, so the total printed over the column cannot be confused with the 24h chart's own —
  // the canvas here records every call made to it, the first range included.
  days: [{ date: '2026-08-29', byProject: [{ project: 'alpha', costUsd: 7 }] }],
  resets: [],
  coverage: { daysRequested: range === '7d' ? 7 : 30, lines: 60, skipped: 0, outOfRange: 0, droppedSessions: 0, capped: false },
});

test('a week with one day of journal in it is drawn a week wide', async () => {
  const m = mount(true, (url) => (url === '/api/history' ? ring() : thin('7d', WEEK)));
  await settle(m);
  m.p.el('range-7d').fire('click');
  await settle(m);

  assert.deepEqual(dayNames(m.p), ['Sun 23', 'Mon 24', 'Tue 25', 'Wed 26', 'Thu 27', 'Fri 28', 'Sat 29']);
  // The one day that exists is charged to its own slot and nowhere else: seven columns, one
  // total printed over them.
  const money = ctx(m.p, 'cost').argsOf('fillText').map((a) => String(a[0])).filter((t) => t === '$7.0');
  assert.deepEqual(money, ['$7.0'], `the week printed ${JSON.stringify(money)} over its columns`);
});

test('a month asked of the same day is a month wide, and not the week again', async () => {
  const window = { from: at(2026, 7, 31, 0), to: at(2026, 8, 30, 0) };
  const m = mount(true, (url) => (url === '/api/history' ? ring() : thin('30d', window)));
  await settle(m);
  m.p.el('range-30d').fire('click');
  await settle(m);

  // Every fifth date of the month, which is what the 30d axis names. Drawn over the week's
  // domain there was one of them, sitting two thirds of the way along an otherwise blank axis.
  const dates = ctx(m.p, 'cost')
    .argsOf('fillText')
    .map((a) => String(a[0]))
    .filter((t) => /^(Jul|Aug) \d{1,2}$/.test(t));
  assert.deepEqual(dates, ['Aug 5', 'Aug 10', 'Aug 15', 'Aug 20', 'Aug 25']);
  assert.deepEqual(dayNames(m.p), [], 'a month names dates, not days of the week');
  // And no per-column total at a month, where thirty of them are noise over bars a few pixels
  // wide. The tap already answers that question, one column at a time.
  assert.equal(
    ctx(m.p, 'cost').argsOf('fillText').some((a) => String(a[0]) === '$7.0'),
    false,
    'a month printed a total over its columns',
  );
});

test('the stretch in front of a young journal says where the record begins, once a chart', async () => {
  const window = { from: at(2026, 7, 31, 0), to: at(2026, 8, 30, 0) };
  const m = mount(true, (url) => (url === '/api/history' ? ring() : thin('30d', window)));
  await settle(m);
  m.p.el('range-30d').fire('click');
  await settle(m);

  for (const id of ['ctx', 'cost', 'quota']) {
    const said = ctx(m.p, id).argsOf('fillText').map((a) => String(a[0])).filter((t) => t.startsWith('no readings before'));
    assert.deepEqual(said, ['no readings before Aug 29'], `the ${id} chart said ${JSON.stringify(said)}`);
  }
});

// A range whose journal covers all of it has nothing to explain, and a sentence about a record
// that starts where the range does would be a caption on a full chart.
test('a range the journal covers says nothing about where it starts', async () => {
  const full = (): unknown => ({
    ...(thin('7d', WEEK) as Record<string, unknown>),
    days: [
      { date: '2026-08-23', byProject: [{ project: 'alpha', costUsd: 2 }] },
      { date: '2026-08-29', byProject: [{ project: 'alpha', costUsd: 3 }] },
    ],
  });
  const m = mount(true, (url) => (url === '/api/history' ? ring() : full()));
  await settle(m);
  m.p.el('range-7d').fire('click');
  await settle(m);

  const said = ctx(m.p, 'cost').argsOf('fillText').map((a) => String(a[0])).filter((t) => t.startsWith('no readings before'));
  assert.deepEqual(said, []);
});

// ── the far end of a range nobody read to (#169 review) ─────────────────────────────────
//
// The grid runs to the close of the window now, and the record inside it stops where the serve
// stopped. Everything drawn between those two is a claim about hours nobody measured — which is
// the one thing this view says, in its own comments, that it must never draw.

/** The plot a 360px canvas gives. See `plotBox`. */
const PL = 8;
const PR = 352;

/**
 * The calls of the LAST frame drawn on a canvas, which is the range under test: the stub records
 * every call it was ever given, and the first frame is always the 24h one the view loads with.
 * `setup` re-bases the context at the top of each frame, so that call is the frame boundary.
 */
const frame = (p: Page, id: string): Array<{ name: string; args: unknown[] }> => {
  const calls = (ctx(p, id) as never as { calls: Array<{ name: string; args: unknown[] }> }).calls;
  return calls.slice(calls.map((c) => c.name).lastIndexOf('setTransform'));
};

const drew = (p: Page, id: string, name: string): unknown[][] =>
  frame(p, id).filter((c) => c.name === name).map((c) => c.args);

/** Where the hour at `idx` of a window `hours` long starts, in plot pixels. */
const xOfHour = (idx: number, hours: number): number => PL + (idx / hours) * (PR - PL);

/** A week of range with three hours of journal in the middle of its last day. */
const stub = (): unknown => ({
  enabled: true,
  range: '7d',
  ...WEEK,
  hours: [0, 1, 2].map((i) => ({ t: T0 + i * HOUR, n: 60, sessions: [session()], rateLimits: { five_hour: 40 + i, seven_day: 20 + i } })),
  days: [{ date: '2026-08-29', byProject: [{ project: 'alpha', costUsd: 7 }] }],
  resets: [],
  coverage: { daysRequested: 7, lines: 180, skipped: 0, outOfRange: 0, droppedSessions: 0, capped: false },
});

/** T0 is 09:00 on the last day of a week that opened seven midnights earlier. */
const LAST_READ = 6 * 24 + 11;
const WEEK_HOURS = 7 * 24;

test('the quota line ends on its last reading, not against the right edge of the range', async () => {
  const m = mount(true, (url) => (url === '/api/history' ? ring() : stub()));
  await settle(m);
  m.p.el('range-7d').fire('click');
  await settle(m);

  // Every dot the chart drops is a reading. Thirteen hours past the last one, against the edge
  // of a window the serve was not up for, it is a reading nobody took.
  const want = xOfHour(LAST_READ, WEEK_HOURS);
  const dots = drew(m.p, 'quota', 'arc').map((a) => Number(a[0]));
  assert.ok(dots.length > 0, 'the chart dropped no end dot at all');
  assert.ok(
    Math.max(...dots) <= want + 0.5,
    `a dot at x=${Math.max(...dots).toFixed(1)} on a curve that ends at x=${want.toFixed(1)}`,
  );
});

test('the five-hour skyline stops at the last hour measured, not at the close of the range', async () => {
  const m = mount(true, (url) => (url === '/api/history' ? ring() : stub()));
  await settle(m);
  m.p.el('range-7d').fire('click');
  await settle(m);

  // One window, so one bar: it opens with the range and closes with the record. Run to `t1` it
  // paints thirteen unmeasured hours at the height of a peak reached at eleven in the morning.
  const bars = drew(m.p, 'quota', 'fillRect').map((a) => ({ x: Number(a[0]), w: Number(a[2]) }));
  assert.equal(bars.length, 1, `one window, ${bars.length} bars`);
  const want = xOfHour(LAST_READ + 1, WEEK_HOURS);
  assert.ok(
    bars[0].x + bars[0].w <= want + 1,
    `the bar runs to x=${(bars[0].x + bars[0].w).toFixed(1)} on a record that ends at x=${want.toFixed(1)}`,
  );
});

// An axis may not promise a span the chart does not draw. The grid is capped, `d.to` is not, and
// the two long charts handed the raw one straight to the tick walk: a window off the wire came
// back as tens of thousands of labels and hundreds of thousands of canvas calls a frame, which
// is the tab that stops answering rather than the error somebody can read.
test('a window the grid could not honour is not drawn on the axis either', async () => {
  const far = { from: at(2026, 8, 1, 0), to: at(2026, 8, 1, 0) + 3650 * 86_400_000 };
  const m = mount(true, (url) =>
    url === '/api/history'
      ? ring()
      : { ...(stub() as Record<string, unknown>), range: '30d', ...far, coverage: { daysRequested: 30, lines: 180, skipped: 0, outOfRange: 0, droppedSessions: 0, capped: false } },
  );
  await settle(m);
  m.p.el('range-30d').fire('click');
  await settle(m);

  // The cost axis is built from its own buckets, which are capped in days, so it is the one that
  // was already honest. The other two are drawn over the same window and must name the same
  // dates: handed the raw far end they named ten years of them over a grid of five.
  const named = (id: string): string[] =>
    drew(m.p, id, 'fillText').map((a) => String(a[0])).filter((w) => /^[A-Z][a-z]{2} \d{1,2}$/.test(w));
  assert.ok(named('cost').length > 0, 'the cost axis named nothing at all');
  assert.deepEqual(named('ctx'), named('cost'), 'the bands and the bars disagree about the axis under them');
  assert.deepEqual(named('quota'), named('cost'), 'the quota curve and the bars disagree about the axis under them');
});

// And the walk itself has a ceiling, wherever its ends come from: the cost chart's axis is built
// from its own buckets, which are capped in days, and 1800 day names is still an axis nobody can
// read drawn at three hundred thousand canvas calls a frame.
test('the tick walk has a ceiling of its own', async () => {
  const far = { from: at(2026, 8, 1, 0), to: at(2026, 8, 1, 0) + 3650 * 86_400_000 };
  const m = mount(true, (url) =>
    url === '/api/history'
      ? ring()
      : { ...(stub() as Record<string, unknown>), ...far },
  );
  await settle(m);
  m.p.el('range-7d').fire('click');
  await settle(m);

  const named = drew(m.p, 'cost', 'fillText').map((a) => String(a[0])).filter((w) => /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}$/.test(w));
  assert.ok(named.length > 0 && named.length <= 400, `the cost axis named ${named.length} days`);
});

// The note explains the space in front of the record, so it is drawn over that space and not
// under the bands that cross it: called before them, every row's own baseline is ruled straight
// through the sentence.
test('the note about the record is drawn over the bands, not under them', async () => {
  const m = mount(true, (url) => (url === '/api/history' ? ring() : stub()));
  await settle(m);
  m.p.el('range-7d').fire('click');
  await settle(m);

  const calls = (ctx(m.p, 'ctx') as never as { calls: Array<{ name: string; args: unknown[] }> }).calls;
  const note = calls.findIndex((c) => c.name === 'fillText' && String(c.args[0]).startsWith('no readings before'));
  const lastStroke = calls.map((c) => c.name).lastIndexOf('stroke');
  assert.ok(note > -1, 'the note was not drawn at all');
  assert.ok(note > lastStroke, `the note is call ${note}, the last band was stroked at ${lastStroke}`);
});

// The marker names itself three pixels to the right of its own line, which is off the plot when
// the line is against the right edge — and a window that turned over in the last hour of a range
// is exactly where a reader looks first. Clipped, `7d reset` renders as `7`.
test('a turnover against the right edge keeps its whole name on the chart', async () => {
  const m = mount(true, (url) =>
    url === '/api/history'
      ? ring()
      : {
          enabled: true,
          range: '7d',
          ...WEEK,
          hours: [0, 1, 2].map((i) => ({ t: T0 + i * HOUR, n: 60, sessions: [session()], rateLimits: { five_hour: 10, seven_day: 20 } })),
          days: [],
          // Dated at the last minute the range holds, which is the right-hand end of the axis.
          resets: [{ limit: 'seven_day', t: WEEK.to - MIN, from: 90, to: 2, sinceMs: MIN }],
          coverage: { daysRequested: 7, lines: 180, skipped: 0, outOfRange: 0, droppedSessions: 0, capped: false },
        },
  );
  await settle(m);
  m.p.el('range-7d').fire('click');
  await settle(m);
  // A 360px canvas plots between 8 and 352, and the name is about forty pixels of nine-point
  // sans. Anchored at the hair itself it would start at 355, three pixels past the edge.
  const anchor = Number(ctx(m.p, 'quota').argsOf('fillText').find((a) => String(a[0]).startsWith('7d reset'))?.[1]);
  assert.ok(anchor <= 312, `the name starts at ${anchor} on a plot that ends at 352`);
});

// `path.basename('/')` is the empty string, which `history-range` already notes it has to live
// with. A key that is falsy isolates nothing while its own button reports itself pressed.
test('a project with no name for a basename can still be isolated', async () => {
  const m = mount(true, () => ({
    since: T0,
    cadence: MIN,
    missed: 0,
    samples: [0, 1].map((i) => ({ t: T0 + i * MIN, sessions: [session({ project: '' })], rateLimits: null })),
  }));
  await settle(m);
  const legend = m.p.el('ctx-legend');
  assert.match(legend.innerHTML, /data-key="" aria-pressed="false"/);
  legend.fire('click', { target: { getAttribute: (n: string): string | null => (n === 'data-key' ? '' : null), parentNode: null } });
  await settle(m);
  assert.match(legend.innerHTML, /data-key="" aria-pressed="true"/);
  assert.equal(legend.classes.has('muted'), true, 'and the isolation actually took');
});

// The name is dropped at a month, where four turnovers say it four times over. The tilde is not:
// a marker the serve did not watch happen sits where the record resumed, and that qualifier is
// exactly what a month of them must not lose.
test('a turnover nobody watched keeps its qualifier even where the label is dropped', async () => {
  const m = mount(true, (url) =>
    url === '/api/history'
      ? ring()
      : {
          enabled: true,
          range: '30d',
          from: at(2026, 7, 31, 0),
          to: at(2026, 8, 30, 0),
          hours: [0, 1, 2].map((i) => ({ t: T0 + i * HOUR, n: 60, sessions: [session()], rateLimits: { five_hour: 10, seven_day: 20 } })),
          days: [],
          resets: [{ limit: 'seven_day', t: T0 + HOUR, from: 90, to: 2, sinceMs: 9 * HOUR }],
          coverage: { daysRequested: 30, lines: 180, skipped: 0, outOfRange: 0, droppedSessions: 0, capped: false },
        },
  );
  await settle(m);
  m.p.el('range-30d').fire('click');
  await settle(m);
  const drawn = words(m.p, 'quota');
  assert.ok(drawn.includes('≈'), `no qualifier among ${JSON.stringify(drawn)}`);
  assert.equal(drawn.includes('7d reset'), false, 'and the name is still dropped at a month');
});

// ── the first run, where there is nothing to draw yet (#151) ─────────────────────────────
//
// A serve that started a minute ago answers a record with nothing in it, and the three charts
// each paint "no readings in this range" onto a canvas — a verdict, in ink nobody can select,
// search or hear read out, about a page that has done nothing wrong. What the reader needs
// there is what is coming and when, and a way to see the thing full without waiting a day.

/** The ring as a serve that has just started answers it: a span, and nothing in it. */
const emptyRing = (): unknown => ({ since: T0, cadence: MIN, missed: 0, samples: [] });

// The words are held next door, against the markup: this DOM models an element whose content
// is text and nothing else, and the block's is a sentence with <strong> and <code> in it.
// What is this file's to prove is that the thing is raised at all, and on what.
test('a record with nothing in it yet raises the first-run block', async () => {
  const m = mount(true, () => emptyRing());
  await settle(m);
  assert.equal(m.p.el('hist-empty').hidden, false, 'a first run is told nothing about the empty charts it is looking at');
});

// The shape the first cut of this got wrong, and the reason the predicate asks the charts
// rather than the sample count. `serve` before the statusline is chained, or with no session
// open, records a sample a minute with nothing in it. The ring is not empty after sixty
// seconds, so a sample-count test lowers the block, while every chart still paints "no
// readings in this range" onto its canvas. The page is then LESS explanatory than it was at
// t=0, on exactly the fresh install #151 was written for.
const recordingNothing = (): unknown => ({
  since: T0,
  cadence: MIN,
  missed: 0,
  samples: [0, 1, 2].map((i) => ({ t: T0 + i * MIN, sessions: [], rateLimits: null })),
});

test('a ring recording empty fleets is still a first run, however many samples it has taken', async () => {
  const m = mount(true, () => recordingNothing());
  await settle(m);
  assert.equal(m.p.el('hist-empty').hidden, false, 'three samples of nothing lowered the block over three empty charts');
});

// The other shape: `serve` running before `install`, so the fleet has a session but no
// statusline has ever written for it. Every field the three charts plot is null, and the ring
// fills up with samples that carry nothing.
const recordingNoTelemetry = (): unknown => ({
  since: T0,
  cadence: MIN,
  missed: 0,
  samples: [0, 1, 2].map((i) => ({
    t: T0 + i * MIN,
    sessions: [session({ ctxState: 'absent', ctxPct: null, costUsd: null })],
    rateLimits: null,
  })),
});

test('a ring of sessions nothing has measured yet is still a first run', async () => {
  const m = mount(true, () => recordingNoTelemetry());
  await settle(m);
  assert.equal(m.p.el('hist-empty').hidden, false, 'a chained-less fleet lowered the block over three empty charts');
});

// And the converse, so none of this passes by refusing to ever lower the block: one window
// reading, with no session telemetry at all, is a quota chart worth drawing.
test('a single account reading is something to draw', async () => {
  const m = mount(true, () => ({
    since: T0,
    cadence: MIN,
    missed: 0,
    samples: [{ t: T0, sessions: [], rateLimits: { five_hour: { used_percentage: 12 }, seven_day: { used_percentage: 4 } } }],
  }));
  await settle(m);
  assert.equal(m.p.el('hist-empty').hidden, true);
});

test('a record with readings in it keeps the first-run block down', async () => {
  const m = mount();
  await settle(m);
  assert.equal(m.p.el('hist-empty').hidden, true, 'the block is up over charts that have something in them');
});

// "Nothing has been recorded yet" is a verdict, and a range still being read has not earned
// one — the same rule `blank` already applies to the canvas it paints.
test('a record still being read is not yet a first run', async () => {
  const m = mount(true, (url) => (url === '/api/history' ? emptyRing() : journal(url.slice(-2))));
  await settle(m);
  assert.equal(m.p.el('hist-empty').hidden, false, 'an empty ring does not raise the block at all');
  m.p.el('range-7d').fire('click');
  await settle(m);
  assert.equal(m.p.el('hist-empty').hidden, true, 'a journal range is not a first run');
  // Back to 24h. `setRange` drops the record and redraws in the same statement, before the next
  // answer is anywhere near: nothing has been read at that moment, and a block raised there
  // would be a verdict reached on no evidence. The click is synchronous, so this reads it.
  m.p.el('range-24h').fire('click');
  assert.equal(m.p.el('hist-empty').hidden, true, 'the block appeared while the record was still in flight');
  await settle(m);
  assert.equal(m.p.el('hist-empty').hidden, false, 'and it is back once the empty record has landed');
});

// A serve that has gone away answers nothing, and the view has no record at all. That is the
// same "no data" the block is raised on, and the block is exactly the wrong thing to say about
// it: "leave the serve running and come back" about a serve that is not running. The reason
// belongs on the canvas and under the pills, where a failed read already puts it.
test('a record that could not be read is not a first run', async () => {
  const m = mount(true);
  await settle(m);
  m.p.el('range-7d').fire('click');
  await settle(m);
  m.fail(true);
  m.p.el('range-24h').fire('click');
  await settle(m);
  assert.match(m.p.el('hist-covers').textContent, /boom/, 'precondition: the read failed and the view says so');
  assert.equal(m.p.el('hist-empty').hidden, true, 'the page told a reader to wait for a serve that had stopped answering');
});

// The block answers one question — "the serve just started, where are my charts" — and its
// answer is to wait a minute. That is not the answer to a month with nothing in it, which is a
// journal that was not running, and `blank` says so on the canvas as it always did.
test('an empty journal range is not a first run, and is not offered a minute of patience', async () => {
  const m = mount(true, (url) =>
    url === '/api/history'
      ? ring()
      : {
          enabled: true,
          range: '30d',
          from: at(2026, 7, 31, 0),
          to: at(2026, 8, 30, 0),
          hours: [],
          days: [],
          resets: [],
          coverage: { daysRequested: 30, lines: 0, skipped: 0, outOfRange: 0, droppedSessions: 0, capped: false },
        },
  );
  await settle(m);
  m.p.el('range-30d').fire('click');
  await settle(m);
  assert.equal(m.p.el('hist-empty').hidden, true);
});

// The first default run is BOTH of the states above at once: no `history.days`, so the server
// shipped "History is off." in the markup, and a ring a minute old, so the predicate above would
// raise "Nothing to draw yet." over it. Two boxes, one screen, saying two things where one is
// true and actionable — which is the screen #151 was written to fix (#157).
//
// "History is off." wins: it names a cause and what to do about it, and it is the server's own
// answer about the config. The other block is for the serve whose journal is on and young.
//
// One record, mounted twice, asserted opposite ways. A test that only pinned the block DOWN on
// the journal-off page would pass over a script that had stopped raising it anywhere — the
// markup ships it hidden, so the assertion would be reading the shell's own starting value back
// — and it would pass over a payload that had quietly stopped being empty. The half that says
// `false` is what makes the other half mean anything: the same record, with a journal, still
// raises it.
test('a first run raises one box, and which one is the journal’s answer', async () => {
  const off = mount(false, () => emptyRing());
  await settle(off);
  assert.equal(off.p.el('range-7d').disabled, true, 'precondition: this is a serve with no journal');
  assert.equal(off.p.el('hist-empty').hidden, true, 'the page said "history is off" and "wait a minute" at once');

  const on = mount(true, () => emptyRing());
  await settle(on);
  assert.equal(on.p.el('range-7d').disabled, false, 'precondition: this serve keeps a journal');
  assert.equal(on.p.el('hist-empty').hidden, false, 'the block is down over a young journal, where it is the true answer');
});

// The counted half of the sentence under the pills. "7 of 7 days on disk" is not a description
// of the product, it is a measurement of THIS serve — and a demo has no disk to have measured
// (#156). Read off the element the server already writes that sentence on, so the script keeps
// asking the server rather than deciding for itself.
test('a demo counts the days it invented, and a real serve counts the days on disk', async () => {
  const demo = mount(true, undefined, true);
  await settle(demo);
  demo.p.el('range-7d').fire('click');
  await settle(demo);
  assert.match(demo.p.el('hist-covers').textContent, /7d from the journal · 1 of 7 days invented/);

  const real = mount();
  await settle(real);
  real.p.el('range-7d').fire('click');
  await settle(real);
  assert.match(real.p.el('hist-covers').textContent, /7d from the journal · 1 of 7 days on disk/);
});
