// `.claude/settings.json` is agent configuration in a public repository: whoever clones this and
// runs Claude Code in it loads the file. It exists for one key, `attribution`, and a pull request
// that slipped a hook or a permission next to it would hand every contributor's agent a command
// to run. The script this suite drives is what keeps it to that one key, in CI.
//
// Each case writes its own settings file in a throwaway directory and hands its path to the
// script, under `sh` as CI runs it. The repository's own file is read once, as the case that
// must pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './sandbox.ts';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(repoRoot, 'scripts', 'settings-attribution-only.sh');

function run(file: string, env: NodeJS.ProcessEnv = process.env): { status: number | null; out: string } {
  const r = spawnSync('/bin/sh', [SCRIPT, file], { cwd: repoRoot, encoding: 'utf8', env });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A settings file holding exactly `body`, in a directory of its own. */
function settings(body: string): string {
  const file = path.join(tempDir('tarmac-settings-'), 'settings.json');
  fs.writeFileSync(file, body);
  return file;
}

test("the repository's own settings file passes", () => {
  const { status, out } = run(path.join(repoRoot, '.claude', 'settings.json'));
  assert.equal(status, 0, out);
});

test('attribution alone passes, with any of its three keys', () => {
  for (const body of [
    '{"attribution":{"commit":"","pr":"","sessionUrl":false}}',
    '{"attribution":{"commit":"x"}}',
    '{"attribution":{}}',
  ]) {
    const { status, out } = run(settings(body));
    assert.equal(status, 0, `${body}: ${out}`);
  }
});

// The file is there to switch attribution off. Gone, it switches nothing off, and a guard that
// passes on a missing file is one a rename walks around.
test('a missing file fails', () => {
  const file = path.join(tempDir('tarmac-settings-'), 'settings.json');
  const { status, out } = run(file);
  assert.equal(status, 1, out);
  assert.match(out, /missing/);
});

test('an empty file, or one of whitespace, fails', () => {
  for (const body of ['', '  \n']) {
    const { status, out } = run(settings(body));
    assert.equal(status, 1, `${JSON.stringify(body)}: ${out}`);
  }
});

test('a file that is not JSON fails', () => {
  const { status, out } = run(settings('{"attribution": {'));
  assert.equal(status, 1, out);
});

test('a key beside attribution fails, and is named', () => {
  for (const key of ['hooks', 'permissions', 'env']) {
    const { status, out } = run(settings(`{"attribution":{"commit":""},"${key}":{}}`));
    assert.equal(status, 1, `${key}: ${out}`);
    assert.match(out, new RegExp(key));
  }
});

// A string value, so this one is caught by the key list and not by the type check below it.
test('an unknown key inside attribution fails', () => {
  const { status, out } = run(settings('{"attribution":{"commit":"","model":"x"}}'));
  assert.equal(status, 1, out);
  assert.match(out, /attribution\.model/);
});

test('an object under one of the three keys fails', () => {
  const { status, out } = run(settings('{"attribution":{"commit":{"hooks":[]}}}'));
  assert.equal(status, 1, out);
  assert.match(out, /attribution\.commit\.hooks/);
});

test('settings that are not an object, or have no attribution, fail', () => {
  for (const body of ['{}', '[]', '"attribution"', '{"attribution":[]}', '{"attribution":"off"}']) {
    const { status, out } = run(settings(body));
    assert.equal(status, 1, `${body}: ${out}`);
  }
});

// jq reads a stream: given two documents it judges each, and its exit status follows the last.
// A clean document after a dirty one must not launder it.
test('a second document after the first fails, whichever one is dirty', () => {
  for (const body of [
    '{"attribution":{}}\n{"hooks":{}}',
    '{"hooks":{}}\n{"attribution":{}}',
  ]) {
    const { status, out } = run(settings(body));
    assert.equal(status, 1, `${body}: ${out}`);
  }
});

// A check that could not run is not a clean file.
test('without jq the script exits 2, never 0', () => {
  const empty = tempDir('tarmac-settings-bin-');
  const { status, out } = run(settings('{"attribution":{}}'), { ...process.env, PATH: empty });
  assert.equal(status, 2, out);
  assert.match(out, /jq/);
});
