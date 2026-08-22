// The sweep runs beside the frame, not inside it (#8) — asked of the real generated script,
// with the cost of the sweep made visible instead of guessed.
//
// `test/sweep-perf.test.ts` puts a real 20 000-file backlog behind the frame and counts what
// the frame charged to itself; it still prints the end-to-end milliseconds, which are honest
// and move with whatever machine runs it, and asserts nothing about them (#65). These tests
// ask the same property from the other side, on a handful of files, and they take the same
// instrument to it: the sweep's `find` is HELD at the stub, before it has looked at anything,
// until the frames it must not have delayed are over.
//
// That is what replaced a duration. A frame budget of 400 ms against a 1 s stubbed sweep read
// as two orders of magnitude and was neither: it was a guess about how fast a machine is, and
// it went red at 466 ms on a loaded one, against a wrapper byte-identical to main — the #73
// shape, in the suite whose subject is bounded waits (#94). The pin asks the same question
// with no clock in it: the frame either returned while its sweep was still held, or it did
// not. A clock survives only in the pin's own way out (PIN_TICKS), so a frame slower than that
// give-up still reddens on a healthy wrapper — but the bar moved from 400 ms to tens of
// seconds, which is the whole of the fix.
//
// The pin also builds the concurrency case a fast sweep never could: "one sweep per hour, not
// one per frame" becomes a count contradicted by a second frame drawn WHILE the first sweep is
// provably in flight, rather than while it is presumed to be — and under a sweep put back
// inside the frame, that presumption is exactly what used to evaporate in silence.
//
// Stubbing `find` is legitimate here and in `sweep-perf.test.ts`, and nowhere else in this
// suite: the wrapper calls it unqualified, by design, so the PATH is part of its contract with
// the machine. The pinned stubs delegate to the real one, so what is deleted is still decided
// by the real expression; the refusing ones (#6) stand in for the two states no permission bit
// can build — a `touch` that cannot stamp, a `find` with no `-mmin` to answer — and there the
// point is that NOTHING is decided: no sweep starts, nothing reaches stderr.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { PRUNE_EVERY_MIN, PRUNE_MARKER, renderWrapper, SNAPSHOT_TTL_MIN } from '../src/wrapper.ts';
import { NET_DEADLINE_MS } from './bounded.ts';
import { settle, waitFor } from './sweep.ts';
import { tempDir } from './sandbox.ts';

const SID = 'ea6a607c-42e0-4773-af4d-ae5f5938d819';
const DEAD = 'ffffffff-1111-2222-3333-444444444444';
const MIN = 60_000;

// Fractional sleep is not POSIX (the standard only promises whole seconds), but it is real on
// every shell in the CI matrix — and on a strict integer `sleep`, `sleep 0.1` returning at once
// would spin the pin through its ticks in microseconds and fail racy and unreadable.
const PIN_TICK_S = 0.1;
/**
 * How long a pinned sweep waits to be released before running anyway, in ticks of
 * {@link PIN_TICK_S}.
 *
 * NOT a budget: nothing is asserted about it, and a healthy frame releases the pin some
 * milliseconds after reaching it. It is the deadlock breaker for the one regression this file
 * exists for — with the sweep back INSIDE the frame, the frame is what the pin is waiting on,
 * and a pin with no way out would hang the runner instead of printing what went wrong.
 *
 * Derived rather than typed, and that is the point of #94: the bound in reach that nobody
 * guessed is the runner's own timeout (#84). With the sweep back inside the frame, the frame is
 * a synchronous `spawnSync` that freezes the event loop, so the runner's per-test timer cannot
 * fire until the frame returns — the pin's give-up is what makes it return, so the pin, not the
 * runner, is what turns the hang into a printed failure. It has to land well under that timeout
 * to do it.
 *
 * A QUARTER of the runner's timeout, nominally — half of NET_DEADLINE_MS, which is itself half
 * the timeout — because a `sleep` per tick is not a clock: the loop pays a fork it does not
 * count and overshoots ~1.5× (300 ticks of `sleep 0.1`, nominal 30 s, measured ~47 s idle).
 * The margin is the room that overshoot is allowed to be wrong in, and ~47 s of a 120 s timeout
 * holds even on the loaded machine this whole file exists for.
 */
const PIN_TICKS = Math.max(1, Math.ceil(NET_DEADLINE_MS / 2 / (PIN_TICK_S * 1_000)));

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
  /** One line per sweep that got PAST the pin — empty for as long as every sweep is held. */
  walks: () => string[];
  /** A sweep stopped holding on its own, which only happens when the frame is what it waits for. */
  ranUnreleased: () => boolean;
  /** Lets the pinned sweeps go, now that the frames they must not have delayed are over. */
  release: () => void;
}

/**
 * A snapshot dir holding one cold snapshot and a marker old enough to be due, plus a `find`
 * on the PATH that is pinned, noisy and honest: it records the sweep, prints on both streams
 * BEFORE the pin — a sweep that inherited the frame's stdout would put that straight into
 * the status line — holds there until the test lets it go, and then runs the real `find` with
 * the real arguments.
 *
 * `stubs` puts more utilities on that same PATH, `find` included if a test wants a different
 * one: the two below need a `touch` that refuses and a `find` that cannot answer `-mmin`,
 * which are the two ways the machine can decline this block without denying anything a
 * permission bit could express.
 */
function rig(stubs: Record<string, string> = {}): Rig {
  const root = tempDir('tarmac-detach-');
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
  const released = path.join(root, 'release');
  // `-prune` appears only in the sweep's expression; the marker's `find` is one file and
  // stays exactly as fast as it is in production. The pin also lets go when the log is gone:
  // the sandbox has been torn down, nothing is watching any more, and a held sweep left behind
  // by a FAILING run has no reason to outlive it.
  fs.writeFileSync(
    path.join(bin, 'find'),
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = -prune ]; then
    printf 'sweep\\n' >> ${JSON.stringify(log)}
    printf 'SWEEP-NOISE\\n'
    printf 'SWEEP-NOISE\\n' >&2
    ticks=0
    while [ ! -e ${JSON.stringify(released)} ]; do
      [ -e ${JSON.stringify(log)} ] || exit 0
      ticks=$((ticks + 1))
      if [ "$ticks" -gt ${PIN_TICKS} ]; then printf 'ran-unreleased\\n' >> ${JSON.stringify(log)}; break; fi
      sleep ${PIN_TICK_S}
    done
    printf 'walk\\n' >> ${JSON.stringify(log)}
    exec ${REAL_FIND} "$@"
  fi
done
exec ${REAL_FIND} "$@"
`,
  );
  fs.chmodSync(path.join(bin, 'find'), 0o755);

  for (const [name, source] of Object.entries(stubs)) {
    fs.writeFileSync(path.join(bin, name), source);
    fs.chmodSync(path.join(bin, name), 0o755);
  }

  const wrapper = path.join(root, 'statusline.sh');
  fs.writeFileSync(wrapper, renderWrapper({ snapshotDir: snapDir, chainCommand: 'echo CHAINED' }));
  fs.chmodSync(wrapper, 0o755);

  const lines = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

  return {
    snapDir,
    wrapper,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    arm: () => {
      const due = new Date(Date.now() - (PRUNE_EVERY_MIN + 60) * MIN);
      fs.utimesSync(marker, due, due);
    },
    sweeps: () => lines().filter((line) => line === 'sweep'),
    walks: () => lines().filter((line) => line === 'walk'),
    ranUnreleased: () => lines().includes('ran-unreleased'),
    release: () => fs.writeFileSync(released, ''),
  };
}

/**
 * Why a sweep is no longer pinned, said at the assertion that rested on the pin: either a test
 * released it, or it gave up waiting — and the only thing it ever waits on is the frame.
 */
const stuck = (r: Rig): string =>
  r.ranUnreleased()
    ? ' The sweep hit its give-up before any release: the frame held it (the regression this file exists for), or was itself slower than the pin — either way the frame did not return while the sweep was pinned.'
    : '';

/**
 * The sweep log is written by the CHILD, so it is waited for and never read on the line after
 * the frame — that read is a race between a fork and a `printf`, and it loses about one run
 * in fifteen on a loaded machine.
 *
 * A barrier and nothing more: it asks that a sweep has started, never that exactly one has.
 * The count belongs to the test that asserts it. Held at `=== 1`, this barrier swallowed that
 * test instead — a wrapper that started three sweeps never satisfied the predicate, so the
 * count below was never reached and the report was a timeout waiting for a sweep that had in
 * fact started three times over.
 */
const sweepStarted = (r: Rig): Promise<void> => waitFor(() => r.sweeps().length > 0, 'the sweep to record that it started');

/** One frame. Returns what the status line printed and what it leaked. */
function frame(r: Rig): { out: string; err: string } {
  const run = spawnSync(r.wrapper, { input: payload, encoding: 'utf8', env: r.env });
  assert.equal(run.error, undefined, 'the frame ran');
  assert.equal(run.status, 0, 'RULE 1: the status line always exits 0');
  return { out: run.stdout, err: run.stderr };
}

test('the frame does not wait for the sweep, and the sweep finishes anyway', async () => {
  const r = rig();
  const dead = path.join(r.snapDir, `${DEAD}.json`);
  r.arm();

  const { out } = frame(r);

  assert.match(out, /CHAINED/, 'the display rendered');
  await sweepStarted(r);
  // The property, with no clock in it: the frame was over while its sweep was still pinned,
  // before that sweep had looked at anything. `walks` only ever grows, so empty HERE is empty
  // at the moment the frame returned — which is the whole assertion, on any machine, at any
  // load. Nothing else in this file has to be fast for it to hold.
  assert.deepEqual(r.walks(), [], `the frame waited for the sweep it started.${stuck(r)}`);

  r.release();
  await waitFor(() => !fs.existsSync(dead), 'the detached sweep to remove the cold snapshot');
  assert.equal(fs.existsSync(path.join(r.snapDir, `${SID}.json`)), true, "and this frame's own snapshot survived it");
});

// A detached child that keeps the frame's stdout is the same bug wearing a different hat:
// the frame returns on time, and whatever the sweep prints lands in the status line — or
// holds the pipe open long after the shell exited, which is the wait above by another route.
test('nothing the sweep prints reaches the status line', async () => {
  const r = rig();
  // The one test here that releases the pin BEFORE its frame — not to change its verdict but to
  // sharpen it. The noise is printed on the way to the pin either way; what a held sweep adds
  // is that one still holding the frame's stdout keeps the frame's spawn open until the
  // deadlock breaker fires — a slow red that says "waited" where an early release gets the
  // crisp one that says "printed", about the same missing redirection. The sharper message wins.
  r.release();
  r.arm();

  const { out } = frame(r);
  await sweepStarted(r);
  assert.doesNotMatch(out, /SWEEP-NOISE/, 'the sweep printed into the display');
  assert.equal(out.trim(), 'CHAINED', 'the status line is exactly what the chain printed');
});

// Amortization has to survive detachment, and this is where it could quietly stop: a frame
// drawn while the first sweep is still in flight must start nothing. That is the property
// asserted here, and it is asserted by counting sweeps, not by inspecting where the
// stamp is written — a `touch` moved to the HEAD of the child lands a millisecond after the
// fork and this test stays green; only a stamp moved to the END of it goes red here. Where
// the stamping has to live is asserted directly, and synchronously, in the test below.
test('a frame drawn while a sweep is in flight does not start a second one', async () => {
  const r = rig();
  r.arm();

  const first = frame(r);
  frame(r);
  frame(r);

  await sweepStarted(r);
  // The premise, and not an aside: all three frames were drawn while the first sweep was
  // pinned, so "in flight" is a fact here rather than a hope about the clock. Put the sweep
  // back inside the frame and this is where it shows — the first frame carries the sweep to
  // completion before the second is drawn, and the concurrency this test is named after never
  // happens at all.
  assert.deepEqual(r.walks(), [], `the sweeping frame did not return before the ones that followed it.${stuck(r)}`);

  r.release();
  // Counted only once the first sweep has finished its work: a second one, had a frame
  // started it, would have written its own line the moment it was forked — before the release
  // above — so by here the log is complete.
  await waitFor(() => !fs.existsSync(path.join(r.snapDir, `${DEAD}.json`)), 'the one sweep to finish its work');
  assert.equal(r.sweeps().length, 1, 'three frames, one sweep');
  assert.match(first.out, /CHAINED/);
});

// The marker is what the next hour is measured from, and it is written before the sweep so
// that a sweep that cannot finish is not retried on the very next frame. Detaching moves the
// work, not the bookkeeping.
test('the marker is restamped by the frame, not by the sweep it started', async () => {
  const r = rig();
  r.arm();
  const marker = path.join(r.snapDir, PRUNE_MARKER);
  const before = fs.statSync(marker).mtimeMs;

  frame(r);

  // Read while the sweep is still pinned: the stamp seen here is one no sweep could have
  // written, whatever a sweep does after this line.
  assert.ok(fs.statSync(marker).mtimeMs > before, 'the frame dated the sweep before returning');
  await sweepStarted(r);
  r.release();
});

// …and the stamp is not merely FIRST, it is the CONDITION. Swap the two and a directory whose
// marker cannot be written is swept by every frame that ever renders there — the unamortized
// walk this design exists to avoid, on the one machine that already told us it cannot take a
// note. Nothing above catches the swap: where the stamp fails because the directory is
// read-only, the `rm` the sweep would run fails too, so the files are still there either way
// and the difference is only in how much walking was done to leave them. A `touch` that
// refuses is that same refusal with the deleting left possible — and, unlike a 0555 fixture,
// it is the same fixture under root.
test('a marker it could not stamp starts no sweep at all', async () => {
  const r = rig({ touch: '#!/bin/sh\nexit 1\n' });
  r.arm();

  const { out } = frame(r);

  assert.match(out, /CHAINED/, 'the display renders');
  await settle();
  assert.deepEqual(r.sweeps(), [], 'the frame that could not date a sweep started none');
  assert.equal(fs.existsSync(path.join(r.snapDir, `${DEAD}.json`)), true, 'so the cold snapshot is still there');
});

// `-mmin` is the one thing in this block POSIX does not require, and a busybox built without
// CONFIG_FEATURE_FIND_MMIN is where it is missing: the marker's age cannot be read, the
// substitution is empty, and the sweep simply never runs. That hole is accepted — snapshots
// pile up exactly as they did before this block existed — on the condition that it is SILENT.
// A `find` that reports what it cannot do is one line of noise per FRAME on the terminal of a
// script whose first rule is to be invisible, and the `2>/dev/null` around that substitution
// is all there is between the two. Removing it broke no test until this one.
test('a find that cannot answer -mmin leaves the frame silent, and sweeps nothing', async () => {
  const r = rig({ find: '#!/bin/sh\nprintf "find: unrecognized: -mmin\\n" >&2\nexit 1\n' });
  r.arm();

  const { out, err } = frame(r);

  assert.equal(err, '', 'nothing at all reaches the user terminal');
  assert.match(out, /CHAINED/, 'and the display renders');
  await settle();
  assert.equal(fs.existsSync(path.join(r.snapDir, `${DEAD}.json`)), true, 'with no age to read, nothing is swept');
});
