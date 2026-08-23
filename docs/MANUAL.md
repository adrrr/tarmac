# tarmac: the manual

The [README](../README.md) is the tour. This is the reference. Everything below is held up by
the test suite, so none of it is aspiration.

## Commands and options

| Command | What it does | Options |
|---|---|---|
| `tarmac list` | one-shot fleet table, and the default, so bare `tarmac` runs it | `--home`, `--stale-after`, `--snapshots-dir`, `--claude-bin`, `--json`, `--watch` |
| `tarmac serve` | local dashboard, `GET /` for the table, `GET /map` for the map, `GET /live` for the fragment both refresh from, `GET /api/fleet` for JSON, `GET /api/history` for the last 24h of readings it took while it ran | `--home`, `--port`, `--stale-after`, `--snapshots-dir`, `--claude-bin`, `--trust-host` |
| `tarmac install` | chain the status line under `<home>/.claude/settings.json`, after confirmation | `--home`, `--yes` |
| `tarmac uninstall` | restore it, and say which of the four restore modes ran | `--home`, `--yes` |

`--help` works everywhere. An option handed to a command that does not read it is an error,
never something quietly ignored, and the error names the commands it does belong to.

## Degradation, state by state

When a field moves, tarmac says the field moved. A measurement it could not take never becomes
a confident `0`. tarmac cannot stop the payload from changing. What it can do is make the
change visible, and the table below is how.

| What tarmac sees | What it shows |
|---|---|
| a percentage | the percentage |
| the key is there but null | `— no turn yet` (a session that has not taken a turn) |
| the key is gone or retyped | `— schema drift`, and a warning if it happened to every session |
| no snapshot for a live session | `— not chained` |
| a live session whose id it will never file under | `— not chained`, and a count saying how many, never "run tarmac install" |
| a reading older than the threshold | the value, dated. A stale number is still true, of an earlier moment |
| a status string it does not know | that string, never "idle" |
| a session halted until you answer something | `waiting`, and which answer: `permission prompt`, `dialog open`, … |
| a snapshot directory it could not read | the errno, not "run tarmac install" |
| a cost key that is absent | `—` for the row, and a total qualified by how many sessions really report one |
| no snapshot carrying the account's rate limits | `— no reading` in both windows, on the page a dotted rail, never a window at 0% |
| a rate-limit reset nowhere near the reading that carried it | `reset —`. The percentage stands, the impossible countdown does not |
| snapshots naming two rate-limit windows open at once | the freshest, and how many readings describe the other one. No winner is ever picked in silence |
| a Claude Code version no fixture covers | a footnote naming that version. Nothing blocked, nothing hidden |

That last row works ahead of the others. The fields above were *observed* on the Claude Code
builds frozen in `fixtures/`. When a session shows up on a build nobody has captured, tarmac
says so before anything breaks, and keeps reporting. It reads the version off the payload
itself, so it tells you about builds actually writing to your fleet, not about the `claude` on
your PATH.

## Installing safely: the full contract

`install` and `uninstall` change a file your terminal reads on every frame, so neither runs
on your say-so alone. Both print the plan first: the settings file, what `statusLine` says
now, what it will say, the command that is being wrapped, where the payloads will land, and
the exact command that undoes it. Then they wait for you to type the verb:

```
tarmac install — your home

  file             /Users/you/.claude/settings.json
  statusLine now   ~/bin/my-line.sh
  statusLine next  /Users/you/.claude/tarmac/statusline.sh
  ↳ which calls    ~/bin/my-line.sh   (your display is unchanged)
  snapshots        /Users/you/.local/state/tarmac/snapshots
  undo             tarmac uninstall

Type "install" to proceed, anything else to abort:
```

Upgrading from a version that kept the snapshots inside `.claude` adds two more lines: the
payloads being cleared out of it, and, if that directory is version-controlled, the
`.gitignore` line worth adding.

`y` is not an answer, and neither is silence. When stdin is not a terminal, in a pipe or a CI
job, tarmac refuses rather than read consent from an unanswerable prompt. Scripts pass `--yes`,
deliberately and in writing.

`--home DIR` points either command at another home. It selects a target, nothing more. `list`
and `serve` default to yours, so pass them the same `--home`. Install into `DIR`, run a bare
`list`, and you are reading a directory nothing was ever written to: it reports
`statusline chained on 0/1 sessions`, a true statement about the wrong directory.

`install` wraps your status line, it does not replace it. The wrapper drops the payload in the
state directory (`$XDG_STATE_HOME/tarmac/snapshots/`, or `DIR/.local/state/tarmac/snapshots/`
when that variable is unset), then calls whatever command was already configured, so your
display is byte-identical. Only two files land under `DIR/.claude/`, and neither one changes at
runtime: the wrapper itself and the `backup.json` that undoes it.

`uninstall` restores the original `settings.json` verbatim when you have not edited it since,
and surgically (statusLine key only) when you have. If someone else has taken over the status
line in the meantime, tarmac leaves it alone and tells you it restored nothing. It names which
of its four restore modes ran. `bytes`, the usual one, puts the original file back exactly.

The write re-serialises `settings.json`, so a version-controlled one shows a formatting diff,
not a one-line diff.

tarmac deletes two things, and both of them are its own. At `serve` start it removes temp files
an interrupted wrapper left behind. They have to be over an hour old and signed, meaning named
`.tarmac-<session>.<pid>.tmp`, a name nothing but tarmac writes. A file merely *shaped* like one
of ours is left alone, because `.<name>.<pid>.tmp` is the temp-file convention of half the
world.

The wrapper also prunes the snapshots of sessions that stopped rendering. A live session
rewrites its own snapshot on every frame, so a `<session>.json` nothing has rewritten in 48h
belongs to a session that is gone. Without this, a fleet that recycles its sessions every night
grows one dead file per session per night, forever. The sweep is amortized, because it sits in
the render path of your status line. A frame costs one `find` on a single marker file
(`.tarmac-last-prune`), and the directory itself is swept at most once an hour.

That hourly sweep runs beside the frame, not inside it. The frame starts it, dates the marker
and goes straight on to your status line. The walk and the unlinks happen in a detached child
that nothing waits for. So on an install that has never pruned, with months of dead snapshots
to get through, the frame that triggers the first sweep still costs about what every other
frame costs, and the backlog disappears a moment later.

Three consequences worth knowing.

A `ps` during that first sweep shows a stray `find` that belongs to tarmac, and it is genuinely
on its own. Closing Claude Code does not take it with it, and neither does a Ctrl-C, because
the shell has an asynchronous command ignore that. It ends when it is done, which is seconds,
or with a signal sent to the process group. Whatever it had not reached waits for the next
sweep.

The files it removes are gone shortly *after* the frame, not by the time the line is drawn.

And if you chained a status line of your own that reads the same directory, it now runs beside
that sweep rather than after it, so it can see a snapshot older than 48h disappear mid-read.

The sweep deletes by the same rule as the temp files: only what tarmac wrote. That is one rule,
not two. A session id is the UUID Claude Code emits, 8-4-4-4-12 hexadecimal. The wrapper
refuses to file a payload whose `session_id` is anything else, and the sweep unlinks exactly
that shape, at the top level of the snapshots directory `install` made for it. Nothing else
goes: not a subdirectory, not a directory or symlink wearing that name, not a dotfile wearing
it either, and not your `settings.json` or `fleet.json` sitting next to it.

`--snapshots-dir` is a *reader's* lens for `list` and `serve`. Point those at a directory
another statusline owns and nothing is deleted, because no reader deletes anything.

So a session whose id is not a UUID gets no snapshot at all. `list` shows it as a live session
with no reading, in those words, rather than telling you to run `tarmac install`. For that
session the install is already right, the frame is already drawn, and the wrapper is declining
on purpose. That is the deliberate half of the trade. The alternative is a sweep whose reach is
every filename of eight characters or more.

Two loose ends, if you ran a version before this one. A snapshot already on disk under a
non-UUID name is still *read*, because the reader takes any `*.json` and keys on the
`session_id` inside it, but no sweep will ever remove it. And a temp file left by an interrupted
frame of the older wrapper, `.tarmac-<non-UUID sid>.<pid>.tmp`, is no longer collected at all.
The reaper now matches only names the current writer can produce, so that is coverage *lost*
over the existing stock, not merely a sweep that skips it. Neither is worth a migration: the
shape has never been observed, and these are files of installs that were never published. Both
are yours to delete by hand. Nothing will write another of either.

One more consequence. A session that is alive but has drawn no status line for 48h loses its
snapshot too, and `list` then shows it as a session with no reading rather than a stale one.
The next frame it draws puts the file back.

Your snapshot files survive `uninstall`. They are your data. tarmac removes only
`.tarmac-last-prune`, the housekeeping marker that has no owner once the pruning wrapper leaves
with it. If the current `statusLine` is foreign, uninstall leaves both the wrapper and its
marker in place, so that command never points at a missing file.

Sometimes nothing says where that directory is. The wrapper was deleted by hand, or it is still
there but no longer carries the path, with `backup.json` left behind for uninstall to work
through. Then uninstall opens no snapshots directory at all, and the plan prints
`snapshots  unknown` rather than a path it would only have guessed at.

Two more states leave the marker where it is, and the plan names which one it is looking at
rather than promising a removal in either. There may be no marker to remove: nothing stamps one
until the first frame that sweeps, so a home whose status line has never drawn has none at all.
Or what wears that name may not be a regular file. A symlink or a directory there is left alone,
because `unlink` would take the link and not what it points at.

### Where the snapshots live, and why not in `.claude`

`$XDG_STATE_HOME/tarmac/snapshots/` when that variable is set to an absolute path,
`<home>/.local/state/tarmac/snapshots/` otherwise. That is the XDG default for "state data that
should persist between restarts but is not important enough for the data directory", which is
what a snapshot is: a reading of one frame, rewritten by the next.

They used to live in `<home>/.claude/tarmac/snapshots/`, and that was a mistake. `.claude` is
commonly a git repository, for dotfiles or config sync, and a file rewritten at every frame of
every session diffs forever (#20). The rules that came out of the move:

- **The reader follows the writer.** With nothing configured, `list` and `serve` take the
  path out of the installed wrapper itself rather than recomputing it. Otherwise an
  `XDG_STATE_HOME` set in your shell and absent from a LaunchAgent (or a systemd user unit,
  or cron) would have the wrapper filing into one directory while the reader watched another,
  reporting a healthy, empty fleet. With no install to ask, the default is computed.
- **The variable is honoured only for the home that exported it.** `--home` exists to work on
  someone else's `.claude`, and your `XDG_STATE_HOME` says nothing about theirs. With
  `--home` pointing elsewhere, the default under *that* home is used. A relative value is
  ignored, as the spec asks.
- **Only an install that can show it was here clears anything.** The old directory is a
  documented path, and "ours" is a shape: a UUID name, a `.tarmac-` prefix. A first install
  on a home tarmac has never touched leaves it entirely alone. What licenses the purge is the
  statusLine already pointing at us, our marker in the wrapper, or a usable backup.
- **`install` clears the old directory.** The payloads, the temp files and the prune marker
  go, and the directory with them. Nothing is copied across: every live session writes a fresh
  snapshot within seconds, and moving them would carry the very files in question into the
  new directory. A file tarmac did not write is never touched, and one is enough for the
  directory to stay. The plan says how many, and where, before you confirm.
- **If `.claude` is a git repository, the plan says so**, and names the `.gitignore` line
  worth adding.

If you read the snapshots with something other than tarmac, this is a breaking change of path.
`tarmac list --json` reports the effective directory as `health.snapshotsDir`, and
`tarmac serve` prints it on startup.

`health.unfilable` is the other field worth reading from that JSON. It counts the live sessions
whose id is not the UUID the wrapper files under. They sit among the ones reporting no context
and never among the covered, because a snapshot an older wrapper filed under a non-UUID name is
still read. The field separates "no frame drawn yet", which `tarmac install` and one frame fix,
from "no frame will ever produce one", which nothing fixes. Both renderers say which of the two
they are looking at rather than defaulting to install advice.

## What `serve` listens on

`serve` prints the settings it resolved, then the URL it got:

```
tarmac serving http://127.0.0.1:4477
```

It binds to loopback. It refuses any request whose `Host` is not loopback, and any request a
browser marks as coming from another origin, meaning `Sec-Fetch-Site` anything but
`same-origin` or `none`. Your cwd paths and costs never leave the machine. A client that sends
no such header, curl or a script, is left alone. Naming a host yourself is the one way past the
`Host` rule, and that is [below](#putting-it-behind-a-reverse-proxy).

A busy default port walks up to the next free one and says so. A port you chose yourself, by
flag, environment or config file, refuses instead, because you chose it (see
[configuration](#configuration)).

### Putting it behind a reverse proxy

A proxy (`tailscale serve`, caddy, nginx) forwards the `Host` the browser typed, and none of
them present a loopback one, so a dashboard reached that way met a 403 on every page and every
API call. `--trust-host` names a host to answer besides loopback, once per host:

```bash
tarmac serve --trust-host laptop.tailnet.ts.net
```

Read what that agrees to twice. It is the one setting here that widens who may read this port.
Anyone who can make a browser send that `Host`, anyone on that tailnet, anyone the proxy lets
through, reads this fleet's working directories, session ids and costs. tarmac cannot tell them
from you, and there is no second check behind this one.

So the name is matched whole, and nothing else is. No wildcard is accepted, and a name is never
read as a prefix or a suffix: `--trust-host example.ts.net` admits neither `sub.example.ts.net`
nor `example.ts.net.somewhere-else.com`.

The port is not part of the name. A proxy presents `:8443` on one setup and nothing at all on
443, and the port in a `Host` header is chosen by whoever sends it, so matching on it would
refuse half the setups this exists for and bar nobody. Case is not part of it either, though
the loopback names are left exactly as strict as they have always been, so `LOCALHOST` is still
refused where `PROXY.EXAMPLE.TS.NET` is served.

Everything else about the name counts to the character. `example.ts.net.`, with the trailing dot
a browser keeps when you type one, is a different host from `example.ts.net`, and a host you did
not name fails closed. A value that could never match a `Host` header at all, a wildcard, a URL,
an IPv6 literal, stops the run rather than sitting in the list refusing everything all day.

Everything else stands where it was. With no host named, which is the default and what every
`serve` that never asked for this still does, the refusal is the sentence it has always been.
With one named, it says which rule refused (`tarmac serves loopback and trusted hosts only`).
Neither quotes the `Host` back. And `Sec-Fetch-Site` does not move: a trusted `Host` does not
make a cross-site page same-origin.

## Staying open

Both live views owe you the same two facts, and neither is allowed to be quiet about them:
when the last good reading arrived, and whether the last attempt to refresh failed.

The page asks the server for `/live` every 5 seconds and swaps it in. The header carries an age
that keeps climbing whether or not the refresh works, so numbers that have stopped moving cannot
pass for live ones. When two polls in a row fail, a banner names the reason and the table is
framed off. The data stays, because it is still true of an earlier moment. `list --watch` does
the same thing in the terminal, and prints `! refresh failing — <reason>` above a table it
refuses to throw away.

Two in a row, not one. The page is read on a phone as often as on a laptop, and a radio drops a
request for a tunnel, a lift, a handover between cells. The next one lands five seconds later.
Framing the table off for that shouted an outage at a reader whose fleet was fine. The banner is
for a server that has gone. A single miss buys nothing but the age upstairs climbing five
seconds further, which is the truth either way.

In a row means in a row in TIME, not merely in the order polls happened to run. A hidden tab
asks for nothing, so a miss from before a phone was locked would otherwise still be sitting
there an hour later. The poll fired the moment the tab comes back is the likeliest miss of the
session, since the radio is still reassociating, and it would meet that stale miss and raise the
banner over a single dropped request. So a miss further back than a few poll intervals starts
the count again.

Three failures are handled by name, because each of them can otherwise look like health:

- **A refusal.** `serve` is gone, and the banner names it once a second poll agrees.
- **An empty answer.** A 200 carrying nothing is not a fleet of nothing. Swapping it in would
  blank the table and stamp it "updated 0s ago" with the dot still green, which is this tool's
  own failure mode wearing its own colours. It counts as a failed refresh.
- **No answer at all.** `fetch` has no timeout in any browser, so a server that accepts the
  connection and goes quiet would leave the request pending forever. After 20 seconds the page
  gives up on it and asks again. It says so at once rather than waiting for a second miss,
  because twenty seconds of silence from a live connection is not a dropped packet. A miss
  after that keeps the banner up rather than taking it back down. Twenty seconds is above the
  collector's own 15s timeout, so a slow but healthy fleet always fails server-side first, with
  a real reason. An answer to a request the page already gave up on is discarded rather than
  allowed to overwrite a newer one. The request is retired at the moment the page gives up, not
  when the next one starts, so there is no window in which a twenty-second-old body can arrive
  and be stamped "updated 0s ago".

On a terminal `--watch` redraws once a second while it waits, so the age is never more than a
second out of date and a hung read shows a counter that has visibly stopped. Piped, it writes
one frame per read. There is no screen to keep current, and a frame a second is just noise.

It is a poll, deliberately, rather than a meta refresh or SSE. A meta refresh cannot render its
own failure: when `serve` dies the browser throws the page away and shows its own error page,
taking the one useful fact with it. SSE would hold a socket per tab and drive
`claude agents --json` from a server-side timer for readers whose laptop is asleep. With a
poll, a hidden tab simply stops asking, and a waking one asks at once.

Everything a reader interprets is rendered on the server. The browser owns two facts and no
rules. Re-deriving "a dash, never a zero" in page JavaScript would put a second copy of it
where the test suite cannot reach.

## The account's two windows

Every session spends from the same two allowances, the five-hour window and the seven-day
window, as the statusline payload reports them. So they are shown once for the fleet, not once
per session. On the page they are gauges at the top, above the fleet. In the terminal they are
one line under it.

```
5h ▬▭▭▭  17%  resets in 2h 14m      7d ▬▬▭▭  42%  resets in 3d 11h
```

```
4 sessions · 2 busy · $109.35
account  5h 17% resets in 2h 14m · 7d 42% resets in 3d 11h · as of 7m
```

The five-hour window leads both of them, and its countdown is exact to the minute. It is the one
a reader can act on inside the day: "two hours left" is a decision about the next task, where a
seven-day window is one the week was already spent against. The seven-day window stands beside
it at the same weight rather than behind a flag, because it is the one that ends a week, and a
number nobody chose to look at is a number nobody sees.

The number is authoritative and the bar is a glance, the same bargain the context column makes.
The reset arrives as an epoch and is shown as what is left of the window, counted from the
moment the fleet was read. The fragment is re-rendered every five seconds, so it keeps counting
down. A window whose reset is already behind the reading that reported it says
`reset was due 20m ago` rather than a countdown with a minus sign in front of it. The percentage
beside those words belongs to a window that has since rolled over.

A reset that is not within eight days of the reading is refused the same way a percentage
outside 0-100 is. The longest window here is seven days, so nothing this account resets at is
further out, while the two ways that field can move both land far outside it. Read as seconds,
the same number in milliseconds is fifty thousand years away. And `0`, the sentinel an unset
field so often is, is 1970. Both used to render with a straight face (`resets in 19656250d`).
The percentage stands. The countdown becomes `reset —`.

The limits belong to the account, and they arrive per session, so several sessions can carry the
same number at different ages. The freshest reading that **measured** something wins. A session
that has just started is the youngest snapshot on the machine and the likeliest to carry a
window whose number has not been taken yet, and letting it win blanked an account three other
sessions were reporting. A snapshot dated *after* the clock that read it is refused rather than
believed (see [staying open](#staying-open)). Two readings of the same age are settled on the
session id rather than on the order `claude agents --json` printed them in, so the same fleet
reads the same way on two machines. Which reading was drawn is dated, but the age cannot say
whether the readings behind it were about the same windows, and one of them is picked either
way.

That is the second thing both surfaces report:

```
! the 5h window is read differently by 1 of 2 readings — the freshest is shown
```

Two rules decide it, and neither is the percentage. The first is the reset. `resets_at` is where
a window *ends*, so two readings naming the same one are one allowance seen at two moments. A
percentage that grew between two frames is the ordinary fleet, and warning about it would be a
warning on every poll. The second rule is that both windows must still be **open** at the moment
the fleet was read. A session that idles keeps the frame it last drew, and the five-hour window
rolls over four or five times a day, so an overnight snapshot names the window it was taken in,
which ended hours ago. That is one reading being old, which its own age and its `!` already say.
Without this rule any fleet with a session idle longer than the current window would carry the
warning permanently.

What survives both rules is what nothing else here can say: two windows open at the same time,
which one allowance cannot have. Whether that is two accounts signed in at once or something
stranger is published on no surface tarmac reads, so it is counted and never diagnosed. A
reading that dates no window is compared with nothing, because an absent boundary is not a
different one. The count is of readings that measured the account, so a payload carrying `{}`,
`[]` or a pair of nulls is not in the denominator. The sentence names only a window whose number
is printed: one shown as `— schema drift` has nothing for "the freshest is shown" to be true of.

What is missing is said, never guessed. No snapshot carrying rate limits at all is
`— no reading`, on the page a dotted rail, the same dotted emptiness an unmeasured dial wears.
A window present with a null percentage is the same, because the key being there means the
number has simply not been taken. A window that is gone, or holding something that is not a
percentage, is `— schema drift`. None of the three is ever a `0%`, which would be the one
sentence tarmac must not say about an account: *you have room*.

The reading is dated, like every other reading here. The percentage is exactly as old as the
snapshot it came from, while the countdown beside it is recomputed on every five-second
re-render. An undated pair would put a frozen number next to a visibly moving one and let both
read as now.

In the terminal every reading is dated, as the AS OF column dates one, with the `!` of a reading
past the freshness threshold: `as of 40m !`. Two cases have no reading and therefore no age, and
print nothing after the two windows. One is a fleet no snapshot carried rate limits for. The
other is a fleet whose only such snapshot is dated after the clock that read it, refused rather
than believed and left to the skew warning to name. Either way the missing age is what tells
those two apart from a snapshot that carried a window whose number had not been taken yet.

On the page, where a fresh reading is not dated anywhere, only a stale one is: `! 40m ago`. Once
for the two windows either way, because both come out of the same snapshot.

On replay the gauges come down from the header and sit with the fleet they belong to, under
the banner that dates it: the account of that minute, not of this one. Their reset is counted
from the sample's own clock. At 09:14 the five-hour window had two hours to run, and it had
two hours to run whatever time it is now. Counted against the present, every reset in the
record would read as long overdue the moment it aged past, and the page would announce an
account over its limit for a day that has already ended.

## The map

`serve` has a second view of the same fleet, on `/map`, reached by the tab in the header. The
tabs are links rather than script, so the view survives a reload and a bookmark. Both views
are rendered into the same fragment, out of the same reading, which is why the two can never
disagree about a session on the same screen.

One node per session, and the count matches the table's rows exactly. A session's node says
five things at once, six when it is waiting, in channels that never rely on colour alone:

| What | Where it is | What it means |
|---|---|---|
| context | the arc | how full the window is, drawn to the size of the reading |
| the reading's age | the arc's weight | solid: fresh. Thin, amber and dated `! 3h ago`: past the freshness threshold |
| no reading at all | a dotted, empty dial | nothing was measured, and the middle says which kind of nothing: `not chained`, `no turn yet`, `schema drift` |
| the session's state | the shape by the name | `●` busy or an agent working, `○` idle or an agent finished, `◐` halted until a human answers, `▲` a word tarmac does not flatten into any of those, printed as it came |
| what a waiting session waits for | a caption under the name | `permission prompt`, `input needed`, `sandbox request`, `worker request`, `dialog open`, the vocabulary the source publishes |
| a reading just landed | one halo, once | a measured reading for that session is under 10s old |

Four of those six are the dial and what it wears, and a background agent has no terminal
behind it to draw one. So an agent is not a smaller node of the same kind. It is a strip, and
it says fewer things (below).

The sort puts `waiting` first, then busy, then unknown, with idle last. The row that has
stopped until someone answers it is the one that must not be under the fold, and a fleet holds
one or two of those at a time. That is the fleet's own order, the one the table uses. The map
groups it into berths (below), each of which takes its place at its first node, so a session
halted on a human lifts the frame around it to the front of the page along with itself.

The state and the reading are two different clocks and are never merged. `busy` comes from
`claude agents --json`, read at the moment you asked; the percentage comes from a file that
session's terminal wrote whenever it last drew a frame. A busy session with a two-hour-old
reading is both live and stale, and the node says both: a solid green dot beside a thin
amber arc dated `! 2h ago`.

One session in that state, on a fleet where something else is fresh, is normal, and the node is
the only place it is said. A terminal in a window nobody has selected draws no frames while its
session works.

The dashboard raises a banner over it in exactly one case: no reading anywhere on the fleet is
fresh, and one of the cold ones belongs to a session that is busy. A statusline is written when
a terminal draws a frame, so a fleet that idles keeps yesterday's numbers. That is the resting
state, not an event, and it is what the per-node dating is for. But a fleet where nothing at all
has been written while something is demonstrably working means the writer has stopped: the
wrapper uninstalled from `settings.json`, the snapshots directory gone or unwritable, a full
disk.

Three things end the question. A single fresh reading anywhere, because something is plainly
writing. A fleet with nobody busy, because that is just the night. And a reading the filesystem
dates in the future, whose age cannot be computed at all: a file that may have been written a
second ago is not evidence that nothing was, so that one gets its own warning instead.

On a fleet of one session the two halves meet, and the banner is right to. A lone session
working against an hours-old reading is the whole machine saying nothing has been written. The
one moment it can mislead is a fleet waking from a quiet stretch, a night or a lunch break, any
gap longer than the threshold. A session is busy on the session list before its first frame
lands, so the banner can stand for a single poll until that frame arrives. There is no grace
period under it on purpose. That would be a second threshold nobody chose, and for that one poll
the newest reading on the machine really is older than the threshold you set.

"How old is the file" and "is there a number in it" are a third pair that is never merged. A
session that has taken no turn yet, and one whose payload drifted, both have a snapshot as
current as any on the machine, and neither has a percentage. They get the dotted dial, not the
solid ring of a session measured at 0%. That distinction matters twice a lifetime and both times
at once: `no turn yet` is the whole fleet for a few minutes after a restart, and `schema drift`
is the whole fleet the day Claude Code moves the payload.

The halo is the only thing that moves, and it makes one claim: a reading for that session
arrived moments ago. Three things have to be true for it. The reading is fresh, it is inside the
ten-second window, and there is a number in it.

So it never fires for a reading the freshness threshold calls stale, even when `--stale-after`
is set below that window, because the threshold is the one that judges. And it never fires for a
snapshot that carried no measurement. A drifted fleet writes a file on every frame, and a fleet
of empty dials beating steadily is the calm, wrong answer this tool exists to refuse. Under
`prefers-reduced-motion: reduce` it stops moving and stays as a faint ring: the movement goes,
the fact it carries does not. It is also written out beside the dial, so the claim is in the
markup and not only in the drawing.

**Berths: the nodes are grouped by working directory.** A frame per directory, labelled with
its project in small uppercase type, the sessions of that directory as cards inside it and the
agents docked underneath as strips, across the frame. The working directory is the only field
every kind of node carries, so it is the only thing the page can group by.

The label is the entire claim. A berth says "read in the same directory", and it never says who
dispatched whom. `claude agents --json` publishes no such field, so a berth holding two sessions
and two agents makes no claim about which of the four asked for which. No label, no position and
no line inside a frame means "parent of". The day that relation is published, it can be drawn
between nodes already sitting side by side, without a frame moving.

Two directories that end in the same folder name are two berths wearing one label. The label is
the basename, and the full path is not printed on this page any more than anywhere else. That is
also why the grouping is keyed on the directory and never on the label: two checkouts of `atlas`
answer to one word, and a frame drawn on that word would claim a directory they do not share.

A node whose working directory the source did not publish gets a berth of its own, labelled
`no directory`, because two directories nobody could read are not the same directory. So does an
agent whose directory matches no session. A frame is a claim about a directory, and that agent's
is nobody else's.

**Background agents.** An agent is a strip: a band of text, left-aligned, half the height of a
card, docked under the cards of its berth. It carries the state in the same glyph a node uses,
and again in a three-pixel accent down its left edge, then the prompt it was named after,
ellipsised to its line, and last the kind it calls itself. It does not carry the project, since
the berth around it says the directory once, for every node in it. A waiting agent captions
itself with what it waits for, like any other node.

What a strip has no room for and no source for is the dial. The arc, its weight and the halo are
all drawn from a statusline frame, and there is no terminal here to draw one. A ring on an agent
could never fill, and the middle of it said `not chained`, the words of a fault someone could go
and repair (`tarmac install`), about a session no install can cover.

The number is not refused, though. A strip prints what that session's snapshot published, and
nothing where nothing was published. The percentage, the model and the effort come out of one
file, so an agent the join found one for carries all three on a line,
`ctx 41% · Fable 5 · max`, dated `! 3h ago` when the reading is past the freshness threshold,
exactly as a card is. The percentage is labelled because a strip has neither a ring around it
nor a column header over it, and a bare `41%` under a line of prompt reads as how much of the
prompt is done. An agent with no snapshot behind it prints none of the three, and no dash
where they would have been.

Which entries those are is decided by `kind`. `interactive` is what a terminal calls itself,
and `background` is the one other value seen so far, on entries that carry no `pid` and report
their state under `state` instead of `status`. One alternative is not a vocabulary, so
`interactive` stays the anchor. A fleet in which nothing calls itself `interactive` is read as a
renamed kind rather than as a machine that has gone entirely background. That is the same
tolerance the fleet applies to telemetry, where a signal true of every row is a change in the
source. Whatever a node calls itself is printed on it when it is not `interactive`, so that
decision is never invisible.

**A background session's name is its prompt.** `claude agents --json` names those sessions
after what they were asked to do, and tarmac carries the name as it came: onto the node, into
the table's `Session` column, and verbatim into `GET /api/fleet` and `list --json`. A
screenshot of a real fleet is therefore a screenshot of what its agents were told.

A long name is ellipsised on a node to fit its column, and wrapped rather than ellipsised in the
table's phone strip, where it has a line to itself and nothing to be cut to. Both are widths,
not redactions. The whole string is still in the markup and in both JSON surfaces, and the first
half of a prompt is usually the half that gives it away. What neither does is push the page
sideways: a name with no length limit costs lines, never a horizontal scroll bar. Worth knowing
before the screen, or the payload, goes anywhere. The one surface it never reaches is the
retained record. See [what the serve remembers](#what-the-serve-remembers).

### Replaying the day

Under the map is a scrubber, with `REPLAY` written above it. It is the one place on this page
where a node is not the fleet as of the reading in the header. The word says what the pair is
and never how much of the day it holds. A serve ten minutes old has seen ten minutes, and the
sentence under the handle is what states the range.

Drag it and the dials render the fleet as the serve recorded it at that minute. The play button
walks the readings, one every 100ms, and stops at the end rather than looping. The record is
asked for when the page loads, and again when a tab that has been away comes back, never per
position, so a drag is a lookup in samples the page already holds. A scrubber that asked per
position would spawn a `claude agents --json` for every pixel of it. It is asked for on `/map`
only: the table has no scrubber, and a full ring is megabytes.

A replay is never allowed to pass for the present:

- a sticky banner names the minute on screen and carries one button back to live
- the live fragment, with its map, its totals, its timestamp and its warnings, all of them
  about now, is hidden while the past is up, so two fleets of two moments are never stacked
- **no halos.** The halo means a reading landed moments ago, which is never true of a sample
- a session absent from a sample is absent from the map, never a dial at zero
- an agent replays as its kind and its numbers. The ring holds no names, so neither does this.
  A replayed card is headed by its project where a live one, framed by a berth that already
  says the directory, is headed by its session name
- **no berths.** The ring keeps a project name and never the working directory it was read in,
  and a basename is not a directory. A frame drawn on it would group two checkouts of `atlas`
  into one, claiming the very thing a berth exists to be trusted about. So a replayed fleet is
  drawn flat, in the order the sample carries. With no directory to group on, there is no
  grouping to put a node anywhere else. The alternative was to widen the record until a frame
  could be earned. It already shows less than the live view does, on purpose, and one more
  field in every one of 1440 samples buys one border
- the poll goes on underneath, so returning to now is instant and a page left on replay does
  not rot
- the banner carries `role="status"` and the minute travels with the handle as its
  `aria-valuetext`, because a yellow box is nothing at all to a reader who cannot see it

The range says what it really covers. A serve ten minutes old offers ten minutes, and a record
whose every reading failed says *that* rather than reading like a serve which has just started.
The handle steps through readings, not minutes, so the line under it also names how many
minutes have none.

One thing it deliberately does not do is date the readings it draws. The ring keeps each
reading, never how old that reading was, so a replayed arc can be neither the solid one of a
fresh reading nor the thin amber one of a stale reading. It gets a third weight of its own: full
colour, a shade lighter, `data-reading="undatable"` in the markup. The line under the scrubber
says why.

A record that is refreshed under a reader who has taken hold of it is not swapped: the answer
re-asks whether anyone is scrubbing at the moment it lands, and a refresh that fails leaves the
record the page already had rather than taking the scrubber away.

With JavaScript off there is no scrubber at all, which is the honest version of a control
nothing can drive. Under `prefers-reduced-motion: reduce` play still plays, one reading a
second instead of ten.

What the *serve* remembers, and hands the scrubber, is below.

### On a phone

The dashboard is read on a phone as often as on a laptop, and three things change under about
46rem.

The table stops being a stack of labelled lines and becomes a two-line strip per session: who
and in what state, then `ctx 65% · Opus 5 · medium · $20.79 · up 15h`. That second line is the
one the map has always printed under a docked agent, and it is the whole reason the fold is
affordable. The labels that go are the ones whose values wear their own name, a `$`, a `%`, a
model, a state that is a word. Nothing is dropped and nothing moves: the columns appear in the
order the table emits them, and every `data-label` a desktop reads is still on the cell. A
session costs 63px of phone instead of 234, so eight of them fit one screen rather than two and
a half.

What the fold costs, said plainly: the column names are on the screen at every other width and
not at this one, and no pseudo-element hides them for a screen reader. Both ways of doing that
were measured against a browser's accessibility tree, and neither reads in the right place. What
a phone reads out is the strip itself, `beacon, beacon-8c, waiting · permission prompt, ctx 65%,
Opus 5, medium, $20.79, up 15h`: named for five of the eight, unnamed for the project, the
session and the model. The desktop table names all eight in its header row, and so do
`GET /api/fleet` and `list --json`.

The summary line drops its ISO stamp, which is the widest thing on it and says what the header
already says in words. The stamp stays in the markup, so a wide window and anything reading the
HTML still get the exact second.

And while a replay is running, the scrubber pins to the bottom of the viewport, so the hand on
the handle and the dials the handle moves are on screen together. The sentence under it comes
with it. Two of the three things it says are properties of the record rather than of its range,
that nothing replayed is dated and that the past is drawn ungrouped, and a phone replaying is
exactly when a reader is looking at an ungrouped map.

Independently of width, wherever the pointer is coarse, the four pills carry an invisible target
of at least 44px: the two tabs, `Play`, and the way back out of a replay. The scrubber itself is
not one of them. It is a range input, dragged by a thumb the browser sizes, and it is left
alone. The overlay is drawn nowhere, so nothing it covers moves. Laid out at 1280px the table
comes out box for box where it was, to two decimals, and the one node the page gained is a span
wrapped round text already drawn in that place. What a desktop reader does see change is the
scrubber's `REPLAY`, which is written above it at every width and not only on a phone. See
[replaying the day](#replaying-the-day).

## What the serve remembers

`serve` reads the whole fleet on every request. Since it is running anyway, it also reads it
on a timer of its own, once a minute, into a ring of 1440 slots. That is 24 hours, after which
the oldest minute falls off. `GET /api/history` hands that ring back.

```json
{
  "since": 1786240000000,
  "cadence": 60000,
  "missed": 0,
  "samples": [
    {
      "t": 1786240060000,
      "rateLimits": { "five_hour": { "used_percentage": 17 } },
      "sessions": [
        { "sid": "ea6a607c-…", "project": "alpha", "kind": "interactive",
          "state": "busy", "waitingFor": null, "ctxState": "ok", "ctxPct": 26, "costUsd": 27.75 }
      ]
    }
  ]
}
```

**In memory, and nowhere else.** A fleet journal on disk is the one file this tool promised
never to write: it would outlive the process that made it and sit in a home directory carrying
session ids, working directories and costs. So the record starts when the serve starts, and
`since` says so. A page that needs to state what it covers reads that field rather than
assuming a full day. Restarting `serve` is how you clear it.

`since` is the oldest minute the record still holds, not the oldest it ever held: for the
first day it is the moment `serve` started, and from the first eviction on it moves with the
ring. A serve that has been up 34 hours covers 24 of them and says 24. The alternative is a
page that reads `since`, promises a day and a half, and shows a day.

**A sample carries no names.** A background session is named after the prompt it was given
(see [the map](#the-map)), which the live views show because someone is looking at their own
screen in the present tense. A day of them, retained by a process and served on a route, is a
different object, so no name enters the ring, for any kind of session. The agent is still
there, with its `sid`, its project and its state. What is missing is the field, not the row.

`waitingFor` is the one string off the source that the ring does keep. It is a closed vocabulary
the surface publishes, five words about the fleet's own machinery, rather than a sentence
somebody typed. "Blocked on a permission prompt at 14:02" is the reason to keep a day of
readings at all.

**A reading that failed is a counted slot.** `missed` is how many minutes were due and never
filled: a collector that threw, or a fleet still being read when the next tick came (only one
read runs at a time, so a slow `claude agents --json` costs a minute, never a queue of
processes). A gap that says it is a gap is not a gap. It counts slots inside the span `since`
names, not since the process booted. The 1440 slots hold minutes, and a minute nobody could
read is one of them, taking a slot from the samples and ageing out with them.

**One minute and one day are the product.** There is no flag, no environment variable and no
config key for the cadence or the retention, and none is planned. A cadence knob is a way to
ask this process to spawn `claude agents --json` every second, and a retention knob is a way to
ask it to hold a week of fleets in RAM. `/api/history` carries the same `X-Tarmac: 1` identity
header and `Cache-Control: no-store` as every other answer, and alone among the routes it
never reads the fleet to answer: it serves what was already read.

## Configuration

Three of tarmac's numbers are judgement calls, so all three are yours to set. The hosts `serve`
answers to are the fourth setting and the only one that is not a number. It has a default nobody
should have to change, and a documented reason to change it. Nothing else is configurable, and
every one of them keeps working with no configuration at all.

| Setting | What it decides | Default |
|---|---|---|
| freshness threshold | how old a reading may be before it is marked `!` | `10m` |
| port | where `serve` listens | `4477` |
| snapshots directory | where `list` and `serve` **read** payloads from | the path frozen into the installed wrapper, so the reader follows the writer; with no install to ask, `$XDG_STATE_HOME/tarmac/snapshots`, else `<home>/.local/state/tarmac/snapshots` |
| trusted hosts | which `Host` values `serve` answers to besides loopback (see [putting it behind a reverse proxy](#putting-it-behind-a-reverse-proxy)) | none |

Flag beats environment beats config file beats default, settled per setting. A port pinned in
the file and a threshold tightened for one run is the normal case.

| Setting | Flag | Environment | `~/.claude/tarmac/config.json` |
|---|---|---|---|
| freshness | `--stale-after 90s` \| `15m` \| `2h` | `TARMAC_STALE_AFTER` (same spelling) | `"staleAfterMs": 90000` |
| port | `--port 8080` | `TARMAC_PORT` | `"port": 8080` |
| snapshots | `--snapshots-dir DIR` | `TARMAC_SNAPSHOTS_DIR` | `"snapshotsDir": "DIR"` |
| trusted hosts | `--trust-host HOST`, once per host | `TARMAC_TRUST_HOST`, comma-separated | `"trustHosts": ["HOST"]` |

```json
{ "staleAfterMs": 900000, "port": 8080 }
```

The trusted hosts are a list, and the rung that wins carries the whole of it: a `--trust-host`
on the command line replaces what `config.json` says rather than adding to it, so a list
widened in a file can be narrowed again for one run.

`tarmac serve` opens by printing each effective value and which of the four sources it came
from. The freshness threshold is named wherever a `!` is put on a reading: beside the marks
in `list`, in the footnote under the dashboard's fleet. A mark whose threshold is invisible is
one you cannot argue with.

**The default port gets out of the way. A port you named does not.** Nobody chose `4477`, so a
`4477` that is taken, by the dashboard you left running this morning, is not a reason to fail.
`serve` walks up to the next free port, up to ten of them, and its first line says where it
landed.

```
tarmac serving http://127.0.0.1:4478 — port 4477 was in use
```

A port named on the command line, in the environment or in `config.json` is a decision, and
`serve` will not quietly honour it somewhere else. It refuses, and names the flag that
moves it.

Nothing here is ever silently dropped. A duration that will not parse, a port out of range,
a key that does not exist, a file that is not JSON, a file that exists but cannot be read:
each one stops the run and says what it got, where it came from, and what would have worked.
That includes the ones that lose. A broken `TARMAC_STALE_AFTER` is refused even when a flag
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

- **No config file is not an error.** It is the zero-config contract. `install` and
  `uninstall` never read the file at all, so a typo in it can never be what stands between
  you and putting your status line back.
- The snapshots directory is a read-side setting, exactly like the flag it mirrors.
  The wrapper writes where `install` put it, in the state directory, which both plans print
  and `serve` prints on startup, and which the readers take from the wrapper when nothing else
  says otherwise. Point the reader at a directory that does not exist and tarmac says so,
  naming the path and the setting that sent it there.
  One absence is silent, and only one: no install here at all. The default used to be a
  path nobody had chosen and nothing had created, so "not there" meant "nothing has been
  chained yet". It is now the path an install *froze into the wrapper*, chosen and made by
  a run that happened, so if it is missing while a wrapper is installed, the writer and the
  reader have parted company, and you are told.

## Developing

```bash
npm test                       # typecheck (src + test + scripts), then run the suite
npm run build                  # flat JavaScript into dist/
node scripts/demo-fleet.ts     # the invented fleet the README's captures are taken of
```

`demo-fleet` plays an invented day into a real `serve`, with the real collector, the real
renderer, and both documented sources standing in as a shell script and a directory of
payloads. It is invented because a screenshot of a real machine carries working directories,
prompts and costs, and nothing real enters this repo.

CI runs the suite on Node 22 and 24, on Linux and macOS, with `TARMAC_REQUIRE_DASH=1` so a
machine without dash cannot report a green build it did not earn. A separate job builds `dist/`
and runs it on Node 20, the oldest version `engines` promises, and the only place the published
artefact is ever executed. Releases are cut by hand ([`PUBLISHING.md`](../PUBLISHING.md)).

The suite runs the TypeScript sources directly through Node's type stripping, so it needs
Node ≥ 22.18 to *develop*. What ships in `dist/` is plain ES2022 and runs on Node ≥ 20.

## Capturing a new Claude Code version

When tarmac reports a version it has never checked, capture the pair, both sources from
one build, in one command, with tarmac installed and a session of that build having drawn
at least one frame:

```bash
npm run fixtures:capture
```

It writes `fixtures/agents-<version>.json` and `fixtures/statusline-payload-<version>-*.json`
verbatim, then tells you to add the version to `CHECKED_VERSIONS` in `src/schema.ts`. The
suite fails while the constant and the directory disagree, which is what keeps the guard
from claiming a coverage nobody verified. Read both files before committing, and scrub
them: they come off your machine carrying real paths, session names and costs. The
fixtures in this repo are the real shapes with synthetic values, and that is the standard a
new one has to meet.

One build is sometimes worth capturing twice, for a `waiting` session, say, which the first
capture happened not to catch. Rename the copy `agents-<version>--<tag>.json`, one lowercase
word for what the capture *shows*, behind a double dash. The suite reads the version and
ignores the tag, so a second capture does not invent a build called `2.1.232-waiting`. A single
dash belongs to the version: `agents-2.1.232-rc.json` is the prerelease it looks like. And a
name that keeps neither shape fails the suite with the rule rather than being read as some
third thing.
