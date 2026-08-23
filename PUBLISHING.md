# Publishing @adrrr/tarmac

Maintainer notes. Nothing here ships with the package (`files: ["dist"]`).

The publish itself is one command, run by a human with the npm token. There is no release
workflow on purpose. The only thing a tag-triggered publish would add is the ability to
release by accident, and this package has one maintainer.

## The command

```bash
npm login                      # once per machine
npm publish --access public
```

That is the whole of it. `npm publish` runs these hooks, in this order, before anything
leaves the machine:

| Hook | What it does | Why it is there |
|---|---|---|
| `prepublishOnly` | `npm run build`, then the suite with `TARMAC_REQUIRE_DASH=1`, then `node dist/cli.js --help` | the dash gate skips silently when dash is missing, and nothing else in the suite ever runs the built artefact |
| `prepack` | `npm run build` | the tarball is built from the sources being published, never from a stale `dist/` |

If any of them fails, nothing is published. A publish that has started cannot be taken back.
npm unpublish is only allowed within 72 hours, and it burns the version number forever. So
the checklist below is done **first**, not after.

## Checklist for every release

- [ ] **`CHANGELOG.md` is current.** Everything under `Unreleased` moves under the new version
      with today's date. It is written at release time from the merged PRs, never reconstructed
      after. The npm page is the only window users have into what changed.
- [ ] **`npm version <patch|minor|major>`** on a clean tree (it tags the commit). Between the
      changelog step above and this one, `npm test` is red by design: the dated section has no
      tag yet, and the changelog guard says so. Finishing the release clears it.
- [ ] **CI is green on the commit being published.** The matrix is what stands behind
      `engines: node >=20` and the POSIX claim. See `.github/workflows/ci.yml`.
- [ ] **`npm pack --dry-run` lists `dist/*.js` plus `README.md`, `LICENSE` and `package.json`,
      and nothing else.** CI asserts both directions of this on every push. A one-sided
      "nothing unexpected" check passes on an empty tarball, which is exactly what a broken
      `files:` field produces.

The published name is `@adrrr/tarmac`. The bare `tarmac` on npm is a 2013 AMD framework,
abandoned and squatted. The command is `tarmac` either way, and the README install lines say
`npx @adrrr/tarmac`.

## After it lands

```bash
npx @adrrr/tarmac@0.1.0 --help      # from the real registry, not from disk
npx @adrrr/tarmac@0.1.0 list        # against the machine's own fleet
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

## What is deliberately not automated

- **No publish-on-tag workflow.** It would need an npm automation token in repository
  secrets, and a token that can publish is a token that can be stolen. One maintainer, one
  command, no standing credential in CI.
- **No provenance attestation**, for the same reason. It is produced by publishing *from* CI,
  which is the thing above. If tarmac ever gets a second maintainer, both come back together,
  gated on the full matrix.
