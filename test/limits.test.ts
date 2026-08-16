// The account's two windows, read out of a payload nobody here owns.
//
// The rules are the ones `snapshots.ts` already applies to the context reading, for the same
// reason: a percentage that is missing, of the wrong type, or outside the range a percentage
// can have is not a number to draw — and drawing it as 0% is how "the account is fine" gets
// said about a window nobody could read.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLimits } from '../src/limits.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n: string): any => JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', n), 'utf8'));

/** A clock the fixture's own reset times sit in the future of. */
const NOW = 1786210000000;

test('a real payload yields the five-hour window and the seven-day one, in that order', () => {
  const [five, seven] = readLimits(fixture('statusline-payload-2.1.220-live.json').rate_limits, NOW);
  assert.equal(five.pct, 17);
  assert.equal(seven.pct, 42);
  assert.match(five.said, /five/i, 'the abbreviation is spelled out for a reader who hears it');
  assert.match(seven.said, /seven/i);
});

// The reset is an epoch in the payload and a stretch of time on the page: the subtraction is
// done here, against the clock the reading was taken with, so no renderer has to invent one.
test('the reset comes back as what is left of the window, out of the clock it is read with', () => {
  const [five] = readLimits({ five_hour: { used_percentage: 17, resets_at: 1786212000 } }, NOW);
  assert.equal(five.resetsInMs, 2_000_000, '1786212000s is 2000s past this clock');
});

// A window that reset while the snapshot sat unread is a real state, and the sign is how the
// page says so. Clamping it to zero would date a reading from the previous window "resets now".
test('a reset that has already passed comes back negative, not clamped to zero', () => {
  const [five] = readLimits({ five_hour: { used_percentage: 90, resets_at: 1786209000 } }, NOW);
  assert.equal(five.resetsInMs, -1_000_000);
});

test('a window that reports no reset keeps its percentage and says nothing about time', () => {
  const [five] = readLimits({ five_hour: { used_percentage: 17 } }, NOW);
  assert.equal(five.pct, 17);
  assert.equal(five.resetsInMs, null);
});

// The cardinal rule of this project, in the header: no snapshot carried rate limits, and that
// is not an account at 0%.
test('a payload with no rate limits at all is two windows with nothing in them, never two zeros', () => {
  const gauges = readLimits(null, NOW);
  assert.equal(gauges.length, 2);
  for (const g of gauges) {
    assert.equal(g.pct, null);
    assert.equal(g.why, 'absent');
    assert.equal(g.resetsInMs, null);
  }
});

// The same discriminant `snapshots.ts` uses for the context window: the PRESENCE of the key,
// never its value. A key that is there and null is a number not taken yet; a key that is gone,
// or holding something that is not a percentage, is a schema that moved.
test('a percentage that is present and null is a reading not taken, not a moved schema', () => {
  const [five] = readLimits({ five_hour: { used_percentage: null, resets_at: 1786212000 } }, NOW);
  assert.equal(five.pct, null);
  assert.equal(five.why, 'absent');
});

test('a window the payload does not carry at all reports drift', () => {
  const [, seven] = readLimits({ five_hour: { used_percentage: 17 } }, NOW);
  assert.equal(seven.pct, null);
  assert.equal(seven.why, 'drift');
});

test('a percentage of the wrong type reports drift rather than being drawn', () => {
  for (const v of ['40%', {}, true, [40]]) {
    const [five] = readLimits({ five_hour: { used_percentage: v } }, NOW);
    assert.equal(five.pct, null, String(v));
    assert.equal(five.why, 'drift', String(v));
  }
});

// `1e999` is legal JSON and parses to Infinity; a negative one reached a bar as `width:-3%`,
// which renders as nothing at all beside a confident number. Neither is a percentage.
test('a percentage outside the range a percentage can have is refused', () => {
  for (const v of [Number.POSITIVE_INFINITY, Number.NaN, -3, 101]) {
    const [five] = readLimits({ five_hour: { used_percentage: v } }, NOW);
    assert.equal(five.pct, null, String(v));
    assert.equal(five.why, 'drift', String(v));
  }
});

test('a percentage is floored, never rounded up to a window that is fuller than it is', () => {
  assert.equal(readLimits({ five_hour: { used_percentage: 17.9 } }, NOW)[0].pct, 17);
});

test('a reset that is not a number is no reset, and never NaN milliseconds', () => {
  for (const v of ['soon', null, {}]) {
    const [five] = readLimits({ five_hour: { used_percentage: 17, resets_at: v } }, NOW);
    assert.equal(five.resetsInMs, null, String(v));
  }
});

// A measured window is a measured window: `why` exists to name a missing number, and a page
// that reads it without checking `pct` first must not find a word there.
test('a window that could be read carries no reason for not being read', () => {
  assert.equal(readLimits({ five_hour: { used_percentage: 0 } }, NOW)[0].why, null);
});

// Anything can arrive in a JSON object. `rate_limits: []` and `rate_limits: "none"` are not
// two windows, and neither of them may throw in the header of a dashboard.
test('rate limits that are not an object of windows are drift, not a crash', () => {
  for (const rl of [[] as any, 'none' as any, 42 as any, { five_hour: 'soon' } as any]) {
    const gauges = readLimits(rl, NOW);
    assert.equal(gauges.length, 2, JSON.stringify(rl));
    assert.equal(gauges[0].pct, null, JSON.stringify(rl));
  }
});
