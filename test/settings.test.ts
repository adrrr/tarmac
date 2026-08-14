import test from 'node:test';
import assert from 'node:assert/strict';
import { chainStatusLine, unchainStatusLine } from '../src/settings.ts';

const WRAPPER = '/home/u/.claude/tarmac/statusline.sh';

test('installs a statusLine when the settings have none', () => {
  const { settings, previous, alreadyInstalled } = chainStatusLine({ model: 'opus' }, WRAPPER);
  assert.equal(alreadyInstalled, false);
  assert.equal(previous, null);
  assert.deepEqual(settings.statusLine, { type: 'command', command: WRAPPER });
  assert.equal(settings.model, 'opus', 'unrelated keys survive');
});

test('wraps an existing command statusLine and hands back the original', () => {
  const original = { type: 'command', command: '~/.claude/statusline.sh' };
  const { settings, previous } = chainStatusLine({ statusLine: original }, WRAPPER);
  assert.deepEqual(previous, original);
  assert.deepEqual(settings.statusLine, { type: 'command', command: WRAPPER });
});

test('preserves extra keys of the wrapped statusLine in the returned original', () => {
  const original = { type: 'command', command: 'x', padding: 0 };
  const { previous } = chainStatusLine({ statusLine: original }, WRAPPER);
  assert.equal(previous!.padding, 0);
});

test('does not mutate the settings object it is given', () => {
  const input = { statusLine: { type: 'command', command: 'x' } };
  chainStatusLine(input, WRAPPER);
  assert.equal(input.statusLine.command, 'x');
});

// The failure that would make the whole product a liar: wrapping our own wrapper, losing
// the user's real statusline behind a chain that points at itself.
test('a second install is a no-op — it never wraps the wrapper', () => {
  const first = chainStatusLine({ statusLine: { type: 'command', command: 'real.sh' } }, WRAPPER);
  const second = chainStatusLine(first.settings, WRAPPER);
  assert.equal(second.alreadyInstalled, true);
  assert.equal(second.previous, null, 'no new original to record');
  assert.deepEqual(second.settings.statusLine, { type: 'command', command: WRAPPER });
});

// C2: two spellings of the same file (/tmp vs /private/tmp, a bind mount, a moved sandbox)
// must not read as "someone else's statusline", or tarmac wraps itself and recurses at
// every TUI frame. Identity is decided by a caller-supplied comparator, never by string ==.
test('recognises its own wrapper under a different spelling of the same path', () => {
  const sameFile = (a: string, b: string) => a.replace('/private', '') === b.replace('/private', '');
  const settings = { statusLine: { type: 'command', command: '/private/tmp/h/.claude/tarmac/statusline.sh' } };
  const res = chainStatusLine(settings, '/tmp/h/.claude/tarmac/statusline.sh', { isSameCommand: sameFile });
  assert.equal(res.alreadyInstalled, true);
  assert.equal(res.previous, null);
});

// I6: everything else on the statusLine object is the user's display config (`padding: 0`
// is flush-left). Dropping it changes what they see — which is what chaining promises not
// to do.
test('keeps the other statusLine keys when it swaps the command', () => {
  const { settings } = chainStatusLine({ statusLine: { type: 'command', command: 'x', padding: 0 } }, WRAPPER);
  assert.equal(settings.statusLine.padding, 0);
  assert.equal(settings.statusLine.command, WRAPPER);
});

test('refuses to replace a statusLine shape it does not understand', () => {
  assert.throws(
    () => chainStatusLine({ statusLine: { type: 'plugin', id: 'x' } }, WRAPPER),
    /unrecognised statusLine/,
  );
});

test('refuses a command statusLine with no command string', () => {
  assert.throws(() => chainStatusLine({ statusLine: { type: 'command' } }, WRAPPER), /unrecognised statusLine/);
});

test('restores the previous statusLine exactly', () => {
  const original = { type: 'command', command: 'real.sh', padding: 0 };
  const { settings, previous } = chainStatusLine({ model: 'opus', statusLine: original }, WRAPPER);
  const { settings: restored, restored: didRestore } = unchainStatusLine(settings, previous, WRAPPER);
  assert.equal(didRestore, true);
  assert.deepEqual(restored, { model: 'opus', statusLine: original });
});

test('restoring to "there was none" removes the key entirely', () => {
  const { settings } = chainStatusLine({ model: 'opus' }, WRAPPER);
  const { settings: restored } = unchainStatusLine(settings, null, WRAPPER);
  assert.deepEqual(restored, { model: 'opus' });
  assert.equal('statusLine' in restored, false);
});

// C3: refusing to touch a foreign statusLine is right — but the caller must LEARN that
// nothing was restored, or it deletes the wrapper that line still points at.
test('restore leaves a foreign statusLine alone and says it restored nothing', () => {
  const settings = { statusLine: { type: 'command', command: 'someone-else.sh' } };
  const { settings: out, restored } = unchainStatusLine(settings, { type: 'command', command: 'real.sh' }, WRAPPER);
  assert.equal(restored, false);
  assert.deepEqual(out.statusLine, { type: 'command', command: 'someone-else.sh' });
});
