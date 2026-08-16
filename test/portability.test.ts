import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PRUNE_MARKER, renderWrapper, SNAPSHOT_TTL_MIN } from '../src/wrapper.ts';
import { wideningLocale } from './locales.ts';
import { settle, waitFor } from './sweep.ts';
import { tempDir } from './sandbox.ts';

// The wrapper was developed on macOS, where /bin/sh is bash wearing a POSIX hat and
// forgives a great deal. On Debian and Ubuntu — the primary target of a public npx tool —
// /bin/sh is dash, which forgives nothing. Everything below runs the REAL generated script
// under every POSIX shell this machine has, and audits its source for constructs no dash
// implements.

interface Shell {
  label: string;
  cmd: string;
  prefix: string[];
}

const CANDIDATES: Shell[] = [
  { label: 'dash', cmd: 'dash', prefix: [] }, // /bin/sh on Debian, Ubuntu
  { label: '/bin/sh', cmd: '/bin/sh', prefix: [] }, // whatever this machine calls sh
  { label: 'ksh', cmd: 'ksh', prefix: [] }, // a third, independent POSIX implementation
  { label: 'busybox sh', cmd: 'busybox', prefix: ['sh'] }, // /bin/sh on Alpine
  // Not a fourth POSIX implementation for its own sake: bash IS `/bin/sh` on macOS and on the
  // RHEL family, and it is the implementation whose bracket RANGES widen under a UTF-8 locale.
  // On Debian and Ubuntu `/bin/sh` is dash, so without naming bash the collation case below
  // cannot be built there at all — the CI leg would pass by being unable to ask.
  { label: 'bash', cmd: 'bash', prefix: [] },
];

function runsHere(shell: Shell): boolean {
  const r = spawnSync(shell.cmd, [...shell.prefix, '-c', 'exit 0'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
}

const SHELLS = CANDIDATES.filter(runsHere);

const SID = 'ea6a607c-42e0-4773-af4d-ae5f5938d819';
const DEAD = 'ffffffff-1111-2222-3333-444444444444';
const QUIET = 'ffffffff-5555-6666-7777-888888888888';

/** 0555 denies root nothing, so the read-only fixture below cannot be built here. */
const ROOT = process.getuid?.() === 0;

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  snapDir: string;
}

/**
 * Writes the wrapper and runs it under `shell` explicitly, ignoring its shebang. `seed`
 * backdates files into the snapshot dir first — ages in minutes — so the prune has
 * something of a known age to decide about.
 */
function runUnder(
  shell: Shell,
  input: string,
  chain: string | null,
  seed?: Record<string, number>,
  readOnlyDir = false,
  env?: Record<string, string>,
): RunResult {
  const root = tempDir('tarmac-posix-');
  const snapDir = path.join(root, 'snapshots');
  if (seed || readOnlyDir) {
    fs.mkdirSync(snapDir, { recursive: true });
    for (const [name, ageMin] of Object.entries(seed ?? {})) {
      fs.writeFileSync(path.join(snapDir, name), '{}');
      const when = new Date(Date.now() - ageMin * 60_000);
      fs.utimesSync(path.join(snapDir, name), when, when);
    }
    if (readOnlyDir) fs.chmodSync(snapDir, 0o555);
  }
  const file = path.join(root, 'statusline.sh');
  fs.writeFileSync(file, renderWrapper({ snapshotDir: snapDir, chainCommand: chain }));
  const r = spawnSync(shell.cmd, [...shell.prefix, file], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(r.error, undefined, `${shell.label} failed to run the wrapper`);
  return { stdout: r.stdout, stderr: r.stderr, status: r.status, snapDir };
}

const payload = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    session_id: SID,
    model: { id: 'claude-fable-5', display_name: 'Fable 5' },
    context_window: { used_percentage: 26 },
    ...over,
  });

/** What the dir holds, minus the prune's own marker — bookkeeping, not telemetry. */
const listSnapshots = (dir: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n !== PRUNE_MARKER).sort() : [];

/** Shells for which the collation case above was really built — see the guard at the end. */
const exercised = new Set<string>();

for (const shell of SHELLS) {
  // One test per shell, exercising the constructs where implementations actually diverge:
  // `${var#pattern}` with a quoted pattern, `${var%%pattern}`, `[!…]` bracket negation,
  // `${#var}`, and `$(cat)` on a payload with embedded quotes.
  test(`the wrapper behaves identically under ${shell.label}`, async () => {
    const ok = runUnder(shell, payload(), 'echo CHAINED');
    assert.match(ok.stdout, /CHAINED/, 'the chained display still renders');
    assert.equal(ok.status, 0);
    // The stderr pin was written for the read-only case, where the leak was found, and that
    // case is the one this suite is least often able to build — it needs a directory 0555
    // really denies. This is the path every frame of every session takes instead, where the
    // stream is empty today under every shell here, and where a leak would be one line of
    // noise per frame on a terminal drawing a status line.
    assert.equal(ok.stderr, '', 'and says nothing on the stream the user is looking at');
    assert.deepEqual(listSnapshots(ok.snapDir), [`${SID}.json`], 'the payload is filed under its session id');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(ok.snapDir, `${SID}.json`), 'utf8')),
      JSON.parse(payload()),
      'byte-for-byte the payload it was handed',
    );

    // The sid rule is a positional bracket pattern, matched by `case`, and the happy path
    // above only proves this shell lets a UUID THROUGH. What each shell has to be asked
    // separately is what it keeps OUT, and the two refusals below are not the same question:
    //   • `../../evil` is refused on shape, which any implementation gets right;
    //   • `ea6a607g-…` has the exact shape of a session id and one character that is not a
    //     hex digit, so it is refused only if this shell reads the CHARACTER SET the same way
    //     `find` and the TypeScript do. A shell that read it loosely would file the snapshot
    //     and no deleter in this repo could ever take it away again — #7, one shell at a time.
    const traversal = runUnder(shell, payload({ session_id: '../../evil' }), 'echo CHAINED');
    assert.match(traversal.stdout, /CHAINED/);
    assert.deepEqual(listSnapshots(traversal.snapDir), [], 'a traversing id writes nothing');

    const notHex = runUnder(shell, payload({ session_id: 'ea6a607g-42e0-4773-af4d-ae5f5938d819' }), 'echo CHAINED');
    assert.match(notHex.stdout, /CHAINED/);
    assert.deepEqual(listSnapshots(notHex.snapDir), [], 'a sid shaped right but not hex writes nothing');

    // …and `g` is outside `a-f` in every collation there is, so the fixture above cannot see
    // the one way this set ever actually widened. A bracket RANGE is collated by the locale:
    // spelled `[0-9a-fA-F]`, `a-f` reaches `é` and fullwidth `ａ` under `en_US.UTF-8` — in
    // bash and in ksh, though NOT in dash, which is why this has to be asked of each shell by
    // name rather than of `#!/bin/sh` on whichever machine happens to run the suite. The regex
    // derived from the same string is ASCII code points, so a widening here is one constant
    // meaning two sets, chosen by the `LANG` of whoever's terminal drew the frame. The rule is
    // an enumeration of the sixteen digits for exactly this reason, and this is the test that
    // holds it there.
    const wide = wideningLocale(shell.cmd, shell.prefix);
    if (wide) {
      exercised.add(shell.label);
      const nonAscii = runUnder(
        shell,
        payload({ session_id: 'éa6a607c-42e0-4773-af4d-ae5f5938d819' }),
        'echo CHAINED',
        undefined,
        false,
        { LC_ALL: wide },
      );
      assert.match(nonAscii.stdout, /CHAINED/);
      assert.deepEqual(listSnapshots(nonAscii.snapDir), [], `a non-ASCII sid writes nothing under ${wide}`);
    }

    // Two ids: the `case` fallthrough and the `[ … ] && sid=''` guard.
    const ambiguous = runUnder(
      shell,
      JSON.stringify({ parent: { session_id: SID }, session_id: SID, model: { display_name: 'X' } }),
      'echo CHAINED',
    );
    assert.match(ambiguous.stdout, /CHAINED/);
    assert.deepEqual(listSnapshots(ambiguous.snapDir), [], 'an ambiguous payload writes nothing');

    // No chain: the second `${var#…}` / `${var%%…}` pair, on a different key.
    const bare = runUnder(shell, payload(), null);
    assert.match(bare.stdout, /Fable 5/, 'falls back to the model name');
    assert.equal(bare.status, 0);

    // RULE 1 under every shell: a failing chain never breaks the display or the exit code.
    const broken = runUnder(shell, payload(), 'echo PARTIAL; exit 3');
    assert.match(broken.stdout, /PARTIAL/);
    assert.equal(broken.status, 0, 'the status line always exits 0');

    // The prune: `$( … )` and `:` under this shell, and `find` with `-prune`, `-mmin` and
    // `-exec … +` under whichever implementation this machine ships — GNU find on Ubuntu,
    // BSD find on macOS, busybox find on Alpine are three different programs, and the two
    // the CI matrix has are exercised right here.
    //
    // …and `cmd &` under this shell, which is the other half of what is asked here since #8:
    // the sweep is detached, so what this shell has to get right is starting a child that
    // outlives it and returning without it. That is why the wait below is a wait and not a
    // read: a directory listed the instant the shell exits says nothing about either.
    const swept = runUnder(shell, payload(), 'echo CHAINED', {
      [`${DEAD}.json`]: SNAPSHOT_TTL_MIN + 60,
      [`${QUIET}.json`]: SNAPSHOT_TTL_MIN - 60,
    });
    assert.match(swept.stdout, /CHAINED/, 'the display renders on a sweeping frame too');
    assert.equal(swept.status, 0);
    // Silent on the sweeping frame too — the one that runs the most code, and whose `find`
    // is a child holding this frame's stderr unless the redirections say otherwise.
    assert.equal(swept.stderr, '', 'and the frame that sweeps says nothing either');
    await waitFor(
      () => !fs.existsSync(path.join(swept.snapDir, `${DEAD}.json`)),
      `the sweep ${shell.label} detached to remove the dead session`,
    );
    assert.deepEqual(
      listSnapshots(swept.snapDir),
      [`${QUIET}.json`, `${SID}.json`].sort(),
      'the dead session is swept, the quiet one and this frame are kept',
    );
    assert.equal(fs.existsSync(path.join(swept.snapDir, PRUNE_MARKER)), true, 'and the sweep is dated');

    // A snapshot dir that has become unwritable — and the reason this case is HERE rather
    // than only in wrapper.test.ts, which runs the script through its own `#!/bin/sh` and
    // therefore under bash on macOS. POSIX says a redirection error on a SPECIAL built-in
    // (`:` is one) shall abort a non-interactive shell: `: > "$marker"` on a read-only
    // directory exits dash 2 and ksh 1 with the status line never printed, while bash
    // shrugs and carries on. RULE 1, broken on exactly the platform the package targets.
    // Skipped under root, which ignores 0555: the fixture would not be the state it claims.
    // A skip inside a test that passes says nothing at all, so the guard at the end of this
    // file says it instead — and, where the claim has to hold, fails.
    if (!ROOT) {
      const blocked = runUnder(shell, payload(), 'echo CHAINED', { [`${DEAD}.json`]: SNAPSHOT_TTL_MIN + 60 }, true);
      try {
        assert.match(blocked.stdout, /CHAINED/, 'the display renders even when nothing can be written');
        assert.equal(blocked.status, 0, 'and the status line still exits 0');
        await settle();
        assert.deepEqual(listSnapshots(blocked.snapDir), [`${DEAD}.json`], 'a dir we cannot stamp is not swept');

        // …and it does all of that SILENTLY. Redirections are applied left to right, so
        // `> "$tmp" 2>/dev/null` attempts the file while stderr is STILL the user's
        // terminal: the shell prints its own `cannot create …: Permission denied` as part
        // of performing that redirection, and the `2>` meant to swallow it only takes
        // effect afterwards. Exit code and display are untouched — `printf` is a regular
        // built-in, so a failed redirection only fails the command — which is precisely why
        // nothing else here catches it. But this runs on every frame of the TUI, so it is
        // one line of noise per frame on the terminal of a script whose first rule is to be
        // invisible. Only `2>/dev/null > "$tmp"` is quiet.
        assert.equal(blocked.stderr, '', 'nothing at all reaches the user terminal');
      } finally {
        fs.chmodSync(blocked.snapDir, 0o755);
      }
    }
  });
}

// A machine with no dash cannot prove the claim this suite exists to make, and a skip is
// the honest report of that. But a skip still exits 0 — so on the paths where the claim has
// to HOLD rather than merely be attempted (CI, and `prepublishOnly` before a release),
// TARMAC_REQUIRE_DASH turns the gap into a failure instead of a line that scrolls past.
// The same shape as the dash guard below, for the same reason, one property further out.
// The collation assertion inside each shell's test is conditional — it can only run where a
// locale exists under which that shell really does widen `a-f`. A condition that is silently
// false is a test that silently is not one, and this one was: written against a NAME list
// with `C.UTF-8` in it, it resolved to a locale that collates by code point, ran, and passed
// with the range spelling fully restored. The list is gone; this makes its absence audible.
test('the collation case was built for at least one shell', (t) => {
  if (exercised.size > 0) {
    assert.ok(true);
    return;
  }
  // A skip, not a failure, and the difference from the dash guard below is real: dash is one
  // `apt install` away, whereas a locale whose collation reaches past ASCII is a property of
  // the images this suite runs on — a minimal container may legitimately carry only `C` and
  // `C.UTF-8`, both of which collate by code point. Failing there would be blaming the runner
  // for a case it cannot build. The regression this protects against is NOT left to a skip:
  // `test/wrapper.test.ts` asserts, on every machine, that the rule contains no range at all.
  t.skip('no installed locale makes any shell here read `a-f` past ASCII: the case cannot be built on this machine');
});

// The read-only fixture is skipped under root, and a skip INSIDE a test that passes scrolls
// past with the test still green: in a root container the suite reports a full pass with the
// stderr pin and the three sweep assertions beside it never asked at all. Nothing there is
// root-specific — the block exists because `: > "$marker"` aborts dash on a directory it
// cannot write — so the case is only unbuildable, not inapplicable. Same treatment as dash,
// one property further out: a skip everywhere it is honest, a failure where the claim has to
// HOLD, and TARMAC_REQUIRE_READONLY is how a caller says which of the two it is asking for.
test('the read-only snapshot dir — where RULE 1 breaks on dash — was exercised', (t) => {
  if (!ROOT) {
    assert.ok(true);
    return;
  }
  const why = 'running as root: 0555 denies nothing, so RULE 1 on an unwritable dir was NOT proven here';
  if (process.env.TARMAC_REQUIRE_READONLY) assert.fail(why);
  t.skip(why);
});

test('dash — the /bin/sh of Debian and Ubuntu — was exercised', (t) => {
  if (!SHELLS.some((s) => s.label === 'dash')) {
    const why = 'dash is not installed here: POSIX conformance was NOT proven on this machine';
    if (process.env.TARMAC_REQUIRE_DASH) assert.fail(why);
    t.skip(why);
    return;
  }
  assert.ok(true);
});

// Running the script proves today's behaviour; this keeps the next edit honest, and fails
// on constructs that would only misbehave on an input the runtime tests do not cover.
const BASHISMS: Array<[RegExp, string]> = [
  [/\[\[/, '[[ … ]] test'],
  [/\(\(/, '(( … )) arithmetic command'],
  [/<<</, '<<< here-string'],
  [/&>/, '&> redirection'],
  [/\$'/, "$'…' ANSI-C quoting"],
  [/\bfunction\s+\w+/, 'function keyword'],
  [/\blocal\b/, 'local (dash implements it, POSIX does not require it)'],
  [/\b(declare|typeset)\b/, 'declare/typeset'],
  [/\bsource\b/, 'source (use .)'],
  [/\b(pushd|popd)\b/, 'pushd/popd'],
  [/\becho\s+-[en]/, 'echo -e / -n (use printf)'],
  [/==/, '== inside test (POSIX is =)'],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*\[/, 'array subscript'],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*(\^\^|,,)/, 'case-conversion expansion'],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*\/[^}]/, '${var/x/y} substitution'],
  [/\$(RANDOM|SECONDS|BASH[A-Z_]*)\b/, 'bash-only variable'],
  [/\bset\s+-o\s+pipefail\b/, 'set -o pipefail'],
  // This wrapper is entirely `${var#…}` / `${var%%…}` string surgery, so substring
  // expansion is exactly the shortcut a future edit reaches for. dash: "Bad substitution".
  [/\$\{[A-Za-z_][A-Za-z0-9_]*:\d/, '${var:offset:length} substring expansion'],
  [/[A-Za-z_][A-Za-z0-9_]*\+=/, '+= append assignment'],
  [/<\(/, '<(…) process substitution'],
  [/\$\(</, '$(< file) read'],
  [/printf\s+["']?[^"'\s]*%q/, 'printf %q'],
  [/\blet\s+[A-Za-z_]/, 'let arithmetic'],
  [/\bread\s+-[A-Za-z]*a/, 'read -a into an array'],
  [/\btrap\b[^\n]*\bERR\b/, 'trap … ERR'],
  [/\b(mapfile|readarray)\b/, 'mapfile/readarray'],
];

test('the generated wrapper source contains no bashism', () => {
  // Generated with no chain: whatever the user's own statusline command contains is THEIR
  // shell code, handed to `sh -c` exactly as Claude Code would have run it, and not ours
  // to police.
  const src = renderWrapper({ snapshotDir: "/tmp/od d's dir", chainCommand: null });
  for (const [pattern, what] of BASHISMS) {
    assert.equal(pattern.test(src), false, `wrapper uses ${what} — not POSIX sh, breaks on dash`);
  }
});

test('the wrapper declares the shell it was written for', () => {
  const src = renderWrapper({ snapshotDir: '/tmp/s', chainCommand: null });
  assert.match(src.split('\n')[0], /^#!\/bin\/sh$/, 'a #!/bin/bash shebang would be a lie on Debian');
});
