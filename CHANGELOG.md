# Changelog

All notable changes to `@adrrr/tarmac` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org/spec/v2.0.0.html).

> Issue references below (`#16`, `#19`, `#20`, …) point at the pre-V1 development
> history, which is not part of this repository's tracker.

## [Unreleased]

### Fixed

- `uninstall` now removes the wrapper-owned `.tarmac-last-prune` housekeeping marker while
  preserving every snapshot file. A foreign `statusLine` keeps both the wrapper and marker,
  and settings restoration completes before marker cleanup can fail. (#9)
- **The wrapper now writes exactly what it can delete.** The writer took any `session_id` of
  8 to 64 characters of `[0-9A-Za-z-]`; the amortized sweep, the legacy purge and the temp
  reaper each matched a different, hand-copied set. That diverged in both directions at once.
  A session id wider than a UUID was filed and then invisible to the sweep — one dead file per
  session per night, forever, for that session, with nothing saying so. And the sweep's glob
  was written with `?`, which matches a leading dot, so a `.bcdefgh-….json` **that the writer
  could never have produced** was unlinked by a status line — the same reach the legacy purge
  had inside `~/.claude`. Both were one divergent constant, and there is now one: a session id
  is the UUID Claude Code emits, 8-4-4-4-12 hexadecimal in either case, read by the writer, by
  the sweep, by the purge and by the reaper from `SID_GLOB`. Written as an enumeration of the
  sixteen digits rather than as `[0-9a-fA-F]`, because a bracket RANGE is collated by the
  locale: under `en_US.UTF-8`, bash, ksh and BSD `find` all read `a-f` as reaching `é` and
  fullwidth `ａ`, while the regex derived from the same string is ASCII code points — one
  constant meaning two sets depending on the `LANG` of whoever's terminal drew the frame.

  The alignment is towards the **writer**, not the deleters. Widening a deleter to the old
  charset would have put every stem of eight characters or more within reach of `rm`, in a
  directory the manual invites you to share with another statusline and that people keep in
  git; a name is not provenance. The cost of the direction chosen is named: a session whose id
  is not a UUID now gets no snapshot, and appears in `list` as a live session with `absent`
  telemetry — a state the fleet join already has, on screen, rather than a leak on disk.
  Two residues on any machine that ran an earlier version, stated rather than glossed: a
  snapshot filed under a non-UUID name is still read but will never be swept, and a temp file
  left under one, `.tarmac-<sid>.<pid>.tmp`, is no longer collected at all — coverage lost
  over the existing stock, not just a sweep that skips it. Neither gets a migration: the shape
  has never been observed (every fixture here, every transcript Claude Code names), and these
  would be files of installs never published. And the cost is now *said*: `list` and `serve` no longer answer a session of that
  kind with "run `tarmac install` and give them one TUI frame" — advice already taken, which
  no frame can satisfy. They report how many session ids the wrapper will never file, which is
  the difference between telemetry that is late and telemetry that is not coming. (#7)

## [0.2.0] - 2026-08-14

### Added

- `repository`, `homepage` and `bugs` links in `package.json` — the npm page now points at
  the public repository ([github.com/adrrr/tarmac](https://github.com/adrrr/tarmac)), which
  is also where issues live from this release on.

### Changed

- **Breaking (path).** Snapshots moved out of `~/.claude`, to
  `$XDG_STATE_HOME/tarmac/snapshots` — `~/.local/state/tarmac/snapshots` when that variable
  is unset or not absolute. `~/.claude` is commonly a git repository (dotfiles, config
  sync), and the wrapper rewrites `<session>.json` at every frame of every session: the
  first sync after an install committed eight runtime payloads, and every one after that
  diffed them forever. The wrapper and `backup.json` stay under `~/.claude/tarmac/` — they
  are stable, and the backup is the undo path. `install` clears the old directory (payloads,
  temp files, prune marker; a file it did not write is never touched and keeps the directory)
  and prints how many, where, and — when `~/.claude` is a git repository — the `.gitignore`
  line worth adding. Nothing is copied across: a snapshot is a reading of the frame that
  wrote it, and every live session writes a fresh one within seconds. **Anything other than
  tarmac reading that directory must follow the move**: `tarmac list --json` reports the
  effective path as `health.snapshotsDir`, `tarmac serve` prints it on startup, and the
  install plan names it. `--snapshots-dir`, `TARMAC_SNAPSHOTS_DIR` and `"snapshotsDir"` are
  unchanged and still win over the default. (#20)

### Fixed

- With nothing configured, `list` and `serve` now take the snapshots directory from the
  **installed wrapper** instead of recomputing it. The wrapper carries an absolute path frozen
  at install time; a reader that recomputed it would disagree with the writer whenever the two
  processes see different environments — `XDG_STATE_HOME` exported in an interactive shell and
  absent from a LaunchAgent, a systemd user unit, cron, or `sudo` without `-E`. The symptom
  would have been `statusline chained on 0/N sessions`: a healthy, empty fleet, which is the
  one failure a fleet monitor may not have. Nothing new is stored, and an install left by an
  earlier version is read as it stands. (#20)
- `uninstall`'s plan now names the snapshots directory it leaves behind, like `install`'s
  does — the path is no longer guessable from the one above it. (#20)
- The `.gitignore` pattern the install hint prints is now relative to the repository it names,
  so it is a line git actually honours. A fixed `tarmac/snapshots/` was correct for a
  `.claude` repository and matched nothing at all from a home that is one. (#20)
- A missing snapshots directory is no longer silent when an install froze that path into the
  wrapper: silence is now reserved for the case it was always about, no install at all. (#20)
- The install plan says when it is about to point the wrapper at a **different** directory
  than the one it writes to today — a relocation left payloads behind with nothing to collect
  them, and said nothing. (#20)

## [0.1.2] — 2026-08-13

### Fixed

- Snapshots no longer accumulate forever. The chained wrapper now prunes `<session>.json`
  files no frame has rewritten in 48h — a live session restamps its own on every frame, so
  mtime is what separates the dead from the living. Amortized like the design it replaces:
  one `find` on a single marker file per frame, one sweep per hour, and only names shaped
  like the session id it writes — never a `settings.json` next to them, never a
  subdirectory, never a directory or symlink wearing that name. Nothing pruned them before,
  and a fleet recycling its sessions nightly grew one dead file per session per night. (#19)
- A snapshot directory that has become read-only no longer prints `cannot create …:
  Permission denied` on the terminal on every frame. Redirections are applied left to right,
  so the wrapper's `> "$tmp" 2>/dev/null` opened the temp file while stderr was still the
  terminal, and the shell's own message was printed before the `2>` could swallow it — under
  every shell, not only dash. The display and the exit code were never affected, which is
  why only stderr itself ever showed it. (#23)

## [0.1.1] — 2026-08-10

### Fixed

- `serve`: a busy **default** port (4477) now walks up to the next free port instead of
  dying — a port named explicitly with `--port` still refuses, with a `--port` hint in
  the message. Only the default nobody chose ever moves. (#16)
- `install`: a failed install now unwinds what it created and restores the bytes of
  anything it overwrote — including through a valid symlink, the dotfiles case — instead
  of leaving a half-written tree behind. The original error is what propagates. (#18)

## [0.1.0] — 2026-08-09

Initial release.

### Added

- `tarmac list` — one-shot fleet table from `claude agents --json` plus chained-statusline
  snapshots; `--watch` redraws every 5s and dates every reading.
- `tarmac serve` — local dashboard on `127.0.0.1:4477` (`/`, `/live`, `/api/fleet`).
- `tarmac install` / `tarmac uninstall` — chain and unchain `statusLine.command`: the plan
  is printed before anything changes, confirmation is a typed word (`--yes`, in writing,
  for scripts), and uninstall restores the exact previous command from its backup.
- Snapshot schema guard pinned to per-version fixtures of Claude Code's real payloads.
