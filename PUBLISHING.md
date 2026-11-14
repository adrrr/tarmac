# Publishing @adrrr/tarmac

Maintainer notes. Nothing here ships with the package (`files: ["dist"]`).

A release is a version bump merged to main. `.github/workflows/release.yml` stages that version
on npm, then tags the commit. Nothing is public until a maintainer approves the staged version
with their 2FA. There is no npm token anywhere: npm trusts this repository and this workflow
file through trusted publishing, set once on npmjs.com.

## Cutting a release

1. Open a pull request that does two things. It adds `## [X.Y.Z] - YYYY-MM-DD` right under
   `## [Unreleased]`, dated the day it will be merged. The bullets below it do not move, they
   now belong to the release. And it runs `npm version X.Y.Z --no-git-tag-version`, which
   changes `package.json` and `package-lock.json` and nothing else.
2. Merge it once CI is green. The release workflow runs on that push.
   - `scripts/release-check.sh` decides first. If the tag `vX.Y.Z` exists, there is nothing to
     do. If the version is not above the last tag, is already on npm, or the checkout has no
     tags, the job fails and nothing is sent.
   - `npm stage publish` runs the hooks below and puts the version in npm's staging area.
   - The `tag` job then creates `vX.Y.Z` on the merged commit.
3. Approve it once two things hold. The Release run of that merge is green. And the Staged
   Packages tab on npmjs.com, or `npm stage list @adrrr/tarmac`, shows that version and no
   other, with the shasum the run printed. npm keeps one staged copy of a version, so a green
   run means the copy in the queue is the one it built. Then Approve, or
   `npm stage approve <stage-id>`. Both ask for 2FA. Anything else in the queue is rejected,
   never approved: any run of a file named `release.yml` in this repository can stage.

`npm stage publish` runs the same hooks as `npm publish`, in this order, before anything leaves
the runner:

| Hook | What it does | Why it is there |
|---|---|---|
| `prepublishOnly` | `npm run build`, then the suite with `TARMAC_REQUIRE_DASH=1`, then `node dist/cli.js --help` | the dash gate skips silently when dash is missing, and nothing else in the suite ever runs the built artefact |
| `prepack` | `npm run build` | the tarball is built from the sources being published, never from a stale `dist/` |

If any of them fails, nothing is staged. A version that has been approved cannot be taken
back. npm unpublish is only allowed within 72 hours, and it burns the version number forever.
So the checklist below is done **first**, not after.

## Checklist for every release

- [ ] **`CHANGELOG.md` is current.** Everything under `Unreleased` moves under the new version
      with the merge date. It is written at release time from the merged PRs, never
      reconstructed after. The npm page is the only window users have into what changed.
- [ ] **CI is green on the release pull request.** The matrix is what stands behind
      `engines: node >=20` and the POSIX claim. See `.github/workflows/ci.yml`.
- [ ] **`npm pack --dry-run` lists `dist/*.js` plus `README.md`, `LICENSE` and `package.json`,
      and nothing else.** CI asserts both directions of this on every push. A one-sided
      "nothing unexpected" check passes on an empty tarball, which is exactly what a broken
      `files:` field produces.

Between the merge and the tag, the changelog suite accepts one dated section with no tag: the
newest, at the version `package.json` names. Any other untagged section still fails. The suite
also fails when `package.json` names a version with no dated section, so a bare version bump
cannot reach the registry.

The published name is `@adrrr/tarmac`. The bare `tarmac` on npm is a 2013 AMD framework,
abandoned and squatted. The command is `tarmac` either way, and the README install lines say
`npx @adrrr/tarmac`.

## When the workflow fails

- **`release-check.sh` refused.** Its message names the reason. Nothing was staged and nothing
  was tagged.
- **The stage failed.** Registry down or a flaky test: re-run the failed jobs. A failure that
  needs a fix needs a new release pull request: the fix, the next patch version, and the dated
  heading renamed to it.
- **The tag failed after the stage.** Re-run that job alone. Re-running the stage would fail:
  npm keeps one staged copy of a version and refuses a second.

## After it lands

```bash
npx @adrrr/tarmac@latest --help     # from the real registry, not from disk
npx @adrrr/tarmac@latest list       # against the machine's own fleet
```

Then check the README's install block against what the registry actually serves. The package
name is the one thing no local test can verify. The images are settled: npm does rewrite
relative paths inside `<picture>` markup, verified on the live page at 0.4.1, where both
captures render and the light variant is served. If a future README changes how the media is
referenced, look again. Until then this check is done.

## One-time chore on machines that ran a pre-signature wrapper

Temp files left by a pre-signature build of the wrapper, named `.<session>.<pid>.tmp` without
the `tarmac-` mark, are never reaped. Nothing in that name says we wrote them. On such a
machine, clear them by hand, once, looking before you delete in case the directory has
another writer:

```bash
ls -l DIR/.claude/tarmac/snapshots/.*.tmp   # look first
rm DIR/.claude/tarmac/snapshots/.*.tmp      # then remove what you recognise
```

Since the snapshots moved out of `.claude` (#20), `install` clears that directory of
everything it can prove it wrote and removes it. These temp files are precisely the ones it
cannot prove, so on such a machine the directory survives the upgrade with them still in it.
Clearing them by hand, once, is also what lets the directory go.

## Why CI publishes now

Releases used to be cut by hand, for two reasons. A token that can publish can be stolen, and a
tag-triggered workflow can release by accident. Trusted publishing removes the token. The
staging step covers the accident: a push to main can at most queue a version, and only a
maintainer with 2FA turns it into a release. Both hold only while two settings on npmjs.com
stay as they are. The trusted publisher allows `npm stage publish` and nothing else, and the
package's publishing access requires 2FA and disallows tokens. If either changes, this section
is wrong.

npm attaches a provenance statement to what trusted publishing sends from a public repository,
so a release links back to the commit and the workflow run that built it.
