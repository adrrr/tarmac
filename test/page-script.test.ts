// The dashboard's script, executed — not read.
//
// A mutation run against the suite as it stood showed that deleting the swap, the ticker, the
// poll timer or the banner left every test green. The rules the script enforces are product
// rules ("an empty answer is not an empty fleet"), and they were being verified by a human
// looking at a browser. These run the string the page actually ships.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPage } from '../src/render.ts';
import { mountPage, scriptOf } from './page-dom.ts';
import type { Respond } from './page-dom.ts';
import { health, row } from './fleet-fixtures.ts';

const SCRIPT = scriptOf(renderPage({ rows: [row()], health: health() }));
const mount = (respond: Respond) => mountPage(SCRIPT, respond);
const ok = (body: string): Promise<{ ok: boolean; body: string }> => Promise.resolve({ ok: true, body });

test('a good answer is swapped in, and the age goes back to zero', async () => {
  const page = mount(() => ok('<div>fresh fleet</div>'));
  await page.advance(5000);
  assert.equal(page.el('live').innerHTML, '<div>fresh fleet</div>');
  assert.match(page.el('age').textContent, /updated 0s ago/);
  assert.equal(page.el('offline').hidden, true);
  assert.equal(page.body.classes.has('failing'), false);
});

test('the age keeps climbing between answers', async () => {
  const page = mount(() => ok('<div>fleet</div>'));
  await page.advance(5000);
  await page.advance(3000);
  assert.match(page.el('age').textContent, /updated 3s ago/);
});

// The defect found by pointing the real page at a server answering 200 with nothing: the
// blank fleet was swapped in and stamped "updated 0s ago", green dot and all.
//
// Three polls, not two: an empty answer is a miss like any other, and the banner is owed a
// second consecutive one before it speaks. The rule under test is what the page REFUSES —
// the blank body is never swapped in, on the first miss as on the second.
test('an empty answer is a failed refresh, not an empty fleet', async () => {
  const page = mount((call) => (call === 1 ? ok('<div>two busy sessions</div>') : ok('')));
  await page.advance(6000);
  await page.advance(5000);
  assert.equal(page.el('live').innerHTML, '<div>two busy sessions</div>', 'the fleet is still there');
  await page.advance(5000);
  assert.equal(page.el('offline').hidden, false);
  assert.match(page.el('why').textContent, /empty page/i);
});

test('a 500 is a failure, and its body becomes the reason', async () => {
  const page = mount(() => Promise.resolve({ ok: false, body: 'tarmac could not read the fleet:\nclaude: not found' }));
  await page.advance(6000);
  await page.advance(5000);
  assert.equal(page.el('offline').hidden, false);
  assert.match(page.el('why').textContent, /claude: not found/);
});

test('a hidden tab stops asking, and a revealed one asks at once', async () => {
  const page = mount(() => ok('<div>fleet</div>'));
  await page.advance(6000);
  const before = page.calls;
  page.hide();
  await page.advance(20_000);
  assert.equal(page.calls, before, 'nothing was asked while hidden');
  await page.show();
  assert.equal(page.calls, before + 1, 'and one thing was asked on waking');
});

// ── the stalled server ────────────────────────────────────────────────────────────────
// The failure the whole design rests on. `fetch` has no timeout in any browser, so a server
// that accepts the connection and never answers — a stopped process, a hung mount under the
// synchronous snapshot read — leaves the request pending forever. The one-at-a-time guard
// then locks: no later poll runs, `failing` is never set, and the page sits green and quiet
// with an ageing number as its only hint. That is the half-open-socket failure the poll was
// chosen over SSE to avoid.
test('a request that never answers eventually raises the banner instead of locking the page', async () => {
  const page = mount(
    (call) => (call === 1 ? ok('<div>fleet</div>') : new Promise(() => {})),
  );
  await page.advance(6000);
  await page.advance(60_000);
  assert.equal(page.el('offline').hidden, false, 'the page admits it is not being refreshed');
  assert.match(page.el('why').textContent, /did not answer/i, 'and says the server went quiet, not something generic');
  assert.match(page.el('age').textContent, /updated 1m ago/);
});

test('a stalled request does not stop the page asking again once it has given up', async () => {
  let stalls = 0;
  const page = mount((call) => {
    if (call === 1) return ok('<div>fleet</div>');
    if (call < 5) {
      stalls++;
      return new Promise(() => {});
    }
    return ok('<div>back</div>');
  });
  await page.advance(6000);
  await page.advance(120_000);
  assert.ok(stalls >= 2, `gave up and retried; stalled requests issued: ${stalls}`);
  assert.equal(page.el('live').innerHTML, '<div>back</div>', 'and it recovered');
  assert.equal(page.el('offline').hidden, true);
});

// Hardening: `live.innerHTML = body` is an active sink. Loopback says where an answer came
// from, not who wrote it — a process that takes the port after tarmac exits, or a proxy in
// front of it, can answer 200 with `<img src=x onerror=…>` and have it executed in a page
// the user opened themselves. An answer that cannot prove it is tarmac's is not swapped in.
test('an answer that does not identify itself as tarmac is never swapped in', async () => {
  const page = mount((call) =>
    call === 1
      ? ok('<div>the real fleet</div>')
      : Promise.resolve({ ok: true, body: '<img src=x onerror="alert(1)">', headers: {} }),
  );
  await page.advance(6000);
  await page.advance(5000);
  assert.equal(page.el('live').innerHTML, '<div>the real fleet</div>', 'the last good fleet stays');
  // The refusal is immediate; only the BANNER waits for a second consecutive miss.
  await page.advance(5000);
  assert.equal(page.el('offline').hidden, false, 'and the reader is told the refresh failed');
  assert.match(page.el('why').textContent, /tarmac/i);
});

// ── the account's two windows ─────────────────────────────────────────────────────────
// They are drawn in the header, which is the shell's and survives the poll — but the numbers
// in them are the fleet's, and the fleet arrives in the fragment. So the fragment carries a
// hidden copy and every swap lifts it up: a five-hour window frozen at the minute the tab was
// opened would be the one number on this page still claiming to be about now.
test('the account gauges are lifted out of the fragment on every swap', async () => {
  const page = mount(() => ok('<div>fleet</div>'));
  page.el('limits-src').innerHTML = '<div class="gauge">5h 21%</div>';
  await page.advance(5000);
  assert.equal(page.el('limits').innerHTML, '<div class="gauge">5h 21%</div>');
});

// The same rule the fragment itself follows: an answer that was refused is an answer nothing
// is read out of. A stranger on the port must not get to write the account's numbers either.
test('an answer that is never swapped in does not get to move the gauges', async () => {
  const page = mount((call) =>
    call === 1
      ? ok('<div>the real fleet</div>')
      : Promise.resolve({ ok: true, body: '<div>a stranger</div>', headers: {} }),
  );
  page.el('limits-src').innerHTML = '<div class="gauge">5h 21%</div>';
  await page.advance(6000);
  page.el('limits-src').innerHTML = '<div class="gauge">99%</div>';
  await page.advance(5000);
  assert.equal(
    page.el('limits').innerHTML,
    '<div class="gauge">5h 21%</div>',
    'the header still shows what tarmac last said',
  );
});

// ── one miss is weather ───────────────────────────────────────────────────────────────
//
// On a phone the page is read on a radio: a tunnel, a lift, a handover between cells drops one
// request and the next one lands. Raising the banner on the first of those framed the table
// off and shouted an outage at a reader whose fleet was fine — five seconds later it was green
// again. The banner is for a server that has gone, so it waits for the second consecutive miss
// and the freshness line carries the truth in the meantime.
test('one missed poll is weather: the banner waits for the second', async () => {
  const page = mount(() => Promise.reject(new Error('Failed to fetch')));
  await page.advance(6000);
  assert.equal(page.el('offline').hidden, true, 'nothing is claimed on one miss');
  assert.equal(page.body.classes.has('failing'), false, 'and the table is not framed off');
  await page.advance(5000);
  assert.equal(page.el('offline').hidden, false, 'the second miss is an outage');
  assert.match(page.el('why').textContent, /Failed to fetch/);
});

// What makes the wait honest rather than a lie of omission: nothing on the page claims to be
// fresher than it is while the banner holds. The age is counted by the shell's own clock and
// keeps climbing whether or not an answer ever comes.
test('the age tells the truth while the banner is still waiting', async () => {
  const page = mount((call) => (call === 1 ? ok('<div>fleet</div>') : Promise.reject(new Error('gone'))));
  await page.advance(6000);
  await page.advance(5000);
  assert.equal(page.el('offline').hidden, true, 'one miss so far');
  assert.match(page.el('age').textContent, /updated 6s ago/, 'counted from the last good answer, not from the miss');
});

// Consecutive, not cumulative. Two misses an hour apart on a good connection are two blips,
// and a counter that never resets turns the second one into a permanent banner.
test('an answer between two misses puts the count back to zero', async () => {
  const page = mount((call) => (call === 2 ? ok('<div>fleet</div>') : Promise.reject(new Error('blip'))));
  await page.advance(6000);
  await page.advance(5000);
  await page.advance(5000);
  assert.equal(page.el('offline').hidden, true, 'a miss, an answer and a miss is not an outage');
});

// The asymmetry, on purpose: a request the server took and never answered is not a dropped
// packet, it is twenty seconds of silence from a process that accepted the connection. That
// one is called at once — and once called, a later miss must not take the alarm back DOWN.
// Counting it as a first miss did exactly that: the banner came up at the stall and dropped
// off five seconds later, while the server was still gone.
test('a poll that fails after a stall does not take the banner back down', async () => {
  let stalled = false;
  const page = mount((call) => {
    if (call === 1) return ok('<div>fleet</div>');
    if (!stalled) {
      stalled = true;
      return new Promise(() => {});
    }
    return Promise.reject(new Error('Failed to fetch'));
  });
  await page.advance(6000);
  await page.advance(5000);
  const stalledCall = page.calls;
  await page.advance(20_000);
  assert.equal(page.el('offline').hidden, false, 'the stall raised it');
  // Exactly ONE poll past the stall, and no further: a second miss would raise the banner on
  // its own and the test would pass against a page that had dropped it in between.
  for (let i = 0; page.calls === stalledCall && i < 30; i++) await page.advance(1000);
  assert.equal(page.calls, stalledCall + 1, 'one poll past the stall, and one only');
  assert.equal(page.el('offline').hidden, false, 'and a miss after it does not lower it');
  assert.equal(page.body.classes.has('failing'), true);
});

// Consecutive means "in a row IN TIME", and the count had no notion of time at all: only a
// successful poll ever cleared it, and a hidden tab issues no polls, so a miss recorded before
// the reader locked their phone was still sitting there an hour later. The wake-up poll — fired
// the instant the tab is shown, which is the likeliest miss of the whole session, because the
// radio is reassociating — found the count at one and raised the banner. Five seconds later the
// next poll landed and it was gone again: the exact behaviour this rule exists to remove,
// reached by the path a phone takes every time it is picked up.
test('a miss an hour after a blip is a first miss, not a second', async () => {
  let calls = 0;
  const page = mount(() => {
    calls += 1;
    return calls === 2 || calls === 3 ? Promise.reject(new Error('Failed to fetch')) : ok('<div>fleet</div>');
  });
  await page.advance(6000);
  await page.advance(5000);
  assert.equal(page.el('offline').hidden, true, 'the blip claims nothing');
  page.hide();
  await page.advance(3_600_000);
  assert.equal(page.calls, 2, 'a hidden tab asks for nothing, so nothing can clear the count');
  await page.show();
  assert.equal(page.calls, 3, 'and the wake-up poll goes out at once');
  assert.equal(page.el('offline').hidden, true, 'one dropped request on waking is still one');
});


// A stall is still two misses' worth on its own, and the miss five seconds behind it is
// consecutive with it — the window may not undo the grace `fail()` spends.
test('a miss right after a stall is still consecutive with it', async () => {
  let stalled = false;
  const page = mount((call) => {
    if (call === 1) return ok('<div>fleet</div>');
    if (!stalled) {
      stalled = true;
      return new Promise(() => {});
    }
    return Promise.reject(new Error('Failed to fetch'));
  });
  await page.advance(6000);
  await page.advance(5000);
  const stalledCall = page.calls;
  await page.advance(20_000);
  for (let i = 0; page.calls === stalledCall && i < 30; i++) await page.advance(1000);
  assert.equal(page.el('offline').hidden, false, 'the stall raised it and the miss keeps it up');
});

// `fail()` gave up on the request without retiring it: it cleared the in-flight flag and left
// the generation alone, so the answer that arrived forty seconds later was still "ours". It was
// swapped in and stamped "updated 0s ago" — a forty-second-old fleet wearing the freshest label
// on the page, which is the exact confusion the empty-answer rule next door exists to prevent.
// The manual has always said an answer to a request already given up on is discarded; now it is.
test('an answer to a request the page gave up on is never swapped in', async () => {
  let release: ((v: { ok: boolean; body: string }) => void) | null = null;
  const page = mount((call) =>
    call === 1
      ? ok('<div>the fleet as it was</div>')
      : new Promise((resolve) => {
          release = resolve;
        }));
  await page.advance(6000);
  await page.advance(5000);
  await page.advance(20_000);
  assert.equal(page.el('offline').hidden, false, 'the stall was declared');
  release!({ ok: true, body: '<div>a twenty-second-old answer</div>' });
  await page.advance(1000);
  assert.equal(page.el('live').innerHTML, '<div>the fleet as it was</div>', 'the dead answer is not the fleet');
  assert.equal(page.el('offline').hidden, false, 'and it does not clear the banner it never earned');
});
