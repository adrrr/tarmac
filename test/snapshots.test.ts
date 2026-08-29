import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTelemetry, preferred, readSnapshots } from '../src/snapshots.ts';
import type { Snapshot } from '../src/snapshots.ts';
import { PRUNE_MARKER } from '../src/wrapper.ts';
import { tempDir } from './sandbox.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n: string): unknown => JSON.parse(fs.readFileSync(path.join(here, '..', 'fixtures', n), 'utf8'));

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  sessionId: 'dup', ctxState: 'ok', ctxPct: 26, ctxTokens: null, ctxWindow: null, model: null,
  modelId: null, effort: null, costUsd: null, ccVersion: null, rateLimits: null,
  ageMs: 1000, file: '/snaps/a.json', ...over,
});

test('reads a real statusline payload captured on the fleet', () => {
  const t = extractTelemetry(fixture('statusline-payload-2.1.220-live.json'));
  assert.equal(t.ctxState, 'ok');
  assert.equal(t.ctxPct, 50);
  assert.equal(t.model, 'Fable 5');
  assert.equal(t.effort, 'max');
  assert.equal(t.costUsd, 12.3456789012345);
  assert.equal(t.ccVersion, '2.1.220');
});

// Independent expectation, not the production formula re-typed: these four numbers are
// read off the fixture by eye and added by hand.
test('sums the four usage fields into a token count', () => {
  const t = extractTelemetry({
    context_window: {
      used_percentage: 50,
      current_usage: { input_tokens: 2, output_tokens: 1148, cache_creation_input_tokens: 2278, cache_read_input_tokens: 252962 },
    },
  });
  assert.equal(t.ctxTokens, 256390);
});

// I4: the module's own rule, one level down. A release that camel-cases these four keys
// must not produce a confident `ctxTokens: 0` sitting next to a healthy `ctxState: "ok"`.
test('renamed usage fields yield no token count, not a fabricated zero', () => {
  const t = extractTelemetry({ context_window: { used_percentage: 50, current_usage: { inputTokens: 5, outputTokens: 9 } } });
  assert.equal(t.ctxTokens, null);
});

test('an empty usage object yields no token count', () => {
  assert.equal(extractTelemetry({ context_window: { used_percentage: 50, current_usage: {} } }).ctxTokens, null);
});

test('a usage array yields no token count', () => {
  assert.equal(extractTelemetry({ context_window: { used_percentage: 50, current_usage: [] } }).ctxTokens, null);
});

test('a partially present usage object still sums what is really there', () => {
  const t = extractTelemetry({ context_window: { used_percentage: 1, current_usage: { input_tokens: 7 } } });
  assert.equal(t.ctxTokens, 7);
});

// A session that booted but has not taken a turn yet: the key is there, the value is null.
// Reporting 0% here would be a lie a whole recycled fleet tells every night.
test('a fresh session reports state=fresh and no percentage, never 0', () => {
  const t = extractTelemetry(fixture('statusline-payload-2.1.226-fresh.json'));
  assert.equal(t.ctxState, 'fresh');
  assert.equal(t.ctxPct, null);
});

// The blindness `seen` cannot see: snapshots keep flowing, the field moved.
test('a renamed context field reports state=drift, not a silent zero', () => {
  const t = extractTelemetry({ session_id: 'a', context_window: { utilisation_pct: 40 } });
  assert.equal(t.ctxState, 'drift');
  assert.equal(t.ctxPct, null);
});

// M2: `1e999` is valid JSON and `JSON.parse` turns it into `Infinity`, which is `typeof
// "number"`. The type check let it through, `Math.floor` kept it, and the terminal printed
// "Infinity%" while the page drew a bar clamped to 100% beside the same word — two surfaces
// disagreeing about a magnitude neither of them could have. A number we cannot use is not a
// measurement: same rule as a renamed key.
test('a context percentage that is not a finite number reports drift, never Infinity%', () => {
  const t = extractTelemetry(JSON.parse('{"session_id":"a","context_window":{"used_percentage":1e999}}'));
  assert.equal(t.ctxState, 'drift');
  assert.equal(t.ctxPct, null);
});

// Same rule, the other impossible value. A percentage below zero is not a reading anyone
// can act on, and it reached the page's bar as `width:-3%` — an element that renders as
// nothing at all next to a confident "-3%".
test('a context percentage outside 0-100 is not a measurement either', () => {
  assert.equal(extractTelemetry({ session_id: 'a', context_window: { used_percentage: -3 } }).ctxPct, null);
  assert.equal(extractTelemetry({ session_id: 'a', context_window: { used_percentage: 140 } }).ctxPct, null);
  assert.equal(extractTelemetry({ session_id: 'a', context_window: { used_percentage: 100 } }).ctxPct, 100, 'the ends are readings');
  assert.equal(extractTelemetry({ session_id: 'a', context_window: { used_percentage: 0 } }).ctxPct, 0);
});

test('a context percentage of the wrong type reports drift', () => {
  const t = extractTelemetry({ context_window: { used_percentage: '40%' } });
  assert.equal(t.ctxState, 'drift');
});

test('no context_window at all reports drift', () => {
  assert.equal(extractTelemetry({ session_id: 'a' }).ctxState, 'drift');
});

test('carries the plan rate limits through when the payload has them', () => {
  const t = extractTelemetry(fixture('statusline-payload-2.1.220-live.json'));
  assert.equal(t.rateLimits!.five_hour.used_percentage, 17);
});

test('a payload without rate limits yields null, not a fabricated zero', () => {
  assert.equal(extractTelemetry({ context_window: { used_percentage: 1 } }).rateLimits, null);
});

// ── directory reading ─────────────────────────────────────────────────────────────────
function snapDir(files: Record<string, string>): string {
  const dir = tempDir('tarmac-snap-');
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

test('keys snapshots by session id taken from the payload, not the filename', () => {
  const dir = snapDir({ 'whatever.json': JSON.stringify({ session_id: 'real-sid', context_window: { used_percentage: 3 } }) });
  assert.ok(readSnapshots(dir).snapshots.has('real-sid'));
});

test('skips a corrupt snapshot instead of failing the whole read', () => {
  const dir = snapDir({
    'a.json': '{ truncated',
    'b.json': JSON.stringify({ session_id: 'b', context_window: { used_percentage: 7 } }),
  });
  const { snapshots, unreadable } = readSnapshots(dir);
  assert.equal(snapshots.size, 1);
  assert.equal(snapshots.get('b')!.ctxPct, 7);
  assert.equal(unreadable, 1, 'a skipped file is counted, not forgotten');
});

// The prune marker comes from the wrapper's own constant: it is dropped in the very
// directory this function reads, on every sweep, and the reader has to know it is paperwork.
// Counted as `unreadable` it would print as a corrupt snapshot the user cannot find; counted
// as a snapshot it would be a session that does not exist.
test('ignores non-json files and the wrapper temp files', () => {
  const dir = snapDir({ [PRUNE_MARKER]: '', 'note.txt': 'x', '.a.123.tmp': '{}' });
  const res = readSnapshots(dir);
  assert.equal(res.snapshots.size, 0);
  assert.equal(res.unreadable, 0, 'and none of them is reported as a snapshot it failed to read');
});

// The sweep deletes cold snapshots from the very directory this function is reading, every
// hour, and `list --watch` and `serve` redraw often enough to be inside that window. A file
// listed by readdir and gone by the time it is read was DELETED between the two — tarmac's
// own housekeeping doing its job — and counting it as a payload we failed to parse let the
// sweep drive the "schema may have moved, check for a newer tarmac" warning (2675 phantom
// unreadable on one read of a 20k directory).
//
// The deletion is scheduled from readdir itself rather than raced against a timer: the whole
// point is the instant BETWEEN the listing and the read, and a test that hopes to hit it
// asserts this machine's luck. Nothing about the failure is faked — the file is really gone
// and the real ENOENT comes back from the real filesystem.
test('a snapshot deleted between the listing and the read is not counted unreadable', () => {
  const dir = snapDir({
    'doomed.json': JSON.stringify({ session_id: 'doomed', context_window: { used_percentage: 1 } }),
    'alive.json': JSON.stringify({ session_id: 'alive', context_window: { used_percentage: 7 } }),
  });
  const realReaddir = fs.readdirSync;
  (fs as any).readdirSync = (...args: [string]) => {
    const names = realReaddir(...args);
    fs.rmSync(path.join(dir, 'doomed.json'), { force: true });
    return names;
  };
  try {
    const res = readSnapshots(dir);
    assert.equal(res.unreadable, 0, 'a file the sweep removed is not a snapshot tarmac could not read');
    assert.equal(res.snapshots.size, 1);
    assert.equal(res.snapshots.get('alive')!.ctxPct, 7, 'and the read carries on through the gap');
  } finally {
    (fs as any).readdirSync = realReaddir;
  }
});

// The other end of the same rule, and the one that keeps the skip above narrow: a file we
// were not ALLOWED to open is exactly what `unreadable` exists to say. Widen the skip to
// "swallow every filesystem error" and nothing else in this suite notices — the corrupt
// payload above is a `JSON.parse` failure, which carries no errno at all.
test('a snapshot file that cannot be opened is still counted unreadable', (t) => {
  // 0000 does not stop root, so under a root container this fixture is not the state it
  // claims to build. Saying that out loud beats a green tick that proved nothing.
  if (process.getuid?.() === 0) {
    t.skip('running as root: 0000 does not deny anything, the case cannot be built here');
    return;
  }
  const dir = snapDir({ 'locked.json': JSON.stringify({ session_id: 'locked', context_window: { used_percentage: 5 } }) });
  const file = path.join(dir, 'locked.json');
  fs.chmodSync(file, 0o000);
  try {
    const res = readSnapshots(dir);
    assert.equal(res.snapshots.size, 0);
    assert.equal(res.unreadable, 1, '"I was not allowed to look" is not "it was deleted"');
  } finally {
    fs.chmodSync(file, 0o644);
  }
});

// The deliberate half of the skip above, pinned rather than left to be discovered: `statSync`
// follows symlinks, so a dead link named like a snapshot is ENOENT too and is skipped in the
// same silence — except that this one is permanent, not a race. `reap.ts:75` reads the very
// same shape the other way round, and is right to: it deletes the link, this only reads what
// the link does not point at.
test('a dangling symlink where a snapshot should be is skipped in silence, not counted', () => {
  const dir = snapDir({ 'alive.json': JSON.stringify({ session_id: 'alive', context_window: { used_percentage: 7 } }) });
  fs.symlinkSync(path.join(dir, 'swept-away.json'), path.join(dir, 'dead.json'));
  const res = readSnapshots(dir);
  assert.equal(res.unreadable, 0, 'nothing to read is not something it failed to read');
  assert.equal(res.snapshots.size, 1, 'and the live snapshot beside it still reads');
});

test('a missing directory reads as empty rather than throwing', () => {
  const res = readSnapshots('/nonexistent/tarmac-snaps');
  assert.equal(res.snapshots.size, 0);
  assert.equal(res.dirError, null, 'nothing there yet is not an error');
});

// I3: "empty" and "I was not allowed to look" must not render identically — the second
// used to produce "0/7 chained, run tarmac install", blaming the user for a permission bug.
test('an unreadable directory is reported, not silently empty', (t) => {
  // 0000 does not stop root, so under a root container this fixture is not the state it
  // claims to build. Saying that out loud beats a green tick that proved nothing.
  if (process.getuid?.() === 0) {
    t.skip('running as root: 0000 does not deny anything, the case cannot be built here');
    return;
  }
  const dir = snapDir({ 'a.json': JSON.stringify({ session_id: 'a', context_window: { used_percentage: 1 } }) });
  fs.chmodSync(dir, 0o000);
  try {
    const res = readSnapshots(dir);
    assert.equal(res.snapshots.size, 0);
    assert.match(res.dirError!, /EACCES|EPERM/);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

// M4: two files claiming the same session — a snapshot copied between directories, or a
// wrapper pointed at a directory another one already writes. `Map.set` used to let the last
// name in readdir order win, silently, and a reader could be shown either of two readings
// with nothing saying there had been a choice. The freshest is kept, and the loss is SAID.
test('two files claiming one session keep the freshest, and the duplicate is counted', () => {
  const dir = snapDir({
    'old.json': JSON.stringify({ session_id: 'dup', context_window: { used_percentage: 10 } }),
    'new.json': JSON.stringify({ session_id: 'dup', context_window: { used_percentage: 90 } }),
  });
  const old = path.join(dir, 'old.json');
  fs.utimesSync(old, new Date(), new Date(Date.now() - 3600_000));

  const { snapshots, duplicates } = readSnapshots(dir);
  assert.equal(snapshots.size, 1);
  assert.equal(snapshots.get('dup')!.ctxPct, 90, 'the freshest reading, whatever readdir order was');
  assert.equal(duplicates, 1, 'and the one that lost is not forgotten');
});

// The tie the first fix left behind. "Freshest wins" decides nothing when two files carry
// the SAME mtime — and that is not the exotic case, it is the one the fix was written for:
// `cp -p`, `rsync -a` and `tar -x` all preserve mtime exactly, so a snapshot copied between
// directories arrives as a perfect twin and whoever readdir listed first still won.
//
// Tested on the rule rather than through a directory on purpose: readdir order is the one
// input a test cannot choose (ext4 with dir_index and APFS both answer in hash order, not
// alphabetically), so a test that goes through the filesystem asserts this machine's luck.
// What has to hold is that the decision does not depend on the order the two are handed in.
test('the freshest of two readings wins whichever order they arrive in', () => {
  const older = snap({ file: 'a.json', ageMs: 9000, ctxPct: 10 });
  const newer = snap({ file: 'b.json', ageMs: 10, ctxPct: 90 });
  assert.equal(preferred(older, newer).ctxPct, 90);
  assert.equal(preferred(newer, older).ctxPct, 90);
});

test('two readings of the same age are decided by their filename, not by their order', () => {
  const a = snap({ file: '/snaps/a.json', ageMs: 500, ctxPct: 10 });
  const b = snap({ file: '/snaps/b.json', ageMs: 500, ctxPct: 90 });
  assert.equal(preferred(a, b).file, preferred(b, a).file, 'the same winner both ways round');
});

test('a fleet with no duplicate snapshot counts none', () => {
  const dir = snapDir({ 'a.json': JSON.stringify({ session_id: 'a', context_window: { used_percentage: 1 } }) });
  assert.equal(readSnapshots(dir).duplicates, 0);
});

test('records how stale each snapshot is against a pinned clock', () => {
  const dir = snapDir({ 'a.json': JSON.stringify({ session_id: 'a', context_window: { used_percentage: 1 } }) });
  const mtime = fs.statSync(path.join(dir, 'a.json')).mtimeMs;
  const { snapshots } = readSnapshots(dir, { now: mtime + 5000 });
  assert.equal(snapshots.get('a')!.ageMs, 5000);
});
