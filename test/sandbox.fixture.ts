// Not part of the suite — the glob is `test/*.test.ts`. This file is the SUBJECT of
// `sandbox.test.ts`, which runs it as a child with a `$TMPDIR` of its own: what a hook does
// after the last test of a file has finished cannot be observed from inside one.
//
// Two sandboxes, and the second one locks itself down, because a cleanup that cannot survive
// a `chmod` fixture would turn a green suite red on its way out — and this suite has several.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './sandbox.ts';

test('takes a sandbox and works in it', () => {
  const dir = tempDir('tarmac-fixture-');
  fs.writeFileSync(path.join(dir, 'a.json'), '{}');
  assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), '{}');
});

test('takes another one and leaves it unreadable behind it', () => {
  const dir = tempDir('tarmac-fixture-');
  fs.mkdirSync(path.join(dir, 'inner'));
  fs.chmodSync(dir, 0o000);
  assert.equal(fs.existsSync(dir), true);
});
