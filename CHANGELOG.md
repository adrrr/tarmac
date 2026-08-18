# Changelog

All notable changes to `@adrrr/tarmac` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org/spec/v2.0.0.html).

> Issue references below (`#16`, `#19`, `#20`, …) point at the pre-V1 development
> history, which is not part of this repository's tracker.

## [Unreleased]

### Fixed

- **The two configuration tables agree about where the snapshots are read from.** The README's
  named the path frozen into the installed wrapper, the manual's named the XDG default; each is
  true in one case, and read side by side they contradict each other. Both cells now carry the
  split the resolver actually makes — the wrapper's own path when there is an install to ask
  it, the XDG state directory when there is not. (#69)

- **The listening sentence says what `serve` turns away.** "Any request a browser does not mark
  same-origin" was a notch wider than the check: a request marked `none`, and one carrying no
  `Sec-Fetch-Site` header at all, are both served — which is what makes a local `curl` work.
  The README and the manual now name what is refused, a request a browser marks as coming from
  another origin, and the manual names the header and the carve-out. (#70)

- **The manual's install walkthrough shows the line you answer.** The block ended at
  `undo tarmac uninstall` and stopped one line short of the prompt that follows it, which is
  the step the whole section is about. (#71)

## [0.4.1] — 2026-08-18

### Added

- **The statusline payload of Claude Code 2.1.232 is captured**, so the shape-check footnote
  goes quiet on the build most fleets are running. The `agents` half of the pair has been
  frozen since #44; this is the other half, and every field name tarmac reads off a payload is
  now one it has been seen carrying on 2.1.232. (#53)

### Changed

- **The session blocked on you is read first, and pulses in its own colour.** 0.4.0 gave
  `waiting` a glyph, a hue and a caption, and left two places treating it as something else.
  The sort ranked it by how busy it is, the question that put it in the `unknown` bucket —
  one rank under a fleet that is mostly busy, which on the map is under the fold, on the one
  row that has STOPPED and will not start again until someone answers it. It leads now:
  busy, unknown and idle are the fleet reporting on itself, and a fleet holds one or two
  waiting sessions at a time, so what it displaces moves down a row. The halo — the pulse
  that means a reading just landed — stroked the busy hue under a lone idle override, which
  was already the admission that its colour was never a pure freshness token, and it was
  never extended: an unrecognised status pulsed green, and since 0.4.0 a waiting session did
  too, in the hue of the one thing it is certainly not doing. Its PRESENCE is the freshness
  signal; its colour now follows the node, off the same four states as the glyph under the
  name, and the suite compares the two palettes rather than listing the hues twice. (#47)

- **The two amber banners that never left the dashboard are footnotes now.** A normal fleet
  carried both at all times. The first counted readings past the freshness threshold — but a
  statusline is only written when a terminal draws a frame, so a fleet that mostly idles has
  most of its readings past it at any hour: the steady state, restated on every poll. The
  second named Claude Code versions no fixture covers — true, and a maintainer's job, up on
  every user's page until a release ships the capture. A box that is always there is not a
  warning, it is wallpaper, and wallpaper is what teaches a reader to skip the boxes that do
  need them. **The freshness banner now appears for one shape only**: not one reading anywhere
  is fresh, AND at least one of the cold ones belongs to a session that is busy right now. A
  busy session redraws its status line, so a fleet where nothing has been written while
  something is plainly working is the writer stopped — an uninstalled wrapper, an unwritable
  snapshot directory — where an idle fleet past the threshold is just the night. One fresh
  reading anywhere ends it, and so does a fleet with nobody busy, and so does a reading the
  filesystem dates in the future: its age cannot be computed, and a file that may have been
  written a second ago is not evidence that nothing was. **The dating is unchanged,
  and is what carries this now**: the thin amber arc, the `! 3h ago` beside the value, the `!`
  in the AS OF column — every reading still says its own age, one by one, which is the surface
  the banner was talking over. The threshold that put those marks there is named in the
  footnote, because a `!` you cannot argue with is worse than no `!` — and it stands down on
  the one screen where the banner already names it, rather than following the alarm with its
  own excuse. Both views point at the footnote with `aria-describedby`, so a reader going
  through the markup is not left meeting `! 3h ago` on every row before anything says what
  threshold put it there. The shape-check keeps
  every word it had, at a footnote's weight, under the fleet rather than over it. Amber is
  left to what needs the reader: a refresh that is failing, a schema that moved, a column that
  is hiding something. `tarmac list` is untouched — a one-shot dump has no top of the page to
  occupy, and its `!` line is the legend for the marks in the column. (#53)

- **The README shows the thing.** Three badges and then prose: the map, the scrubber and the
  gauges could not be seen without installing, which is the wrong bet for a tool whose whole
  output is a screen. Under the badges is a GIF of the map replaying a day — the handle
  dragged from one end of the record to the other, sessions coming and going, the five-hour
  window filling and rolling over — and the map section carries a screenshot with all four
  session states in it. Both follow the reader's colour scheme — the operating system's, which
  is not always the one their GitHub theme is set to — so a browser only ever fetches one of
  each. The quickstart moved above the long prose, the sections are ordered so the depth
  is below the first screen, and nothing was cut. Every capture is taken of an invented fleet
  (`scripts/demo-fleet.ts`) served through the real collector and the real renderer, because
  a screenshot of a real machine carries working directories, prompts and costs. (#52)

- **The README is the tour again, and the manual holds the depth.** #52 put the captures, the
  order and the anchors in place and cut nothing, so the sections were as long as they had
  always been: a page that had to be read to the end to be trusted, and was not being read to
  the end. The depth has moved rather than gone — the dashboard's front door, the install
  contract past the first confirmation, the command and option table, the map's per-node rules,
  the scrubber, the rate-limit gauges, the CI matrix and the Node versions are all in
  `docs/MANUAL.md`, each under a section that already existed or, for the three the manual did
  not have (`serve`'s listener, the commands, developing), under one that now does. What stays
  on the README is what a reader decides on: the pitch, the quickstart, the two surfaces tarmac
  reads and how each one degrades, the map with its two captures, the install ritual, the three
  settings, and "what it deliberately does not do" untouched. Every link points at the section
  that took the prose. 1714 words of README prose down to 997, no fact dropped on the way.
  (#59)

- **The README stops promising no history at all.** The ring (#35) and the scrubber (#36)
  shipped, and a running `serve` has held the day it has seen ever since. The bullet under
  "What it deliberately does not do" was half true — `tarmac list` is still a snapshot — and
  it now names the boundary that is actually kept: nothing on disk, and nothing outliving the
  serve that read it. (#48)

## [0.4.0] — 2026-08-17

### Added

- **The session that is blocked on you, drawn as such.** `claude agents --json` reports
  `status: "waiting"` with a `waitingFor` naming the answer it is halted on — a permission
  prompt, an input, a sandbox or worker request, an open dialog. Tarmac collapsed all of it
  into the amber "a word tarmac does not know", beside a banner saying so, over a fleet where
  nothing was wrong with the tool and something was wanted from the reader. It is a state of
  its own now: a fourth glyph and hue on the map, with the reason captioned under the session
  name; the reason beside the word in both tables, where `list` no longer prefixes it with the
  `?` that means "unrecognised"; and the field kept in the ring, so a replayed minute still
  says what that minute was blocked on. The boolean underneath is unchanged and deliberately
  so — "is this session working" has no honest answer here, and `false` would read as calm on
  the one session that needs you. The signal is as good as the surface and no better: a
  session that asked its question in prose still reports `idle`, and inferring more would mean
  reading a transcript. (#44)

- **The account's two rate-limit windows, drawn at the top of the page.** The five-hour and
  seven-day allowances the statusline payload has been carrying all along — used percentage, and
  the reset spelled as the time left rather than as an epoch. They are page-level because that is
  what a rate limit is: one account, which every session below is spending from. The number is
  authoritative and the bar is a glance, the same bargain the context column makes. The countdown
  is recomputed from the moment the fleet was read, so the polled fragment keeps it counting down;
  a reset already behind the reading that reported it says `reset was due 20m ago` rather than a
  countdown with a minus sign, because the percentage beside it belongs to a window that has since
  rolled over. Sessions can disagree about the account — they carry the same number at different
  ages — and the freshest reading wins, the fleet model's own rule, with a snapshot dated after
  the clock that read it refused rather than believed. Past the freshness threshold the pair is
  dated `! 40m ago`, once for the two: the percentage is as old as its snapshot while the
  countdown moves every poll, and undated the two would read as one moment. Nothing measured is
  never a zero — no snapshot carrying limits at all, and a window whose percentage is present and
  null, both read `— no reading` on a dotted rail; a window that is gone, or holding something
  that is not a percentage, reads `— schema drift`; and a reset further from the reading than the
  longest window can be (the same field in milliseconds, or the `0` an unset field so often is) is
  refused rather than rendered as `resets in 19656250d`. The gauges live in the shell so a poll
  cannot move them, and their numbers ride up out of the fragment on every swap so they are never
  as old as the tab. On replay they come down and sit with the fleet they belong to, under the
  banner that dates it, counted from the sample's own minute — which is what makes the five-hour
  window watchable, draining and refilling across a day. (#37)

- **A scrubber under the map that replays the day the serve has seen.** Drag it and the dials
  render the fleet as it was at that minute; a play button walks the readings, one every 100ms
  — one a second for a reader who asked their system for less motion — and stops at the end
  rather than looping. The record comes from `GET /api/history`, fetched on load and again
  when a tab that has been away comes back, so a drag is a lookup in samples the page already
  holds and not a request, let alone a `claude agents --json`, per position. Only the map view
  asks for it: the table has no scrubber, and a full ring is megabytes. A replay is never allowed to pass for the present: a sticky
  banner names the minute it is showing and carries one button back to live, the live fragment
  — map, totals, timestamp and warnings, all of them about now — is hidden while the past is
  up, **halos stay off** because a sample never "just landed", and a session absent from a
  minute is absent from the map rather than a dial at zero. Agents replay as the ring holds
  them: kind and numbers, no name. The live poll keeps running underneath, so returning to the
  present is instant and a page left on replay does not rot; a tab that has been away picks up
  the minutes it missed, though never under a reader who has taken hold of the handle, and a
  refresh that fails leaves the record the page already had. The banner carries `role="status"`
  and the minute travels with the handle as its `aria-valuetext`, because a yellow box is
  nothing to a reader who cannot see it. The range says what it really covers — a serve ten
  minutes old offers ten minutes, and a record whose every reading failed says so instead of
  reading like a serve that has just started — along with how many minutes have no reading.
  Because the ring keeps each reading and never how old that reading was, a replayed arc gets
  a weight of its own rather than the solid one of a fresh reading or the amber one of a stale
  reading, and the line under the scrubber says why.
  All of it lives in the page shell rather than in the polled fragment, which is what keeps a
  refresh from dragging the reader back to the present every five seconds. With JavaScript off
  there is no scrubber at all. (#36)

- **A day of what `serve` already read, on `GET /api/history`.** The dashboard read the whole
  fleet on every request and forgot it on the next one; it now also reads it on a timer of its
  own — one sample a minute into a ring of 1440 slots, after which the oldest minute falls off
  — and hands that ring back as `{ since, cadence, samples, missed }`. Per session and per
  minute: `sid`, `project`, `kind`, `state`, `ctxState`, `ctxPct`, `costUsd`, with the
  account's rate limits beside them as the payload carries them. In memory and nowhere else,
  by design: a fleet journal on disk would outlive the process that wrote it and is the one
  file this tool promised never to write, so the record starts when the serve starts and
  `since` says so out loud — and once the ring has begun dropping minutes, `since` moves with
  it rather than going on naming an hour the record no longer holds. **No name enters the
  ring, for any kind of session** — a background
  session is named after its prompt, which the live surfaces may show and a retained day of
  readings may not, and a test pins it. A reading that failed, or one still running when the
  next tick came, is a counted slot in `missed` rather than a dead timer, a second `claude`
  process or a dead serve; the route itself never collects, so asking about the past cannot
  spawn anything in the present. One minute and 24 hours are the product: no flag, no
  environment variable, no config key. (#35)

## [0.3.0] — 2026-08-16

### Added

- **A map view of the fleet, on `GET /map`.** One node per session — the arc is its context,
  the arc's weight is how much that reading may be believed, the shape by the name is its
  state, and a single halo says a measured reading for it landed moments ago — a percentage
  nobody took gets a dotted, empty dial and no halo at all, however new the file it came in. It is a view over the
  fleet model the table already renders and opens no second source: `claude agents --json`
  for the sessions, the statusline snapshots for the readings, the snapshots' own timing for
  the pulse. The state and the reading stay two different clocks — a busy session with a
  two-hour-old snapshot is drawn as both live and stale, never as one or the other — and a
  reading the freshness threshold calls stale never pulses, even with `--stale-after` set
  below the pulse window. Background agents (`kind` on the discovery payload, carried but
  never interpreted until now) are placed *beside* the session sharing their working
  directory rather than nested inside it: nesting would make this page show a smaller fleet
  than the table beside it, and an edge would claim a parentage `claude agents --json` does
  not publish. `interactive` is the only kind any captured payload contains, so a fleet in
  which nothing calls itself that is read as a renamed kind rather than as a machine gone
  entirely background — and every node prints whatever it does call itself. Both views are
  rendered into the same `/live` fragment and the tabs are plain links, so they cannot show
  readings of different ages, the view survives a reload, and the page still needs no
  client-side rules. No history and no scrubber. (#5)
- `kind` now travels on every fleet row, so it is also a new field on `GET /api/fleet` and on
  `list --json`. Carried verbatim from `claude agents --json`, never interpreted outside the
  map. (#5)

### Fixed

- **A background agent's state is read.** `claude agents --json` prints those sessions with
  none of the keys an interactive one carries: no `pid`, no `status` — their word is under
  `state`. Reading only `status` made every background agent on the page an amber "unknown"
  and raised `N session(s) report a status tarmac does not know` on a fleet where nothing was
  wrong. `status` still wins wherever both are present. `working` and `done` join the two words
  the mapping already knew; `failed`, `stopped`, `blocked` and `waiting` deliberately do not,
  because "not working" is the least interesting true thing about a failed agent and reads as
  calm on one that is waiting for you — unknown is the bucket whose node prints the word
  itself, so those keep it. A word tarmac has never seen is still `null`, never "idle". (#5)
- `! 0m ago` on both surfaces. A `--stale-after` under a minute — legal, and the example the
  map's own pulse window is documented against — dated a thirty-second reading with the "!"
  that means past the threshold and the "0m" that means brand new, in the same breath. Under
  a minute the age now reads `<1m` rather than rounding itself into a contradiction.
- **The uninstall plan looks at the prune marker before promising to remove it.** It printed
  "tarmac's prune marker is removed" without ever asking what was at that path — so it said it
  to everyone whose install had **no marker at all** (nothing stamps one until the first frame
  that sweeps — a frame away in ordinary use, but never on a machine that installs and draws no
  status line, and never again once a snapshots directory is emptied by hand), and to anyone
  whose marker was a symlink or a directory, which `removePruneMarker` refuses by design because
  `unlink` takes a link and not its target. Same class as issue #15, one branch over: the plan now carries what
  is really on disk (`marker: 'file' | 'not-a-file' | 'none' | null`, read with the same
  `lstat().isFile()` question the removal asks) and says which of the four it is. Three of them
  are "it stays", each for its own reason. The deed is unchanged. (issue #23)
- **The sweep's own deletions no longer count as unreadable snapshots.** A snapshot file listed
  by `readdir` and gone by the time it was read landed in `snapshotsUnreadable`, and `list` and
  `serve` printed "schema may have moved, check for a newer tarmac" — tarmac driving its own
  format-drift warning off its own housekeeping. Measured at up to **2675** phantom unreadable on
  one read of a 20 000-file directory, and `list --watch` and `serve` redraw often enough to be
  inside that window every hour. An `ENOENT` there is now skipped in silence; a file that is
  corrupt, half-written or truly unreadable still counts, as it must. (issue #17)
- **The hourly sweep no longer happens inside a frame.** Amortization made the sweep cheap on
  average, and the average was never the problem: the ONE frame that swept paid for the whole
  backlog at once. On an install that had never pruned — 20 000 snapshots, half of them dead —
  that frame measured **0.6-0.9 s**, a directory walk plus ten thousand unlinks in front of the
  status line. It rendered, and it exited 0, so nothing in the suite could see it: every test
  asked what the sweep *did*, none asked what the frame *cost*. The frame now dates the marker
  and hands the walk to a detached child: **16.7 ms** on the same stock, with the ordinary frames
  around it unchanged at ~11 ms, and the backlog gone a moment later. (Figures from
  `test/sweep-perf.test.ts`, which prints its own on whatever machine runs it.) Bounding the work per
  sweep was the alternative and it only spreads the same cost — one capped batch an hour, over
  weeks of frames that each still stop to walk the directory. Nothing on the nominal path (a
  frame with no sweep due) changed at all: it is still one `find` on one marker file. Two
  things follow, and both are stated in the manual: a `ps` during that first sweep shows a
  stray `find` that belongs to tarmac, and snapshots disappear shortly *after* the frame
  rather than by the time the line is drawn — which also means a chained status line reading
  the same directory now runs beside the sweep rather than after it, and can see a cold
  snapshot vanish mid-frame. (#8)
- **The uninstall plan no longer promises a removal it cannot make.** With the wrapper
  hand-deleted and a usable `backup.json` left behind — a state `uninstall` still works
  through — nothing says where the snapshots are, so nothing there is opened or removed. The
  plan filled that gap with the directory it *would* have computed and printed "tarmac's prune
  marker is removed" beside it: a promise about a path nobody had established. The unknown now
  travels in the plan (`snapshots: string | null`, the same `null` `uninstall` acts on) and the
  plan says `unknown` instead of guessing. No destructive consequence either way — the failure
  was a promise, not a deletion. (issue #15)
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
