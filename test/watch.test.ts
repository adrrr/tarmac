// `tarmac list --watch` — the terminal's half of "a view worth leaving open".
//
// It owes the reader the same two facts the page owes: when the last good reading arrived,
// and whether the last attempt failed. A watch that silently redraws the same numbers when
// `claude` has stopped answering is the frozen dashboard, in a smaller window.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWatch } from '../src/render.ts';
import { runWatch } from '../src/watch.ts';
import { health, row } from './fleet-fixtures.ts';
import type { Fleet } from '../src/fleet.ts';

const fleet = (over: Partial<ReturnType<typeof row>> = {}): Fleet => ({ rows: [row(over)], health: health() });

// ── the frame ─────────────────────────────────────────────────────────────────────────
test('a watch frame is the list table plus how old the reading is', () => {
  const frame = renderWatch({ fleet: fleet(), error: null, ageMs: 0, everyMs: 5000 });
  assert.match(frame, /alpha +idle +26%/, 'the table, as a row and not merely as a word');
  assert.match(frame, /26%/);
  assert.match(frame, /updated 0s ago/);
  assert.match(frame, /\^C/, 'and the way out');
});

test('a failing refresh keeps the last table and says the numbers stopped moving', () => {
  const frame = renderWatch({ fleet: fleet(), error: 'claude: not found', ageMs: 42_000, everyMs: 5000 });
  assert.match(frame, /26%/, 'the last good reading is still shown');
  assert.match(frame, /refresh failing/i);
  assert.match(frame, /claude: not found/, 'and why');
  assert.match(frame, /42s ago/, 'and how stale it now is');
});

test('a first refresh that fails has no table to show, and does not invent one', () => {
  const frame = renderWatch({ fleet: null, error: 'claude: not found', ageMs: 0, everyMs: 5000 });
  assert.match(frame, /claude: not found/);
  assert.equal(/PROJECT/.test(frame), false);
});

// ── the loop ──────────────────────────────────────────────────────────────────────────
/** A watch driven by a fake clock: no timers, no wall time, three frames, then stop. */
function drive(collect: () => Promise<Fleet>, frames = 3, isTTY = false): { out: string[]; run: Promise<void> } {
  const out: string[] = [];
  const ctl = new AbortController();
  let clock = 0;
  const run = runWatch({
    collect,
    write: (s) => {
      out.push(s);
      if (out.length >= frames) ctl.abort();
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    everyMs: 5000,
    isTTY,
    signal: ctl.signal,
  });
  return { out, run };
}

test('the watch redraws once per tick, re-reading the fleet each time', async () => {
  let calls = 0;
  const { out, run } = drive(async () => {
    calls++;
    return fleet({ ctxPct: 20 + calls });
  });
  await run;
  assert.equal(out.length, 3);
  assert.equal(calls, 3);
  assert.match(out[2], /23%/, 'the last frame shows the last reading');
});

test('a collector that throws does not end the watch, and the next success recovers it', async () => {
  let calls = 0;
  const { out, run } = drive(async () => {
    calls++;
    if (calls === 2) throw new Error('claude: not found');
    return fleet();
  });
  await run;
  assert.equal(out.length, 3);
  assert.equal(/refresh failing/i.test(out[0]), false);
  assert.match(out[1], /refresh failing/i);
  assert.match(out[1], /26%/, 'the last good table stays on screen');
  assert.equal(/refresh failing/i.test(out[2]), false, 'and the watch comes back');
});

// The age is the age of the last GOOD reading. Dating it from the last attempt would make a
// dead collector look like a fleet that simply stopped changing.
test('the age counts from the last good reading, not from the last attempt', async () => {
  let calls = 0;
  const { out, run } = drive(async () => {
    if (++calls > 1) throw new Error('claude: not found');
    return fleet();
  });
  await run;
  assert.match(out[0], /updated 0s ago/);
  assert.match(out[2], /updated 10s ago/, 'two failed ticks later, the reading is 10s old');
  assert.match(out[2], /refresh failing/i);
});

// `(e as Error).message` is a promise the compiler cannot keep: a rejection that is not an
// Error yields `undefined`, which is FALSY — so the failure line disappeared entirely and the
// frame showed the last good table with nothing to say the refresh had stopped working. The
// silent version of the exact failure this loop exists to make loud.
test('a collector that rejects with something that is not an Error still says so', async () => {
  let calls = 0;
  const { out, run } = drive(async () => {
    if (++calls > 1) throw 'claude exploded';
    return fleet();
  });
  await run;
  assert.match(out[2], /refresh failing/i);
  assert.match(out[2], /claude exploded/);
  assert.equal(/undefined/.test(out[2]), false);
});

// A terminal redraws while it waits, so the age on screen is never more than a second out of
// date. Without it the frame was written only after `collect()` returned, and a collector that
// hung — up to its own 15s timeout — left a table dated "0s ago" sitting there looking fresh
// for twenty seconds, while the page in the same situation kept counting every second.
test('on a terminal the age is redrawn while it waits, not only when a read lands', async () => {
  const out: string[] = [];
  const ctl = new AbortController();
  let clock = 0;
  await runWatch({
    collect: async () => ({ rows: [row()], health: health() }),
    write: (s) => {
      out.push(s);
      if (out.length >= 7) ctl.abort();
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    everyMs: 5000,
    isTTY: true,
    signal: ctl.signal,
  });
  const ages = out.map((f) => f.match(/updated (\d+)s ago/)?.[1]);
  assert.deepEqual(ages.slice(0, 6), ['0', '1', '2', '3', '4', '5'], 'one redraw per second, ageing');
});

test('a piped watch still writes one frame per read, not one per second', async () => {
  let calls = 0;
  const { out, run } = drive(async () => {
    calls++;
    return fleet();
  });
  await run;
  assert.equal(out.length, 3);
  assert.equal(calls, 3, 'three reads, three frames — no per-second noise down a pipe');
});

test('the screen is cleared on a terminal, and never when the output is piped', async () => {
  const piped = drive(async () => fleet(), 1, false);
  await piped.run;
  assert.equal(piped.out[0].includes('\x1b['), false);

  const tty = drive(async () => fleet(), 1, true);
  await tty.run;
  assert.match(tty.out[0], /^\x1b\[/);
});
