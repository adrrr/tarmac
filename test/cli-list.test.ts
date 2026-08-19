// End to end, through the real binary: `tarmac list` against a fleet whose Claude Code is
// a version nobody has ever captured.
//
// The unit tests prove the guard and the renderers separately. This one proves the wiring
// the exit criteria are actually about: the notice reaches stdout, the readings are still
// printed, and the process still exits 0 — a schema guard that turned into a gate would be
// a worse failure than the drift it warns about.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { waitForOutput } from './bounded.ts';
import { tempDir } from './sandbox.ts';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const SID = 'aaaaaaaa-1111-1111-1111-111111111111';
const OTHER = 'bbbbbbbb-2222-2222-2222-222222222222';

/** A fleet of two sessions on CC 2.99.0: one reports a cost, one has no `cost` key at all. */
function fleetOnUncheckedVersion(): { bin: string; snapshots: string } {
  const dir = tempDir('tarmac-list-');
  const agents = path.join(dir, 'agents.json');
  fs.writeFileSync(
    agents,
    JSON.stringify([
      { pid: 1, cwd: '/tmp/alpha', kind: 'interactive', startedAt: Date.now() - 3600_000, sessionId: SID, name: 'alpha-1', status: 'idle' },
      { pid: 2, cwd: '/tmp/beta', kind: 'interactive', startedAt: Date.now() - 3600_000, sessionId: OTHER, name: 'beta-2', status: 'idle' },
    ]),
  );
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\n[ "$1" = "agents" ] && exec cat ${agents}\necho "2.99.0 (Claude Code)"\n`, { mode: 0o755 });

  const snapshots = path.join(dir, 'snaps');
  fs.mkdirSync(snapshots);
  fs.writeFileSync(
    path.join(snapshots, `${SID}.json`),
    JSON.stringify({
      session_id: SID,
      version: '2.99.0',
      model: { display_name: 'Opus 5' },
      effort: { level: 'high' },
      cost: { total_cost_usd: 12.5 },
      context_window: { used_percentage: 26, context_window_size: 1000000 },
    }),
  );
  fs.writeFileSync(
    path.join(snapshots, `${OTHER}.json`),
    JSON.stringify({
      session_id: OTHER,
      version: '2.99.0',
      model: { display_name: 'Fable 5' },
      context_window: { used_percentage: 40, context_window_size: 1000000 },
    }),
  );
  return { bin, snapshots };
}

const list = (extra: string[] = []): SpawnSyncReturns<string> => {
  const { bin, snapshots } = fleetOnUncheckedVersion();
  return spawnSync(process.execPath, [CLI, 'list', '--claude-bin', bin, '--snapshots-dir', snapshots, ...extra], {
    encoding: 'utf8',
    timeout: 20000,
  });
};

test('list warns about an unchecked Claude Code version, prints the fleet anyway, and exits 0', () => {
  const r = list();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2\.99\.0/, 'the version it is actually being fed');
  assert.match(r.stdout, /never been checked/i);
  assert.match(r.stdout, /26%/, 'telemetry is not suppressed');
  assert.match(r.stdout, /40%/);
});

test('list totals only the sessions that really report a cost', () => {
  assert.match(list().stdout, /\$12\.50 \(1\/2 reporting cost\)/);
});

// The wiring the unit tests cannot reach: the flag, the loop, the clock, and a Ctrl-C that
// gets the process out rather than leaving it running under the test runner.
test('list --watch draws a live frame and leaves on a Ctrl-C', async () => {
  const { bin, snapshots } = fleetOnUncheckedVersion();
  const child = spawn(process.execPath, [CLI, 'list', '--watch', '--claude-bin', bin, '--snapshots-dir', snapshots], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    // Longhand here once, deadline and all, which is how it came to carry a 20s of its own
    // while every other wait in the suite moved to the runner's (#73). `waitForOutput` is the
    // same wait, minus the copy: it carries the shared deadline, quotes what did arrive, and
    // kills the child on the way out — which this one never did.
    const out = await waitForOutput(child, /\^C to quit/);
    assert.match(out, /26%/, 'the fleet');
    assert.match(out, /updated 0s ago/, 'and the age of the reading');
  } finally {
    child.kill('SIGINT');
    // A watch that ignored SIGINT would hang the suite here rather than fail it.
    await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 5000).unref())]);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      assert.fail('list --watch did not exit on SIGINT');
    }
  }
});

test('list --watch and --json refuse to be combined', () => {
  const r = list(['--watch', '--json']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--watch/);
  assert.match(r.stderr, /--json/);
});

// C1, end to end and in the reviewer's own words: two live sessions, two snapshots being
// written for them right now, and a Claude Code release that renamed `session_id`. Nothing
// can be keyed, so the fleet reads as uncovered — and the only thing tarmac used to say was
// "statusline chained on 0/2 sessions … run tarmac install", which is both already done and
// useless against a schema change. The count of unreadable payloads is what tells them apart.
test('list names the snapshots it could not read when the payload key moved', () => {
  const dir = tempDir('tarmac-drift-');
  const agents = path.join(dir, 'agents.json');
  fs.writeFileSync(
    agents,
    JSON.stringify([
      { pid: 1, cwd: '/tmp/alpha', kind: 'interactive', startedAt: Date.now() - 3600_000, sessionId: SID, name: 'alpha-1', status: 'idle' },
      { pid: 2, cwd: '/tmp/beta', kind: 'interactive', startedAt: Date.now() - 3600_000, sessionId: OTHER, name: 'beta-2', status: 'idle' },
    ]),
  );
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\n[ "$1" = "agents" ] && exec cat ${agents}\necho "2.1.226 (Claude Code)"\n`, { mode: 0o755 });
  const snapshots = path.join(dir, 'snaps');
  fs.mkdirSync(snapshots);
  for (const sid of [SID, OTHER]) {
    // The one key renamed — everything else is a healthy payload still being written.
    fs.writeFileSync(
      path.join(snapshots, `${sid}.json`),
      JSON.stringify({ sessionId: sid, version: '2.1.226', context_window: { used_percentage: 26 } }),
    );
  }

  const r = spawnSync(process.execPath, [CLI, 'list', '--claude-bin', bin, '--snapshots-dir', snapshots], {
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 snapshot/i, 'both payloads are accounted for');
  assert.match(r.stdout, /unreadable/i);
  assert.match(r.stdout, /schema/i, 'the cause the README promises');
});

test('the guard travels in the JSON output too', () => {
  const r = list(['--json']);
  assert.equal(r.status, 0, r.stderr);
  const fleet = JSON.parse(r.stdout) as { health: { schemaGuard: { state: string; versions: string[] }; costReporting: number } };
  assert.equal(fleet.health.schemaGuard.state, 'unchecked');
  assert.deepEqual(fleet.health.schemaGuard.versions, ['2.99.0']);
  assert.equal(fleet.health.costReporting, 1);
});
