#!/bin/sh
# Nothing in this repository links to private infrastructure or carries a tool-session URL
# (CLAUDE.md, "Working rules"). One such trailer reached a squashed merge before anything
# checked; published history keeps it, so this is for the next one.
#
# Usage: scripts/no-session-links.sh [range]
#
#   range   commit messages to read, as `base..head`. Omitted, or naming a commit this
#           checkout does not have, the last commit alone is read. Both happen: the first
#           push to a branch has no base at all and the workflow hands over a null sha, and
#           after a force-push the old tip is unreachable, so no checkout fetches it. A guard
#           that errors out there is a guard that is skipped exactly when history is being
#           rewritten.
#
# The index is read whatever the range says, not the working tree: what is committed is what a
# push carries, and the two differ whenever a file is cleaned on disk after the fact or
# `working-tree-encoding` hands a reader something other than the blob.
#
# What is deliberately NOT matched: a `Co-Authored-By:` trailer, which names a co-author and is
# nobody's session. Nor is the other half of the rule this enforces. A link to private
# infrastructure that is not a session URL is not in the pattern.
set -eu

root=$(git rev-parse --show-toplevel) || exit 2
cd "$root" || exit 2

# Assembled from fragments, deliberately: this script is tracked, and the sweep below would
# otherwise report itself as the first offender.
#
# `01` is not decoration on the session id: `session_` alone appears in 28 tracked files, as the
# `session_id` key of the statusline payload this product reads. The prefix is what separates an
# id from that key, so an id that ever stops carrying it goes unseen here.
host='claude'
sid='session_'
trailer='Claude'
pattern="$host\\.ai/code|${sid}01|$trailer-Session:"

status=0

range="${1:-}"
if [ -n "$range" ] && git rev-list "$range" >/dev/null 2>&1; then
  shas=$(git rev-list "$range")
else
  [ -z "$range" ] || echo "no such range: $range, reading the last commit instead" >&2
  shas=$(git rev-list -1 HEAD)
fi

for sha in $shas; do
  hits=$(git log -1 --format=%B "$sha" | grep -nE "$pattern") || continue
  echo "$sha: a session link in the commit message"
  printf '%s\n' "$hits" | sed 's/^/  /'
  status=1
done

# 0 is a hit, 1 is a clean tree, anything else is git failing to look, and a guard that
# reports clean because it could not read is worth less than no guard at all.
rc=0
hits=$(git grep --cached -nE "$pattern" -- .) || rc=$?
case "$rc" in
  0)
    echo "a session link in tracked files:"
    printf '%s\n' "$hits" | sed 's/^/  /'
    status=1
    ;;
  1) ;;
  *)
    echo "git grep could not read the tree (exit $rc)" >&2
    exit 2
    ;;
esac

exit "$status"
