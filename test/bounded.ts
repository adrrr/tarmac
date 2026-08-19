// The suite's two ways of waiting on something that may never come: a line on a child's
// stdout, and an HTTP request a server may accept and never answer. Not a `*.test.ts`, so
// the runner's glob leaves it alone — same arrangement as `fleet-fixtures.ts`.
//
// The deadline is the whole point. Both serve harnesses used to wait on `tarmac serving`
// with nothing to stop them: when a change made that line never come, the tests that should
// have gone red stopped reporting instead, and the file had to be killed from outside. A
// wait that cannot fail is a test that cannot fail.
//
// Both live HERE, together, because neither deadline is one line of code and both are easy
// to write in a form that looks bounded and is not (see `rawGet`). One home, one pair of
// tests in `bounded-waits.test.ts` — and a static guard that keeps the raw clients out of
// the test files, where nothing would prove their deadline fires.

import http from 'node:http';
import type { ChildProcess } from 'node:child_process';

/**
 * What a deadline falls back to when the runner is not holding one. `npm test` always is —
 * this is the value its own `--test-timeout=120000` yields — but a file run on its own,
 * `node --test test/server.test.ts`, has NO per-test timeout, and then this number is the
 * only thing standing between a silent server and a file that never reports.
 */
const NO_RUNNER_DEADLINE_MS = 60_000;

/**
 * Half of the per-test timeout `argv` puts in force, or {@link NO_RUNNER_DEADLINE_MS} when
 * it puts none.
 *
 * Half, so the wait loses the race: a rejection naming the URL and the elapsed time is a
 * report, "test timed out after 120000ms" is a shrug. The runner stays the outer net — and
 * a net is ALL it is: a test it times out is marked failed, but the socket left pending
 * keeps the file's process alive, so the run does not end, it hangs having already decided.
 * Measured on node 26: a file whose test timed out at 3s was still up nine seconds later,
 * and was killed from outside. That is why removing these deadlines is not an option.
 *
 * Exported for its own test. `--test-timeout` is read from `process.execArgv` because that
 * is where the runner republishes the flags of the run to each test file, and it is read in
 * the `=` form only: node normalises the space form into one before re-emitting the raw
 * pair, so the LAST `=` occurrence is the value in force under either spelling. Zero is not
 * a timeout — node treats `--test-timeout=0` as none at all — so it takes the fallback.
 */
export function netDeadlineFrom(argv: readonly string[]): number {
  let runnerMs = 0;
  for (const arg of argv) {
    const flag = /^--test-timeout=(\d+)$/.exec(arg);
    if (flag) runnerMs = Number(flag[1]);
  }
  return runnerMs > 0 ? runnerMs / 2 : NO_RUNNER_DEADLINE_MS;
}

/**
 * The deadline every wait in this suite carries, for the run in progress.
 *
 * It is one number for the whole suite because it was twenty-two of them, all written 4000
 * or 20_000 next to the call and none of them derived from anything: four suites at once on
 * a busy machine aborted requests that servers were about to answer, in files whose slowest
 * test takes twelve seconds under that load (#73). A deadline typed by hand is a guess
 * about a machine, and the only machine-independent bound in reach is the runner's own —
 * hence this, and hence the static guard that now insists every `fetch` in the suite carry
 * exactly it. A test that needs a SHORT deadline because the deadline is what it is testing
 * passes its own, as the three below do.
 */
export const NET_DEADLINE_MS = netDeadlineFrom(process.execArgv);

/**
 * Resolves with everything `child` printed on stdout up to and including the first match of
 * `marker`. Rejects — always within `timeoutMs` — when the line never comes, when the child
 * exits first, or when it could not be spawned at all. Every rejection carries the output
 * so far, which is the only clue available when a CLI comes up differently than expected.
 *
 * A rejection also KILLS the child, and that is half the guarantee: a spawned process with
 * open pipes holds the event loop open, so a failed wait that leaves the CLI running still
 * ends in a file that never terminates — a deadline alone does not buy a report.
 *
 * `marker` must not carry `g`: `test()` on a global regex is stateful.
 */
export function waitForOutput(child: ChildProcess, marker: RegExp, timeoutMs = NET_DEADLINE_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      fail(new Error(`nothing matched ${marker} in ${timeoutMs}ms.\nstdout so far:\n${out}\nstderr so far:\n${err}`));
    }, timeoutMs);
    // The wait is over before this can matter, but a stray deadline must never be the reason
    // a file stays open — the failure this module exists to prevent, in miniature.
    timer.unref();

    const settle = (finish: () => void): void => {
      clearTimeout(timer);
      finish();
    };
    const fail = (error: Error): void =>
      settle(() => {
        child.kill('SIGKILL');
        reject(error);
      });
    child.stdout!.on('data', (b: Buffer) => {
      out += b.toString();
      if (marker.test(out)) settle(() => resolve(out));
    });
    child.stderr!.on('data', (b: Buffer) => {
      err += b.toString();
    });
    child.on('error', (e) => fail(e));
    child.on('exit', (code) => fail(new Error(`cli exited ${code}: ${err || out}`)));
  });
}

/**
 * A GET that says what it likes in the `Host` header — which `fetch` refuses to set, it
 * being a forbidden header — resolving with the status code.
 *
 * ⚠️ `timeout` on `http.request` is NOT a deadline. It only makes the socket EMIT
 * `'timeout'`; the request stays pending forever unless someone destroys it, which is what
 * the listener below is for. A `timeout:` with no `destroy` reads as bounded, passes review,
 * and hangs the file exactly as an unbounded one does — the reason this helper is shared and
 * tested rather than copied into whichever suite needs a raw request next.
 */
export function rawGet(
  port: string,
  host: string,
  path = '/api/fleet',
  extra: Record<string, string> = {},
  timeoutMs = NET_DEADLINE_MS,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { Host: host, ...extra }, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from ${path} in ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * A server that accepts a connection and answers nothing — the exact shape `rawGet`'s
 * deadline exists for, and what `src/server.ts` becomes the moment a handler returns without
 * writing a body. It lives here because this is the one file allowed to name `node:http`:
 * the guard bans that import everywhere else, and an exception for "just the test that
 * proves the bound" would be the hole the rule is about.
 */
export const silentServer = (): http.Server => http.createServer(() => {});
