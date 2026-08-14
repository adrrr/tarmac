import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { firstWord, quoteArg } from '../src/shell.ts';

// `statusLine.command` is shell source — Claude Code documents that field as running in a
// shell. tarmac both WRITES a path into it and READS one back out of it, so the two
// directions are one pair: anything `quoteArg` can produce, `firstWord` must undo. They
// drifted apart once already (a home with an apostrophe stopped being recognised as its own
// install, and the wrapper chained itself into a fork bomb), so the property is pinned here.
const NASTY = [
  '/plain/path/statusline.sh',
  '/with a space/statusline.sh',
  "/od d's home/statusline.sh",
  '/quotes"inside/statusline.sh',
  '/dollar$HOME/statusline.sh',
  '/back\\slash/statusline.sh',
  '/tilde~/statusline.sh',
  '/semi;colon&&/statusline.sh',
  '/back`tick`/statusline.sh',
  '/new\nline/statusline.sh',
];

for (const path of NASTY) {
  test(`round trip: ${JSON.stringify(path)}`, () => {
    assert.equal(firstWord(quoteArg(path)), path, 'what we write, we read back');
  });

  test(`a real shell agrees the quoting is one argument: ${JSON.stringify(path)}`, () => {
    const seen = execFileSync('/bin/sh', ['-c', `printf '%s' ${quoteArg(path)}`], { encoding: 'utf8' });
    assert.equal(seen, path);
  });
}

test('a path needing no quoting is left alone', () => {
  assert.equal(quoteArg('/usr/local/bin/x.sh'), '/usr/local/bin/x.sh');
});

// Reading is not just unquoting: the field may carry arguments, a redirect, a pipe. The FILE
// that runs is the first word, and that is the only part identity can be decided on.
for (const [command, word] of [
  ['/path/x.sh --quiet', '/path/x.sh'],
  ['  /path/x.sh  ', '/path/x.sh'],
  ['"/path/with space/x.sh" --flag', '/path/with space/x.sh'],
  ["'/path/x.sh' | cat", '/path/x.sh'],
  ['/path/x\\ y.sh', '/path/x y.sh'],
  ['', ''],
] as const) {
  test(`the first word of ${JSON.stringify(command)} is ${JSON.stringify(word)}`, () => {
    assert.equal(firstWord(command), word);
  });
}

// A command we cannot parse is not a command we may guess at: half a quoted string could
// name any file at all, and this answer decides whether tarmac deletes a wrapper.
test('an unbalanced quote yields nothing rather than a guess', () => {
  assert.equal(firstWord("'/path/x.sh"), '');
});
