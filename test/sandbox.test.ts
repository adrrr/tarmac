import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './sandbox.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

// The suite takes a throwaway directory for nearly every test and never gave one back: the
// machine this is developed on reached 103 000 `tarmac-*` directories in `$TMPDIR`. CI
// runners are destroyed after every build, so the only place the leak exists is the only
// place nothing was watching.
//
// Asserted end to end rather than by reading the helper: the removal happens in a hook that
// runs after the last test of a file, which no test in that file can watch. So a real child,
// with a `$TMPDIR` of its own, and the directory is counted from outside once it has exited.
test('a test file that takes sandboxes leaves none behind', () => {
  const tmp = tempDir('tarmac-leak-');
  // NODE_TEST_CONTEXT and NODE_TEST_WORKER_ID are set by the runner WE are running under, and
  // a nested `node --test` that inherits them reports as a subtest of ours and exits 0 —
  // whatever it found. Caught by watching this very test pass while its fixture could not
  // even resolve its import: a harness that always says yes proves nothing.
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST_')) delete env[k];

  const r = spawnSync(process.execPath, ['--test', path.join(here, 'sandbox.fixture.ts')], {
    // TMP and TEMP too: `os.tmpdir()` reads whichever of the three this platform prefers.
    env,
    encoding: 'utf8',
    timeout: 60000,
  });

  assert.equal(r.status, 0, `the fixture itself must pass first:\n${r.stdout}${r.stderr}`);
  assert.deepEqual(fs.readdirSync(tmp), [], 'every sandbox that file took is gone, the locked one included');
});
