# Tarmac V1 — feasibility spike

**Date** 2026-08-09 · **Machine** Mac mini, macOS 25.5 · **Claude Code** `2.1.226` · **Node** `v26.5.0`
**Repo** `~/projects/tarmac` (local only, never pushed) · **Suite** `npm test` → **127 tests, 127 pass, 0 fail**
**Reviewed** by an adversarial pass that found 4 Critical and 8 Important defects — all fixed, each against the reviewer's own reproduction. What follows is the corrected report; §Review records what was wrong in its first version.

> **Read as history.** This is the spike exactly as it stood on 2026-08-09, kept for the
> reasoning and the defects, not as current documentation. V1 then migrated it to TypeScript
> with no logic change: every `src/*.js` below is now `src/*.ts`, and `bin/tarmac.js` is
> `src/cli.ts`. The invariants it records are unchanged, and are the ones V1 must keep.

The spike answers one question: can a fleet-observability tool for Claude Code be built on
**contractual surfaces only** — never parsing an internal format, therefore never breaking
on a Claude Code update?

Short answer: **yes, for busy/idle + context/model/cost telemetry.** Verdict and caveats at
the bottom.

---

## P1 — Contractual session discovery · **PROVEN**

`claude agents --json` is a documented CLI surface. It answers instantly, needs no
permission prompt, and requires no knowledge of Claude Code's internals.

Observed schema (CC 2.1.226, 7 live sessions, frozen in `fixtures/agents-2.1.226.json`):

```json
{
  "pid": 66956,
  "cwd": "/Users/jane/golf",
  "kind": "interactive",
  "startedAt": 1786237453919,
  "sessionId": "ea6a607c-42e0-4773-af4d-ae5f5938d819",
  "name": "golf-eb",
  "status": "busy"
}
```

| Field | Type | Use in V1 |
|---|---|---|
| `sessionId` | uuid | **the join key** with the statusline snapshot |
| `status` | `"busy"` \| `"idle"` | the busy/idle signal, straight from the product |
| `cwd` | path | project name (basename) |
| `startedAt` | epoch ms | session uptime |
| `pid`, `kind`, `name` | — | identity, process actions later |

Real output at capture time: **7 sessions, 5 idle / 2 busy**, one per project. No
transcript read, no pane scraped.

**Design decision worth carrying into V1** (`src/sessions.js`): a status string we do not
recognise maps to `busy: null`, **never** `false`. A release that renames `busy` must make
the product say "I don't know", not "the fleet is calm" — the second is a silent outage.
The health block counts `unknownStatus` so the dashboard says it out loud.

**Discovery failures are loud** (`src/discover.js`): binary missing, non-zero exit,
unparseable stdout all reject. A monitoring tool that answers "0 sessions" when it merely
could not look is worse than one that answers nothing.

---

## P2 — Non-destructive, reversible chaining · **PROVEN AFTER CORRECTION**

> First reported as proven on the strength of the canary below. Review then found **four
> Critical path-identity and restore defects** the canary could not see (§Review). All are
> fixed and re-verified against the reviewer's reproductions; the canary evidence stands,
> it was simply never sufficient on its own.

Claude Code calls `settings.json → statusLine.command` on **every TUI frame**, handing it a
documented JSON payload on stdin. That payload is the telemetry. The installer inserts a
wrapper that drops the payload and then **calls whatever statusline was already configured**.

### Proof 1 — a real Claude Code session, in a sandbox HOME

Not a synthetic payload: a real CC 2.1.226 session booted on the generated wrapper.

```bash
printf '{"statusLine":{"type":"command","command":"echo EXISTING-DISPLAY-KEPT"}}' \
  > /tmp/tarmac-canary/home/.claude/settings.json
node bin/tarmac.js install --home /tmp/tarmac-canary/home
tmux new-session -d -s tarmaccanary -c /tmp/tarmac-canary/work \
  "claude --settings '/tmp/tarmac-canary/home/.claude/settings.json' --model haiku"
```

Result, read off the real TUI (line 49 of the pane) — the user's own statusline, untouched:

```
  EXISTING-DISPLAY-KEPT                                                        /rc
```

and a snapshot appeared at `…/tarmac/snapshots/1d781a6d-82be-4fb1-bff1-7ec30e036a8c.json`,
869 bytes, 12 keys, `version: "2.1.226"`.

### Proof 2 — byte-exact restore

```
expected sha: 7ffb6f406f1541c88f9cebb3d0705f5019d0f7c08ba5a7814d606ba398b416ce
uninstall: {"mode":"bytes"}
7ffb6f406f1541c88f9cebb3d0705f5019d0f7c08ba5a7814d606ba398b416ce  …/settings.json
```

Wrapper and backup removed; **collected snapshots deliberately kept** (user data, not our
scaffolding).

### The two-level restore model

"Byte for byte" and "do not clobber the user's later edits" cannot both hold
unconditionally, so the installer records both the original bytes and the bytes it wrote:

| Situation at uninstall | Mode | Result |
|---|---|---|
| settings.json untouched since install | `bytes` | original restored verbatim — indentation, key order, trailing newline |
| settings.json edited since | `surgical` | only the `statusLine` key restored; every other edit kept (re-serialised) |
| settings.json did not exist before | `absent` | the file we created is removed |
| statusLine now points elsewhere | — | **left alone**; someone else owns it now |

### Refusals (a spike that overwrites a working terminal is a failed spike)

- the **real HOME** — `install`/`uninstall` require `--home` and throw on `os.homedir()`;
- a `settings.json` that does not parse — never rewritten;
- a `statusLine` shape we cannot chain (not `{type:"command", command:"…"}`);
- a `session_id` that is not UUID-shaped — **refused, not sanitised**: it becomes a
  filename, and a guessed name would be read back later as if it were certain.

### Idempotence

A second install detects its own wrapper, does **not** re-wrap (which would chain the
wrapper to itself and lose the user's statusline), and does **not** overwrite the backup —
the original command survives any number of installs. Tested by running the wrapper after a
double install and asserting the original still renders.

### The wrapper's own rule: never break the display

Generated POSIX `sh`, not Node, on purpose: this runs on every frame. Verified by executing
the real script — missing chain, failing chain (`exit 3`), non-existent chain, unwritable
snapshot dir, path with spaces and quotes, payload with no `session_id`, `session_id` with
path traversal: the status line still renders and the exit code is still `0`.

Production reference for the same technique — the fleet's own statusline wrapper, which
this tool was modelled on — measured ≈ **+10 ms per frame**.

---

## P3 — Local dashboard, both sources crossed · **PROVEN AFTER CORRECTION**

> The demo worked; its honesty claim did not. Four of the seven numbers below were hours
> old and unmarked in the first version of this report (§Review, I1). Staleness is now
> shown and dated.

`tarmac list` / `tarmac serve` (node:http, one HTML page, no framework, no build step),
run **read-only** against the production snapshot directory:

```
$ node bin/tarmac.js list --snapshots-dir <the fleet's own statusline directory>
PROJECT            STATE  CTX      AS OF  MODEL    EFFORT  COST    UP
golf               busy   28%      7m     Fable 5  max     $41.20  8h
echo-tracker       busy   27%      22m !  Fable 5  max     $62.75  8h
charlie            idle   12%      3h !   Opus 5   high    $5.40   8h
bravo              idle   10%      4h !   Opus 5   medium  $2.60   18h
alpha              idle   8%       19m !  Fable 5  xhigh   $7.23   32h
delta              idle   8%       5h !   Opus 5   medium  $1.90   8h
foxtrot            idle   — fresh  8h !   Opus 5   high    $0.00   8h

! 6 reading(s) marked "!" are older than the freshness threshold

7 sessions · 2 busy · $121.08

(Project names and costs above are anonymised; the shape, the states and the ages are the
run exactly as it happened.)
```

The `AS OF` column is the correction: without it, the four hours-old numbers above were
indistinguishable from the seven-minute-old one.

`GET /` serves the same as a page, `GET /api/fleet` as JSON.

**The join is spined on live sessions**: a snapshot with no live session is a ghost (a
recycled fleet leaves dead files behind) and is dropped; a session with no snapshot is a
real state and stays visible with telemetry marked `absent`.

### What the payload gives, and the two things it does not

Available: `context_window.used_percentage` (computed by Claude Code against the session's
**real** window — 200k or 1M — which a homemade calculation cannot know), `current_usage`
(4 token fields), `model.display_name`, `effort.level`, `cost.total_cost_usd`, `version`,
and on real sessions `rate_limits.{five_hour,seven_day}` — captured, unused in V1.

Absent, confirmed: **no git branch**, **no permission mode**, and **no "waiting for human"
signal** — consistent with the decision to keep that signal out of V1.

### Honesty of the numbers

The rule the whole model rests on: **a missing measurement is never rendered as `0`, and a
measurement is never implied to be current.**
`ctxPct: null` renders `—`, plus the reason. Two opposite causes stay distinguishable:

| Snapshot shape | State | Meaning |
|---|---|---|
| `used_percentage: 40` | `ok` | measured |
| `used_percentage: null` (key present) | `fresh` | session booted, no turn yet — normal, transient |
| key gone / retyped | `drift` | **a CC release moved the schema** |
| no snapshot at all | `absent` | statusline not chained on that session |
| snapshot older than the threshold | `stale` | still true — *as of* its age, which is shown |

Three failures that are OURS, not the user's, are reported rather than rendered as calm
absence: a snapshot directory we could not read (`EACCES` ≠ empty), snapshot files we could
not parse, and sessions discovery returned but could not identify (`noSessionId` — a renamed
`sessionId` must never render as "no sessions found").

Both edge cases showed up for real, not in theory: one session was `fresh` in the run
above, and the Haiku canary emitted **no `effort` key at all** (Haiku has no effort level) →
rendered `—`, never invented.

`schemaBroken` fires only when **every** snapshot drifts — a whole fleet of `fresh` sessions
(the state of a recycled fleet at 3am) must never raise it.

---

## Surprises

1. **`--settings` does not hot-reload, but a normal settings edit does.** Claude Code
   re-reads `statusLine.command` at the next frame of a *live* session — a fleet arms itself
   without restarting. A `--settings` override is frozen at boot. Confusing the two produces
   the wrong conclusion about deployment (it did, in the production build).
2. **A real session's payload is richer than a probe's** — the canary emitted 12 keys, a
   real fleet session 16, including `rate_limits` (5h/7d plan windows). Conclusions about
   "the payload does not contain X" must be drawn on a real session.
3. **`effort` is absent, not null, on models without effort levels** (Haiku). Any V1 schema
   check must treat it as optional.
4. **The trust dialog blocks the first frame.** A brand-new sandbox project boots into
   "Is this a project you trust?" and renders no statusline until answered — worth knowing
   for any onboarding flow that installs then waits for a first snapshot.

---

## Review — what the first version of this report got wrong

The first version of this report claimed P2 and P3 **PROVEN** on the strength of a green
suite and one real-session canary. An adversarial review found that neither claim held.

**Four Critical defects, all in P2 — the proposition the canary appeared to prove.** Every
one ended with the user's real statusline replaced, self-chained, or pointing at a file
tarmac had deleted while reporting success:

| # | Defect | Why the canary missed it |
|---|---|---|
| C1 | The HOME guard was string equality. A symlink walked past it, and so does a macOS **firmlink** (`/System/Volumes/Data/Users/x` — same inode, and `realpath` does *not* collapse it) | The canary used one spelling of one path |
| C2 | "Is this our wrapper?" was string equality too, so `/tmp` vs `/private/tmp` made tarmac **chain itself** — unbounded recursion at every TUI frame, user's statusline erased from the only file naming it | Idempotence was tested with one spelling |
| C3 | `uninstall` reported `mode: "surgical"` while restoring **nothing**, then deleted the wrapper *and* the backup — settings left pointing at a missing file, `exit 127` every frame, no way back | The "leaves a foreign statusLine alone" test asserted the file, never the wrapper's survival |
| C4 | The backup guard tested **truthiness**: a parseable `{}` walked straight through and dropped the chain | The guard was written the same hour, against the same blind spot |

Identity is now device+inode, which holds through every spelling; `unchainStatusLine`
reports whether it restored anything (`mode: 'foreign'` keeps the wrapper and the backup);
the backup is validated by **shape**, with key *presence* as discriminant, because
`previous: null` is a legitimate value — the same rule this codebase already applies to
`used_percentage`.

**And the honesty claim of P3 was false in its own demo.** The reviewer crossed the live
table against snapshot mtimes:

```
bravo    idle   snapshot 235 min old   →  table printed "10%"
delta    idle   snapshot 267 min old   →  table printed "8%"
golf     busy   snapshot   5 min old   →  table printed "27%"
```

Four of seven numbers were hours old and rendered **identically** to a five-minute-old one.
`ageMs` was computed, carried through the join, and never shown — the exact class of defect
the design forbids, inside the table this report called *PROVEN on the live fleet*. The same
run today:

```
golf               busy   28%      7m     …
charlie            idle   12%      3h !   …
delta              idle   8%       5h !   …

! 6 reading(s) marked "!" are older than the freshness threshold
```

A stale reading is still the truth — of an earlier moment. It is shown, and dated.

Four further silent-failure paths were closed: discovery's `noSessionId` never reached a
renderer (a renamed `sessionId` would have rendered as the cheerful *"No Claude Code
sessions found"*); an unreadable snapshot directory was indistinguishable from an empty one
and blamed the user (*"run `tarmac install`"*) for a permission bug; `ctxTokens` coerced
absent keys to `0`, fabricating a confident zero on exactly the drift the module exists to
catch; and a cost summed over 3 of 7 sessions was printed as *the* fleet cost.

**The lesson worth keeping, and it is the product's own thesis turned on its author:** a
green suite and one happy-path canary prove that the thing works, never that it fails
honestly. Every defect above was a place where the code answered confidently instead of
saying "I don't know" — the precise failure mode Tarmac exists to make visible in Claude
Code. The invariants were right; three of the four Criticals were the invariants applied to
*values* but not to *identities*, and I1 was one applied to values but not to *time*.

---

## Verdict — **GO for V1**

All three propositions hold **after correction**. P1 was sound as first written; P2 and P3
are sound now, each fix verified against the reviewer's own reproduction. The marketing
claim survives inspection: nothing in this code reads a transcript, a pane, or an
undocumented file.

**Two honest qualifications on the "no internal format" claim.** First, `claude agents
--json` is a genuinely documented scripting contract (`--help`: *"Print active sessions …
as a JSON array … for scripting; does not require a TTY"*), but the load-bearing telemetry
field — `context_window.used_percentage`, plus `effort.level` and `rate_limits` — is
**observed on this machine, not cited from a published schema**. Say "documented CLI surface
+ observed statusline payload", not "documented" flatly. Second, the product's defence was
never immunity, it is **visible degradation** — and the review showed that defence was real
for `ctxPct` and `status` while entirely absent for `sessionId`, `ctxTokens` and staleness.
It now exists for all five. That property, not the parsing strategy, is what V1 must keep.

### Effort estimate for V1

| Lot | Content | Size |
|---|---|---|
| Harden the installer | interactive confirmation instead of the HOME guard, multi-HOME/multi-machine, Windows (the sh wrapper is POSIX-only — a `.cmd`/Node fallback is needed) | M |
| Watch mode | poll + auto-refresh, SSE or plain meta-refresh | S |
| Fleet history | keep snapshots over time → context/cost curves (`rate_limits` already captured) | M |
| Packaging | `npx tarmac`, publish, README, no dep | S |
| Schema guard | pin the observed CC version, warn when it moves (fixtures + `cc_version` check) | S |
| Wrapper hygiene | reap orphaned `.tmp` snapshots; confirm `sh -c` vs bashisms on Linux (`/bin/sh` = dash) before the npx release | S |

**≈ 1 week of focused work** for a shippable open-core V1 on this base. The spike is
throwaway, but the invariants it encodes (null never becomes 0, unknown never becomes idle,
refuse rather than sanitise, chain rather than replace, restore rather than rewrite) should
survive verbatim.

---

## Artefacts

| Path | What |
|---|---|
| `src/sessions.js`, `src/discover.js` | P1 — parse + run `claude agents --json` |
| `src/settings.js`, `src/wrapper.js`, `src/install.js` | P2 — chaining, generated wrapper, reversible installer |
| `src/snapshots.js`, `src/fleet.js`, `src/collect.js` | P3 — telemetry read + join |
| `src/render.js`, `src/server.js`, `bin/tarmac.js` | P3 — page, http server, CLI |
| `test/*.test.js` | 127 tests, `node:test`, zero dependency |
| `fixtures/` | real `agents --json` (2.1.226) + real statusline payloads (2.1.220 live, 2.1.226 fresh) |
