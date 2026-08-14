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

/** The settings a config file is allowed to carry. Every one of them is optional. */
export interface FileConfig {
  staleAfterMs?: number;
  port?: number;
  snapshotsDir?: string;
}

const KNOWN_KEYS = ['staleAfterMs', 'port', 'snapshotsDir'] as const;

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
}

export interface ResolveInput {
  /** What the command line said. `null` means the flag was not passed at all. */
  flags: { staleAfter: string | null; port: number | null; snapshotsDir: string | null };
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
