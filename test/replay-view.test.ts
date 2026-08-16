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
  for (const id of ['replay', 'replay-view', 'replaying']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*hidden`), id);
  }
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
    if (!/\.replay\b|\.replaying-note\b|#replay\b|#replay-view\b/.test(selector)) continue;
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
