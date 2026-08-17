// The README's pixels, held to the two things nothing else can catch.
//
// A broken image on the repo page is invisible from here: the file renders as an alt string
// and the suite is as green as ever, so a rename in `docs/media/` costs nothing until someone
// opens the page. And an image directory is where weight accumulates — a re-capture at twice
// the size makes the page slower with a diff that reads as "updated the screenshot".
//
// Both are cheap to assert and neither is checkable by eye at review time.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
const MEDIA = 'docs/media';

/**
 * Every local image the README points at, in the three ways this file points at one: a
 * markdown image (with or without a title), an `<img src>`, and an `<img>`'s `<source srcset>`.
 *
 * Narrow on purpose. `src=` on anything that is not an `<img>` is not an image, and a `srcset`
 * is a comma-separated list of candidates each of which may carry a descriptor — matching the
 * whole attribute would demand a file called `docs/media/map-dark.png 2x`.
 */
function referenced(markdown: string): string[] {
  const found = new Set<string>();
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g)) found.add(m[1]);
  for (const tag of markdown.matchAll(/<(?:img|source)\b[^>]*>/g)) {
    const src = tag[0].match(/\bsrc="([^"]+)"/);
    if (src !== null) found.add(src[1]);
    const srcset = tag[0].match(/\bsrcset="([^"]+)"/);
    if (srcset !== null) for (const candidate of srcset[1].split(',')) found.add(candidate.trim().split(/\s+/)[0]);
  }
  return [...found].filter((p) => p !== '' && !/^https?:/.test(p));
}

test('every image the README shows is a file that is actually here', () => {
  const images = referenced(README);
  assert.ok(images.length > 0, 'the README references no local image at all');
  for (const rel of images) {
    assert.ok(fs.existsSync(path.join(repo, rel)), `README points at ${rel}, which is not in the repo`);
  }
});

// A page nobody can read a screenshot of is not fixed by the screenshot being there.
test('every image the README shows carries alt text', () => {
  for (const tag of README.matchAll(/<img\b[^>]*>/g)) {
    const alt = tag[0].match(/\balt="([^"]*)"/);
    assert.ok(alt !== null, `an <img> with no alt attribute: ${tag[0].slice(0, 60)}…`);
    assert.ok(alt[1].trim().length >= 40, `alt text too thin to stand in for the image: "${alt[1]}"`);
  }
});

/**
 * Every capture under `docs/media`, at any depth. Recursive because `statSync` on a directory
 * reports the directory entry — 96 bytes — so a size cap that walked one level would be blind
 * to whatever is inside one. Dotfiles are skipped, the same rule the snapshot reader follows:
 * a `.DS_Store` is not a capture, and reddening the suite over one teaches nothing.
 */
const captures = (): string[] =>
  fs
    .readdirSync(path.join(repo, MEDIA), { recursive: true, encoding: 'utf8' })
    .map((name) => name.split(path.sep).join('/'))
    .filter((name) => !name.split('/').some((part) => part.startsWith('.')))
    .filter((name) => fs.statSync(path.join(repo, MEDIA, name)).isFile());

// Room to re-capture, not room to stop noticing. The whole point of the GIF is a repo page
// that loads before the reader scrolls past it.
test('the media the repo page loads stays small enough to be worth loading', () => {
  let total = 0;
  for (const name of captures()) {
    const bytes = fs.statSync(path.join(repo, MEDIA, name)).size;
    total += bytes;
    assert.ok(bytes <= 1_000_000, `${MEDIA}/${name} is ${(bytes / 1e6).toFixed(2)} MB — over 1 MB on its own`);
  }
  assert.ok(total <= 2_500_000, `${MEDIA} is ${(total / 1e6).toFixed(2)} MB in total`);
});

// Captures are replaced, not appended: an image nothing points at is weight in the clone and
// in every fetch of the repo, and it is the kind of thing a rename leaves behind.
test('nothing sits in docs/media that the README does not show', () => {
  const shown = new Set(referenced(README));
  for (const name of captures()) {
    assert.ok(shown.has(`${MEDIA}/${name}`), `${MEDIA}/${name} is not referenced by the README`);
  }
});
