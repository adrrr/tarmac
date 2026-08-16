// What a frame costs on an install that never pruned (#8).
//
// The amortized sweep is cheap on average and that average was never the problem: the ONE
// frame that sweeps pays for the whole backlog at once, and on a directory carrying the
// snapshots of every session since the day tarmac was installed that is a directory walk
// plus ten thousand unlinks, in the render path, before the status line is printed. Measured
// at 0.5 s in #8, and at 0.6-0.9 s by the harness below. The line still renders and the exit code is still 0 — RULE 1 is
// intact — so nothing in the suite could see it: every other test here asks what the sweep
// does, none asked what the frame COSTS.
//
// So this file builds the stock the issue describes and times real frames through the real
// generated script. The budget is what a frame may cost when a sweep is due, and it is an
// order of magnitude below what a user can perceive: the sweep does not get to be the reason
// a TUI stutters, whatever it finds to do.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PRUNE_EVERY_MIN, PRUNE_MARKER, renderWrapper, SNAPSHOT_TTL_MIN } from '../src/wrapper.ts';
import { waitFor, warmUpFrames } from './sweep.ts';

/** The issue's number: an install that has been running for months and never pruned. */
const STOCK = 20_000;
/** Half of it cold — sessions that stopped rendering days ago and have to go. */
const COLD = STOCK / 2;

/**
 * The most a frame may cost when a sweep is due. Not a measurement of the fix — a fixed
 * budget, chosen ahead of it: ~150 ms is the threshold under which an interface is felt as
 * responsive rather than as lagging, and it leaves room for a loaded CI runner while still
 * being a third of what a single blocking sweep measured. A frame that stays inside it
 * cannot be the frame that pays for the backlog. Eleven of twelve frames must stay inside
 * it; the twelfth has its own ceiling below.
 */
const BUDGET_MS = 150;

/**
 * The floor of what a BLOCKING sweep costs on this stock (0.6-0.9 s measured, #8): a frame
 * at half that has paid for the backlog, not caught a stall. No frame may reach it, ever,
 * on any machine.
 */
const SWEEP_PAID_MS = 500;

/** Frames per run: one sweeping frame, then the ordinary ones that follow it. */
const FRAMES = 12;

const SID = 'ea6a607c-42e0-4773-af4d-ae5f5938d819';
const MIN = 60_000;

const payload = JSON.stringify({
  session_id: SID,
  model: { id: 'claude-fable-5', display_name: 'Fable 5' },
  context_window: { used_percentage: 26 },
});

/**
 * `STOCK` snapshots, `COLD` of them beyond the TTL, and a marker stamped just now — so the
 * warm-up frames below draw an ordinary frame and the sweep is armed, by `armSweep`, only
 * once the clock is about to start. Ids are derived from a counter rather than drawn at
 * random: two colliding names would quietly shrink the stock this test claims to measure.
 */
function stockedDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-perf-'));
  const dir = path.join(root, 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  const cold = new Date(Date.now() - (SNAPSHOT_TTL_MIN + 24 * 60) * MIN);
  for (let i = 0; i < STOCK; i++) {
    const tail = i.toString(16).padStart(12, '0');
    const file = path.join(dir, `aaaaaaaa-bbbb-cccc-dddd-${tail}.json`);
    fs.writeFileSync(file, '{}');
    if (i < COLD) fs.utimesSync(file, cold, cold);
  }
  fs.writeFileSync(path.join(dir, PRUNE_MARKER), '');
  return dir;
}

/** Backdates the marker so that the very next frame is the one that sweeps. */
function armSweep(dir: string): void {
  const due = new Date(Date.now() - (PRUNE_EVERY_MIN + 60) * MIN);
  fs.utimesSync(path.join(dir, PRUNE_MARKER), due, due);
}

/** Writes the wrapper next to its snapshot dir and returns its path. */
function wrapperFor(dir: string): string {
  const file = path.join(path.dirname(dir), 'statusline.sh');
  fs.writeFileSync(file, renderWrapper({ snapshotDir: dir, chainCommand: 'echo CHAINED' }));
  fs.chmodSync(file, 0o755);
  return file;
}

const percentile = (sorted: number[], p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];

const coldLeft = (dir: string): number =>
  fs.readdirSync(dir).filter((n) => n.endsWith('.json') && Number.parseInt(n.slice(24, 36), 16) < COLD).length;

test(`no frame pays for the backlog with ${STOCK} snapshots to sweep`, async (t) => {
  const dir = stockedDir();
  // 20 000 files is a new order of magnitude for this suite, and the runner that keeps them
  // is the runner that has to stay quick for everything else — including the timing tests in
  // `sweep-detached.test.ts`, which node runs concurrently with this file.
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const wrapper = wrapperFor(dir);
  const draw = (): string => execFileSync(wrapper, { input: payload, encoding: 'utf8' });

  warmUpFrames(draw);
  armSweep(dir);

  const frames: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const started = process.hrtime.bigint();
    const out = draw();
    frames.push(Number(process.hrtime.bigint() - started) / 1e6);
    // RULE 1 holds on every one of them, sweeping or not: the display is the point.
    assert.match(out, /CHAINED/, `frame ${i} rendered nothing`);
  }

  const sorted = [...frames].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const allButOne = sorted[FRAMES - 2];
  const worst = sorted[FRAMES - 1];
  t.diagnostic(`stock ${STOCK} (${COLD} cold) — frame p50 ${p50.toFixed(1)}ms · worst ${worst.toFixed(1)}ms · first ${frames[0].toFixed(1)}ms`);
  t.diagnostic(`frames: ${frames.map((f) => f.toFixed(0)).join(' ')}`);

  // Two ceilings, because two different things can go wrong (#21 carries the field data).
  // A frame that paid for the BACKLOG — the sweep back inline, the regression #8 forbids —
  // costs what a blocking sweep costs: 0.6-0.9 s. Half of that is the line no frame may
  // cross, on any machine. Separately, ONE frame may catch a bounded stall that is not the
  // sweep's price: a cold frame on this stock measures 270-400 ms with the sweep never
  // armed, and a mid-run frame on a real terminal stalled at ~340 ms while the 10 000
  // unlinks ran beside it — isolated, bounded, and indistinguishable from a machine hiccup.
  // The budget still binds every other frame: a SECOND slow frame is a regime, not a stall.
  assert.ok(
    worst < SWEEP_PAID_MS,
    `a frame paid for the backlog: worst ${worst.toFixed(1)}ms is blocking-sweep territory (>=${SWEEP_PAID_MS}ms) ` +
      `(p50 ${p50.toFixed(1)}ms, first frame ${frames[0].toFixed(1)}ms, ${STOCK} snapshots, ${COLD} of them cold)`,
  );
  assert.ok(
    allButOne <= BUDGET_MS,
    `more than one frame over budget: ${sorted.filter((f) => f > BUDGET_MS).length} of ${FRAMES} over ${BUDGET_MS}ms ` +
      `(frames ${frames.map((f) => f.toFixed(0)).join(' ')})`,
  );

  // …and the budget above is only worth something if the work still gets done. A sweep that
  // never ran is the cheapest frame there is, and would pass every assertion before this one.
  await waitFor(() => coldLeft(dir) === 0, `the ${COLD} cold snapshots to be swept`, 60_000);
  assert.equal(fs.readdirSync(dir).length, STOCK - COLD + 2, 'the live snapshots, this frame’s own, and the marker');
});
