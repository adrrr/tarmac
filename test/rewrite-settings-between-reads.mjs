// Preloaded into the CLI under test with `--import`. The first read of settings.json is the
// plan's; right after it returns, this rewrites the file, as an editor save or another install
// would while the prompt waits. The second read, uninstall's own, then sees a different file.
import fs from 'node:fs';
import path from 'node:path';

const settings = path.join(process.env.HOME, '.claude', 'settings.json');
const readFileSync = fs.readFileSync;
let rewritten = false;
fs.readFileSync = function (file, ...rest) {
  const text = readFileSync.call(this, file, ...rest);
  if (!rewritten && String(file) === settings) {
    rewritten = true;
    const current = JSON.parse(String(text));
    current.model = 'set while the prompt waited';
    fs.writeFileSync(settings, JSON.stringify(current, null, 2) + '\n');
  }
  return text;
};
