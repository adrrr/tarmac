# tarmac

[![npm](https://img.shields.io/npm/v/%40adrrr%2Ftarmac)](https://www.npmjs.com/package/@adrrr/tarmac)
![node](https://img.shields.io/node/v/%40adrrr%2Ftarmac)
![runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

**Fleet observability for Claude Code.** One table for every session you have running —
busy or idle, how full its context is, which model, what it has cost so far.

```
$ npx @adrrr/tarmac list

PROJECT            STATE  CTX      AS OF  MODEL    EFFORT  COST    UP
apollo             busy   28%      7m     Fable 5  max     $41.20  8h
mercury-dashboard  busy   27%      22m !  Fable 5  max     $62.75  8h
gemini             idle   12%      3h !   Opus 5   high    $5.40   8h
atlas              idle   — fresh  8h !   Opus 5   high    $0.00   8h

! 3 reading(s) marked "!" are older than the freshness threshold

4 sessions · 2 busy · $109.35
```

## Install

```bash
npx @adrrr/tarmac install      # chain the status line under ~/.claude, after showing you what changes
npx @adrrr/tarmac list         # one-shot table
npx @adrrr/tarmac list --watch # the same table, redrawn every 5s until ^C
npx @adrrr/tarmac serve        # dashboard on http://127.0.0.1:4477
npx @adrrr/tarmac uninstall    # put your status line back, exactly
```

Node ≥ 20. **Zero runtime dependencies** — no framework, no bundler, nothing to audit.

`install` changes one line of `~/.claude/settings.json`, and never on your say-so alone:
it prints the full plan — including the exact command that undoes it — and waits for a
**typed word** (`y` is not an answer; scripts pass `--yes`, deliberately). Your status
line is wrapped, not replaced: the display stays byte-identical, and `uninstall` restores
the original exactly.

The only things it puts under `~/.claude/` are the wrapper and the `backup.json` that undoes
it, neither of which changes at runtime — the snapshots the wrapper writes at every frame go
to `$XDG_STATE_HOME/tarmac/snapshots` (`~/.local/state/tarmac/snapshots` by default), because
`~/.claude` is a directory people commit.

## The dashboard

`tarmac serve` puts the same fleet in the browser — every session a row, ages that keep
climbing, and a banner the moment a refresh fails instead of a table quietly going stale:

```
tarmac serving http://127.0.0.1:4477
```

It binds to loopback and refuses any request whose `Host` is not loopback — your cwd
paths and costs never leave the machine.

## Why it does not break

Every other way to watch a Claude Code fleet reads something Claude Code never promised
would stay put: transcript files, terminal panes, undocumented paths. Those tools break on
an update, and — worse — they break *quietly*, reporting a calm empty fleet.

tarmac reads two things instead:

| Source | What it gives | How solid |
|---|---|---|
| `claude agents --json` | which sessions exist, busy or idle, cwd, uptime | a documented CLI surface (`--help`: *"Print active sessions … as a JSON array … for scripting"*) |
| the status line payload | context %, model, effort, cost | the JSON Claude Code hands to your own `statusLine.command` on every frame — **observed, not published as a schema** |

That second line is the honest caveat, and it is the reason the real defence is not
immunity, it is **visible degradation**: a null renders as `— no turn yet`, a moved field
as `— schema drift`, a stale reading as the value **dated** — never a confident `0`. And
when a session shows up on a Claude Code build no fixture covers, tarmac names that
version *before* anything breaks, and keeps reporting. The full state-by-state table is
in `docs/MANUAL.md`.

## Commands

| Command | What it does | Options |
|---|---|---|
| `tarmac list` | one-shot fleet table | `--home`, `--stale-after`, `--snapshots-dir`, `--claude-bin`, `--json`, `--watch` |
| `tarmac serve` | local dashboard, `GET /` for the page, `GET /live` for the fragment it refreshes, `GET /api/fleet` for JSON | `--home`, `--port`, `--stale-after`, `--snapshots-dir`, `--claude-bin` |
| `tarmac install` | chain the status line under `<home>/.claude/settings.json`, after confirmation | `--home`, `--yes` |
| `tarmac uninstall` | restore it, and say which of the four restore modes ran | `--home`, `--yes` |

`--help` works everywhere. An option handed to a command that does not read it is an
**error**, not something quietly ignored.

Both live views tell you **when the last good reading arrived** and **whether the last
refresh failed** — ages keep climbing whether or not the refresh works, failures are
banners with names, and a table is never thrown away for one. How each failure mode is
kept from looking like health: `docs/MANUAL.md`.

## Configuration

Three numbers are opinions, not truths, so all three are yours; everything else is
deliberately not configurable, and all of it works with no configuration at all.

| Setting | Flag | Environment | `~/.claude/tarmac/config.json` | Default |
|---|---|---|---|---|
| freshness threshold | `--stale-after 90s` \| `15m` \| `2h` | `TARMAC_STALE_AFTER` | `"staleAfterMs": 90000` | `10m` |
| port | `--port 8080` | `TARMAC_PORT` | `"port": 8080` | `4477` |
| snapshots dir (read side) | `--snapshots-dir DIR` | `TARMAC_SNAPSHOTS_DIR` | `"snapshotsDir": "DIR"` | `$XDG_STATE_HOME/tarmac/snapshots`, else `<home>/.local/state/tarmac/snapshots` |

**Flag beats environment beats config file beats default**, settled per setting. `serve`
opens by printing each effective value and which source it came from. Nothing is ever
silently dropped or silently corrected: a value that will not parse stops the run and says
what it got, where it came from, and what would have worked — including values that were
going to lose the precedence fight anyway. Full rules and edge cases: `docs/MANUAL.md`.

## What V1 does not do

- **No "waiting for you" signal.** The obvious missing column — which session is blocked on
  a human — is deliberately absent: the status line payload carries nothing that means it,
  and `agents --json` reports `idle` for a session waiting on you and for one that finished.
  Inferring it would mean reading a transcript, which is the one thing this tool will not do.
- **No history.** Each run is a snapshot in time; context and cost curves come later.
- **No Windows.** The generated wrapper is POSIX `sh`.
- **No remote fleets.** It watches the machine it runs on.

## Development

```bash
npm test           # typecheck (src + test + scripts), then run the suite
npm run build      # flat JavaScript into dist/
```

CI runs the suite on Node 22 and 24, on Linux and macOS, with `TARMAC_REQUIRE_DASH=1` so a
machine without dash cannot report a green build it did not earn; a separate job builds
`dist/` and runs it on Node 20 — the oldest version `engines` promises, and the only place
the published artefact is ever executed. Releases are cut by hand (`PUBLISHING.md`);
capturing fixtures for a new Claude Code build: `docs/MANUAL.md`.

The suite runs the TypeScript sources directly through Node's type stripping, so it needs
Node ≥ 22.18 to *develop*; what ships in `dist/` is plain ES2022 and runs on Node ≥ 20.

## License

MIT
