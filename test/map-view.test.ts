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

/** How deep the `<article>` nesting goes: 1 on a page where no node is drawn inside another. */
function deepestArticle(html: string): number {
  let depth = 0;
  let deepest = 0;
  for (const m of html.matchAll(/<(\/?)article\b/g)) {
    depth += m[1] === '' ? 1 : -1;
    deepest = Math.max(deepest, depth);
  }
  return deepest;
}

// The pair, and the split between them: the frame says where the node was read, the card says
// which node it is. Inside a berth the project is on the frame, so a card that printed it too
// would say `apollo` four times around one directory.
test('a node carries its session name and its context, and its berth the project', () => {
  const html = one({ project: 'apollo', name: 'alpha-7a', ctxPct: 62 });
  assert.match(html, /class="berth-label">apollo</);
  assert.match(html, /class="name">alpha-7a</);
  assert.match(html, /62/);
  assert.equal((html.match(/apollo/g) ?? []).length, 2, 'once in the label, once in the frame it names');
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
// reader who cannot separate two hues. The map's four glyphs differ in silhouette, which
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

// ── the berth ────────────────────────────────────────────────────────────────────────────
//
// One frame per working directory. What it claims is exactly that — the nodes inside it were
// read in one directory — and the red line of the whole shape is what it must never claim:
// which of them dispatched which. The source publishes no such field.

test('the nodes of one directory are drawn inside one frame, labelled with the project', () => {
  const html = renderMap(
    fleet([
      row({ sessionId: 'a', kind: 'interactive', cwd: '/w', project: 'apollo', name: 'apollo-7a' }),
      row({ sessionId: 'b', kind: 'background', cwd: '/w', project: 'apollo', name: 'sweep-01' }),
    ]),
  );
  assert.equal((html.match(/<section class="berth"/g) ?? []).length, 1);
  assert.match(html, /class="berth-label">apollo</);
  assert.match(html, /class="berth-cards">[\s\S]*apollo-7a/);
  assert.match(html, /class="berth-strips">[\s\S]*sweep-01/);
});

// The claim the frame is NOT allowed to make. Two sessions and two agents in one directory:
// no node is inside another, nothing points at anything, and no word on the page says one of
// them asked for another — because `claude agents --json` publishes nobody's parent.
test('a berth of four says they share a directory, and nothing about who dispatched whom', () => {
  const html = renderMap(
    fleet([
      row({ sessionId: 'a', kind: 'interactive', cwd: '/w', project: 'harbor', name: 'harbor-3f' }),
      row({ sessionId: 'b', kind: 'interactive', cwd: '/w', project: 'harbor', name: 'harbor-9k' }),
      row({ sessionId: 'c', kind: 'background', cwd: '/w', project: 'harbor', name: 'sweep-01' }),
      row({ sessionId: 'd', kind: 'background', cwd: '/w', project: 'harbor', name: 'draft the notes' }),
    ]),
  );
  assert.equal((html.match(/<section class="berth"/g) ?? []).length, 1);
  assert.equal((html.match(/<article class="node"/g) ?? []).length, 4);
  // The structural half: a node inside another node is the parentage drawn, whatever the
  // labels say. Counted rather than pattern-matched — four siblings satisfy any regex for
  // "an <article> and then another one".
  assert.equal(deepestArticle(html), 1, 'no node is inside another');
  assert.doesNotMatch(html, /&#8627;/, 'and nothing points at anything');
  for (const word of [/parent/i, /child/i, /dispatch/i, /spawned/i]) assert.doesNotMatch(html, word);
});

// Two frames, two labels, and each holds only what was read in its own directory.
test('two directories are two frames, in the order the fleet handed them over', () => {
  const html = renderMap(
    fleet([
      row({ sessionId: 'a', kind: 'interactive', cwd: '/w/apollo', project: 'apollo', name: 'apollo-7a' }),
      row({ sessionId: 'b', kind: 'interactive', cwd: '/w/orion', project: 'orion', name: 'orion-11' }),
      row({ sessionId: 'c', kind: 'background', cwd: '/w/apollo', project: 'apollo', name: 'sweep-01' }),
    ]),
  );
  assert.deepEqual([...html.matchAll(/class="berth-label">(\w+)</g)].map((m) => m[1]), ['apollo', 'orion']);
  assert.ok(html.indexOf('sweep-01') < html.indexOf('orion-11'), 'the agent stays in the frame it belongs to');
});

// The frame is named for a reader who is handed no border at all — and named as a GROUP, the
// idiom this page already uses three times over. A `<section>` with an accessible name is a
// region, which is a landmark: one per working directory turns a busy machine into a page of
// landmarks, all of them called after a basename, several of them possibly called the same
// thing. The name is what a frame is worth to a screen reader; a place in the landmark index
// is not.
test('a frame is named as a group, not as one landmark per directory', () => {
  const html = one({ project: 'apollo' });
  assert.match(html, /<section class="berth" role="group" aria-label="apollo">/);
});

// And the label is a heading, which is the other way through a page: a reader who navigates by
// headings meets the directories in order. Dropping to a `<div>` looks identical and takes
// that away.
test('the label of a frame is a heading, not a line of styled text', () => {
  assert.match(one({ project: 'apollo' }), /<h2 class="berth-label">apollo<\/h2>/);
});

// The frame is a frame. Nothing else on this view draws a box around a claim, and a berth
// whose border went missing is a label floating over a group nobody can see the edges of.
test('a berth is bordered — the frame is the claim', () => {
  assert.match(declared('.berth', 'border'), /1px solid/);
});

// DOM order is the visual order, so a reader going through the markup meets the cards and the
// strips of a berth in the order they are drawn — and nothing in the sheet reorders them.
test('the cards of a berth come before its strips, in the markup as on the screen', () => {
  const html = renderMap(
    fleet([
      row({ sessionId: 'b', kind: 'background', cwd: '/w', project: 'harbor', name: 'sweep-01' }),
      row({ sessionId: 'a', kind: 'interactive', cwd: '/w', project: 'harbor', name: 'harbor-3f' }),
    ]),
  );
  assert.ok(html.indexOf('harbor-3f') < html.indexOf('sweep-01'), 'the card first, whatever order they arrived in');
  // `order` moves a flex item past its siblings, and nothing this view draws may be moved. It
  // is scoped to those elements rather than refused across the whole sheet, because the table's
  // phone strip declares it too — to wedge a line break between the state and the first number,
  // never to reorder, which `phone-view` pins against the columns `renderRow` emits.
  for (const [, raw, declarations] of mapCss().matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(?:^|;)\s*order\s*:/.test(declarations)) continue;
    const selector = raw.slice(raw.lastIndexOf('}') + 1).trim();
    assert.doesNotMatch(selector, /\.map\b|\.berth|\.node\b|\.strip\b/, `${selector} moves a node past its siblings`);
  }
  assert.doesNotMatch(mapCss(), /flex-direction:\s*\w+-reverse/);
  // `wrap-reverse` reverses the ROWS: the berths keep their order along each line and the
  // lines stack upwards, so the fleet's first frame ends up at the bottom of the page.
  assert.doesNotMatch(mapCss(), /flex-wrap:\s*\w+-reverse/);
});

// The same red line, drawn where the markup cannot refuse it: geometry. Indenting the strips
// under the cards and running a rail down their left edge is the diagram of a tree — "these
// strips hang off those cards" — which is the one thing a berth is not allowed to say, and the
// source publishes nothing that could make it true. It reads as a tidy-up, it passes every
// other assertion here, and it says in a border what the whole feature says it will not say.
test('the strips are not indented under the cards — a rail there would draw a parentage', () => {
  assert.deepEqual(leftInsetsOnStrips(), []);
});

// A frame's name is an attribute, and this page answers an absent value with an ELEMENT — a
// dash in a span. A label that ever came out empty put that span inside `aria-label="…"`,
// where its own quotes end the attribute: markup in a slot that takes a string. The label the
// model hands over is never empty, and this is the assertion that says so from out here.
test('a frame is named with a string, never with the markup of a missing one', () => {
  for (const r of [{ cwd: '/', project: '' }, { cwd: null, project: null }, { project: 'apollo' }]) {
    const label = /aria-label="([^"]*)"/.exec(renderMap(fleet([row(r)])))?.[1];
    assert.ok(label, `no aria-label at all for ${JSON.stringify(r)}`);
    assert.doesNotMatch(label, /[<>]/, `${JSON.stringify(r)} named the frame with markup`);
  }
});

// A label off someone else's filesystem, in an attribute and in text.
test('a berth label is escaped in both places it is printed', () => {
  const html = renderMap(fleet([row({ project: '"><script>alert(1)</script>' })]));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /aria-label="&quot;&gt;&lt;script&gt;/);
});

// ── the strip ────────────────────────────────────────────────────────────────────────────
//
// What an agent is drawn as. Anchored by a terminal, so the fleet-level guard cannot decide
// these background entries are a renamed kind, and with no snapshot behind it — the common
// agent, and the one the shape was designed for. The strip's rule about the rest is that it
// prints what that session's snapshot published and nothing where nothing was published, so
// the fleet's two cases are both here: this one, and `measured` below it.

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

// The strip spends its one line on what tells two agents in one berth apart: the prompt it was
// named after and the kind it calls itself. The directory is the frame around it, said once.
test('an agent is a strip: what it is, and the prompt it was given', () => {
  const html = strip();
  assert.doesNotMatch(html, /class="dial"/, 'no dial');
  assert.doesNotMatch(html, /class="track/, 'and nothing left of one');
  assert.match(html, /class="kind">background</);
  assert.match(html, /class="prompt">sweep the flaky specs</);
  assert.doesNotMatch(html, /harbor/, 'the frame around it says the directory; the strip does not repeat it');
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

/**
 * The other case, and the one no fixture held: an agent the join DID find a payload for.
 * Every strip above has a null snapshot behind it, which is why nothing on this page ever
 * showed what a published one looks like — and the fleet builds all four fields off that one
 * object, so a reading arrives with the model and the effort or the file does not exist.
 */
const measured = (a: Partial<FleetRow> = {}): string =>
  strip({ ctxState: 'ok', ctxPct: 61, snapshotAgeMs: 1200, stale: false, model: 'Fable 5', effort: 'max', ...a });

// The publication rule, in the direction that says what IS printed. A snapshot is one file:
// dropping the model and the effort out of a line that prints the percentage from beside them
// is the page choosing which published facts to pass on.
test('a strip prints what the snapshot published: the reading, the model and the effort', () => {
  const html = measured();
  assert.match(html, /class="sub">ctx 61% · Fable 5 · max</);
  assert.doesNotMatch(html, /class="dial"/, 'still inline, rather than growing the dial back');
});

// A card has a ring around its number and the table a column header over it. A strip has
// neither, so a bare `61%` under a line of prompt is a progress bar to anyone reading quickly
// — the one thing a context reading is not.
test('the number on a strip says which quantity it is', () => {
  assert.doesNotMatch(measured(), /class="sub">61%/);
});

// The same rule in the direction that says what is NOT printed: no line at all, rather than an
// empty one or the dash that says a value was expected.
test('an agent with no snapshot behind it prints none of the three', () => {
  assert.doesNotMatch(strip(), /class="sub"/);
});

// And it is per FIELD, not per file. `fresh` and `drift` are snapshots as current as any with
// no percentage in them, and the model in that same file is still a fact the source published.
test('a field the snapshot left empty is the only one dropped', () => {
  assert.match(measured({ ctxPct: null, ctxState: 'fresh' }), /class="sub">Fable 5 · max</);
  assert.match(measured({ effort: null }), /class="sub">ctx 61% · Fable 5</);
});

// And it keeps the one thing that makes a number honest: a reading past the threshold may not
// be read as current on a strip any more than in a ring.
test('a reading printed on a strip carries its age when it is one nobody should trust', () => {
  const html = measured({ snapshotAgeMs: 3 * 3600_000, stale: true });
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
  for (const field of ['name', 'kind'] as const) {
    assert.doesNotMatch(strip({ [field]: nasty }), /<script>/, field);
  }
  assert.doesNotMatch(strip({ busy: null, status: 'waiting', waitingFor: nasty }), /<script>/, 'waitingFor');
});

// An orphan is still a node. Its directory matches no session on this machine — the one it was
// dispatched from has since been closed — and the map's promise is that it counts the same. It
// gets a berth of its own rather than being tucked into somebody else's: a frame is a claim
// about a directory, and this agent's is not theirs.
test('an agent whose directory matches no session is a berth of its own', () => {
  const html = renderMap(
    fleet([
      row({ sessionId: 'i', kind: 'interactive', cwd: '/w', project: 'harbor', name: 'harbor-3f' }),
      row({ sessionId: 'o', kind: 'background', cwd: '/gone', project: 'quarry', name: 'rebuild the docs index' }),
    ]),
  );
  assert.deepEqual([...html.matchAll(/class="berth-label">(\w+)</g)].map((m) => m[1]), ['harbor', 'quarry']);
  const orphan = html.slice(html.indexOf('aria-label="quarry"'));
  assert.match(orphan, /class="prompt">rebuild the docs index</);
  assert.doesNotMatch(orphan, /class="dial"/, 'still a strip, with no card in the frame beside it');
  assert.doesNotMatch(orphan, /class="berth-cards"/);
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

/**
 * The stylesheet the map ships with, comments stripped — a selector captured as "everything
 * since the last brace" is otherwise the prose above the rule as well, and every rule down
 * there is explained by a paragraph naming it.
 */
const mapCss = (): string =>
  /<style>([\s\S]*?)<\/style>/.exec(renderPage(fleet([row()]), 'map'))![1].replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * One EXACT selector's value for a property. `paint` keys on a class and keeps whichever rule
 * set the property last, which cannot tell `.node` from `.node[data-role="agent"]` — and those
 * two disagree about alignment on purpose, which is the whole shape of a strip.
 */
const declared = (selector: string, prop: string): string => {
  for (const [, raw, declarations] of mapCss().matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // A rule that follows a closing brace carries it into the capture — the `}` of an @media
    // block, or of the rule above. The selector is what comes after the last one.
    if (raw.slice(raw.lastIndexOf('}') + 1).trim() !== selector) continue;
    const value = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(declarations)?.[1].trim();
    if (value !== undefined) return value;
  }
  return '';
};

/**
 * Every value the sheet gives one property on one EXACT selector, in source order, `@media`
 * blocks included. `declared` answers with the first it finds and cannot tell a top-level rule
 * from a scoped one, which is enough to read a value and wrong to assert a guarantee: a later
 * rule taking the property back, or the declaration moved inside a media query so it holds on
 * one viewport and nowhere else, both leave `declared` answering with the value the page wanted
 * and no longer has. Both mutations pass against `declared`; neither passes against this.
 */
const declaredEverywhere = (selector: string, prop: string, css: string = mapCss()): string[] => {
  const found: string[] = [];
  for (const [, raw, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (raw.slice(raw.lastIndexOf('}') + 1).trim() !== selector) continue;
    const value = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(declarations)?.[1].trim();
    if (value !== undefined) found.push(value);
  }
  return found;
};

/**
 * The sheet with every `@media` block cut out, so a rule scoped to one viewport cannot answer
 * for the page. Needed because the flat scans above read a selector as whatever follows the
 * last `}`, which is true of a nested rule too: without this, moving a declaration from the
 * top level into the phone block satisfies both of them while the page loses it everywhere a
 * phone is not.
 */
const cssOutsideMedia = (): string => {
  const css = mapCss();
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
};

/**
 * Every declaration in the sheet that would inset a `.berth-strips` box from the left, whatever
 * spelling it arrives in — reported as text so a failure names the rule it found.
 *
 * Written as a sweep rather than as three assertions on three longhands because the longhands
 * are the spelling nobody would reach for. The rule already carries `margin-top`, so collapsing
 * it into a `margin:` shorthand is the tidy-up an editor makes without thinking, and it draws
 * the rail with every other assertion here green. Same for the logical properties, for a border
 * on a descendant, and for a `translateX`, which moves the box without declaring an inset at
 * all. Any border is refused outright: nothing about this container wants one, and a border on
 * its left edge is the rail itself.
 */
const leftInsetsOnStrips = (): string[] => {
  // The left of a `margin`/`padding` shorthand: four values name it fourth, two or three name
  // it second, one names it alone.
  const left = (shorthand: string): string => {
    const parts = shorthand.trim().split(/\s+/);
    return parts[3] ?? parts[1] ?? parts[0];
  };
  const isZero = (v: string): boolean => /^0[a-z%]*$/.test(v.trim());
  const found: string[] = [];
  for (const [, raw, declarations] of mapCss().matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = raw.slice(raw.lastIndexOf('}') + 1).trim();
    if (!/\.berth-strips\b/.test(selector)) continue;
    for (const [, prop, value] of declarations.matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)) {
      const offends =
        (/^(margin|padding)$/.test(prop) && !isZero(left(value)))
        || (/^(margin|padding)-(left|inline-start)$/.test(prop) && !isZero(value))
        || /^border/.test(prop)
        || prop === 'transform';
      if (offends) found.push(`${selector} { ${prop}: ${value.trim()} }`);
    }
  }
  return found;
};

// The shape itself, which had no test at all: a strip is a line of text down the left edge of
// its cell, inside a grid whose every other node is centred on a dial. Both declarations are
// on the agent's own rule and both are reversed by the `.node` rule above it, so neither can
// be checked by the class-wide scan.
test('a strip is a left-aligned band, in a grid of centred cards', () => {
  assert.equal(declared('.node[data-role="agent"]', 'align-items'), 'stretch');
  assert.equal(declared('.node[data-role="agent"]', 'text-align'), 'left');
  assert.equal(declared('.node', 'align-items'), 'center', 'and a card is still centred on its dial');
  assert.equal(declared('.node', 'text-align'), 'center');
});

// The rule that now belongs to the OTHER surface. A live strip prints no project — the berth
// around it says the directory — so the only `.project` left inside an agent is the one the
// browser copy draws behind the scrubber, where there is no berth and the project is all the
// ring kept. Deleting the rule with the markup that used to need it left that name a size and
// a half too big, in the one place this suite renders no HTML of its own.
test("a replayed strip keeps the project's own size, now that no live strip prints one", () => {
  assert.equal(declared('.node[data-role="agent"] .project', 'font-size'), '.8rem');
  assert.doesNotMatch(renderMap(fleet([row({ kind: 'background', cwd: '/w' })])), /class="project"/);
});

// The one line on a strip with no length limit is the prompt — a sentence somebody typed, and
// the manual promises it is "ellipsised on a node to fit its column, which is a width, not a
// redaction". Unclipped, a 400-character prompt is a node several lines tall in a row of
// one-line strips, and it fails quietly: the page still renders, just wrong.
test('the prompt is clipped to one line, with the ellipsis that says so', () => {
  assert.equal(paint('prompt', 'text-overflow', 'idle'), 'ellipsis');
  assert.equal(paint('prompt', 'overflow', 'idle'), 'hidden');
  assert.equal(paint('prompt', 'white-space', 'idle'), 'nowrap');
});

// And the ellipsis above needs a width to clip against, which the berths took away. A frame is
// a flex ITEM of `.map.berths`, so its automatic minimum size is its min-content width — and
// the min-content of a frame is dictated by the strips docked in it, whose prompt is one
// `nowrap` line with no length limit. Left at `auto`, a berth is therefore as wide as the
// longest prompt it holds: the three declarations above still resolve, against a column that
// is never narrower than its text, so nothing is ever clipped and the page scrolls sideways
// instead. The flat grid supplied that width by being a grid; the frame has to declare it.
// Asserted with `declaredEverywhere` and not `declared`: this is a guarantee, not a value. A
// second rule taking it back, or the declaration moved inside a media query so it holds on a
// phone and nowhere else, both leave `declared` answering `0` over a page that overflows.
test('a berth may be narrower than the prompts inside it, or nothing is ever clipped', () => {
  assert.deepEqual(declaredEverywhere('.berth', 'min-width'), ['0'], 'declared once, and never taken back');
  assert.deepEqual(
    declaredEverywhere('.berth', 'min-width', cssOutsideMedia()),
    ['0'],
    'and declared by the page, not by one viewport of it',
  );
});

// The same mechanism, one rule below, on the surface where it matters most. On a phone the
// cards stop being a fixed column — `.berth-cards .node { flex:1 1 8.5rem; width:auto }` — and
// `width` is the specified size suggestion that was capping their automatic minimum. Without
// it, a card is as wide as the name on it: `.who .name` is one `nowrap` line, and a background
// session's name is its PROMPT, which has no length limit. It is not the exotic case — when
// nothing in the fleet calls itself `interactive`, `roleOf` draws every row as a card, so the
// prompts land in `.name` on cards rather than on strips.
//
// The manual's promise is a privacy promise: a long name "is ellipsised on a node to fit its
// column, which is a width, not a redaction", said so a reader knows what a screenshot of a
// real fleet gives away. A phone is where a screenshot gets taken.
test('a card on a phone may be narrower than the name printed on it', () => {
  assert.match(atMedia('(max-width: 46rem)'), /\.berth-cards\s+\.node\s*\{[^}]*min-width:\s*0/);
  assert.deepEqual(declaredEverywhere('.berth-cards .node', 'min-width'), ['0'], 'and never taken back');
});

// Every rule in this sheet is prefixed by the element it belongs to, and these two arrived
// bare. `.kind` and `.prompt` are words a table cell could want the day it grows one, and a
// selector with no `.node` in front of it would paint that cell in six-point uppercase.
test("the strip's own classes are scoped to a node", () => {
  for (const cls of ['kind', 'prompt']) {
    assert.equal(declared(`.${cls}`, 'color'), '', `.${cls} is not a rule of its own`);
    assert.notEqual(declared(`.node .${cls}`, 'color'), '', `.node .${cls} is`);
  }
});

// The colour a node's halo ends up with, as the cascade resolves it: the `.node[data-state=…]`
// rule if the stylesheet has one, and the bare `.halo` otherwise — the class selector on the
// left of the descendant combinator can never outrank it.
const paint = (cls: string, prop: string, state: string): string => {
  const css = mapCss();
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

// A strip is half the height of the card beside it and may not be stretched to match — but
// that is the strip's business alone, and only where it HAS a card beside it, which since the
// berths is the replay's flat grid. The cards of a berth still share one height, which is what
// keeps a row of dials from stepping up and down; telling their row to stop stretching would
// have changed every session on the page to make room for one strip.
test('a strip in the flat grid sits at its top, and cards in a berth keep their shared height', () => {
  assert.equal(declared('.map.flat .node[data-role="agent"]', 'align-self'), 'start');
  assert.equal(declared('.berth-cards', 'align-items'), 'stretch');
  assert.equal(declared('.berth-cards', 'align-self'), '', 'and nothing tells a card to opt out of it');
});

// Docked, so it is the width of the frame and not the width of its own prompt — which is what
// "start" would mean in a column, and it is the declaration the grid rule above carries.
test('a strip docked in a berth is not shrunk to its own text', () => {
  assert.equal(declared('.berth-strips .node', 'align-self'), '', 'nothing overrides the column stretch');
  assert.equal(declared('.node[data-role="agent"]', 'align-self'), '', 'the grid keeps its own rule to itself');
});

// The frames themselves are top-aligned: a directory with one card in it is a short frame, and
// stretching it to the height of the busiest berth on the row is a box drawn around air.
test('the frames sit at the top of their row rather than stretching to the tallest', () => {
  assert.equal(declared('.map.berths', 'align-items'), 'flex-start');
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
// row instead, which is what the table's own cells do at the same breakpoint. The rule is the
// REPLAY grid's now — a live strip is docked full width by the berth around it at every size —
// and the replay is the surface that still lays nodes out as one flat grid.
test('a strip spans the width of a phone rather than sharing it with a card', () => {
  assert.match(atMedia('(max-width: 46rem)'), /\.node\[data-role="agent"\][^{]*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
});

// ── the berth, as layout ─────────────────────────────────────────────────────────────────
//
// The frames are laid out as a row of boxes that wrap, and each one is as wide as what it
// holds. The flat grid stays where it is still the shape: behind the scrubber, where the
// record has no directory to group by.
test('the live map is a row of frames, and the replay is still the flat grid', () => {
  assert.equal(declared('.map.berths', 'display'), 'flex');
  assert.equal(declared('.map.flat', 'display'), 'grid');
  assert.match(declared('.map.flat', 'grid-template-columns'), /auto-fill/);
});

// Both rules key on a second class, so the whole split rides on two attribute values. The
// live one is asserted wherever a berth is; this is the other, and without it the container
// the replay renders into can lose the word `flat` and take the grid with it — every node
// stacked full width, in a change that renders, passes and looks deliberate.
test('the two containers wear the class their layout is written for', () => {
  const html = renderPage(fleet([row()]), 'map');
  assert.match(html, /<div class="map flat" id="replay-map">/);
  assert.match(html, /<div class="map berths">/);
});

// The strips are docked under the cards of their own berth, full width of it, one under the
// other — the shape a line of text wants, and the one that keeps the prompt off an ellipsis.
test('the strips of a berth are stacked under its cards, across the frame', () => {
  assert.equal(declared('.berth-strips', 'flex-direction'), 'column');
  assert.equal(declared('.berth-cards', 'flex-wrap'), 'wrap', 'and the cards sit side by side until they run out');
});

// On a phone the frames stop sharing a row: each takes the width, and the cards inside it stop
// being a fixed column so two of them still fit across. Nothing else changes — the border of
// a berth and the border of a card are both a hairline, and a phone is not a reason to draw
// the one claim this view makes any heavier.
test('on a phone the frames stack, and their cards stretch to the width they are given', () => {
  const phone = atMedia('(max-width: 46rem)');
  assert.match(phone, /\.berth\s*\{[^}]*width:\s*100%/);
  assert.match(phone, /\.berth-cards\s+\.node\s*\{[^}]*flex:/);
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
  assert.match(html, /class="map berths"/);
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
