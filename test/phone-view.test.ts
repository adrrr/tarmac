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
import { mountPage, scriptOf } from './page-dom.ts';
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
/**
 * The line-height a control's own line box is laid out with — named per control rather than
 * assumed, because `body`'s `font:14px/1.5` is not the whole story. The way out of a replay is a
 * button inside `<div class="warn replaying-note">`, and `.warn` sets 1.45: Chrome lays that
 * button's line box out at 17.4px against the 19.2 a flat 1.5 predicts. Small, and the wrong
 * direction to be wrong in, since it is the tightest of the three targets to begin with.
 *
 * The whole sheet's minimum would be 1.2, from `.why` inside a dial, which no control inherits —
 * a model wrong in the safe direction is still a model that fails a page that is fine.
 */
function lineHeight(selector: string): number {
  const css = sheet();
  if (selector !== '.replaying-note button') return Number(/font:\s*\d+px\/([\d.]+)/.exec(css)![1]);
  // Only if the button really is inside one: the markup and the sheet have to agree, or this
  // number is read off a rule that stopped applying.
  assert.match(renderPage(fleet(), 'map'), /<div class="warn replaying-note"/, 'the note is still a .warn');
  return Number(declaredEverywhere('.warn', 'line-height', css).at(-1)!);
}

const px = (value: string): number =>
  value.endsWith('rem') ? parseFloat(value) * REM : parseFloat(value);

/** The vertical half of a shorthand: `.15rem .55rem` is `.15rem`, `-.6rem -.3rem` is `-.6rem`. */
const shorthandY = (value: string): number => px(value.trim().split(/\s+/)[0]);

/**
 * The height of the box a finger has to hit, in CSS pixels at a 16px root.
 *
 * The overlay is absolutely positioned inside a `position: relative` control, so its containing
 * block is the control's PADDING box — not its border box. With `top` and `bottom` both set and
 * `height` auto, its height resolves to the padding box plus the two insets, and the border sits
 * INSIDE that rectangle rather than adding to it. Counting the border made every control read
 * 2px taller than the browser lays it out, which put all four of them over a threshold they were
 * under: measured against Chrome, `nav a` was 43.2 while this said 45.2.
 *
 * Computed rather than asserted as a literal, because the number that matters is the SUM. A pill
 * whose padding is trimmed by a tenth of a rem, or an overlay copied onto a control set in
 * smaller type, both leave every individual declaration looking reasonable and the target short.
 */
function tapHeight(selector: string): number {
  // Read outside every media block on purpose. `pointer: coarse` matches at any width — an iPad,
  // or this phone in landscape, is coarse and past the 46rem breakpoint — so a padding or a
  // font-size scoped to one viewport is not the geometry this sum is about. The check below
  // refuses one to exist at all, rather than letting this quietly pick the wrong number.
  const plain = cssOutsideMedia();
  const fontSize = px(declaredEverywhere(selector, 'font-size', plain).at(-1)!);
  const padding = shorthandY(declaredEverywhere(selector, 'padding', plain).at(-1)!);
  const coarse = atMedia('(pointer: coarse)');
  const inset = shorthandY(declaredEverywhere(`${selector}::after`, 'inset', coarse).at(-1)!);
  return fontSize * lineHeight(selector) + 2 * padding + 2 * Math.abs(inset);
}

const CONTROLS = ['nav a', '.replay button', '.replaying-note button'];

test('every control a thumb has to hit is at least 44px tall on a coarse pointer', () => {
  for (const selector of CONTROLS) {
    assert.ok(tapHeight(selector) >= 44, `${selector} is only ${tapHeight(selector)}px of tappable box`);
  }
});

// The height above is the half a stylesheet can answer for. The other axis is the width of a
// word, which no sheet knows: every control here clears 44 on its own text, measured in a
// browser at 63, 48, 51 and 89, and there is no horizontal inset to make up a shortfall — one
// was tried and made the two tabs' targets overlap by 7px.
//
// So the arithmetic has to be reading the geometry the coarse pointer actually meets. A padding
// or a font-size on one of these controls inside a media block would be a second geometry the
// sum above cannot see, and `pointer: coarse` matches on viewports that block does not cover.
test('none of those controls is resized for one viewport behind the sum that pins it', () => {
  const plain = cssOutsideMedia();
  for (const selector of CONTROLS) {
    for (const prop of ['font-size', 'padding']) {
      assert.deepEqual(
        declaredEverywhere(selector, prop),
        declaredEverywhere(selector, prop, plain),
        `${selector} declares ${prop} inside a media block`,
      );
    }
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
//
// And each rule has to actually BUILD a target. Asserting only the selector left the feature
// open to being deleted a declaration at a time and staying green — a pseudo-element with no
// `content` is never generated at all, so dropping that one word takes every overlay on the
// page with it and leaves the whole suite passing. `pointer-events: none` and a `display` are
// the same deletion by other spellings: the box exists and nothing can be tapped on it.
test('the coarse-pointer block adds targets and moves nothing that is drawn', () => {
  const coarse = atMedia('(pointer: coarse)');
  let rules = 0;
  for (const [, raw, declarations] of coarse.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = raw.slice(raw.lastIndexOf('}') + 1).split(',').map((s) => s.trim()).filter(Boolean);
    if (selectors.length === 0) continue;
    rules++;
    for (const selector of selectors) {
      assert.match(selector, /::after$/, `${selector} changes something the page draws`);
    }
    assert.match(declarations, /(?:^|;)\s*content:\s*''/, `${selectors.join(', ')} generates no box at all`);
    assert.match(declarations, /(?:^|;)\s*position:\s*absolute/, `${selectors.join(', ')} is not laid over its control`);
    // A whitelist, because a denylist of ways to be invisible is a list somebody adds to. These
    // three build the target and nothing else builds anything: `background:red` paints a slab
    // over every control on the page and `z-index:-1` puts the target behind its own control,
    // and both walked past a list of `pointer-events`, `display` and `visibility`.
    for (const [, prop] of declarations.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)) {
      assert.ok(['content', 'position', 'inset'].includes(prop),
        `${selectors.join(', ')} declares ${prop}, which is not part of building a target`);
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

// The reason the stamp is affordable at all, executed rather than grepped: the shell counts the
// age of the reading out loud, on its own clock, whether or not a poll ever lands. Take that
// away and the stamp is the only thing on the page dating the fleet, and hiding it is a page
// that has stopped saying how old it is.
test('the freshness the stamp repeats keeps being said in words, with no answer at all', async () => {
  const page = mountPage(scriptOf(renderPage(fleet(), 'map')), () => Promise.reject(new Error('gone')));
  await page.advance(6000);
  await page.advance(30_000);
  assert.match(page.el('age').textContent, /updated 36s ago/);
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
  // Above the banner, not merely above zero: `.replaying-note` is sticky too, at the top of the
  // same screen, and a bar that only cleared the default layer would be under it wherever the
  // two meet on a short viewport.
  const above = Number(/z-index:\s*(-?\d+)/.exec(rule)![1]);
  const note = Number(declaredEverywhere('.replaying-note:not([hidden])', 'z-index').at(-1)!);
  assert.ok(above > note, `the pinned bar sits at ${above}, the banner at ${note}`);
});

// Only while replaying, and only on a phone. A scrubber pinned to the bottom of a live page
// is a permanent bar over the fleet, offering a drag into a past nobody has asked for yet.
test('nothing pins the scrubber on a live page, or on a laptop', () => {
  assert.deepEqual(declaredEverywhere('.replay:not([hidden])', 'position'), [], 'not on a live page');
  assert.doesNotMatch(cssOutsideMedia(), /body\.replaying \.replay[^{]*\{[^}]*position:\s*sticky/, 'not on a laptop');
});

// The sentence under the handle is not hidden on a phone, and this test is why rather than an
// accident. Folding it away for the length of a replay is the obvious way to keep the pinned bar
// short, and it undoes a fix `coversText` argues for in this same file: two of its three parts
// are standing properties of the RECORD and not its range — nothing replayed here is dated, and
// the past is drawn ungrouped — and they were put in the reader's view precisely because they
// had lived "nowhere the reader can see it", where an ungrouped map reads as a rendering that
// broke. A phone replaying is exactly when a reader is looking at one.
test('the sentence under the handle is never folded away, on any viewport', () => {
  for (const css of [sheet(), PHONE()]) {
    for (const [, raw, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\.covers\b/.test(raw)) continue;
      assert.doesNotMatch(declarations, /display:\s*none|visibility:\s*hidden|opacity:\s*0\b/,
        `${raw.slice(raw.lastIndexOf('}') + 1).trim()} takes the record's own properties off the page`);
    }
  }
  assert.match(renderPage(fleet(), 'map'), /id="covers"/, 'and the sentence is still rendered');
});
// ── the session, as a strip ──────────────────────────────────────────────────────────────
//
// Below the breakpoint the table has always folded into a card of eight labelled lines, and a
// card of eight lines is 234px: two and a half sessions fill a phone, and a fleet of eight is
// four screens of scrolling to answer "is anything waiting on me". The map next door already
// says a session in one line — `ctx 41% · Fable 5 · max` — and the card now says it the same
// way. Two lines: who and in what state, then the numbers. Nothing is dropped; the labels that
// go are the ones whose values wear their own name, a `$`, a `%`, the name of a model.
//
// It is CSS and nothing else. The markup a desktop reads, and every JSON surface, is untouched.

/** The `order` the phone gives each column's value, keyed by the column's name. */
function stripOrder(): Map<string, number> {
  const out = new Map<string, number>();
  for (const [, raw, declarations] of PHONE().matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const order = /(?:^|;)\s*order\s*:\s*(-?\d+)/.exec(declarations)?.[1];
    if (order === undefined) continue;
    for (const selector of raw.slice(raw.lastIndexOf('}') + 1).split(',')) {
      const label = /td\[data-label="([^"]+)"\]/.exec(selector)?.[1];
      if (label !== undefined) out.set(label, Number(order));
    }
  }
  return out;
}

/** The columns `renderRow` actually emits, in the order it emits them. */
const columns = (): string[] =>
  [...renderPage(fleet(), 'table').matchAll(/<td data-label="([^"]+)"/g)].map((m) => m[1]);

test('a session on a phone is a row that wraps, not a stack of labelled lines', () => {
  const tr = /(?:^|\s)tr\s*\{([^}]*)\}/.exec(PHONE())![1];
  assert.match(tr, /display:\s*flex/);
  assert.match(tr, /flex-wrap:\s*wrap/);
  // The three that make it a strip rather than a run-on line: values that do not touch, lines
  // that do not double-space, and a shared baseline under type set at two sizes.
  assert.match(tr, /column-gap:\s*[.\d]/, 'the values would touch');
  assert.match(tr, /row-gap:\s*[.\d]/, 'the two lines would set their own spacing');
  assert.match(tr, /align-items:\s*baseline/, 'the second line is smaller type and would float');
  // The axis, said out loud: `flex-direction:column` stacks the values back into eight lines and
  // undoes the whole change while every assertion above still reads true.
  for (const value of declaredEverywhere('tr', 'flex-direction', PHONE())) {
    assert.equal(value, 'row', 'the strip is a row');
  }
  assert.match(PHONE(), /td\s*\{[^}]*display:\s*contents/, 'the cell steps out of the way of its value');
});

// Two lines, and exactly two: the break is a zero-height item wedged between the state and the
// first number, so the first three values share a line whatever they are and the numbers start
// a new one. Without it the row is a paragraph of values that reflows differently per session,
// and a column of cards whose second line starts in a different place each time is unreadable.
test('the strip breaks after the state, so the numbers always start a line of their own', () => {
  const rule = /(?:^|\s)tr::after\s*\{([^}]*)\}/.exec(PHONE())?.[1];
  assert.ok(rule, 'no line break in the strip');
  assert.match(rule, /content:\s*''/, 'a pseudo with no content is never generated');
  assert.match(rule, /flex-basis:\s*100%/);
  assert.match(rule, /height:\s*0/, 'a break, not a gap');
  const order = Number(/(?:^|;)\s*order\s*:\s*(-?\d+)/.exec(rule)![1]);
  const by = stripOrder();
  assert.ok(by.get('State')! < order, 'the state is on the first line');
  assert.ok(by.get('Context')! > order, 'and the numbers below it');
});

// Nothing is dropped. The claim the old layout made by printing every column's name is now made
// by placing every column's value, so the check is the same one: every cell the table renders
// has a place in the strip. Read off the markup rather than typed out here — a ninth column
// added to `renderRow` and forgotten in the sheet lands on this line, which is only true
// because the cell it is read from is required to carry a `data-label` (next test down).
test('every column the table renders has a place in the strip', () => {
  const by = stripOrder();
  for (const label of columns()) {
    assert.ok(by.has(label), `${label} has no place on the phone`);
  }
});

// A place is not the same as being on the screen, and the check above cannot tell the two apart:
// `td[data-label="Context"] { display:none }` takes the whole context reading off every phone and
// leaves its `order` declaration exactly where it was. So the block is scanned for anything that
// hides part of a session, whatever spelling it arrives in.
//
// Two exemptions, both named here rather than pattern-matched: `thead`, whose column names the
// strip replaces, and `.bar`, the magnitude rail beside the percentage, which is a second way of
// saying a number the strip still prints.
test('nothing in the phone block takes a value off the screen', () => {
  for (const [, raw, declarations] of PHONE().matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/display:\s*none|visibility:\s*hidden|opacity:\s*0(?!\.)/.test(declarations)) continue;
    const selector = raw.slice(raw.lastIndexOf('}') + 1).trim();
    if (!/\btable\b|\btbody\b|\btr\b|\btd\b|\.v\b|\.pill\b/.test(selector)) continue;
    assert.match(selector, /^thead$|\.bar$/, `${selector} hides part of a session`);
  }
  // And the rail is still hidden, which is what makes it an exemption rather than an oversight.
  assert.match(PHONE(), /\.bar\s*\{[^}]*display:\s*none/);
});

// The red line the map is held to, applied here: what a reader meets going through the markup
// is what a reader meets going down the screen. `order` is used to insert a line break, never
// to move one value past another.
// `columns()` reads `data-label`, so a cell without one is invisible to every check above it —
// and to the strip, which hangs all of its rules on that attribute. Such a cell would take the
// default `order: 0` and draw its value ahead of the project, at full size, with no name.
test('every cell the table renders carries the attribute the strip hangs on', () => {
  const html = renderPage(fleet(), 'table');
  const rows = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  assert.equal((rows.match(/<td\b/g) ?? []).length, (rows.match(/data-label="/g) ?? []).length);
  assert.ok(columns().length >= 8, 'and the columns were found at all');
});

test('the strip prints the columns in the order the markup emits them', () => {
  const by = stripOrder();
  const placed = columns().map((label) => by.get(label)!);
  for (let i = 1; i < placed.length; i++) {
    assert.ok(placed[i] > placed[i - 1], `${columns()[i]} is drawn before ${columns()[i - 1]}`);
  }
});

// A number with no name is a number that means nothing: `65%` under a prompt reads as how much
// of the prompt is done, which is the mistake the map's own strip already had to fix. The
// values that shed a label are the ones whose value says what it is — a `$`, a model's name —
// and the two that do not get one back in the strip's own words.
test('the values that shed their column name wear one of their own', () => {
  assert.match(PHONE(), /td\[data-label="Context"\] \.v::before\s*\{[^}]*content:\s*'ctx '/);
  assert.match(PHONE(), /td\[data-label="Uptime"\] \.v::before\s*\{[^}]*content:\s*'· up '/);
});

// "Nothing is dropped" holds for a value that says what it is. A DASH does not, and a session
// with no snapshot behind it has four of them at once — `model`, `effort`, `costUsd` and the
// percentage all come from the same statusline frame, so they go missing together. That is not
// a corner case: it is every session until `tarmac install` has run and each one has drawn a
// TUI frame, which is the state the page prints a warning about. Read as a strip it came out
// `ctx — not chained · — · — · — · up —`, three anonymous dashes in a row. The same happens one
// at a time for a session that reports no cost.
//
// So a value that is only a dash gets its column word back. The hook is the markup's own: a
// missing value is rendered as `<span class="dim">—</span>` inside the cell's `.v`, and a
// present one never puts a `.dim` there.
test('a value that is only a dash says which column it is a dash for', () => {
  for (const [label, word] of [['Model', 'model'], ['Effort', 'effort'], ['Cost', 'cost']] as const) {
    assert.match(
      PHONE(),
      new RegExp(`td\\[data-label="${label}"\\] \\.v:has\\(\\.dim\\)::before\\s*\\{[^}]*content:\\s*'· ${word} '`),
      `a missing ${label} is an anonymous dash`,
    );
  }
  // The hook, against the markup rather than against a belief about it.
  const missing = renderPage(fleet([row({ model: null, effort: null, costUsd: null })]), 'table');
  assert.match(missing, /data-label="Model"><span class="v"><span class="dim">—<\/span>/);
  const present = renderPage(fleet(), 'table');
  assert.match(present, /data-label="Model"><span class="v">Fable 5<\/span>/, 'a real model brings no .dim with it');
});

// The weight on the context value is for a PERCENTAGE. A session with no reading renders the
// same cell as `— not chained`, and set in the number's weight a missing measurement reads
// like a measurement — heavier on a phone than the same words are on the desktop table, which
// is this tool's own promise inverted. The quiet ink the reason already wears takes it back.
test('a context nobody measured is not set in the weight of a number', () => {
  assert.match(PHONE(), /td\[data-label="Context"\] \.v \.dim\s*\{[^}]*font-weight:\s*400/);
  assert.match(
    renderPage(fleet([row({ ctxState: 'absent', ctxPct: null })]), 'table'),
    /data-label="Context"[^>]*><span class="v"><span class="dim">—<\/span> <span class="dim">not chained/,
    'the dash and its reason are the cell, and both are dim',
  );
});

// The column names leave the screen, and nothing hides them for a screen reader either.
//
// Both ways of trying were measured against Chrome's accessibility tree. Out of flow, in the
// `.sr` recipe, the eight labels are read as ONE block after the whole table, detached from
// every value they name; in flow at zero size they are pruned from the tree and still move the
// strip. So the pseudo is gone rather than half-there — and this test is what says so, because
// a pseudo-label that reads in the wrong place is the kind of thing that gets added back by
// someone reading the sheet and thinking it was an oversight.
//
// The attribute stays: it is what every rule in the strip hangs on, and what `GET /` carries
// for anything reading the markup.
test('the strip generates no pseudo-label, and keeps every attribute it hangs on', () => {
  assert.doesNotMatch(sheet(), /content:\s*attr\(data-label\)/);
  for (const label of columns()) {
    assert.match(renderPage(fleet(), 'table'), new RegExp(`data-label="${label}"`), label);
  }
});

// ── a name with no length limit ──────────────────────────────────────────────────────────
//
// A background session is named after its prompt, so the `Session` column holds a sentence
// nobody capped. On a strip that shares its line with two other values, the honest answer is
// to wrap it: an ellipsis is a width, and the manual's promise is that a long name costs a
// width and never a scroll bar. The page is content-box below this breakpoint and `.wrap`
// gives up its `overflow-x`, so a single line that refuses to break takes the whole document
// sideways — a fleet you can no longer read the left edge of.
const AGENT = 'sweep the flaky specs in the checkout suite and report what is really failing';

test('a prompt with no length limit wraps rather than taking the page sideways', () => {
  const decls = /td\[data-label="Session"\] \.v\s*\{([^}]*)\}/.exec(PHONE())?.[1];
  assert.ok(decls, 'the session value has no rule of its own on a phone');
  assert.match(decls, /white-space:\s*normal/, 'the desktop nowrap is given back');
  assert.match(decls, /overflow-wrap:\s*anywhere/, 'and a word longer than the phone breaks');
  assert.match(decls, /min-width:\s*0/, 'so the flex item may be narrower than its text');
});

// The state travels in a pill with a border round it, and the reason a session is waiting is
// free text: `permission prompt` fits, a sentence does not. Left `nowrap` it is one unbreakable
// item on the strip's first line, which is the same scroll bar by another road.
test('the reason a session is waiting wraps inside its pill rather than past the phone', () => {
  assert.match(PHONE(), /\.pill\s*\{[^}]*white-space:\s*normal/);
  // And the border stops being a capsule once it has three lines to go round. A 99px radius on
  // a one-line pill is a pill; on a wrapped one it is an ellipse, and its curve crosses the
  // words at the top and bottom of the box. A radius under half the height of a single line is
  // still clamped to a capsule there, and merely rounded once the box grows.
  assert.match(PHONE(), /\.pill\s*\{[^}]*border-radius:\s*\.9rem/);
  assert.match(
    renderPage(fleet([row({ busy: null, status: 'waiting', waitingFor: 'permission prompt' })]), 'table'),
    /waiting · permission prompt/,
    'and the reason is printed in full, not abbreviated to fit',
  );
});

// The red line under all of it: a background session's name is its PROMPT, and a prompt drawn
// as the heading of a card is a dashboard announcing what its agents were told to do, in the
// largest type on the page. The project leads the strip and carries the weight; the name
// travels beside it in the grey the page uses for secondary facts.
test("a background session's prompt is never promoted to the strip's title", () => {
  const project = /td\[data-label="Project"\] \.v\s*\{([^}]*)\}/.exec(PHONE())![1];
  const session = /td\[data-label="Session"\] \.v\s*\{([^}]*)\}/.exec(PHONE())![1];
  assert.match(project, /font-weight:\s*[6-9]\d\d/, 'the project is the one that leads');
  assert.doesNotMatch(session, /font-weight:\s*[6-9]\d\d/, 'and the prompt never outweighs it');
  assert.match(session, /color:\s*var\(--dim\)/);
  const html = renderPage(fleet([row({ kind: 'background', name: AGENT })]), 'table');
  assert.match(html, new RegExp(`data-label="Session"[^>]*><span class="v">${AGENT}`), 'still printed in full');
});

// Found by laying the page out in a real engine rather than by reading the sheet: the strip
// overflowed a 390px phone by 49px on a fleet whose project name was long. `td` is `nowrap` on
// the desktop table and `white-space` is INHERITED, so a cell that steps out of the layout with
// `display:contents` hands its nowrap to the value inside it all the same. The card layout this
// replaced said `white-space:normal` on the cell and that is what went missing with it.
//
// Two rules, because they answer two different strings: `normal` breaks a sentence at its
// spaces, and `anywhere` breaks the two values that can arrive as one long token — a project is
// a directory's basename and a background session's name is a prompt.
test('nothing in the strip keeps the desktop table\'s nowrap', () => {
  // On `td` and nowhere else: the desktop rule that has to be undone is `td { white-space:
  // nowrap }`, and an explicit declaration on the cell beats anything the ROW passes down. Set
  // on `tr` instead — which is where it was first put, and which passed a sheet-reading test
  // while the engine still laid the project name out 128px past the phone — the value inside
  // the cell goes on inheriting nowrap from the cell.
  assert.ok(
    declaredEverywhere('td', 'white-space', PHONE()).includes('normal'),
    'the cell never gives the desktop nowrap back',
  );
  for (const label of ['Project', 'Session']) {
    const decls = /\{([^}]*)\}/.exec(
      new RegExp(`td\\[data-label="${label}"\\] \\.v\\s*\\{[^}]*\\}`).exec(PHONE())![0],
    )![1];
    assert.match(decls, /overflow-wrap:\s*anywhere/, `${label} may hold one long token`);
    assert.match(decls, /min-width:\s*0/, `${label} may be narrower than its text`);
  }
});
