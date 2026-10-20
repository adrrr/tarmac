// Preload for test/install.test.ts. Right after the uninstall plan has seen the prune marker as
// a file, the marker goes: the plan promised a removal that would no longer happen.
import fs from 'node:fs';
import path from 'node:path';
import { PRUNE_MARKER } from '../src/wrapper.ts';

const lstatSync = fs.lstatSync;
let done = false;
fs.lstatSync = function (file, ...rest) {
  try {
    return lstatSync.call(this, file, ...rest);
  } finally {
    if (!done && path.basename(String(file)) === PRUNE_MARKER) {
      done = true;
      fs.rmSync(String(file), { force: true });
    }
  }
};
