// P3 — `tarmac list --watch`: the terminal's half of the live view.
//
// The loop holds one piece of state the one-shot `list` never needed — the last fleet it
// managed to read — because that is what makes an honest failure possible. When `claude`
// stops answering, the table stays (it is still true, of an earlier moment), the reason is
// printed above it, and the age underneath it keeps climbing. A watch that simply redrew the
// same numbers would be the frozen dashboard, in a smaller window.
//
// Clock and sleeping are injected: a suite that waits five real seconds per frame is a suite
// nobody runs.

import { reason, renderWatch, REFRESH_MS } from './render.ts';
import type { Fleet } from './fleet.ts';

/** Home, then erase — in that order, so the scrollback above is not what gets redrawn into. */
const CLEAR = '\x1b[H\x1b[2J';

export interface WatchDeps {
  collect: () => Promise<Fleet>;
  write: (frame: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  everyMs?: number;
  /** Only a terminal gets escape codes; a piped `--watch` stays a stream of plain frames. */
  isTTY?: boolean;
  /** Ctrl-C, so the process leaves by the door rather than through the window. */
  signal: AbortSignal;
}

export async function runWatch({
  collect,
  write,
  sleep,
  now,
  everyMs = REFRESH_MS,
  isTTY = false,
  signal,
}: WatchDeps): Promise<void> {
  let fleet: Fleet | null = null;
  let lastOk = now();
  let error: string | null = null;
  const draw = (): void => write((isTTY ? CLEAR : '') + renderWatch({ fleet, error, ageMs: now() - lastOk, everyMs }));

  while (!signal.aborted) {
    try {
      fleet = await collect();
      lastOk = now();
      error = null;
    } catch (e) {
      // Kept, not thrown: one unreadable tick is a thing to report, not a reason to quit and
      // take the last good reading off the screen with it. `reason` rather than `.message`
      // because a non-Error rejection yields `undefined`, which is falsy — the failure line
      // would not have printed badly, it would not have printed at all.
      error = reason(e);
    }
    draw();
    if (signal.aborted) break;

    // A terminal redraws while it waits, so the age on screen is never more than a second
    // stale — and a collector that hangs shows a counter that has visibly stopped rather than
    // a table still claiming to be current. Down a pipe there is no screen to keep current,
    // and a frame a second would be nothing but noise, so the wait stays one sleep.
    if (!isTTY) {
      await sleep(everyMs);
      continue;
    }
    for (let left = everyMs; left > 0 && !signal.aborted; left -= 1000) {
      await sleep(Math.min(1000, left));
      if (!signal.aborted) draw();
    }
  }
}
