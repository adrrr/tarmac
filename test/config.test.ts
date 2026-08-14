// P4 — configuration: what a value is, where it came from, and what happens when it is wrong.
//
// The three settings are opinions, so they are settable. The rule this suite exists to hold
// is that a setting is never *silently* anything: a bad value stops the run and names itself,
// and a good one remembers which of the four sources it came from.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PORT,
  DEFAULT_STALE_AFTER_MS,
  formatDuration,
  parseDuration,
  parsePort,
  readConfigFile,
  resolveConfig,
} from '../src/config.ts';
import type { FileConfig } from '../src/config.ts';

test('a duration is read in the units a human writes', () => {
  assert.equal(parseDuration('90s', '--stale-after'), 90_000);
  assert.equal(parseDuration('15m', '--stale-after'), 15 * 60_000);
  assert.equal(parseDuration('2h', '--stale-after'), 2 * 3600_000);
  assert.equal(parseDuration('500ms', '--stale-after'), 500);
});

test('a fractional duration is allowed and lands on a whole millisecond', () => {
  assert.equal(parseDuration('1.5h', '--stale-after'), 5_400_000);
});

test('a bare number is refused rather than guessed at', () => {
  // 600000 is ten minutes in ms and a week in seconds. Picking one for the user is the
  // silent correction this whole module exists to refuse.
  assert.throws(() => parseDuration('600000', '--stale-after'), /--stale-after.*90s.*600000/s);
});

test('a duration of zero or less is refused, threshold or not', () => {
  assert.throws(() => parseDuration('0s', '--stale-after'), /--stale-after/);
  assert.throws(() => parseDuration('-5m', '--stale-after'), /--stale-after/);
});

// A duration that survives the guard and then rounds to nothing is worse than one refused
// outright: every reading goes stale, and the warning explains itself with `older than 0h`,
// a spelling this module's own parser will not read back.
test('a duration that rounds away to nothing is refused, not rounded to zero', () => {
  assert.throws(() => parseDuration('0.4ms', '--stale-after'), /--stale-after/);
  assert.throws(() => readConfigFile(writeConfig({ staleAfterMs: 0.4 })), /staleAfterMs/);
});

test('the refusal quotes the value it was handed and the source that handed it over', () => {
  const err = failure(() => parseDuration('soon', 'TARMAC_STALE_AFTER'));
  assert.match(err, /TARMAC_STALE_AFTER/, 'which knob the user must go and fix');
  assert.match(err, /soon/, 'what it was actually set to');
  assert.match(err, /90s|15m|2h/, 'and what would have worked');
});

test('a duration is written back in the units it would be typed in', () => {
  // The renderers print this next to every `!`, so it has to read like the thing a user
  // would set — and to round-trip through the parser that reads it back.
  assert.equal(formatDuration(600_000), '10m');
  assert.equal(formatDuration(90_000), '90s');
  assert.equal(formatDuration(5_400_000), '90m');
  assert.equal(formatDuration(7_200_000), '2h');
  assert.equal(formatDuration(500), '500ms');
  assert.equal(parseDuration(formatDuration(90_000), 'x'), 90_000, 'round trip');
});

test('a port is a port number, and anything else is refused by name', () => {
  assert.equal(parsePort('8080', '--port'), 8080);
  assert.equal(parsePort('0', '--port'), 0, 'zero is "pick a free one", which serve genuinely uses');
  assert.equal(parsePort('65535', '--port'), 65535);
  assert.throws(() => parsePort('eight', 'TARMAC_PORT'), /TARMAC_PORT.*eight/s);
  assert.throws(() => parsePort('65536', '--port'), /--port.*65536/s);
  assert.throws(() => parsePort('-1', '--port'), /--port/);
  assert.throws(() => parsePort('80.5', '--port'), /--port/);
});

test('no config file is not an error — it is the zero-config contract', () => {
  assert.deepEqual(readConfigFile(path.join(tmpdir(), 'nothing-here.json')), {});
});

test('a config file sets the three settings it is allowed to set', () => {
  const file = writeConfig({ staleAfterMs: 90_000, port: 8080, snapshotsDir: '/tmp/snaps' });
  assert.deepEqual(readConfigFile(file), { staleAfterMs: 90_000, port: 8080, snapshotsDir: '/tmp/snaps' });
});

test('a config file that is not JSON is reported, with its path', () => {
  const file = path.join(tmpdir(), 'config.json');
  fs.writeFileSync(file, '{ port: 8080 }\n');
  assert.throws(() => readConfigFile(file), new RegExp(escape(file)));
});

test('a config file that is JSON but not an object is reported', () => {
  const file = path.join(tmpdir(), 'config.json');
  fs.writeFileSync(file, '[1, 2, 3]\n');
  assert.throws(() => readConfigFile(file), /object/i);
});

test('a config file that exists but cannot be read is reported, never treated as absent', () => {
  // Unreadable-and-present is the case where "absent means {}" would quietly become a lie.
  const file = path.join(tmpdir(), 'config.json');
  fs.mkdirSync(file);
  assert.throws(() => readConfigFile(file), new RegExp(escape(file)));
});

test('an unknown key is refused, and the message says what would have been understood', () => {
  const file = writeConfig({ stale_after_ms: 90_000 });
  const err = failure(() => readConfigFile(file));
  assert.match(err, /stale_after_ms/, 'the key the user actually wrote');
  assert.match(err, /staleAfterMs/, 'and the one they meant');
});

test('a known key of the wrong type is refused rather than coerced', () => {
  assert.throws(() => readConfigFile(writeConfig({ staleAfterMs: '15m' })), /staleAfterMs.*15m/s);
  assert.throws(() => readConfigFile(writeConfig({ staleAfterMs: 0 })), /staleAfterMs/);
  assert.throws(() => readConfigFile(writeConfig({ port: '8080' })), /port.*8080/s);
  assert.throws(() => readConfigFile(writeConfig({ port: 70000 })), /port.*70000/s);
  assert.throws(() => readConfigFile(writeConfig({ snapshotsDir: 7 })), /snapshotsDir/);
  assert.throws(() => readConfigFile(writeConfig({ snapshotsDir: '' })), /snapshotsDir/);
});

test('a refusal shows an empty value as something the eye can catch', () => {
  // `got: ` followed by nothing reads like the message itself is broken.
  assert.match(failure(() => readConfigFile(writeConfig({ snapshotsDir: '' }))), /\(empty\)/);
});

// ── precedence ──────────────────────────────────────────────────────────────────────────
// flag > env > file > default, one setting at a time, each remembering where it came from.

test('with nothing set anywhere, the numbers are the ones that were baked into the source', () => {
  const c = resolve({});
  assert.deepEqual(c.staleAfterMs, { value: 600_000, source: 'default' });
  assert.deepEqual(c.port, { value: 4477, source: 'default' });
  assert.deepEqual(c.snapshotsDir, { value: '/default/snaps', source: 'default' });
  assert.equal(DEFAULT_STALE_AFTER_MS, 600_000, 'the constant issue #4 quotes');
  assert.equal(DEFAULT_PORT, 4477);
});

test('a config file beats the default', () => {
  const c = resolve({ file: { staleAfterMs: 90_000, port: 8080, snapshotsDir: '/from/file' } });
  assert.deepEqual(c.staleAfterMs, { value: 90_000, source: 'file' });
  assert.deepEqual(c.port, { value: 8080, source: 'file' });
  assert.deepEqual(c.snapshotsDir, { value: '/from/file', source: 'file' });
});

test('the environment beats the config file', () => {
  const c = resolve({
    file: { staleAfterMs: 90_000, port: 8080, snapshotsDir: '/from/file' },
    env: { TARMAC_STALE_AFTER: '2h', TARMAC_PORT: '9000', TARMAC_SNAPSHOTS_DIR: '/from/env' },
  });
  assert.deepEqual(c.staleAfterMs, { value: 7_200_000, source: 'env' });
  assert.deepEqual(c.port, { value: 9000, source: 'env' });
  assert.deepEqual(c.snapshotsDir, { value: '/from/env', source: 'env' });
});

test('a flag beats the environment', () => {
  const c = resolve({
    file: { staleAfterMs: 90_000, port: 8080, snapshotsDir: '/from/file' },
    env: { TARMAC_STALE_AFTER: '2h', TARMAC_PORT: '9000', TARMAC_SNAPSHOTS_DIR: '/from/env' },
    flags: { staleAfter: '30s', port: 1234, snapshotsDir: '/from/flag' },
  });
  assert.deepEqual(c.staleAfterMs, { value: 30_000, source: 'flag' });
  assert.deepEqual(c.port, { value: 1234, source: 'flag' });
  assert.deepEqual(c.snapshotsDir, { value: '/from/flag', source: 'flag' });
});

test('precedence is settled per setting, not per source', () => {
  // The mixed case is the one a user actually lives in: a port pinned in the file, a
  // threshold tightened for this one run.
  const c = resolve({ file: { port: 8080 }, flags: { staleAfter: '45s' } });
  assert.deepEqual(c.port, { value: 8080, source: 'file' });
  assert.deepEqual(c.staleAfterMs, { value: 45_000, source: 'flag' });
  assert.deepEqual(c.snapshotsDir, { value: '/default/snaps', source: 'default' });
});

test('a bad value in the environment is refused by the name the user would export', () => {
  assert.throws(() => resolve({ env: { TARMAC_STALE_AFTER: 'soon' } }), /TARMAC_STALE_AFTER.*soon/s);
  assert.throws(() => resolve({ env: { TARMAC_PORT: 'eighty' } }), /TARMAC_PORT.*eighty/s);
});

// The config file validates every key it finds, whoever ends up winning. The environment
// has to answer the same way, or a stale TARMAC_STALE_AFTER in a shell profile makes
// `tarmac list` fail on its own and succeed the moment a flag is passed — and the README
// says, without conditions, that nothing here is ever dropped in silence.
test('a bad value is refused even when something beats it', () => {
  assert.throws(() => resolve({ env: { TARMAC_STALE_AFTER: 'soon' }, flags: { staleAfter: '5m' } }), /TARMAC_STALE_AFTER/);
  assert.throws(() => resolve({ env: { TARMAC_PORT: 'eighty' }, flags: { port: 1234 } }), /TARMAC_PORT/);
  assert.throws(
    () => resolve({ env: { TARMAC_STALE_AFTER: 'soon' }, file: { staleAfterMs: 90_000 } }),
    /TARMAC_STALE_AFTER/,
    'and when the file is what it loses to',
  );
});

test('an empty environment variable is unset, not an empty value', () => {
  // `TARMAC_PORT= tarmac serve` is how a shell wrapper says "never mind" — erroring there
  // would make the tool unusable from a script that clears its own variables.
  const c = resolve({ env: { TARMAC_STALE_AFTER: '', TARMAC_PORT: '', TARMAC_SNAPSHOTS_DIR: '' } });
  assert.equal(c.port.source, 'default');
  assert.equal(c.staleAfterMs.source, 'default');
  assert.equal(c.snapshotsDir.source, 'default');
});

/** `resolveConfig` with everything defaulted, so each test states only what it is about. */
function resolve(input: {
  flags?: { staleAfter?: string | null; port?: number | null; snapshotsDir?: string | null };
  env?: Record<string, string | undefined>;
  file?: FileConfig;
}) {
  return resolveConfig({
    flags: { staleAfter: null, port: null, snapshotsDir: null, ...(input.flags ?? {}) },
    env: input.env ?? {},
    file: input.file ?? {},
    defaultSnapshotsDir: '/default/snaps',
  });
}

const tmpdir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-config-'));

function writeConfig(body: Record<string, unknown>): string {
  const file = path.join(tmpdir(), 'config.json');
  fs.writeFileSync(file, JSON.stringify(body, null, 2));
  return file;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The message of a call that must throw — asserting on prose is the point here. */
function failure(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  assert.fail('expected a refusal, got a value');
}
