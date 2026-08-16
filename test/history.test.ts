import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, HISTORY_CADENCE_MS, HISTORY_SLOTS } from '../src/history.ts';
import { health, row, NOW } from './fleet-fixtures.ts';
import type { Fleet } from '../src/fleet.ts';

const fleet = (rows = [row()], generatedAt = NOW): Fleet => ({
  rows,
  health: health({ sessions: rows.length, generatedAt }),
});

test('a sample carries, per session, the fields a replay reads back', () => {
  const h = createHistory({ since: NOW, cadence: HISTORY_CADENCE_MS });
  h.record(fleet());
  const [sample] = h.read().samples;
  assert.equal(sample.t, NOW, 'dated by the reading it was taken from');
  assert.equal(sample.sessions.length, 1);
  assert.deepEqual(sample.sessions[0], {
    sid: 's1',
    project: 'alpha',
    kind: 'interactive',
    state: 'idle',
    ctxState: 'ok',
    ctxPct: 26,
    costUsd: 27.75,
  });
});

// The three words the map draws, out of the same function: a replay that disagreed with the
// live view about the same session would be showing two states, not one.
test('a session whose status tarmac does not recognise is unknown in the ring too', () => {
  const h = createHistory({ since: NOW, cadence: HISTORY_CADENCE_MS });
  h.record(fleet([row({ busy: null, status: 'transmogrifying' })]));
  assert.equal(h.read().samples[0].sessions[0].state, 'unknown');
});

// One account's number, read at whatever moment each session last drew a frame. The youngest
// reading is the one that is still true.
test('the rate limits travel with the sample, from the freshest reading that carried them', () => {
  const h = createHistory({ since: NOW, cadence: HISTORY_CADENCE_MS });
  h.record(
    fleet([
      row({ snapshotAgeMs: 90_000, rateLimits: { five_hour: { used_percentage: 17 } } }),
      row({ sessionId: 's2', snapshotAgeMs: 1200, rateLimits: { five_hour: { used_percentage: 42 } } }),
    ]),
  );
  assert.equal(h.read().samples[0].rateLimits!.five_hour.used_percentage, 42);
});

// The same value `map.ts` refuses to call an age: a snapshot dated after the clock that read
// it (an NTP correction, a mount running ahead) is not the youngest reading, and letting it
// win would misreport the account's limits for every sample until the skew clears.
test('a snapshot dated in the future does not get to be the freshest reading', () => {
  const h = createHistory({ since: NOW, cadence: HISTORY_CADENCE_MS });
  h.record(
    fleet([
      row({ snapshotAgeMs: -600_000, rateLimits: { five_hour: { used_percentage: 3 } } }),
      row({ sessionId: 's2', snapshotAgeMs: 1200, rateLimits: { five_hour: { used_percentage: 91 } } }),
    ]),
  );
  assert.equal(h.read().samples[0].rateLimits!.five_hour.used_percentage, 91);
});

test('a fleet whose snapshots carry no rate limits samples them as absent, never as zero', () => {
  const h = createHistory({ since: NOW, cadence: HISTORY_CADENCE_MS });
  h.record(fleet());
  assert.equal(h.read().samples[0].rateLimits, null);
});

// The one number that makes this "in memory only" a promise rather than a hope: a serve left
// open for a week holds a day, and holds it whatever the fleet's size.
test('the ring stops at a day of minutes and drops the oldest one', () => {
  const h = createHistory({ since: NOW, cadence: HISTORY_CADENCE_MS });
  for (let i = 0; i < HISTORY_SLOTS + 3; i++) h.record(fleet([row()], NOW + i));
  const { samples } = h.read();
  assert.equal(samples.length, HISTORY_SLOTS);
  assert.equal(samples[0].t, NOW + 3, 'the oldest minutes fell off');
  assert.equal(samples[samples.length - 1].t, NOW + HISTORY_SLOTS + 2, 'the newest is last');
  assert.equal(HISTORY_SLOTS, 1440, '24h at one sample a minute');
});

test('a failed collection is a counted slot, not a missing one and not a sample', () => {
  const h = createHistory({ since: NOW, cadence: HISTORY_CADENCE_MS });
  h.record(fleet());
  h.miss(NOW + 1);
  h.miss(NOW + 2);
  const { samples, missed } = h.read();
  assert.equal(samples.length, 1);
  assert.equal(missed, 2);
});

// `since` is what a page reads to say what it covers, so it may not go on naming a moment the
// record no longer holds. A serve open for 34 hours covers 24 of them.
test('once the oldest minute has fallen off, `since` is the oldest minute still held', () => {
  const h = createHistory({ since: NOW, cadence: HISTORY_CADENCE_MS });
  for (let i = 0; i < HISTORY_SLOTS; i++) h.record(fleet([row()], NOW + i));
  assert.equal(h.read().since, NOW, 'a full ring has dropped nothing, and covers everything since the start');
  h.record(fleet([row()], NOW + HISTORY_SLOTS));
  assert.equal(h.read().since, NOW + 1, 'the first minute is gone, and `since` stops claiming it');
});

// 1440 SLOTS, not 1440 samples: a minute the fleet could not be read is a minute of the day
// this record covers, and it ages out with the rest. `missed` counted for the life of the
// process while `since` covered a day would be two spans in one payload.
test('a missed slot takes its place in the ring, and ages out of it', () => {
  const h = createHistory({ since: NOW, cadence: HISTORY_CADENCE_MS });
  h.miss(NOW);
  for (let i = 1; i < HISTORY_SLOTS; i++) h.record(fleet([row()], NOW + i));
  assert.equal(h.read().missed, 1);
  assert.equal(h.read().samples.length, HISTORY_SLOTS - 1, 'the failure took a slot from the samples');
  h.record(fleet([row()], NOW + HISTORY_SLOTS));
  const after = h.read();
  assert.equal(after.missed, 0, 'a day later it is no longer part of what the record covers');
  assert.equal(after.since, NOW + 1);
});

// What the page reads to say what it covers — the reason no flag needs to.
test('the payload says when the record started and how often it is written', () => {
  const h = createHistory({ since: NOW, cadence: HISTORY_CADENCE_MS });
  const { since, cadence, samples, missed } = h.read();
  assert.equal(since, NOW);
  assert.equal(cadence, HISTORY_CADENCE_MS);
  assert.equal(HISTORY_CADENCE_MS, 60_000, 'one minute');
  assert.deepEqual(samples, []);
  assert.equal(missed, 0);
});

// A reader that mutated what it was handed would edit the record — the ring is the only
// copy there is, and there is no file to re-read it from.
test('what a reader gets back is not the ring itself', () => {
  const h = createHistory({ since: NOW, cadence: HISTORY_CADENCE_MS });
  h.record(fleet());
  h.read().samples.length = 0;
  assert.equal(h.read().samples.length, 1);
});
