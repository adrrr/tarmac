// The one command behind the schema guard's advice: capture the fixture PAIR for the
// Claude Code currently installed, so a version tarmac has never seen becomes one it has.
//
//   npm run fixtures:capture
//
// A pair, never one alone: the two surfaces are read by the same tool at the same moment,
// and a repo holding an `agents` capture from one build next to a statusline payload from
// another would let the guard claim a coverage nobody ever verified. Both files are written
// VERBATIM — a fixture that has been reformatted on the way in is not what was received.
//
// Dev tooling: it is not in `files`, so it never ships to npm. Everything it touches is
// redirected by env, which is also how the suite exercises it without going near a real home.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { paths } from '../src/install.ts';
import { extractTelemetry } from '../src/snapshots.ts';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const claudeBin = process.env.TARMAC_CLAUDE_BIN ?? 'claude';
const snapshotsDir = process.env.TARMAC_SNAPSHOTS ?? paths(os.homedir()).snapshots;
const fixturesDir = process.env.TARMAC_FIXTURES ?? path.join(repo, 'fixtures');

function die(message: string): never {
  process.stderr.write(`capture-fixtures: ${message}\n`);
  process.exit(1);
}

// `claude --version` prints e.g. "2.1.226 (Claude Code)".
const versionLine = run([claudeBin, '--version'], `cannot run \`${claudeBin} --version\``);
const version = versionLine.trim().split(/\s+/)[0] ?? '';
// This string becomes a filename. A binary that answers something odd must not be able to
// write outside the fixtures directory.
if (!/^[0-9A-Za-z.+-]+$/.test(version)) die(`could not read a version from: ${versionLine.trim() || '(no output)'}`);

// The statusline side first: it is the one that can be missing, and nothing is written
// until both halves of the pair are in hand.
const payload = newestPayloadFor(version);
if (!payload) {
  die(
    `no statusline snapshot from ${version} under ${snapshotsDir}.\n` +
      `  The pair must come from one build. Run \`tarmac install\`, open a Claude Code session\n` +
      `  on ${version}, let it draw one frame, then run this again.`,
  );
}

const agents = run([claudeBin, 'agents', '--json'], `cannot run \`${claudeBin} agents --json\``);
// "It parsed as JSON" is not "it shows the shape we read". An empty array — no session was
// running when you captured — would freeze this version as verified while not one field
// name was ever observed on that surface, which is the coverage-nobody-checked this whole
// mechanism exists to prevent. Demand the two fields `sessions.ts` actually reads.
let parsed: unknown;
try {
  parsed = JSON.parse(agents);
} catch {
  die('`claude agents --json` did not return JSON — nothing captured');
}
const usable =
  Array.isArray(parsed) &&
  parsed.some((e) => e && typeof e === 'object' && typeof e.sessionId === 'string' && typeof e.status === 'string');
if (!usable) {
  die('`claude agents --json` showed no session carrying `sessionId` and `status` — open a Claude Code session and run this again');
}

// The suffix is the reader's own verdict on the payload, taken from the module that will
// have to read it: `live` (a measured session), `fresh` (booted, no turn yet) or `drift`
// (the shape already moved — the most valuable fixture of the three, and the one a name
// like "live" would bury).
const SUFFIX = { ok: 'live', fresh: 'fresh', drift: 'drift' } as const;
const suffix = SUFFIX[payload.ctxState];
const agentsFile = path.join(fixturesDir, `agents-${version}.json`);
const payloadFile = path.join(fixturesDir, `statusline-payload-${version}-${suffix}.json`);

// Both halves are in memory before either is on disk, and a failure half-way removes what
// it managed to write: a lone `agents-<version>.json` is enough to fail the fixtures test
// with no trace of where it came from.
const written: string[] = [];
try {
  fs.mkdirSync(fixturesDir, { recursive: true });
  for (const [file, bytes] of [
    [agentsFile, Buffer.from(agents)],
    [payloadFile, payload.bytes],
  ] as const) {
    fs.writeFileSync(file, bytes);
    written.push(file);
  }
} catch (e) {
  for (const f of written) fs.rmSync(f, { force: true });
  die(`could not write the pair (${(e as Error).message}) — nothing was left behind`);
}

process.stdout.write(
  `captured Claude Code ${version}\n` +
    `  ${agentsFile}\n` +
    `  ${payloadFile}   (from ${payload.file})\n\n` +
    `Next:\n` +
    `  1. read both files — they carry real cwd paths, session names and costs\n` +
    `  2. add ${version} to CHECKED_VERSIONS in src/schema.ts (the suite fails until you do)\n` +
    `  3. npm test\n` +
    `  4. git add fixtures src/schema.ts && git commit -m "fixtures: Claude Code ${version}"\n`,
);

function run(argv: string[], why: string): string {
  try {
    return execFileSync(argv[0]!, argv.slice(1), { encoding: 'utf8', timeout: 20000 });
  } catch (e) {
    return die(`${why} (${(e as Error).message})`);
  }
}

/** The most recently written snapshot whose payload says it came from `want`. */
function newestPayloadFor(want: string): { file: string; bytes: Buffer; ctxState: 'ok' | 'fresh' | 'drift' } | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(snapshotsDir);
  } catch (e) {
    return die(`cannot read ${snapshotsDir} (${(e as NodeJS.ErrnoException).code})`);
  }
  let best: { file: string; bytes: Buffer; ctxState: 'ok' | 'fresh' | 'drift'; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const file = path.join(snapshotsDir, name);
    try {
      // Read the bytes here, while we are allowed to fail freely: by the time anything is
      // written, both halves of the pair must already be in hand.
      const bytes = fs.readFileSync(file);
      const p = JSON.parse(bytes.toString('utf8')) as Record<string, any>;
      if (p?.version !== want) continue;
      const mtimeMs = fs.statSync(file).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) best = { file, bytes, ctxState: extractTelemetry(p).ctxState, mtimeMs };
    } catch {
      continue; // half-written or corrupt: not a fixture candidate
    }
  }
  return best;
}
