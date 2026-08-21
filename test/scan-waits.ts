// The rule behind the suite's static guard: which lines open a network wait that nothing
// can stop. A module rather than a closure inside the test, so the rules can be run against
// lines whose verdict is written down — a guard with no negative test is a guard nobody has
// checked, and the first cut of this one blessed three shapes it was written to catch.

/** The one file allowed to hold a raw client, because its deadline has a test. */
const ONE_HOME = 'bounded.ts';

/**
 * The one file allowed to hand a wait a number, because there the deadline is the SUBJECT and
 * not the tool: `waitForOutput(c, /tarmac serving/, 500)` is how you prove a deadline fires, and
 * with the suite's own it would take half the runner's timeout to prove it. Every such call
 * there is raced against an outer bound in the same test, which is what keeps the exemption from
 * being the hang it exists to catch. The two rules below are the only ones it excuses — a bare
 * `fetch` in that file is an offence like anywhere else.
 */
const DEADLINE_UNDER_TEST = 'bounded-waits.test.ts';

/**
 * `fetch` is judged where it is written, because its deadline IS one expression and belongs
 * next to the call, where a reader sees it. Line-based, so a fetch split over several lines
 * reads as unbounded — write it on one.
 *
 * The bound has to be `NET_DEADLINE_MS` and not merely SOME `AbortSignal.timeout`, because
 * a number typed next to the call is how the first version of this rule was satisfied
 * nineteen times over with 4000ms — until a loaded machine aborted two of those requests on
 * a server that was answering them (#73). A literal passes review, reads as bounded, and is
 * a guess about how fast a machine is; the shared constant is half the runner's own timeout.
 * Copying a neighbouring call is how every one of the nineteen got written, so the neighbour
 * is what the rule has to police.
 */
const BARE_FETCH = /\bfetch\s*\(/;
const BOUNDED = /AbortSignal\.timeout\(\s*NET_DEADLINE_MS\s*\)/;

/**
 * The rule above checks a NAME, and a name is cheap: `const NET_DEADLINE_MS = 4000` one line
 * up satisfies it while writing back the exact literal it exists to refuse. So the shadow is
 * banned outright outside the one home — the same move as judging the raw client at its
 * import rather than at its call, and for the same reason. Importing the constant is not a
 * declaration and does not match.
 */
const SHADOWS_DEADLINE = /\b(?:const|let|var)\s+NET_DEADLINE_MS\b/;

/**
 * A raw `node:http` client is judged at the IMPORT, not the call, and that is the whole
 * lesson of this rule's first version. It banned `http.request(` — which the default import
 * happens to produce and nothing else does: `import { request } from 'node:http'` and
 * `import * as h from 'node:http'` both walk straight past, and the named form is the more
 * natural way to write it. Whatever the call ends up being spelled, the module has to be
 * named once, in one place, and that is where it can be caught.
 *
 * Checking the bound at the call site is not an option either: `timeout:` on `http.request`
 * only makes the socket EMIT `'timeout'` — without a `destroy` on some other line the
 * request hangs forever, so a line-based rule cannot tell a bounded one from a no-op.
 */
const IMPORTS_RAW_CLIENT = /(?:from\s+|require\s*\(\s*)['"](?:node:)?https?['"]/;
/** A type is erased before anything runs: it cannot open a socket. */
const TYPE_ONLY = /^\s*import\s+type\s/;

/**
 * The literal one line further out: `async function myGet(url, timeoutMs = 4000)`, which is the
 * pre-fix shape of both `rawGet` and `historyUntil` (#84) and the form a helper written next year
 * arrives in. The rules above police `fetch` calls and the shadowed constant, and a default is
 * neither — the number never appears at a call site at all, and every caller inherits it.
 *
 * The NAME is what is read, and only a deadline-shaped one: `timeoutMs`, `deadlineMs`, a
 * `waitMs`. An age or a duration a test hands its own fixture — `snapshotAgeMs = 1200` — is data
 * it chose, not a bound on anything that can hang, and a rule that reported it would be a rule
 * people turn off. A `= NET_DEADLINE_MS` is what the rule asks for and does not match; only a
 * digit on the right does, annotated (`timeoutMs: number = 4000`) or not.
 */
const HAND_TYPED_DEFAULT = /\b(?:timeout|deadline|budget|wait)[A-Za-z]*Ms\b(?:\s*:\s*number)?\s*=\s*\d/i;

/**
 * The same guess made at the call instead: `waitForOutput(child, /marker/, 20_000)`. The default
 * can be the suite's constant and this still walks past it — which is how a shared helper ends up
 * carrying twenty-two deadlines again, one call site at a time.
 *
 * Read at the CALLEE, because the last argument alone means nothing: `setTimeout(fn, 5000)` is a
 * timer, not a wait, and a rule that could not tell them apart would have to be dropped. Any
 * `wait…` and `rawGet` — the shape every wait helper in this suite is written in.
 */
const WAIT_CALL = /\b(?:wait[A-Za-z]*|rawGet)\s*\(/g;
/** A trailing positional number, in the argument list of the call it belongs to. */
const TRAILING_NUMBER = /,\s*\d[\d_]*\s*$/;

/**
 * Whether `line` hands one of those helpers a number of its own.
 *
 * The brackets are counted rather than matched, because both ways of writing it past a regex are
 * ordinary here: `waitFor(() => cold(r.dir) === 0, what, 60_000)` closes a bracket the deadline
 * is still inside, and `assert.equal(await rawGet(port, host), 403)` closes the call before a
 * number that belongs to the assertion — the second is five call sites in `server.test.ts`, and
 * a rule that reported them would be a rule people turn off.
 *
 * Two limits, both narrow and neither silent: a bracket inside a string literal is counted like
 * any other, and a call split over several lines is not read at all — the same line-based rule
 * `fetch` is judged by, for the same reason. Write the wait on one line.
 */
function handsOverADeadline(line: string): boolean {
  for (const call of line.matchAll(WAIT_CALL)) {
    const open = call.index + call[0].length;
    let depth = 1;
    let i = open;
    for (; i < line.length && depth > 0; i++) {
      if ('([{'.includes(line[i]!)) depth++;
      else if (')]}'.includes(line[i]!)) depth--;
    }
    if (depth === 0 && TRAILING_NUMBER.test(line.slice(open, i - 1))) return true;
  }
  return false;
}

/**
 * Comments are prose, not code — but only a comment that OPENS the line can be skipped
 * wholesale. A trailing one has to be cut instead, and cut carefully: `//` also opens every
 * `http://` URL in this suite, so the cut is made only where the slashes are not preceded by
 * a colon. Without it, `await fetch(url); // TODO: bound this` reads as a comment line and
 * the bare call it carries is waved through.
 */
const stripComment = (line: string): string => line.replace(/(^|[^:])\/\/.*$/, '$1');
const opensWithComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

/** Every unbounded wait `source` opens, as `file:line needs …` — empty when there are none. */
export function unboundedWaits(file: string, source: string): string[] {
  const found: string[] = [];
  source.split('\n').forEach((raw, i) => {
    if (opensWithComment(raw)) return;
    const line = stripComment(raw);
    const at = `${file}:${i + 1}`;
    if (BARE_FETCH.test(line) && !BOUNDED.test(line)) {
      found.push(`${at} needs an AbortSignal.timeout(NET_DEADLINE_MS) from ${ONE_HOME}`);
    }
    if (SHADOWS_DEADLINE.test(line) && file !== ONE_HOME) {
      found.push(`${at} must import NET_DEADLINE_MS from ${ONE_HOME}, not declare one of its own`);
    }
    if (IMPORTS_RAW_CLIENT.test(line) && !TYPE_ONLY.test(line) && file !== ONE_HOME) {
      found.push(`${at} must use rawGet from ${ONE_HOME}, not a raw http client`);
    }
    if (file === DEADLINE_UNDER_TEST) return;
    if (HAND_TYPED_DEFAULT.test(line)) {
      found.push(`${at} must default to NET_DEADLINE_MS from ${ONE_HOME}, not to a number of its own`);
    }
    if (handsOverADeadline(line)) {
      found.push(`${at} must let the helper's deadline stand rather than hand it one`);
    }
  });
  return found;
}
