// Tiny argv parser. `node:util.parseArgs` would do, but a hand-rolled one keeps the error
// messages actionable and the surface exactly as wide as the commands we support.
//
// Unknown options and unknown commands are ERRORS. A typo silently ignored is how someone
// ends up believing they pointed tarmac at a directory it never read.

import { parsePort } from './config.ts';

export type Command = 'list' | 'serve' | 'install' | 'uninstall' | 'help';

export interface Options {
  command: Command;
  /**
   * `null` means "not passed", never "passed the default". The distinction is the whole of
   * the precedence rule: `--port 4477` has to be able to outrank a port set in the config
   * file, and it cannot if the parser has already filled the field in with 4477 itself.
   */
  port: number | null;
  /** Verbatim, e.g. `90s` — one parser owns what a duration means, and it is not this one. */
  staleAfter: string | null;
  snapshotsDir: string | null;
  home: string | null;
  claudeBin: string;
  json: boolean;
  /** `list`, redrawn on an interval until Ctrl-C, instead of printed once. */
  watch: boolean;
  /** Skip the typed confirmation on install/uninstall. Opt-in, never implied. */
  yes: boolean;
  help: boolean;
}

type OptionKey = Exclude<keyof Options, 'command'>;
type FlagKey = 'json' | 'watch' | 'yes' | 'help';
type StringKey = 'staleAfter' | 'snapshotsDir' | 'home' | 'claudeBin';

const COMMANDS = new Set<string>(['list', 'serve', 'install', 'uninstall', 'help']);

// `| undefined` is load-bearing, not decoration: without it the compiler types the lookup
// below as always-present and the `if (!key) throw` guard reads as dead code — which is how
// a future cleanup deletes the one thing standing between a typo and a silently ignored flag.
const OPTIONS: Record<string, OptionKey | undefined> = {
  '--port': 'port',
  '--stale-after': 'staleAfter',
  '--snapshots-dir': 'snapshotsDir',
  '--home': 'home',
  '--claude-bin': 'claudeBin',
  '--json': 'json',
  '--watch': 'watch',
  '--yes': 'yes',
  '--help': 'help',
};
const FLAGS = new Set<OptionKey>(['json', 'watch', 'yes', 'help']);

/**
 * Which options each command really reads. The doc-comment above refuses a flag nobody
 * implements; this refuses a flag THIS command does not implement, which is the same defect
 * one level down — `tarmac serve --json` parsed cleanly and changed nothing, and from the
 * outside that is indistinguishable from a server that decided to answer HTML anyway.
 *
 * `help` is in every set on purpose: `--help` is answerable whatever else was typed.
 */
const ACCEPTS: Record<Command, ReadonlySet<OptionKey>> = {
  list: new Set<OptionKey>(['staleAfter', 'snapshotsDir', 'home', 'claudeBin', 'json', 'watch', 'help']),
  serve: new Set<OptionKey>(['port', 'staleAfter', 'snapshotsDir', 'home', 'claudeBin', 'help']),
  install: new Set<OptionKey>(['home', 'yes', 'help']),
  uninstall: new Set<OptionKey>(['home', 'yes', 'help']),
  help: new Set<OptionKey>(['help']),
};

/** The commands a misplaced flag would have been right on — an error that points somewhere. */
function ownersOf(key: OptionKey): string {
  return (Object.keys(ACCEPTS) as Command[]).filter((c) => c !== 'help' && ACCEPTS[c].has(key)).join(', ');
}

/** Every flag this parser knows, so a documentation check can enumerate rather than guess. */
export const OPTION_FLAGS: readonly string[] = Object.keys(OPTIONS);

/**
 * Does `command` read `flag`? Exported for the test that holds `--help` to this matrix:
 * asking the parser is the only way to check that does not go through the wording of an
 * error message, which a reword would silently turn into a test that greens on everything.
 */
export function accepts(command: Command, flag: string): boolean {
  const key = OPTIONS[flag];
  return key !== undefined && ACCEPTS[command].has(key);
}

export function parseArgs(argv: string[]): Options {
  const out: Options = { command: 'list', port: null, staleAfter: null, snapshotsDir: null, home: null, claudeBin: 'claude', json: false, watch: false, yes: false, help: false };
  let i = 0;

  if (argv[0] && !argv[0].startsWith('-')) {
    if (!COMMANDS.has(argv[0])) throw new Error(`unknown command: ${argv[0]}`);
    out.command = argv[0] as Command;
    i = 1;
  }

  for (; i < argv.length; i++) {
    const [flag, inline] = splitInline(argv[i]);
    const key = OPTIONS[flag];
    if (!key) throw new Error(`unknown option: ${flag}`);
    if (!ACCEPTS[out.command].has(key))
      throw new Error(`${flag} is not an option of \`tarmac ${out.command}\` — it belongs to: ${ownersOf(key)}`);
    if (FLAGS.has(key)) {
      out[key as FlagKey] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    // An EMPTY value is no value: `--snapshots-dir=` used to sail through as an empty path,
    // and the fleet then read the process's cwd and reported a calm "nothing is chained".
    // The config file has always refused an empty path; the flags refuse it in the same words.
    if (value === undefined || value.trim() === '') throw new Error(`${flag} needs a value`);
    if (key === 'port') {
      // Same validator the environment and the config file go through, so a port is refused
      // in the same words wherever it was set.
      out.port = parsePort(value, '--port');
    } else {
      out[key as StringKey] = value;
    }
  }
  return out;
}

function splitInline(arg: string): [string, string | null] {
  const eq = arg.indexOf('=');
  return eq === -1 ? [arg, null] : [arg.slice(0, eq), arg.slice(eq + 1)];
}
