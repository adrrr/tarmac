# tarmac

[![npm](https://img.shields.io/npm/v/%40adrrr%2Ftarmac)](https://www.npmjs.com/package/@adrrr/tarmac)
[![CI](https://github.com/adrrr/tarmac/actions/workflows/ci.yml/badge.svg)](https://github.com/adrrr/tarmac/actions/workflows/ci.yml)
![node](https://img.shields.io/node/v/%40adrrr%2Ftarmac)
![runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

**Fleet observability for Claude Code.** One table for every session you have running:
busy or idle, how full its context is, which model, what it has cost so far. It reads
documented surfaces only, never an internal format.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/replay-dark.gif">
  <img src="docs/media/replay-light.gif" width="1100"
       alt="The tarmac map, live and then replayed. It opens on the live fleet, whose nodes are grouped into a frame per working directory, each labelled with its project. As the scrubber is dragged the frames give way to the flat record: sessions drawn as dials, each arc a context window, background agents as strips of text, with the account's five-hour and seven-day gauges above them. Sessions appear and disappear, the arcs fill and reset, the five-hour window fills and rolls over, and a banner names the minute being replayed until Back to live is pressed and the frames come back.">
</picture>

[Quickstart](#quickstart) · [The map](#the-map) · [Install](#install) ·
[Configuration](#configuration) · [Commands](docs/MANUAL.md#commands-and-options) ·
[Manual](docs/MANUAL.md) · [Changelog](CHANGELOG.md) · [Issues](https://github.com/adrrr/tarmac/issues)

## Quickstart

```bash
npx @adrrr/tarmac              # one-shot fleet table
npx @adrrr/tarmac --watch      # the same table, redrawn every 5s until ^C
npx @adrrr/tarmac serve        # the same fleet in the browser
npx @adrrr/tarmac install      # chain the status line: unlocks ctx, model, effort and cost
npx @adrrr/tarmac uninstall    # hand your status line back
```

```
$ npx @adrrr/tarmac

PROJECT            STATE  CTX      AS OF  MODEL    EFFORT  COST    UP
apollo             busy   28%      7m     Fable 5  max     $41.20  8h
mercury-dashboard  busy   27%      22m !  Fable 5  max     $62.75  8h
gemini             idle   12%      3h !   Opus 5   high    $5.40   8h
atlas              idle   — fresh  8h !   Opus 5   high    $0.00   8h

! 3 reading(s) marked "!" are older than 10m (--stale-after)

4 sessions · 2 busy · $109.35
account  5h 17% resets in 2h 14m · 7d 42% resets in 3d 11h · as of 7m
```

That is the table with the status line chained. The last line belongs to the account, not to
any one session. Every row above spends from the same five-hour and seven-day
[window](docs/MANUAL.md#the-accounts-two-windows), so it is printed once. It is dated like
every other reading here, and it reads `— no reading` rather than `0%` when no snapshot
carried one.

With nothing installed, the same command still lists every session, its state and its uptime,
straight from `claude agents --json`. The context column reads `— absent`. Model, effort and
cost fall to `—`. The line under the table counts how many sessions are covered.

Node ≥ 20. Zero runtime dependencies: no framework, no bundler, nothing to audit.
`--help` works everywhere. An option handed to a command that does not read it is an error,
never something quietly ignored. Every command, flag and route is in
[the manual](docs/MANUAL.md#commands-and-options).

## The map

`tarmac serve` puts the same fleet in the browser. Every session is a row, the ages keep
climbing, and a banner goes up the moment a refresh fails, so the table never goes stale in
silence.

It binds to loopback. It refuses any request whose `Host` is not loopback, and any request a
browser marks as coming from another origin, so your cwd paths and costs never leave the
machine. A client that sends no such mark, curl or a script, is left alone. A reverse proxy
presents a `Host` of its own, so `--trust-host <name>` names the one to let through;
[the manual](docs/MANUAL.md#putting-it-behind-a-reverse-proxy) says who that lets in. The
listening rules are [there too](docs/MANUAL.md#what-serve-listens-on).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/map-dark.png">
  <img src="docs/media/map-light.png" width="1100"
       alt="The tarmac map, live. Four framed groups, one per working directory and labelled with its project: beacon, holding a session halted on a permission prompt; harbor, holding a session busy with its context arc at 90% and a background agent docked under the cards of that frame as a strip named after its prompt; quay, reporting a status tarmac does not know; and atlas, idle at 36%. A frame says only that its nodes were read in the same directory. Nothing inside one claims that any node dispatched another. The account's five-hour and seven-day gauges sit above them, and one warning above the fleet names the unrecognised status rather than filing it as idle.">
</picture>

The tab in the header swaps the table for the same fleet drawn as nodes: one per session, the
arc its context, the shape by the name its state. A background agent has no terminal behind it
to draw a frame with, so it gets a strip of text rather than a dial that could never fill. Both
views render the same reading into the same fragment, so they can never disagree.

The nodes are grouped by working directory: a frame per directory, labelled with its project,
the sessions inside it as cards and the agents docked underneath as strips. A frame claims one
thing and no more: these nodes were read in the same directory. `claude agents --json`
publishes nothing that ties an agent to whoever dispatched it, so no label, no position and no
line inside a frame says one node asked for another. An agent whose directory matches no
session gets its own frame rather than somebody else's.

Above the fleet are the account's five-hour and seven-day
[gauges](docs/MANUAL.md#the-accounts-two-windows). Under it is a scrubber over the day this
serve has seen. Drag it and the nodes render the fleet as it was at that minute. Press play
and the day walks past. Replayed, the nodes are drawn flat and unframed. The record keeps a
project name and never the directory it was read in, and a basename is not a directory. Two
checkouts of `atlas` answer to the same word, so a frame drawn on it would claim a shared
directory nobody can check.

The map follows the rules the table follows. A reading past the freshness threshold is drawn
thin, amber and dated. A percentage nobody measured is an empty dotted dial, never a ring at
zero. Where nothing was published at all, such as the strip of an agent the join found no
snapshot for, nothing is drawn in its place: no dial, no dash. A word
`claude agents --json` printed that tarmac has no boolean for is shown as it came rather than
filed as `idle`, and raises one warning above the fleet naming it. The page is JSON
underneath: `GET /api/fleet` and `GET /api/history` serve exactly what the map draws. Details
are in [the manual](docs/MANUAL.md#the-map).

## Install

`install` changes the `statusLine` key of `~/.claude/settings.json`, and never on your
say-so alone. It prints the whole plan first, including the exact command that undoes it,
then waits for a typed word. `y` is not an answer. Scripts pass `--yes`, deliberately.

A status line you already had is wrapped, not replaced: its display stays byte-identical, and
`uninstall` names which of its four restore modes ran. Two files land under `~/.claude/`, the
wrapper and the `backup.json` that undoes it, and neither changes at runtime. The snapshots go
to `~/.local/state/tarmac/snapshots` (`$XDG_STATE_HOME` when set), because `~/.claude` is a
directory people commit. The plan, the restore modes and the cleanup of the old layout that
kept snapshots inside `.claude` are in
[the manual](docs/MANUAL.md#installing-safely-the-full-contract).

## Why it does not break

The usual ways to watch a Claude Code fleet read something Claude Code never promised would
stay put: transcript files, terminal panes, undocumented paths. Those break on an update, and
worse, they break *quietly*, reporting a calm empty fleet.

tarmac reads two things instead:

| Source | What it gives | How solid |
|---|---|---|
| `claude agents --json` | which sessions exist, busy, idle or waiting on you, cwd, uptime | a documented CLI surface (`--help`: *"Print active sessions … as a JSON array … for scripting"*) |
| the status line payload | context %, model, effort, cost | the JSON Claude Code hands to your own `statusLine.command` on every frame. Observed, not published as a schema |

That second row is the honest caveat. tarmac does not promise the payload will hold still.
It promises that a measurement it could not take never renders as a confident `0`. What you
get instead is an em dash naming which kind of missing it is: `absent` for a session no status
line ever wrote for, `fresh` for one that has taken no turn yet, `drift` for a release that
moved the payload out from under us. A stale reading keeps its value and gets dated with a
`!`. A Claude Code build no fixture covers gets its version named *before* anything breaks,
and tarmac keeps reporting. The full state-by-state table is in
[the manual](docs/MANUAL.md#degradation-state-by-state).

## Configuration

Three numbers here are judgement calls, so all three are yours to set, and behind a reverse
proxy the hosts `serve` answers to are yours as well. Everything else is deliberately not
configurable, and all of it works with no configuration at all.

| Setting | Flag | Default |
|---|---|---|
| freshness threshold | `--stale-after 90s` \| `15m` \| `2h` | `10m` |
| port | `--port 8080` | `4477` |
| snapshots dir (read side) | `--snapshots-dir DIR` | the wrapper's frozen path when installed, else the XDG state directory |
| trusted hosts | `--trust-host HOST`, once per host | none, so loopback only |

Each also has an environment variable and a key in `<home>/.claude/tarmac/config.json`.
Flag beats environment beats config file beats default, settled per setting. `serve` opens by
printing each effective value and where it came from. Nothing is silently dropped or silently
corrected. A value that will not parse stops the run and says what it got, where it came from,
and what would have worked. Spellings, edge cases and the two health fields
`tarmac list --json` reports are in [the manual](docs/MANUAL.md#configuration).

## What it deliberately does not do

- **No inferred "waiting for you".** `agents --json` reports `waiting` with a reason, such as
  a permission prompt or an open dialog, and tarmac draws exactly that, in the table and on
  the map. It does not guess at the rest. A session that asked you a question in prose still
  reports `idle`, because the only way to know better is to read a transcript, and this tool
  does not read transcripts.
- **No history on disk.** `tarmac list` is a snapshot in time. A running `serve` holds the
  last 24 hours of the readings it took itself, in memory, so the page can replay them. That
  record reaches no further back than the serve that took it, and goes when it goes. None of
  it is written down.
- **No Windows.** The generated wrapper is POSIX `sh`.
- **No remote fleets.** It watches the machine it runs on.

## Development

```bash
npm test                       # typecheck (src + test + scripts), then run the suite
npm run build                  # flat JavaScript into dist/
node scripts/demo-fleet.ts     # the invented fleet the captures above are taken of
```

Every capture on this page is taken of a fleet that does not exist. A screenshot of a real
machine carries working directories, prompts and costs, and nothing real enters this repo.
What CI covers, which Node version develops and which one ships:
[the manual](docs/MANUAL.md#developing). Capturing the fixtures for a new Claude Code build:
[the manual](docs/MANUAL.md#capturing-a-new-claude-code-version).

## License

MIT
