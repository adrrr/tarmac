import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectFleet } from '../src/collect.ts';
import { parseArgs } from '../src/args.ts';

const SID = 'ea6a607c-42e0-4773-af4d-ae5f5938d819';

interface StageOptions {
  agents: unknown[];
  snapshotFiles?: Record<string, string>;
}

function stage({ agents, snapshotFiles = {} }: StageOptions): { claudeBin: string; snapshotsDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-e2e-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(agents)}\nEOF\n`);
  fs.chmodSync(bin, 0o755);
  const snaps = path.join(dir, 'snapshots');
  fs.mkdirSync(snaps);
  for (const [n, b] of Object.entries(snapshotFiles)) fs.writeFileSync(path.join(snaps, n), b);
  return { claudeBin: bin, snapshotsDir: snaps };
}

test('joins live sessions to their snapshots end to end', async () => {
  const { claudeBin, snapshotsDir } = stage({
    agents: [{ sessionId: SID, status: 'busy', cwd: '/Users/jane/alpha', name: 'n', startedAt: 1000 }],
    snapshotFiles: {
      [`${SID}.json`]: JSON.stringify({
        session_id: SID,
        model: { display_name: 'Fable 5' },
        context_window: { used_percentage: 26, current_usage: { input_tokens: 5 } },
        cost: { total_cost_usd: 1.25 },
      }),
    },
  });
  const { rows, health } = await collectFleet({ claudeBin, snapshotsDir, now: 61000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ctxPct, 26);
  assert.equal(rows[0].model, 'Fable 5');
  assert.equal(rows[0].busy, true);
  assert.equal(rows[0].uptimeMs, 60000);
  assert.equal(health.covered, 1);
});

test('reports a session the statusline does not cover', async () => {
  const { claudeBin, snapshotsDir } = stage({ agents: [{ sessionId: SID, status: 'idle', cwd: '/a' }] });
  const { rows, health } = await collectFleet({ claudeBin, snapshotsDir, now: 1 });
  assert.equal(rows[0].ctxState, 'absent');
  assert.equal(health.covered, 0);
  assert.equal(health.sessions, 1);
});

test('never writes to the snapshots directory it reads', async () => {
  const { claudeBin, snapshotsDir } = stage({
    agents: [{ sessionId: SID, status: 'idle', cwd: '/a' }],
    snapshotFiles: { [`${SID}.json`]: JSON.stringify({ session_id: SID, context_window: { used_percentage: 4 } }) },
  });
  const before = fs.readdirSync(snapshotsDir).sort();
  const beforeBytes = fs.readFileSync(path.join(snapshotsDir, `${SID}.json`), 'utf8');

  const { rows } = await collectFleet({ claudeBin, snapshotsDir, now: 1 });

  // Proves the read really happened — without this the assertions below would also hold
  // for a collector that did nothing at all.
  assert.equal(rows[0].ctxPct, 4);
  assert.deepEqual(fs.readdirSync(snapshotsDir).sort(), before);
  assert.equal(fs.readFileSync(path.join(snapshotsDir, `${SID}.json`), 'utf8'), beforeBytes);
});

test('reports an unreadable snapshot directory through to the fleet health', async () => {
  const { claudeBin } = stage({ agents: [{ sessionId: SID, status: 'idle', cwd: '/a' }] });
  const { health } = await collectFleet({ claudeBin, snapshotsDir: '/nonexistent/nope', now: 1 });
  assert.equal(health.snapshotsError, null, 'a directory that does not exist yet is not an error');
  assert.equal(health.covered, 0);
});

// "Nothing there yet" is only innocent for the directory NOBODY chose. A path someone typed
// — in a flag, in a variable, in a config file edited months ago — that does not exist is a
// setting pointing at nothing, and rendering it as "not chained yet" sends the user to run
// `tarmac install`, which cannot help: install writes where install writes, not where the
// reader was pointed.
test('a snapshots directory that does not exist is innocent only when it is the default', async () => {
  const { claudeBin } = stage({ agents: [{ sessionId: SID, status: 'idle', cwd: '/a' }] });
  const missing = '/nonexistent/nope';

  const untouched = await collectFleet({ claudeBin, snapshotsDir: missing, now: 1, snapshotsDirSource: 'default' });
  assert.equal(untouched.health.snapshotsError, null, 'the default may simply not exist yet');

  for (const source of ['flag', 'env', 'file'] as const) {
    const { health } = await collectFleet({ claudeBin, snapshotsDir: missing, now: 1, snapshotsDirSource: source });
    assert.ok(health.snapshotsError, `a directory set by ${source} that is absent is reported`);
    assert.match(health.snapshotsError!, /nonexistent\/nope/, 'naming the path it was sent to');
    assert.match(health.snapshotsError!, /ENOENT/);
  }

  const fromFile = await collectFleet({ claudeBin, snapshotsDir: missing, now: 1, snapshotsDirSource: 'file' });
  assert.match(fromFile.health.snapshotsError!, /config file/, 'and which knob sent it there');
});

// ── argument parsing ──────────────────────────────────────────────────────────────────
test('defaults to the list command on an empty argv', () => {
  assert.equal(parseArgs([]).command, 'list');
});

test('reads the command and its options', () => {
  const a = parseArgs(['serve', '--port', '9999', '--snapshots-dir', '/tmp/s']);
  assert.equal(a.command, 'serve');
  assert.equal(a.port, 9999);
  assert.equal(a.snapshotsDir, '/tmp/s');
});

test('accepts --opt=value as well as --opt value', () => {
  assert.equal(parseArgs(['serve', '--port=8080']).port, 8080);
});

test('rejects a port that is not a number', () => {
  assert.throws(() => parseArgs(['serve', '--port', 'eight']), /--port/);
});

// A flag that was not passed has to be TELLABLE from one passed with the value that happens
// to be the default — otherwise `--port 4477` could not outrank a port set in the config file.
test('an option nobody passed comes back as null, not as its default', () => {
  const a = parseArgs(['serve']);
  assert.equal(a.port, null);
  assert.equal(a.staleAfter, null);
  assert.equal(a.snapshotsDir, null);
});

test('reads --stale-after verbatim, leaving what a duration means to one parser', () => {
  assert.equal(parseArgs(['list', '--stale-after', '90s']).staleAfter, '90s');
  assert.equal(parseArgs(['list', '--stale-after=2h']).staleAfter, '2h');
});

// The one flag that lets a script past the typed confirmation, so it is opt-in and never
// implied: `--yes` off by default is what makes a non-TTY refusal meaningful.
test('reads --yes, and leaves it false when it is absent', () => {
  assert.equal(parseArgs(['install']).yes, false);
  assert.equal(parseArgs(['install', '--yes']).yes, true);
});

// `--snapshots-dir=` used to sail straight through as an empty path: the fleet then read
// the process's cwd, found nothing, and reported a perfectly calm "nothing is chained". The
// config file has always refused an empty path; the flag has to refuse it in the same breath.
test('an option handed an empty value is refused, never taken as an empty setting', () => {
  assert.throws(() => parseArgs(['list', '--snapshots-dir=']), /--snapshots-dir needs a value/);
  assert.throws(() => parseArgs(['list', '--home=']), /--home needs a value/);
  assert.throws(() => parseArgs(['list', '--claude-bin=']), /--claude-bin needs a value/);
  assert.throws(() => parseArgs(['list', '--stale-after=']), /--stale-after needs a value/);
  assert.throws(() => parseArgs(['serve', '--port=']), /--port needs a value/);
});

test('reads --watch, and leaves it false when it is absent', () => {
  assert.equal(parseArgs(['list']).watch, false);
  assert.equal(parseArgs(['list', '--watch']).watch, true);
});

test('rejects an unknown option instead of ignoring it', () => {
  assert.throws(() => parseArgs(['list', '--colour']), /unknown option/);
});

// M1: the module's own promise, applied one level deeper. "A typo silently ignored is how
// someone ends up believing they pointed tarmac at a directory it never read" — and a flag
// that belongs to ANOTHER command is exactly that: `tarmac serve --json` accepted and
// ignored looks, from the outside, like a server that decided to answer HTML anyway.
test('rejects a flag that belongs to another command, naming both', () => {
  assert.throws(() => parseArgs(['install', '--watch']), /--watch/);
  assert.throws(() => parseArgs(['install', '--watch']), /tarmac install/);
  assert.throws(() => parseArgs(['install', '--watch']), /list/, 'and says where it does belong');
});

test('rejects the reading flags on the writing commands, and the reverse', () => {
  assert.throws(() => parseArgs(['serve', '--json']), /--json/);
  assert.throws(() => parseArgs(['list', '--port', '4477']), /--port/);
  assert.throws(() => parseArgs(['list', '--yes']), /--yes/);
  assert.throws(() => parseArgs(['uninstall', '--snapshots-dir', '/tmp/s']), /--snapshots-dir/);
});

test('accepts every flag its own command really uses', () => {
  assert.equal(parseArgs(['list', '--home', '/tmp', '--json']).json, true);
  assert.equal(parseArgs(['serve', '--home', '/tmp', '--port', '4477']).port, 4477);
  assert.equal(parseArgs(['install', '--home', '/tmp', '--yes']).yes, true);
  assert.equal(parseArgs(['uninstall', '--help']).help, true, '--help is always allowed');
});

test('rejects an unknown command', () => {
  assert.throws(() => parseArgs(['deploy']), /unknown command/);
});

// S2 (review): "the default may simply not exist yet" was sound while the default was a pure
// function of `--home` — a path nobody had chosen and nothing had created. Since #20 the
// default is the path the INSTALL froze into the wrapper: a directory that was chosen, and
// made, by an install that ran. Missing, it is not "nothing has been chained yet", it is the
// writer and the reader having parted company — the `healthy and empty` fleet that
// docs/MANUAL.md calls the worst thing this tool can render.
//
// So the silence is narrowed to what it was always about: no install here at all.
test('a frozen default that is missing is reported, unlike one no install ever chose', async () => {
  const { claudeBin } = stage({ agents: [{ sessionId: SID, status: 'idle', cwd: '/a' }] });
  const missing = '/nonexistent/nope';

  const never = await collectFleet({ claudeBin, snapshotsDir: missing, now: 1, snapshotsDirSource: 'default' });
  assert.equal(never.health.snapshotsError, null, 'nothing chained yet is still the zero-config case');

  const frozen = await collectFleet({
    claudeBin,
    snapshotsDir: missing,
    now: 1,
    snapshotsDirSource: 'default',
    installed: true,
  });
  assert.ok(frozen.health.snapshotsError, 'an installed wrapper writes there — its absence is a fault');
  assert.match(frozen.health.snapshotsError!, /ENOENT/);
  assert.match(frozen.health.snapshotsError!, /nonexistent\/nope/);
  assert.match(frozen.health.snapshotsError!, /wrapper|install/i, 'and says who chose it');
});
