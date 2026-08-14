import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { install, uninstall, paths, planInstall, planUninstall, countLegacySnapshots, purgeLegacySnapshots, installedSnapshotsDir, wrapperIsOurs } from '../src/install.ts';
import type { UninstallMode } from '../src/install.ts';
import { renderPlan } from '../src/render.ts';
import { renderWrapper, PRUNE_MARKER, TEMP_PREFIX, WRAPPER_MARKER } from '../src/wrapper.ts';
import { escapeRe } from '../src/reap.ts';

function fakeHome(settingsText?: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-home-'));
  fs.mkdirSync(path.join(home, '.claude'));
  if (settingsText !== undefined) fs.writeFileSync(path.join(home, '.claude', 'settings.json'), settingsText);
  return home;
}
const settingsOf = (home: string): string => fs.readFileSync(paths(home).settings, 'utf8');
const jsonOf = (home: string): Record<string, any> => JSON.parse(settingsOf(home));

// ── the plan: everything the user is told BEFORE a byte is written ────────────────────
// The spike refused the real HOME outright. A released tool cannot: installing into your
// own home is the point. What replaces the refusal is this — a dry run that names the file,
// quotes the command it will wrap, and spells out the way back, computed by reading only.

test('the install plan names the file it will edit and the command it will wrap, verbatim', () => {
  const home = fakeHome(JSON.stringify({ statusLine: { type: 'command', command: '~/bin/mine.sh --flag' } }));
  const plan = planInstall({ home });
  assert.equal(plan.settings, paths(home).settings);
  assert.equal(plan.before, '~/bin/mine.sh --flag', 'settings.json as it stands');
  assert.equal(plan.chained, '~/bin/mine.sh --flag', 'and that is what the wrapper will call');
  assert.equal(plan.after, paths(home).wrapper);
});

test('the install plan says so when there is no statusLine to wrap', () => {
  const plan = planInstall({ home: fakeHome('{"model":"opus"}') });
  assert.equal(plan.before, null);
  assert.equal(plan.chained, null);
});

// A plan that can disagree with what runs is worse than no plan. These two are derived
// from the same read, and the test compares the promise to the deed.
test('the install plan predicts exactly what install then writes', () => {
  const home = fakeHome(JSON.stringify({ statusLine: { type: 'command', command: 'echo MINE' } }));
  const plan = planInstall({ home });
  install({ home });
  assert.equal(jsonOf(home).statusLine.command, plan.after);
});

test('the install plan tells a re-install that the wrapper will be regenerated', () => {
  const home = fakeHome(JSON.stringify({ statusLine: { type: 'command', command: 'echo MINE' } }));
  install({ home });
  const plan = planInstall({ home });
  assert.equal(plan.alreadyInstalled, true);
  assert.equal(plan.before, paths(home).wrapper, 'settings.json already points at us');
  assert.equal(plan.chained, 'echo MINE', 'and the command we wrapped is read back from the backup');
  assert.equal(plan.after, paths(home).wrapper);
});

// Every refusal has to happen while planning, not after the user has typed the word: the
// prompt must never appear for an install that was going to throw anyway.
test('the install plan refuses a settings.json it cannot parse, and touches nothing', () => {
  const home = fakeHome('{ this is not json ');
  assert.throws(() => planInstall({ home }), /not valid JSON/);
  assert.equal(settingsOf(home), '{ this is not json ', 'file untouched');
  assert.equal(fs.existsSync(paths(home).wrapper), false, 'no wrapper written either');
});

test('the install plan refuses a statusLine shape it cannot chain', () => {
  const home = fakeHome(JSON.stringify({ statusLine: { type: 'ansi', magic: true } }));
  assert.throws(() => planInstall({ home }), /statusLine/);
});

test('the install plan refuses a re-install whose backup is gone', () => {
  const home = fakeHome(JSON.stringify({ statusLine: { type: 'command', command: 'echo MINE' } }));
  install({ home });
  fs.rmSync(paths(home).backup);
  assert.throws(() => planInstall({ home }), /backup/);
});

// C1: `path.resolve` normalises `..` and trailing slashes but resolves neither symlinks nor
// macOS firmlinks — so string equality cannot tell you whether this is YOUR home. Identity
// is the file itself (device + inode), the same through every spelling. The spike used it
// to refuse; the plan uses it to say which terminal is about to change under you.
test('the plan recognises the real home through a symlink', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-realhome-'));
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-link-')), 'home');
  fs.symlinkSync(real, link);
  assert.equal(planInstall({ home: link, realHome: real }).isRealHome, true);
});

test('the plan recognises the real home spelled with a trailing slash', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-realhome-'));
  assert.equal(planInstall({ home: real + '/', realHome: real }).isRealHome, true);
});

test('the plan does not mistake a different directory for the real home', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-realhome-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-sandbox-'));
  assert.equal(planInstall({ home: other, realHome: real }).isRealHome, false);
});

// "The exact command that undoes it" is exact or it is a lie: undoing an install into a
// directory that is not your home needs the flag that put it there.
test('the undo command carries --home unless the target is the real home', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-realhome-'));
  fs.mkdirSync(path.join(real, '.claude'));
  assert.equal(planInstall({ home: real, realHome: real }).undo, 'tarmac uninstall');
  const other = fakeHome('{}');
  assert.equal(planInstall({ home: other, realHome: real }).undo, `tarmac uninstall --home ${other}`);
});

// "Exact" has to survive a copy-paste, and a home directory with a space in it is ordinary
// on macOS. An unquoted path would print a command that runs against the wrong directory.
test('the undo command is pasteable when the home has a space in it', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-space-'));
  const home = path.join(parent, "od d's home");
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-realhome-'));
  const { undo } = planInstall({ home, realHome: real });
  assert.equal(undo, `tarmac uninstall --home '${home.replace(/'/g, `'\\''`)}'`);
  // and it really is one argument once a shell has read it
  const seen = execFileSync('/bin/sh', ['-c', `printf '%s' ${undo.split('--home ')[1]}`], { encoding: 'utf8' });
  assert.equal(seen, home);
});

// `--home /Usres/jane` used to build a complete, useless install under the typo and
// report success — the exact failure `args.ts` refuses for flags ("a typo silently ignored
// is how someone ends up believing they pointed tarmac at a directory it never read").
test('refuses a --home that does not exist, instead of building a tree inside the typo', () => {
  const missing = path.join(os.tmpdir(), `tarmac-not-here-${process.pid}`);
  assert.throws(() => planInstall({ home: missing }), /does not exist/);
  assert.equal(fs.existsSync(missing), false, 'and created nothing');
});

test('refuses a --home that is a file, while planning rather than mid-write', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-file-')), 'not-a-dir');
  fs.writeFileSync(file, '');
  assert.throws(() => planInstall({ home: file }), /not a directory/);
});

test('uninstall names the file that is not JSON instead of leaking a parser error', () => {
  const home = fakeHome(MINE);
  install({ home });
  fs.writeFileSync(paths(home).settings, '{ this is not json ');
  assert.throws(() => planUninstall({ home }), /not valid JSON/);
});

// With a symlinked settings.json the bytes land somewhere else than the path the plan
// names. That is now supported — so it has to be visible, or the plan is not what happens.
test('the plan says where the bytes really land when settings.json is a symlink', () => {
  const home = fakeHome();
  const store = path.join(home, 'dotfiles');
  fs.mkdirSync(store);
  const dotfile = path.join(store, 'settings.json');
  fs.writeFileSync(dotfile, MINE);
  fs.symlinkSync(dotfile, paths(home).settings);
  const plan = planInstall({ home });
  assert.equal(plan.settings, paths(home).settings);
  assert.equal(plan.writes, dotfile, 'the file the write actually reaches, as the link names it');
  assert.match(renderPlan(plan), new RegExp(escapeForTest(dotfile)));
  assert.equal(planInstall({ home: fakeHome(MINE) }).writes, null, 'and nothing extra to say when there is no link');
});

// Uninstall has four outcomes and they are not interchangeable — one of them ("foreign")
// restores nothing at all. Telling the user afterwards is not enough when the whole point
// of the prompt is to decide BEFORE, so the plan predicts the mode, and each case checks
// the prediction against what uninstall then reports.
const MINE = JSON.stringify({ statusLine: { type: 'command', command: 'echo MINE' } });
const RESTORES: Array<{
  mode: UninstallMode;
  when: string;
  settings?: string;
  disturb?: (home: string) => void;
  after: string | null;
}> = [
  { mode: 'bytes', when: 'settings.json has not been touched since install', settings: MINE, after: 'echo MINE' },
  { mode: 'absent', when: 'there was no settings.json before install', after: null },
  {
    mode: 'surgical',
    when: 'settings.json has been edited since install',
    settings: MINE,
    disturb: (home) => {
      const edited = JSON.parse(fs.readFileSync(paths(home).settings, 'utf8'));
      edited.env = { FOO: 'bar' };
      fs.writeFileSync(paths(home).settings, JSON.stringify(edited, null, 2));
    },
    after: 'echo MINE',
  },
  {
    mode: 'foreign',
    when: 'someone else has taken the statusLine over',
    settings: MINE,
    disturb: (home) =>
      fs.writeFileSync(paths(home).settings, JSON.stringify({ statusLine: { type: 'command', command: 'other.sh' } })),
    after: 'other.sh',
  },
];

for (const { mode, when, settings, disturb, after } of RESTORES) {
  test(`the uninstall plan predicts "${mode}" when ${when}`, () => {
    const home = fakeHome(settings);
    install({ home });
    disturb?.(home);
    const plan = planUninstall({ home });
    assert.equal(plan.mode, mode);
    assert.equal(plan.after, after, 'and what the statusLine will say afterwards');
    assert.equal(uninstall({ home }).mode, plan.mode, 'uninstall reports the mode the plan promised');
  });
}

test('the uninstall plan reads the statusLine as it stands now', () => {
  const home = fakeHome(MINE);
  install({ home });
  assert.equal(planUninstall({ home }).before, paths(home).wrapper);
});

test('the uninstall plan refuses when there is no install to undo', () => {
  assert.throws(() => planUninstall({ home: fakeHome('{}') }), /no tarmac install/);
});

test('the way back from an uninstall is the install that undoes it', () => {
  const home = fakeHome(MINE);
  install({ home });
  assert.equal(planUninstall({ home }).undo, `tarmac install --home ${home}`);
});

// ── the plan, in words ────────────────────────────────────────────────────────────────
// What the user reads is the only thing they can consent to, so the three facts the
// confirmation rests on have to be IN it: the file, the command, and the way back.
test('the printed plan carries the file, both statusLine values and the undo command', () => {
  const home = fakeHome(MINE);
  const text = renderPlan(planInstall({ home }));
  assert.match(text, new RegExp(escapeForTest(paths(home).settings)), 'the file it will edit');
  assert.match(text, /echo MINE/, 'the command it will wrap, verbatim');
  assert.match(text, new RegExp(escapeForTest(paths(home).wrapper)), 'what statusLine will say next');
  assert.match(text, new RegExp(escapeForTest(`tarmac uninstall --home ${home}`)), 'the way back');
});

test('the printed plan says out loud when the target is your own home', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-realhome-'));
  fs.mkdirSync(path.join(real, '.claude'));
  assert.match(renderPlan(planInstall({ home: real, realHome: real })), /your home/i);
  const other = fakeHome('{}');
  assert.doesNotMatch(renderPlan(planInstall({ home: other, realHome: real })), /your home/i);
});

// "foreign" is the outcome that undoes nothing. Anyone about to type the word has to read
// that before typing it, not in the report afterwards.
test('the printed uninstall plan warns when it would restore nothing', () => {
  const home = fakeHome(MINE);
  install({ home });
  fs.writeFileSync(paths(home).settings, JSON.stringify({ statusLine: { type: 'command', command: 'other.sh' } }));
  const text = renderPlan(planUninstall({ home }));
  assert.match(text, /foreign/);
  assert.match(text, /nothing/i, 'and what "foreign" means, in words');
  assert.match(text, /prune marker stays/i, 'and that the wrapper still owns its marker');
});

test('the printed uninstall plan distinguishes snapshot files from the prune marker', () => {
  const home = fakeHome('{}');
  install({ home });
  const text = renderPlan(planUninstall({ home }));
  assert.match(text, /snapshot files stay/i);
  assert.match(text, /prune marker is removed/i);
  assert.doesNotMatch(text, /left exactly as they are/i);
});

const escapeForTest = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── the command line ──────────────────────────────────────────────────────────────────
// `install` with no flags means "this home", which is the whole point of the lot — and the
// reason every run below sets HOME to a throwaway directory. `os.homedir()` reads $HOME, so
// the suite can exercise the default target without the real one ever being reachable.
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

function tarmac(argv: string[], home: string): { status: number | null; stdout: string; stderr: string } {
  // HOME is replaced, so `os.homedir()` returns the throwaway one and the runs below exercise
  // the default target. XDG_STATE_HOME is REMOVED for the same reason it is removed in
  // `cli-config.test.ts`: with $HOME faked, the two anchors coincide and the guard in
  // `stateRoot` reads true — a variable in the developer's shell would otherwise send this
  // suite's snapshots into their real state directory, quietly, while every assertion passed.
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  delete env.XDG_STATE_HOME;
  const r = spawnSync(process.execPath, [CLI, ...argv], { env, encoding: 'utf8', timeout: 20000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('install with no flags targets the home it runs under — and will not do it unasked', () => {
  const home = fakeHome('{}');
  const run = tarmac(['install'], home);
  assert.equal(run.status, 1);
  assert.match(run.stdout, new RegExp(escapeForTest(paths(home).settings)), 'the plan was printed first');
  assert.match(run.stderr, /--yes/, 'and the refusal names the flag that would allow it');
  assert.equal(settingsOf(home), '{}', 'settings.json untouched');
  assert.equal(fs.existsSync(paths(home).wrapper), false, 'no wrapper written');
});

// The identity question "is this command OUR wrapper?" used to be `stat` of the raw string,
// so any spelling a shell resolves and `stat` does not defeated it — starting with `~/…`,
// which is exactly how this machine's own production statusLine is written. tarmac then
// wrapped its own wrapper: unbounded recursion at every frame, and the backup rewritten
// with the wrapper itself, erasing the only record of the statusline it was meant to chain.
test('recognises its own wrapper spelled with a tilde instead of wrapping it again', () => {
  const home = fakeHome(MINE);
  tarmac(['install', '--yes'], home);
  // the user re-spells their statusLine portably, as anyone with dotfiles eventually does
  const settings = jsonOf(home);
  settings.statusLine.command = paths(home).wrapper.replace(home, '~');
  fs.writeFileSync(paths(home).settings, JSON.stringify(settings, null, 2));

  const run = tarmac(['install', '--yes'], home);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /already installed/, 'it knows it is looking at itself');
  const backup = JSON.parse(fs.readFileSync(paths(home).backup, 'utf8'));
  assert.equal(backup.previous.command, 'echo MINE', 'the record of the real statusline survives');
  assert.match(fs.readFileSync(paths(home).wrapper, 'utf8'), /TARMAC_CHAIN='echo MINE'/, 'and it never chains itself');
});

test('recognises its own wrapper through a quoted spelling', () => {
  const home = fakeHome(MINE);
  tarmac(['install', '--yes'], home);
  const settings = jsonOf(home);
  settings.statusLine.command = `'${paths(home).wrapper}'`;
  fs.writeFileSync(paths(home).settings, JSON.stringify(settings, null, 2));
  assert.equal(planInstall({ home }).alreadyInstalled, true);
});

// Belt and braces: a spelling nobody anticipated still cannot make tarmac wrap a tarmac
// wrapper, because the file itself says what it is.
test('never wraps a file that says it is a tarmac wrapper, whatever path led to it', () => {
  const home = fakeHome();
  const stray = path.join(home, 'copied-wrapper.sh');
  fs.writeFileSync(stray, renderWrapper({ snapshotDir: '/tmp/elsewhere', chainCommand: null }));
  fs.writeFileSync(paths(home).settings, JSON.stringify({ statusLine: { type: 'command', command: stray } }));
  // Recognised as a wrapper, and there is no backup naming what IT wraps — so tarmac
  // refuses rather than nest one wrapper inside another and lose that record.
  assert.throws(() => planInstall({ home }), /tarmac wrapper/);
  assert.equal(fs.existsSync(paths(home).wrapper), false, 'and wrote nothing');
});

// …and the anchor is the home being INSTALLED INTO, not the one the process runs from.
// `--home` is the whole point of the flag, and a `~` in that home's settings.json will be
// expanded by the shell of a Claude Code running under THAT home. Resolving it against
// `os.homedir()` left the blocker fully intact for every `--home` install — invisible to a
// test that spawns with `HOME` set to the target, because there the two anchors coincide.
test('resolves ~ against the home being installed into, not the one it runs from', () => {
  const running = fakeHome('{}');
  const target = fakeHome(MINE);
  tarmac(['install', '--home', target, '--yes'], running);
  const settings = jsonOf(target);
  settings.statusLine.command = '~/.claude/tarmac/statusline.sh';
  fs.writeFileSync(paths(target).settings, JSON.stringify(settings, null, 2));

  const run = tarmac(['install', '--home', target, '--yes'], running);
  assert.match(run.stdout, /already installed/, 'recognised as its own wrapper');
  const backup = JSON.parse(fs.readFileSync(paths(target).backup, 'utf8'));
  assert.equal(backup.previous.command, 'echo MINE', 'the record of the real statusline survives');
});

// The quoting we write and the reading we do are inverse operations or they are a bug: an
// apostrophe in the home is the one character `quoteArg` transforms rather than wraps, and
// tarmac stopped recognising its own install there — chaining itself, and unable to uninstall.
test("a home with an apostrophe survives the whole round trip", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-quote-'));
  const home = path.join(parent, "od d's home");
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(paths(home).settings, MINE);

  install({ home });
  const command = jsonOf(home).statusLine.command;
  const out = execFileSync('/bin/sh', ['-c', command], { input: '{"session_id":"abcdefgh-1111"}', encoding: 'utf8' });
  assert.match(out, /MINE/, 'the display still renders');
  assert.equal(planInstall({ home }).alreadyInstalled, true, 'and tarmac knows the line is its own');
  assert.equal(uninstall({ home }).mode, 'bytes', 'and can take itself back out');
});

// The marker answers "is this a tarmac wrapper?" — which is the right question when deciding
// whether to WRAP something, and the wrong one when deciding whether to OVERWRITE it. A
// script of the user's that merely mentions the wrapper is not ours to restore over.
test('a foreign statusLine that merely mentions the wrapper is still foreign', () => {
  const home = fakeHome(MINE);
  install({ home });
  const theirs = path.join(home, 'my-statusline.sh');
  fs.writeFileSync(theirs, `#!/bin/sh\n# calls the ${WRAPPER_MARKER} that tarmac wrote\nexec ${paths(home).wrapper}\n`);
  fs.writeFileSync(paths(home).settings, JSON.stringify({ statusLine: { type: 'command', command: theirs } }));

  assert.equal(planUninstall({ home }).mode, 'foreign', 'predicted foreign');
  assert.equal(uninstall({ home }).mode, 'foreign');
  assert.equal(jsonOf(home).statusLine.command, theirs, 'their line is untouched');
  assert.equal(fs.existsSync(paths(home).wrapper), true, 'and the wrapper it execs still exists');
});

// The last-ditch refusal — the one that exists precisely so a lost backup cannot turn into a
// fork bomb — was still comparing the raw string, so the same spelling walked past it too.
test('refuses to chain the wrapper to itself, however the backup spells the command', () => {
  const home = fakeHome(MINE);
  install({ home });
  const backup = JSON.parse(fs.readFileSync(paths(home).backup, 'utf8'));
  backup.previous.command = '~/.claude/tarmac/statusline.sh';
  fs.writeFileSync(paths(home).backup, JSON.stringify(backup));
  assert.throws(() => install({ home }), /itself/);
});

// The plan reads a path out of someone's settings.json before the prompt. A FIFO with no
// writer, or a dead network mount, must not hang the tool with no output and no way out.
test('a statusLine pointing at a FIFO does not hang the plan', () => {
  const home = fakeHome();
  const fifo = path.join(home, 'fifo');
  execFileSync('mkfifo', [fifo]);
  fs.writeFileSync(paths(home).settings, JSON.stringify({ statusLine: { type: 'command', command: fifo } }));
  const run = tarmac(['install', '--home', home], home);
  assert.notEqual(run.status, null, 'it finished rather than hanging');
  assert.match(run.stderr, /--yes/, 'and got as far as asking');
});

// Told with a spelling of our own path, since with the canonical one "announces a change"
// and "announces nothing" are the same string, and a plan that cannot be caught lying is
// not being checked.
test('a re-install plan does not announce a change it will not make', () => {
  const home = fakeHome(MINE);
  tarmac(['install', '--yes'], home);
  const settings = jsonOf(home);
  const spelling = '~/.claude/tarmac/statusline.sh';
  settings.statusLine.command = spelling;
  fs.writeFileSync(paths(home).settings, JSON.stringify(settings, null, 2));

  const plan = planInstall({ home, realHome: home });
  assert.equal(plan.alreadyInstalled, true);
  assert.equal(plan.after, spelling, 'settings.json is left exactly as it is');
  assert.equal(plan.after, plan.before);
});

test('a dangling symlink is written through, not replaced by a regular file', () => {
  const home = fakeHome();
  const store = path.join(home, 'dotfiles');
  fs.mkdirSync(store);
  const dotfile = path.join(store, 'settings.json'); // the dotfiles repo is not cloned yet
  fs.symlinkSync(dotfile, paths(home).settings);

  install({ home });
  assert.equal(fs.lstatSync(paths(home).settings).isSymbolicLink(), true, 'the link survives');
  assert.equal(fs.existsSync(dotfile), true, 'and the file it named is what got created');
});

test('install --yes installs into the home it runs under', () => {
  const home = fakeHome(MINE);
  const run = tarmac(['install', '--yes'], home);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(jsonOf(home).statusLine.command, paths(home).wrapper);
});

test('uninstall --yes is symmetrical, and says which restore ran', () => {
  const home = fakeHome(MINE);
  tarmac(['install', '--yes'], home);
  const run = tarmac(['uninstall', '--yes'], home);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /bytes/);
  assert.deepEqual(jsonOf(home).statusLine, { type: 'command', command: 'echo MINE' });
});

test('--home still chooses the target, and no longer means "a sandbox"', () => {
  const running = fakeHome('{}');
  const target = fakeHome('{}');
  const run = tarmac(['install', '--home', target, '--yes'], running);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.existsSync(paths(target).wrapper), true);
  assert.equal(fs.existsSync(paths(running).wrapper), false, 'the home it ran under was left alone');
});

// The prompt is for decisions, not for operations that were never going to happen.
test('a refusal lands before the prompt, not after it', () => {
  const home = fakeHome('{ this is not json ');
  const run = tarmac(['install'], home);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /not valid JSON/);
  assert.doesNotMatch(run.stdout, /Type "install"/, 'nothing was ever asked');
});

// ── install ───────────────────────────────────────────────────────────────────────────
test('points statusLine at the tarmac wrapper', () => {
  const home = fakeHome('{"model":"opus"}');
  install({ home });
  assert.equal(jsonOf(home).statusLine.command, paths(home).wrapper);
  assert.equal(jsonOf(home).model, 'opus');
});

test('writes an executable wrapper', () => {
  const home = fakeHome('{}');
  install({ home });
  const st = fs.statSync(paths(home).wrapper);
  assert.ok(st.mode & 0o111, 'wrapper is executable');
});

test('the installed wrapper still renders the statusline it wrapped', () => {
  const home = fakeHome(JSON.stringify({ statusLine: { type: 'command', command: 'echo MINE' } }));
  install({ home });
  const out = execFileSync(paths(home).wrapper, { input: '{"session_id":"abcdefgh-1"}', encoding: 'utf8' });
  assert.match(out, /MINE/);
});

test('creates settings.json when there is none', () => {
  const home = fakeHome();
  install({ home });
  assert.equal(jsonOf(home).statusLine.command, paths(home).wrapper);
});

test('creates the .claude directory when there is none', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-bare-'));
  install({ home });
  assert.equal(jsonOf(home).statusLine.command, paths(home).wrapper);
});

test('refuses to write over settings.json it could not parse', () => {
  const home = fakeHome('{ this is not json ');
  assert.throws(() => install({ home }), /not valid JSON/);
  assert.equal(settingsOf(home), '{ this is not json ', 'file untouched');
});

test('installing twice wraps only once and keeps the original command', () => {
  const home = fakeHome(JSON.stringify({ statusLine: { type: 'command', command: 'echo MINE' } }));
  install({ home });
  const first = fs.readFileSync(paths(home).backup, 'utf8');
  const res = install({ home });
  assert.equal(res.alreadyInstalled, true);
  assert.equal(jsonOf(home).statusLine.command, paths(home).wrapper);
  assert.equal(fs.readFileSync(paths(home).backup, 'utf8'), first, 'backup not overwritten by the second install');
  const out = execFileSync(paths(home).wrapper, { input: '{"session_id":"abcdefgh-1"}', encoding: 'utf8' });
  assert.match(out, /MINE/, 'still chains the real statusline, not itself');
});

// Losing the backup means we can no longer name the statusline we wrapped. Regenerating
// the wrapper from that hole would drop the user's real statusline for good, exit 0, and
// say nothing — so a re-install in that state must refuse and touch nothing.
test('refuses to re-install when the backup is gone, keeping the wrapper intact', () => {
  const home = fakeHome(JSON.stringify({ statusLine: { type: 'command', command: 'echo MINE' } }));
  install({ home });
  const wrapperBefore = fs.readFileSync(paths(home).wrapper, 'utf8');
  fs.rmSync(paths(home).backup);

  assert.throws(() => install({ home }), /backup/);
  assert.equal(fs.readFileSync(paths(home).wrapper, 'utf8'), wrapperBefore, 'wrapper untouched');
  const out = execFileSync(paths(home).wrapper, { input: '{"session_id":"abcdefgh-1"}', encoding: 'utf8' });
  assert.match(out, /MINE/, 'the wrapped statusline is still chained');
});

// C2, on disk: the same directory reached by two different path strings. Installing under
// both must not make the wrapper chain itself — identity is device+inode, not the spelling.
function spellingHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-spell-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(paths(home).settings, JSON.stringify({ statusLine: { type: 'command', command: 'echo PRECIOUS' } }));
  return home;
}

function assertChainedOnce(home: string): void {
  const wrapper = fs.readFileSync(paths(home).wrapper, 'utf8');
  assert.match(wrapper, /TARMAC_CHAIN='echo PRECIOUS'/);
  assert.equal(wrapper.includes(`TARMAC_CHAIN='${paths(home).wrapper}'`), false, 'never chains itself');
}

test('installing through a symlink to the same home never chains the wrapper to itself', () => {
  const home = spellingHome();
  const link = `${home}-link`;
  fs.symlinkSync(home, link);
  install({ home });
  const res = install({ home: link });
  assert.equal(res.alreadyInstalled, true, 'recognised itself under the other spelling');
  assertChainedOnce(home);
});

// The spelling that FOUND C2, and the harsher one: a macOS firmlink is not a symlink and
// `realpath` does not collapse it, so `/tmp/x` and `/private/tmp/x` stay two strings for the
// same inode. It exists on darwin only — and the portable symlink case above is what keeps
// this file honest everywhere else, rather than a skip standing in for a check.
test('installing under both macOS spellings of /tmp never chains the wrapper to itself', (t) => {
  if (process.platform !== 'darwin' || !fs.existsSync('/private/tmp')) {
    t.skip('macOS firmlinks only');
    return;
  }
  const home = fs.mkdtempSync(path.join('/tmp', 'tarmac-spell-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(paths(home).settings, JSON.stringify({ statusLine: { type: 'command', command: 'echo PRECIOUS' } }));
  install({ home });
  const res = install({ home: path.join('/private', home.replace(/^\/private/, '').replace(/^\//, '')) });
  assert.equal(res.alreadyInstalled, true, 'recognised itself under the other spelling');
  assertChainedOnce(home);
});

// C4: `{}` parses fine and is truthy. The guard must check the SHAPE, because `previous:
// null` is a legitimate value ("there was no statusLine") — presence of the key is the only
// discriminant, exactly as for `used_percentage`.
test('refuses to re-install when the backup parses but carries nothing', () => {
  const home = fakeHome(JSON.stringify({ statusLine: { type: 'command', command: 'echo MINE' } }));
  install({ home });
  fs.writeFileSync(paths(home).backup, '{}');
  assert.throws(() => install({ home }), /backup/);
  const out = execFileSync(paths(home).wrapper, { input: '{"session_id":"abcdefgh-1"}', encoding: 'utf8' });
  assert.match(out, /MINE/, 'the wrapped statusline is still chained');
});

test('accepts a backup whose previous is legitimately null', () => {
  const home = fakeHome('{}');
  install({ home });
  const res = install({ home });
  assert.equal(res.alreadyInstalled, true);
});

test('refuses to re-install when the backup is corrupt', () => {
  const home = fakeHome(JSON.stringify({ statusLine: { type: 'command', command: 'echo MINE' } }));
  install({ home });
  fs.writeFileSync(paths(home).backup, '{ truncated');
  assert.throws(() => install({ home }), /backup/);
});

// "The `command` field runs in a shell" (Claude Code statusline docs), so what tarmac
// writes there is shell source, not a path. Written raw, a wrapper under a home with a
// space in its name is word-split: the status line dies with 127 at every frame, and the
// display tarmac promises never to break is the first thing that goes.
test('a wrapper path with a space is written so the shell reads it as one argument', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-space-'));
  const home = path.join(parent, 'My Home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(paths(home).settings, MINE);

  const plan = planInstall({ home });
  install({ home });

  const command = jsonOf(home).statusLine.command;
  assert.equal(plan.after, command, 'and the plan showed that spelling, not a path it never wrote');
  const out = execFileSync('/bin/sh', ['-c', command], { input: '{"session_id":"abcdefgh-1111"}', encoding: 'utf8' });
  assert.match(out, /MINE/, 'the display the user already had still renders');
  assert.equal(planInstall({ home }).alreadyInstalled, true, 'and tarmac still recognises that spelling as its own');
});

test('a wrapper path that needs no quoting is written plainly', () => {
  const home = fakeHome(MINE);
  install({ home });
  assert.equal(jsonOf(home).statusLine.command, paths(home).wrapper);
});

// A settings.json kept in a dotfiles repo and symlinked into place is the normal setup for
// exactly the people who install a tool like this. Renaming over the LINK replaces it with
// a regular file: the dotfile silently stops being the source of truth, and no restore ever
// puts the link back — the one damage this codebase's reversibility model cannot undo.
test('a symlinked settings.json stays a symlink, and its target is what changes', () => {
  const home = fakeHome();
  const store = path.join(home, 'dotfiles');
  fs.mkdirSync(store);
  const dotfile = path.join(store, 'settings.json');
  fs.writeFileSync(dotfile, MINE);
  fs.symlinkSync(dotfile, paths(home).settings);

  install({ home });
  assert.equal(fs.lstatSync(paths(home).settings).isSymbolicLink(), true, 'the link survives install');
  assert.equal(JSON.parse(fs.readFileSync(dotfile, 'utf8')).statusLine.command, paths(home).wrapper, 'the dotfile is what changed');

  uninstall({ home });
  assert.equal(fs.lstatSync(paths(home).settings).isSymbolicLink(), true, 'and survives uninstall');
  assert.equal(fs.readFileSync(dotfile, 'utf8'), MINE, 'restored into the dotfile, byte for byte');
});

// `-rw-------` on a settings file is a decision, not an accident, and a restore that hands
// it back world-readable is not the file the user had.
test('the permissions of settings.json survive install and uninstall', () => {
  const home = fakeHome(MINE);
  fs.chmodSync(paths(home).settings, 0o600);
  install({ home });
  assert.equal(fs.statSync(paths(home).settings).mode & 0o777, 0o600, 'install did not widen them');
  uninstall({ home });
  assert.equal(fs.statSync(paths(home).settings).mode & 0o777, 0o600, '"byte for byte" includes who may read the bytes');
});

// ── uninstall ─────────────────────────────────────────────────────────────────────────
test('restores the original settings.json byte for byte', () => {
  const original = '{\n    "model": "opus",\n    "statusLine": { "type": "command", "command": "echo MINE" }\n}\n';
  const home = fakeHome(original);
  install({ home });
  assert.notEqual(settingsOf(home), original, 'install really changed the file');
  uninstall({ home });
  assert.equal(settingsOf(home), original);
});

test('restores a settings.json that had no statusLine, byte for byte', () => {
  const original = '{\n  "model": "opus"\n}\n';
  const home = fakeHome(original);
  install({ home });
  uninstall({ home });
  assert.equal(settingsOf(home), original);
});

test('removes settings.json again when it did not exist before', () => {
  const home = fakeHome();
  install({ home });
  uninstall({ home });
  assert.equal(fs.existsSync(paths(home).settings), false);
});

test('removes the generated wrapper and the backup', () => {
  const home = fakeHome('{}');
  install({ home });
  uninstall({ home });
  assert.equal(fs.existsSync(paths(home).wrapper), false);
  assert.equal(fs.existsSync(paths(home).backup), false);
});

test('keeps unrelated edits made after install, and still restores the statusLine', () => {
  const home = fakeHome(JSON.stringify({ statusLine: { type: 'command', command: 'echo MINE' } }));
  install({ home });
  const edited = JSON.parse(settingsOf(home));
  edited.env = { FOO: 'bar' };
  fs.writeFileSync(paths(home).settings, JSON.stringify(edited, null, 2));
  uninstall({ home });
  assert.deepEqual(jsonOf(home).statusLine, { type: 'command', command: 'echo MINE' });
  assert.deepEqual(jsonOf(home).env, { FOO: 'bar' });
});

// C3: refusing to touch a foreign statusLine is right, but uninstall used to delete the
// wrapper and the backup anyway while reporting success — leaving settings pointing at a
// file that no longer exists (exit 127 every frame) and no way back.
test('leaves a statusLine that someone else changed after install alone', () => {
  const home = fakeHome(JSON.stringify({ statusLine: { type: 'command', command: 'echo MINE' } }));
  install({ home });
  fs.writeFileSync(
    paths(home).settings,
    JSON.stringify({ statusLine: { type: 'command', command: 'other.sh' } }, null, 2),
  );
  const res = uninstall({ home });
  assert.equal(res.mode, 'foreign', 'does not claim it restored anything');
  assert.deepEqual(jsonOf(home).statusLine, { type: 'command', command: 'other.sh' });
});

test('keeps the wrapper and the backup when it restored nothing', () => {
  const home = fakeHome(JSON.stringify({ statusLine: { type: 'command', command: 'echo MINE' } }));
  install({ home });
  fs.writeFileSync(paths(home).settings, JSON.stringify({ statusLine: { type: 'command', command: 'other.sh' } }));
  uninstall({ home });
  assert.equal(fs.existsSync(paths(home).wrapper), true, 'the wrapper someone may still point at survives');
  assert.equal(fs.existsSync(paths(home).backup), true, 'the way back survives');
});

// I7: the backup is the only way back, so it must exist on disk BEFORE settings.json sends
// Claude Code to the wrapper. Crashing between the two used to lock the user out of both
// install (backup missing) and uninstall (no install found).
test('writes the backup before it points settings at the wrapper', () => {
  const home = fakeHome(JSON.stringify({ statusLine: { type: 'command', command: 'echo MINE' } }));
  install({ home });
  assert.ok(fs.statSync(paths(home).backup).mtimeMs <= fs.statSync(paths(home).settings).mtimeMs);
});

// The other end of that order. The wrapper and the backup are on disk when the settings
// write runs, so a write that THROWS used to leave both — with settings.json never pointing
// at us, which is exactly the state `uninstall` reports as `foreign` and clears nothing.
// A settings.json symlinked into a directory that is not there yet (a dotfiles repo not
// cloned) reaches that failure without touching permissions, on every platform.
function danglingSettings(home: string): void {
  fs.rmSync(paths(home).settings, { force: true });
  fs.symlinkSync(path.join(home, 'not-cloned', 'settings.json'), paths(home).settings);
}

test('an install whose settings write fails takes back what it created', () => {
  const home = fakeHome();
  danglingSettings(home);

  assert.throws(() => install({ home }), /ENOENT/);
  assert.equal(fs.existsSync(paths(home).wrapper), false, 'the wrapper it wrote is gone');
  assert.equal(fs.existsSync(paths(home).backup), false, 'so is the backup that names no install');
  assert.equal(fs.existsSync(paths(home).dir), false, 'and the directory it made for them');
});

test('the unwind leaves what it did not create, including the user config', () => {
  const home = fakeHome();
  fs.mkdirSync(paths(home).dir, { recursive: true });
  fs.writeFileSync(paths(home).config, '{"claudeBin":"claude"}');
  danglingSettings(home);

  assert.throws(() => install({ home }), /ENOENT/);
  assert.equal(fs.existsSync(paths(home).wrapper), false, 'still takes back its own wrapper');
  assert.equal(fs.readFileSync(paths(home).config, 'utf8'), '{"claudeBin":"claude"}', 'the config is the user\'s');
  assert.equal(fs.existsSync(paths(home).dir), true, 'so the directory holding it stays');
});

// The pendant of the dangling case above, and by far the commoner one: the dotfiles repo IS
// cloned, so the link RESOLVES. `writeFileSync` follows it — which means the bytes this run
// destroys are the user's own script, at the far end of a link the unwind never looked
// through. Reading only what `lstat` calls a file saved the dangling case and missed this.
test('the unwind puts back the live symlink target it wrote through', () => {
  const home = fakeHome('{}');
  const dotfiles = path.join(home, 'dotfiles');
  fs.mkdirSync(dotfiles);
  const theirs = path.join(dotfiles, 'statusline.sh');
  const THEIRS = '#!/bin/sh\n# my own, hand-written, three years of tweaks\necho hello\n';
  fs.writeFileSync(theirs, THEIRS, { mode: 0o755 });
  fs.mkdirSync(paths(home).dir, { recursive: true });
  fs.symlinkSync(theirs, paths(home).wrapper);
  danglingSettings(home);

  assert.throws(() => install({ home }), /ENOENT/);
  assert.equal(fs.readFileSync(theirs, 'utf8'), THEIRS, 'their script, at the end of the link');
  assert.equal(fs.lstatSync(paths(home).wrapper).isSymbolicLink(), true, 'and the link itself is still a link');
});

// A cleanup must never become the error. The temp removal in `writeAtomic` runs in a
// `finally`, so a removal that throws REPLACES the failure that stopped the install and the
// user reads about a temp file instead of the reason nothing was written. Reached without
// touching permissions: leave a non-empty directory where the temp file goes, and both the
// write and the `rmSync` after it fail with EISDIR — only their messages tell them apart.
test('a cleanup that fails does not replace the error that caused it', () => {
  const home = fakeHome(MINE);
  const tmp = `${paths(home).settings}${TEMP_PREFIX}${process.pid}.tmp`;
  fs.mkdirSync(tmp);
  fs.writeFileSync(path.join(tmp, 'occupied'), 'x');

  assert.throws(
    () => install({ home }),
    (e: Error) => {
      assert.match(e.message, /open/, 'the write that actually stopped the install');
      assert.equal(/rm returned/.test(e.message), false, `the cleanup masked it: ${e.message}`);
      return true;
    },
  );
});

// The `rmdir`-not-recursive choice, which nothing held up: mutating it to a recursive remove
// left 423 tests green. The path that makes it matter is not exotic — the installed wrapper
// writes a snapshot at every Claude Code frame, so a live session dropping a file into
// `snapshots/` while an install unwinds is the ordinary state of the machine, not a race
// someone has to engineer. One process cannot produce that concurrency honestly, so the
// write is staged on the backup — the last thing to land before the failure.
test('the unwind refuses a directory something else has written into', () => {
  const home = fakeHome();
  danglingSettings(home);
  const p = paths(home);
  const landed = path.join(p.snapshots, 'aaaaaaaa-1111-1111-1111-111111111111.json');

  const realWrite = fs.writeFileSync;
  let armed = true;
  fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string, options?: fs.WriteFileOptions) => {
    realWrite(file, data, options);
    if (armed && file === p.backup) {
      armed = false;
      realWrite(landed, '{"from":"a live statusline frame"}');
    }
  }) as typeof fs.writeFileSync;
  try {
    assert.throws(() => install({ home }), /ENOENT/);
  } finally {
    fs.writeFileSync = realWrite;
  }

  assert.equal(fs.existsSync(landed), true, 'the snapshot a live session wrote survives the unwind');
});

// The rule that keeps the unwind from being `rm -rf ~/.claude/tarmac`: a re-install that
// fails must not carry off the way back from the install that succeeded.
//
// And "the way back" is the RECORD, not the inode. A failed re-install has already rewritten
// the backup — `previous: null`, because the dangling settings.json read as "no statusLine to
// wrap" — and regenerated the wrapper to chain nothing. Leaving those two files in place
// while their contents name an install that never happened loses the user's real statusline
// exactly as surely as deleting them would, and `uninstall` still answers `foreign`.
test('the unwind puts back the backup and the wrapper it overwrote', () => {
  const home = fakeHome(MINE);
  install({ home });
  const backupBefore = fs.readFileSync(paths(home).backup, 'utf8');
  const wrapperBefore = fs.readFileSync(paths(home).wrapper, 'utf8');
  danglingSettings(home);

  assert.throws(() => install({ home }), /ENOENT/);
  assert.equal(fs.readFileSync(paths(home).backup, 'utf8'), backupBefore, 'the earlier way back survives, record and all');
  assert.equal(fs.readFileSync(paths(home).wrapper, 'utf8'), wrapperBefore, 'and so does the wrapper it names');
  const out = execFileSync(paths(home).wrapper, { input: '{"session_id":"abcdefgh-1"}', encoding: 'utf8' });
  assert.match(out, /MINE/, 'the statusline the first install wrapped still renders');
});

// `existsSync` follows the link, so a DANGLING one reads as absent and the unwind unlinks it
// — removing something this run never created, which is the one thing it must not do. The
// same dotfiles-repo-not-cloned shape the rest of this file is built around.
test('the unwind leaves a dangling symlink the user put there', () => {
  const home = fakeHome();
  fs.mkdirSync(paths(home).dir, { recursive: true });
  fs.symlinkSync(path.join(home, 'not-cloned', 'statusline.sh'), paths(home).wrapper);

  assert.throws(() => install({ home }), /ENOENT/);
  assert.equal(fs.lstatSync(paths(home).wrapper).isSymbolicLink(), true, 'their link, not ours to remove');
});

// The failure that lands on the LAST statement of the atomic write rather than the first:
// the temp file — a complete copy of settings.json — is already on disk next to the user's
// own file when the rename throws, and it is the one thing the unwind above cannot see (it
// lands beside the SETTINGS target, not under ~/.claude/tarmac, and `reap` only ever looks
// in the snapshots directory). `chflags uchg` is the Finder's "Locked" checkbox.
test('a rename that fails leaves no temp copy of settings.json behind', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('chflags is macOS; the leak itself is not platform-specific');
    return;
  }
  const home = fakeHome(MINE);
  execFileSync('chflags', ['uchg', paths(home).settings]);
  try {
    assert.throws(() => install({ home }), /EPERM/);
    const strays = fs.readdirSync(paths(home).claude).filter((f) => f.includes(TEMP_PREFIX));
    assert.deepEqual(strays, [], 'a full copy of settings.json, left where nothing will ever clear it');
  } finally {
    execFileSync('chflags', ['nouchg', paths(home).settings]);
  }
});

test('uninstalling what was never installed fails loudly', () => {
  const home = fakeHome('{}');
  assert.throws(() => uninstall({ home }), /no tarmac install/);
});

test('install then uninstall twice over leaves the original untouched', () => {
  const original = '{"model":"opus"}';
  const home = fakeHome(original);
  install({ home });
  uninstall({ home });
  assert.throws(() => uninstall({ home }), /no tarmac install/);
  assert.equal(settingsOf(home), original);
});

test('snapshots survive uninstall while the prune marker leaves with the wrapper', () => {
  const home = fakeHome('{}');
  install({ home });
  fs.writeFileSync(path.join(paths(home).snapshots, 'x.json'), '{}');
  fs.writeFileSync(path.join(paths(home).snapshots, PRUNE_MARKER), '');
  uninstall({ home });
  assert.ok(fs.existsSync(path.join(paths(home).snapshots, 'x.json')));
  assert.equal(fs.existsSync(path.join(paths(home).snapshots, PRUNE_MARKER)), false);
});

test('uninstall leaves a symlink wearing the prune marker name alone', () => {
  const home = fakeHome('{}');
  install({ home });
  const target = path.join(home, 'someone-elses-file');
  fs.writeFileSync(target, 'keep');
  fs.symlinkSync(target, path.join(paths(home).snapshots, PRUNE_MARKER));

  uninstall({ home });

  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
  assert.equal(fs.lstatSync(path.join(paths(home).snapshots, PRUNE_MARKER)).isSymbolicLink(), true);
});

test('uninstall removes the marker from the directory frozen in the wrapper', () => {
  const home = fakeHome('{}');
  install({ home });
  const snapshots = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-uninstall-')), 'snapshots');
  fs.mkdirSync(snapshots);
  fs.writeFileSync(path.join(snapshots, PRUNE_MARKER), '');
  fs.writeFileSync(paths(home).wrapper, renderWrapper({ snapshotDir: snapshots, chainCommand: null }), { mode: 0o755 });

  uninstall({ home });

  assert.equal(fs.existsSync(path.join(snapshots, PRUNE_MARKER)), false);
});

test('a foreign statusLine keeps the wrapper and its prune marker', () => {
  const home = fakeHome('{}');
  install({ home });
  const marker = path.join(paths(home).snapshots, PRUNE_MARKER);
  fs.writeFileSync(marker, '');
  fs.writeFileSync(paths(home).settings, JSON.stringify({ statusLine: { type: 'command', command: 'other.sh' } }));

  assert.equal(uninstall({ home }).mode, 'foreign');
  assert.equal(fs.existsSync(paths(home).wrapper), true);
  assert.equal(fs.existsSync(marker), true);
});

test('a prune marker removal failure cannot prevent settings restoration', (t) => {
  if (process.getuid?.() === 0) {
    t.skip('running as root: 0555 does not deny anything, the case cannot be built here');
    return;
  }
  const original = '{"model":"opus"}';
  const home = fakeHome(original);
  install({ home });
  const marker = path.join(paths(home).snapshots, PRUNE_MARKER);
  fs.writeFileSync(marker, '');
  fs.chmodSync(paths(home).snapshots, 0o555);

  try {
    assert.throws(() => uninstall({ home }), /EACCES|EPERM/);
    assert.equal(settingsOf(home), original);
    assert.equal(fs.existsSync(paths(home).wrapper), true, 'wrapper remains when cleanup cannot finish');
  } finally {
    fs.chmodSync(paths(home).snapshots, 0o755);
  }
});

// ── where the snapshots live: outside `.claude`, which people version-control ──────────
// #20. `~/.claude` is commonly a git repo (dotfiles, config sync), and the wrapper rewrites
// `<sid>.json` at EVERY frame of EVERY session: the first sync after install committed eight
// runtime payloads, and every one after that would have diffed them forever. Runtime state
// that is regenerated on the next frame belongs in the XDG state directory, not in a
// directory whose whole point is to be committed.

/** What `paths` answers with no environment at all — the zero-config default. */
const bareEnv = {} as Record<string, string | undefined>;

test('snapshots live outside .claude, in the XDG state directory', () => {
  const home = fakeHome();
  const p = paths(home, { env: bareEnv, realHome: home });
  assert.equal(p.snapshots, path.join(home, '.local', 'state', 'tarmac', 'snapshots'));
  assert.equal(p.snapshots.startsWith(p.claude), false, 'and nowhere under .claude');
});

test('XDG_STATE_HOME moves the state directory, for the home that exported it', () => {
  const home = fakeHome();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-xdg-'));
  const p = paths(home, { env: { XDG_STATE_HOME: state }, realHome: home });
  assert.equal(p.snapshots, path.join(state, 'tarmac', 'snapshots'));
});

// The same rule `commandTarget` applies to `~` in a statusLine: `--home` exists to work on
// SOMEONE ELSE'S `.claude`, and this process's XDG_STATE_HOME speaks only for this process's
// own home. Honouring it there would have `tarmac install --home /home/jane` write jane's
// telemetry into our state directory — and would have this very suite, run on a machine that
// exports it, write into the developer's real one.
test('XDG_STATE_HOME does not follow --home into someone else\'s home', () => {
  const home = fakeHome();
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-realhome-'));
  const p = paths(home, { env: { XDG_STATE_HOME: '/var/somebody-elses-state' }, realHome: real });
  assert.equal(p.snapshots, path.join(home, '.local', 'state', 'tarmac', 'snapshots'));
});

// The XDG spec: "If $XDG_STATE_HOME is either not set or empty, a default equal to
// $HOME/.local/state should be used" — and a value that is not an absolute path "should be
// considered invalid and ignored". A relative one would resolve against the process's cwd,
// which for a status line is whatever directory Claude Code happened to be started in.
test('an XDG_STATE_HOME that is empty or relative is ignored, as the spec requires', () => {
  const home = fakeHome();
  const fallback = path.join(home, '.local', 'state', 'tarmac', 'snapshots');
  for (const XDG_STATE_HOME of ['', '   ', 'state', './state', '~/state']) {
    assert.equal(paths(home, { env: { XDG_STATE_HOME }, realHome: home }).snapshots, fallback, XDG_STATE_HOME);
  }
});

test('install points the wrapper at the state directory and creates it', () => {
  const home = fakeHome('{}');
  const state = path.join(home, '.local', 'state', 'tarmac', 'snapshots');
  install({ home });
  assert.equal(fs.statSync(state).isDirectory(), true);
  assert.match(fs.readFileSync(paths(home).wrapper, 'utf8'), new RegExp(`TARMAC_DIR='${escapeRe(state)}'`));
});

// The whole point of #20, asserted where it can be read: after an install, the only things
// tarmac owns inside `.claude` are the two files the issue calls fine there — the wrapper
// and the backup that undoes it. Nothing under `.claude` is rewritten at frame cadence.
test('nothing tarmac writes at runtime lands inside .claude', () => {
  const home = fakeHome('{}');
  install({ home });
  assert.deepEqual(fs.readdirSync(paths(home).dir).sort(), ['backup.json', 'statusline.sh']);
});

test('the install plan names where the snapshots will land', () => {
  const home = fakeHome('{}');
  assert.equal(planInstall({ home }).snapshots, paths(home).snapshots);
});

// A live session drops a snapshot into the state directory while an install unwinds — the
// same ordinary concurrency `the unwind refuses a directory something else has written into`
// covers, now that the directory is somewhere else.
test('a failed install takes back the state directory it created', () => {
  const home = fakeHome();
  danglingSettings(home);
  assert.throws(() => install({ home }), /ENOENT/);
  assert.equal(fs.existsSync(path.join(home, '.local', 'state', 'tarmac', 'snapshots')), false, 'ours to create, ours to take back');
  assert.equal(fs.existsSync(path.join(home, '.local', 'state', 'tarmac')), false, 'and the directory above it, which it also made');
});

// ── the payloads an older tarmac left inside `.claude` ─────────────────────────────────
// Moving the directory is only half of #20: the machines that hit the bug already have the
// files, in the repo, and nothing would ever remove them. They are PURGED rather than moved
// — a snapshot is a reading of the frame that wrote it, the live sessions write theirs again
// within seconds, and copying them over would carry the very files being complained about
// into the new directory, dated from before the move.

const legacyDir = (home: string): string => paths(home).legacySnapshots;

/**
 * A tarmac install as 0.1.x left it — wrapper, backup and a settings.json pointing at us,
 * with the snapshots directory still inside `.claude`. This is the machine #20 is about, and
 * the ONLY machine whose legacy directory is ours to clear: what makes those files ours is
 * that we can show we installed here, never that their names look like ours.
 */
function oldInstall(home: string, chained = 'echo MINE'): void {
  const p = paths(home);
  fs.mkdirSync(p.dir, { recursive: true });
  fs.writeFileSync(p.wrapper, renderWrapper({ snapshotDir: p.legacySnapshots, chainCommand: chained }), { mode: 0o755 });
  const installedText = JSON.stringify({ statusLine: { type: 'command', command: p.wrapper } }, null, 2) + '\n';
  fs.writeFileSync(
    p.backup,
    JSON.stringify(
      { version: 1, originalText: null, installedText, previous: { type: 'command', command: chained }, installedAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  fs.writeFileSync(p.settings, installedText);
}

/** A legacy directory as an older tarmac left it: payloads, a temp file, the prune marker. */
function legacyLitter(home: string, extra: Record<string, string> = {}): string {
  const dir = legacyDir(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'aaaaaaaa-1111-1111-1111-111111111111.json'), '{"session_id":"a"}');
  fs.writeFileSync(path.join(dir, 'bbbbbbbb-2222-2222-2222-222222222222.json'), '{"session_id":"b"}');
  fs.writeFileSync(path.join(dir, `${TEMP_PREFIX}aaaaaaaa-1111-1111-1111-111111111111.4242.tmp`), '{}');
  fs.writeFileSync(path.join(dir, PRUNE_MARKER), '');
  for (const [name, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('install clears the runtime payloads an older tarmac left inside .claude', () => {
  const home = fakeHome('{}');
  oldInstall(home);
  const dir = legacyLitter(home);
  const { legacy } = install({ home });
  assert.equal(fs.existsSync(dir), false, 'the directory goes too — a zombie is what got noticed');
  assert.equal(legacy?.payloads, 4, 'two snapshots, a temp file and the prune marker');
  assert.equal(legacy?.kept, 0);
});

// `rmdir`, never a recursive remove — the same rule the unwind states. A directory people
// version-control is the last place to delete something we cannot prove we wrote.
test('a file nothing here wrote keeps the legacy directory, and itself', () => {
  const home = fakeHome('{}');
  oldInstall(home);
  const dir = legacyLitter(home, { 'notes.txt': 'mine', 'settings.json': '{}' });
  const { legacy } = install({ home });
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'mine');
  assert.equal(fs.existsSync(path.join(dir, 'settings.json')), true, 'a *.json we did not write is not a snapshot');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['notes.txt', 'settings.json']);
  assert.equal(legacy?.kept, 2);
});

test('an install with nothing to clear says so, rather than inventing a directory', () => {
  const home = fakeHome('{}');
  assert.equal(install({ home }).legacy, null);
  assert.equal(fs.existsSync(legacyDir(home)), false, 'and does not create the one it just moved away from');
});

// The commonest shape of all: `npx @adrrr/tarmac install` on a machine running the old
// version, whose settings.json already points at the wrapper.
test('a re-install clears the legacy payloads too', () => {
  const home = fakeHome(MINE);
  install({ home });
  const dir = legacyLitter(home);
  assert.equal(install({ home }).legacy?.payloads, 4);
  assert.equal(fs.existsSync(dir), false);
});

test('the plan counts the legacy payloads before a byte is written', () => {
  const home = fakeHome('{}');
  oldInstall(home);
  const dir = legacyLitter(home, { 'notes.txt': 'mine' });
  const plan = planInstall({ home });
  assert.equal(plan.legacy?.dir, dir);
  assert.equal(plan.legacy?.payloads, 4);
  assert.equal(plan.legacy?.kept, 1);
  assert.equal(fs.readdirSync(dir).length, 5, 'and the plan is a dry run: nothing removed yet');
  assert.match(renderPlan(plan), /4 runtime payload/);
});

test('the plan says nothing about a legacy directory that is not there', () => {
  assert.equal(/runtime payload/.test(renderPlan(planInstall({ home: fakeHome('{}') }))), false);
});

// ── the .gitignore hint ────────────────────────────────────────────────────────────────
// The other half of #20's suggestion. It is printed by the PLAN rather than after the fact:
// this operation now deletes files inside a git repository, and the user reads the plan
// before typing the word that starts it.

test('the plan warns that .claude is a git repository, and what to ignore', () => {
  const home = fakeHome('{}');
  oldInstall(home);
  legacyLitter(home);
  fs.mkdirSync(path.join(home, '.claude', '.git'));
  const plan = planInstall({ home });
  assert.equal(plan.gitRepo?.dir, paths(home).claude);
  const out = renderPlan(plan);
  assert.match(out, /git repositor/i);
  assert.match(out, /\.gitignore/);
  assert.match(out, /tarmac\/snapshots\//, 'the exact line to add');
});

// A worktree or a submodule spells `.git` as a FILE holding a `gitdir:` pointer. The people
// who keep `.claude` in a dotfiles repo are exactly the people who use those.
test('a .git file counts as a repository just as a .git directory does', () => {
  const home = fakeHome('{}');
  fs.writeFileSync(path.join(home, '.claude', '.git'), 'gitdir: /elsewhere/.git/worktrees/claude\n');
  assert.equal(planInstall({ home }).gitRepo?.dir, paths(home).claude);
});

test('the plan is quiet about git when .claude is not a repository', () => {
  const plan = planInstall({ home: fakeHome('{}') });
  assert.equal(plan.gitRepo, null);
  assert.equal(/git/i.test(renderPlan(plan)), false);
});

// The workaround someone will already have applied to #20: point the legacy directory at a
// disk outside the repo with a symlink. `readdir` follows it, so an unguarded purge would
// delete their snapshots at the far end and leave the link itself behind — the unwind's
// dangling-symlink lesson, in the one place where the user has ALREADY solved the problem
// this install is about.
test('a legacy snapshots directory that is a symlink is left entirely alone', () => {
  const home = fakeHome('{}');
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-elsewhere-'));
  const theirs = path.join(elsewhere, 'aaaaaaaa-1111-1111-1111-111111111111.json');
  fs.writeFileSync(theirs, '{"session_id":"a"}');
  fs.mkdirSync(paths(home).dir, { recursive: true });
  fs.symlinkSync(elsewhere, paths(home).legacySnapshots);

  assert.equal(planInstall({ home }).legacy, null, 'nothing to announce: this is not a directory we made');
  assert.equal(install({ home }).legacy, null);
  assert.equal(fs.readFileSync(theirs, 'utf8'), '{"session_id":"a"}', 'their snapshots, at the end of the link');
  assert.equal(fs.lstatSync(paths(home).legacySnapshots).isSymbolicLink(), true, 'and the link is still a link');
});

// I2 (review): the sweep in the wrapper is `-name '<sid shape>' -type f`, and BOTH halves are
// the rule — `wrapper.ts` says so, and a test there asserts it refuses a directory or a
// symlink wearing a session id's name. The purge matched the name and unlinked, so a symlink
// a user had put there was removed where the shell sweep would have left it. Deleting by the
// same name as the writer is not the same as deleting by the same RULE.
test('a symlink wearing a session id name is not a payload, and survives the purge', () => {
  const home = fakeHome('{}');
  oldInstall(home);
  const dir = legacyLitter(home);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-target-'));
  const target = path.join(elsewhere, 'kept.json');
  fs.writeFileSync(target, '{"not":"ours"}');
  fs.symlinkSync(target, path.join(dir, 'cccccccc-3333-3333-3333-333333333333.json'));
  fs.mkdirSync(path.join(dir, 'dddddddd-4444-4444-4444-444444444444.json'));

  const { legacy } = install({ home });
  assert.equal(legacy?.payloads, 4, 'the four real payloads, and only those');
  assert.equal(fs.lstatSync(path.join(dir, 'cccccccc-3333-3333-3333-333333333333.json')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), '{"not":"ours"}', 'and nothing happened at the far end');
  assert.equal(legacy?.kept, 2, 'the link and the directory keep the directory alive');
});

// I3 (review): the OLD wrapper is still the one Claude Code calls until the new bytes land,
// and its first act is `mkdir -p "$TARMAC_DIR"` — so a frame in flight can put the directory
// back between our `rmdir` and our report. The window is small; the claim it invalidates was
// not ("the directory goes too"), and the user was told to commit a removal that had already
// been undone. What is reported is now what is on disk, read back after the fact.
test('a frame that lands mid-purge is reported, not papered over', () => {
  const home = fakeHome('{}');
  oldInstall(home);
  const dir = legacyLitter(home);
  const realRmdir = fs.rmdirSync;
  fs.rmdirSync = ((d: fs.PathLike) => {
    realRmdir(d);
    // exactly what the 0.1.2 wrapper does on its next frame, before we look again
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'eeeeeeee-5555-5555-5555-555555555555.json'), '{}');
  }) as typeof fs.rmdirSync;
  let legacy;
  try {
    legacy = install({ home }).legacy;
  } finally {
    fs.rmdirSync = realRmdir;
  }
  assert.equal(fs.existsSync(dir), true, 'the frame really did put it back');
  assert.equal(legacy?.kept, 1, 'and the report says the directory is still there');
});

// M2 (review): `↳ clearing 0 runtime payload(s)` under a `git … commit the removal above`.
// An empty legacy directory is the state a machine is left in by the previous install, and
// the plan announced a deletion it was not going to make.
test('an empty legacy directory announces no deletion, and asks for no commit', () => {
  const home = fakeHome('{}');
  fs.mkdirSync(paths(home).legacySnapshots, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', '.git'));
  const out = renderPlan(planInstall({ home }));
  assert.equal(/runtime payload/.test(out), false, 'nothing to clear, nothing to announce');
  assert.match(out, /git repositor/i, 'the repository is still worth saying');
  assert.equal(/commit the removal/.test(out), false, 'but there is no removal to commit');
});

// M3 (review): `XDG_STATE_HOME=$HOME/.claude` makes the new home and the old one the same
// path, and the install then purged and `rmdir`d the very directory it had just announced as
// where the payloads would land — reporting "they belong in X" about the X it removed.
test('the purge never touches the directory the wrapper is about to write to', () => {
  const home = fakeHome('{}');
  const p = paths(home, { env: { XDG_STATE_HOME: path.join(home, '.claude') }, realHome: home });
  assert.equal(p.snapshots, p.legacySnapshots, 'the setup this guards: one directory, two names');
  fs.mkdirSync(p.snapshots, { recursive: true });
  fs.writeFileSync(path.join(p.snapshots, 'aaaaaaaa-1111-1111-1111-111111111111.json'), '{}');
  assert.equal(countLegacySnapshots(p, true), null, 'nothing to migrate away from itself');
  assert.equal(purgeLegacySnapshots(p, true), null);
  assert.equal(fs.existsSync(path.join(p.snapshots, 'aaaaaaaa-1111-1111-1111-111111111111.json')), true);
});

// I1 (review): every CLI run in this file sets HOME to a throwaway directory, so
// `os.homedir()` returns it and the guard in `stateRoot` reads TRUE — the guard arbitrates
// which HOME, not which process. A developer (or a runner) with XDG_STATE_HOME exported
// therefore had the suite create directories in their REAL state directory, silently, while
// every assertion passed. The environment the suite runs under is not one of its inputs —
// the same rule, and the same fix, as `cli-config.test.ts` applies to `TARMAC_*`.
test('a CLI run under a throwaway home cannot reach the developer\'s state directory', () => {
  const home = fakeHome('{}');
  const theirs = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-devxdg-'));
  const restore = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = theirs;
  let run;
  try {
    run = tarmac(['install', '--yes'], home);
  } finally {
    if (restore === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = restore;
  }
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(fs.readdirSync(theirs), [], 'nothing of ours in a directory the suite did not choose');
  assert.equal(fs.existsSync(path.join(home, '.local', 'state', 'tarmac', 'snapshots')), true, 'it went to the fake home');
});

// M8 (review): `paths()` took `os.homedir()` as a DEFAULT PARAMETER, so it was evaluated on
// every call — including the overwhelming majority that pass `--home` and never consult it.
// On a container with no passwd entry and no $HOME that call throws, in a function that never
// used to touch the environment at all. It is only needed to arbitrate XDG_STATE_HOME, and
// when it cannot answer, "this is not the home that exported it" is the safe reading: the
// default under the home actually being targeted.
test('a real home that cannot be determined falls back to the targeted home, and never throws', () => {
  const home = fakeHome();
  const fallback = path.join(home, '.local', 'state', 'tarmac', 'snapshots');
  const realHomedir = os.homedir;
  let asked = 0;
  os.homedir = (() => {
    asked += 1;
    throw new Error('no passwd entry, and no $HOME');
  }) as typeof os.homedir;
  try {
    assert.equal(paths(home, { env: {} }).snapshots, fallback);
    assert.equal(asked, 0, 'nothing asked the question, so nothing paid for it');
    assert.equal(paths(home, { env: { XDG_STATE_HOME: '/state' } }).snapshots, fallback, 'asked, unanswerable, safe');
    assert.equal(asked, 1);
  } finally {
    os.homedir = realHomedir;
  }
});

// ── the reader looks where the writer writes ──────────────────────────────────────────
// C1 (review). The wrapper carries an ABSOLUTE path, frozen into the file at install time.
// `list` and `serve` never read that file: they RECOMPUTED the default from their own
// `process.env`. `XDG_STATE_HOME` present in one process and absent in the other — an
// interactive shell versus a LaunchAgent, a systemd user unit, cron, `sudo` without `-E` —
// and the wrapper writes to A while the reader watches B.
//
// The failure was silent by construction: `collect.ts` suppresses "directory missing" when
// the source is `default` (a default that does not exist yet is the zero-config case), so the
// only symptom was `statusline chained on 0/N sessions` — which `docs/MANUAL.md` itself calls
// "a true statement about the wrong directory". For an observability tool, a fault whose
// signature is "fleet healthy and empty" is the worst one available.
//
// So the reader stops guessing and reads the writer's own file. Nothing new is written, and
// an install made by an older version is picked up as it stands.

test('the effective snapshots directory is the one frozen in the wrapper', () => {
  const home = fakeHome('{}');
  const theirs = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-statehome-'));
  const withXdg: Record<string, string | undefined> = { ...process.env, HOME: home, XDG_STATE_HOME: theirs };
  const withoutXdg: Record<string, string | undefined> = { ...process.env, HOME: home };
  delete withoutXdg.XDG_STATE_HOME;

  const installed = spawnSync(process.execPath, [CLI, 'install', '--yes'], { env: withXdg, encoding: 'utf8', timeout: 20000 });
  assert.equal(installed.status, 0, installed.stderr);
  const wrapper = fs.readFileSync(paths(home).wrapper, 'utf8');
  assert.match(wrapper, new RegExp(escapeRe(path.join(theirs, 'tarmac', 'snapshots'))), 'the writer was pointed there');

  const bin = path.join(home, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\n[ "$1" = agents ] && echo "[]"\n', { mode: 0o755 });
  const listed = spawnSync(process.execPath, [CLI, 'list', '--json', '--claude-bin', bin], {
    env: withoutXdg,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(
    JSON.parse(listed.stdout).health.snapshotsDir,
    path.join(theirs, 'tarmac', 'snapshots'),
    'and the reader follows it, whatever its own environment says',
  );
});

test('a home with no install falls back to the computed default', () => {
  const home = fakeHome('{}');
  assert.equal(installedSnapshotsDir(paths(home)), null);
});

// The same rule as `carriesWrapperMarker`: a file at that path is only ours if it says so.
test('a statusline script that is not ours is not read for a path', () => {
  const home = fakeHome('{}');
  fs.mkdirSync(paths(home).dir, { recursive: true });
  fs.writeFileSync(paths(home).wrapper, "#!/bin/sh\nTARMAC_DIR='/somewhere/i/made/up'\necho hi\n");
  assert.equal(installedSnapshotsDir(paths(home)), null);
});

// `renderWrapper` single-quotes the path for POSIX sh, and a home with an apostrophe in it is
// an ordinary macOS home. Reading it back is the inverse of that quoting or it is a guess.
test('a snapshots path with an apostrophe survives the round trip', () => {
  const home = fakeHome('{}');
  const odd = "/tmp/od d's state/tarmac/snapshots";
  fs.mkdirSync(paths(home).dir, { recursive: true });
  fs.writeFileSync(paths(home).wrapper, renderWrapper({ snapshotDir: odd, chainCommand: null }));
  assert.equal(installedSnapshotsDir(paths(home)), odd);
});

// M4 (review): the install plan names the snapshots directory precisely because it is no
// longer guessable from the path above it. `uninstall` is the command that LEAVES those files
// behind — "your snapshots survive uninstall" — so it owes the same sentence, and it owes the
// path the wrapper really used rather than one recomputed from this shell's environment.
test('the uninstall plan says where the snapshots it leaves behind are', () => {
  const home = fakeHome(MINE);
  const odd = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-elsewhere-')), 'snapshots');
  install({ home });
  fs.writeFileSync(paths(home).wrapper, renderWrapper({ snapshotDir: odd, chainCommand: 'echo MINE' }), { mode: 0o755 });

  const plan = planUninstall({ home });
  assert.equal(plan.snapshots, odd, 'read from the wrapper, not recomputed');
  assert.match(renderPlan(plan), new RegExp(escapeRe(odd)));
  assert.match(renderPlan(plan), /left|kept|stay/i, 'and says they are not going anywhere');
});

// M6 (review): `.claude/.git` is one of several ways a config directory ends up under version
// control. `git init ~` is another, and the hint was silent for it while the purge ran just
// the same. The line names the repository it found, so it can never describe the wrong one.
test('a home that is itself a git repository gets the hint, naming the home', () => {
  const home = fakeHome('{}');
  oldInstall(home);
  legacyLitter(home);
  fs.mkdirSync(path.join(home, '.git'));
  const plan = planInstall({ home });
  assert.equal(plan.gitRepo?.dir, home);
  assert.match(renderPlan(plan), new RegExp(`${escapeRe(home)} is a git repositor`));
});

// …and the nearer one wins: `.claude` under its own repo inside a home under another is the
// dotfiles-submodule shape, and the advice is about the inner one.
test('a .claude repository is named ahead of the home containing it', () => {
  const home = fakeHome('{}');
  fs.mkdirSync(path.join(home, '.git'));
  fs.mkdirSync(path.join(home, '.claude', '.git'));
  assert.equal(planInstall({ home }).gitRepo?.dir, paths(home).claude);
});

// ── provenance: whose files are those? ────────────────────────────────────────────────
// The purge ran on EVERY install, first one included. `~/.claude/tarmac/snapshots` is a
// documented path that this project's own README once told people to point a statusline at,
// and the "ours" set is a SHAPE — a UUID name, a `.tarmac-` prefix. On a home where tarmac
// had never been installed, another writer's files matched it and were deleted, under a plan
// promising they would be "written again on the next frame" by a wrapper that had never
// written them. That is the same reasoning this branch used to spare a symlink — a name is
// not provenance — applied to the one place it was missing.
//
// What makes those files ours is evidence that we installed here: the statusLine already
// pointing at us, our marker in the wrapper, or a usable backup. All three are read BEFORE
// this run writes anything, since by the time the purge runs it has written both itself.

test('a first install never clears a directory it cannot show it wrote', () => {
  const home = fakeHome('{}');
  const dir = legacyLitter(home); // another writer's, on a home tarmac has never touched
  const before = fs.readdirSync(dir).sort();

  const { legacy } = install({ home });

  assert.equal(legacy, null, 'nothing of ours was there to clear');
  assert.deepEqual(fs.readdirSync(dir).sort(), before, 'and someone else\'s files are still someone else\'s');
});

test('the plan of a first install promises no deletion it has no right to make', () => {
  const home = fakeHome('{}');
  legacyLitter(home);
  const plan = planInstall({ home });
  assert.equal(plan.legacy, null);
  assert.equal(/runtime payload/.test(renderPlan(plan)), false);
});

// The three proofs, each on its own: a settings.json already pointing at us is the update
// path; the marker is what an install that lost its settings still leaves; the backup is what
// survives a wrapper someone deleted by hand.
test('any one proof of an install here is enough to clear its directory', () => {
  for (const proof of ['statusLine', 'marker', 'backup'] as const) {
    const home = fakeHome('{}');
    oldInstall(home);
    if (proof !== 'statusLine') fs.writeFileSync(paths(home).settings, '{}');
    if (proof === 'statusLine' || proof === 'backup') void 0;
    if (proof === 'marker') fs.rmSync(paths(home).backup);
    if (proof === 'backup') fs.rmSync(paths(home).wrapper);
    legacyLitter(home);

    assert.equal(install({ home }).legacy?.payloads, 4, proof);
  }
});

// ── the hint has to be a line git would actually honour ───────────────────────────────
// S1 (review): the pattern was always `tarmac/snapshots/`, and a .gitignore pattern is read
// relative to the file that carries it. In `~/.claude/.gitignore` that is right; in
// `~/.gitignore` — `git init ~`, which `gitRepoOf` now detects — it matches nothing at all.
// The old test asserted the repository's NAME and never the pattern's validity, so it could
// not have caught this. `git check-ignore` can.

/** Does git itself honour `pattern`, written at the root of `repo`, for `file`? */
function gitIgnores(repo: string, pattern: string, file: string): boolean {
  fs.writeFileSync(path.join(repo, '.gitignore'), `${pattern}\n`);
  const r = spawnSync('git', ['check-ignore', '-q', file], { cwd: repo, encoding: 'utf8' });
  return r.status === 0;
}

test('the pattern the hint prints is one git honours, from the repository it names', () => {
  for (const where of ['claude', 'home'] as const) {
    const home = fakeHome('{}');
    oldInstall(home);
    const dir = legacyLitter(home);
    const payload = path.join(dir, 'aaaaaaaa-1111-1111-1111-111111111111.json');
    const repo = where === 'claude' ? paths(home).claude : home;
    execFileSync('git', ['init', '-q', repo]);

    const { gitRepo } = planInstall({ home });
    assert.equal(gitRepo?.dir, repo, where);
    assert.match(renderPlan(planInstall({ home })), new RegExp(escapeRe(gitRepo!.ignore)));
    assert.equal(gitIgnores(repo, gitRepo!.ignore, payload), true, `${where}: git does not honour ${gitRepo!.ignore}`);
  }
});

// ── a wrapper that already points somewhere else ──────────────────────────────────────
// S3 (review): the READER follows the wrapper, but `install` re-freezes the path from its own
// environment. Run it from a shell that exports XDG_STATE_HOME after an install made without
// one (or the reverse) and the writer relocates — silently, with the payloads of the old
// directory left behind for nothing to ever collect. Fixing the relocation is a separate
// question; announcing it is not, because a plan that changes where the telemetry lands
// without saying so is the one thing `renderPlan` exists to prevent.
test('the plan says so when the install moves the snapshots directory', () => {
  const home = fakeHome(MINE);
  const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-was-')), 'snapshots');
  install({ home });
  fs.writeFileSync(paths(home).wrapper, renderWrapper({ snapshotDir: elsewhere, chainCommand: 'echo MINE' }), { mode: 0o755 });

  const plan = planInstall({ home });
  assert.equal(plan.movingFrom, elsewhere);
  const out = renderPlan(plan);
  assert.match(out, new RegExp(escapeRe(elsewhere)), 'the directory being left');
  assert.match(out, new RegExp(escapeRe(paths(home).snapshots)), 'and the one being taken');
  assert.match(out, /mov(e|ing)/i);
});

test('a plan that changes nothing about the directory says nothing about moving it', () => {
  const home = fakeHome(MINE);
  install({ home });
  assert.equal(planInstall({ home }).movingFrom, null);
  assert.equal(/moving/i.test(renderPlan(planInstall({ home }))), false);
});

// N1 (review): a frame that resurrects the directory is now reported, but the `rmdir` was
// never retried — and the directory it recreated is empty of everything except that one
// payload, which the retry would take. One retry, not a loop: a second failure means frames
// are still arriving, and this is an install, not a daemon.
test('a directory a frame put back is swept once more, then left alone', () => {
  const home = fakeHome('{}');
  oldInstall(home);
  const dir = legacyLitter(home);
  const realRmdir = fs.rmdirSync;
  let calls = 0;
  fs.rmdirSync = ((d: fs.PathLike) => {
    calls += 1;
    realRmdir(d);
    if (calls === 1) fs.mkdirSync(dir, { recursive: true }); // the frame's `mkdir -p`, nothing more
  }) as typeof fs.rmdirSync;
  let legacy;
  try {
    legacy = install({ home }).legacy;
  } finally {
    fs.rmdirSync = realRmdir;
  }
  assert.equal(calls, 2, 'tried once more, and only once');
  assert.equal(fs.existsSync(dir), false, 'so an empty resurrection does not survive the install');
  assert.equal(legacy?.kept, 0);
});

// N2 (review): every other reader in this codebase refuses an empty value rather than
// treating it as a path (`args.ts` for `--snapshots-dir=`, `config.ts` for `"snapshotsDir"`),
// and `TARMAC_DIR=''` is a wrapper that writes nowhere — not a wrapper that writes to "".
test('a wrapper that names no directory is not a directory of ""', () => {
  const home = fakeHome('{}');
  fs.mkdirSync(paths(home).dir, { recursive: true });
  fs.writeFileSync(paths(home).wrapper, `#!/bin/sh\n# ${WRAPPER_MARKER}\nTARMAC_DIR=''\n`);
  assert.equal(installedSnapshotsDir(paths(home)), null);
  assert.equal(wrapperIsOurs(paths(home)), true, 'ours, but unreadable — the caller can tell the two apart');
});

// N3 (review): the only round-trip test used a path with an apostrophe, which is quoted under
// any scheme. A plain path is the one every real install has, and the shape a hand-edited or
// differently-quoted wrapper is most likely to carry.
test('a plain snapshots path reads back exactly, quoted or not', () => {
  const home = fakeHome('{}');
  const plain = '/Users/someone/.local/state/tarmac/snapshots';
  fs.mkdirSync(paths(home).dir, { recursive: true });
  for (const line of [`TARMAC_DIR='${plain}'`, `TARMAC_DIR="${plain}"`]) {
    fs.writeFileSync(paths(home).wrapper, `#!/bin/sh\n# ${WRAPPER_MARKER}\n${line}\n`);
    assert.equal(installedSnapshotsDir(paths(home)), plain, line);
  }
});
