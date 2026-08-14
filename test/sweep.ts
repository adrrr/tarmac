// How this suite observes a sweep that no longer happens inside the frame (#8).
//
// The wrapper hands the directory walk to a detached child and returns, so when `runWrapper`
// comes back the frame is over and the sweep has, at best, just started. Every assertion
// about what the sweep DID therefore waits for it; every assertion about what it did NOT do
// waits too, only for a different reason. Not a `*.test.ts`, so the runner's glob leaves it
// alone — same arrangement as `bounded.ts` and `fleet-fixtures.ts`.

import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Draws the frames that must not be timed, before the clock starts.
 *
 * macOS runs its first-execution check on a binary the first time it is exec'd, and a script
 * written by a test seconds earlier is exactly that: ~250–450 ms on the FIRST run of a given
 * `statusline.sh`, ~15 ms on its second, with nothing in between to do with what the script
 * contains — invoked as `sh <file>`, where the interpreter is what gets exec'd, it never
 * appears at all. A wrapper on a real machine pays it once, at install, and never again;
 * charged instead to the one frame a test measures, it is 250 ms of a 150 ms budget — a red
 * bar on a script that did nothing wrong, and, once the budget is widened to swallow it, a
 * green one on a script that did.
 *
 * Two runs, because the second is what shows the cost was a one-off and not the frame.
 */
export function warmUpFrames(drawFrame: () => void): void {
  drawFrame();
  drawFrame();
}

/**
 * Polls until `pred` holds, and throws at the deadline rather than hanging — the rule
 * `bounded.ts` states for the network waits, applied to the filesystem: a wait that cannot
 * fail is a test that cannot fail. `what` is in the message because a poll that times out
 * carries no other clue about which of the two halves of a sweep never arrived.
 */
export async function waitFor(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() >= deadline) throw new Error(`waited ${timeoutMs}ms for ${what}, and it never came`);
    await sleep(10);
  }
}

/**
 * The other half: proving a sweep did NOT run. Nothing ever arrives, so there is nothing to
 * poll for — what can be bounded is the fork instead. `cmd &` forks BEFORE the wrapper runs
 * its last line, so by the time the frame has returned the sweep child either exists or
 * never will; and a sweep of a directory holding a handful of fixtures is a single `find`
 * over a handful of entries. This window is four orders of magnitude more than that walk
 * needs, which is what makes "still there afterwards" mean "no sweep was ever started"
 * rather than "we looked too early".
 */
export const settle = (): Promise<void> => sleep(500);
