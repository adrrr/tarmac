# CLAUDE.md — how code is written here

Rules for anyone, human or agent, changing this repo. The product's promise depends on
most of them, so a PR that breaks one does not merge, however good the rest of it is.

## Red lines

- **Zero runtime dependencies.** `dependencies` does not exist in package.json and never
  will. Dev-dependencies are two (`typescript`, `@types/node`) and grow only for a reason
  a redesign could not remove.
- **Documented surfaces only.** tarmac reads `claude agents --json`, the statusline payload
  Claude Code hands it, and its own files. Never a transcript, never an undocumented format,
  never a guess. If the data is not published, tarmac does not show it — read "What it
  deliberately does not do" in the README before proposing a feature.
- **Nothing real enters the repo.** Fixtures, tests, screenshots, issue and PR text:
  synthetic values only. A real session id, project path or prompt is a leak, not a fixture.
- **Honest copy.** A number nobody measured renders as absent, never as zero. A state
  tarmac does not know is printed verbatim, not mapped to the nearest known one.
  `waitingFor` is free text — test the status, never the reason.

## Working rules

- Test-first, and mutation-check: break the code, watch the test go red, restore it.
  A test that stays green under the mutation it exists for is not finished.
- Small diffs, one concern per PR. Deleting code beats adding it.
- Comments carry what the code cannot say — a constraint, a refusal, a trade-off — and a
  diff keeps every comment it touches true.
- Every user-visible change adds a CHANGELOG entry under `Unreleased`.
- No new flag, env var or config key unless a documented use case cannot exist without it.
  Defaults are the product.
- English throughout, maintainer's voice: precise, plain, no marketing. Nothing in this
  repo links to private infrastructure or carries a tool-session URL.
