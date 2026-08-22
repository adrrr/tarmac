// The rule behind the suite's static guard: which lines open a network wait that nothing
// can stop. A module rather than a closure inside the test, so the rules can be run against
// lines whose verdict is written down — a guard with no negative test is a guard nobody has
// checked, and the first cut of this one blessed three shapes it was written to catch.

/** The one file allowed to hold a raw client, because its deadline has a test. */
const ONE_HOME = 'bounded.ts';

/**
 * The one file allowed to hand a wait a number, because there the deadline is the SUBJECT and
 * not the tool: `waitForOutput(c, /tarmac serving/, 500)` is how you prove a deadline fires, and
 * with the suite's own it would take half the runner's timeout to prove it. What keeps the
 * exemption from being the hang it exists to catch: each excused call proves a SHORT deadline
 * fires — the expected rejection is its own terminus — and the one call that waits for an
 * answer instead of a rejection is raced against an outer bound in the same test. The two rules
 * below are the only ones it excuses — a bare `fetch` in that file, or a wait split over several
 * lines, is an offence like anywhere else.
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
 * `wait…`, any `…Until` poller and `rawGet` — the shapes every wait helper in this suite is
 * written in (`historyUntil` polls a record the way `waitFor` polls a predicate).
 */
const WAIT_CALL = /\b(?:wait[A-Za-z]*|[A-Za-z]+Until|rawGet)\s*\(/g;
/** A trailing positional number, in the argument list of the call it belongs to. */
const TRAILING_NUMBER = /,\s*\d[\d_]*\s*$/;

/**
 * The one shape that opens such a bracket without calling anything: the helper's own signature,
 * split because it is too long for a line — `export function rawGet(` in `bounded.ts` and
 * `async function historyUntil(` in `server.test.ts` are both exactly that. What a signature
 * does wrong is a DEFAULT, and `HAND_TYPED_DEFAULT` reads it on whichever of its lines it lands.
 * The arrow form needs no exemption: `const waitFor = (` puts an `=` where the rule wants a
 * bracket, so it never matches in the first place.
 */
const DECLARES = /\bfunction\s+$/;

/**
 * What `line` does to a wait helper, if anything: hands it a number of its own, or opens a call
 * it does not close.
 *
 * The brackets are counted rather than matched, because both ways of writing it past a regex are
 * ordinary here: `waitFor(() => cold(r.dir) === 0, what, 60_000)` closes a bracket the deadline
 * is still inside, and `assert.equal(await rawGet(port, host), 403)` closes the call before a
 * number that belongs to the assertion — the second is five call sites in `server.test.ts`, and
 * a rule that reported them would be a rule people turn off.
 *
 * An unclosed bracket used to end the reading, and a line break was therefore the way out of the
 * rule: the #85 defect rewritten over five lines left the suite green, while a `fetch` split the
 * same way stayed flagged — the two rules pointed opposite ways, and the softer one was the
 * documented exit (#93). So the split IS the offence now, which is the whole of the fix: a rule
 * that walked on to find the number would have to read a second grammar to say the same thing,
 * and would still leave the deadline off the line the reader is on. Line-based judgement is what
 * this module is; the wait goes on one line, as the `fetch` next to it already had to.
 *
 * One limit left, unchanged: a bracket inside a string literal is counted like any other.
 */
function waitOffence(line: string): 'deadline' | 'split' | undefined {
  for (const call of line.matchAll(WAIT_CALL)) {
    if (DECLARES.test(line.slice(0, call.index))) continue;
    const open = call.index + call[0].length;
    let depth = 1;
    let i = open;
    for (; i < line.length && depth > 0; i++) {
      if ('([{'.includes(line[i]!)) depth++;
      else if (')]}'.includes(line[i]!)) depth--;
    }
    if (depth > 0) return 'split';
    if (TRAILING_NUMBER.test(line.slice(open, i - 1))) return 'deadline';
  }
  return undefined;
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
    const wait = waitOffence(line);
    // Before the exemption below, and the only rule that is: being excused from PICKING a
    // deadline is not being excused from writing it where it can be read.
    if (wait === 'split') {
      found.push(`${at} must write the wait on one line, where its deadline can be read`);
    }
    if (file === DEADLINE_UNDER_TEST) return;
    if (HAND_TYPED_DEFAULT.test(line)) {
      found.push(`${at} must default to NET_DEADLINE_MS from ${ONE_HOME}, not to a number of its own`);
    }
    if (wait === 'deadline') {
      found.push(`${at} must let the helper's deadline stand rather than hand it one`);
    }
  });
  return found;
}
