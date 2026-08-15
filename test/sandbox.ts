// Throwaway directories for the suite, and the one hook that gives them back.
//
// Every test here works on real files — that is deliberate, and it is why the suite is worth
// anything. What was not deliberate is that none of those directories was ever removed: the
// machine this is developed on reached 103 000 `tarmac-*` directories in `$TMPDIR`, 48 000 of
// them from `fakeHome` alone. CI runners are destroyed after every build, so the leak lived
// exactly where nobody was counting.
//
// The hook is per FILE, not per test (`node --test` runs each file in its own process, so a
// module-level `after` attaches to that file's root context). Per test would have been the
// tighter promise and the wrong one: a sandbox is sometimes read by the test after the one
// that made it, and cleaning up between them would have turned a leak into a flake.

import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const taken: string[] = [];

/**
 * A directory of one's own, removed when the file that asked for it has finished.
 *
 * `root` is only ever passed by the one test that needs a literal `/tmp` — macOS firmlinks
 * make `/tmp/x` and `/private/tmp/x` two spellings of one inode, which is the thing that test
 * exists to exercise, and `os.tmpdir()` there answers with the resolved one.
 */
export function tempDir(prefix: string, root: string = os.tmpdir()): string {
  const dir = fs.mkdtempSync(path.join(root, prefix));
  taken.push(dir);
  return dir;
}

after(() => {
  for (const dir of taken) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A fixture that locked its own sandbox down (0000, 0555 — this suite builds several)
      // cannot be walked as it stands. Taking the permission back is ours to do: this process
      // made that directory, minutes ago, for this file.
      //
      // The retry reaches the ROOT of the sandbox only. A locked SUBdirectory left locked would
      // still refuse to go, and this would give up on it in silence — no fixture does that
      // today (they restore in a `finally`), so what holds here is the shape of the fixtures,
      // not the shape of this code. Worth knowing before writing one that does not.
      try {
        fs.chmodSync(dir, 0o700);
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // And if it still will not go: a directory left behind is a far smaller harm than a
        // suite that passed and then failed on its way out.
      }
    }
  }
  taken.length = 0;
});
