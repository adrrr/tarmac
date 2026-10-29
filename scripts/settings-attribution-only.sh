#!/bin/sh
# `.claude/settings.json` holds the `attribution` key and nothing else (CLAUDE.md, "Working
# rules"). Claude Code loads that file for anyone who opens this repository in it, so a hook or a
# permission a pull request slipped in beside the key would run on contributors' machines.
#
# Usage: scripts/settings-attribution-only.sh [file]     (default: .claude/settings.json)
#
# Exit 0: one JSON object whose only key is `attribution`, an object whose keys are among
# `commit`, `pr` and `sessionUrl` and whose values are strings or booleans. Exit 1: anything else,
# a missing or empty file included, since the file is what switches attribution off. Exit 2: jq is
# not there, which is a check that did not run, never a clean file.
#
# `--slurp` because jq reads a stream: two documents back to back are judged one by one and its
# exit status follows the last, so a clean object after a dirty one would pass without it.
set -u

file="${1:-.claude/settings.json}"

command -v jq > /dev/null 2>&1 || { echo "jq not found: $file was not checked" >&2; exit 2; }

if [ ! -f "$file" ]; then
  echo "$file is missing: it is what turns off the attribution Claude Code adds" >&2
  exit 1
fi

allowed='"attribution", "attribution.commit", "attribution.pr", "attribution.sessionUrl"'

if jq --slurp --exit-status '
  length == 1
  and (.[0] | type == "object" and keys == ["attribution"]
    and (.attribution | type == "object"
      and (keys - ["commit", "pr", "sessionUrl"]) == []
      and all(.[]; type == "string" or type == "boolean")))
' "$file" > /dev/null 2>&1; then
  exit 0
fi

echo "$file must hold the attribution key and nothing else." >&2
extra=$(jq --slurp --raw-output ".[] | paths | map(tostring) | join(\".\") | select(IN($allowed) | not)" "$file" 2> /dev/null) ||
  extra='(not a JSON document)'
[ -n "$extra" ] && printf 'unexpected:\n%s\n' "$extra" >&2
exit 1
