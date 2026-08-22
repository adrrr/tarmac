// The account's two gauges, as markup.
//
// They sit in the page header rather than on a node, because a rate limit belongs to the
// account every session on the page is spending from. The model next door decides what a
// window IS; these are the rules about what reaches the screen — that the number is the
// authority and the bar is a glance, that a window nobody could read never becomes 0%, and
// that a reset is spelled as time left rather than as an epoch nobody reads.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLive, renderPage } from '../src/render.ts';
import { health, row, NOW } from './fleet-fixtures.ts';
import type { Fleet } from '../src/fleet.ts';

/** An account read a moment ago: 17% of five hours, 42% of seven days. */
const limits = (over: Record<string, any> = {}): Record<string, any> => ({
  five_hour: { used_percentage: 17, resets_at: NOW / 1000 + 8040 },
  seven_day: { used_percentage: 42, resets_at: NOW / 1000 + 300_000 },
  ...over,
});

const fleet = (rateLimits: Record<string, any> | null = limits(), snapshotAgeMs = 1200): Fleet => ({
  rows: [row({ rateLimits, snapshotAgeMs })],
  health: health(),
});

/** Two sessions, each with a reading of its own — the shape an account arrives in. */
const twoReadings = (other: Record<string, any>): Fleet => ({
  rows: [row({ rateLimits: limits(), snapshotAgeMs: 1200 }), row({ sessionId: 's2', rateLimits: other, snapshotAgeMs: 90_000 })],
  health: health({ sessions: 2 }),
});
const headerOf = (f: Fleet): string => {
  const html = renderPage(f);
  return html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
};

const page = (rateLimits: Record<string, any> | null = limits()): string => renderPage(fleet(rateLimits));
/** The header alone — the stylesheet above it has widths and percentages of its own. */
const header = (rateLimits: Record<string, any> | null = limits(), ageMs?: number): string => {
  const html = renderPage(fleet(rateLimits, ageMs));
  return html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
};

test('the header carries both windows, each with its used percentage', () => {
  const html = header();
  assert.match(html, /5h/);
  assert.match(html, /17%/);
  assert.match(html, /7d/);
  assert.match(html, /42%/);
});

// The rule the whole page is built on, applied to the one pair of numbers that is about the
// account rather than about a session: the number is what is authoritative, the bar is a
// glance at a magnitude.
test('the bar is drawn to the size of the reading, and the number stands beside it', () => {
  const html = header();
  assert.match(html, /width:17%/);
  assert.match(html, /width:42%/);
});

// An epoch is not something anyone reads. What a reader needs is how long they have, and it is
// counted from the moment the fleet was read — so a fragment re-rendered every five seconds
// carries a number that keeps counting down.
test('the reset is spelled as the time left, out of the clock the fleet was read with', () => {
  assert.match(header(), /resets in 2h 14m/);
});

// A window whose reset is behind the reading that reported it has rolled over since, so the
// percentage above it belongs to a window that no longer exists. "resets in -3h" would be the
// page saying nothing at all; naming the reset as passed is what makes the number readable.
test('a reset that has already passed says so, instead of a negative countdown', () => {
  const html = header({ five_hour: { used_percentage: 90, resets_at: NOW / 1000 - 1200 } });
  assert.doesNotMatch(html, /in -/);
  assert.match(html, /reset was due 20m ago/);
});

test('a window that reports no reset shows its percentage and claims no time', () => {
  const html = header({ five_hour: { used_percentage: 17 } });
  assert.match(html, /17%/);
  assert.doesNotMatch(html, /resets in/);
});

// This project's cardinal sin, in the header: a fleet whose snapshots carry no rate limits has
// not told us the account is empty, and 0% is the one thing that must not be drawn.
test('a fleet that carries no rate limits says so, and never draws 0%', () => {
  const html = header(null);
  assert.doesNotMatch(html, /\b0%/);
  assert.match(html, /no reading/);
  // The gauge's own dash, not any dash in the header: "updated &mdash;" is up there too, and so
  // is an em dash inside an HTML comment, so a bare /—/ passed with the whole pair deleted.
  assert.match(html, /<span class="num"><span class="dim">—<\/span><\/span>/);
  assert.doesNotMatch(html, /width:/, 'nothing is filled in for a window nobody read');
});

// Keyed on the measurement and never on anything else — the same dotted track the dials wear
// for a context nobody measured, so the two absences look alike wherever they appear.
test('an unread window wears a dotted rail, not an empty one', () => {
  assert.match(header(null), /rail unmeasured/);
  assert.doesNotMatch(header(), /rail unmeasured/);
});

test('a window whose shape moved says drift, and the other one is still drawn', () => {
  const html = header({ five_hour: { used_percentage: '17%' }, seven_day: { used_percentage: 42 } });
  assert.match(html, /schema drift/);
  assert.match(html, /42%/);
});

// "5h" is an abbreviation on a screen and nothing at all in an ear. Every other state on this
// page is said as well as drawn.
test('each window is spelled out for a reader who hears the page', () => {
  const html = header();
  assert.match(html, /five-hour window/);
  assert.match(html, /seven-day window/);
});

// The bar is the one part of a gauge that carries nothing the text does not already say.
test('the bar is hidden from anything reading the page out', () => {
  assert.match(header(), /class="rail"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*class="rail"/);
});

// Between the tabs and the freshness, a reader who hears the page gets "five-hour window 17%
// resets in 2h 14m seven-day window 42%…" with nothing saying whose windows those are. The pair
// is named once, as a group, rather than each gauge repeating the word "account".
test('the pair says what it is the pair of', () => {
  const group = /<div class="limits" id="limits"([^>]*)>/.exec(header())![1];
  assert.match(group, /role="group"/);
  assert.match(group, /aria-label="[^"]*account/i);
});

// Where they live, and why. The header is the shell's — it survives the poll, the tabs and the
// replay banner — but the NUMBERS are the fleet's, and the fleet arrives in the fragment. So
// the fragment carries them too, in a slot the script copies into the header on every swap.
test('the fragment carries the same gauges, so a poll can refresh what the header shows', () => {
  const live = renderLive(fleet());
  assert.match(live, /id="limits-src"/);
  assert.match(live.slice(live.indexOf('id="limits-src"')), /17%/);
});

// It is a source, not a second display: two copies of the account's numbers on one page, one of
// them above the table and one inside it, is a page that can show two different accounts.
test('the fragment ships its copy hidden', () => {
  assert.match(renderLive(fleet()), /id="limits-src"[^>]*hidden/);
});

// The replay draws its own pair, out of the sample under the reader's hand. It ships hidden
// because with no script there is no replay — and `hidden` is only a UA rule of display:none,
// which any display a stylesheet gives the same element beats.
test('the replayed gauges ship hidden, and nothing gives them a display that outranks it', () => {
  const html = page();
  assert.match(html, /id="replay-limits"[^>]*hidden/);
  // Comments stripped FIRST. A selector is captured as "everything since the last brace", which
  // is the comment above the rule as well as the rule — and the comment above this one explains
  // the guard by naming it, so the assertion below was matching prose and passing over a
  // selector that had lost it. Removing the guard from the stylesheet left this green.
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1].replace(/\/\*[\s\S]*?\*\//g, '');
  let checked = 0;
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selector, declarations] = m;
    if (!/display\s*:\s*(?!none)/.test(declarations)) continue;
    if (!/\.limits\b|#limits\b|#replay-limits\b/.test(selector)) continue;
    checked++;
    assert.match(selector, /:not\(\[hidden\]\)/, `${selector.trim()} would show while hidden`);
  }
  assert.ok(checked > 0, 'the rule this is about was found at all');
});

// The rule every other value on this page follows, and the one this pair was breaking in the
// loudest possible way: the percentage is as old as the snapshot it came from, while the
// countdown beside it is recomputed every five seconds — so a window measured forty minutes ago
// sat next to a number visibly ticking down, with nothing saying which of the two was current.
// A stale reading is still the truth, of an earlier moment. Show it, and date it.
test('a reading past the freshness threshold is dated, like every other stale reading here', () => {
  const html = header(limits(), 40 * 60_000);
  assert.match(html, /17%/, 'the number is still shown — it was true of an earlier moment');
  assert.match(html, /! 40m ago/);
});

test('a reading inside the threshold is not dated, and the pair is said once', () => {
  const html = header();
  assert.doesNotMatch(html, /ago/);
});

// One reading, one date. Both windows come out of the same snapshot, so two "! 40m ago" would
// be the same fact said twice.
test('the age is the pair, not each gauge', () => {
  assert.equal((header(limits(), 40 * 60_000).match(/! 40m ago/g) ?? []).length, 1);
});

// A replaying page hides the live fragment for a reason — its totals are about now. The
// header's gauges are about now too, and left up they would be the one live number standing
// beside a fleet three hours old.
test('a replaying page hides the live gauges, the way it hides the live fragment', () => {
  assert.match(page(), /body\.replaying #limits \{ display:none/);
});

// Where the replayed pair goes, and it is not the header. Found by opening the page: the
// banner that says "this is the past" is BELOW the header, so an account drawn above it is the
// one past number on the page with nothing over it saying so — and the first thing a screen
// reader reaches, minutes before the warning. It goes with the rest of the past instead,
// under the banner and above the fleet it belongs to.
test('the replayed account is drawn with the replayed fleet, under the banner that dates it', () => {
  const html = page();
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  assert.doesNotMatch(header, /id="replay-limits"/, 'not in the header, where nothing dates it');
  const view = html.slice(html.indexOf('id="replay-view"'), html.indexOf('id="replay-map"'));
  assert.match(view, /id="replay-limits"/, 'inside the surface the past is drawn on');
  assert.ok(html.indexOf('id="replaying"') < html.indexOf('id="replay-limits"'), 'and after the banner');
});

// ── readings that are not about the same window ─────────────────────────────────────────
//
// One number is drawn out of as many readings as there are sessions, and the freshest wins.
// That rule holds while the readings are one allowance seen at several moments — and says
// nothing at all when they are not: a fleet spanning two logins, or a snapshot from before the
// window rolled over, hands the header a winner picked from a set nobody was told about.

test('the header says when the readings behind it are not all about the same window', () => {
  const html = headerOf(twoReadings({ five_hour: { used_percentage: 91, resets_at: NOW / 1000 + 60 }, seven_day: { used_percentage: 42, resets_at: NOW / 1000 + 300_000 } }));
  assert.match(html, /the 5h window is read differently by 1 of the 2 snapshots that carry rate limits/);
  assert.match(html, /the freshest is the one shown/, 'and what the number beside it therefore is');
  assert.match(html, /17%/, 'which is still drawn — there is nothing better to draw');
});

test('readings that name the same windows are the ordinary fleet, and go unremarked', () => {
  assert.doesNotMatch(headerOf(twoReadings(limits())), /read differently/);
});

// The mark is a warning, in the same ink as the one that dates a stale reading: what it says
// is that the number beside it may not be the account this fleet is spending from.
test('the mark carries the warning weight, rather than reading as chrome', () => {
  const html = headerOf(twoReadings({ five_hour: { used_percentage: 91, resets_at: NOW / 1000 + 60 } }));
  assert.match(html, /class="mixed"/);
  assert.match(renderPage(fleet()), /\.stale, \.mixed \{/, 'the two marks share one rule, so neither can lose its hue alone');
});
