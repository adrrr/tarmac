#!/bin/sh
# Is the commit checked out here a release? The release workflow asks on every push to main that
# touches package.json, and the usual answer is no: a dev-dependency bump changes the file and
# leaves the version alone.
#
# Usage: scripts/release-check.sh      (from the repository root, with every tag fetched)
#
# Prints `version=X.Y.Z` and `release=yes|no` on stdout, in the form `$GITHUB_OUTPUT` takes.
# Exit 0 with `release=no`: the tag vX.Y.Z exists, so this version has been released. Exit 0
# with `release=yes`: the version is above every vX.Y.Z tag and absent from the registry.
# Exit 1, with no `release=` line: anything that would publish what should not be, or publish a
# version twice. No tags at all, a version at or below the last tag, a version the registry
# already has, a registry that cannot be read or answers nothing.
set -u

name="$(node -p "require('./package.json').name")" || exit 1
version="$(node -p "require('./package.json').version")" || exit 1
tag="v$version"
echo "version=$version"

if git rev-parse --quiet --verify "refs/tags/$tag" > /dev/null; then
  echo "$tag exists: $version is released, nothing to do" >&2
  echo "release=no"
  exit 0
fi

# Releases only. A prerelease tag never names the version line this compares against.
last="$(git tag --list 'v*' | sed -n 's/^v\([0-9]*\.[0-9]*\.[0-9]*\)$/\1/p' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)"
if [ -z "$last" ]; then
  echo "no v* tags in this checkout, so every version looks new: check out with fetch-depth: 0" >&2
  exit 1
fi

highest="$(printf '%s\n%s\n' "$last" "$version" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)"
if [ "$highest" != "$version" ]; then
  echo "$version is not above v$last, the last release tag: refusing to publish it" >&2
  exit 1
fi

# The whole version list rather than `npm view name@version`: that one exits 1 both for a
# version that does not exist and for a registry that did not answer, and only the first is
# a go.
if ! published="$(npm view "$name" versions --json)"; then
  echo "could not read the versions of $name from the registry: refusing to publish blind" >&2
  exit 1
fi
if [ -z "$published" ]; then
  echo "the registry answered nothing for $name: refusing to publish blind" >&2
  exit 1
fi
if printf '%s\n' "$published" | grep -Fq "\"$version\""; then
  echo "$name@$version is already on npm, but $tag does not exist here: tag the commit it was published from" >&2
  exit 1
fi

echo "release=yes"
