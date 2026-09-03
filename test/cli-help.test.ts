// `--help` against the parser it describes.
//
// Help text is documentation that lives one file away from the code it documents, and the
// two drifted: `--home` chooses whose `.claude` every command reads, and the synopsis showed
// it on `install` and `uninstall` only — so the flag that makes `list` and `serve` usable
// against another home was, for a reader of `--help`, a flag that did not exist.
//
// These run the real binary and check its output against the real parser, in both
// directions: nothing is offered that would be refused, and nothing a command accepts goes
// unmentioned on it. The check asks the parser (`accepts`) rather than reading the wording
// of its refusals — an error message someone rewords must not turn this into a test that
// greens on everything.
//
// A flag every command takes is exempt from the second direction, on the grounds that the
// option list documents it once. A third check holds the exemption to those grounds, so it
// cannot go on excusing a flag no list names — which is where `--help` itself sat (#113).
//
// The option list is then held to the parser in the same two directions the synopsis is, the
// last check below covering the one those three leave open: a flag the list describes and the
// parser has never heard of refuses the reader who typed what the help told them to.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { accepts, COMMAND_NAMES, OPTION_FLAGS } from '../src/args.ts';
import type { Command } from '../src/args.ts';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

const help = (): string => {
  const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

/**
 * The flags a line names. Short spellings count: matching `--` only left `-v` invisible in both
 * directions — a synopsis line could offer `-x` to a parser that refuses it and nothing here
 * would look (#113).
 *
 * The lookbehind is what keeps that widening honest. `-[a-z]` on its own matches inside any
 * hyphenated word, so `one-shot` in a description would read as a flag named `-shot`.
 */
const flagsIn = (s: string): string[] => [...s.matchAll(/(?<![\w-])--?[a-z][a-z-]*/g)].map((f) => f[0]);

// Both directions below rest on this regex, and neither would notice it reading wrong: a flag
// it cannot see is a flag nothing checks, which is the silence this file exists to break.
test('a flag is read in either spelling, and a hyphenated word is not one', () => {
  assert.deepEqual(flagsIn('[--home DIR] [-v]'), ['--home', '-v']);
  assert.deepEqual(flagsIn('one-shot fleet table — with --watch'), ['--watch']);
});

/**
 * The synopsis block: `  tarmac <command> …`, plus the indented `[--flag]` continuation
 * lines under it. Four commands times every option they take does not fit on four lines of
 * an 80-column terminal, and a synopsis that wraps must not become a synopsis this check
 * reads half of.
 */
function synopsis(text: string): Array<{ command: string; flags: string[] }> {
  const out: Array<{ command: string; flags: string[] }> = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^ {2}tarmac (\w+)\s+(.*)$/);
    if (m) out.push({ command: m[1], flags: flagsIn(m[2]) });
    else if (out.length > 0 && /^\s+\[-/.test(line)) out[out.length - 1].flags.push(...flagsIn(line));
  }
  return out;
}

test('every flag the synopsis offers is one that command really accepts', () => {
  const text = help();
  const lines = synopsis(text);
  assert.ok(lines.length >= 4, `the synopsis was not found in --help:\n${text}`);
  for (const { command, flags } of lines) {
    for (const flag of flags) {
      assert.ok(accepts(command as Command, flag), `--help offers \`${flag}\` on \`tarmac ${command}\`, and the parser refuses it`);
    }
  }
});

/**
 * The option list: `  --flag[, -x]   what it does`, the block under the synopsis where a flag
 * is described once. Two spaces of indent and at least two before the description is what
 * tells it apart from the synopsis lines above, which are indented the same and continue with
 * a command rather than a flag.
 */
function optionList(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^ {2}(-\S+(?:, -\S+)*) {2,}\S/);
    if (m) out.push(...flagsIn(m[1]));
  }
  return out;
}

/**
 * The flags that are not about a command at all — every command takes them, and repeating
 * them on four synopsis lines would say four times what belongs in the option list once.
 * They are exempt from the check below and from nothing else: the forward direction still
 * holds a synopsis that offers one to the parser that has to accept it, and the option-list
 * check that follows holds the exemption itself to the sentence above.
 */
const ANSWERED_EVERYWHERE = new Set(['--help', '--version', '-v']);

// The other direction, and the one that matters more: a flag the parser takes and the help
// never mentions is a feature nobody can find. `--home` was in that state on `list` and
// `serve`; `--claude-bin` was in it on both, with no synopsis line at all — which the
// forward check above is structurally incapable of noticing.
test('every flag a command accepts is shown on that command in --help', () => {
  const shown = new Map<string, string[]>();
  for (const { command, flags } of synopsis(help())) {
    shown.set(command, [...(shown.get(command) ?? []), ...flags]);
  }
  for (const [command, flags] of shown) {
    for (const flag of OPTION_FLAGS) {
      if (ANSWERED_EVERYWHERE.has(flag) || !accepts(command as Command, flag)) continue;
      assert.ok(flags.includes(flag), `\`tarmac ${command}\` accepts ${flag} and no synopsis line for it says so`);
    }
  }
});

// The check above reads its list of commands out of the help text, so a command the parser
// gained and the synopsis never mentioned is not held to that direction — it is skipped, in
// silence, which is the `--claude-bin` story one level up (#125). `help` is the exception the
// help text itself makes: it is the command you get by typing nothing, and it offers nothing
// to describe on a line of its own.
test('every command the parser accepts has a synopsis line to be checked on', () => {
  const shown = new Set(synopsis(help()).map((s) => s.command));
  for (const command of COMMAND_NAMES) {
    if (command === 'help') continue;
    assert.ok(shown.has(command), `the parser accepts \`tarmac ${command}\` and --help shows no synopsis line for it`);
  }
});

// The exemption above is a claim, and until #113 nothing held it: `--version, -v` has been
// named in the option list since #110, `--help` was named in no option list and on no synopsis
// line at all — the flag a reader reaches for before any other, absent from the help's own
// account of itself, and hidden from the check above by the set that excuses it.
test('every flag the synopsis is excused from naming is named in the option list', () => {
  const listed = optionList(help());
  assert.ok(listed.length > 0, 'no option list found in --help — the failures below would blame the flags for an extractor that read none');
  for (const flag of ANSWERED_EVERYWHERE) {
    assert.ok(
      listed.includes(flag),
      `\`${flag}\` is exempt from the synopsis check because the option list documents it, and the option list does not name it`,
    );
  }
});

// The other direction on the option list, which nothing above asks: the synopsis checks cover
// the flags a synopsis line offers, and a description under it is read by neither. A typo there
// (`--hom` for `--home`) or a flag that never shipped costs the reader an exit 1 on a spelling
// the help itself handed them, and every test in this file stays green.
test('every flag the option list names is one the parser knows', () => {
  const listed = optionList(help());
  assert.ok(listed.length > 0, 'no option list found in --help');
  for (const flag of listed) {
    assert.ok(OPTION_FLAGS.includes(flag), `the option list documents \`${flag}\` and the parser has never heard of it`);
  }
});
