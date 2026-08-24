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

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { accepts, OPTION_FLAGS } from '../src/args.ts';
import type { Command } from '../src/args.ts';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

const help = (): string => {
  const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

const flagsIn = (s: string): string[] => [...s.matchAll(/--[a-z-]+/g)].map((f) => f[0]);

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
    else if (out.length > 0 && /^\s+\[--/.test(line)) out[out.length - 1].flags.push(...flagsIn(line));
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
 * The flags that are not about a command at all — every command takes them, and repeating
 * them on four synopsis lines would say four times what belongs in the option list once.
 * They are exempt from the check below and from nothing else: the forward direction still
 * holds a synopsis that offers one to the parser that has to accept it.
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
