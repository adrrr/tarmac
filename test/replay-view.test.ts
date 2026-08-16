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

// The replay is a claim about the past, and the loudest thing on the page has to say so —
// with the minute it is showing, and the way back, in the same breath.
test('the banner names the replay and carries the way back to live', () => {
  const html = page();
  const banner = html.slice(html.indexOf('id="replaying"'));
  assert.match(banner.slice(0, 400), /id="replay-at"/, 'the minute it shows has somewhere to go');
  assert.match(banner.slice(0, 400), /id="to-live"/, 'and one gesture returns to the present');
});

// The live map and the replayed one occupy the same place. While the past is on screen the
// present one is not — two maps of two different moments, stacked, is the confusion this
// whole feature has to avoid.
test('a replaying page hides the live map, and only on the map view is any of it shown', () => {
  const html = page();
  assert.match(html, /body\.replaying \.view-map \{ display:none/);
  assert.match(html, /body\[data-view="table"\] #replay(-view)?[^{]*\{ display:none/);
});
