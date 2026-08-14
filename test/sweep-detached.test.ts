// The sweep runs beside the frame, not inside it (#8) — asked of the real generated script,
// with the cost of the sweep made visible instead of guessed.
//
// `test/sweep-perf.test.ts` measures the frame against a real 20 000-file stock, which is
// the honest end-to-end number and, for the same reason, a number that moves with whatever
// machine runs it. These tests pin the PROPERTY rather than the duration: a `find` on the
// PATH that takes a full second to answer turns "the frame does not wait for the sweep" into
// something a clock can settle on any machine, and turns "one sweep per hour, not one per
// frame" into a count that a second frame can contradict WHILE the first sweep is in flight —
// the concurrency case a fast sweep can never build.
//
// Stubbing `find` is legitimate here and nowhere else in this suite: the wrapper calls it
// unqualified, by design, so the PATH is part of its contract with the machine. The stub
// delegates to the real one, so what is deleted is still decided by the real expression.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PRUNE_EVERY_MIN, PRUNE_MARKER, renderWrapper, SNAPSHOT_TTL_MIN } from '../src/wrapper.ts';
import { waitFor, warmUpFrames } from './sweep.ts';

const SID = 'ea6a607c-42e0-4773-af4d-ae5f5938d819';
const DEAD = 'ffffffff-1111-2222-3333-444444444444';
const MIN = 60_000;
/** How long the stubbed sweep takes to answer. Long enough that a frame waiting on it is unmistakable. */
const SWEEP_MS = 1_000;
/** …and the most a frame may take while that is going on. Two orders of magnitude below it. */
const FRAME_BUDGET_MS = 400;

const payload = JSON.stringify({
  session_id: SID,
  model: { id: 'claude-fable-5', display_name: 'Fable 5' },
  context_window: { used_percentage: 26 },
});

/** The real `find`, resolved before the stub shadows it — the stub cannot ask for itself. */
const REAL_FIND = execFileSync('/bin/sh', ['-c', 'command -v find'], { encoding: 'utf8' }).trim();

interface Rig {
  snapDir: string;
  wrapper: string;
  env: NodeJS.ProcessEnv;
  /** Backdates the marker, so that the next frame is the one that sweeps. */
  arm: () => void;
  /** One line per sweep actually started, in order. */
  sweeps: () => string[];
}

/**
 * A snapshot dir holding one cold snapshot and a marker old enough to be due, plus a `find`
 * on the PATH that is slow, noisy and honest: it records the sweep, prints on both streams
 * BEFORE sleeping — a sweep that inherited the frame's stdout would put that straight into
 * the status line — and then runs the real `find` with the real arguments.
 */
function rig(): Rig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-detach-'));
  const snapDir = path.join(root, 'snapshots');
  fs.mkdirSync(snapDir, { recursive: true });

  const dead = path.join(snapDir, `${DEAD}.json`);
  fs.writeFileSync(dead, '{}');
  const cold = new Date(Date.now() - (SNAPSHOT_TTL_MIN + 60) * MIN);
  fs.utimesSync(dead, cold, cold);

  const marker = path.join(snapDir, PRUNE_MARKER);
  fs.writeFileSync(marker, '');

  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(root, 'sweeps.log');
  // `-prune` appears only in the sweep's expression; the marker's `find` is one file and
  // stays exactly as fast as it is in production.
  fs.writeFileSync(
    path.join(bin, 'find'),
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = -prune ]; then
    printf 'sweep\\n' >> ${JSON.stringify(log)}
    printf 'SWEEP-NOISE\\n'
    printf 'SWEEP-NOISE\\n' >&2
    sleep ${SWEEP_MS / 1000}
    exec ${REAL_FIND} "$@"
  fi
done
exec ${REAL_FIND} "$@"
`,
  );
  fs.chmodSync(path.join(bin, 'find'), 0o755);

  const wrapper = path.join(root, 'statusline.sh');
  fs.writeFileSync(wrapper, renderWrapper({ snapshotDir: snapDir, chainCommand: 'echo CHAINED' }));
  fs.chmodSync(wrapper, 0o755);

  return {
    snapDir,
    wrapper,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    arm: () => {
      const due = new Date(Date.now() - (PRUNE_EVERY_MIN + 60) * MIN);
      fs.utimesSync(marker, due, due);
    },
    sweeps: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
  };
}

/** One frame. Returns what the status line printed and what it cost. */
function frame(r: Rig): { out: string; ms: number } {
  const started = process.hrtime.bigint();
  const out = execFileSync(r.wrapper, { input: payload, encoding: 'utf8', env: r.env });
  return { out, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

test('the frame does not wait for the sweep, and the sweep finishes anyway', async () => {
  const r = rig();
  const dead = path.join(r.snapDir, `${DEAD}.json`);
  warmUpFrames(() => frame(r));
  r.arm();

  const { out, ms } = frame(r);

  assert.equal(r.sweeps().length, 1, 'sanity: this frame was a sweeping one');
  assert.ok(ms < FRAME_BUDGET_MS, `the frame waited for the sweep: ${ms.toFixed(0)}ms of a ${SWEEP_MS}ms sweep`);
  assert.match(out, /CHAINED/, 'the display rendered');
  assert.equal(fs.existsSync(dead), true, 'sanity: the sweep is still running, so nothing is gone yet');

  await waitFor(() => !fs.existsSync(dead), 'the detached sweep to remove the cold snapshot');
  assert.equal(fs.existsSync(path.join(r.snapDir, `${SID}.json`)), true, "and this frame's own snapshot survived it");
});

// A detached child that keeps the frame's stdout is the same bug wearing a different hat:
// the frame returns on time, and whatever the sweep prints lands in the status line — or
// holds the pipe open long after the shell exited, which is the wait above by another route.
test('nothing the sweep prints reaches the status line', () => {
  const r = rig();
  warmUpFrames(() => frame(r));
  r.arm();

  const { out } = frame(r);
  assert.equal(r.sweeps().length, 1, 'sanity: this frame was a sweeping one');
  assert.doesNotMatch(out, /SWEEP-NOISE/, 'the sweep printed into the display');
  assert.equal(out.trim(), 'CHAINED', 'the status line is exactly what the chain printed');
});

// Amortization has to survive detachment, and this is where it could quietly stop: the
// marker is stamped by the FRAME, before the fork, so a second frame arriving while the
// first sweep is still walking the directory sees a fresh marker and starts nothing. Stamp
// it inside the child instead and every frame drawn during a slow sweep starts another one.
test('a frame drawn while a sweep is in flight does not start a second one', async () => {
  const r = rig();
  warmUpFrames(() => frame(r));
  r.arm();

  const first = frame(r);
  const second = frame(r);
  const third = frame(r);

  assert.ok(
    Math.max(second.ms, third.ms) < FRAME_BUDGET_MS,
    'the frames that followed the sweeping one were not slowed either',
  );
  assert.equal(r.sweeps().length, 1, 'three frames, one sweep');

  await waitFor(() => !fs.existsSync(path.join(r.snapDir, `${DEAD}.json`)), 'the one sweep to finish its work');
  assert.match(first.out, /CHAINED/);
});

// The marker is what the next hour is measured from, and it is written before the sweep so
// that a sweep that cannot finish is not retried on the very next frame. Detaching moves the
// work, not the bookkeeping.
test('the marker is restamped by the frame, not by the sweep it started', () => {
  const r = rig();
  warmUpFrames(() => frame(r));
  r.arm();
  const marker = path.join(r.snapDir, PRUNE_MARKER);
  const before = fs.statSync(marker).mtimeMs;

  frame(r);

  assert.ok(fs.statSync(marker).mtimeMs > before, 'the frame dated the sweep before returning');
  assert.equal(r.sweeps().length, 1);
});
