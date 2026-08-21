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
 * Measured on node 26: a file whose only test timed out at 3s was still running half a
 * minute later, and left only when it was killed from outside. That is why removing these
 * deadlines — the other fix #73 offered — is not an option.
 *
 * Exported for its own test. `--test-timeout` is read from `process.execArgv`, where the
 * runner republishes the flags of the run to each test file, and BOTH spellings are read
 * because both really occur. On node 24+ a run leaves three copies: node dumps every option
 * it holds, effective value in `=` form, then re-emits the raw argv after it — so
 * `--test-timeout 30000` normally survives as an `=` too. On node 22 there is NO dump, ever
 * (and no `--test-isolation` to blame — the flag does not exist there): a plain spaced
 * `--test-timeout 30000` reaches a test file spaced and spaced only (captured on all three
 * node lines of the CI matrix). Reading `=` only would take
 * the fallback there, and a fallback LONGER than the runner's own timeout is the inversion
 * this whole constant exists to prevent — the request would stop losing the race. Last
 * occurrence of either spelling wins, as it does in node. Zero is not a timeout — node treats
 * `--test-timeout=0` as none at all — so it takes the fallback.
 *
 * Floored, because the halving is the one place a fraction can appear and
 * `AbortSignal.timeout()` refuses one: `--test-timeout=4001` would have thrown
 * `ERR_OUT_OF_RANGE` out of all nineteen requests while the two helpers, which take a
 * fractional delay quite happily, carried on — a breakage split in half is the worst kind.
 *
 * And floored to ONE, not to zero, because zero is not a short deadline — it is two different
 * absences, and `--test-timeout=1` is enough to reach both. `AbortSignal.timeout(0)` aborts a
 * request before it is sent, so the nineteen fail whatever the server does; `timeout: 0` on
 * `http.request` means no timeout at all, so `rawGet` waits forever on the silent server this
 * module exists for. One millisecond fires, which is what a caller typing 1 asked for.
 */
export function netDeadlineFrom(argv: readonly string[]): number {
  let runnerMs = 0;
  argv.forEach((arg, i) => {
    const inline = /^--test-timeout=(\d+)$/.exec(arg);
    if (inline) runnerMs = Number(inline[1]);
    else if (arg === '--test-timeout' && /^\d+$/.test(argv[i + 1] ?? '')) runnerMs = Number(argv[i + 1]);
  });
  return runnerMs > 0 ? Math.max(1, Math.floor(runnerMs / 2)) : NO_RUNNER_DEADLINE_MS;
}

/**
 * The deadline every wait in this suite carries, for the run in progress.
 *
 * It is one number for the whole suite because it was twenty-two of them — 4000 written out
 * at nineteen `fetch` calls, and three defaults nobody passes — and not one derived from
 * anything. With four suites running at once, both requests in `cli-config.test.ts` aborted
 * on a server that was answering them: a loopback request took longer than four seconds
 * because the machine was busy, which is a fact about the machine and not about the code
 * under test (#73). That is the whole argument. A hand-typed deadline is a guess about a
 * machine; the runner's own timeout is the one bound in reach that is not.
 *
 * The other seventeen requests were never seen to fail — they move because a rule the
 * suite can check beats seventeen numbers that happen to be the same today, and because
 * the static guard now insists on this constant rather than on any literal.
 *
 * The cost is named, not hidden: a route that hangs takes 60s to report where 4000ms used
 * to do it. That is the price of the deadline meaning "the machine is gone" rather than
 * "the machine is busy", and it is only ever paid on a run that is already failing.
 *
 * A wait whose deadline is the thing under test passes its own, as the three below do. For
 * `fetch` the guard leaves no such door: no test needs one today, and the day one does, the
 * exception belongs in the rule rather than in a call nobody can find again.
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
