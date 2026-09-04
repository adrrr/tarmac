// Tiny argv parser. `node:util.parseArgs` would do, but a hand-rolled one keeps the error
// messages actionable and the surface exactly as wide as the commands we support.
//
// Unknown options and unknown commands are ERRORS. A typo silently ignored is how someone
// ends up believing they pointed tarmac at a directory it never read.

import { parseHistoryDays, parsePort, parseTrustHost } from './config.ts';

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
  /**
   * The hosts `serve` answers to besides loopback, one `--trust-host` each. A list rather
   * than a `null`, and the only option here that repeats: no value can be typed to mean
   * "none", so empty says "not passed" without ambiguity.
   */
  trustHost: string[];
  /**
   * How many days of fleet journal `serve` keeps on disk. `null` means "not passed", and with
   * nothing set anywhere that is a journal that does not exist rather than one of length zero.
   */
  historyDays: number | null;
  home: string | null;
  claudeBin: string;
  json: boolean;
  /** `list`, redrawn on an interval until Ctrl-C, instead of printed once. */
  watch: boolean;
  /** Skip the typed confirmation on install/uninstall. Opt-in, never implied. */
  yes: boolean;
  /**
   * `serve` an invented fleet instead of this machine's. No `claude`, no snapshots, no journal,
   * and nothing written anywhere; the page it serves says on itself that the fleet is a demo.
   */
  demo: boolean;
  help: boolean;
  /** Print the version and leave, answerable on any command exactly as `help` is. */
  version: boolean;
}

type OptionKey = Exclude<keyof Options, 'command'>;
type FlagKey = 'json' | 'watch' | 'yes' | 'demo' | 'help' | 'version';
type StringKey = 'staleAfter' | 'snapshotsDir' | 'home' | 'claudeBin';
type ListKey = 'trustHost';

const COMMANDS = new Set<string>(['list', 'serve', 'install', 'uninstall', 'help']);

// `| undefined` is load-bearing, not decoration: without it the compiler types the lookup
// below as always-present and the `if (!key) throw` guard reads as dead code — which is how
// a future cleanup deletes the one thing standing between a typo and a silently ignored flag.
const OPTIONS: Record<string, OptionKey | undefined> = {
  '--port': 'port',
  '--stale-after': 'staleAfter',
  '--snapshots-dir': 'snapshotsDir',
  '--trust-host': 'trustHost',
  '--history-days': 'historyDays',
  '--home': 'home',
  '--claude-bin': 'claudeBin',
  '--json': 'json',
  '--watch': 'watch',
  '--yes': 'yes',
  '--demo': 'demo',
  '--help': 'help',
  '--version': 'version',
  // The one short spelling this parser knows, and it is here because it is what people type
  // before they read anything (#110). No other flag gets one: a letter is a scarce name, and
  // `-h` for help would be the next request and the one after that.
  '-v': 'version',
};
const FLAGS = new Set<OptionKey>(['json', 'watch', 'yes', 'demo', 'help', 'version']);
/** Options that ACCUMULATE rather than overwrite — passed twice, both values are kept. */
const LISTS = new Set<OptionKey>(['trustHost']);

/**
 * Which options each command really reads. The doc-comment above refuses a flag nobody
 * implements; this refuses a flag THIS command does not implement, which is the same defect
 * one level down — `tarmac serve --json` parsed cleanly and changed nothing, and from the
 * outside that is indistinguishable from a server that decided to answer HTML anyway.
 *
 * `help` is in every set on purpose: `--help` is answerable whatever else was typed, and
 * `version` is there for the same reason — what build this is does not depend on the verb.
 */
const ACCEPTS: Record<Command, ReadonlySet<OptionKey>> = {
  list: new Set<OptionKey>(['staleAfter', 'snapshotsDir', 'home', 'claudeBin', 'json', 'watch', 'help', 'version']),
  serve: new Set<OptionKey>(['port', 'staleAfter', 'snapshotsDir', 'trustHost', 'historyDays', 'home', 'claudeBin', 'demo', 'help', 'version']),
  install: new Set<OptionKey>(['home', 'yes', 'help', 'version']),
  uninstall: new Set<OptionKey>(['home', 'yes', 'help', 'version']),
  help: new Set<OptionKey>(['help', 'version']),
};

/** The commands a misplaced flag would have been right on — an error that points somewhere. */
function ownersOf(key: OptionKey): string {
  return (Object.keys(ACCEPTS) as Command[]).filter((c) => c !== 'help' && ACCEPTS[c].has(key)).join(', ');
}

/** Every flag this parser knows, so a documentation check can enumerate rather than guess. */
export const OPTION_FLAGS: readonly string[] = Object.keys(OPTIONS);

/** Every command it knows, from the same matrix, and for the same reason one level up. */
export const COMMAND_NAMES: readonly Command[] = Object.keys(ACCEPTS) as Command[];

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
  const out: Options = { command: 'list', port: null, staleAfter: null, snapshotsDir: null, trustHost: [], historyDays: null, home: null, claudeBin: 'claude', json: false, watch: false, yes: false, demo: false, help: false, version: false };
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
    } else if (key === 'historyDays') {
      // Same validator the environment and the config file go through, so a retention is
      // refused in the same words wherever it was set.
      out.historyDays = parseHistoryDays(value, '--history-days');
    } else if (LISTS.has(key)) {
      // Same rule, for the same reason — and the value is kept as the guard will compare it,
      // so what `serve` prints on startup is what it will actually match against.
      out[key as ListKey].push(parseTrustHost(value, flag));
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
