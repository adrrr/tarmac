// The rule behind the suite's static guard: which lines open a network wait that nothing
// can stop. A module rather than a closure inside the test, so the rules can be run against
// lines whose verdict is written down — a guard with no negative test is a guard nobody has
// checked, and the first cut of this one blessed three shapes it was written to catch.

/** The one file allowed to hold a raw client, because its deadline has a test. */
const ONE_HOME = 'bounded.ts';

/**
 * `fetch` is judged where it is written, because its deadline IS one expression and belongs
 * next to the call, where a reader sees it. Line-based, so a fetch split over several lines
 * reads as unbounded — write it on one.
 */
const BARE_FETCH = /\bfetch\s*\(/;
const BOUNDED = /AbortSignal\.timeout/;

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
    if (BARE_FETCH.test(line) && !BOUNDED.test(line)) found.push(`${at} needs an AbortSignal.timeout`);
    if (IMPORTS_RAW_CLIENT.test(line) && !TYPE_ONLY.test(line) && file !== ONE_HOME) {
      found.push(`${at} must use rawGet from ${ONE_HOME}, not a raw http client`);
    }
  });
  return found;
}
