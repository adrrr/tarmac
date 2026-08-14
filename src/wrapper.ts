// P2 — the generated statusline wrapper.
//
// Claude Code calls `statusLine.command` on EVERY frame of its TUI, passing a documented
// JSON payload on stdin. The wrapper does exactly three things:
//   1. drop that payload as-is under <snapshotDir>/<session_id>.json (the telemetry);
//   2. prune the snapshots of sessions that stopped rendering — amortized, because every
//      line here is paid on every frame (see PRUNE_MARKER below);
//   3. hand stdin to the command that was already configured, so the user's display is
//      untouched.
//
// Written as POSIX sh rather than Node on purpose: this sits in the render path of every
// frame. A `node` boot per frame (~40 ms) is an order of magnitude more than a `sh` one,
// and the fleet measured the sh version at ≈ +10 ms/frame in production.
//
// POSIX means POSIX: on Debian and Ubuntu `/bin/sh` is dash, not bash. Every construct
// below is in the POSIX shell command language, and `test/portability.test.ts` runs this
// script under every POSIX shell present on the machine to keep it that way.
//
// Three invariants, all tested by running the real script:
//   RULE 1 — never break the display. Missing chain, failing chain, unwritable directory:
//            the status line still renders and the exit code is still 0. Telemetry loses,
//            display wins, always.
//   RULE 2 — never write outside the snapshot directory. `session_id` is external input
//            that becomes a filename, so anything that is not UUID-shaped is REFUSED, not
//            sanitised: a guessed name would be read back later as if it were certain.
//   RULE 3 — the sweep may remove exactly what the writer may write, no more and no less.
//            One rule, `SID_GLOB`, read by both — because when those two sets are merely
//            written to agree, they stop agreeing quietly, in both directions at once (#7).

/**
 * Prefix of every temp file the wrapper writes, and the ONLY thing that proves tarmac
 * wrote one. `.<sid>.<pid>.tmp` — what this used to emit — is a convention, not a
 * signature: the fleet's own production statusline wrapper emits byte-identical names into
 * a directory the docs tell you to point `--snapshots-dir` at. `src/reap.ts` builds
 * its match from this constant so the writer and the deleter can never drift apart.
 */
export const TEMP_PREFIX = '.tarmac-';

/**
 * The line every generated wrapper carries, and the last word on "is this file one of
 * ours?". Path identity answers that question only for the spellings `stat` can resolve —
 * `~/…`, quoted, or written relative to somewhere else all stat to nothing, and a tarmac
 * that fails to recognise itself wraps its own wrapper: unbounded recursion at every frame,
 * with the real statusline erased from the only file that named it. The file says what it
 * is, in itself, whatever the spelling that reached it.
 */
export const WRAPPER_MARKER = 'tarmac statusline wrapper — GENERATED';

/**
 * Bookkeeping file of the amortized prune below — its mtime is the date of the last sweep.
 * A dotfile, because `readSnapshots` skips those: the wrapper's own paperwork must never be
 * read back as if it were a session's telemetry.
 */
export const PRUNE_MARKER = '.tarmac-last-prune';

/** At most one sweep per hour, whatever the frame rate. R3's number, and its whole point. */
export const PRUNE_EVERY_MIN = 60;

/**
 * How long a snapshot nobody rewrites survives. A live session restamps its own file on
 * every frame, so 48h without one is a session that is gone — and far beyond `--stale-after`,
 * so nothing was reading that file as current anyway.
 */
export const SNAPSHOT_TTL_MIN = 48 * 60;

/**
 * A session id — ONE rule, and the only one the writer below, the sweep below and the
 * TypeScript that reads this directory are allowed to know. Written as a shell pattern
 * because two of the three consumers are shell; the third derives its regex from it.
 *
 * It is the canonical UUID, 8-4-4-4-12 hex: every fixture in this repo, every file in the
 * snapshot directory of the fleet this was built for, every transcript file observed. The
 * statusline payload documents `session_id` only as a "unique session identifier", so that
 * is an observation and not a promise — and the direction of the bet is deliberate. An id
 * that is not a UUID is refused at write time, which surfaces as a live session with
 * `absent` telemetry: a state `fleet.ts` already names and shows. The other bet — file
 * whatever arrives, and widen the deleters to match — would put every stem of 8..64
 * characters of `[0-9A-Za-z-]` within reach of `rm`, in a directory whose location comes
 * from `XDG_STATE_HOME` and can therefore be `~/.claude` itself, where the legacy purge
 * already deletes and where people keep a git repository. A missing row is recoverable.
 *
 * Bracket expressions, not `?`: `?` matches a leading dot (fnmatch without FNM_PERIOD), so
 * the old glob reached dotfiles the writer's own charset forbids it to produce (#7).
 *
 * And an ENUMERATION, not the range `[0-9a-fA-F]`: a range is collated by the locale, which
 * for a status line is whatever the TUI that spawned it carries. Under `en_US.UTF-8` — the
 * ordinary case on macOS, where `/bin/sh` is bash — `a-f` reaches `é`, `ç` and fullwidth `ａ`
 * in bash, in ksh and in BSD `find`, while the regex below is ASCII code points and always
 * will be. That is one string meaning two different sets depending on `LANG`, which is this
 * whole rule undone: a sid filed in a Terminal, refused under `LC_ALL=C`, and a file written
 * by the first frame that no TypeScript consumer here can ever recognise. Sixteen digits
 * spelled out cost 400 characters of pattern and nothing measurable per frame.
 */
const HEX = '[0123456789abcdefABCDEF]';
export const SID_GLOB = [8, 4, 4, 4, 12].map((n) => HEX.repeat(n)).join('-');

/**
 * The names the sweep below is allowed to remove: the sid rule, and a `.json`. NOT `*.json` —
 * that would take a `settings.json` or a `fleet.json` sitting next to them, data this script
 * never wrote, deleted from inside a status line.
 */
export const SNAPSHOT_GLOB = `${SID_GLOB}.json`;

/**
 * The same set, in Node — derived from the glob itself so the shell that deletes and the
 * TypeScript that deletes can never drift apart. A bracket expression means the same thing
 * in both languages; only the `.` of the extension separates them.
 */
export const SNAPSHOT_NAME = new RegExp(`^${SNAPSHOT_GLOB.replace(/\./g, '\\.')}$`);

export interface WrapperOptions {
  snapshotDir: string;
  chainCommand: string | null;
}

/** Single-quotes a string for POSIX sh. */
function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** @returns the sh source of the wrapper */
export function renderWrapper({ snapshotDir, chainCommand }: WrapperOptions): string {
  return `#!/bin/sh
# ${WRAPPER_MARKER}, do not edit.
# Removed by \`tarmac uninstall\`, which also puts back the statusLine it wrapped.
TARMAC_DIR=${shQuote(snapshotDir)}
TARMAC_CHAIN=${shQuote(chainCommand ?? '')}

payload=$(cat)

# --- extract "session_id" without forking (no jq, no python: this runs every frame) ---
# The match is positional (first occurrence). If the payload ever gains a NESTED id — a
# parent or subagent block — the first one is not ours, the snapshot would be filed under
# a wrong name, and a second session would silently clobber it. Ambiguity is refused, not
# resolved by guessing: same rule as the UUID shape check below.
sid=''
rest=\${payload#*'"session_id"'}
case "\${rest}" in
  *'"session_id"'*) payload_has_two_ids=1 ;;
  *) payload_has_two_ids=0 ;;
esac

case "$payload" in
  *'"session_id"'*)
    rest=\${payload#*'"session_id"'}
    rest=\${rest#*:}
    case "$rest" in
      *'"'*)
        rest=\${rest#*'"'}
        sid=\${rest%%'"'*}
        ;;
    esac
    ;;
esac
# Refuse anything that is not a session id — this value becomes a filename, and it is the
# same rule the sweep below deletes by: what this line declines to write, that one cannot
# unlink, and the reverse. An empty sid matches nothing here, so it stays empty.
case "$sid" in
  ${SID_GLOB}) ;;
  *) sid='' ;;
esac
# refuse an ambiguous payload outright
[ "$payload_has_two_ids" = 1 ] && sid=''

# --- drop the snapshot (best effort, atomic: temp file + rename in the same dir) ---
if [ -n "$sid" ] && mkdir -p "$TARMAC_DIR" 2>/dev/null; then
  tmp="$TARMAC_DIR/${TEMP_PREFIX}$sid.$$.tmp"
  # \`2>/dev/null\` comes FIRST, and the order is the whole point: redirections are applied
  # left to right, so \`> "$tmp" 2>/dev/null\` opens the temp file while stderr is STILL the
  # user's terminal — the shell prints its own \`cannot create …: Permission denied\` there,
  # and the \`2>\` that was meant to swallow it only takes effect afterwards. On a snapshot
  # directory that has become read-only that is one line of noise per FRAME, on the terminal
  # of a script whose first rule is to be invisible. Exit code and display are untouched
  # (\`printf\` is a regular built-in, so a failed redirection only fails the command), which
  # is exactly why nothing but stderr itself catches this. RULE 1.
  if printf '%s\\n' "$payload" 2>/dev/null > "$tmp"; then
    mv -f "$tmp" "$TARMAC_DIR/$sid.json" 2>/dev/null || rm -f "$tmp" 2>/dev/null
  else
    rm -f "$tmp" 2>/dev/null
  fi
fi

# --- prune the snapshots of sessions that stopped rendering (amortized) ---
# Nothing else would ever remove them: \`reap.ts\` collects this script's own temp litter and
# refuses to touch a \`<sid>.json\`. A fleet that recycles its sessions nightly leaves one dead
# file behind per session per night, forever. A LIVE session restamps its own snapshot on
# every frame, so mtime is what tells the dead from the living.
#
# Amortized, because this is the render path: the frame pays one \`find\` on ONE file — the
# marker — and the DIRECTORY is walked at most once an hour. The marker is stamped BEFORE the
# sweep and only if stamping works, so a sweep that cannot finish is not retried on the next
# frame. (A directory where the stamp itself keeps failing does pay one \`touch\` per frame,
# forever — a fork, not a directory walk, and it means nothing can be written there anyway.)
#
# Two known holes, both of them the safe way round, and both inherited from the fleet script
# this transposes:
#   • a marker dated in the FUTURE (clock skew, a restored backup, a network mount) is never
#     stale, so pruning stops until the wall clock catches up. Silent, and it fails towards
#     "keep files" rather than "delete files".
#   • \`-mmin\` is the one thing here POSIX does not require. GNU, BSD and toybox find have it,
#     busybox has it unless the build dropped CONFIG_FEATURE_FIND_MMIN; \`-mtime\` could not
#     replace it (it cannot express hours, and it rounds UP on BSD and DOWN on GNU, so one
#     expression would mean 24h on macOS and 48h on Linux). Where it is missing \`find\` fails,
#     the substitution is empty, and the sweep simply never runs.
# In both cases snapshots pile up exactly as they did before this block existed, and the
# display is never at risk.
#
# One race, priced and accepted: a sweep can stat a cold snapshot in the microseconds before
# another session's frame renames a fresh one over that same name, and then unlink the fresh
# inode. The session writes another one on its next frame — seconds later, on a live session
# — whereas a lock would cost every frame of every session, forever.
if [ -d "$TARMAC_DIR" ]; then
  marker="$TARMAC_DIR/${PRUNE_MARKER}"
  # Only a plain file, or nothing at all, is a marker — and the braces are load-bearing,
  # since \`&&\` and \`||\` have EQUAL precedence in sh. Both refusals are real:
  #   • a symlink — \`touch\` follows it, so a dangling one has the status line CREATE the
  #     link's target, a file outside the snapshot directory. RULE 2.
  #   • a directory — \`touch\` SUCCEEDS on one, so every frame reads as freshly stamped while
  #     \`-mmin\` never gets a regular file to judge: the sweep would run on every frame and
  #     the amortization would be gone, silently.
  if [ ! -h "$marker" ] && { [ ! -e "$marker" ] || { [ -f "$marker" ] && [ -n "$(find "$marker" -mmin +${PRUNE_EVERY_MIN} 2>/dev/null)" ]; }; }; then
    # \`touch\`, and NOT \`: > "$marker"\`: POSIX says a redirection error on a special
    # built-in — and \`:\` is one — shall abort a non-interactive shell. On a snapshot
    # directory that has become read-only that spelling exits dash 2 and ksh 1 with the
    # status line never printed, while bash carries on: RULE 1, broken on Debian and Ubuntu
    # only. An ordinary utility just reports a non-zero status, which is what this \`if\` is
    # asking about.
    if touch "$marker" 2>/dev/null; then
      # \`<dir>/.\` with \`! -name . -prune\` is how POSIX spells \`-maxdepth 1\`, and \`-type f\`
      # keeps a directory or a symlink wearing a session id's name out of it.
      #
      # The glob is the sid SHAPE, not \`*.json\`, and that is the same rule \`reap.ts\` states
      # for the temp files: only what we wrote — see SNAPSHOT_GLOB, which the legacy purge in
      # \`install.ts\` reads from the same constant.
      find "$TARMAC_DIR"/. ! -name . -prune -name '${SNAPSHOT_GLOB}' -type f -mmin +${SNAPSHOT_TTL_MIN} -exec rm -f {} + 2>/dev/null
    fi
  fi
fi

# --- hand over to the status line that was already there ---
if [ -n "$TARMAC_CHAIN" ]; then
  printf '%s\\n' "$payload" | sh -c "$TARMAC_CHAIN"
else
  # nothing to chain: print the model name so the line is never blank
  case "$payload" in
    *'"display_name"'*)
      rest=\${payload#*'"display_name"'}
      rest=\${rest#*:}
      case "$rest" in
        *'"'*)
          rest=\${rest#*'"'}
          printf '%s\\n' "\${rest%%'"'*}"
          ;;
      esac
      ;;
  esac
fi

exit 0
`;
}
