// P2 — the installer, on disk.
//
// CONSENT, NOT A GUARD: the spike refused the real HOME outright, which is exactly the one
// thing a released tool must be able to do. What stands in its place is `planInstall` /
// `planUninstall` — a dry run that reads only, names the file, quotes the command it will
// wrap and spells out the way back — plus the typed confirmation in `prompt.ts`. Nothing
// here decides on the user's behalf; every refusal below is about a state we cannot undo,
// never about which directory it is.
//
// The suite still never reaches the real home: `os.homedir()` reads $HOME, so the tests
// that exercise the default target run under a throwaway one.
//
// Reversibility model — two levels, because "byte for byte" and "do not clobber the user's
// later edits" cannot both hold unconditionally:
//   • settings.json untouched since we wrote it  → restore the ORIGINAL BYTES verbatim
//     (indentation, key order, trailing newline — everything).
//   • settings.json edited since                 → surgical restore of the statusLine key
//     only, everything else the user wrote is kept (re-serialised, so formatting may move).
// Which of the two ran is reported back to the caller, never guessed at silently.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chainStatusLine, unchainStatusLine } from './settings.ts';
import type { Settings, StatusLineCommand } from './settings.ts';
import { firstWord, quoteArg } from './shell.ts';
import { renderWrapper, PRUNE_MARKER, SNAPSHOT_NAME, TEMP_PREFIX, WRAPPER_MARKER } from './wrapper.ts';

/** Every path tarmac owns under a given HOME. */
export interface TarmacPaths {
  claude: string;
  settings: string;
  dir: string;
  wrapper: string;
  backup: string;
  /**
   * The runtime payloads — OUTSIDE `.claude`, and that is the whole of #20: `.claude` is
   * commonly a git repo (dotfiles, config sync), and the wrapper rewrites `<sid>.json` at
   * every frame of every session. State that is regenerated on the next frame has no
   * business in a directory whose purpose is to be committed.
   */
  snapshots: string;
  /** `<state>/tarmac` — the parent of `snapshots`, and ours to take back if an install fails. */
  stateDir: string;
  /** Where they lived before: inside `.claude`. Cleared by `install`, never written again. */
  legacySnapshots: string;
  /** The user's, not ours: written by hand, read by `list` and `serve`, never touched here. */
  config: string;
}

export interface PathOptions {
  /** This process's environment — see `stateRoot` for why it is not simply read here. */
  env?: Record<string, string | undefined>;
  /** The home this process runs under, i.e. the one `XDG_STATE_HOME` speaks for. */
  realHome?: string;
}

/** The only record of the statusline we wrapped. Losing it means losing the way back. */
export interface Backup {
  version: 1;
  previous: StatusLineCommand | null;
  originalText: string | null;
  installedText: string;
  installedAt: string;
}

export type InstallResult = TarmacPaths & {
  alreadyInstalled: boolean;
  previous: StatusLineCommand | null;
  /** What an older tarmac had left inside `.claude`, and this run cleared. `null`: nothing. */
  legacy: LegacySnapshots | null;
};

/** The runtime payloads a pre-#20 install left under `.claude`, as counted or as cleared. */
export interface LegacySnapshots {
  /** The directory itself, so a plan or a report can name it. */
  dir: string;
  /** Payloads this tool wrote there — removed, since the next frame writes them anew. */
  payloads: number;
  /** What stays: everything we did not write, plus anything we could not remove. */
  kept: number;
}

export type UninstallMode = 'bytes' | 'surgical' | 'absent' | 'foreign';

export interface HomeOptions {
  home: string;
}

export interface PlanOptions extends HomeOptions {
  /** Only ever used to SAY whether this is your own home — never to refuse it. */
  realHome?: string;
}

/**
 * A dry run, in the user's words: which file changes, what it says now, what it will say,
 * and how to undo it. Computed by reading only, so the confirmation prompt can never
 * appear for an operation that was going to refuse anyway.
 */
interface PlanBase {
  home: string;
  settings: string;
  wrapper: string;
  /** The very home this terminal is using — i.e. the display that changes under you. */
  isRealHome: boolean;
  /** `statusLine.command` as settings.json spells it today, verbatim. */
  before: string | null;
  /** `statusLine.command` afterwards — `null` when the key (or the file) goes away. */
  after: string | null;
  /**
   * Where the bytes really land, when `settings` is a symlink and they land elsewhere.
   * `null` when the path is the file. (A symlinked `.claude` DIRECTORY is not reported —
   * the write follows it just the same, and the plan names the path the user typed.)
   */
  writes: string | null;
  /** The exact command that undoes this one. */
  undo: string;
}

export interface InstallPlan extends PlanBase {
  action: 'install';
  /**
   * Where the payloads will live — the path this install is about to freeze into the wrapper.
   * No longer guessable from the path above it, which is exactly why both plans name it.
   */
  snapshots: string;
  /** The command the wrapper will call, so the display is unchanged. */
  chained: string | null;
  alreadyInstalled: boolean;
  /** The payloads an older tarmac left inside `.claude`, which this install clears. */
  legacy: LegacySnapshots | null;
  /**
   * The version-controlled directory this install writes into, and the pattern that would
   * ignore the payloads FROM THAT REPOSITORY's root — a `.gitignore` pattern is relative to
   * the file carrying it, so the two cannot be computed apart.
   */
  gitRepo: { dir: string; ignore: string } | null;
  /**
   * Where the installed wrapper writes today, when this install is about to freeze a
   * different path into it. `null` when nothing moves, which is every install but a
   * relocation.
   */
  movingFrom: string | null;
}

export interface UninstallPlan extends PlanBase {
  action: 'uninstall';
  /** Which restore will run — the same four modes `uninstall` reports afterwards. */
  mode: UninstallMode;
  /**
   * Where the payloads this uninstall leaves behind really are — read from the installed
   * wrapper, which is the only thing that knows.
   *
   * `null` when there is no answer to read: the wrapper is gone (hand-deleted, with a usable
   * `backup.json` left over — a state `uninstall` still works through) or it no longer says
   * where it writes. That is not the same as "the default", and the difference is the whole
   * point: `uninstall` reads the same `null` and touches NOTHING in any snapshots directory,
   * so a plan that filled the gap with a computed path promised a removal in a directory
   * nobody had established. Same rule as `ctxPct`: no value is never rendered as a value.
   */
  snapshots: string | null;
}

export type Plan = InstallPlan | UninstallPlan;

export function paths(home: string, { env = process.env, realHome }: PathOptions = {}): TarmacPaths {
  const claude = path.join(home, '.claude');
  const dir = path.join(claude, 'tarmac');
  const stateDir = path.join(stateRoot(home, env, realHome), 'tarmac');
  return {
    claude,
    settings: path.join(claude, 'settings.json'),
    dir,
    wrapper: path.join(dir, 'statusline.sh'),
    backup: path.join(dir, 'backup.json'),
    snapshots: path.join(stateDir, 'snapshots'),
    stateDir,
    legacySnapshots: path.join(dir, 'snapshots'),
    config: path.join(dir, 'config.json'),
  };
}

/**
 * `$XDG_STATE_HOME`, or `<home>/.local/state` — the XDG default, for "state data that should
 * persist between restarts but is not important enough for the data directory". A snapshot
 * is exactly that: a reading of one frame, rewritten by the next.
 *
 * The environment is only honoured FOR THE HOME THAT EXPORTED IT, which is the same rule
 * `commandTarget` applies to a `~` in someone's statusLine: `--home` exists to work on
 * someone else's `.claude`, and this process's `XDG_STATE_HOME` says nothing about theirs.
 * Read unconditionally, `tarmac install --home /home/jane` would point jane's wrapper at our
 * state directory. (It is NOT what keeps this project's own suite out of the developer's
 * real one — every CLI test there replaces $HOME, so both anchors coincide by construction
 * and this guard reads true. Removing the variable is the test helper's job, and it does it.)
 *
 * A relative value is ignored, as the spec asks: it would resolve against the working
 * directory, which for a status line is wherever Claude Code happened to be started.
 */
function stateRoot(home: string, env: Record<string, string | undefined>, realHome: string | undefined): string {
  const xdg = env.XDG_STATE_HOME?.trim();
  // Short-circuited on purpose: the real home is a QUESTION ABOUT THIS VARIABLE. Asking it
  // unconditionally — as a default parameter — made `paths()`, which never touched the
  // environment before, able to throw on a container with no passwd entry and no $HOME.
  if (xdg && path.isAbsolute(xdg) && sameFile(home, thisHome(realHome))) return xdg;
  return path.join(home, '.local', 'state');
}

/**
 * Which home this process runs under, or `null` when the system cannot say. Unanswerable
 * reads as "this is NOT the home that exported the variable" — the safe direction: the
 * default under the home actually being targeted, rather than a throw or someone else's
 * directory.
 */
function thisHome(realHome: string | undefined): string | null {
  if (realHome !== undefined) return realHome;
  try {
    return os.homedir();
  } catch {
    return null;
  }
}

// Two paths name the same directory far more often than string equality admits: `/tmp` is
// a symlink to `/private/tmp`, `/System/Volumes/Data/Users/x` is a macOS firmlink onto
// `/Users/x` (same inode, and `realpath` does NOT collapse it), plus bind mounts and
// relative spellings. Device + inode is the only identity that holds through all of them.
function sameFile(a: string, b: string | null): boolean {
  // `null` is "the question could not be answered" — never an accidental match.
  if (b === null) return false;
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    // one of them does not exist yet — fall back to the strongest textual comparison
    return realpathOrSelf(a) === realpathOrSelf(b);
  }
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// A home that is not there is a typo, not an instruction. Creating `<typo>/.claude/tarmac/`
// and reporting success is how someone ends up believing tarmac watches a directory nothing
// will ever write to — the same failure `args.ts` refuses for a misspelled flag.
function requireHome(home: string): string {
  if (!home) throw new Error('a HOME is required');
  const root = path.resolve(home);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    throw new Error(`${root} does not exist — pass --home a directory that does`);
  }
  if (!stat.isDirectory()) throw new Error(`${root} is not a directory`);
  return root;
}

/** @throws if settings.json exists and is not JSON — the one file we must never mangle. */
function readSettings(p: TarmacPaths): { text: string | null; settings: Settings } {
  const text = fs.existsSync(p.settings) ? fs.readFileSync(p.settings, 'utf8') : null;
  let settings: Settings = {};
  if (text !== null && text.trim() !== '') {
    try {
      settings = JSON.parse(text);
    } catch {
      throw new Error(`${p.settings} is not valid JSON — refusing to touch it`);
    }
  }
  return { text, settings };
}

/**
 * On a re-install the original statusLine lives in the backup — never in the current
 * settings, which already point at us. If that backup is gone, unreadable or shapeless we
 * can no longer NAME what we wrapped: regenerating the wrapper from that hole would
 * silently drop the user's real statusline forever. Refuse, and touch nothing.
 */
function backupOrRefuse(p: TarmacPaths): Backup {
  const backup = readBackup(p);
  if (!isUsableBackup(backup)) {
    throw new Error(
      `${p.settings} already points at the tarmac wrapper but its backup (${p.backup}) is missing, unreadable or incomplete — ` +
        `refusing to regenerate the wrapper, which would drop the statusline it wraps. ` +
        `Restore the backup, or point statusLine back at your own command and install again.`,
    );
  }
  return backup;
}

// "The exact command that undoes it" has to survive being pasted back into a shell, and a
// home with a space in its name is an ordinary macOS home — `quoteArg` lives in `shell.ts`
// next to the reader that undoes it.
const undoCommand = (verb: string, home: string, isRealHome: boolean): string =>
  isRealHome ? `tarmac ${verb}` : `tarmac ${verb} --home ${quoteArg(home)}`;

/**
 * The file a write to `file` really reaches. `realpath` cannot answer this: it fails on a
 * DANGLING link — a dotfiles repo not cloned yet is exactly that — and the fallback then
 * renames over the link, replacing it with a regular file. Following the links by hand
 * lands where a shell's `>` would, and creates the file the link names.
 */
function resolveWriteTarget(file: string): string {
  let current = file;
  for (let hops = 0; hops < 10; hops++) {
    let link: string;
    try {
      link = fs.readlinkSync(current);
    } catch {
      return current; // not a link (or unreadable): this is the file
    }
    current = path.resolve(path.dirname(current), link);
  }
  return current; // a loop of links: stop somewhere rather than spin
}

/** …and say so, when that is not the path the plan names. */
function writesInstead(file: string): string | null {
  const target = resolveWriteTarget(file);
  return target === file ? null : target;
}

// ── the payloads left inside `.claude` by the versions that wrote them there ────────────
//
// Moving the directory is only half of #20: the machines that hit the bug already have the
// files, committed, and nothing would ever remove them. They are PURGED rather than moved —
// a snapshot is a reading of the frame that wrote it, every live session writes a fresh one
// within seconds, and carrying them across would import into the new directory the very
// files the issue is about, dated from before the move.

/**
 * What is in the legacy directory: the payloads this tool wrote, and everything else.
 *
 * The "ours" set is the WRITER'S RULE, not merely the writer's names. The wrapper's own
 * sweep is `-name '<sid shape>' -type f`, and both halves are the rule — `wrapper.ts` refuses
 * a directory or a symlink wearing a session id's name, because a name is not provenance.
 * Matching only the name here removed a symlink the shell sweep would have left. Everything
 * else is someone's, and one of them is enough to keep the directory (`rmdir`, never a
 * recursive remove: the same rule the unwind states, and this one runs inside a git repo).
 */
function readLegacyDir(p: TarmacPaths): { ours: string[]; kept: number } | null {
  // The directory the wrapper is ABOUT TO WRITE TO is never the directory we clear, however
  // the two came to be the same path — `XDG_STATE_HOME=$HOME/.claude` is enough. Purging it
  // would delete the payloads while announcing the very same path as their new home.
  if (sameFile(p.snapshots, p.legacySnapshots)) return null;

  const dir = p.legacySnapshots;
  // `lstat`, not `readdir` alone: a SYMLINK here is the workaround someone will already have
  // applied to #20 — the directory pointed at a disk outside the repo. `readdir` follows it,
  // so an unguarded sweep would delete their snapshots at the far end and leave the link.
  // A directory this tool did not make is not this tool's to empty.
  try {
    if (!fs.lstatSync(dir).isDirectory()) return null;
  } catch {
    return null; // absent, which is the normal case from #20 on
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // Unreadable is not ours to fix from inside an install.
    return null;
  }

  const ours: string[] = [];
  let kept = 0;
  for (const name of entries) {
    if (isPayloadName(name) && isPlainFile(path.join(dir, name))) ours.push(name);
    else kept += 1;
  }
  return { ours, kept };
}

/**
 * The three names the wrapper writes into its snapshot directory, and nothing else.
 *
 * `SNAPSHOT_NAME` is the writer's own rule now, not a second reading of it (#7): this purge
 * deletes from inside `~/.claude`, a directory people version-control, and a `<sid>.json` is
 * recognised by SHAPE alone — so the shape had better be one the wrapper can actually
 * produce, or this deletes by resemblance in the worst place to be wrong about it.
 *
 * `TEMP_PREFIX` is deliberately the whole test for a temp file, and deliberately looser than
 * `reap.ts`'s `<prefix><sid>.<pid>.tmp`. The two answer different questions. `reap` runs on
 * every `serve` tick, in a directory a reader may have been pointed at and another program
 * may own, so it takes only the exact name this wrapper emits. This runs once, at install,
 * behind `tarmacWasInstalledHere` — provenance already proven — over a directory whose whole
 * purpose was to be ours, and its job is to leave nothing behind so the directory itself can
 * go. There, a name only tarmac ever writes is signature enough.
 */
const isPayloadName = (name: string): boolean =>
  SNAPSHOT_NAME.test(name) || name.startsWith(TEMP_PREFIX) || name === PRUNE_MARKER;

/** `lstat`: the LINK's own kind decides, since `unlink` would remove the link, not its target. */
const isPlainFile = (file: string): boolean => {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * Did an install of OURS already exist here, before this run wrote anything?
 *
 * `~/.claude/tarmac/snapshots` is a documented path — this project's own docs invite you to
 * point a reader at one — and the "ours" set is a SHAPE: a UUID name, a `.tarmac-` prefix.
 * Shape is not provenance. Without this, a FIRST install on a home tarmac had never touched
 * deleted another writer's files, under a plan promising they would be "written again on the
 * next frame" by a wrapper that had never written them. It is the same reasoning that spares
 * a symlink two functions up, applied where it was missing.
 *
 * Three independent proofs, any one of which is enough: the statusLine already points at us
 * (the update path), our marker is in the wrapper (an install whose settings.json was lost),
 * or a usable backup is on disk (a wrapper someone deleted by hand). All three must be read
 * BEFORE this run writes anything — by the time the purge runs it has written two of them.
 */
export function tarmacWasInstalledHere(p: TarmacPaths, alreadyInstalled: boolean): boolean {
  return alreadyInstalled || carriesWrapperMarker(p.wrapper) || isUsableBackup(readBackup(p));
}

/** Read-only, for the plan: what an install would clear, before a byte is written. */
export function countLegacySnapshots(p: TarmacPaths, wasInstalled: boolean): LegacySnapshots | null {
  if (!wasInstalled) return null;
  const found = readLegacyDir(p);
  return found === null ? null : { dir: p.legacySnapshots, payloads: found.ours.length, kept: found.kept };
}

/**
 * …and the deed. Best effort throughout: a payload we cannot remove is counted as KEPT, not
 * as removed — which is both honest and exactly what decides whether the directory goes.
 *
 * Runs LAST in an install, after the wrapper has been rewritten: until those bytes land, the
 * OLD wrapper is still the one Claude Code calls, and still dropping a file in here at every
 * frame. That frame cannot be locked out — and its first act is `mkdir -p`, so it can put the
 * whole directory back between the `rmdir` and this function returning. Hence the read-back:
 * what is reported is what is ON DISK afterwards, never what was asked for. A user told to
 * commit a removal that had already been undone is worse served than one told it did not take.
 */
export function purgeLegacySnapshots(p: TarmacPaths, wasInstalled: boolean): LegacySnapshots | null {
  if (!wasInstalled) return null;
  const found = readLegacyDir(p);
  if (found === null) return null;

  let payloads = 0;
  let kept = found.kept;
  for (const name of found.ours) {
    try {
      fs.unlinkSync(path.join(p.legacySnapshots, name));
      payloads += 1;
    } catch {
      kept += 1;
    }
  }
  if (kept === 0) {
    // Twice at most. The first `rmdir` can lose a race with a frame's `mkdir -p`, and what
    // that recreates is an EMPTY directory — which the second attempt takes. A second failure
    // means the frame also wrote a payload into it: reported, not chased, because this is an
    // install and not a daemon. Either way what is reported is read back from disk.
    for (let pass = 0; pass < 2; pass++) {
      try {
        fs.rmdirSync(p.legacySnapshots);
      } catch {
        // ENOTEMPTY from a frame that landed mid-sweep — the read-back below reports it.
      }
      const after = readLegacyDir(p);
      if (after === null) break; // gone, which is the whole point
      kept = after.ours.length + after.kept;
    }
  }
  return { dir: p.legacySnapshots, payloads, kept };
}

/**
 * The version-controlled directory this install writes into, nearest first — `.claude` under
 * its own repo, else a home that is one (`git init ~` is an ordinary dotfiles setup, and the
 * hint was silent for it while the purge ran just the same). Nearest wins, so the advice is
 * always about the repository the files are actually in.
 *
 * `.git` is a FILE in a worktree or a submodule — a `gitdir:` pointer — and the people who
 * keep `.claude` in a dotfiles repo are exactly the people who use those, so this asks
 * whether the name exists at all rather than what it is. A bare-repo setup (`yadm`, a
 * `--git-dir` alias) has no `.git` anywhere and is not detected: stated, not papered over.
 *
 * Only ever used to SAY something. Nothing here reads, writes or runs git.
 */
function gitRepoOf(p: TarmacPaths, home: string): { dir: string; ignore: string } | null {
  const dir = [p.claude, home].find((d) => fs.existsSync(path.join(d, '.git')));
  if (dir === undefined) return null;
  // Relative to the repository that will carry the `.gitignore`, with a trailing slash so it
  // names a directory. A fixed `tarmac/snapshots/` was right for `.claude` and INERT for a
  // home — `git check-ignore` says so, and a test now asks it rather than asking us.
  return { dir, ignore: `${path.relative(dir, p.legacySnapshots)}/` };
}

export function planInstall({ home, realHome = os.homedir() }: PlanOptions): InstallPlan {
  const root = requireHome(home);
  const p = paths(root);
  const { settings } = readSettings(p);
  const { previous, alreadyInstalled } = chainStatusLine(settings, p.wrapper, {
    isSameCommand: (command, wrapper) => isWrapperCommand(command, root, wrapper),
    commandSpelling: quoteArg(p.wrapper),
  });
  const isRealHome = sameFile(root, realHome);
  const before = commandOf(settings.statusLine);
  return {
    action: 'install',
    home: root,
    settings: p.settings,
    wrapper: p.wrapper,
    isRealHome,
    writes: writesInstead(p.settings),
    before,
    // A re-install regenerates the wrapper and leaves settings.json alone, so announcing a
    // new value there would be a plan disagreeing with what runs.
    after: alreadyInstalled ? before : quoteArg(p.wrapper),
    chained: alreadyInstalled ? (backupOrRefuse(p).previous?.command ?? null) : (previous?.command ?? null),
    alreadyInstalled,
    snapshots: p.snapshots,
    legacy: countLegacySnapshots(p, tarmacWasInstalledHere(p, alreadyInstalled)),
    gitRepo: gitRepoOf(p, root),
    movingFrom: movedFrom(p),
    undo: undoCommand('uninstall', root, isRealHome),
  };
}

/**
 * The directory the installed wrapper writes to today, when this install is about to freeze a
 * different one into it — `null` when nothing moves.
 *
 * `install` re-derives the path from ITS OWN environment, so a shell that exports
 * `XDG_STATE_HOME` and a cron job that does not relocate the writer back and forth. The
 * relocation itself is a separate question; a plan that changes where the telemetry lands
 * without saying so is not, and the payloads left in the old directory are collected by
 * nothing.
 */
function movedFrom(p: TarmacPaths): string | null {
  const current = installedSnapshotsDir(p);
  return current === null || current === p.snapshots ? null : current;
}

/** The statusLine command as written, or `null` when there is none to read. */
function commandOf(statusLine: unknown): string | null {
  const command = (statusLine as { command?: unknown } | null | undefined)?.command;
  return typeof command === 'string' ? command : null;
}

/**
 * Is `command` the very wrapper at `wrapperPath`, under any spelling?
 *
 * `stat` of the raw string is not an answer: `statusLine.command` is read by a shell, and
 * `~/…` — how this machine's own production statusline is written — stats to nothing. A
 * tarmac that fails to recognise itself there wraps its own wrapper (unbounded recursion at
 * every frame) AND rewrites the backup with the wrapper as "what we wrapped", erasing the
 * only record of the user's real statusline. So: resolve the spellings a shell would, then
 * ask the file itself, which carries a marker no other file has a reason to.
 */
function isOurWrapperPath(command: string, home: string, wrapperPath: string): boolean {
  return sameFile(commandTarget(command, home), wrapperPath);
}

/**
 * Deciding whether to WRAP something: path identity, or the file saying what it is. Over-
 * claiming here fails closed — tarmac refuses instead of nesting a wrapper in a wrapper.
 *
 * Deciding whether to OVERWRITE something (uninstall) is the opposite risk, so it asks
 * `isOurWrapperPath` alone: a script of the user's that merely mentions the wrapper stays
 * foreign, and foreign still means "nothing is restored and nothing is deleted".
 */
function isWrapperCommand(command: string, home: string, wrapperPath: string): boolean {
  return isOurWrapperPath(command, home, wrapperPath) || carriesWrapperMarker(commandTarget(command, home));
}

/**
 * The file a statusLine command refers to.
 *
 * `~`, `$HOME` and `${HOME}` are resolved against `home` — the home whose settings.json this
 * is — not against the process's own. `--home` exists precisely to work on someone else's
 * `.claude`, and the shell that will run that line runs under THAT home.
 */
function commandTarget(command: string, home: string): string {
  const s = command.trim();
  for (const [prefix, cut] of [['~/', 2], ['$HOME/', 6], ['${HOME}/', 8]] as const) {
    if (s.startsWith(prefix)) return path.join(home, firstWord(s.slice(cut)));
  }
  return firstWord(s);
}

/**
 * The first `size` bytes of a file, or `null` when there are none to be had.
 *
 * `O_NONBLOCK`, because the path can come out of someone's settings.json: a FIFO with no
 * writer or a dead network mount would otherwise hang a tool before it printed anything.
 */
function readHead(file: string, size: number): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const head = Buffer.alloc(size);
    const read = fs.readSync(fd, head, 0, size, 0);
    return head.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Only install-time code asks this, never the render path. */
function carriesWrapperMarker(file: string): boolean {
  return readHead(file, 512)?.includes(WRAPPER_MARKER) ?? false;
}

/**
 * Is the file at the wrapper's path one of ours? Lets a caller tell "no install here" from
 * "an install whose path we could not read" — two answers `installedSnapshotsDir` collapses
 * into `null`, and only one of which is worth a word on stderr.
 */
export const wrapperIsOurs = (p: TarmacPaths): boolean => carriesWrapperMarker(p.wrapper);

/**
 * Where the INSTALLED wrapper actually writes — read out of the wrapper itself.
 *
 * The wrapper carries an absolute path, frozen into the file at install time. `list` and
 * `serve` used to RECOMPUTE the default instead, from their own `process.env` — so an
 * `XDG_STATE_HOME` set in an interactive shell and absent from a LaunchAgent, a systemd user
 * unit, cron or `sudo` without `-E` had the writer filing into A while the reader watched B.
 *
 * That split was silent by construction: a default directory that does not exist is the
 * zero-config case, so `collect.ts` says nothing about it, and the only symptom was
 * `statusline chained on 0/N sessions` — which the manual itself calls "a true statement
 * about the wrong directory". A fleet monitor whose failure looks like a healthy empty fleet
 * is the one failure it may not have.
 *
 * Reading our own generated file is not parsing an internal format: this is the file this
 * module writes, and the marker is the same one `carriesWrapperMarker` trusts everywhere
 * else. Nothing new is stored, and an install left by an older version is picked up as it
 * stands. `null` means "no install here to ask" — the caller then computes the default.
 */
export function installedSnapshotsDir(p: TarmacPaths): string | null {
  const head = readHead(p.wrapper, 8192);
  if (head === null || !head.includes(WRAPPER_MARKER)) return null;
  const line = /^TARMAC_DIR=(.*)$/m.exec(head);
  return line === null ? null : shUnquote(line[1]);
}

/**
 * The inverse of the single-quoting `renderWrapper` applies (`shQuote`, in `wrapper.ts`) —
 * the exact one, never a guess.
 *
 * Double quotes are accepted too. Nothing here emits them, but a hand-edited wrapper, or one
 * written by another generation of this file, exists; refusing a spelling every shell reads
 * the same way would send the reader back to guessing from its own environment, which is the
 * bug this function closes.
 *
 * An EMPTY value is not a path — it is a wrapper that writes nowhere. `args.ts` refuses
 * `--snapshots-dir=` and `config.ts` refuses `"snapshotsDir": ""` for exactly that reason.
 */
function shUnquote(text: string): string | null {
  const s = text.trim();
  const quote = s.startsWith("'") ? "'" : s.startsWith('"') ? '"' : null;
  if (quote === null || s.length < 2 || !s.endsWith(quote)) return null;
  const body = quote === "'" ? s.slice(1, -1).split(`'\\''`).join("'") : s.slice(1, -1);
  return body === '' ? null : body;
}

/**
 * A backup we cannot trust is worse than none: it is the only record of the statusline we
 * wrapped. `previous: null` is legitimate ("there was no statusLine"), so the discriminant
 * is the PRESENCE of the key — the same rule this codebase applies to `used_percentage`.
 */
function isUsableBackup(b: unknown): b is Backup {
  return (
    !!b &&
    typeof b === 'object' &&
    (b as Backup).version === 1 &&
    'previous' in (b as object) &&
    'originalText' in (b as object)
  );
}

export function install({ home }: HomeOptions): InstallResult {
  const root = requireHome(home);
  const p = paths(root);

  const { text: originalText, settings } = readSettings(p);
  const { settings: next, previous, alreadyInstalled } = chainStatusLine(settings, p.wrapper, {
    isSameCommand: (command, wrapper) => isWrapperCommand(command, root, wrapper),
    commandSpelling: quoteArg(p.wrapper),
  });
  // Read here and nowhere later: two of its three proofs are things this function is about
  // to write, so asking afterwards would always answer yes.
  const wasInstalled = tarmacWasInstalledHere(p, alreadyInstalled);

  if (alreadyInstalled) {
    const backup = backupOrRefuse(p);
    fs.mkdirSync(p.snapshots, { recursive: true });
    writeWrapper(p, backup.previous?.command ?? null, root);
    // After the wrapper, always: this is the update path, and until that write lands the
    // frames are still filing into the directory being cleared.
    return { alreadyInstalled: true, previous: backup.previous ?? null, legacy: purgeLegacySnapshots(p, wasInstalled), ...p };
  }

  // The other end of that order: everything from here CREATES, and the settings write is
  // the step that can still throw — a symlinked settings.json whose target lives in a
  // directory with entirely different permissions, or in one that is not there at all.
  // Left behind, the wrapper and the backup describe an install that never happened, and
  // that is precisely the state `uninstall` calls `foreign` and clears nothing of. So:
  // remember what was already on disk, and unwind exactly what this run added.
  const before = whatIsThere([p.dir, p.stateDir, p.snapshots, p.wrapper, p.backup]);
  try {
    fs.mkdirSync(p.dir, { recursive: true });
    fs.mkdirSync(p.snapshots, { recursive: true });
    writeWrapper(p, previous?.command ?? null, root);

    // Order matters: the backup is the only way back, so it must be on disk BEFORE
    // settings.json sends Claude Code to the wrapper. Crashing between the two otherwise
    // locks the user out of install (backup missing) and uninstall (no install found) at once.
    const installedText = JSON.stringify(next, null, 2) + '\n';
    fs.writeFileSync(
      p.backup,
      JSON.stringify({ version: 1, originalText, installedText, previous, installedAt: new Date().toISOString() }, null, 2),
    );
    writeAtomic(p.settings, installedText);
  } catch (failure) {
    unwind(p, before);
    throw failure;
  }

  return { alreadyInstalled: false, previous, legacy: purgeLegacySnapshots(p, wasInstalled), ...p };
}

/**
 * What is on disk before we touch it: the paths that are already there, mapped to the bytes
 * we would have to put back. `null` when there are no bytes to save — a directory, a dangling
 * link (whose target we would be CREATING, not restoring), a FIFO.
 *
 * The two stats answer two different questions, and using one for both is how this went
 * wrong twice:
 *   • PRESENCE is `lstatSync` — the link itself. `existsSync` follows it, so a DANGLING
 *     symlink reads as absent and the unwind unlinks something this run never created.
 *   • CONTENT is `statSync` — through the link. `writeFileSync` follows it too, so when the
 *     dotfiles repo IS cloned the bytes this run destroys are the TARGET's: the user's own
 *     statusline script, which an `lstat`-only reading called "not a file" and left to die.
 */
function whatIsThere(targets: string[]): Map<string, Buffer | null> {
  const before = new Map<string, Buffer | null>();
  for (const target of targets) {
    try {
      fs.lstatSync(target);
    } catch {
      continue; // not there: ours to create, and ours to take back
    }
    before.set(target, statThroughLink(target)?.isFile() ? readOrNull(target) : null);
  }
  return before;
}

const statThroughLink = (file: string): fs.Stats | null => {
  try {
    return fs.statSync(file);
  } catch {
    return null; // a dangling link: present, but with nothing behind it to save
  }
};

const readOrNull = (file: string): Buffer | null => {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
};

/**
 * Put the tree back as this run found it: remove what it created, newest first, and restore
 * what it overwrote. Both halves matter — a re-install that fails must not carry off the way
 * back from the install that succeeded, and leaving that backup in place with `previous:
 * null` written into it loses the user's statusline just as surely as deleting the file
 * would. A directory that holds the user's own config.json is not ours either way.
 */
function unwind(p: TarmacPaths, before: Map<string, Buffer | null>): void {
  const attempt = (undo: () => void): void => {
    try {
      undo();
    } catch {
      // What we cannot take back must never stand in for the failure that brought us here.
    }
  };
  const drop = (target: string, remove: (t: string) => void): void => {
    if (!before.has(target)) return attempt(() => remove(target));
    const original = before.get(target) ?? null;
    if (original !== null) attempt(() => fs.writeFileSync(target, original));
  };
  drop(p.backup, (f) => fs.rmSync(f, { force: true }));
  drop(p.wrapper, (f) => fs.rmSync(f, { force: true }));
  // `rmdir`, not a recursive remove: a directory that has gained snapshots or a config since
  // we made it holds someone else's data now, and ENOTEMPTY is the answer we want.
  //
  // The state directory goes back too, deepest first — `mkdir -p` made both rungs. What is
  // ABOVE it (`~/.local/state`) is XDG's, not ours: we may have created it on a home that
  // had none, and unmaking it would be reaching past what this tool owns.
  drop(p.snapshots, (d) => fs.rmdirSync(d));
  drop(p.stateDir, (d) => fs.rmdirSync(d));
  drop(p.dir, (d) => fs.rmdirSync(d));
}

/** Never let the wrapper chain to itself, whatever spelling the caller used. */
function writeWrapper(p: TarmacPaths, chainCommand: string | null, home: string): void {
  if (chainCommand && isWrapperCommand(chainCommand, home, p.wrapper)) {
    throw new Error(`refusing to chain the tarmac wrapper to itself (${chainCommand})`);
  }
  fs.writeFileSync(p.wrapper, renderWrapper({ snapshotDir: p.snapshots, chainCommand }), { mode: 0o755 });
}

// Claude Code re-reads settings.json at frame cadence: a truncated read window is real.
//
// Two things the rename must not quietly destroy, both invisible in a diff of the contents:
//   • a SYMLINK. settings.json kept in a dotfiles repo and linked into place is the normal
//     setup for the people who install a tool like this; renaming over the link replaces it
//     with a regular file, the dotfile silently stops being the source of truth, and no
//     restore puts the link back. So the write follows the link and lands on its target.
//   • the MODE. `-rw-------` is a decision; a restore that hands the file back
//     world-readable is not the file the user had, whatever the bytes say.
// The temp file is cleaned up even when the rename is what fails — a target the user has
// locked, or a read-only directory reached through a symlink. It lands NEXT TO their
// settings.json rather than under `~/.claude/tarmac/`, so the unwind above cannot see it and
// `reap` never looks there: nothing else would ever clear a full copy of their settings.
// After a successful rename it is already gone, and `force` makes the removal a no-op.
function writeAtomic(file: string, text: string): void {
  const target = resolveWriteTarget(file);
  const tmp = `${target}${TEMP_PREFIX}${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    const mode = modeOf(target);
    if (mode !== null) fs.chmodSync(tmp, mode); // after the write: umask masks the create mode
    fs.renameSync(tmp, target);
  } finally {
    // In a `finally`, so a removal that throws would REPLACE the failure that stopped the
    // install — the user reading about a temp file instead of why nothing was written.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // The temp file outliving the run is the smaller harm, every time.
    }
  }
}

/** The permission bits of an existing file, or `null` when we are creating it. */
function modeOf(file: string): number | null {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

export function planUninstall({ home, realHome = os.homedir() }: PlanOptions): UninstallPlan {
  const root = requireHome(home);
  const p = paths(root);
  const backup = installedBackupOrRefuse(p);
  // Through `readSettings`, so a settings.json that stopped being JSON since install is
  // named, not reported as a raw parser position nobody can act on.
  const { text: currentText, settings: current } = readSettings(p);

  // Predicted by asking the same two questions `uninstall` asks, in the same order. The
  // surgical branch is a pure function, so the prediction runs it and throws the result away.
  let mode: UninstallMode;
  let after: string | null;
  if (currentText === backup.installedText) {
    mode = backup.originalText === null ? 'absent' : 'bytes';
    after = backup.previous?.command ?? null;
  } else {
    const { settings, restored } = unchainStatusLine(current, backup.previous, p.wrapper, {
      isSameCommand: (command, wrapper) => isOurWrapperPath(command, root, wrapper),
    });
    mode = restored ? 'surgical' : 'foreign';
    after = restored ? commandOf(settings.statusLine) : commandOf(current.statusLine);
  }

  const isRealHome = sameFile(root, realHome);
  return {
    action: 'uninstall',
    home: root,
    settings: p.settings,
    wrapper: p.wrapper,
    isRealHome,
    writes: writesInstead(p.settings),
    before: commandOf(current.statusLine),
    after,
    mode,
    // Where they REALLY are: `uninstall` leaves them behind, so the path it prints has to be
    // the wrapper's own, not one recomputed from this shell's environment — and when the
    // wrapper cannot answer, neither can the plan. The same `null` `uninstall` acts on.
    snapshots: installedSnapshotsDir(p),
    undo: undoCommand('install', root, isRealHome),
  };
}

function installedBackupOrRefuse(p: TarmacPaths): Backup {
  const backup = readBackup(p);
  if (!isUsableBackup(backup)) throw new Error(`no tarmac install found under ${p.dir}`);
  return backup;
}

function removePruneMarker(snapshots: string | null): void {
  if (snapshots === null) return;
  const marker = path.join(snapshots, PRUNE_MARKER);
  if (isPlainFile(marker)) fs.rmSync(marker, { force: true });
}

export function uninstall({ home }: HomeOptions): { mode: UninstallMode } {
  const root = requireHome(home);
  const p = paths(root);
  const backup = installedBackupOrRefuse(p);

  // Read this before removing the wrapper: it is the source of truth when the install used
  // XDG_STATE_HOME, and the marker is the only file in that directory uninstall owns.
  const snapshots = installedSnapshotsDir(p);

  const currentText = fs.existsSync(p.settings) ? fs.readFileSync(p.settings, 'utf8') : null;
  let mode: UninstallMode;

  if (currentText === backup.installedText) {
    // untouched since install → put the original bytes back, or remove the file we created
    if (backup.originalText === null) {
      fs.rmSync(p.settings, { force: true });
      mode = 'absent';
    } else {
      writeAtomic(p.settings, backup.originalText);
      mode = 'bytes';
    }
  } else {
    const current = currentText ? JSON.parse(currentText) : {};
    const { settings, restored } = unchainStatusLine(current, backup.previous, p.wrapper, {
      isSameCommand: (command, wrapper) => isOurWrapperPath(command, root, wrapper),
    });
    if (!restored) {
      // The statusLine is someone else's now — possibly still pointing AT our wrapper's
      // path through another route. Deleting the wrapper here would leave that line
      // executing a file that no longer exists, at every frame, with no way back.
      return { mode: 'foreign' };
    }
    writeAtomic(p.settings, JSON.stringify(settings, null, 2) + '\n');
    mode = 'surgical';
  }

  // Restore settings before touching runtime state: even an unreadable snapshots directory
  // must not strand statusLine on the wrapper we are uninstalling.
  removePruneMarker(snapshots);

  // Snapshot payloads are data the user may still want; only what we generated goes.
  fs.rmSync(p.wrapper, { force: true });
  fs.rmSync(p.backup, { force: true });
  return { mode };
}

function readBackup(p: TarmacPaths): unknown {
  if (!fs.existsSync(p.backup)) return null;
  try {
    return JSON.parse(fs.readFileSync(p.backup, 'utf8'));
  } catch {
    return null;
  }
}
