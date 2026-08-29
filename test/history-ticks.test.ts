// The day axis, on the two mornings a year a local day is not twenty-four hours long.
//
// `history-range` states the rule for the files it reads: calendar arithmetic, never 24-hour
// blocks. The ticks under the 7d and 30d charts walked the other way, `+ 86400000` from a local
// midnight, and Europe/Paris gains an hour on 25 October 2026. Seven columns got eight ticks,
// `Sun 25` was printed twice, and every column after it carried the name of the day before. The
// March morning drifts the other way: each name an hour into its neighbour's column.
//
// The clock is pinned here rather than read off the machine. This suite is run at UTC and at
// Pacific/Kiritimati, neither of which observes DST, so a chart that cannot draw a week with a
// shift in it would go green in both. `replay-script` pins its own for the same reason.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../src/render.ts';
import { historyScriptOf, mountPage, shellState } from './page-dom.ts';
import type { Page } from './page-dom.ts';
import { health, row } from './fleet-fixtures.ts';

process.env.TZ = 'Europe/Paris';

const DAY = 86_400_000;
/** The plot a 360px canvas gives, which is what a tick's x is read against. See `plotBox`. */
const L = 8;
const R = 352;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local midnight of a `YYYY-MM-DD`, the way `dayStart` reads the journal's own file names. */
const midnight = (date: string): number => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
};

const word = (t: number): string => {
  const d = new Date(t);
  return DOW[d.getDay()] + ' ' + d.getDate();
};

/** The view, holding one stretch of the journal: a day a column, one project in each. */
async function span(days: string[], range: '7d' | '30d' = '7d'): Promise<Page> {
  const html = renderPage({ rows: [row()], health: health() }, 'history', { historyEnabled: true });
  const p = mountPage(
    historyScriptOf(html),
    async (_call, url) => ({
      ok: true,
      body: JSON.stringify(
        url === '/api/history'
          ? { since: midnight(days[0]), cadence: 60_000, missed: 0, samples: [] }
          : {
              enabled: true,
              range: range,
              hours: [],
              resets: [],
              days: days.map((date) => ({ date, byProject: [{ project: 'alpha', costUsd: 3 }] })),
              coverage: { daysRequested: days.length, lines: 0, skipped: 0, outOfRange: 0, droppedSessions: 0, capped: false },
            },
      ),
    }),
    { shell: shellState(html) },
  );
  await p.advance(1);
  p.el('range-' + range).fire('click');
  await p.advance(1);
  return p;
}

/** Every day name the cost axis printed, with the x it was anchored at. */
const dayTicks = (p: Page): { text: string; x: number }[] =>
  (p.el('cost-canvas').getContext('2d') as never as { argsOf(n: string): unknown[][] })
    .argsOf('fillText')
    .filter((a) => /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}$/.test(String(a[0])))
    .map((a) => ({ text: String(a[0]), x: Number(a[1]) }));

/**
 * Where each day's name belongs: centred over the column its own midnight opens and the next
 * midnight closes. Calendar days, so the 25-hour one is a wider column than the six beside it
 * and its neighbours are pushed along by the hour it gained.
 */
const centres = (days: string[]): { text: string; x: number }[] => {
  const t0 = midnight(days[0]);
  const t1 = midnight(days[days.length - 1]) + DAY;
  const at = (t: number): number => L + ((t - t0) / (t1 - t0)) * (R - L);
  return days.map((date, i) => {
    const start = midnight(date);
    const end = i + 1 < days.length ? midnight(days[i + 1]) : t1;
    return { text: word(start), x: (at(start) + Math.min(R, at(end))) / 2 };
  });
};

async function assertAxis(days: string[]): Promise<void> {
  const drawn = dayTicks(await span(days));
  const want = centres(days);
  assert.deepEqual(
    drawn.map((t) => t.text),
    want.map((t) => t.text),
  );
  for (let i = 0; i < want.length; i++)
    assert.ok(
      Math.abs(drawn[i].x - want[i].x) < 0.5,
      `${drawn[i].text} is centred at ${drawn[i].x.toFixed(1)}, and its column is centred at ${want[i].x.toFixed(1)}`,
    );
}

// Sunday 25 October 2026 is twenty-five hours long in Paris. Stepped by 86400000 from its
// midnight, the walk lands at 23:00 the same evening: a second `Sun 25`, and then a name a
// column early for every day left in the week.
test('the week a clock falls back gets one tick a day, each over its own column', async () => {
  await assertAxis(['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']);
});

// Sunday 29 March is twenty-three. The count comes out right and the names do too, which is
// what makes this one the quiet half of the bug: every tick from Monday on is drawn an hour
// into the column beside it.
test('the week a clock springs forward keeps its ticks on their own columns', async () => {
  await assertAxis(['2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01']);
});

// A month labels every fifth date rather than every day, and it walks the same loop. The
// evening the walk slipped into is still the 25th, so the month drew `Oct 25` twice, eleven
// pixels apart, which is the two of them overprinting each other.
test('a month names each fifth date once, and at the date itself', async () => {
  const days: string[] = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(2026, 9, 6 + i);
    days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  const t0 = midnight(days[0]);
  const t1 = midnight(days[days.length - 1]) + DAY;
  const want = days
    .filter((date) => new Date(midnight(date)).getDate() % 5 === 0)
    .map((date) => ({
      text: MON[new Date(midnight(date)).getMonth()] + ' ' + new Date(midnight(date)).getDate(),
      x: L + ((midnight(date) - t0) / (t1 - t0)) * (R - L),
    }));
  const drawn = (
    (await span(days, '30d')).el('cost-canvas').getContext('2d') as never as { argsOf(n: string): unknown[][] }
  )
    .argsOf('fillText')
    .filter((a) => /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}$/.test(String(a[0])))
    .map((a) => ({ text: String(a[0]), x: Number(a[1]) }));
  assert.deepEqual(
    drawn.map((t) => t.text),
    want.map((t) => t.text),
  );
  for (let i = 0; i < want.length; i++)
    assert.ok(
      Math.abs(drawn[i].x - want[i].x) < 0.5,
      `${drawn[i].text} is drawn at ${drawn[i].x.toFixed(1)}, and its own midnight is at ${want[i].x.toFixed(1)}`,
    );
});
