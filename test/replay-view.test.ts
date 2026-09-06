// The scrubber, as markup.
//
// Everything here is about WHERE the replay lives rather than what it draws: the controls,
// the banner and the surface the past is drawn on all sit in the shell, because `/live` is
// swapped into `innerHTML` every five seconds and anything of the reader's inside it is
// reset on the next poll. The script's own behaviour is next door, in `replay-script`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLive, renderPage } from '../src/render.ts';
import { health, row } from './fleet-fixtures.ts';
import type { Fleet } from '../src/fleet.ts';

const fleet = (): Fleet => ({ rows: [row()], health: health() });
const page = (): string => renderPage(fleet(), 'map');

test('the shell carries the scrubber, the play button and the surface the past is drawn on', () => {
  const html = page();
  assert.match(html, /id="scrub"/);
  assert.match(html, /id="play"/);
  assert.match(html, /id="replay-map"/);
});

// The rule the tabs already follow, for the same reason: the shell owns the reader's choice.
// A scrubber inside the fragment would be dragged back to the present every five seconds by
// a poll the reader did not ask for.
test('the fragment carries none of it, so a poll cannot reset the reader', () => {
  const live = renderLive(fleet());
  for (const id of ['scrub', 'play', 'replay-map', 'replaying']) {
    assert.doesNotMatch(live, new RegExp(`id="${id}"`), id);
  }
});

// Without a script there is nothing to drive them, and a dead control is worse than none:
// the page's own noscript banner promises what is left is still readable, not still usable.
test('the controls ship hidden, so a page with no script shows no dead handle', () => {
  const html = page();
  for (const id of ['replay', 'replay-view', 'replaying', 'live-state']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*hidden`), id);
  }
});

// ── the line that says which fleet is on screen ───────────────────────────────────────────
//
// The banner used to be inserted into the flow the moment a reader touched the handle, and
// taken back out when they let go: the whole page jumped down a line on the way in and back up
// on the way out, at the exact moment the reader is comparing two minutes of it. So the two
// states take turns in ONE place instead. What is live says so, quietly, where the warning
// about the past will stand — the space is spent either way, and a page that never says which
// of the two it is showing is a page that only speaks up when it is lying.
test('the state line stands where the banner will, so entering a replay moves nothing', () => {
  const html = page();
  const live = html.indexOf('id="live-state"');
  const note = html.indexOf('id="replaying"');
  assert.notEqual(live, -1, 'the page carries a live state line');
  assert.ok(live < note, 'in the banner\'s own place in the flow');
  assert.ok(html.indexOf('id="live"') > note, 'both above the fleet');
});

// One box, declared once, worn by whichever of the two is up. Two rules could not disagree by
// much and would only have to disagree by a pixel of padding: the point of the pair is that the
// swap is invisible, and a height that comes from two places is a height that drifts.
test('the state line and the banner are one box, so the swap costs no vertical pixel', () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(page())![1].replace(/\/\*[\s\S]*?\*\//g, '');
  const shared = /\.warn,\s*\.live-state\s*\{([^}]*)\}/.exec(css);
  assert.ok(shared, 'the box is declared for the pair, not once each');
  for (const prop of ['padding', 'font-size', 'line-height', 'min-height', 'margin']) {
    assert.match(shared![1], new RegExp(`${prop}\\s*:`), prop);
  }
  // A minimum, because the banner carries a button and the live line carries none: left to
  // their own line boxes the two differ by the button's border and padding.
  assert.match(shared![1], /min-height:/);
  const own = /(?:^|\})\s*\.live-state(?::not\(\[hidden\]\))?\s*\{([^}]*)\}/.exec(css);
  assert.ok(own, 'and the live line has a rule of its own for what it does not share');
  for (const prop of ['padding', 'font-size', 'min-height']) {
    assert.doesNotMatch(own![1], new RegExp(`${prop}\\s*:`), `${prop} is the pair's, not the live line's`);
  }
});

// The live line is the one that goes down: the banner is a claim about the past, and a page
// showing both would be saying two things at once about the same fleet.
test('one of the two is up at a time', () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(page())![1];
  assert.match(css, /body\.replaying \.live-state \{ display:none/);
});

// Found by opening the page: `hidden` is a UA rule of `display:none`, and any `display` a
// stylesheet gives the same element beats it. Both replay containers are laid out with flex,
// so both came up on load — a banner announcing a replay nobody had asked for, over a live
// map, which is this feature's own worst failure shipped as its default state.
test('a container the script hides is never given a display that outranks hidden', () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(page())![1];
  let checked = 0;
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selector, declarations] = m;
    // Only a display that would SHOW it. `display:none` agrees with the attribute rather than
    // outranking it, and is how the table view hides these same elements.
    if (!/display\s*:\s*(?!none)/.test(declarations)) continue;
    // Every element the script ships hidden, by class or by id — `#replay-view` is the one
    // whose accidental reveal would put a past map on screen with nothing saying so.
    if (!/\.replay\b|\.replaying-note\b|\.live-state\b|#replay\b|#replay-view\b/.test(selector)) continue;
    checked++;
    assert.match(selector, /:not\(\[hidden\]\)/, `${selector.trim()} would show while hidden`);
  }
  assert.ok(checked > 0, 'the rules this is about were found at all');
});

// The replay is a claim about the past, and the loudest thing on the page has to say so —
// with the minute it is showing, and the way back, in the same breath.
test('the banner names the replay and carries the way back to live', () => {
  const html = page();
  const banner = html.slice(html.indexOf('id="replaying"'));
  assert.match(banner.slice(0, 400), /id="replay-at"/, 'the minute it shows has somewhere to go');
  assert.match(banner.slice(0, 400), /id="to-live"/, 'and one gesture returns to the present');
});

// The page says every other state out loud beside the shape that draws it — the node's `.sr`
// span, the halo's "a reading just landed". The banner appears without a reload and without
// focus moving, so a reader who is not looking at it gets nothing unless it is announced.
test('the banner is announced, not merely drawn', () => {
  const banner = page().slice(page().indexOf('id="replaying"'));
  assert.match(banner.slice(0, 200), /role="status"/);
});

// The whole fragment, and not merely its map. Hiding the map alone left the LIVE header —
// "4 sessions · 2 busy · $31.60 · 2026-08-16T09:50:14Z" — sitting directly above the replayed
// one, so the page showed two totals of two different moments and dated the pair with the
// present. Found by opening it; the warnings above them are about the present too.
test('a replaying page hides the whole live fragment, not just its map', () => {
  const html = page();
  assert.match(html, /body\.replaying #live \{ display:none/);
  assert.match(html, /body\[data-view="table"\] #replay(-view)?[^{]*\{ display:none/);
});

// ── the handle says what it is ────────────────────────────────────────────────────────────
//
// A button reading "Play" and a slider at the foot of the page, under a map, with nothing
// naming them: on a phone that is the whole of what fits on screen, and the first question it
// gets asked is what it plays. The name is the answer, and it costs one line at every width —
// a control nobody dares touch is a control that is not there.
test('the scrubber carries its own name', () => {
  const html = page();
  assert.match(html, /<span class="replay-name">Replay<\/span>/);
  assert.ok(html.indexOf('<span class="replay-name">') < html.indexOf('id="play"'), 'above the controls it names');
});

// "The last 24 hours" is the size of the RING, not of the record: a serve ten minutes old has
// seen ten minutes, and `coversText` is built around refusing to say otherwise. A title naming
// a duration would be the one line on this surface claiming a day nobody recorded — and the
// only line still on screen once a phone folds the prose away mid-drag.
test('the name says what the control is, never how much of the day it holds', () => {
  const name = /<span class="replay-name">([^<]*)<\/span>/.exec(page())![1];
  assert.doesNotMatch(name, /\d/, name);
  assert.doesNotMatch(name, /\b(day|hours?|h|minutes?)\b/i, name);
});

// It sits inside the container the script raises, so a page with no script shows no title over
// a scrubber that is not there — the same bargain the handle itself is under.
test('the name goes up and down with the controls, and never rides in the fragment', () => {
  const html = page();
  const container = html.indexOf('<div class="replay" id="replay" hidden>');
  assert.notEqual(container, -1, 'the container ships hidden');
  const name = html.indexOf('<span class="replay-name">');
  assert.ok(name > container, 'the name is inside it, not above it');
  assert.ok(name < html.indexOf('</div>', container), 'and closes with it');
  assert.doesNotMatch(renderLive(fleet()), /replay-name/);
});

// ── the handle itself ─────────────────────────────────────────────────────────────────────
//
// Everything else on this page is drawn by the stylesheet; the one control a reader spends the
// most time touching was whatever their browser felt like: a fat grey groove on one, a blue
// pill on another, and on none of them a track that belongs to the rest of the page. A range
// input is only styleable through its two shadow parts, and it is `appearance:none` that hands
// them over — without it the declarations below are read and ignored.
test('the page draws its own handle, in both engines rather than one', () => {
  const css = replayCss();
  assert.match(css, /\.replay input\[type="range"\][^{]*\{[^}]*appearance:\s*none/);
  for (const part of ['-webkit-slider-runnable-track', '-webkit-slider-thumb', '-moz-range-track', '-moz-range-thumb']) {
    assert.match(css, new RegExp(`::${part}`), part);
  }
});

// The pair the drawing is FOR: a thumb a thumb can find, on a track thin enough to read as a
// rail rather than as a bar with a value in it. Asserted as a comparison — the day one of the
// two is retuned, the other moves with it or this goes red.
test('the thumb is the thing you can grab, and the track the thing it runs on', () => {
  const css = replayCss();
  const size = (part: string, prop: string): number => {
    const m = new RegExp(`::${part}[^{]*\\{([^}]*)\\}`).exec(css);
    assert.ok(m, part);
    const v = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([\\d.]+)rem`).exec(m![1]);
    assert.ok(v, `${part} has no ${prop}`);
    return Number(v![1]);
  };
  for (const [thumb, track] of [
    ['-webkit-slider-thumb', '-webkit-slider-runnable-track'],
    ['-moz-range-thumb', '-moz-range-track'],
  ]) {
    assert.ok(size(thumb, 'height') > size(track, 'height') * 2, `${thumb} stands off its track`);
  }
});

// A control that can be reached by tab and not seen once it is there is a control a keyboard
// reader loses. `appearance:none` takes the browser's own focus ring with it, so the page owes
// one back — to the handle it just redrew, and to the buttons beside it.
test('every control in the replay row shows where the keyboard is', () => {
  const focus = [...replayCss().matchAll(/([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/g)]
    .filter(([, , declarations]) => /outline\s*:/.test(declarations))
    .map(([, selector]) => selector)
    .join(' ');
  for (const control of ['.replay input[type="range"]:focus-visible', '.replay button:focus-visible', '.replaying-note button:focus-visible']) {
    assert.ok(focus.includes(control), control);
  }
});

// Play and Pause are one button, and the word on it is the whole of what says which. A word is
// nothing to glance at across a room — and a screenshot of a paused replay reads the same as a
// running one. The state travels in the markup too, where the stylesheet can paint it.
test('the play button carries what it is doing where the sheet can see it', () => {
  assert.match(page(), /id="play"[^>]*data-playing="false"/);
  assert.match(replayCss(), /#play\[data-playing="true"\]\s*\{[^}]*background/);
});

/** The page's stylesheet, comments stripped: a selector is otherwise the prose above its rule. */
const replayCss = (): string => /<style>([\s\S]*?)<\/style>/.exec(page())![1].replace(/\/\*[\s\S]*?\*\//g, '');

// Its own line, above the row: dropped into the flex line beside Play it would read as a label
// for the button rather than for the pair, and take width from the slider to do it.
test('the name takes a line of its own rather than width from the slider', () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(page())![1];
  assert.match(css, /\.replay \.replay-name\s*\{[^}]*flex-basis:\s*100%/);
});
