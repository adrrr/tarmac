// The schema guard: what tarmac has actually looked at, versus what it is being fed.
//
// Every field this tool reads was OBSERVED on a Claude Code build, not promised by a
// published schema. The existing defences fire once a field has already broken (`drift`,
// `schemaBroken`). This one fires earlier and for a different reason: a version nobody has
// ever checked is a reason to LOOK, never a reason to stop reporting.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHECKED_VERSIONS, guardVersions, schemaNotice } from '../src/schema.ts';
import { extractTelemetry } from '../src/snapshots.ts';
import { tempDir } from './sandbox.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const fixturesDir = path.join(repo, 'fixtures');

// ── the constant against the fixtures it claims to describe ───────────────────────────
//
// `CHECKED_VERSIONS` is baked into src because only `dist/` is published — a released
// tarmac has no fixtures/ to read. This test is what keeps the baked list honest: the
// guard would otherwise be free to claim a version nobody ever captured.

/**
 * The version an agents fixture was captured from, and nothing else in its name.
 *
 * One build can be worth capturing twice — the plain capture, and one showing a state the
 * first happened not to catch (a `waiting` session, #44). The second is named for what it
 * shows, and that word is a description of the CAPTURE, never a version: read as one it puts
 * `2.1.232-waiting` into the checked list, where it silently vouches for a build that does
 * not exist and, being an exact-equality member, silences nothing real.
 *
 * The tag is peeled only when the rest of the name cannot claim it: lazily, so
 * `agents-2.1.226-rc.1.json` is still the prerelease it says it is rather than `2.1.226`
 * wearing a tag. A tag is a lowercase word for that reason — anything a version could
 * contain would take the ambiguity back.
 */
const agentsVersion = (file: string): string | null => /^agents-(.+?)(?:-[a-z]+)?\.json$/.exec(file)?.[1] ?? null;

test('the checked versions are exactly the ones fixtures/ covers', () => {
  const files = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));
  const statusline = files
    .map((f) => /^statusline-payload-(.+)-[^-]+\.json$/.exec(f)?.[1])
    .filter((v): v is string => Boolean(v));
  const agents = files.map(agentsVersion).filter((v): v is string => Boolean(v));

  assert.deepEqual([...CHECKED_VERSIONS.statusline].sort(), [...new Set(statusline)].sort());
  assert.deepEqual([...CHECKED_VERSIONS.agents].sort(), [...new Set(agents)].sort());
  assert.equal(
    files.length,
    statusline.length + agents.length,
    'every .json in fixtures/ is named so the guard can see it — an unrecognised name is an invisible fixture',
  );
});

// Both directions, because each one alone is a rule half kept: a tag read as a version
// invents a build, and a version mistaken for a tag drops a real one out of the checked list
// — which is silence about a shape nobody captured, the failure this whole file exists for.
test('a tagged agents fixture is a second capture of one build, never a version of its own', () => {
  assert.equal(agentsVersion('agents-2.1.232-waiting.json'), '2.1.232', 'the tag says what the capture shows');
  assert.equal(agentsVersion('agents-2.1.232.json'), '2.1.232', 'and an untagged name is not shortened');
  assert.equal(agentsVersion('agents-2.1.226-rc.1.json'), '2.1.226-rc.1', 'a prerelease is a version, not a tag');
  assert.equal(agentsVersion('statusline-payload-2.1.226-live.json'), null, 'the other family is not this one');
});

// The other half of the same promise, and the half nothing was checking: the guard says
// every field tarmac reads was OBSERVED, so a key the reader takes off an entry and no
// fixture carries is a claim with nothing behind it. `state` was exactly that — read since
// the map landed, frozen nowhere (#28). The keys come off the reader's own source rather
// than a list kept beside it, because a list beside it is a list that stops being updated.
// Across the family, not per file: the 2.1.226 capture caught no background session (which
// says nothing about the field's existence there), and a fixture is a capture of one build,
// not a checklist to be filled in.
test('every key the agents reader takes off an entry is carried by some fixture', () => {
  const read = new Set([...fs.readFileSync(path.join(repo, 'src', 'sessions.ts'), 'utf8').matchAll(/\bentry\.(\w+)/g)].map((m) => m[1]!));
  assert.ok(read.size > 0, 'no `entry.` reads found — this test has stopped watching anything');

  const carried = new Set<string>();
  for (const f of fs.readdirSync(fixturesDir).filter((f) => /^agents-/.test(f) && f.endsWith('.json'))) {
    for (const e of JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf8')) as Record<string, unknown>[]) {
      for (const k of Object.keys(e)) carried.add(k);
    }
  }
  assert.deepEqual([...read].filter((k) => !carried.has(k)), [], 'read off a shape no capture ever showed');
});

// The statusline twin of the test above, and the half that was missing: adding a version to
// `CHECKED_VERSIONS` buys permanent silence about that build for every user, and the only
// thing behind that silence is a file in `fixtures/`. Until this existed, nothing opened the
// statusline captures at all beyond their filenames — a payload could carry the wrong
// `version`, or a drifted context window, and the suite stayed green while the guard went on
// vouching for it.
//
// Two claims per file, both read through the module that will have to read the real thing:
// the build named in the filename is the build the payload says wrote it, and the tag is the
// verdict `extractTelemetry` actually reaches (the mapping `scripts/capture-fixtures.ts` uses
// to choose the name in the first place).
const CTX_STATE_BY_TAG: Record<string, string> = { live: 'ok', fresh: 'fresh', drift: 'drift' };

test('every statusline fixture is the build and the state its name claims', () => {
  const files = fs.readdirSync(fixturesDir).filter((f) => /^statusline-payload-/.test(f));
  assert.ok(files.length > 0, 'no statusline fixtures found — this test has stopped watching anything');

  for (const f of files) {
    const [, version, tag] = /^statusline-payload-(.+)-([^-]+)\.json$/.exec(f)!;
    const t = extractTelemetry(JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf8')));
    assert.equal(t.ccVersion, version, `${f}: the payload names a different build than the filename`);
    assert.equal(t.ctxState, CTX_STATE_BY_TAG[tag!], `${f}: the tag is not the verdict the reader reaches`);
  }
});

// And the coverage claim itself: a `-live` capture is the one that shows every field this tool
// reads carrying a real value. A fixture where half of them come back null would freeze a
// version as "checked" on a payload that never demonstrated the shape.
test('a live statusline fixture carries every field the reader takes off a payload', () => {
  const live = fs.readdirSync(fixturesDir).filter((f) => /^statusline-payload-.+-live\.json$/.test(f));
  assert.ok(live.length > 0, 'no live statusline fixture — nothing proves the fields exist anywhere');

  for (const f of live) {
    const t = extractTelemetry(JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf8')));
    for (const [field, value] of Object.entries(t)) {
      assert.notEqual(value, null, `${f}: ${field} came back null on a capture named "live"`);
    }
  }
});

// ── the guard ─────────────────────────────────────────────────────────────────────────
test('a version tarmac has checked says nothing at all', () => {
  const g = guardVersions(['2.1.226']);
  assert.equal(g.state, 'ok');
  assert.deepEqual(g.versions, ['2.1.226']);
  assert.deepEqual(g.unchecked, []);
  assert.equal(schemaNotice(g), null);
});

test('an unchecked version is named, and so is what has been checked', () => {
  const g = guardVersions(['2.2.0']);
  assert.equal(g.state, 'unchecked');
  assert.deepEqual(g.versions, ['2.2.0']);
  assert.deepEqual(g.unchecked, [
    { surface: 'statusline', versions: ['2.2.0'] },
    { surface: 'agents', versions: ['2.2.0'] },
  ]);
  const notice = schemaNotice(g)!;
  assert.match(notice, /2\.2\.0/, 'the version actually seen');
  assert.match(notice, /2\.1\.226/, 'what tarmac did check');
  assert.match(notice, /never been checked/i);
});

// The notice is read by someone who installed tarmac with `npx`, and `files: ["dist"]`
// means they have no scripts/ and no npm script to run. Advice they cannot follow is
// worse than no advice: it reads as "this tool is broken and you cannot fix it".
test('the notice only advises what a published install can actually do', () => {
  const notice = schemaNotice(guardVersions(['2.2.0']))!;
  assert.equal(/fixtures:capture/.test(notice), false, 'that script never ships to npm');
  assert.match(notice, /update tarmac/i);
  assert.match(notice, /github\.com\/adrrr\/tarmac\/issues/);
});

// B1, the defect two reviews found independently: judging only the HIGHEST version seen
// let every other build in flight go unremarked. During a rolling update — which is the
// normal state of a fleet whose sessions live for days — the straggler is exactly the
// session running a shape nobody captured, and it was the one being silenced.
test('a version nobody captured is named even when a newer, checked one is in flight', () => {
  const g = guardVersions(['2.1.222', '2.1.226']);
  assert.equal(g.state, 'unchecked');
  assert.deepEqual(g.versions, ['2.1.222', '2.1.226']);
  assert.match(schemaNotice(g)!, /2\.1\.222/);
});

// The shape-check line is a maintainer's, and it stands on every user's page until a release
// ships the fixture that ends it (#53). This is that release for 2.1.232, whose `agents` half
// has been frozen since #44 and whose statusline half had never been captured — the exact
// half-covered state the notice was reporting, verbatim, to everyone.
test('2.1.232 is checked on both surfaces, so a fleet running it is told nothing', () => {
  const g = guardVersions(['2.1.232']);
  assert.equal(g.state, 'ok');
  assert.deepEqual(g.unchecked, []);
  assert.equal(schemaNotice(g), null);
});

// The two surfaces do not cover the same builds — `2.1.220` is frozen on the statusline
// side and nowhere on the agents side. A version covered on one surface and not the other
// must say which one is missing rather than accusing both.
test('a version checked on one surface only names the surface that is not', () => {
  const g = guardVersions(['2.1.220']);
  assert.equal(g.state, 'unchecked');
  assert.deepEqual(g.unchecked, [{ surface: 'agents', versions: ['2.1.220'] }]);
  const notice = schemaNotice(g)!;
  assert.match(notice, /agents --json/);
  assert.equal(/statusline payload \(checked/.test(notice), false, 'the checked surface is not accused');
});

test('every distinct version in flight is judged, each one once', () => {
  const g = guardVersions(['2.1.226', '2.2.0', '2.1.226', '2.2.0']);
  assert.deepEqual(g.versions, ['2.1.226', '2.2.0']);
  assert.deepEqual(g.unchecked, [
    { surface: 'statusline', versions: ['2.2.0'] },
    { surface: 'agents', versions: ['2.2.0'] },
  ], 'only the version that is really missing, and only on the surfaces missing it');
});

// A prerelease of a checked version is NOT that version: membership is exact string
// equality, so it cannot inherit the silence of the release it prefixes.
test('a prerelease of a checked version is not treated as checked', () => {
  const g = guardVersions(['2.1.226-rc.1']);
  assert.equal(g.state, 'unchecked');
  assert.deepEqual(g.versions, ['2.1.226-rc.1']);
});

// The exit criterion that matters most: an ABSENT version key is drift, and must never
// read as "known". A release that drops `version` would otherwise buy permanent silence.
test('snapshots that carry no version at all are drift, never a known shape', () => {
  const g = guardVersions([null, null]);
  assert.equal(g.state, 'no-version');
  assert.equal(g.noVersion, 2);
  const notice = schemaNotice(g)!;
  assert.match(notice, /version/i);
  assert.equal(/never been checked/.test(notice), false, 'not the unchecked-version wording');
});

// The release that DROPS `version` rolls out session by session. One survivor still
// carrying it must not vouch for the six that do not — that was the silence B1 bought.
test('one old session carrying a version does not vouch for the ones that lost it', () => {
  const g = guardVersions([null, null, null, null, null, null, '2.1.226']);
  assert.equal(g.state, 'no-version');
  assert.equal(g.noVersion, 6);
  assert.match(schemaNotice(g)!, /6 of 7/);
});

test('a missing version outranks an unchecked one when both are true', () => {
  const g = guardVersions([null, '2.2.0']);
  assert.equal(g.state, 'no-version', 'the worse fact leads');
  const notice = schemaNotice(g)!;
  assert.match(notice, /no `version`/, 'and neither fact is dropped');
  assert.match(notice, /2\.2\.0/);
});

test('no snapshots at all: nothing to check, and nothing to say', () => {
  const g = guardVersions([]);
  assert.equal(g.state, 'nothing');
  assert.deepEqual(g.versions, []);
  assert.equal(schemaNotice(g), null);
});

// ── the one-command capture ───────────────────────────────────────────────────────────
//
// The notice tells the reader to run this. If it does not work, the guard is a dead end.
// Everything is redirected by env: the suite never reads or writes a real ~/.claude.
const CAPTURE = path.join(repo, 'scripts', 'capture-fixtures.ts');
const AGENTS_JSON = '[{"pid":1,"cwd":"/tmp/a","sessionId":"aaaa","status":"idle"}]';

function sandbox(): { dir: string; bin: string; snapshots: string; fixtures: string } {
  const dir = tempDir('tarmac-capture-');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "agents" ]; then printf '%s' '${AGENTS_JSON}'; else echo "9.9.9 (Claude Code)"; fi\n`,
    { mode: 0o755 },
  );
  const snapshots = path.join(dir, 'snaps');
  const fixtures = path.join(dir, 'fixtures');
  fs.mkdirSync(snapshots);
  fs.mkdirSync(fixtures);
  return { dir, bin, snapshots, fixtures };
}

const capture = (s: ReturnType<typeof sandbox>): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [CAPTURE], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      TARMAC_CLAUDE_BIN: s.bin,
      TARMAC_SNAPSHOTS: s.snapshots,
      TARMAC_FIXTURES: s.fixtures,
    },
  });

test('captures the fixture pair for the version claude reports', () => {
  const s = sandbox();
  const payload = `{"session_id":"abcd-1","version":"9.9.9","context_window":{"used_percentage":26}}`;
  fs.writeFileSync(path.join(s.snapshots, 'abcd-1.json'), payload);

  const r = capture(s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(s.fixtures, 'agents-9.9.9.json'), 'utf8'), AGENTS_JSON);
  assert.equal(
    fs.readFileSync(path.join(s.fixtures, 'statusline-payload-9.9.9-live.json'), 'utf8'),
    payload,
    'the payload is copied verbatim — a fixture that has been reformatted is not what was received',
  );
  assert.match(r.stdout, /CHECKED_VERSIONS/, 'it says what still has to be edited by hand');
});

// The fixture's name is the reader's verdict on it, and the three verdicts are the three
// the tool itself makes. A drifting payload named "live" would be the worst fixture of all:
// the one that looks like a reference and is not.
test('names the fixture after what the payload actually is', () => {
  for (const [body, suffix] of [
    [`"context_window":{"used_percentage":null}`, 'fresh'],
    [`"context_window":{"usedPercentage":26}`, 'drift'],
    [`"cost":{"total_cost_usd":1}`, 'drift'],
  ] as const) {
    const s = sandbox();
    fs.writeFileSync(path.join(s.snapshots, 'abcd-1.json'), `{"session_id":"abcd-1","version":"9.9.9",${body}}`);
    assert.equal(capture(s).status, 0);
    assert.equal(fs.existsSync(path.join(s.fixtures, `statusline-payload-9.9.9-${suffix}.json`)), true, suffix);
  }
});

// A snapshot written by an older build says nothing about the shape of the new one.
test('refuses to pair an agents capture with a payload from another version', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.snapshots, 'abcd-1.json'), `{"session_id":"abcd-1","version":"1.0.0"}`);

  const r = capture(s);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /9\.9\.9/);
  assert.deepEqual(fs.readdirSync(s.fixtures), [], 'and writes nothing at all');
});

test('picks the newest matching snapshot when several are lying around', () => {
  const s = sandbox();
  const old = path.join(s.snapshots, 'old.json');
  const recent = path.join(s.snapshots, 'recent.json');
  const cw = `"context_window":{"used_percentage":26}`;
  fs.writeFileSync(old, `{"session_id":"old","version":"9.9.9","n":1,${cw}}`);
  fs.writeFileSync(recent, `{"session_id":"recent","version":"9.9.9","n":2,${cw}}`);
  const then = new Date(Date.now() - 3600_000);
  fs.utimesSync(old, then, then);

  assert.equal(capture(s).status, 0);
  assert.match(fs.readFileSync(path.join(s.fixtures, 'statusline-payload-9.9.9-live.json'), 'utf8'), /"n":2/);
});

test('the documented command runs the script', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).scripts as Record<string, string>;
  assert.match(scripts['fixtures:capture'] ?? '', /capture-fixtures/);
  // The capture walkthrough lives in the manual since the README went short (0.1.1).
  assert.match(fs.readFileSync(path.join(repo, 'docs', 'MANUAL.md'), 'utf8'), /npm run fixtures:capture/);
});

// The script is dev tooling, so it must not travel to npm with the package.
test('the capture script is not published', () => {
  const files = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).files as string[];
  assert.deepEqual(files, ['dist']);
});

// A capture that cannot write both halves must leave NEITHER: a lone agents-<v>.json is
// enough to break the fixtures/CHECKED_VERSIONS test with no clue why it appeared.
test('writes neither half of the pair when the second one cannot be written', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.snapshots, 'abcd-1.json'), `{"session_id":"abcd-1","version":"9.9.9","context_window":{"used_percentage":26}}`);
  fs.mkdirSync(path.join(s.fixtures, 'statusline-payload-9.9.9-live.json')); // in the way

  const r = capture(s);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(path.join(s.fixtures, 'agents-9.9.9.json')), false, 'no orphan half');
  assert.match(r.stderr, /capture-fixtures:/, 'a said refusal, not a raw stack');
});

// "It parsed as JSON" is not "it shows the shape we read". An empty array freezes a
// version as verified while no field name was ever observed on that surface.
test('refuses an agents capture that shows no identifiable session', () => {
  for (const body of ['[]', '[{"pid":1}]']) {
    const s = sandbox();
    fs.writeFileSync(s.bin, `#!/bin/sh\nif [ "$1" = "agents" ]; then printf '%s' '${body}'; else echo "9.9.9 (Claude Code)"; fi\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(s.snapshots, 'abcd-1.json'), `{"session_id":"abcd-1","version":"9.9.9","context_window":{"used_percentage":26}}`);

    const r = capture(s);
    assert.notEqual(r.status, 0, body);
    assert.deepEqual(fs.readdirSync(s.fixtures), [], body);
  }
});
