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

test('a refused connection raises the banner and names the reason', async () => {
  const page = mount(() => Promise.reject(new Error('Failed to fetch')));
  await page.advance(6000);
  assert.equal(page.el('offline').hidden, false);
  assert.equal(page.body.classes.has('failing'), true);
  assert.match(page.el('why').textContent, /Failed to fetch/);
});

// The defect found by pointing the real page at a server answering 200 with nothing: the
// blank fleet was swapped in and stamped "updated 0s ago", green dot and all.
test('an empty answer is a failed refresh, not an empty fleet', async () => {
  const page = mount((call) => (call === 1 ? ok('<div>two busy sessions</div>') : ok('')));
  await page.advance(6000);
  await page.advance(5000);
  assert.equal(page.el('live').innerHTML, '<div>two busy sessions</div>', 'the fleet is still there');
  assert.equal(page.el('offline').hidden, false);
  assert.match(page.el('why').textContent, /empty page/i);
});

test('a 500 is a failure, and its body becomes the reason', async () => {
  const page = mount(() => Promise.resolve({ ok: false, body: 'tarmac could not read the fleet:\nclaude: not found' }));
  await page.advance(6000);
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
  assert.equal(page.el('offline').hidden, false, 'and the reader is told the refresh failed');
  assert.match(page.el('why').textContent, /tarmac/i);
});
