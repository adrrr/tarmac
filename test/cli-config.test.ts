// P4, end to end through the real binary: where the three settings come from, in the order
// the README promises — flag > env > file > default — and what a wrong one looks like.
//
// The unit suite proves the resolver. This one proves the WIRING, which is the part that
// silently rots: a precedence rule that is right in `config.ts` and never reaches `collect`
// would leave `--stale-after` printing a threshold it did not apply.
//
// Every run gets its own throwaway home. Nothing here reads or writes the real `~/.claude`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NET_DEADLINE_MS, rawGet, waitForOutput } from './bounded.ts';
import { tempDir } from './sandbox.ts';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const SID = 'aaaaaaaa-1111-1111-1111-111111111111';
const TWENTY_MIN = 20 * 60_000;

interface Home {
  home: string;
  bin: string;
  snapshots: string;
  config: string;
}

/**
 * A home with one live session whose only reading is twenty minutes old — deliberately
 * astride the 10-minute default, so the threshold in force decides whether it is stale.
 */
function fakeHome(): Home {
  const root = tempDir('tarmac-cfg-');
  // The XDG state directory, not `.claude` — see #20. `--home` is a throwaway directory here
  // and never the real home, so an `XDG_STATE_HOME` in the developer's shell cannot reach it.
  const snapshots = path.join(root, '.local', 'state', 'tarmac', 'snapshots');
  fs.mkdirSync(snapshots, { recursive: true });
  // `<home>/.claude/tarmac/` is no longer created as a side effect of making the snapshots
  // directory — it holds the config file this fixture writes, and nothing else here.
  fs.mkdirSync(path.join(root, '.claude', 'tarmac'), { recursive: true });

  const agents = path.join(root, 'agents.json');
  fs.writeFileSync(
    agents,
    JSON.stringify([
      { pid: 1, cwd: '/tmp/alpha', kind: 'interactive', startedAt: Date.now() - 3600_000, sessionId: SID, name: 'alpha-1', status: 'idle' },
    ]),
  );
  const bin = path.join(root, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\n[ "$1" = "agents" ] && exec cat ${agents}\necho "2.1.226 (Claude Code)"\n`, { mode: 0o755 });

  const snapshot = path.join(snapshots, `${SID}.json`);
  fs.writeFileSync(
    snapshot,
    JSON.stringify({
      session_id: SID,
      version: '2.1.226',
      model: { display_name: 'Opus 5' },
      context_window: { used_percentage: 26, context_window_size: 1000000 },
    }),
  );
  // The age of a reading is the age of its file, and the CLI has no injectable clock.
  const old = new Date(Date.now() - TWENTY_MIN);
  fs.utimesSync(snapshot, old, old);

  return { home: root, bin, snapshots, config: path.join(root, '.claude', 'tarmac', 'config.json') };
}

interface Health {
  staleAfterMs: number;
  snapshotsDir: string;
  stale: number;
}

/** `tarmac list --json` under a fresh home, with an optional config file and environment. */
function list(
  h: Home,
  { flags = [], env = {}, config }: { flags?: string[]; env?: Record<string, string>; config?: Record<string, unknown> } = {},
): SpawnSyncReturns<string> {
  if (config) fs.writeFileSync(h.config, JSON.stringify(config, null, 2));
  return spawnSync(process.execPath, [CLI, 'list', '--home', h.home, '--claude-bin', h.bin, ...flags], {
    encoding: 'utf8',
    timeout: 20000,
    env: childEnv(env),
  });
}

/**
 * The parent's environment MINUS every TARMAC_ variable. A developer (or a CI runner) with
 * one exported would otherwise silently change what "with no environment" means in half
 * this file — and the test asserting the defaults would go on passing while proving nothing.
 */
function childEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(out)) if (key.startsWith('TARMAC_')) delete out[key];
  // Same reasoning for the one variable outside that prefix which moves a default (#20).
  delete out.XDG_STATE_HOME;
  return { ...out, ...extra };
}

function health(r: SpawnSyncReturns<string>): Health {
  assert.equal(r.status, 0, r.stderr);
  return (JSON.parse(r.stdout) as { health: Health }).health;
}

// ── the defaults do not move ──────────────────────────────────────────────────────────

test('with no flag, no environment and no config file, the numbers are the old ones', () => {
  const h = fakeHome();
  const got = health(list(h, { flags: ['--json'] }));
  assert.equal(got.staleAfterMs, 600_000, 'ten minutes, exactly as before this was settable');
  assert.equal(got.snapshotsDir, h.snapshots, '<home>/.local/state/tarmac/snapshots');
  assert.equal(got.stale, 1, 'and a twenty-minute-old reading is still stale under it');
});

// ── flag > env > file > default, proved one rung at a time ────────────────────────────

test('a config file beats the default', () => {
  const h = fakeHome();
  const got = health(list(h, { flags: ['--json'], config: { staleAfterMs: 7_200_000 } }));
  assert.equal(got.staleAfterMs, 7_200_000);
  assert.equal(got.stale, 0, 'the threshold was applied, not merely reported');
});

test('the environment beats the config file', () => {
  const h = fakeHome();
  const got = health(list(h, { flags: ['--json'], config: { staleAfterMs: 7_200_000 }, env: { TARMAC_STALE_AFTER: '60s' } }));
  assert.equal(got.staleAfterMs, 60_000);
  assert.equal(got.stale, 1);
});

test('a flag beats the environment', () => {
  const h = fakeHome();
  const got = health(
    list(h, { flags: ['--stale-after', '3h', '--json'], config: { staleAfterMs: 7_200_000 }, env: { TARMAC_STALE_AFTER: '60s' } }),
  );
  assert.equal(got.staleAfterMs, 3 * 3600_000);
  assert.equal(got.stale, 0);
});

test('the snapshots directory follows the same three rungs', () => {
  const h = fakeHome();
  const fromFile = path.join(h.home, 'from-file');
  const fromEnv = path.join(h.home, 'from-env');
  const fromFlag = path.join(h.home, 'from-flag');
  for (const d of [fromFile, fromEnv, fromFlag]) fs.mkdirSync(d);

  assert.equal(health(list(h, { flags: ['--json'], config: { snapshotsDir: fromFile } })).snapshotsDir, fromFile);
  assert.equal(
    health(list(h, { flags: ['--json'], config: { snapshotsDir: fromFile }, env: { TARMAC_SNAPSHOTS_DIR: fromEnv } })).snapshotsDir,
    fromEnv,
  );
  assert.equal(
    health(
      list(h, {
        flags: ['--snapshots-dir', fromFlag, '--json'],
        config: { snapshotsDir: fromFile },
        env: { TARMAC_SNAPSHOTS_DIR: fromEnv },
      }),
    ).snapshotsDir,
    fromFlag,
  );
});

// ── a wrong value stops the run and says which knob to turn ───────────────────────────

test('an unparseable duration on the command line is refused by name, with an exit code', () => {
  const r = list(fakeHome(), { flags: ['--stale-after', 'banana'] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--stale-after must be a positive duration like 90s, 15m or 2h, got: banana/);
  assert.equal(r.stdout, '', 'and no table is printed as if nothing had happened');
});

test('an unparseable duration in the environment names the variable, not the flag', () => {
  const r = list(fakeHome(), { env: { TARMAC_STALE_AFTER: 'soon' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TARMAC_STALE_AFTER must be a positive duration like 90s, 15m or 2h, got: soon/);
});

test('a bad port in the environment is refused before anything binds', () => {
  const r = list(fakeHome(), { env: { TARMAC_PORT: 'eighty' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /TARMAC_PORT must be a port number between 0 and 65535, got: eighty/);
});

test('an unknown key in the config file is reported, never dropped in silence', () => {
  const h = fakeHome();
  const r = list(h, { flags: ['--json'], config: { stale_after_ms: 90_000 } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stale_after_ms/, 'the key as written');
  assert.match(r.stderr, /staleAfterMs/, 'and the one that exists');
  assert.match(r.stderr, new RegExp(h.config.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'in which file');
});

test('a config file that is not JSON is reported', () => {
  const h = fakeHome();
  fs.writeFileSync(h.config, '{ port: 8080 }\n');
  const r = list(h, { flags: ['--json'] });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
});

// A directory set once in a config file and later renamed is the ordinary way this goes
// wrong, and the old answer — "statusline chained on 0/1 sessions", exit 0 — reads as a
// perfectly healthy fleet that simply has not been installed yet.
test('a snapshots directory that points nowhere is named, with the setting that sent it there', () => {
  const h = fakeHome();
  const typo = path.join(h.home, '.claude', 'tarmac', 'snapshot'); // not "snapshots"
  const r = list(h, { config: { snapshotsDir: typo } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(escapeRe(typo)), 'the path it was actually sent to');
  assert.match(r.stdout, /config file/, 'and who sent it there');
  assert.equal(/chained on 0\/1/.test(r.stdout), false, 'never the "just run install" story');
});

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── the threshold is visible wherever a `!` is ────────────────────────────────────────

test('the table names the threshold that put a "!" on a reading', () => {
  const r = list(fakeHome(), { flags: ['--stale-after', '90s'] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /20m !/, 'the reading is marked');
  assert.match(r.stdout, /older than 90s \(--stale-after\)/, 'and the mark carries the threshold it was judged against');
  assert.equal(/older than 10m/.test(r.stdout), false, 'never the default the fleet did not use');
});

// ── serve says what it decided, and on whose authority ────────────────────────────────

test('serve opens by printing the effective settings and where each came from', async () => {
  const h = fakeHome();
  // Port 0 from the environment: it proves the variable is honoured over the file AND binds
  // an ephemeral port, so the test cannot collide with whatever else is listening.
  fs.writeFileSync(h.config, JSON.stringify({ port: 4477, staleAfterMs: 90_000 }));
  const { child, out } = await serve(h, { TARMAC_PORT: '0' });
  try {
    assert.match(out, /port +0 +\(env\)/, 'the environment beat the file, and it says so');
    assert.match(out, /freshness +90s +\(file\)/);
    assert.match(out, new RegExp(`snapshots +${escapeRe(h.snapshots)} +\\(default\\)`));
    assert.match(out, /flag > env > file > default/, 'the rule itself, for whoever reads the log');
  } finally {
    child.kill('SIGKILL');
  }
});

// The dashboard's own API is a separate wiring from `list`, and the criterion names it. A
// settings block that says `90s` over a `/api/fleet` still judging by the default would be
// the exact lie this issue is about, and it would look perfectly healthy.
test('/api/fleet is judged by the configured threshold, not by the default', async () => {
  const h = fakeHome();
  fs.writeFileSync(h.config, JSON.stringify({ port: 0, staleAfterMs: 90_000 }));
  const { child, out } = await serve(h);
  try {
    const port = /127\.0\.0\.1:(\d+)/.exec(out)?.[1];
    assert.ok(port, `no port in: ${out}`);
    const fleet = (await (await fetch(`http://127.0.0.1:${port}/api/fleet`, { signal: AbortSignal.timeout(NET_DEADLINE_MS) })).json()) as {
      rows: Array<{ stale: boolean }>;
      health: { staleAfterMs: number; stale: number };
    };
    // Under the default the twenty-minute reading would be fresh and this would read 600000.
    assert.equal(fleet.health.staleAfterMs, 90_000);
    assert.equal(fleet.health.stale, 1);
    assert.equal(fleet.rows[0].stale, true, 'the row itself, not just the count');
  } finally {
    child.kill('SIGKILL');
  }
});

// The unit suite proves the guard; this proves the flag REACHES it. A settings block printing
// `trusted proxy.example.ts.net` over a server still answering 403 to that very Host is the
// exact shape this file exists to catch, and from the outside it reads as a feature that works.
test('a host trusted on the command line is one serve really answers to', async () => {
  const h = fakeHome();
  fs.writeFileSync(h.config, JSON.stringify({ port: 0 }));
  const { child, out } = await serve(h, {}, ['--trust-host', 'proxy.example.ts.net']);
  try {
    const port = /127\.0\.0\.1:(\d+)/.exec(out)?.[1];
    assert.ok(port, `no port in: ${out}`);
    assert.match(out, /trusted +proxy\.example\.ts\.net +\(flag\)/, 'and the run says whose decision it was');
    assert.equal(await rawGet(port, 'proxy.example.ts.net'), 200, 'the name given, as a proxy would forward it');
    assert.equal(await rawGet(port, 'proxy.example.ts.net:8443'), 200, 'and on whatever port it arrives');
    assert.equal(await rawGet(port, 'other.example'), 403, 'and nothing else was let in with it');
  } finally {
    child.kill('SIGKILL');
  }
});

// Same rung, from the environment, because the resolver and the wiring are two different
// places to drop a setting — and this one is how a systemd unit or a launchd plist sets it.
test('a host trusted in the environment is one serve really answers to', async () => {
  const h = fakeHome();
  fs.writeFileSync(h.config, JSON.stringify({ port: 0 }));
  const { child, out } = await serve(h, { TARMAC_TRUST_HOST: 'proxy.example.ts.net' });
  try {
    const port = /127\.0\.0\.1:(\d+)/.exec(out)?.[1];
    assert.ok(port, `no port in: ${out}`);
    assert.match(out, /trusted +proxy\.example\.ts\.net +\(env\)/);
    assert.equal(await rawGet(port, 'proxy.example.ts.net'), 200);
  } finally {
    child.kill('SIGKILL');
  }
});

// The default is the product: a serve nobody configured says nothing about trusted hosts and
// refuses every one of them.
test('with no host named, serve says nothing about trust and lets nothing in', async () => {
  const h = fakeHome();
  fs.writeFileSync(h.config, JSON.stringify({ port: 0 }));
  const { child, out } = await serve(h);
  try {
    const port = /127\.0\.0\.1:(\d+)/.exec(out)?.[1];
    assert.ok(port, `no port in: ${out}`);
    assert.equal(/trusted/.test(out), false, 'nothing was chosen, so there is nothing to report');
    assert.equal(await rawGet(port, 'proxy.example.ts.net'), 403);
  } finally {
    child.kill('SIGKILL');
  }
});

// A host that could never match a Host header is refused where every other bad value is: at
// the start of the run, in one line, naming the knob — never accepted and quietly ineffective.
test('a --trust-host nothing could match stops the run and names the flag', () => {
  const r = spawnSync(process.execPath, [CLI, 'serve', '--home', fakeHome().home, '--trust-host', '*.ts.net'], {
    encoding: 'utf8',
    timeout: 20000,
    env: childEnv(),
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--trust-host must be a host name like example\.ts\.net.*no wildcard.*\*\.ts\.net/s);
});

// The settings block is PRINTED text and the URL is whatever the server happened to pick:
// with `--port 0` both follow the socket, so neither notices if the resolved port never
// reaches `listen`. Only a port asked for by number and found again on the socket does.
test('serve binds the port it was configured with, not one of its own choosing', async () => {
  const h = fakeHome();
  const wanted = await freePort();
  fs.writeFileSync(h.config, JSON.stringify({ port: wanted }));
  const { child, out } = await serve(h);
  try {
    assert.match(out, new RegExp(`tarmac serving http://127\\.0\\.0\\.1:${wanted}\\b`), out);
    const res = await fetch(`http://127.0.0.1:${wanted}/api/fleet`, { signal: AbortSignal.timeout(NET_DEADLINE_MS) });
    assert.equal(res.status, 200, 'and it is really answering there');
  } finally {
    child.kill('SIGKILL');
  }
});

// Pinning a port in config.json and finding something already on it is the ordinary way
// this feature fails. The whole point of moving parsing inside the try was that a refusal
// reaches the user as one line naming the knob — an unhandled 'error' event undoes that.
test('serve refuses a port already in use in one line, naming the port and its source', async () => {
  const h = fakeHome();
  const busy = net.createServer();
  const port = await new Promise<number>((resolve) =>
    busy.listen(0, '127.0.0.1', () => resolve((busy.address() as AddressInfo).port)),
  );
  fs.writeFileSync(h.config, JSON.stringify({ port }));
  try {
    const r = spawnSync(process.execPath, [CLI, 'serve', '--home', h.home, '--claude-bin', h.bin], {
      encoding: 'utf8',
      timeout: 20000,
      env: childEnv(),
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`\\b${port}\\b`), 'the port it could not have');
    assert.match(r.stderr, /config file/, 'and who asked for it');
    // The report this UX pass came from: the refusal named the port, the source, and no way
    // out. Someone reading it had no idea `--port` existed.
    assert.match(r.stderr, /--port/, 'and the knob that gets them out of it');
    assert.equal(/throw er|at Server\./.test(r.stderr), false, `a stack trace, not a message:\n${r.stderr}`);
  } finally {
    busy.close();
  }
});

/** A port nothing is listening on: bind :0, note what the kernel gave, hand it back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Starts the real CLI and resolves with everything it printed up to "serving".
 *
 * Through `waitForOutput`, so a `tarmac serving` line that never comes is a rejection with
 * the output that did — not a file that stops reporting. That marker is a contract now, and
 * a mutation of it used to hang this file rather than turn it red.
 */
async function serve(h: Home, env: Record<string, string> = {}, flags: string[] = []): Promise<{ child: ChildProcess; out: string }> {
  const child = spawn(process.execPath, [CLI, 'serve', '--home', h.home, '--claude-bin', h.bin, ...flags], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(env),
  });
  return { child, out: await waitForOutput(child, /tarmac serving/) };
}
