// The journal on disk, which exists only because someone asked for it.
//
// Everything here is about a promise the README used to make without an asterisk: nothing of
// the fleet is written down. A reader who sets `history.days` lifts that for their own machine,
// and what they get has to be exactly what was advertised: the same fields the in-memory ring
// keeps, no name and no working directory, bounded by an age AND by a hard cap, and never a
// reason for `serve` to fall over.
//
// The clock is injected in every test here. A store judged by the wall clock has a retention
// test that is green today and red at midnight, and a cap test that depends on the hour it ran.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHistoryStore, historyDirFor, HISTORY_MAX_BYTES } from '../src/history-store.ts';
import type { HistorySample } from '../src/history.ts';
import { tempDir } from './sandbox.ts';

/** Noon on a named calendar day, local. Noon so no test sits within an hour of a DST shift. */
const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h, 0, 0, 0).getTime();

/**
 * The day a moment falls on, restated rather than imported: a file name checked with the
 * function that produced it is a file name nothing checks.
 */
function dayOf(t: number): string {
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const sample = (t: number, over: Partial<HistorySample> = {}): HistorySample => ({
  t,
  sessions: [
    {
      sid: 's1',
      project: 'alpha',
      kind: 'interactive',
      state: 'idle',
      waitingFor: null,
      ctxState: 'ok',
      ctxPct: 26,
      costUsd: 27.75,
    },
  ],
  rateLimits: { five_hour: { used_percentage: 17 } },
  ...over,
});

/** A store whose clock the test moves by hand. */
function store(dir: string, days: number, clock: { now: number }, maxBytes?: number) {
  return createHistoryStore({ dir, days, now: () => clock.now, maxBytes });
}

const lines = (dir: string, day: string): string[] =>
  fs
    .readFileSync(path.join(dir, `${day}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l !== '');

// ── what lands on disk ────────────────────────────────────────────────────────────────

test('a sample is one JSON line in the file for the local day it was read on', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 30, clock);

  s.append(sample(clock.now));

  const written = lines(dir, '2026-08-07');
  assert.equal(written.length, 1, 'one line, one reading');
  // The seven fields spelled out, rather than compared against the fixture that produced them:
  // the journal is an ALLOWLIST of the ring's record, so a shape-to-shape assertion would have
  // to be edited into agreement with whatever the ring grows next, and would agree.
  assert.deepEqual(JSON.parse(written[0]), {
    t: clock.now,
    sessions: [
      { sid: 's1', project: 'alpha', kind: 'interactive', state: 'idle', ctxState: 'ok', ctxPct: 26, costUsd: 27.75 },
    ],
    rateLimits: { five_hour: { used_percentage: 17 } },
  });
});

test('the directory is made when it is not there yet', () => {
  const root = tempDir('tarmac-hist-');
  const dir = path.join(root, 'history');
  const clock = { now: at(2026, 8, 7) };
  assert.equal(fs.existsSync(dir), false, 'nothing on disk before a reader asked for any');

  store(dir, 30, clock).append(sample(clock.now));

  assert.ok(fs.existsSync(path.join(dir, '2026-08-07.jsonl')));
});

test('a second reading is appended, never written over the first', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 30, clock);

  s.append(sample(clock.now));
  clock.now = at(2026, 8, 7, 13);
  s.append(sample(clock.now));

  const written = lines(dir, '2026-08-07');
  assert.equal(written.length, 2);
  assert.equal((JSON.parse(written[0]) as HistorySample).t, at(2026, 8, 7));
  assert.equal((JSON.parse(written[1]) as HistorySample).t, at(2026, 8, 7, 13));
});

test('a reading taken on the next day opens the file for the next day', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 30, clock);

  s.append(sample(clock.now));
  clock.now = at(2026, 8, 8);
  s.append(sample(clock.now));

  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-08-07.jsonl', '2026-08-08.jsonl']);
});

// The privacy line is NOT asserted here, and that is deliberate. This store writes the object
// it is handed, so a fixture invented in this file could only ever prove that `JSON.stringify`
// invents no keys: a leak in `sampleOf` would leave every assertion in this file green. What
// the journal actually carries is held one level up, over the real sampler, in
// `test/server.test.ts` ("a background agent's name never reaches the journal either").

// ── retention ─────────────────────────────────────────────────────────────────────────

/** Days already on disk when the store opens, as a restarted `serve` finds them. */
function given(dir: string, days: string[]): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const day of days) fs.writeFileSync(path.join(dir, `${day}.jsonl`), '{"t":0,"sessions":[],"rateLimits":null}\n');
}

// `days: 30` is thirty days of journal, today included. A store that kept thirty-one would be
// off by a day against the number a reader wrote in their own config file.
test('a prune keeps the last `days` days and removes what fell out of them', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  given(dir, ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']);

  const { removed, failed } = store(dir, 3, clock).prune();

  assert.equal(removed, 2);
  assert.equal(failed, 0);
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    ['2026-08-05.jsonl', '2026-08-06.jsonl', '2026-08-07.jsonl'],
    'three days, the third of them today',
  );
});

// The prune a restarted `serve` runs before it has written anything: the retention is a
// property of the directory, not of what this process happens to have appended to it.
test('a startup prune reaches days no reading of this run ever touched', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  given(dir, ['2026-03-01', '2026-08-07']);

  assert.deepEqual(store(dir, 30, clock).prune(), { removed: 1, failed: 0 });
  assert.deepEqual(fs.readdirSync(dir), ['2026-08-07.jsonl']);
});

// Only what we wrote. The same rule `reap.ts` states for the temp files, and the reason the
// journal lives in a directory of its own: a sweep that deleted by age alone would be a tool
// deleting a stranger's file out of the user's own home.
test('a prune leaves a file this store did not write, whatever its age', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 1, clock);
  s.append(sample(clock.now));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours\n');
  fs.writeFileSync(path.join(dir, '2020-01-01.jsonl.bak'), 'not our name\n');

  s.prune();

  assert.deepEqual(fs.readdirSync(dir).sort(), ['2020-01-01.jsonl.bak', '2026-08-07.jsonl', 'notes.txt']);
});

// `serve` runs for weeks. Pruning only at startup would let a machine left up since March hold
// every day since March, under a config file that says thirty.
test('the store prunes itself once the local day has turned over', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 2, clock);

  s.append(sample(clock.now));
  clock.now = at(2026, 8, 8);
  s.append(sample(clock.now));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-08-07.jsonl', '2026-08-08.jsonl'], 'both still inside two days');

  clock.now = at(2026, 8, 9);
  s.append(sample(clock.now));

  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-08-08.jsonl', '2026-08-09.jsonl'], 'the 7th aged out on its own');
});

// ── the hard cap ──────────────────────────────────────────────────────────────────────

test('the cap is 256 MB, and it is a constant nobody can set from outside', () => {
  assert.equal(HISTORY_MAX_BYTES, 268_435_456);
});

// An age limit alone is not a bound: a fleet of two hundred sessions writes a hundred times
// what the startup line quoted. Past the cap the journal stops rather than fills the disk.
test('past the cap nothing more is written, and the store says why', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 30, clock, 400);

  for (let i = 0; i < 20; i++) {
    clock.now = at(2026, 8, 7, 12) + i * 60_000;
    s.append(sample(clock.now));
  }

  const stats = s.stats();
  assert.ok(stats.bytes <= 400, `the cap held: ${stats.bytes} bytes`);
  assert.ok(stats.stopped !== null, 'and the reason is there to be printed');
  assert.match(stats.stopped!, /cap/i);
  assert.ok(lines(dir, '2026-08-07').length < 20, 'the later readings were refused, not written');
});

// A reader who empties the directory by hand, which is what the README tells them to do to
// erase it, is a reader the cap has to notice too. `stopped` is recomputed on the write it
// would refuse, so a journal writing again cannot go on announcing that it is full.
test('a journal that has room again stops saying it is at its cap', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 30, clock, 400);
  for (let i = 0; i < 20; i++) {
    clock.now = at(2026, 8, 7, 12) + i * 60_000;
    s.append(sample(clock.now));
  }
  assert.ok(s.stats().stopped !== null, 'at the cap first, or this proves nothing');

  fs.rmSync(path.join(dir, '2026-08-07.jsonl'));
  s.append(sample(clock.now));

  assert.equal(s.stats().stopped, null, 'writing again, and no longer saying otherwise');
  assert.equal(lines(dir, '2026-08-07').length, 1);
});

// The cap is a stop, not a death sentence: the retention that made room is the retention that
// lets the journal resume, and a store that stayed stopped would need a restart to notice.
test('a prune that frees space lets the journal write again', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 2, clock, 400);

  for (let i = 0; i < 20; i++) {
    clock.now = at(2026, 8, 7, 12) + i * 60_000;
    s.append(sample(clock.now));
  }
  assert.ok(s.stats().stopped !== null, 'stopped first, or this proves nothing');

  clock.now = at(2026, 8, 12);
  s.prune();

  assert.equal(s.stats().stopped, null, 'the days that filled it are gone');
  s.append(sample(clock.now));
  assert.equal(lines(dir, '2026-08-12').length, 1);
});

// ── best effort, always ───────────────────────────────────────────────────────────────

// Hygiene must never be the reason `serve` falls over: it runs unattended for hours, and a
// throw out of the sampler is an unhandled rejection. A write that fails costs a line.
test('a write that cannot happen is counted, never thrown', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  fs.mkdirSync(dir, { recursive: true });
  // A directory wearing the day's name: every write to it fails, on every platform, with no
  // permission games a root-running CI would sail through.
  fs.mkdirSync(path.join(dir, '2026-08-07.jsonl'));
  const s = store(dir, 30, clock);

  assert.doesNotThrow(() => s.append(sample(clock.now)));
  assert.doesNotThrow(() => s.append(sample(clock.now)));

  assert.equal(s.stats().misses, 2, 'both of them, counted for whoever prints the line');
});

test('a directory that cannot be read reports no journal rather than throwing', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 30, clock);

  assert.deepEqual(s.stats(), { files: 0, bytes: 0, misses: 0, stopped: null });
  assert.deepEqual(s.prune(), { removed: 0, failed: 0 });
});

test('the stats count the files on disk and what they weigh', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  const s = store(dir, 30, clock);

  s.append(sample(clock.now));
  clock.now = at(2026, 8, 8);
  s.append(sample(clock.now));

  const stats = s.stats();
  assert.equal(stats.files, 2);
  assert.equal(
    stats.bytes,
    fs.statSync(path.join(dir, '2026-08-07.jsonl')).size + fs.statSync(path.join(dir, '2026-08-08.jsonl')).size,
  );
  assert.equal(stats.misses, 0);
  assert.equal(stats.stopped, null);
});

// ── where it lives ────────────────────────────────────────────────────────────────────

// A sibling of the snapshots, never a child of them. Three things already delete files under
// that directory (`reap.ts`, the wrapper's own sweep, the legacy purge in `install.ts`), and
// each of them decides by NAME: a journal sitting among the payloads would be one rename away
// from being somebody else's litter.
test('the journal is a sibling of the snapshots directory, on the same frozen base', () => {
  assert.equal(historyDirFor('/home/u/.local/state/tarmac/snapshots'), '/home/u/.local/state/tarmac/history');
  assert.equal(historyDirFor('/home/u/.local/state/tarmac/snapshots/'), '/home/u/.local/state/tarmac/history');
});

test('the file name rolls over with the year, not just with the day', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 12, 31, 23) };
  const s = store(dir, 30, clock);

  s.append(sample(clock.now));
  clock.now = at(2027, 1, 1, 1);
  s.append(sample(clock.now));

  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-12-31.jsonl', '2027-01-01.jsonl']);
  assert.equal(dayOf(at(2027, 1, 1, 1)), '2027-01-01', 'the year rolled over with the day');
});

// A retention so large the calendar cannot express it: `new Date(y, m, d - 100000000)` is an
// Invalid Date, its day reads `NaN-NaN-NaN`, and every real file name sorts BELOW that string.
// The prune then deleted the whole journal, which is the exact opposite of what the number
// asked for, in silence. A cutoff nothing can compute is a cutoff nothing is deleted by.
test('a retention too large for the calendar keeps everything, rather than deleting everything', () => {
  const dir = path.join(tempDir('tarmac-hist-'), 'history');
  const clock = { now: at(2026, 8, 7) };
  given(dir, ['2020-01-01', '2026-08-06', '2026-08-07']);

  assert.deepEqual(store(dir, 300_000_000, clock).prune(), { removed: 0, failed: 0 });

  assert.equal(fs.readdirSync(dir).length, 3, 'a journal asked to be kept for a million years is kept');
});
