import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { confirmTyped } from '../src/prompt.ts';

/** A stdin with a canned answer, and a stdout we can read back. */
function io(answer?: string): { input: PassThrough; output: PassThrough; said: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let said = '';
  output.on('data', (b: Buffer) => {
    said += b.toString();
  });
  if (answer === undefined) input.end();
  else input.end(answer);
  return { input, output, said: () => said };
}

// A typed word, not `y`. The whole point of the confirmation is that it cannot be crossed
// by the keystroke someone was already about to press.
test('proceeds when the word is typed exactly', async () => {
  const { input, output } = io('install\n');
  assert.equal(await confirmTyped({ word: 'install', input, output, isTTY: true, yes: false }), true);
});

test('surrounding whitespace is forgiven', async () => {
  const { input, output } = io('  install  \n');
  assert.equal(await confirmTyped({ word: 'install', input, output, isTTY: true, yes: false }), true);
});

for (const answer of ['y\n', 'yes\n', 'INSTALL\n', 'instal\n', '\n', 'uninstall\n']) {
  test(`refuses ${JSON.stringify(answer)} — it is not the word`, async () => {
    const { input, output } = io(answer);
    assert.equal(await confirmTyped({ word: 'install', input, output, isTTY: true, yes: false }), false);
  });
}

test('a stdin that closes without an answer is not consent', async () => {
  const { input, output } = io();
  assert.equal(await confirmTyped({ word: 'install', input, output, isTTY: true, yes: false }), false);
});

test('the prompt says which word to type', async () => {
  const { input, output, said } = io('install\n');
  await confirmTyped({ word: 'install', input, output, isTTY: true, yes: false });
  assert.match(said(), /install/);
});

// A pipe cannot be asked anything, and a tool that reads consent from an unanswerable
// prompt would take EOF for a yes. CI and scripts have to say so on the command line.
test('refuses a stdin that is not a terminal, and names the flag that would allow it', async () => {
  const { input, output } = io('install\n');
  await assert.rejects(
    () => confirmTyped({ word: 'install', input, output, isTTY: false, yes: false }),
    /--yes/,
  );
});

test('--yes proceeds without a terminal, and without asking anything', async () => {
  const { input, output, said } = io();
  assert.equal(await confirmTyped({ word: 'install', input, output, isTTY: false, yes: true }), true);
  assert.equal(said(), '', 'nothing was asked');
});
