// P4 — configuration. Three numbers in this tool are opinions, not truths: how old a reading
// may be before it is marked stale, which port the dashboard binds, and where the snapshots
// are read from. This module is where they get their values, and — just as important — where
// they remember who gave it to them.
//
// Two rules hold everything else up:
//   1. NOTHING IS SILENT. A value we cannot parse, a key we do not know, a file that is not
//      JSON — each one stops the run and says which knob to go and turn. A dropped setting is
//      a lie about what the tool is doing.
//   2. THE DEFAULTS DO NOT MOVE. With no flag, no environment and no file, every number here
//      is the one that was baked into the source before this module existed.
//
// Pure: no filesystem outside `readConfigFile`, no imports from the rest of the project, so
// the precedence rules can be exercised without a fleet, a home, or a process.

import fs from 'node:fs';

/** Where a value came from, in precedence order. Reported, never inferred by the reader. */
export type Source = 'flag' | 'env' | 'file' | 'default';

export interface Resolved<T> {
  value: T;
  source: Source;
}

/** How to name a source in a sentence, when an error has to say who chose the value. */
export const SOURCE_PHRASE: Record<Source, string> = {
  flag: 'a command-line flag',
  env: 'the environment',
  file: 'the config file',
  default: 'the default',
};

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3600_000 };
const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

/**
 * A human duration — `90s`, `15m`, `2h` — in milliseconds.
 *
 * A bare number is refused on purpose: `600000` is ten minutes in milliseconds and a week in
 * seconds, and choosing for the user is exactly the silent correction this module forbids.
 *
 * @param label how the source spells this setting, so the refusal names the knob to turn
 */
export function parseDuration(text: string, label: string): number {
  const m = DURATION.exec(text.trim());
  const ms = m ? Math.round(Number(m[1]) * UNITS[m[2]]) : NaN;
  // Rounded BEFORE the guard: `0.4ms` clears a `> 0` test and then lands on 0, which marks
  // every reading stale and explains itself with `older than 0h` — a spelling this very
  // parser refuses to read back.
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`${label} must be a positive duration like 90s, 15m or 2h, got: ${text}`);
  }
  return ms;
}

/**
 * A duration back into the units it would have been typed in — the largest one that divides
 * it evenly, so `600000` reads as `10m`. Printed next to every `!`: a threshold nobody can
 * see is a mark nobody can argue with. Round-trips through `parseDuration`.
 */
export function formatDuration(ms: number): string {
  for (const unit of ['h', 'm', 's'] as const) {
    if (ms % UNITS[unit] === 0) return `${ms / UNITS[unit]}${unit}`;
  }
  return `${ms}ms`;
}

/** A TCP port from text. `0` stays legal — it means "pick a free one", which `serve` uses. */
export function parsePort(text: string, label: string): number {
  const trimmed = text.trim();
  const n = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  return checkPort(n, label, text);
}

function checkPort(n: unknown, label: string, shown: unknown = n): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`${label} must be a port number between 0 and 65535, got: ${shown}`);
  }
  return n;
}

/**
 * How many local days of fleet journal to keep on disk, today included.
 *
 * The one setting here whose absence is the product: with no `history` key there is no journal,
 * which is what every install that never asked for one gets. So ZERO is refused rather than read
 * as "off". It is the number a reader reaches for to mean off, and reading it that way would
 * leave a file growing all day under a retention that keeps none of it. Off is the absence of
 * the key, which is also what deleting it does: one way to stop, not two.
 *
 * @param label how the source spells this setting, so the refusal names the knob to turn
 */
export function parseHistoryDays(text: string, label: string): number {
  const trimmed = text.trim();
  return checkHistoryDays(/^\d+$/.test(trimmed) ? Number(trimmed) : NaN, label, text);
}

function checkHistoryDays(n: unknown, label: string, shown: unknown = n): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
    throw new Error(`${label} must be a whole number of days, 1 or more, got: ${format(shown)}`);
  }
  return n;
}

/**
 * The name out of a `Host` header, or out of a setting that has to match one: the port
 * dropped, the brackets of an IPv6 literal dropped with it.
 *
 * Shared with the server's guard so that BOTH sides of that comparison are cut the same way.
 * A normaliser written twice is a guard with two definitions of the same name.
 */
export const hostName = (host: string): string => host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');

/**
 * A host `serve` will answer to besides loopback. Refuses everything that is not a name a
 * `Host` header can carry — a scheme, a path, a wildcard, an IPv6 literal, an empty string —
 * because each of those is accepted at the command line, printed on startup, and then matches
 * nothing at all: a setting the tool appears to have taken and silently never applies.
 *
 * The port is DROPPED rather than refused, and the drop is visible in what `serve` prints. A
 * proxy presents `name:8443` on one setup and a bare `name` on 443, and a list that matched
 * the port would refuse half the setups it was typed for. It costs nothing: the port in a
 * `Host` header is chosen by whoever sends it, so it never barred anybody.
 *
 * @param label how the source spells this setting, so the refusal names the knob to turn
 */
export function parseTrustHost(text: string, label: string): string {
  // Lowered because host names are case-insensitive and browsers send them lowered — a 403
  // over a capital would be a setting typed, accepted, and never matched. It gives nothing
  // away: the name still has to be the one the reader wrote down, character for character.
  const name = hostName(text.trim()).toLowerCase();
  if (!HOST_NAME.test(name)) {
    throw new Error(
      `${label} must be a host name like example.ts.net — no scheme, no path, no wildcard, got: ${format(text)}`,
    );
  }
  return name;
}

/** Letters, digits, dots and dashes, starting and ending on one that is not a dash or a dot. */
const HOST_NAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/** The settings a config file is allowed to carry. Every one of them is optional. */
export interface FileConfig {
  staleAfterMs?: number;
  port?: number;
  snapshotsDir?: string;
  trustHosts?: string[];
  /**
   * Nested, alone among these keys, because it is the one that will grow: the journal has a
   * retention today and the shape leaves room for what a range API needs tomorrow, without a
   * second top-level key called `historyDays` sitting next to it forever.
   */
  history?: { days: number };
}

const KNOWN_KEYS = ['staleAfterMs', 'port', 'snapshotsDir', 'trustHosts', 'history'] as const;

/**
 * `~/.claude/tarmac/config.json`, if there is one.
 *
 * ABSENT IS SILENCE, UNREADABLE IS NOT. No file at all is the zero-config contract and
 * returns `{}`. A file that exists and cannot be read, parsed, or understood stops the run:
 * a settings file that turns out to have been ignored all along is worse than no file.
 */
export function readConfigFile(file: string): FileConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`could not read ${file}: ${(e as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${file} must contain a JSON object with keys ${KNOWN_KEYS.join(', ')}`);
  }

  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).filter((k) => !(KNOWN_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new Error(
      `unknown key(s) in ${file}: ${unknown.join(', ')} — known keys are ${KNOWN_KEYS.join(', ')}`,
    );
  }

  const out: FileConfig = {};
  const where = (key: string): string => `${file}: ${key}`;
  if ('staleAfterMs' in body) {
    const v = body.staleAfterMs;
    // Rounded before the guard, same reason as `parseDuration`: 0.4 ms is not a threshold.
    const ms = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : NaN;
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(`${where('staleAfterMs')} must be a positive number of milliseconds, got: ${format(v)}`);
    }
    out.staleAfterMs = ms;
  }
  if ('port' in body) out.port = checkPort(body.port, where('port'), format(body.port));
  if ('snapshotsDir' in body) {
    const v = body.snapshotsDir;
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`${where('snapshotsDir')} must be a non-empty path, got: ${format(v)}`);
    }
    out.snapshotsDir = v;
  }
  if ('trustHosts' in body) {
    const v = body.trustHosts;
    if (!Array.isArray(v)) {
      throw new Error(`${where('trustHosts')} must be an array of host names, got: ${format(v)}`);
    }
    out.trustHosts = v.map((h) => {
      if (typeof h !== 'string') {
        throw new Error(`${where('trustHosts')} must be an array of host names, got: ${format(h)}`);
      }
      // The same parser the flag and the environment go through: a host is refused, and kept,
      // in the same words wherever it was written down.
      return parseTrustHost(h, where('trustHosts'));
    });
  }
  if ('history' in body) {
    const v = body.history;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new Error(`${where('history')} must be an object like {"days": 30}, got: ${format(v)}`);
    }
    const inner = v as Record<string, unknown>;
    const unknownInner = Object.keys(inner).filter((k) => k !== 'days');
    if (unknownInner.length > 0) {
      throw new Error(
        `unknown key(s) in ${file}: ${unknownInner.map((k) => `history.${k}`).join(', ')} (the only key of history is days)`,
      );
    }
    // An unfinished key, not an off switch. `"history": {}` reads as a setting the tool took
    // and silently never applied, which is the one thing this module exists to prevent.
    if (!('days' in inner)) {
      throw new Error(
        `${where('history.days')} must be set to a whole number of days; remove the history key to keep nothing on disk`,
      );
    }
    out.history = { days: checkHistoryDays(inner.days, where('history.days')) };
  }
  return out;
}

/**
 * Values come back from JSON as anything; the refusal has to be able to show them all —
 * including the empty string, which as bare text turns `got: ` into a message that reads
 * like the message itself is broken.
 */
const format = (v: unknown): string =>
  v === '' ? '(empty)' : typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);

// ── resolution ──────────────────────────────────────────────────────────────────────────

/**
 * A snapshot is written at every TUI frame, so its age is the age of the READING. An idle
 * session redraws rarely: its number is not wrong, but it is "as of" hours ago, and must not
 * render identically to one measured a minute ago. Threshold, not truth — hence settable.
 */
export const DEFAULT_STALE_AFTER_MS = 10 * 60_000;
export const DEFAULT_PORT = 4477;

export interface Config {
  staleAfterMs: Resolved<number>;
  port: Resolved<number>;
  snapshotsDir: Resolved<string>;
  /** Empty is the default and the product: loopback, and nothing else. */
  trustHosts: Resolved<string[]>;
  /**
   * How many days of fleet journal `serve` keeps on disk. `null` is the default and the
   * product: nothing is written down, which is what the README promises everyone who never
   * asked otherwise.
   */
  historyDays: Resolved<number | null>;
}

export interface ResolveInput {
  /**
   * What the command line said. `null` means the flag was not passed at all — except for
   * the repeatable one, where an empty list says it and no value can be confused with it:
   * `--trust-host` cannot be typed to mean "none".
   */
  flags: {
    staleAfter: string | null;
    port: number | null;
    snapshotsDir: string | null;
    trustHosts: string[];
    historyDays: number | null;
  };
  env: Record<string, string | undefined>;
  file: FileConfig;
  /**
   * Where the payloads land with nothing configured. Supplied by the caller, which is what
   * knows the home — and, more importantly, what can read the path out of the INSTALLED
   * wrapper. Recomputing it here from an environment would let a reader and a writer that
   * see different environments disagree in silence.
   */
  defaultSnapshotsDir: string;
}

/**
 * Flag beats environment beats file beats default, settled INDEPENDENTLY per setting: a port
 * pinned in the file and a threshold tightened for one run is the normal case, not an edge.
 */
export function resolveConfig({ flags, env, file, defaultSnapshotsDir }: ResolveInput): Config {
  // EVERY rung is parsed, including the ones about to lose. `readConfigFile` already refuses
  // a bad key whoever wins; an environment that were only checked when it happens to win
  // would make a stale TARMAC_STALE_AFTER in a shell profile break `tarmac list` on its own
  // and pass the moment a flag is added — a setting silently dropped, which is the one thing
  // this module exists to prevent.
  const staleAfterEnv = parseIfSet(env.TARMAC_STALE_AFTER, (v) => parseDuration(v, 'TARMAC_STALE_AFTER'));
  const portEnv = parseIfSet(env.TARMAC_PORT, (v) => parsePort(v, 'TARMAC_PORT'));
  const dirEnv = read(env.TARMAC_SNAPSHOTS_DIR);
  // Comma-separated, which a host name cannot contain — so the list needs no quoting rule of
  // its own, and an empty item between two commas is refused rather than skipped.
  const trustEnv = parseIfSet(env.TARMAC_TRUST_HOST, (v) =>
    v.split(',').map((h) => parseTrustHost(h, 'TARMAC_TRUST_HOST')),
  );
  const historyEnv = parseIfSet(env.TARMAC_HISTORY_DAYS, (v) => parseHistoryDays(v, 'TARMAC_HISTORY_DAYS'));

  return {
    staleAfterMs:
      flags.staleAfter !== null
        ? { value: parseDuration(flags.staleAfter, '--stale-after'), source: 'flag' }
        : staleAfterEnv !== null
          ? { value: staleAfterEnv, source: 'env' }
          : file.staleAfterMs !== undefined
            ? { value: file.staleAfterMs, source: 'file' }
            : { value: DEFAULT_STALE_AFTER_MS, source: 'default' },
    port:
      flags.port !== null
        ? { value: flags.port, source: 'flag' }
        : portEnv !== null
          ? { value: portEnv, source: 'env' }
          : file.port !== undefined
            ? { value: file.port, source: 'file' }
            : { value: DEFAULT_PORT, source: 'default' },
    snapshotsDir:
      flags.snapshotsDir !== null
        ? { value: flags.snapshotsDir, source: 'flag' }
        : dirEnv !== null
          ? { value: dirEnv, source: 'env' }
          : file.snapshotsDir !== undefined
            ? { value: file.snapshotsDir, source: 'file' }
            : { value: defaultSnapshotsDir, source: 'default' },
    // The winning rung is the WHOLE list, like every other setting here. Adding the four
    // together would leave nobody able to narrow, for one run, a list a config file widened —
    // and this is the one setting where widening is the whole of the risk.
    trustHosts:
      flags.trustHosts.length > 0
        ? { value: flags.trustHosts, source: 'flag' }
        : trustEnv !== null
          ? { value: trustEnv, source: 'env' }
          : file.trustHosts !== undefined
            ? { value: file.trustHosts, source: 'file' }
            : { value: [], source: 'default' },
    // The only default here that is not a number: no key anywhere means no journal, and that
    // is the behaviour every install had before this setting existed.
    historyDays:
      flags.historyDays !== null
        ? { value: flags.historyDays, source: 'flag' }
        : historyEnv !== null
          ? { value: historyEnv, source: 'env' }
          : file.history !== undefined
            ? { value: file.history.days, source: 'file' }
            : { value: null, source: 'default' },
  };
}

/**
 * An empty environment variable is UNSET, not an empty value: `TARMAC_PORT= tarmac serve` is
 * how a shell wrapper says "never mind", and refusing it there would break scripts that clear
 * their own environment. The only place in this module where absence is inferred.
 */
const read = (v: string | undefined): string | null => (v === undefined || v.trim() === '' ? null : v);

/** Parse a variable that is set — win or lose — so a bad value is never carried in silence. */
function parseIfSet<T>(raw: string | undefined, parse: (v: string) => T): T | null {
  const v = read(raw);
  return v === null ? null : parse(v);
}
