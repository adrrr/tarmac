// `--version`, against the number the package publishes.
//
// It is the first thing anyone types to find out what they are running, and it answered
// `tarmac: unknown option: --version`, exit 1 (#110) — worst on `npx`, which is precisely
// where a cached build makes the question worth asking.
//
// The answer is compared against `package.json` rather than against a literal written here: a
// test carrying the version of the day would have to be edited by every release, and a release
// that forgot it would be a red suite over nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Command } from '../src/args.ts';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(repo, 'src', 'cli.ts');
const PUBLISHED = (JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')) as { version: string }).version;

const run = (...argv: string[]): { status: number | null; stdout: string; stderr: string } =>
  spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', timeout: 20000 });

test('--version prints the version of the package it runs from, and nothing else', () => {
  const r = run('--version');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${PUBLISHED}\n`, 'bare, so `tarmac --version` can be read by something other than a person');
});

test('-v is the same answer', () => {
  const r = run('-v');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${PUBLISHED}\n`);
});

// Every command, and `install`/`uninstall` above all: those two compute a plan and then wait
// for a typed word, so a `--version` they parsed and did not act on would hang a script asking
// a one-line question.
test('every command answers it, and none of them does anything else first', () => {
  for (const command of ['list', 'serve', 'install', 'uninstall'] as Command[]) {
    const r = run(command, '--version');
    assert.equal(r.status, 0, `tarmac ${command} --version: ${r.stderr}`);
    assert.equal(r.stdout, `${PUBLISHED}\n`, `tarmac ${command} --version printed more than the version`);
  }
});

// A flag every command takes is documented once, in the option list, so the synopsis parity
// check in `cli-help.test.ts` exempts it — and an exemption with nothing behind it is how a
// flag ends up implemented and unfindable, which is the defect that file exists for. Both
// spellings, because the short one is the whole reason a reader looks.
test('--help says it exists, in both spellings', () => {
  const r = run('--help');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}--version, -v {2,}\S/m);
});

// Which of the two wins is arbitrary; that one of them does, and always the same one, is not.
test('--help outranks it, being the wider question', () => {
  const r = run('--help', '--version');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^tarmac — fleet observability/);
});
