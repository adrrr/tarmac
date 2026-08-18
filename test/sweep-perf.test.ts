// What a frame COSTS on an install that never pruned (#8) — counted, not timed (#65).
//
// The amortized sweep is cheap on average and that average was never the problem: the ONE
// frame that sweeps pays for the whole backlog at once, and on a directory carrying the
// snapshots of every session since the day tarmac was installed that is a directory walk
// plus ten thousand unlinks, in the render path, before the status line is printed. Measured
// at 0.5 s in #8, and at 0.6-0.9 s by the harness below. The line still renders and the exit
// code is still 0 — RULE 1 is intact — so nothing in the suite could see it: every other test
// here asks what the sweep does, none asked what the frame COSTS.
//
// So this file builds the stock the issue describes, draws real frames through the real
// generated script, and counts the filesystem work each of them charged to ITSELF.
//
// Milliseconds were the first way of asking that question and the wrong one: 150 ms of budget
// against a 13 ms frame is six times the margin on the machine the number was chosen on, and a
// coin toss on a shared runner — where it landed, red, on a test-only diff that could not reach
// this file (#65). The work does not move with the machine. A frame that walked no directory
// and unlinked nothing did not pay for the backlog, on any hardware, under any load.
//
// Two shims on the PATH do the counting — `find` and `rm`, the only two that can do work
// proportional to the backlog (the `touch` that refreshes the marker is O(1) on one path)
// — and the sweep's `find` is HELD at the shim, before it has looked at anything, until
// the frames are over. The pin is what makes the count exact instead of a race against a child
// that is already deleting: what the log holds when the last frame returns is what the frames
// did, and nothing else. Same licence as `sweep-detached.test.ts` and for the same reason —
// the wrapper calls both utilities unqualified, by design, so the PATH is part of its contract
// with the machine — and the shims delegate to the real ones, so what is deleted is still
// decided by the real expression.
//
// What no longer has an assertion behind it, deliberately: a frame slow for a reason that is
// not the filesystem — a `sleep`, a `node` boot, a shell construct that scales with nothing —
// which is now `sweep-detached.test.ts`'s 400 ms frame against its 1 s stubbed sweep, two
// orders of magnitude apart and on a handful of files. The frame times are still measured and
// still printed here; nothing gates on them.

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

/** Frames per run: one sweeping frame, then the ordinary ones that follow it. */
const FRAMES = 12;

/**
 * How long a pinned sweep waits to be released before running anyway, in ticks of `PIN_TICK_S`.
 * NOT a budget: nothing is asserted about it, and a healthy frame releases the pin some
 * milliseconds after reaching it. It is the deadlock breaker for the one regression this file
 * exists for — with the sweep back inside the frame, the frame is what the pin is waiting on,
 * and a pin with no way out would hang the runner instead of printing what went wrong.
 */
const PIN_TICKS = 200;
// Fractional sleep is not POSIX (the standard only promises whole seconds), but it is real on
// every shell in the CI matrix — and on a strict integer `sleep`, `sleep 0.1` returning at
// once would spin the pin through its 200 ticks in microseconds and fail racy and unreadable.
const PIN_TICK_S = 0.1;

const SID = 'ea6a607c-42e0-4773-af4d-ae5f5938d819';
const MIN = 60_000;

const payload = JSON.stringify({
  session_id: SID,
  model: { id: 'claude-fable-5', display_name: 'Fable 5' },
  context_window: { used_percentage: 26 },
});

/** The real utilities, resolved before the shims shadow them — a shim cannot ask for itself. */
const realPath = (name: string): string =>
  execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();

/** Everything the frames charged to themselves, read off the shims' log. */
interface Work {
  /** `find` invocations on the marker alone: the amortization check, one entry, one per frame. */
  markers: number;
  /** `find` invocations carrying the sweep's expression: the walk of the whole directory. */
  walks: number;
  /** Paths handed to `rm`, flags excluded. */
  unlinked: number;
  /** The sweep reached the pin — it is holding, and can no longer add to the count. */
  pinned: boolean;
  /** …and stopped holding on its own, which only happens when the frame is what it waits for. */
  ranUnreleased: boolean;
}

interface Rig {
  root: string;
  dir: string;
  wrapper: string;
  env: NodeJS.ProcessEnv;
  /** Backdates the marker so that the very next frame is the one that sweeps. */
  arm: () => void;
  /** Drops what the warm-up frames logged: they drew before the sweep was armed. */
  forget: () => void;
  /** Lets the pinned sweep go, now that the frames it must not have delayed are over. */
  release: () => void;
  work: () => Work;
}

function shim(bin: string, name: string, source: string): void {
  const file = path.join(bin, name);
  fs.writeFileSync(file, source);
  fs.chmodSync(file, 0o755);
}

/**
 * `STOCK` snapshots, `COLD` of them beyond the TTL, and a marker stamped just now — so the
 * warm-up frames draw an ordinary frame and the sweep is armed, by `arm`, only once the count
 * is about to start. Ids are derived from a counter rather than drawn at random: two colliding
 * names would quietly shrink the stock this test claims to sweep.
 */
function rig(): Rig {
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
  const marker = path.join(dir, PRUNE_MARKER);
  fs.writeFileSync(marker, '');

  const log = path.join(root, 'work.log');
  const release = path.join(root, 'release');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);

  // `-prune` appears only in the sweep's expression; the marker's `find` is handed one file and
  // stays exactly as cheap as it is in production. The pin also lets go when the log is gone:
  // the sandbox has been torn down, nothing is counting any more, and a held sweep left behind
  // by a FAILING run has no reason to outlive it by the deadline.
  const realFind = realPath('find');
  shim(
    bin,
    'find',
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = -prune ]; then
    printf 'pinned\\n' >> ${JSON.stringify(log)}
    ticks=0
    while [ ! -e ${JSON.stringify(release)} ]; do
      [ -e ${JSON.stringify(log)} ] || exit 0
      ticks=$((ticks + 1))
      if [ "$ticks" -gt ${PIN_TICKS} ]; then printf 'ran-unreleased\\n' >> ${JSON.stringify(log)}; break; fi
      sleep ${PIN_TICK_S}
    done
    printf 'walk\\n' >> ${JSON.stringify(log)}
    exec ${realFind} "$@"
  fi
done
printf 'marker\\n' >> ${JSON.stringify(log)}
exec ${realFind} "$@"
`,
  );

  // The sweep's `rm` comes from `-exec rm -f {} +`, so one invocation carries a whole batch of
  // paths: the count is the paths, not the invocations.
  shim(
    bin,
    'rm',
    `#!/bin/sh
n=0
for arg in "$@"; do
  case "$arg" in -*) ;; *) n=$((n + 1)) ;; esac
done
printf 'rm %s\\n' "$n" >> ${JSON.stringify(log)}
exec ${realPath('rm')} "$@"
`,
  );

  const wrapper = path.join(root, 'statusline.sh');
  fs.writeFileSync(wrapper, renderWrapper({ snapshotDir: dir, chainCommand: 'echo CHAINED' }));
  fs.chmodSync(wrapper, 0o755);

  const lines = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

  return {
    root,
    dir,
    wrapper,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    arm: () => {
      const due = new Date(Date.now() - (PRUNE_EVERY_MIN + 60) * MIN);
      fs.utimesSync(marker, due, due);
    },
    forget: () => fs.writeFileSync(log, ''),
    release: () => fs.writeFileSync(release, ''),
    work: () => {
      const l = lines();
      return {
        markers: l.filter((line) => line === 'marker').length,
        walks: l.filter((line) => line === 'walk').length,
        unlinked: l.reduce((n, line) => (line.startsWith('rm ') ? n + Number(line.slice(3)) : n), 0),
        pinned: l.includes('pinned'),
        ranUnreleased: l.includes('ran-unreleased'),
      };
    },
  };
}

const coldLeft = (dir: string): number =>
  fs.readdirSync(dir).filter((n) => n.endsWith('.json') && Number.parseInt(n.slice(24, 36), 16) < COLD).length;

test(`no frame pays for the backlog with ${STOCK} snapshots to sweep`, async (t) => {
  const r = rig();
  // 20 000 files is a new order of magnitude for this suite, and the runner that keeps them
  // is the runner that has to stay quick for everything else — including the timing tests in
  // `sweep-detached.test.ts`, which node runs concurrently with this file.
  t.after(() => fs.rmSync(r.root, { recursive: true, force: true }));
  const draw = (): string => execFileSync(r.wrapper, { input: payload, encoding: 'utf8', env: r.env });

  warmUpFrames(draw);
  r.forget();
  r.arm();

  const frames: number[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const started = process.hrtime.bigint();
    const out = draw();
    frames.push(Number(process.hrtime.bigint() - started) / 1e6);
    // RULE 1 holds on every one of them, sweeping or not: the display is the point.
    assert.match(out, /CHAINED/, `frame ${i} rendered nothing`);
  }

  // Frame times print BEFORE the barrier below: the two failure modes that trip there would
  // otherwise die without a number on the record.
  t.diagnostic(`stock ${STOCK} (${COLD} cold) — frames in ms: ${frames.map((f) => f.toFixed(0)).join(' ')} (measured, asserted by nothing)`);

  // The sweep announces itself from the CHILD, so it is waited for and never read on the line
  // after the frame — that read is a race between a fork and a `printf`, and it loses about one
  // run in fifteen on a loaded machine. Once the announcement is in, the count is settled:
  // the sweep is holding at the pin, and a held sweep cannot add to it.
  await waitFor(() => r.work().pinned, 'the sweep to announce that it started (the shim recognises it by -prune)');
  const charged = r.work();

  t.diagnostic(`charged to the ${FRAMES} frames: ${charged.markers} marker checks, ${charged.walks} walks, ${charged.unlinked} unlinks`);

  // The pin is released by the line below the assertions; a sweep that gave up waiting for it
  // waited on the frame instead, which is the regression itself, said from the other end.
  const stuck = charged.ranUnreleased
    ? ` The sweep was never released: it held for ${(PIN_TICKS * PIN_TICK_S).toFixed(0)}s and ran anyway, which is what happens when the frame is the thing it is waiting for.`
    : '';
  assert.equal(
    charged.walks,
    0,
    `a frame walked the backlog: ${charged.walks} walk(s) of the ${STOCK}-snapshot directory charged to ${FRAMES} frames.${stuck}`,
  );
  assert.equal(
    charged.unlinked,
    0,
    `a frame paid for the backlog: ${charged.unlinked} path(s) unlinked by the frames before they returned.${stuck}`,
  );
  // …and none of the two above is worth anything if the frames never reached the prune block:
  // a wrapper that stopped pruning charges nothing to anybody. Every frame runs the check, and
  // the check is ONE entry — the marker — whatever the other 20 000 are doing.
  assert.equal(
    charged.markers,
    FRAMES,
    `${charged.markers} amortization checks for ${FRAMES} frames: the prune block is not running the way this test believes`,
  );

  // The work is not gone, it is on the other side of the fork — and it is all still to do.
  r.release();
  await waitFor(() => coldLeft(r.dir) === 0, `the ${COLD} cold snapshots to be swept`, 60_000);
  const swept = r.work();
  assert.equal(swept.walks, 1, `the hour's one walk, once the frames are over: ${swept.walks}`);
  assert.equal(swept.unlinked, COLD, `the sweep unlinked ${swept.unlinked} of the ${COLD} cold snapshots`);
  assert.equal(fs.readdirSync(r.dir).length, STOCK - COLD + 2, 'the live snapshots, this frame’s own, and the marker');
});
