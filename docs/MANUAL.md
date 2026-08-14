# tarmac — the manual

The [README](../README.md) is the tour; this is the reference. Everything below is held
up by the test suite — none of it is aspiration.

## Degradation, state by state

The real defence is not immunity, it is **visible degradation**. When a field moves,
tarmac says the field moved. It never turns a measurement it could not take into a
confident `0`.

| What tarmac sees | What it shows |
|---|---|
| a percentage | the percentage |
| the key is there but null | `— no turn yet` (a session that has not taken a turn) |
| the key is gone or retyped | `— schema drift`, and a warning if it happened to every session |
| no snapshot for a live session | `— not chained` |
| a reading older than the threshold | the value, **dated** — a stale number is still true, of an earlier moment |
| a status string it does not know | that string, never "idle" |
| a snapshot directory it could not read | the errno, not "run tarmac install" |
| a cost key that is absent | `—` for the row, and a total qualified by how many sessions really report one |
| a Claude Code version no fixture covers | a notice naming that version — nothing blocked, nothing hidden |

That last line is the smoke detector to the rest's alarm. The fields above were *observed*
on the Claude Code builds frozen in `fixtures/`; when a session shows up on a build nobody
has captured, tarmac says so **before** anything breaks, and keeps reporting. It reads the
version off the payload itself, so it tells you about builds actually writing to your fleet
— not about the `claude` on your PATH.

## Installing safely — the full contract

`install` and `uninstall` change a file your terminal reads on every frame, so neither runs
on your say-so alone. Both print the plan first — the settings file, what `statusLine` says
now, what it will say, the command that is being wrapped, where the payloads will land, and
the exact command that undoes it — and then wait for you to **type the verb**:

```
tarmac install — your home

  file             /Users/you/.claude/settings.json
  statusLine now   ~/bin/my-line.sh
  statusLine next  /Users/you/.claude/tarmac/statusline.sh
  ↳ which calls    ~/bin/my-line.sh   (your display is unchanged)
  snapshots        /Users/you/.local/state/tarmac/snapshots
  undo             tarmac uninstall
```

Upgrading from a version that kept the snapshots inside `.claude` adds two more lines — the
payloads being cleared out of it, and, if that directory is version-controlled, the
`.gitignore` line worth adding.

`y` is not an answer, and neither is silence: with stdin not a terminal — a pipe, a CI job —
tarmac refuses rather than read consent from an unanswerable prompt. Scripts pass `--yes`,
deliberately and in writing.

`--home DIR` points either command at another home; it selects a target, nothing more.
**Pass the same `--home` to `list` and `serve`**, which default to yours: installing into
`DIR` and then running a bare `list` reads a directory nothing was ever written to, and
reports `statusline chained on 0/1 sessions` — a true statement about the wrong directory.

`install` does not replace your status line, it **wraps** it: the wrapper drops the payload
in the state directory (`$XDG_STATE_HOME/tarmac/snapshots/`, or `DIR/.local/state/tarmac/snapshots/`
when that variable is unset) and then calls whatever command was already configured, so your
display is byte-identical. Only two files land under `DIR/.claude/`, and neither one changes
at runtime: the wrapper itself and the `backup.json` that undoes it. `uninstall` restores the original `settings.json` verbatim
when you have not edited it since, and surgically (statusLine key only) when you have. If
someone else has taken over the status line in the meantime, tarmac leaves it alone and
tells you it restored nothing.

tarmac deletes two things, and both of them are its own. At `serve` start it removes temp
files an interrupted wrapper left behind — over an hour old, and **signed**, meaning named
`.tarmac-<session>.<pid>.tmp`, a name nothing but tarmac writes. It will not touch a file
merely *shaped* like one of ours, because `.<name>.<pid>.tmp` is the temp-file convention of
half the world.

And the wrapper prunes the snapshots of sessions that stopped rendering. A live session
rewrites its own snapshot on **every frame**, so a `<session>.json` nothing has rewritten in
48h belongs to a session that is gone — and without this, a fleet that recycles its sessions
every night grows one dead file per session per night, forever. The sweep is amortized,
because it sits in the render path of your status line: a frame costs one `find` on a single
marker file (`.tarmac-last-prune`), and the directory itself is swept at most once an hour.

It deletes by the same rule as the temp files: **only what it wrote** — and that is one rule,
not two. A session id is the UUID Claude Code emits, 8-4-4-4-12 hexadecimal; the wrapper
refuses to file a payload whose `session_id` is anything else, and the sweep unlinks exactly
that shape at the top level of the snapshots directory `install` made for it, and nothing
else: not a subdirectory, not a directory or symlink wearing that name, not a dotfile wearing
it either, and not your `settings.json` or `fleet.json` sitting next to it. (`--snapshots-dir`
is a *reader's* lens for `list` and `serve` — pointing those at a directory another statusline
owns deletes nothing, because no reader deletes anything.)

A session whose id is not a UUID therefore gets no snapshot at all, and `list` shows it with
no reading rather than with a stale one. That is the deliberate half of the trade: the
alternative is a sweep whose reach is every filename of eight characters or more.

One consequence worth knowing: a session that is alive but has drawn no status line for 48h
loses its snapshot too, and `list` then shows it as a session with no reading rather than a
stale one. The next frame it draws puts the file back.

Your snapshot files survive `uninstall`; they are your data. Tarmac removes only
`.tarmac-last-prune`, the housekeeping marker that has no owner once the pruning wrapper
leaves with it. If the current `statusLine` is foreign, uninstall leaves both the wrapper and
its marker in place so that command never points at a missing file.

### Where the snapshots live, and why not in `.claude`

`$XDG_STATE_HOME/tarmac/snapshots/` when that variable is set to an absolute path, and
`<home>/.local/state/tarmac/snapshots/` otherwise — the XDG default for "state data that
should persist between restarts but is not important enough for the data directory". That is
what a snapshot is: a reading of one frame, rewritten by the next.

They used to live in `<home>/.claude/tarmac/snapshots/`, and that was a mistake. `.claude` is
commonly a git repository — dotfiles, config sync — and a file rewritten at every frame of
every session diffs forever (#20). So:

- **The reader follows the writer.** With nothing configured, `list` and `serve` take the
  path out of the installed wrapper itself rather than recomputing it — otherwise an
  `XDG_STATE_HOME` set in your shell and absent from a LaunchAgent (or a systemd user unit,
  or cron) would have the wrapper filing into one directory while the reader watched another,
  reporting a healthy, empty fleet. With no install to ask, the default is computed.
- **The variable is honoured only for the home that exported it.** `--home` exists to work on
  someone else's `.claude`, and your `XDG_STATE_HOME` says nothing about theirs; with
  `--home` pointing elsewhere, the default under *that* home is used. A relative value is
  ignored, as the spec asks.
- **Only an install that can show it was here clears anything.** The old directory is a
  documented path, and "ours" is a shape — a UUID name, a `.tarmac-` prefix. A first install
  on a home tarmac has never touched leaves it entirely alone; what licenses the purge is the
  statusLine already pointing at us, our marker in the wrapper, or a usable backup.
- **`install` clears the old directory** — the payloads, the temp files and the prune
  marker — and removes it. Nothing is copied across: every live session writes a fresh
  snapshot within seconds, and moving them would carry the very files in question into the
  new directory. A file tarmac did not write is never touched, and one is enough for the
  directory to stay. The plan says how many, and where, before you confirm.
- **If `.claude` is a git repository, the plan says so**, and names the `.gitignore` line
  worth adding.

If you read the snapshots with something other than tarmac, this is a **breaking change of
path**: `tarmac list --json` reports the effective directory as `health.snapshotsDir`, and
`tarmac serve` prints it on startup.

## Staying open

Both live views owe you the same two facts, and neither is allowed to be quiet about them:
**when the last good reading arrived**, and **whether the last attempt to refresh failed**.

The page asks the server for `/live` every 5 seconds and swaps it in; the header carries an
age that keeps climbing whether or not the refresh works, so numbers that have stopped moving
cannot pass for live ones. When a poll fails, a banner names the reason and the table is
framed off — the data stays, because it is still true of an earlier moment. `list --watch`
does the same thing in the terminal, and prints `! refresh failing — <reason>` above a table
it refuses to throw away.

Three failures are handled by name, because each of them can otherwise look like health:

- **A refusal** (`serve` is gone) — the banner names it on the next poll.
- **An empty answer.** A 200 carrying nothing is not a fleet of nothing. Swapping it in would
  blank the table and stamp it "updated 0s ago" with the dot still green, which is this tool's
  own failure mode wearing its own colours. It counts as a failed refresh.
- **No answer at all.** `fetch` has no timeout in any browser, so a server that accepts the
  connection and goes quiet would leave the request pending forever. After 20 seconds — above
  the collector's own 15s timeout, so a slow-but-healthy fleet always fails server-side first
  with a real reason — the page gives up on it, says so, and asks again. An answer to a
  request it already gave up on is discarded rather than allowed to overwrite a newer one.

On a terminal `--watch` redraws once a second while it waits, so the age is never more than a
second out of date and a hung read shows a counter that has visibly stopped. Piped, it writes
one frame per read — there is no screen to keep current, and a frame a second is just noise.

It is a poll and not a meta refresh or SSE, deliberately. A meta refresh cannot render its
own failure: when `serve` dies the browser throws the page away and shows its own error page,
taking the one useful fact with it. SSE would hold a socket per tab and drive
`claude agents --json` from a server-side timer for readers whose laptop is asleep — with a
poll, a hidden tab simply stops asking, and a waking one asks at once.

Everything a reader interprets is rendered on the server. The browser owns two facts and no
rules: re-deriving "a dash, never a zero" in page JavaScript would put a second copy of it
where the test suite cannot reach.

## Configuration

Three of tarmac's numbers are opinions, not truths, so all three are yours to set. Nothing
else is configurable, and every one of them keeps working with no configuration at all.

| Setting | What it decides | Default |
|---|---|---|
| freshness threshold | how old a reading may be before it is marked `!` | `10m` |
| port | where `serve` listens | `4477` |
| snapshots directory | where `list` and `serve` **read** payloads from | `$XDG_STATE_HOME/tarmac/snapshots`, else `<home>/.local/state/tarmac/snapshots` |

**Flag beats environment beats config file beats default**, settled per setting — a port
pinned in the file and a threshold tightened for one run is the normal case.

| Setting | Flag | Environment | `~/.claude/tarmac/config.json` |
|---|---|---|---|
| freshness | `--stale-after 90s` \| `15m` \| `2h` | `TARMAC_STALE_AFTER` (same spelling) | `"staleAfterMs": 90000` |
| port | `--port 8080` | `TARMAC_PORT` | `"port": 8080` |
| snapshots | `--snapshots-dir DIR` | `TARMAC_SNAPSHOTS_DIR` | `"snapshotsDir": "DIR"` |

```json
{ "staleAfterMs": 900000, "port": 8080 }
```

`tarmac serve` opens by printing each effective value **and which of the four sources it
came from**, and the freshness threshold is named in every warning that puts a `!` on a
reading — a mark whose threshold is invisible is one you cannot argue with.

**The default port gets out of the way; a port you named does not.** Nobody chose `4477`,
so a `4477` that is taken — the dashboard you left running this morning — is not a reason
to fail: `serve` walks up to the next free port, up to ten of them, and its first line says
where it landed.

```
tarmac serving http://127.0.0.1:4478 — port 4477 was in use
```

A port named on the command line, in the environment or in `config.json` is a decision, and
`serve` will not quietly honour it somewhere else — it refuses, and names the flag that
moves it.

Nothing here is ever silently dropped. A duration that will not parse, a port out of range,
a key that does not exist, a file that is not JSON, a file that exists but cannot be read —
each one stops the run and says what it got, where it came from, and what would have worked.
**Including the ones that lose**: a broken `TARMAC_STALE_AFTER` is refused even when a flag
was going to beat it, so a stale variable in a shell profile cannot lurk until the day you
drop the flag.

```
$ TARMAC_STALE_AFTER=soon tarmac list
tarmac: TARMAC_STALE_AFTER must be a positive duration like 90s, 15m or 2h, got: soon
```

A bare number is refused on purpose: `600000` is ten minutes in milliseconds and a week in
seconds, and picking one for you is exactly the silent correction the rest of this tool
refuses. An empty environment variable (`TARMAC_PORT= tarmac serve`) means unset, not empty.

Two edges worth knowing:

- **No config file is not an error** — it is the zero-config contract. `install` and
  `uninstall` never read the file at all, so a typo in it can never be what stands between
  you and putting your status line back.
- The snapshots directory is a **read-side** setting, exactly like the flag it mirrors.
  The wrapper writes where `install` put it — the state directory, which both plans print and
  `serve` prints on startup, and which the readers take from the wrapper when nothing else
  says otherwise. Point the reader at a directory that does not exist and tarmac says so,
  naming the path and the setting that sent it there.
  **One absence is silent, and only one**: no install here at all. The default used to be a
  path nobody had chosen and nothing had created, so "not there" meant "nothing has been
  chained yet". It is now the path an install *froze into the wrapper* — chosen, and made, by
  a run that happened — so if it is missing while a wrapper is installed, the writer and the
  reader have parted company, and you are told.

## Capturing a new Claude Code version

When tarmac reports a version it has never checked, capture the pair — both surfaces from
one build, in one command, with tarmac installed and a session of that build having drawn
at least one frame:

```bash
npm run fixtures:capture
```

It writes `fixtures/agents-<version>.json` and `fixtures/statusline-payload-<version>-*.json`
verbatim, then tells you to add the version to `CHECKED_VERSIONS` in `src/schema.ts` — the
suite fails while the constant and the directory disagree, which is what keeps the guard
from claiming a coverage nobody verified. **Read both files before committing, and scrub
them**: they come off your machine carrying real paths, session names and costs. The
fixtures in this repo are the real shapes with synthetic values, and that is the standard a
new one has to meet.
