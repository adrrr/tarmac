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

/** The journal, as `/api/history?range=` answers. A different shape entirely. */
const journal = (range: string): unknown => ({
  enabled: true,
  range,
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

const page = (historyEnabled = true): string => renderPage({ rows: [row()], health: health() }, 'history', { historyEnabled });

interface Mounted {
  p: Page;
  urls: string[];
  /** Hold the next answer back, so a test can look at the page mid-flight. */
  hold: (on: boolean) => void;
  release: () => void;
}

function mount(historyEnabled = true, body: (url: string) => unknown = (u) => (u === '/api/history' ? ring() : journal(u.slice(-2)))): Mounted {
  const html = page(historyEnabled);
  const urls: string[] = [];
  let held: (() => void) | null = null;
  let holding = false;
  const p = mountPage(
    historyScriptOf(html),
    async (_call, url) => {
      urls.push(url);
      if (holding) await new Promise<void>((r) => (held = r));
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
          hours: [0, 1, 2].map((i) => ({ t: T0 + i * HOUR, n: 60, sessions: [session()], rateLimits: { five_hour: 10, seven_day: 20 } })),
          days: [],
          // Dated at the last hour the range holds, which is the right-hand end of the axis.
          resets: [{ limit: 'seven_day', t: T0 + 2 * HOUR, from: 90, to: 2, sinceMs: MIN }],
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
