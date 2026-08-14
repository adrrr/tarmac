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
import { rawGet, silentServer, waitForOutput } from './bounded.ts';
import { unboundedWaits } from './scan-waits.ts';
import { RAW_CLIENT_IMPORT, VERDICTS } from './scan-waits.fixtures.ts';

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
  const wrong = VERDICTS.filter(({ line, caught }) => unboundedWaits('watch.test.ts', line).length > 0 !== caught).map(
    ({ line, caught, why }) => `${caught ? 'MISSED' : 'FALSE POSITIVE'}: ${why} — ${line}`,
  );
  assert.deepEqual(wrong, []);
});

test('the one home may hold the raw client the others may not', () => {
  assert.deepEqual(unboundedWaits('bounded.ts', RAW_CLIENT_IMPORT), []);
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
    const out = await waitForOutput(c, /tarmac serving/, 20_000);
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
  await assert.rejects(() => waitForOutput(c, /tarmac serving/, 20_000), /already in use/);
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
