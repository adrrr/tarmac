// Preload for test/install.test.ts. Right after the uninstall plan has looked at the prune
// marker, the scenario of #262: a re-install to another --snapshots-dir, then the new wrapper's
// first frame stamping a marker there. The CLI has to refuse.
import fs from 'node:fs';
import path from 'node:path';
import { install } from '../src/install.ts';
import { PRUNE_MARKER } from '../src/wrapper.ts';

const to = process.env.TARMAC_TEST_TO;
const lstatSync = fs.lstatSync;
let done = false;
fs.lstatSync = function (file, ...rest) {
  try {
    return lstatSync.call(this, file, ...rest);
  } finally {
    if (!done && path.basename(String(file)) === PRUNE_MARKER) {
      done = true;
      install({ home: process.env.HOME, snapshotsDir: to });
      fs.writeFileSync(path.join(to, PRUNE_MARKER), '');
    }
  }
};
