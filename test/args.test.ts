// The commands the parser accepts, against the matrix that says what each one takes.
//
// `parseArgs` checked argv[0] against a list of its own while `ACCEPTS` was written out
// separately, and nothing tied the two together. A name in the first and not the second was
// not refused: the parser took it, and the first flag after it read `.has` off `undefined` —
// `tarmac doctor --json` answered `Cannot read properties of undefined` where every other
// typo gets one line naming what was not understood, and `tarmac doctor` on its own printed
// the `list` table, silently, the dispatch in cli.ts ending in an `else` (#149).
//
// Both directions are checked here, because the two lists could drift either way and the
// halves fail differently: a command missing from the parser's list is refused although the
// help offers it, one missing from the matrix is a crash.

import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_NAMES, parseArgs } from '../src/args.ts';

// The direction a new command breaks: added to the matrix, to `--help` and to the docs, and
// not to whatever the parser checks argv[0] against — where it is a command the help
// describes and the CLI refuses.
test('every command the matrix names is one the parser accepts', () => {
  assert.ok(COMMAND_NAMES.length > 0, 'no commands to check — the failures below would blame the parser for an empty matrix');
  for (const command of COMMAND_NAMES) {
    assert.equal(parseArgs([command]).command, command, `the matrix carries \`${command}\` and the parser refuses it`);
  }
});

// The direction #149 was about, and the flag is what makes this the test that defect needed:
// a command the parser accepts with no matrix behind it does not fail on the command, it
// fails on the next argument, with a TypeError nobody can act on. `toString` is in the list
// because the matrix is an object: asked with `in` rather than for an own key, every name on
// `Object.prototype` is a command.
test('a name the matrix does not carry is refused, whatever follows it', () => {
  for (const name of ['doctor', 'List', 'lists', 'toString', 'constructor']) {
    assert.throws(
      () => parseArgs([name, '--json']),
      new RegExp(`^Error: unknown command: ${name}$`),
      `\`tarmac ${name}\` is not a command and the parser did not say so`,
    );
  }
});
