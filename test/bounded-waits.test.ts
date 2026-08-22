// A test that blocks with no deadline does not fail — it HANGS, and a hang reports nothing.
//
// Twice now a mutation this suite was supposed to catch stopped the run mid-file instead of
// turning it red: a bind-host mutation left a `fetch` waiting on a socket that accepts and
// never answers, and a mutation of the `tarmac serving` marker left both serve harnesses
// waiting for a line that would never come. In both cases the test was correct and the
// failure was un-reportable — TAP simply stopped, and the runner was killed from outside.
//
// This file holds the two guards against that class: the static one, which keeps every
// network wait in the suite bounded, and the behavioural one, which proves the helper both
// serve harnesses wait on turns a missing line into a rejection carrying what did arrive.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { NET_DEADLINE_MS, netDeadlineFrom, rawGet, silentServer, waitForOutput } from './bounded.ts';
import { unboundedWaits } from './scan-waits.ts';
import { DEADLINE_UNDER_TEST_CALL, HAND_TYPED_DEFAULT_DEFINITION, RAW_CLIENT_IMPORT, SPLIT_WAIT_CALL, VERDICTS } from './scan-waits.fixtures.ts';

const testDir = path.dirname(fileURLToPath(import.meta.url));

test('no test waits on the network without a deadline', () => {
  const unbounded: string[] = [];
  for (const file of fs.readdirSync(testDir).filter((f) => f.endsWith('.ts')).sort()) {
    // The fixture module is skipped: it holds strings ABOUT offending code, never a call.
    if (file === 'scan-waits.fixtures.ts') continue;
    unbounded.push(...unboundedWaits(file, fs.readFileSync(path.join(testDir, file), 'utf8')));
  }
  assert.deepEqual(unbounded, [], 'an unbounded network wait hangs its file instead of failing it');
});

// A guard with no negative test is a guard nobody has checked: break the regex and the suite
// stays green, which is the blind spot the `rmdir` line had in #18. So the rules are also run
// against lines whose verdict is written down, in `scan-waits.fixtures.ts`.
test('the guard catches what it claims to, and nothing it does not', () => {
  const wrong = VERDICTS.filter(({ source, caught }) => unboundedWaits('watch.test.ts', source).length > 0 !== caught).map(
    ({ source, caught, why }) => `${caught ? 'MISSED' : 'FALSE POSITIVE'}: ${why} — ${source}`,
  );
  assert.deepEqual(wrong, []);
});

// The two halves of #85 read the same line, and only one of them is right about it: a helper
// whose default is a literal is a default to fix, not a call handing itself a number. Told
// twice, in two registers, the report stops saying where to go and starts needing a reading.
test('a literal default is one finding, and it is the one that names the default', () => {
  const found = unboundedWaits('watch.test.ts', HAND_TYPED_DEFAULT_DEFINITION);
  assert.equal(found.length, 1, `a definition is not also a call: ${found.join(' / ')}`);
  assert.match(found[0]!, /must default to NET_DEADLINE_MS/);
});

// The rule the comment used to be: a wait is written on one line, or its deadline is not where
// the reader is. Two things worth saying that a boolean verdict cannot — the finding points at
// the line that OPENS the call, and it holds in the file excused from picking deadlines, because
// being allowed to choose one is not being allowed to put it out of sight.
test('a wait split over several lines is reported where it opens, in every file', () => {
  const found = unboundedWaits('watch.test.ts', SPLIT_WAIT_CALL);
  assert.equal(found.length, 1, `one finding, on the line that opens the call: ${found.join(' / ')}`);
  assert.match(found[0]!, /^watch\.test\.ts:1 /);
  assert.match(found[0]!, /on one line/);
  assert.equal(unboundedWaits('bounded-waits.test.ts', SPLIT_WAIT_CALL).length, 1, 'the deadline exemption is not one from writing it where it reads');
});

test('the one home may hold the raw client the others may not', () => {
  assert.deepEqual(unboundedWaits('bounded.ts', RAW_CLIENT_IMPORT), []);
});

// The other file-deep exemption, and the narrower one: a test OF a deadline has to be able to
// hand a wait a number, or the three below could only be written with the suite's own 60s. It is
// this file and no other, which is what makes it worth asserting from both sides.
test('the file that tests the deadlines may hand a wait a number, and no other file may', () => {
  assert.deepEqual(unboundedWaits('bounded-waits.test.ts', DEADLINE_UNDER_TEST_CALL), []);
  assert.equal(unboundedWaits('watch.test.ts', DEADLINE_UNDER_TEST_CALL).length, 1, 'an offence anywhere else');
});

// ── the deadline all of them carry ────────────────────────────────────────────────────
// A deadline is what the guard above is for; a SHORT one is the other half of the same
// failure. Every wait in this suite carried a number typed next to it — 4000ms at nineteen
// `fetch` calls, on `rawGet`'s socket deadline and on a poll budget, 20s on `waitForOutput`.
// With four suites running at once both requests in `cli-config.test.ts` aborted on a server
// that was answering: a loopback request took more than four seconds because the machine was
// busy (#73). The number comes off the runner's own per-test timeout now, and THAT is what is
// worth testing — `process.execArgv` is where the runner publishes it, and it does not
// publish it in one shape.

test('the deadline is half the runner timeout in force', () => {
  assert.equal(netDeadlineFrom(['--test-timeout=120000']), 60_000, "what `npm test`'s own 120s yields");
  // Every array below is the `--test-timeout` part of a real `execArgv`, run and captured —
  // the rest of it, on node 24+ some thirty-odd entries of node dumping its own options, is
  // cut. The dump is where the `=` copy of a space-form flag comes from, and the raw pair
  // follows it. Node 22 never dumps: a spaced flag arrives spaced, alone.
  assert.equal(netDeadlineFrom(['--test-timeout=77000', '--test-timeout', '77000']), 38_500, 'the space form');
  assert.equal(netDeadlineFrom(['--test-timeout', '30000']), 15_000, 'node 22: spaced, no dump, nothing else');
  assert.equal(
    netDeadlineFrom(['--test-timeout=5000', '--test-timeout=1000', '--test-timeout=5000']),
    2500,
    'the last flag wins, as it does in node',
  );
  // `--test-isolation=none` leaves no dump, and then the space form is all there is. Read the
  // `=` form alone and this falls to the fallback — a deadline LONGER than the runner's, which
  // can no longer fire first, which is the hang the file is about wearing a green disguise.
  assert.equal(netDeadlineFrom(['--test', '--test-isolation=none', '--test-timeout', '30000']), 15_000, 'no dump');
  // The halving is where a fraction can appear, and `AbortSignal.timeout` throws on one —
  // `ERR_OUT_OF_RANGE`, from the nineteen requests but not from the two helpers, which take it.
  assert.equal(netDeadlineFrom(['--test-timeout=4001']), 2000, 'an odd timeout still yields an integer');
  // It is also where a zero can appear, and a zero is not a short deadline — it is two different
  // absences. `AbortSignal.timeout(0)` aborts every `fetch` before it is sent; `timeout: 0` on
  // `http.request` means NO timeout at all, which hands `rawGet` back the unbounded wait. One
  // millisecond is a deadline that fires, which is what the caller asked for by typing 1.
  assert.equal(netDeadlineFrom(['--test-timeout=1']), 1, 'an absurd timeout is still a timeout, never a zero');
});

test('with no runner timeout the deadline is the only net, and it is finite', () => {
  // `node --test one.test.ts` with no flag has no per-test timeout at all, and neither does
  // `--test-timeout=0` — verified: a 600ms test passes under it. Halving either into the
  // deadline would hand the suite back the unbounded wait this whole file exists to prevent.
  const bare = netDeadlineFrom([]);
  assert.ok(Number.isFinite(bare) && bare > 0, `a fallback that cannot fire is no fallback: ${bare}`);
  assert.equal(netDeadlineFrom(['--test-timeout=0']), bare, 'a zero is not a timeout to halve');
});

// Finite and positive is the weaker half of what the fallback has to be. The other half is its
// MAGNITUDE: it is taken whenever the flag cannot be read — the node 22 spaced form was exactly
// that until #84 — and a fallback longer than the timeout the runner is still holding no longer
// fires first. The wait then loses nothing and reports nothing, and the runner times out a test
// whose socket keeps the file alive: the hang this file exists for, wearing a green disguise.
// `200_000` against `npm test`'s own 120s passes every other assertion here. And `<` alone
// would admit a 119_000 that only loses the race by a second (#92): the fallback's contract
// (`bounded.ts` — « the value its own `--test-timeout=120000` yields ») is the exact half,
// so the exact half is what is pinned. A deliberately more conservative fallback is a
// decision — it changes this line AND that comment together, which is the point.
test('the fallback fires before the timeout npm test puts in force', () => {
  const script = (JSON.parse(fs.readFileSync(path.join(testDir, '..', 'package.json'), 'utf8')).scripts as Record<string, string>).test;
  const runnerMs = Number(/--test-timeout[= ](\d+)/.exec(script ?? '')?.[1]);
  assert.ok(runnerMs > 0, `the suite's own runner timeout is what this is measured against: ${script}`);
  const bare = netDeadlineFrom([]);
  assert.equal(bare, Math.floor(runnerMs / 2), `the fallback is the value npm test's own flag yields, not merely something under ${runnerMs}ms`);
});

// The invariant the whole design rests on, read off the run in progress rather than off a
// fixture: the request has to lose the race, or its deadline never fires and the runner is
// back to timing out a test whose socket keeps the file alive. The runner timeout is parsed
// here a second time, deliberately — a test that called `netDeadlineFrom` to check
// `netDeadlineFrom` would agree with any parser, including one that reads nothing at all.
test('the deadline the suite carries loses to the runner it came from', () => {
  assert.equal(NET_DEADLINE_MS, netDeadlineFrom(process.execArgv), 'not a number of its own');
  let runnerMs = 0;
  process.execArgv.forEach((arg, i) => {
    if (/^--test-timeout=\d+$/.test(arg)) runnerMs = Number(arg.split('=')[1]);
    else if (arg === '--test-timeout' && /^\d+$/.test(process.execArgv[i + 1] ?? '')) runnerMs = Number(process.execArgv[i + 1]);
  });
  if (runnerMs > 0) assert.ok(NET_DEADLINE_MS < runnerMs, `${NET_DEADLINE_MS}ms must fire before the runner's ${runnerMs}ms`);
  else assert.equal(NET_DEADLINE_MS, netDeadlineFrom([]), 'a run with no per-test timeout gets the fallback');
});

// ── the wait both serve harnesses are built on ────────────────────────────────────────
// `tarmac serving` is a contract now: `test/cli-config.test.ts` and `test/reap.test.ts`
// block on that substring to know the CLI came up. Blocking on it with no deadline is what
// made a mutation of the marker un-reportable — the tests were right, the run just stopped.

/** A child that prints what it is told and stays alive, like `tarmac serve` does. */
const child = (script: string): ChildProcess =>
  spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });

test('a line that never comes is a rejection carrying what did arrive', async () => {
  // Printed on a loop, so the deadline cannot fire before the child has said anything.
  const c = child('setInterval(() => console.log("listening on 4477"), 50)');
  try {
    await assert.rejects(
      () => waitForOutput(c, /tarmac serving/, 2000),
      (e: Error) => {
        assert.match(e.message, /tarmac serving/, 'names the line it waited for');
        assert.match(e.message, /listening on 4477/, 'and quotes what the child did print');
        return true;
      },
    );
  } finally {
    c.kill('SIGKILL');
  }
});

test('the line resolves with everything printed up to it', async () => {
  const c = child('console.log("settings"); console.log("tarmac serving http://127.0.0.1:1"); setInterval(() => {}, 1000)');
  try {
    const out = await waitForOutput(c, /tarmac serving/, NET_DEADLINE_MS);
    assert.match(out, /settings/, 'the block printed before the marker is what the assertions read');
    assert.match(out, /tarmac serving/);
  } finally {
    c.kill('SIGKILL');
  }
});

// The other half of the same hang, and the half a deadline alone does not fix: a spawned
// child with open pipes keeps the event loop — and therefore the test file — alive. A wait
// that rejects and leaves the CLI running still ends with a file that never terminates.
test('a wait that fails takes the child with it', async () => {
  const c = child('setInterval(() => console.log("still here"), 50)');
  try {
    await assert.rejects(() => waitForOutput(c, /tarmac serving/, 500));
    await Promise.race([once(c, 'exit'), new Promise((r) => setTimeout(r, 3000).unref())]);
    assert.equal(c.signalCode, 'SIGKILL', 'the child outlived the wait, and would outlive the file');
  } finally {
    // Without this the day it goes red is a day this file hangs instead of reporting — the
    // very failure under test. Verified by watching it: 134s of nothing, then a kill.
    c.kill('SIGKILL');
  }
});

// The failure mode that already worked, kept: a CLI that dies before the line says why.
test('a child that dies before the line fails with what it printed', async () => {
  const c = child('console.error("port 4477 already in use"); process.exit(1)');
  await assert.rejects(() => waitForOutput(c, /tarmac serving/, NET_DEADLINE_MS), /already in use/);
});

// ── the request the other half of the suite is built on ───────────────────────────────
// A server that accepts and never answers is not hypothetical: it is what `src/server.ts`
// becomes the moment a handler returns without writing a body, and what a bare
// `net.createServer()` holding a port is by nature. `timeout:` alone does not save you from
// it — the socket emits `'timeout'` and the request stays pending — so the destroy is the
// bound, and this is the test that says so.
test('a request nobody answers is a rejection, not a wait forever', async () => {
  const silent = silentServer(); // accepts, never answers, never closes
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
  const port = String((silent.address() as AddressInfo).port);
  try {
    // Raced against a deadline of the test's own: if `rawGet` ever stops settling, this goes
    // red rather than hanging the file — the failure the whole file is about.
    const outcome = await Promise.race([
      rawGet(port, `localhost:${port}`, '/api/fleet', {}, 500).then(
        (status) => `answered ${status}`,
        (e: Error) => `rejected: ${e.message}`,
      ),
      new Promise<string>((r) => setTimeout(() => r('still pending'), 5000).unref()),
    ]);
    assert.match(outcome, /^rejected: no answer from \/api\/fleet in 500ms$/, outcome);
  } finally {
    // `closeAllConnections` before `close`, and it is the difference between a red test and
    // a hung file: a request still pending holds the socket, `close()` waits for the socket,
    // and the day this goes red is the day the request never settles. Verified by removing
    // the destroy from `rawGet` — without this line the file ran past five minutes.
    silent.closeAllConnections();
    await new Promise<void>((r) => silent.close(() => r()));
  }
});
