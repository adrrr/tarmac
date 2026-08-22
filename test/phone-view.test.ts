// The page on a phone.
//
// Everything here is about the two things a phone has that a laptop does not: a finger, and a
// viewport narrow enough that the page rearranges itself. Both are CSS, and CSS was the one
// part of this page nothing executed — so these read the sheet the browser is actually served
// and assert the rules by name, the same way `map-view` pins the berths.
//
// The desktop half of the bargain is asserted here too, in the negative: a rule that reshapes
// the page for a finger has to be behind `pointer: coarse` or the phone breakpoint, and a
// mutation that lifts it out of either lands on a test in this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLive, renderPage } from '../src/render.ts';
import { health, row } from './fleet-fixtures.ts';
import type { Fleet, FleetRow } from '../src/fleet.ts';

const fleet = (rows: FleetRow[] = [row()]): Fleet => ({ rows, health: health() });
/** The sheet the browser is served, with its prose cut out — a comment before a rule would
 *  otherwise be read as part of the selector that follows it. */
const sheet = (rows?: FleetRow[]): string =>
  /<style>([\s\S]*?)<\/style>/.exec(renderPage(fleet(rows), 'map'))![1].replace(/\/\*[\s\S]*?\*\//g, '');

/** One `@media` rule's block, braces balanced — a flat regex cannot count them. */
function atMedia(query: string, css: string = sheet()): string {
  const start = css.indexOf(`@media ${query}`);
  assert.notEqual(start, -1, `no @media ${query} in the stylesheet`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i);
  }
  throw new Error(`@media ${query} is never closed`);
}

/** Every value the sheet gives one property on one EXACT selector, in source order. */
const declaredEverywhere = (selector: string, prop: string, css: string = sheet()): string[] => {
  const found: string[] = [];
  for (const [, raw, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = raw.slice(raw.lastIndexOf('}') + 1).split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    const value = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(declarations)?.[1].trim();
    if (value !== undefined) found.push(value);
  }
  return found;
};

/** The sheet with every `@media` block cut out, so a viewport-scoped rule cannot answer for the page. */
function cssOutsideMedia(css: string = sheet()): string {
  let out = '';
  for (let i = 0; i < css.length; i++) {
    if (!css.startsWith('@media', i)) {
      out += css[i];
      continue;
    }
    let depth = 0;
    let j = css.indexOf('{', i);
    assert.notEqual(j, -1, 'an @media with no block');
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) break;
    }
    i = j;
  }
  return out;
}

// ── a finger is not a cursor ─────────────────────────────────────────────────────────────
//
// The three controls this page has are pills sized for a pointer that lands on a single
// pixel: the two tabs, the scrubber's Play, and the way back out of a replay. Apple asks for
// 44pt of tappable box and the pills are around 26 — so the TAPPABLE box grows and the drawn
// one does not, through an overlay that only exists where the pointer is coarse.

const REM = 16;
/** `body`'s own `font:14px/1.5` — the ratio every line box on this page is laid out with. */
const LINE_HEIGHT = 1.5;

const px = (value: string): number =>
  value.endsWith('rem') ? parseFloat(value) * REM : parseFloat(value);

/** The vertical half of a shorthand: `.15rem .55rem` is `.15rem`, `-.6rem -.3rem` is `-.6rem`. */
const shorthandY = (value: string): number => px(value.trim().split(/\s+/)[0]);

/**
 * The height of the box a finger has to hit, in CSS pixels at a 16px root: the control's own
 * line box, its padding and its border, plus whatever the coarse overlay adds above and below.
 *
 * Computed rather than asserted as a literal, because the number that matters is the SUM. A
 * pill whose padding is trimmed by a tenth of a rem, or an overlay copied onto a control with a
 * smaller font, both leave every individual declaration looking reasonable and the target under
 * the threshold — which is how the way out of a replay came to be 41px.
 */
function tapHeight(selector: string): number {
  const fontSize = px(declaredEverywhere(selector, 'font-size').at(-1)!);
  const padding = shorthandY(declaredEverywhere(selector, 'padding').at(-1)!);
  const border = px(declaredEverywhere(selector, 'border').at(-1)!.split(/\s+/)[0]);
  const coarse = atMedia('(pointer: coarse)');
  const inset = shorthandY(declaredEverywhere(`${selector}::after`, 'inset', coarse).at(-1)!);
  return fontSize * LINE_HEIGHT + 2 * padding + 2 * border + 2 * Math.abs(inset);
}

const CONTROLS = ['nav a', '.replay button', '.replaying-note button'];

test('every control a thumb has to hit is at least 44px tall on a coarse pointer', () => {
  for (const selector of CONTROLS) {
    assert.ok(tapHeight(selector) >= 44, `${selector} is only ${tapHeight(selector)}px of tappable box`);
  }
});

// The overlay is only a target: it is absolutely positioned against the control, which has to
// be a containing block for it, and that anchor cannot itself be phone-only or the overlay
// would resolve against the page and cover the wrong thing.
test('each of those controls anchors its own overlay, at every viewport', () => {
  for (const selector of CONTROLS) {
    assert.deepEqual(declaredEverywhere(selector, 'position', cssOutsideMedia()), ['relative'], selector);
  }
});

// The whole point of doing this with an invisible overlay rather than more padding: a mouse
// never meets any of it. A declaration in this block that is not on a `::after` is a
// declaration that moves something a desktop reader can see.
test('the coarse-pointer block adds targets and moves nothing that is drawn', () => {
  const coarse = atMedia('(pointer: coarse)');
  let rules = 0;
  for (const [, raw] of coarse.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = raw.slice(raw.lastIndexOf('}') + 1).split(',').map((s) => s.trim()).filter(Boolean);
    if (selectors.length === 0) continue;
    rules++;
    for (const selector of selectors) {
      assert.match(selector, /::after$/, `${selector} changes something the page draws`);
    }
  }
  assert.ok(rules > 0, 'the block this is about was found at all');
});

// ── the phone breakpoint ─────────────────────────────────────────────────────────────────
//
// One block, and the suite depends on it being one: `map-view` reads the phone's rules by
// finding `@media (max-width: 46rem)` and balancing its braces, which answers with the FIRST
// one in the sheet. A second block is a place for a rule to hide from every test that looks.
test('the phone has exactly one block in the sheet, so a rule cannot hide in a second', () => {
  assert.equal((sheet().match(/@media \(max-width: 46rem\)/g) ?? []).length, 1);
});

// The summary line ends in the reading's own ISO timestamp, and the header above it already
// says "updated 3s ago" — the same fact, in the words a reader actually uses. On a laptop the
// pair costs nothing; on a phone the stamp is the widest thing on the line and the line is
// four inches. It is spent, not deleted: the fragment still carries it, so a reader who wants
// the exact second can find it in the markup and a wide window still prints it.
test('the summary keeps its timestamp and spends it on a phone', () => {
  assert.match(renderLive(fleet()), /<span class="stamp">[^<]*\d{4}-\d\d-\d\dT[^<]*Z<\/span>/);
  assert.match(atMedia('(max-width: 46rem)'), /\.meta \.stamp\s*\{[^}]*display:\s*none/);
});

// The reason the stamp is affordable at all: the shell counts the age of the reading out loud,
// on its own, whether or not a poll ever lands. Take that away and the stamp is the only thing
// on the page dating the fleet.
test('the freshness the stamp repeats is still said in words', () => {
  assert.match(renderPage(fleet(), 'map'), /id="age"/);
});

// ── the handle stays under the thumb ─────────────────────────────────────────────────────
//
// The scrubber is at the FOOT of the map, and a map on a phone is several screens tall. Dragging
// it means the dials it moves are somewhere above the fold: the reader scrubs blind, lets go,
// scrolls up to see what changed, scrolls back down. Pinned to the bottom of the viewport, the
// hand and the thing the hand is changing are on screen at once.
const PHONE = (): string => atMedia('(max-width: 46rem)');
const STICKY = /body\.replaying \.replay:not\(\[hidden\]\)\s*\{([^}]*)\}/;

test('while a replay is on, the scrubber pins to the foot of a phone', () => {
  const rule = STICKY.exec(PHONE())?.[1];
  assert.ok(rule, 'no sticky rule for the scrubber in the phone block');
  assert.match(rule, /position:\s*sticky/);
  assert.match(rule, /bottom:\s*0/);
});

// It is pinned OVER the map, so it has to be opaque and it has to win: left transparent, the
// dials scroll through the slider they are being dragged by.
test('the pinned scrubber is opaque and sits above what scrolls under it', () => {
  const rule = STICKY.exec(PHONE())![1];
  assert.match(rule, /background:\s*var\(--bg\)/, 'the map must not read through the handle');
  assert.match(rule, /z-index:\s*[1-9]/);
});

// Only while replaying, and only on a phone. A scrubber pinned to the bottom of a live page
// is a permanent bar over the fleet, offering a drag into a past nobody has asked for yet.
test('nothing pins the scrubber on a live page, or on a laptop', () => {
  assert.deepEqual(declaredEverywhere('.replay:not([hidden])', 'position'), [], 'not on a live page');
  assert.doesNotMatch(cssOutsideMedia(), /body\.replaying \.replay[^{]*\{[^}]*position:\s*sticky/, 'not on a laptop');
});

// The sentence saying what the record covers is rest-reading: it is two lines of prose, and two
// lines of prose in a bar pinned over the map is half the map. It yields while the drag is on
// — the banner at the top carries the minute under the hand — and comes back at rest.
test('the prose under the handle yields its place while the drag is on', () => {
  assert.match(PHONE(), /body\.replaying \.replay \.covers\s*\{[^}]*display:\s*none/);
  assert.doesNotMatch(cssOutsideMedia(), /\.covers\s*\{[^}]*display:\s*none/, 'and only on a phone');
  assert.match(renderPage(fleet(), 'map'), /id="covers"/, 'the sentence is still rendered');
});
