// The map, as markup.
//
// The model next door decides what a node IS; these are the rules about what reaches the
// screen — that a percentage nobody measured never becomes a ring, that a stale reading is
// not drawn like a live one, and that a session name is escaped before it is drawn.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLive, renderMap, renderPage } from '../src/render.ts';
import { health, row } from './fleet-fixtures.ts';
import type { Fleet, FleetHealth, FleetRow } from '../src/fleet.ts';

const fleet = (rows: FleetRow[], h: Partial<FleetHealth> = {}): Fleet => ({ rows, health: health(h) });
const one = (r: Partial<FleetRow> = {}): string => renderMap(fleet([row(r)]));

test('a node carries its project, its session name and its context', () => {
  const html = one({ project: 'apollo', name: 'alpha-7a', ctxPct: 62 });
  assert.match(html, /apollo/);
  assert.match(html, /alpha-7a/);
  assert.match(html, /62/);
});

// The arc is the percentage, as a fraction of the circle's real circumference.
//
// `pathLength="100"` would say the same thing in far prettier markup — 62 filled, 38 empty —
// but it is an attribute browsers have not always honoured on basic shapes, and the way it
// fails is the way this project cannot afford: the dash array is ignored, the arc closes,
// and every session on the page reads 100% context. So the arithmetic is done here, where
// the suite can check it.
test('the ring is drawn to the size of the reading', () => {
  const html = one({ ctxPct: 62 });
  const dash = /stroke-dasharray="([\d.]+) ([\d.]+)"/.exec(html);
  assert.ok(dash, 'the arc carries a dash array');
  const [filled, empty] = [Number(dash[1]), Number(dash[2])];
  assert.ok(Math.abs(filled / (filled + empty) - 0.62) < 0.001, `${filled} of ${filled + empty} is not 62%`);
  assert.doesNotMatch(html, /pathLength/, 'nothing normalises the circle out from under it');
});

test('a full context window fills the ring, and no more', () => {
  const dash = /stroke-dasharray="([\d.]+) ([\d.]+)"/.exec(one({ ctxPct: 100 }))!;
  assert.equal(Number(dash[2]), 0);
});

test('a session with no reading gets a dash and the reason, never a ring', () => {
  const html = one({ ctxPct: null, ctxState: 'absent', snapshotAgeMs: null });
  assert.match(html, /not chained/);
  assert.match(html, /&mdash;|—/);
  // No arc at all, rather than one drawn at zero: an arc of zero length is what a session
  // measured at 0% would get, and "I could not look" is not "the value is zero".
  assert.doesNotMatch(html, /class="arc"/);
});

test('the two other kinds of missing keep their own words', () => {
  assert.match(one({ ctxPct: null, ctxState: 'fresh', snapshotAgeMs: null }), /no turn yet/);
  assert.match(one({ ctxPct: null, ctxState: 'drift', snapshotAgeMs: null }), /schema drift/);
});

// The dial that says "nothing was measured" is keyed on the measurement, never on the age of
// the file. `fresh` and `drift` have a snapshot as current as any — and no number in it, so
// they got the solid ring of a session measured at zero, and a halo on top of it.
test('a session with a fresh snapshot and no number in it still reads as unmeasured', () => {
  for (const ctxState of ['fresh', 'drift'] as const) {
    const html = one({ ctxPct: null, ctxState, snapshotAgeMs: 1200, stale: false });
    assert.match(html, /class="track unmeasured"/, ctxState);
    assert.doesNotMatch(html, /class="halo"/, `${ctxState} has nothing to pulse about`);
  }
});

test('a session measured at zero keeps the solid dial of a real reading', () => {
  const html = one({ ctxPct: 0, ctxState: 'ok', snapshotAgeMs: 1200 });
  assert.doesNotMatch(html, /unmeasured/);
  assert.match(html, /class="pct">0<i>%/);
});

// The red line: a reading four hours old may not be drawn as though it were live.
test('a stale node says so, and is marked as stale in its own markup', () => {
  const html = one({ ctxPct: 47, snapshotAgeMs: 3 * 3600_000, stale: true });
  assert.match(html, /data-reading="stale"/);
  assert.match(html, /! 3h ago/);
});

test('a live node is not marked stale and carries no age', () => {
  const html = one({ ctxPct: 47, snapshotAgeMs: 4000, stale: false });
  assert.match(html, /data-reading="live"/);
  assert.doesNotMatch(html, /ago/);
});

// Same refusal as the table's "— ahead": an age that cannot be told is not a fresh one.
test('a reading dated in the future is shown undated', () => {
  const html = one({ ctxPct: 19, snapshotAgeMs: -4000 });
  assert.match(html, /data-reading="undated"/);
  assert.match(html, /class="asof stale">! undated/, 'in words, not only in an attribute');
});

// The contradiction `ctxCell` was written to prevent, on the other surface: "!" says past the
// threshold, "0m" says brand new. `--stale-after` accepts seconds, so a 30s reading judged
// against a 2s threshold is exactly that pair.
test('a stale reading under a minute old is dated, never "0m ago"', () => {
  const html = one({ ctxPct: 47, snapshotAgeMs: 30_000, stale: true });
  assert.doesNotMatch(html, /! 0m ago/);
  assert.match(html, /! &lt;1m ago/);
});

// The halo is the pulse: it is drawn only for a reading that just landed, so a node the
// fleet calls stale has nothing on it that can animate.
test('a reading that just landed pulses, and a stale one never does', () => {
  assert.match(one({ snapshotAgeMs: 1000, stale: false }), /class="halo"/);
  assert.doesNotMatch(one({ snapshotAgeMs: 4 * 3600_000, stale: true }), /class="halo"/);
});

// The table's pill is "● busy" for a reason: shape, word and border, so the state survives a
// reader who cannot separate two hues. The map's three glyphs differ in silhouette, which
// covers that reader — but a screen reader is handed "●" and nothing else, and an unrecognised
// status, the one state the table spells out in full, disappears entirely.
test('a node names its state in words, not only in a shape', () => {
  assert.match(one({ busy: true }), /<span class="sr">busy<\/span>/);
  assert.match(one({ busy: false }), /<span class="sr">idle<\/span>/);
  assert.match(one({ busy: null, status: 'compacting' }), /<span class="sr">compacting<\/span>/);
});

test('a busy session is marked busy, and an unknown status is not marked idle', () => {
  assert.match(one({ busy: true }), /data-state="busy"/);
  assert.match(one({ busy: null, status: 'compacting' }), /data-state="unknown"/);
});

// The node this whole lot is for: a session blocked on a human, drawn as its own state and
// captioned with the answer it is waiting for — the one thing a reader can act on.
test('a waiting node is drawn as waiting, captioned with what it waits for', () => {
  const html = one({ busy: null, status: 'waiting', waitingFor: 'permission prompt' });
  assert.match(html, /data-state="waiting"/);
  assert.match(html, /<span class="sr">waiting<\/span>/, 'and the word, for a reader handed only a glyph');
  assert.match(html, /class="sub waiting-for">permission prompt</);
});

// The caption is a field, and the field can be absent. An empty line under the name says
// "waiting for nothing", which is the one thing it never means.
test('a waiting node with no reason carries no caption at all', () => {
  const html = one({ busy: null, status: 'waiting', waitingFor: null });
  assert.match(html, /data-state="waiting"/);
  assert.doesNotMatch(html, /waiting-for/);
});

// The empty string is the same absence wearing different clothes: the server copies of the
// rule check truthiness, like the client one always has.
test('an empty reason draws neither the caption nor the pill separator', () => {
  const empty = fleet([row({ busy: null, status: 'waiting', waitingFor: '' })]);
  assert.doesNotMatch(renderMap(empty), /waiting-for/);
  assert.doesNotMatch(renderPage(empty, 'table'), /waiting · </);
});

test('a background agent is drawn as an agent, and names what it is', () => {
  const html = renderMap(
    fleet([
      row({ sessionId: 'a', kind: 'interactive', cwd: '/w', project: 'apollo', name: 'apollo-7a' }),
      row({ sessionId: 'b', kind: 'background', cwd: '/w', project: 'apollo', name: 'sweep-01' }),
    ]),
  );
  assert.match(html, /data-role="agent"/);
  assert.match(html, /background/);
  assert.match(html, /sweep-01/);
});

// The kind is printed whenever it is not the one we know, whatever the node was drawn as.
// The fleet-level guard can decide a lone background session is a renamed terminal, and a
// node that says nothing about what it is would make that decision invisible.
test('a session of an unfamiliar kind says so, even when it is drawn as a session', () => {
  const html = one({ kind: 'background' });
  assert.match(html, /data-role="session"/, 'nothing anchors this fleet');
  assert.match(html, /background/, 'and it still says what it calls itself');
});

test('the kind we know is not printed on every node as noise', () => {
  assert.doesNotMatch(one({ kind: 'interactive' }), /interactive/);
});

// An agent is PLACED next to its session, and placement is not a promise: the grid wraps, so
// the node above an agent can be a session from another directory entirely, and the fleet's
// own sort can hand the same agent a different neighbour on the next poll. So the agent says
// which directory it belongs to itself, rather than pointing at whoever is beside it.
test('an agent names its own directory, so its placement can be checked', () => {
  const html = renderMap(
    fleet([
      row({ sessionId: 'a', kind: 'interactive', cwd: '/w', project: 'apollo', name: 'apollo-7a' }),
      row({ sessionId: 'b', kind: 'background', cwd: '/w', project: 'apollo', name: 'sweep-01' }),
    ]),
  );
  const agent = html.slice(html.indexOf('data-role="agent"'));
  assert.match(agent, /apollo/, 'the agent carries its project');
  assert.doesNotMatch(html, /&#8627;/, 'and points at nobody');
});

// ── the strip ────────────────────────────────────────────────────────────────────────────
//
// What an agent is drawn as. Anchored by a terminal, so the fleet-level guard cannot decide
// these background entries are a renamed kind, and stripped of every statusline-derived
// field: a background session has no terminal, so context, model, effort and cost are not
// late for it — they are never coming.

const strip = (a: Partial<FleetRow> = {}): string => {
  const html = renderMap(
    fleet([
      row({ sessionId: 'i', kind: 'interactive', cwd: '/w', project: 'harbor', name: 'harbor-3f' }),
      row({
        sessionId: 'b',
        kind: 'background',
        cwd: '/w',
        project: 'harbor',
        name: 'sweep the flaky specs',
        pid: null,
        ctxState: 'absent',
        ctxPct: null,
        ctxTokens: null,
        snapshotAgeMs: null,
        model: null,
        effort: null,
        costUsd: null,
        ...a,
      }),
    ]),
  );
  return html.slice(html.indexOf('data-role="agent"'));
};

test('an agent is a strip: its project, what it is, and the prompt it was given', () => {
  const html = strip();
  assert.doesNotMatch(html, /class="dial"/, 'no dial');
  assert.doesNotMatch(html, /class="track/, 'and nothing left of one');
  assert.match(html, /class="project">harbor</);
  assert.match(html, /class="kind">background</);
  assert.match(html, /class="prompt">sweep the flaky specs</);
});

// The correction this whole shape is for. A dial captioned "not chained" is the vocabulary of
// a fault someone could go and repair — `tarmac install` and the session is covered — said
// about a session that has no terminal for a statusline to be chained into. The absence of a
// SURFACE is not a missing measurement, and a strip says nothing rather than saying that.
test('a strip claims no context at all, rather than reporting one as missing', () => {
  const html = strip();
  assert.doesNotMatch(html, /not chained/);
  assert.doesNotMatch(html, /no reading/);
  assert.doesNotMatch(html, /&mdash;|—/, 'not even the dash that says a value was expected');
});

// If the source ever does publish a percentage for a background session, it is a reading like
// any other and is printed — inline, where the two lines are, rather than growing the dial back.
test('a percentage the source did publish for an agent is printed on its strip', () => {
  const html = strip({ ctxPct: 41, ctxState: 'ok', snapshotAgeMs: 1200, stale: false });
  assert.match(html, /41%/);
  assert.doesNotMatch(html, /class="dial"/);
});

// And it keeps the one thing that makes a number honest: a reading past the threshold may not
// be read as current on a strip any more than in a ring.
test('a reading printed on a strip carries its age when it is one nobody should trust', () => {
  const html = strip({ ctxPct: 41, ctxState: 'ok', snapshotAgeMs: 3 * 3600_000, stale: true });
  assert.match(html, /data-reading="stale"/);
  assert.match(html, /! 3h ago/);
  assert.doesNotMatch(html, /class="dial"/);
});

// The state a reader can act on, on the node the old shape was worst at: a background agent
// halted on a human answered with a dial full of nothing and a word in six-point type.
test('a background agent halted on a human is drawn waiting, and says what it waits for', () => {
  const html = strip({ busy: null, status: 'waiting', waitingFor: 'permission prompt' });
  assert.match(html, /data-state="waiting"/);
  assert.match(html, /<span class="sr">waiting<\/span>/);
  assert.match(html, /class="sub waiting-for">permission prompt</);
  assert.doesNotMatch(html, /class="dial"/);
});

// Same two channels as a card — the glyph for a reader who cannot separate two hues, the word
// for one who is handed no glyph at all. A shape that changed with the layout would be a state
// that reads differently depending on which node it landed on.
test('a strip names its state in words and in a glyph, exactly as a card does', () => {
  assert.match(strip({ busy: true }), /<span class="shape" aria-hidden="true">●<\/span><span class="sr">busy<\/span>/);
  assert.match(strip({ busy: false }), /<span class="sr">idle<\/span>/);
  assert.match(strip({ busy: null, status: 'compacting' }), /data-state="unknown"/);
  assert.match(strip({ busy: null, status: 'compacting' }), /<span class="sr">compacting<\/span>/);
  assert.doesNotMatch(strip({ busy: true }), /class="dial"/);
});

// Nothing is lost by this: the halo lives inside the dial, and the reading it announces comes
// off a statusline frame no background session can produce. A strip that pulsed would be
// announcing the arrival of the one thing this shape exists to stop claiming.
test('a strip never pulses', () => {
  const html = strip({ ctxPct: 40, ctxState: 'ok', snapshotAgeMs: 1000, stale: false });
  assert.doesNotMatch(html, /class="halo"/);
  assert.doesNotMatch(html, /just landed/);
});

// The escaping test above reaches the card, never this branch: a fleet of one background entry
// is not anchored, so it renders as a session. The strip draws four strings off another
// machine of its own — and the prompt is the one a person typed, which is the least trusted
// string on the page.
test('every value the machine supplies reaches a strip escaped', () => {
  const nasty = '<script>alert(1)</script>';
  for (const field of ['project', 'name', 'kind'] as const) {
    assert.doesNotMatch(strip({ [field]: nasty }), /<script>/, field);
  }
  assert.doesNotMatch(strip({ busy: null, status: 'waiting', waitingFor: nasty }), /<script>/, 'waitingFor');
});

// An orphan is still a node. Its directory matches no session on this machine — the one it was
// dispatched from has since been closed — and the map's promise is that it counts the same.
test('an agent whose directory matches no session is a strip like any other', () => {
  const html = renderMap(
    fleet([
      row({ sessionId: 'i', kind: 'interactive', cwd: '/w', project: 'harbor', name: 'harbor-3f' }),
      row({ sessionId: 'o', kind: 'background', cwd: '/gone', project: 'quarry', name: 'rebuild the docs index' }),
    ]),
  );
  const orphan = html.slice(html.indexOf('data-role="agent"'));
  assert.match(orphan, /class="project">quarry</);
  assert.match(orphan, /class="prompt">rebuild the docs index</);
  assert.doesNotMatch(orphan, /class="dial"/);
});

// The halo lives inside an `aria-hidden` <svg>, so the one thing on this page that moves was
// also the one fact on it a reader who is not looking got nothing of. Said, not shown — the
// same rule as the shape beside it, which already carries its word.
test('the halo says in words that a reading just landed', () => {
  assert.match(one({ snapshotAgeMs: 1000, stale: false }), /<span class="sr">a reading just landed<\/span>/);
  assert.doesNotMatch(one({ snapshotAgeMs: 4 * 3600_000, stale: true }), /just landed/);
  // The negative that matters, and the one the words could get wrong on their own: a file
  // landed, a reading did not. A drifted fleet writes a snapshot every frame, and "a reading
  // just landed" on every node of it would be the calm, wrong answer said out loud.
  assert.doesNotMatch(one({ ctxPct: null, ctxState: 'drift', snapshotAgeMs: 1200, stale: false }), /just landed/);
});

// The colour a node's halo ends up with, as the cascade resolves it: the `.node[data-state=…]`
// rule if the stylesheet has one, and the bare `.halo` otherwise — the class selector on the
// left of the descendant combinator can never outrank it.
const paint = (cls: string, prop: string, state: string): string => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(renderPage(fleet([row()]), 'map'))![1]
    // Comments first, or a selector captured as "everything since the last brace" is the prose
    // above the rule as well — and every rule down here is explained by a paragraph naming it.
    .replace(/\/\*[\s\S]*?\*\//g, '');
  let base = '';
  let override = '';
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selector, declarations] = m;
    if (!new RegExp(`\\.${cls}\\b`).test(selector)) continue;
    const value = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(declarations)?.[1].trim();
    if (value === undefined) continue;
    const on = /data-state="(\w+)"/.exec(selector)?.[1];
    if (on === undefined) base = value;
    else if (on === state) override = value;
  }
  return override || base;
};

// The halo was strokeed `var(--busy)` with a single idle override — which is already the
// admission that its colour was never a pure freshness token, because somebody refused to
// pulse green over an idle node. The refusal was never extended: on main an unknown node
// pulses green, and since #46 a waiting one does too, in the hue of the one state it is
// certainly not. Its PRESENCE is the freshness signal; its colour is the node's own.
test("the halo pulses in the node's own hue, never in a state the node is not", () => {
  assert.equal(paint('halo', 'stroke', 'busy'), 'var(--busy)');
  assert.equal(paint('halo', 'stroke', 'waiting'), 'var(--wait)');
  assert.equal(paint('halo', 'stroke', 'unknown'), 'var(--warn)');
  assert.equal(paint('halo', 'stroke', 'idle'), 'var(--dim)');
});

// Two channels saying the state of one node, so they may not be able to disagree about it.
// Written as a comparison rather than a second list of hues: the day a state changes colour,
// the ring around the dial and the glyph under the name change together or this goes red.
test('the halo and the glyph beside it agree on what every state looks like', () => {
  for (const state of ['busy', 'waiting', 'unknown', 'idle']) {
    assert.equal(paint('halo', 'stroke', state), paint('shape', 'color', state), state);
  }
});

// The strip has no ring to carry its state, so the state is carried by the accent down its
// left edge — the same three-pixel border, in the same hues, the table's rows wear on a phone.
// Written as a comparison for the reason the one above it is: the day a state changes colour,
// the accent and the glyph move together or this goes red.
test("a strip's left accent is the node's own hue, the one its glyph already carries", () => {
  for (const state of ['busy', 'waiting', 'unknown', 'idle']) {
    assert.equal(paint('node', 'border-left-color', state), paint('shape', 'color', state), state);
  }
});

/** One `@media` rule's declarations, braces balanced — which the flat scan above cannot do. */
function atMedia(query: string): string {
  const css = /<style>([\s\S]*?)<\/style>/.exec(renderPage(fleet([row()]), 'map'))![1];
  const start = css.indexOf(`@media ${query}`);
  assert.notEqual(start, -1, `no @media ${query} in the stylesheet`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i);
  }
  throw new Error(`@media ${query} is never closed`);
}

// A strip in half a phone's width is an ellipsis where the prompt was: the one line that says
// what this agent was told to do is the first thing a narrow column takes away. It spans the
// row instead, which is what the table's own cells do at the same breakpoint.
test('a strip spans the width of a phone rather than sharing it with a card', () => {
  assert.match(atMedia('(max-width: 46rem)'), /\.node\[data-role="agent"\][^{]*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
});

// Both views are in the fragment, and one of them is behind `display:none` — so a sentence
// each rendered for itself was read twice by anything that goes through the markup rather
// than looking at the page.
test('an empty fleet says so once, not once per view', () => {
  const live = renderLive(fleet([], { sessions: 0, covered: 0 }));
  assert.equal((live.match(/No Claude Code sessions found/g) ?? []).length, 1);
});

// Everything on this page comes off a machine whose directories and session names are
// someone else's strings.
test('a session name is escaped, not drawn', () => {
  const html = one({ name: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

// Every one of these comes off someone else's machine: the model and the effort are strings
// out of a JSON payload tarmac does not own, and the kind out of `claude agents --json`.
test('every value the machine supplies is escaped', () => {
  const nasty = '<script>alert(1)</script>';
  for (const field of ['project', 'model', 'effort', 'kind', 'status'] as const) {
    const html = renderMap(fleet([row({ [field]: nasty, busy: null, kind: field === 'kind' ? nasty : 'background', cwd: '/w' })]));
    assert.doesNotMatch(html, /<script>/, field);
  }
  // The reason a session is waiting is one of them, and it only reaches the page beside the
  // word that puts it there — a documented vocabulary today, a string off another process
  // either way.
  assert.doesNotMatch(renderMap(fleet([row({ busy: null, status: 'waiting', waitingFor: nasty })])), /<script>/);
});

// ── the page around it ───────────────────────────────────────────────────────────────────

// The rule that outranks every layout question here: whatever the map does with an entry, it
// may not answer with a smaller fleet than the table sitting in the same fragment.
test('the map and the table count the same sessions', () => {
  const rows = [
    row({ sessionId: 'a', kind: 'interactive', cwd: '/x', name: 'a' }),
    row({ sessionId: 'b', kind: 'background', cwd: '/x', name: 'b' }),
    row({ sessionId: 'c', kind: 'background', cwd: '/gone', name: 'c' }),
    row({ sessionId: 'd', kind: null, cwd: null, name: 'd' }),
    row({ sessionId: 'e', kind: 'interactive', cwd: '/x', name: 'e' }),
  ];
  const live = renderLive(fleet(rows, { sessions: rows.length }));
  assert.equal((live.match(/<tr data-state=/g) ?? []).length, rows.length);
  assert.equal((live.match(/<article class="node"/g) ?? []).length, rows.length);
});

test('the page carries both views, so one refresh feeds them both', () => {
  const html = renderPage(fleet([row()]), 'map');
  assert.match(html, /<table/, 'the table is still rendered');
  assert.match(html, /class="map"/);
});

test('the page opens on the view that was asked for', () => {
  assert.match(renderPage(fleet([row()]), 'map'), /<body data-view="map"/);
  assert.match(renderPage(fleet([row()]), 'table'), /<body data-view="table"/);
});

// The tabs are links, not script: the view survives a refresh, a bookmark and a browser with
// JavaScript turned off — the same page the noscript banner promises is still readable.
test('the tabs are links, and the current one says so', () => {
  const html = renderPage(fleet([row()]), 'map');
  assert.match(html, /<a href="\/"[^>]*>Table<\/a>/);
  assert.match(html, /<a href="\/map" aria-current="page">Map<\/a>/);
});
