// One rule, three readers (#207). "Is this a status tarmac does not know" is asked by the
// discovery reader, by fleet health, and by the demo's stand-in discovery, and the three used
// to write it out separately — down to the demo spelling `waiting` as a literal. They agreed,
// and nothing said they had to: the day the reader exempts a second word the way it exempted
// `waiting`, the other two keep counting it, and the banner says "reports a status tarmac does
// not know" over a session the page draws, captioned, as known.
//
// So the rule is `isUnknownStatus` in sessions.ts and the three call it. This file feeds one
// set of sessions to the counters that surface a number and expects the same answer from each.
// The demo's copy surfaces none of its own — `buildFleet` recomputes the count from the rows —
// so what holds it is that it is now the same call, with no rule left in it to drift.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFleet } from '../src/fleet.ts';
import { isUnknownStatus, parseAgents } from '../src/sessions.ts';

const NOW = 1786240000000;

// One entry per answer the rule owes: the four words the boolean covers, the word it cannot
// answer for that tarmac knows by name anyway, two it cannot answer for at all, and an entry
// carrying no word. `unknown` is written out here rather than counted off a counter, so a
// mutation that moves all three counters together still turns this file red.
const CASES: ReadonlyArray<{ word: string; entry: Record<string, unknown>; unknown: boolean }> = [
  { word: 'busy', entry: { sessionId: 'a', status: 'busy' }, unknown: false },
  { word: 'idle', entry: { sessionId: 'b', status: 'idle' }, unknown: false },
  { word: 'working', entry: { sessionId: 'c', state: 'working' }, unknown: false },
  { word: 'done', entry: { sessionId: 'd', state: 'done' }, unknown: false },
  { word: 'waiting', entry: { sessionId: 'e', status: 'waiting', waitingFor: 'input needed' }, unknown: false },
  { word: 'compacting', entry: { sessionId: 'f', status: 'compacting' }, unknown: true },
  { word: 'failed', entry: { sessionId: 'g', state: 'failed' }, unknown: true },
  { word: 'no word at all', entry: { sessionId: 'h' }, unknown: true },
];

const UNKNOWN = CASES.filter((c) => c.unknown).length;

test('the rule names the words tarmac does not know, one session at a time', () => {
  for (const { word, entry, unknown } of CASES) {
    const { sessions } = parseAgents(JSON.stringify([entry]));
    assert.equal(isUnknownStatus(sessions[0]), unknown, word);
  }
});

test('discovery and fleet health count the same sessions as the rule', () => {
  const { sessions, health } = parseAgents(JSON.stringify(CASES.map((c) => c.entry)));
  const { health: fleetHealth } = buildFleet({ sessions, snapshots: new Map(), now: NOW });
  assert.equal(health.unknownStatus, UNKNOWN, 'the reader');
  assert.equal(fleetHealth.unknownStatus, UNKNOWN, 'the fleet');
  assert.equal(sessions.filter(isUnknownStatus).length, UNKNOWN, 'the rule the demo counts with');
});
