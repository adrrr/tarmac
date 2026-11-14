// `scripts/release-check.sh` decides whether a push to main is a release. The release workflow
// runs it on every push that touches package.json, and most of those are not releases: a
// dev-dependency bump changes the file and leaves the version alone. So "nothing to do" is the
// common answer, and it has to be a quiet exit 0. Everything that would publish something it
// should not, or publish a version twice, has to be a loud exit 1 before npm is ever called.
//
// Each case builds a throwaway repository and puts a fake `npm` first on PATH, answering
// `npm view <name> versions --json` with a version list the case chooses. The real registry is
// never asked.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './sandbox.ts';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(repoRoot, 'scripts', 'release-check.sh');

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

function commitVersion(dir: string, version: string): void {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@example/pkg', version }, null, 2) + '\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', `version ${version}`);
}

/** A repository whose history released `tags`, in order, and whose HEAD carries `head`. */
function repo(tags: string[], head: string): string {
  const dir = tempDir('tarmac-release-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  for (const t of tags) {
    commitVersion(dir, t);
    git(dir, 'tag', `v${t}`);
  }
  commitVersion(dir, head);
  return dir;
}

/** A fake npm that prints `published` as the registry's version list, or fails like a network error. */
function fakeNpm(published: string[] | 'offline'): string {
  const bin = tempDir('tarmac-fake-npm-');
  const body =
    published === 'offline'
      ? 'echo "npm error code ECONNRESET" >&2\nexit 1\n'
      : `[ "$1 $3 $4" = "view versions --json" ] || { echo "unexpected: npm $*" >&2; exit 9; }\ncat <<'EOF'\n${JSON.stringify(published, null, 2)}\nEOF\n`;
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\n${body}`, { mode: 0o755 });
  return bin;
}

function run(cwd: string, npmBin: string): { status: number | null; stdout: string; out: string } {
  const r = spawnSync('sh', [SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${npmBin}:${process.env.PATH}` },
  });
  return { status: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
}

test('a version above the last tag and absent from the registry is a release', () => {
  const dir = repo(['0.9.0', '0.10.0'], '0.11.0');
  const { status, stdout, out } = run(dir, fakeNpm(['0.9.0', '0.10.0']));
  assert.equal(status, 0, out);
  assert.match(stdout, /^version=0\.11\.0$/m);
  assert.match(stdout, /^release=yes$/m);
});

// The numeric order, not the string one: "0.10.0" sorts below "0.9.0" as text.
test('a version above the last tag by number, below it as text, is still a release', () => {
  const dir = repo(['0.9.0'], '0.10.0');
  const { status, stdout, out } = run(dir, fakeNpm(['0.9.0']));
  assert.equal(status, 0, out);
  assert.match(stdout, /^release=yes$/m);
});

test('a version whose tag already exists is not a release, and says so quietly', () => {
  const dir = repo(['0.9.0', '0.10.0'], '0.10.0');
  const { status, stdout, out } = run(dir, fakeNpm(['0.9.0', '0.10.0']));
  assert.equal(status, 0, out);
  assert.match(stdout, /^release=no$/m);
  assert.doesNotMatch(stdout, /release=yes/);
});

test('a version below the last tag is refused', () => {
  const dir = repo(['0.9.0', '0.10.0'], '0.9.1');
  const { status, stdout, out } = run(dir, fakeNpm(['0.9.0', '0.10.0']));
  assert.equal(status, 1, out);
  assert.doesNotMatch(stdout, /release=yes/);
  assert.match(out, /0\.9\.1.*v0\.10\.0/);
});

test('a version already on the registry, with no tag here, is refused rather than sent twice', () => {
  const dir = repo(['0.9.0'], '0.10.0');
  const { status, stdout, out } = run(dir, fakeNpm(['0.9.0', '0.10.0']));
  assert.equal(status, 1, out);
  assert.doesNotMatch(stdout, /release=yes/);
  assert.match(out, /already on npm/);
});

// A version that only CONTAINS the candidate as a substring must not count as published.
test('a published 0.11.0-rc.1 does not make 0.11.0 look published', () => {
  const dir = repo(['0.10.0'], '0.11.0');
  const { status, stdout, out } = run(dir, fakeNpm(['0.10.0', '0.11.0-rc.1', '10.11.0']));
  assert.equal(status, 0, out);
  assert.match(stdout, /^release=yes$/m);
});

test('a registry that cannot be read is a refusal, never a release', () => {
  const dir = repo(['0.10.0'], '0.11.0');
  const { status, stdout, out } = run(dir, fakeNpm('offline'));
  assert.equal(status, 1, out);
  assert.doesNotMatch(stdout, /release=yes/);
});

// A shallow checkout has no tags, and every version would then look new.
test('a checkout with no version tags is refused', () => {
  const dir = repo([], '0.11.0');
  const { status, stdout, out } = run(dir, fakeNpm(['0.10.0']));
  assert.equal(status, 1, out);
  assert.doesNotMatch(stdout, /release=yes/);
  assert.match(out, /fetch-depth: 0|no v\*/);
});
