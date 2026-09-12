// P3 — the renderers. Everything a human reads comes out of this module: the terminal
// table, the install plan, and the dashboard page. One string each, no framework, no build
// step, no external asset: an `npx` tool has no business shipping a bundler.
//
// Rendering rule that matches the data model: a missing measurement renders as an em dash.
// A dashboard that prints `0%` where it means "I could not look" is how a blind sensor
// stays invisible for days. The two surfaces say the same things in their own words — so
// they are written side by side, and the suite can reach both.

import { formatDuration } from './config.ts';
import { HISTORY_MAX_BYTES } from './history-store.ts';
import type { Config, Source } from './config.ts';
import { buildMap, stateOf } from './map.ts';
import { INTERACTIVE } from './sessions.ts';
import {
  HISTORY_CSS,
  HISTORY_PHONE_CSS,
  HISTORY_PALETTE,
  HISTORY_TOUCH_CSS,
  historyScript,
  renderHistoryView,
} from './history-view.ts';
import type { Berth, MapNode, NodeState } from './map.ts';
import { schemaNoteParts, schemaNotice } from './schema.ts';
import type { NoteParts } from './schema.ts';
import { LIMIT_WINDOWS, RESET_HORIZON_MS, readLimits } from './limits.ts';
import type { Gauge, LimitWhy } from './limits.ts';
import { accountLimits, busyOnStaleFleet } from './fleet.ts';
import type { AccountReading, Fleet, FleetHealth, FleetRow } from './fleet.ts';
import type { ClearedPayloads, Plan, UninstallMode, UninstallPlan } from './install.ts';

/**
 * The other thing this module renders: the plan a user consents to before install or
 * uninstall touches their settings.json. Everything the decision rests on has to be here —
 * the file, both values of `statusLine`, the way back — because what is not printed cannot
 * be consented to. Terminal text, no colour: this is read once, under a prompt.
 */
export function renderPlan(plan: Plan): string {
  const where = plan.isRealHome ? 'your home' : plan.home;
  const rows: Array<[string, string]> = [
    ['file', plan.settings],
    ...(plan.writes ? ([['↳ really', plan.writes]] as Array<[string, string]>) : []),
    ['statusLine now', plan.before ?? '(none)'],
    ['statusLine next', plan.after ?? '(removed)'],
  ];

  if (plan.action === 'install') {
    if (plan.chained !== null) rows.push(['↳ which calls', `${plan.chained}   (your display is unchanged)`]);
    if (plan.alreadyInstalled) rows.push(['note', 'already installed — the wrapper is regenerated, settings.json is left alone']);
    // The snapshots directory is no longer under `.claude`, so it is no longer guessable
    // from the path above it: naming it here is how a reader of `list`, `serve` or any other
    // tool finds out where the payloads land.
    rows.push(['snapshots', plan.snapshots]);
    // A relocation is a change to where the telemetry lands, so it is never implied — and it
    // is now one the user asked for, which makes what happens to the old directory the thing
    // left to say. Named whether or not there is anything in it: the move is the news.
    if (plan.moving !== null) rows.push(['↳ moving from', `${plan.moving.dir}   (${movedFate(plan.moving)})`]);
    // This operation now DELETES files, inside a directory people commit. A plan that can
    // disagree with what runs is worse than no plan — so it says how many, and where.
    // A directory that is THERE but holds none of our payloads is the state the previous
    // install left behind: nothing to announce, and nothing to ask anyone to commit.
    const clearing = plan.legacy !== null && plan.legacy.payloads > 0;
    if (clearing) {
      rows.push([
        '↳ clearing',
        `${plan.legacy!.payloads} runtime payload(s) under ${plan.legacy!.dir} — each one is written again on the next frame`,
      ]);
      if (plan.legacy!.kept > 0)
        rows.push(['↳ keeping', `${plan.legacy!.kept} file(s) nothing here wrote, so that directory stays`]);
    }
    if (plan.gitRepo !== null) rows.push(['git', gitHint(plan.gitRepo, clearing)]);
  } else {
    rows.push(['restore', `${plan.mode} — ${restoreMeaning(plan.mode)}`]);
    // Nothing here says where the payloads are — no wrapper, or one that no longer carries
    // the path, or one we cannot read. There is no directory to name, and `uninstall` opens
    // none and removes nothing in one. Printing the default we would have computed, beside a
    // promise to clear a marker out of it, is a plan disagreeing with what runs.
    if (plan.snapshots === null) {
      rows.push(['snapshots', 'unknown — nothing here says where; nothing there is opened or removed']);
    } else {
      rows.push(['snapshots', `${plan.snapshots}   (snapshot files stay; ${markerFate(plan.mode, plan.marker)})`]);
    }
  }
  rows.push(['undo', plan.undo]);

  const w = Math.max(...rows.map(([label]) => label.length));
  return (
    `tarmac ${plan.action} — ${where}\n\n` +
    rows.map(([label, value]) => `  ${label.padEnd(w)}  ${value}\n`).join('') +
    '\n'
  );
}

/**
 * What becomes of the directory a move leaves — the same three answers the legacy purge has,
 * said in one line because the row above it already names the directory.
 */
const movedFate = (moving: ClearedPayloads): string =>
  moving.payloads === 0 && moving.kept === 0
    ? 'nothing of ours is there to clear'
    : `${moving.payloads} runtime payload(s) there are cleared — each one is written again on the next frame` +
      (moving.kept > 0 ? `; ${moving.kept} file(s) nothing here wrote stay, so the directory does` : '');

/** What an install cleared, as it went: the same sentence for both directories it can clear. */
export const clearedLine = (cleared: ClearedPayloads, snapshots: string): string =>
  `install: cleared ${cleared.payloads} runtime payload(s) from ${cleared.dir} — they belong in ${snapshots}` +
  (cleared.kept > 0 ? ` (${cleared.kept} file(s) kept, so the directory stays)` : '');

/**
 * The line #20 asked for, said once, to the only people it concerns: those whose `.claude`
 * is a git repository.
 *
 * It has two jobs, and which one is live depends on whether the payloads are still there:
 * an install that clears them produces a DELETION the user has to commit, and a `.gitignore`
 * line keeps them from coming back if that directory is ever pointed at again. With nothing
 * to clear, the only thing left to say is that this install adds nothing that churns.
 */
const gitHint = (repo: { dir: string; ignore: string }, hasLegacy: boolean): string =>
  `${repo.dir} is a git repository — ` +
  (hasLegacy
    ? `commit the removal above, and add \`${repo.ignore}\` to its .gitignore`
    : 'nothing tarmac writes there changes at runtime; the snapshots live outside it');

/**
 * What becomes of the prune marker, said only after looking at it.
 *
 * Three of these four answers are "it stays", each for its own reason: a foreign statusLine
 * keeps the wrapper, so the marker keeps its owner; nothing is there to take; or what is there
 * is not a plain file, which `removePruneMarker` refuses by design because `unlink` would take
 * a link and not its target.
 *
 * Written so that ONLY `'file'` can reach the removal sentence, rather than letting it be the
 * fallthrough: `marker` is nullable by type, and a null landing on "is removed" would be the
 * exact promise this whole change exists to stop making. The safe answer is the default; the
 * dangerous one is the special case.
 */
const markerFate = (mode: UninstallMode, marker: UninstallPlan['marker']): string =>
  marker !== 'file'
    ? marker === 'not-a-file'
      ? "the prune marker's name is worn by something that is not a regular file, so it stays"
      : 'no prune marker to remove'
    : mode === 'foreign'
      ? "tarmac's prune marker stays"
      : "tarmac's prune marker is removed";

/** What each restore mode means, in the words the plan and the report both use. */
export const restoreMeaning = (mode: UninstallMode): string => RESTORE_MEANING[mode];

const RESTORE_MEANING: Record<UninstallMode, string> = {
  bytes: 'the settings.json you had, back byte for byte',
  surgical: 'only the statusLine key goes back; your later edits are kept',
  absent: 'settings.json is removed — there was none before install',
  foreign: 'the statusLine is someone else\'s now, so nothing is restored and nothing is deleted',
};

/**
 * Where the dashboard is, in one line — and, when the port it was given was taken, which one
 * that was.
 *
 * `tarmac serving ` leads in BOTH shapes, and that is a contract rather than a preference:
 * two of this project's own test harnesses start `serve` and block until that substring
 * appears, with no timeout behind them. A moved line that opened with anything else would not
 * fail them, it would hang them — on the first day 4477 happened to be busy.
 */
// Structural on purpose: `server.ts` already imports this module, so naming its `Listening`
// here would close a cycle for two numbers.
export const servingLine = ({ port, movedFrom }: { port: number; movedFrom: number | null }): string =>
  `tarmac serving http://127.0.0.1:${port}` + (movedFrom === null ? '' : ` — port ${movedFrom} was in use`);

/**
 * What this run decided, and on whose authority. `serve` prints it once at startup because
 * it then runs unattended for hours: a threshold or a directory whose origin is invisible is
 * one nobody can go and correct — and pointing at an empty snapshots directory looks exactly
 * like a fleet with no statusline chained.
 */
export function renderSettings(config: Config, configFile: string, historyDir: string): string {
  const days = config.historyDays.value;
  const rows: Array<[string, string, Source]> = [
    ['freshness', formatDuration(config.staleAfterMs.value), config.staleAfterMs.source],
    ['port', String(config.port.value), config.port.source],
    ['snapshots', config.snapshotsDir.value, config.snapshotsDir.source],
    // Unlike the trusted hosts below, this line is printed either way. Off is the default and
    // the product, and a reader who came looking for their week of history has to be able to
    // read, in the same block as everything else, that there is none and which key starts it.
    // On, it is the only setting here that writes to their disk, so it says all of it at once:
    // how long it keeps, the ceiling they did not set, and the directory to go and look in.
    [
      'history',
      days === null
        ? 'off  (set history.days to keep more than 24 h)'
        : `${days} days  (about 2 MB a day at 8 sessions, hard cap ${HISTORY_MAX_BYTES / (1024 * 1024)} MB)  ${historyDir}`,
      config.historyDays.source,
    ],
  ];
  // Only when there are any. An empty list is what every other run has, chosen by nobody —
  // a `(default)` line saying "none" on every serve is noise, and this line has to read as
  // what it is: the one setting that widened who may read this port.
  if (config.trustHosts.value.length > 0) {
    rows.push(['trusted', config.trustHosts.value.join(', '), config.trustHosts.source]);
  }
  // Only the LABEL column is padded. Padding the values aligned the sources against the
  // snapshots path, which is absolute — pushing the one word that says where a value came
  // from past the edge of an 80-column terminal.
  return (
    `tarmac settings — flag > env > file > default\n` +
    rows.map(([label, value, source]) => `  ${label.padEnd(9)}  ${value}  (${source})\n`).join('') +
    `  file       ${configFile}\n`
  );
}

/** The one-shot `tarmac list` view: fixed-width columns, then everything we could not see. */
export function renderTable({ rows, health }: Fleet): string {
  const head = ['PROJECT', 'STATE', 'CTX', 'AS OF', 'MODEL', 'EFFORT', 'COST', 'UP'];
  const body = rows.map((r) =>
    [
      r.project ?? '—',
      stateCell(r),
      r.ctxPct === null ? `— ${r.ctxState}` : `${r.ctxPct}%`,
      // The age of the reading, never implied to be "now".
      r.snapshotAgeMs === null ? '—' : ahead(r) ? '— ahead' : `${age(r.snapshotAgeMs)}${r.stale ? ' !' : ''}`,
      r.model ?? '—',
      r.effort ?? '—',
      r.costUsd === null ? '—' : `$${r.costUsd.toFixed(2)}`,
      r.uptimeMs === null ? '—' : `${Math.round(r.uptimeMs / 3600000)}h`,
    ].map(clip),
  );
  // Columns, not code points, on both halves of the arithmetic: a cap measured one way and a
  // padding measured the other would line the table up against a width the cap never bounded.
  const w = head.map((h, i) => Math.max(cols(h), ...body.map((r) => cols(r[i]))));
  const line = (cells: string[]): string =>
    cells.map((c, i) => c + ' '.repeat(Math.max(0, w[i] - cols(c)))).join('  ').trimEnd();

  const warns: string[] = [];
  if (health.noSessionId > 0)
    warns.push(`! ${health.noSessionId}/${health.discovered} discovered sessions carry no sessionId — schema may have moved`);
  // Snapshots ARRIVED and could not be keyed — a payload with no `session_id`, or one no
  // parser could read. It leads the coverage line below because it is the CAUSE of it: a
  // fleet that reads as unchained while its statusline is writing every frame is a schema
  // change, and "run tarmac install" is advice for the opposite problem.
  if ((health.snapshotsUnreadable ?? 0) > 0)
    warns.push(
      `! ${health.snapshotsUnreadable} snapshot file(s) present but unreadable — schema may have moved, check for a newer tarmac`,
    );
  if ((health.snapshotsDuplicates ?? 0) > 0)
    warns.push(
      `! ${health.snapshotsDuplicates} snapshot file(s) claim a session id another file already claims — the freshest was kept`,
    );
  // Not folded into the line above: a name that is not a file is a directory somebody put
  // something in, and sending them to look for a newer tarmac would be advice for the schema.
  if ((health.snapshotsNotFiles ?? 0) > 0)
    warns.push(
      `! ${health.snapshotsNotFiles} name(s) in the snapshot directory are not regular files — stepped over unread, never opened`,
    );
  // Covers both "not allowed to look" and "there is nothing there to look at", so the words
  // have to fit an errno as well as a path that points nowhere.
  if (health.snapshotsError) warns.push(`! snapshots unavailable — ${health.snapshotsError}`);
  else if (health.schemaBroken) warns.push('! every snapshot drifted — the statusline payload schema moved');
  else if (health.covered < health.chainable) {
    // The count travels, for the same reason `unreadable` does one line up: without it
    // this line reads as "run install", and for a session id the wrapper declines to file
    // that is advice already taken which can never work. And when the denominator is
    // smaller than the fleet, the line says who it left out: "1/2 sessions" over a
    // four-row table is a comparison the reader should not have to resolve alone.
    const excluded = health.sessions - health.chainable;
    const counted = `${health.covered}/${health.chainable} sessions${excluded > 0 ? ` (${excluded} agent(s) draw no frame)` : ''}`;
    warns.push(
      health.unfilable > 0
        ? `! statusline chained on ${counted} — ${health.unfilable} session(s) with an id tarmac never files`
        : `! statusline chained on ${counted}`,
    );
  }
  if (health.stale > 0)
    warns.push(`! ${health.stale} reading(s) marked "!" are older than ${formatDuration(health.staleAfterMs)} (--stale-after)`);
  const skewed = rows.filter(ahead).length;
  if (skewed > 0) warns.push(`! ${skewed} reading(s) are dated in the future — ${SKEW}`);
  if (health.unknownStatus > 0) warns.push(`! ${health.unknownStatus} session(s) report an unknown status`);
  const account = accountLimits(rows, health.generatedAt);
  const gauges = readLimits(account === null ? null : account.rateLimits, health.generatedAt);
  const split = accountSplit(account, gauges);
  if (split) warns.push(`! ${split}`);
  // Last, and never instead of anything above: this one is a heads-up, not a fault.
  const schema = schemaNotice(health.schemaGuard);
  if (schema) warns.push(`! ${schema}`);

  const total = health.costUsd === null ? 'cost —' : `$${health.costUsd.toFixed(2)}${costQualifier(health)}`;

  return (
    [line(head), ...body.map(line)].join('\n') +
    '\n' +
    (warns.length ? '\n' + warns.join('\n') + '\n' : '') +
    `\n${health.sessions} sessions · ${health.busy} busy · ${total}\n${accountLine(gauges, account, health)}\n`
  );
}

/**
 * The account's two windows, under the fleet rather than in a column.
 *
 * They are the one pair of numbers in this table that is not about a session: every row above
 * spends from the same five-hour and seven-day allowance, so a column of them would be the
 * same two numbers printed once per session. Under the totals, where the other fleet-wide
 * facts are.
 *
 * Dated like every reading here, and always: the AS OF column exists because a percentage is
 * as old as the frame that wrote it, and this one has no column to be dated by. The `!` is the
 * same mark, past the same threshold, explained by the same warning above.
 */
function accountLine(gauges: Gauge[], account: AccountReading | null, health: FleetHealth): string {
  const windows = gauges
    .map((g) => `${g.label} ${g.pct === null ? `— ${LIMIT_WHY[g.why!]}` : `${g.pct}% ${resetWords(g.resetsInMs, '—')}`}`)
    .join(' · ');
  // A reading is dated; no reading is not. The two states read alike in the windows above —
  // `— no reading` is what a payload with no rate limits and a fleet with no snapshot at all
  // both come to — and the age is what tells them apart: a snapshot that said nothing carries
  // the moment it said it, and a fleet nothing was read for has no such moment to print.
  const as = account === null ? '' : ` · as of ${age(account.ageMs)}${account.ageMs > health.staleAfterMs ? ' !' : ''}`;
  return `account  ${windows}${as}`;
}

/**
 * What to say when the readings behind that line are not all about the same windows, and
 * `null` on the ordinary fleet, where they are.
 *
 * One warning for both surfaces to be written from: the account is the ONE number here picked
 * out of several that could have been it, and a picked winner presented as the fleet's account
 * is exactly what a fleet signed into two logins at once would look like. The count is what the
 * reader needs in order to go and look; WHY two windows were open at the same time is published
 * nowhere tarmac reads, so it is not guessed.
 *
 * Only windows that are drawn as a number, because this sentence qualifies one: a window the
 * surface prints as `— schema drift` has nothing for "the freshest is shown" to be true of, and
 * a warning derived from a field the line under it has just called unreadable is a warning about
 * the wrong thing. When that leaves nothing to name, there is nothing to say.
 */
function accountSplit(account: AccountReading | null, gauges: Gauge[]): string | null {
  if (account === null || account.apart === 0) return null;
  const drawn = new Set(gauges.filter((g) => g.pct !== null).map((g) => g.key));
  const labels = LIMIT_WINDOWS.filter((w) => account.apartWindows.includes(w.key) && drawn.has(w.key)).map((w) => w.label);
  if (labels.length === 0) return null;
  const which = `the ${labels.join(' and ')} window${labels.length === 1 ? '' : 's'}`;
  // Said the long way round on purpose: "1 of 4 readings names" and "2 of 4 readings name" are
  // two sentences, and a count that has to agree with a verb is a count someone will get wrong.
  return `${which} ${labels.length === 1 ? 'is' : 'are'} read differently by ${account.apart} of ${account.readings} readings — the freshest is shown`;
}

/**
 * How wide a column may get, `null` for one nothing can stretch.
 *
 * Four of the eight carry a string this tool did not choose the length of — a directory
 * basename, a status word tarmac does not know or the free text a `waiting` session gives, a
 * model name, an effort — and one long value in any of them used to push every row of the
 * table past 190 columns, on a terminal that wraps at 80. The caps are picked so that the
 * worst fleet a source can hand this renderer stays within 120 COLUMNS a row — what the
 * terminal counts, rather than the code points the string holds (#80): a CJK name of 20
 * glyphs is 20 points and 40 columns, and a cap that could not tell them apart kept its
 * promise for ASCII alone. The page has CSS to wrap with, a terminal has nothing. The other
 * four are a percentage, an age, a cost and an hour count; their own magnitude is what bounds
 * them, and no cap here would ever bite.
 */
// STATE is the widest of the four because it is two facts on one line: the state, and the
// reason a `waiting` session gives for being in it. `waiting · permission prompt` — the
// reason the fleet's own suite is written around — is 27 of these 28 columns.
const CAPS: Array<number | null> = [20, 28, null, null, 16, 8, null, null];

/**
 * One cell, made safe to print and cut to its column. The ellipsis is spent out of the cap
 * rather than added past it — a cap a cut cell can exceed is not a cap — and the cut is by
 * glyph, because half a surrogate pair is not a shorter name, it is a broken one, and neither
 * is a name whose accent was left behind by the cut before it.
 */
function clip(cell: string, i: number): string {
  const cap = CAPS[i];
  const text = sanitise(cell);
  if (cap === null || cols(text) <= cap) return text;
  let cut = '';
  let n = 0;
  for (const g of glyphs(text)) {
    const width = widthOf(g);
    // `>` and not `>=`: the budget is the cap minus the ellipsis, and a wide glyph that would
    // land astride the edge is dropped whole, leaving the cell a column short of its cap.
    if (n + width > cap - 1) break;
    cut += g;
    n += width;
  }
  return cut + '…';
}

/**
 * What a source string is allowed to put in a cell.
 *
 * Three of the four capped values are the machine's, not ours: a POSIX basename may hold any
 * byte but `/` and NUL, `waitingFor` is free text, and a status word is whatever the payload
 * said. Printed as they arrive, a `\n` breaks one row into two physical lines that no cap
 * measured and no padding aligned, a `\r` paints the next cell over this one, and an ESC hands
 * whatever named that directory the terminal's own escape codes. Each control character
 * becomes U+FFFD: one column, and visible, because a character silently dropped is a name
 * silently rewritten — the reader has to be able to see that something was there.
 */
const sanitise = (cell: string): string => cell.replace(/\p{Cc}/gu, '\uFFFD');

/**
 * How many columns a string paints. What the terminal counts, and what neither `.length` nor
 * a count of code points answers: a CJK ideograph and a fullwidth form take two, a combining
 * accent takes none, and everything else takes one.
 *
 * A table rather than a dependency. What it does not resolve is what no two terminals agree
 * on either: the East Asian Ambiguous class, whose width depends on the font the reader
 * chose. Those stay at one, which is what a Western terminal draws.
 */
function cols(s: string): number {
  let n = 0;
  for (const g of glyphs(s)) n += widthOf(g);
  return n;
}

/**
 * The string split where a terminal can cut it: a code point, plus whatever rides on it.
 *
 * A combining mark, a variation selector, a skin tone and a zero-width joiner have no column
 * of their own — they modify the glyph before them — so a cut between the two is the surrogate
 * pair bug in another alphabet: a name that comes back missing its accent, or a family emoji
 * ending in a joiner that binds to the ellipsis.
 *
 * A flag is the one glyph neither rule reaches: its two regional indicators are peers, and
 * nothing rides on anything. They pair from the left, the way the standard reads them, so an
 * odd run ends in an indicator with nobody left to pair with — a glyph of its own, and what a
 * terminal draws as a boxed letter.
 */
function glyphs(s: string): string[] {
  const out: string[] = [];
  for (const ch of s) {
    const prev = out.length - 1;
    if (prev >= 0 && (RIDES.test(ch) || out[prev].endsWith(ZWJ) || (HALF_FLAG.test(ch) && HALF_FLAG.test(out[prev]))))
      out[prev] += ch;
    else out.push(ch);
  }
  return out;
}

const ZWJ = '\u200D';
/** Marks, joiners, variation selectors and skin tones: everything that belongs to a neighbour. */
const RIDES = /[\p{Mn}\p{Me}\u200B-\u200D\uFEFF\uFE00-\uFE0F\u{1F3FB}-\u{1F3FF}]/u;
/**
 * A glyph that is ONLY those: what rides on a neighbour, having arrived with no neighbour to
 * ride on. `glyphs` had nowhere to put it and left it standing alone. Built out of the class
 * above rather than beside it, because two lists of what rides would drift apart.
 */
const RIDES_ALONE = new RegExp(`^${RIDES.source}+$`, 'u');
/**
 * One regional indicator, and the pair of them that is a country. Both anchored, and that is
 * what pairs from the left rather than swallowing a run: a glyph that is already a pair fails
 * the single-indicator test, so the third indicator of four starts the second flag.
 */
const HALF_FLAG = /^[\u{1F1E6}-\u{1F1FF}]$/u;
const FLAG = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;

/**
 * One glyph's columns. U+FE0F is asked about first because it is a REQUEST: it selects the
 * emoji presentation of a character a terminal would otherwise draw in one column, and the
 * terminals that honour it draw two.
 */
function widthOf(g: string): number {
  // Asked before U+FE0F, because a selector standing on its own is not that request: there is
  // no character in front of it whose presentation could be selected. A terminal draws nothing
  // for a glyph with no base, and a cell measured wider than it paints is padded that much
  // short — the row comes apart to the left of where the stray character sits.
  if (RIDES_ALONE.test(g)) return 0;
  if (g.includes('\uFE0F')) return 2;
  // A flag is two columns, and neither indicator is one of them: the standard calls an indicator
  // Neutral, so the table below answers 1 for each and a pair added up to the right number only
  // while it was two glyphs. Measured as the one glyph a terminal draws, it has to say so.
  if (FLAG.test(g)) return 2;
  const cp = g.codePointAt(0)!;
  return WIDE.some(([lo, hi]) => cp >= lo && cp <= hi) ? 2 : 1;
}

/**
 * Every code point Unicode 16.0 assigns and calls East Asian Wide or Fullwidth, and no other
 * assigned one, plus the regions the standard leaves wide before assignment (the undesignated
 * code points of planes 2 and 3 and of the CJK blocks), so a future CJK extension counts two
 * columns before anyone regenerates this. Generated, not written: a range spans a gap only
 * where the gap holds nothing assigned, so no narrow or ambiguous character is swept up by a
 * round number.
 *
 *   python3 -c "import re,unicodedata as u;D=((0x3400,0x4dbf),(0x4e00,0x9fff),(0xf900,0xfaff),(0x20000,0x2fffd),(0x30000,0x3fffd));w=lambda c:(u.east_asian_width(chr(c)) in 'WF') if u.category(chr(c))!='Cn' else any(a<=c<=b for a,b in D);s=''.join('W' if w(c) else 'U' if u.category(chr(c))=='Cn' else 'N' for c in range(0x110000));print('\n'.join('  [0x%04x, 0x%04x],'%(m.start(),m.end()-1) for m in re.finditer('W[WU]*W|W',s)))"
 *
 * A block list is what this replaced, and it is the shape of the bug it fixes: U+2705,
 * U+2B50 and U+23F3 are two columns and sit in no emoji block, U+1F321 is one column and
 * sits inside one. There are 83 ranges because the standard has that many runs, not because
 * anybody chose 83.
 */
const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2630, 0x2637],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x268a, 0x268f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x3247],
  [0x3250, 0xa4c6],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6b],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x1b2fb],
  [0x1d300, 0x1d376],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6df],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7f0],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1faf8],
  [0x20000, 0x3fffd],
];

/**
 * The STATE column, out of the same verdict the page draws from.
 *
 * `?` is this column's word for "a status tarmac does not recognise", so it may not lead the
 * one status tarmac knows by name and now has a state for. The reason follows the word, in
 * the separator this renderer already uses for two facts on one line — and it is the only
 * value here that can widen a column: it does so on a fleet that has a session blocked on a
 * human, which is the fleet you wanted it on.
 */
function stateCell(r: FleetRow): string {
  const state = stateOf(r);
  if (state === 'unknown') return `?${r.status ?? ''}`;
  return state === 'waiting' && r.waitingFor ? `waiting · ${r.waitingFor}` : state;
}

/**
 * A snapshot dated AFTER the clock we are reading it with — a mount whose time runs ahead, an
 * NTP correction between the write and the read. Its age is not a small number, it is not a
 * number at all, and `age()` rounded it to "0m": the freshest reading a column can show, for
 * the one file whose freshness is unknowable. `reap.ts` already refuses to judge these files;
 * both renderers refuse to date them.
 */
const ahead = (r: FleetRow): boolean => r.snapshotAgeMs !== null && r.snapshotAgeMs < 0;

const SKEW = "the snapshot's clock is ahead of this one, so how old the reading is cannot be told";

// Rounded, and deliberately not `duration()` below: the table trades precision for width
// ("4h", not "3h"), the page has room to floor and be exact.
function age(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * Everything on the page that a refresh replaces: the fleet's numbers, its warnings, its
 * rows. The shell around it — style, script, the title — never changes, so it is rendered
 * once and left alone.
 *
 * This is one function and not two on purpose. The rules that make a reading honest (a dash
 * where nothing was measured, an age next to a dated one, a warning that names what tarmac
 * could not see) are hard-won and tested; re-deriving them in browser JavaScript to redraw a
 * polled row would put the second copy somewhere this suite cannot reach.
 */
export function renderLive(fleet: Fleet): string {
  const { rows, health } = fleet;
  const warnings: string[] = [];
  if (health.noSessionId > 0) {
    // Never "no sessions found" when discovery DID find some it could not identify.
    warnings.push(
      `${health.noSessionId} of ${health.discovered} discovered session(s) carry no sessionId — tarmac cannot identify them, so no telemetry can be joined. The \`claude agents --json\` schema may have moved.`,
    );
  }
  if ((health.snapshotsUnreadable ?? 0) > 0) {
    // Same rule as the terminal's, in the page's words: state the drift BEFORE the coverage
    // line, whose advice ("run tarmac install") is for a fleet that was never chained.
    warnings.push(
      `${health.snapshotsUnreadable} snapshot file(s) are present but unreadable — a payload tarmac cannot key to a session cannot be joined to one. Claude Code's statusline schema may have moved; check for a newer tarmac.`,
    );
  }
  if ((health.snapshotsDuplicates ?? 0) > 0) {
    warnings.push(
      `${health.snapshotsDuplicates} snapshot file(s) claim a session id another file already claims — the freshest reading was kept and the other ignored. Two wrappers may be writing into the same directory.`,
    );
  }
  if ((health.snapshotsNotFiles ?? 0) > 0) {
    warnings.push(
      `${health.snapshotsNotFiles} name(s) in the snapshot directory are not regular files — a directory, a link or a named pipe wearing a snapshot's name is stepped over rather than opened, because reading one can wait for ever. Whatever else is there was read as usual.`,
    );
  }
  if (health.snapshotsError) {
    // A permission error is ours to report, not the user's to be blamed for.
    warnings.push(`The snapshot directory could not be used — ${health.snapshotsError}. Context readings are unavailable, and this is not an install problem.`);
  } else if (health.schemaBroken) {
    warnings.push(
      `Every snapshot drifted — Claude Code's statusline schema has probably moved. Context readings are dead until the payload shape is re-checked.`,
    );
  } else if (health.covered < health.chainable) {
    const blind = health.chainable - health.covered;
    // Same naming as the table line: the denominator is the chainable population, and the
    // rows below list agents as "not chained" too — without the parenthesis the banner and
    // the rows disagree on how many are missing.
    const excluded = health.sessions - health.chainable;
    const counted = `${health.covered}/${health.chainable} sessions${excluded > 0 ? ` (${excluded} agent(s) draw no frame)` : ''}`;
    warnings.push(
      health.unfilable === 0
        ? `Statusline chained on ${counted} — the rest report no context. Run \`tarmac install\` and give them one TUI frame.`
        : health.unfilable >= blind
          ? `Statusline chained on ${counted} — the rest carry a session id that is not the UUID tarmac files snapshots under, so no frame will ever produce one. Installing again will not change that.`
          : `Statusline chained on ${counted} — ${blind} report no context, and ${health.unfilable} of them will never be filed: the session id is not the UUID tarmac files snapshots under. For the others, run \`tarmac install\` and give them one TUI frame.`,
    );
  }
  if (health.unknownStatus > 0) {
    warnings.push(`${health.unknownStatus} session(s) report a status tarmac does not know — treated as unknown, not idle.`);
  }
  // NOT "N readings are stale", which used to live here and was on every hour of every day
  // (#53): a statusline is written when a terminal draws a frame, so a fleet that idles keeps
  // yesterday's numbers and says so on every poll. The rows and the nodes date each reading
  // themselves — a page-wide box repeating it is wallpaper, and wallpaper is what teaches a
  // reader to skip the boxes below. What is left here is the one stale-shaped thing that is
  // an event: `busyOnStaleFleet` (see fleet.ts for why both halves of it are needed).
  const stalled = busyOnStaleFleet(rows);
  if (stalled > 0) {
    warnings.push(
      `Every context reading is stale, including ${stalled} session(s) busy right now — a busy session redraws its status line, so its reading should not be older than ${formatDuration(health.staleAfterMs)}. The statusline writer looks stopped rather than the fleet idle: check that the wrapper is still installed and that the snapshot directory is writable.`,
    );
  }
  const skewed = rows.filter(ahead).length;
  if (skewed > 0) {
    warnings.push(`${skewed} reading(s) are dated in the future — ${SKEW}. They are shown undated rather than as brand new.`);
  }

  // Under the fleet, at a footnote's weight: two facts that are true, worth keeping, and worth
  // nobody's alarm. The first is the legend for the marks the rows carry — a `!` whose
  // threshold is invisible is a mark the reader cannot argue with, which is why demoting the
  // banner above could not take the number with it. The second is a maintainer's line: it
  // stands for every user of a released tarmac until the next release ships the fixture, so
  // amber would mean amber forever. Both keep every word they had.
  // Each one in two halves: the fact, printed, and what follows from it behind a disclosure.
  // Between them they keep every word these notes have ever had — what changed is that the
  // page no longer ends in four to nine lines of prose a reader did not scroll there for.
  const notes: NoteParts[] = [];
  // Not under the stall banner, which names the same threshold two lines up: the pair reads as
  // the alarm followed by its own excuse, and the excuse is the reading the alarm exists to
  // tell you not to accept.
  if (health.stale > 0 && stalled === 0) {
    notes.push({
      key: 'stale',
      // The legend for the mark, and the only half of this a reader ever has to be handed: it
      // is what makes `! 3h ago` on a row something they can argue with.
      lead: `Readings past the ${formatDuration(health.staleAfterMs)} freshness threshold are dated where they sit.`,
      // Why that is so, and the flag that moves it. Every word it had; one join that was an
      // em dash is a full stop.
      rest: `A statusline is only written when its terminal draws a frame, so an idle session's number is "as of" its last one. Set another with --stale-after.`,
    });
  }
  const schema = schemaNoteParts(health.schemaGuard);
  if (schema) notes.push(schema);

  // Both views, every time, out of the one reading the page just asked for. The tabs are
  // links and the shell decides which of the two is visible, so a fleet cannot be drawn as a
  // table of one age beside a map of another.
  //
  // A fleet with nothing in it has no two ways to be laid out, so it gets one sentence above
  // both of them rather than a copy inside each — the copy behind `display:none` was invisible
  // on screen and read out all the same by anything going through the markup.
  const body =
    rows.length === 0
      ? empty(health)
      : // `aria-describedby` on both views, because demoting the footnote moved it BELOW every
        // row and every node: a reader going through the markup now meets `! 3h ago` N times
        // before anything says what threshold put it there. Sighted readers glance down; this
        // is the same glance for anyone who cannot. The target is rendered whether or not it
        // has anything in it, so the reference is never dangling.
        `<div class="view view-table"><div class="wrap"><table aria-describedby="fleet-notes">
      <thead><tr>
        <th>Project</th><th>Session</th><th>State</th><th>Context</th><th>Model</th><th>Effort</th><th>Cost</th><th>Uptime</th>
      </tr></thead>
      <tbody>${rows.map(renderRow).join('')}</tbody>
    </table></div></div>
<div class="view view-map" role="group" aria-label="fleet map" aria-describedby="fleet-notes">${renderMap(fleet)}</div>`;

  return `<div id="limits-src" hidden>${renderLimits(fleet)}</div>
<div class="meta">${health.sessions} session${health.sessions === 1 ? '' : 's'} · ${health.busy} busy · ${cost(health)}<span class="stamp"> · ${esc(new Date(health.generatedAt).toISOString())}</span></div>
${warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
${body}
<div id="fleet-notes">${notes.map(renderNote).join('')}</div>`;
}

/**
 * A footnote, folded.
 *
 * `<details>` and not a script: the page's one honest claim is that it is readable without
 * JavaScript, and a disclosure the browser owns is open to a keyboard, to a screen reader and
 * to a find-in-page that reaches inside a closed one. Shut, because open it is the wall of
 * prose this was written to fold — and the LEAD is outside the fold, so what a reader is
 * handed by `aria-describedby` is the fact, never a promise that there is one somewhere.
 *
 * A note with nothing behind its lead is not a disclosure at all: an empty fold is a control
 * that answers a press with nothing.
 */
function renderNote(n: NoteParts): string {
  return n.rest === ''
    ? `<div class="note">${esc(n.lead)}</div>`
    : `<details class="note" id="note-${esc(n.key)}"><summary>${esc(n.lead)}</summary>${esc(n.rest)}</details>`;
}

/**
 * The account's two windows, for the page's header.
 *
 * They are the one pair of numbers here that is not about a session: every session on the page
 * spends from the same five-hour and seven-day allowance, so the gauges sit at the top of the
 * page rather than on a node — and the fleet's own rule decides whose reading counts when the
 * sessions carry the same number at different ages.
 *
 * Rendered into the FRAGMENT as well as into the shell, in a slot the script copies up on every
 * swap. The header is the shell's — it has to survive a poll, the tabs and a replay — but the
 * numbers are the fleet's, and the fleet is what the fragment carries. A gauge left in the shell
 * alone would be as old as the tab.
 */
export function renderLimits({ rows, health }: Fleet): string {
  const account = accountLimits(rows, health.generatedAt);
  const read = readLimits(account === null ? null : account.rateLimits, health.generatedAt);
  const gauges = read.map(gauge).join('');
  // Dated when the snapshot behind it is past the threshold, exactly as the table dates a stale
  // context. It matters more here than anywhere else on the page: the percentage is as old as
  // that snapshot, while the countdown beside it is recomputed on every five-second re-render —
  // so an undated pair puts a frozen number next to a visibly moving one and lets the reader
  // assume both are now.
  //
  // Once for the two, not once each: both windows come out of the SAME snapshot, and the same
  // fact said twice is noise. The replay has no equivalent — the ring keeps each reading and
  // never how old it was, which is why nothing replayed on this page is dated.
  const stale = account !== null && account.ageMs > health.staleAfterMs;
  // The other thing that can be wrong with this pair, and the one the age cannot say: the
  // number was picked out of several readings, and they were not all about the same window.
  // Beside the number rather than in a box below the fleet, because what it qualifies is the
  // number — and it says the whole sentence, since a mark whose reason is elsewhere is a mark
  // the reader cannot argue with.
  const split = accountSplit(account, read);
  return (
    gauges +
    (stale ? `<span class="stale">! ${esc(asOfAge(account!.ageMs))} ago</span>` : '') +
    (split === null ? '' : `<span class="mixed">! ${esc(split)}</span>`)
  );
}

/**
 * One window. Four things in a line: which window it is, a bar for the glance, the number that
 * is authoritative, and how long is left. The bar is `aria-hidden` because it says nothing the
 * number does not, and the abbreviation is replaced rather than doubled for a reader who hears
 * the page — "5h" is a label on a screen and a syllable in an ear.
 */
function gauge(g: Gauge): string {
  // No fill, ever, for a window nobody read: an empty bar is what an account at 0% wears, and
  // "I could not look" must not be able to wear it. The same dotted emptiness as an unmeasured
  // dial, in the shape a bar has.
  const rail =
    g.pct === null
      ? `<span class="rail unmeasured" aria-hidden="true"></span>`
      : `<span class="rail" aria-hidden="true"><i style="width:${g.pct}%"></i></span>`;
  return (
    `<div class="gauge"><span class="lbl" aria-hidden="true">${g.label}</span><span class="sr">${g.said}</span>` +
    `${rail}<span class="num">${g.pct === null ? dash() : `${g.pct}%`}</span>` +
    `<span class="reset">${g.pct === null ? LIMIT_WHY[g.why!] : resetWords(g.resetsInMs, dash())}</span></div>`
  );
}

/** Which kind of missing a missing window is, in the two words both surfaces use. */
const LIMIT_WHY: Record<LimitWhy, string> = { absent: 'no reading', drift: 'schema drift' };

/**
 * The reset, as a stretch of time rather than as the epoch the payload carries.
 *
 * A negative one is not a countdown to be printed with a minus sign: the window rolled over
 * after the reading that reported it, so the percentage beside these words belongs to a window
 * that no longer exists. Saying that is the whole point of showing a reset at all.
 */
const resetWords = (ms: number | null, none: string): string =>
  ms === null ? `reset ${none}` : ms > 0 ? `resets in ${left(ms)}` : `reset was due ${left(-ms)} ago`;

/**
 * How long, in the two units that matter at each scale. Deliberately finer than `duration()`
 * next door, which floors a session's uptime to whole hours: five hours is a window someone
 * plans the next hour around, and "resets in 2h" said anywhere between 2h00 and 2h59 is the
 * kind of rounding that makes a reader stop believing the number.
 */
function left(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

/**
 * What to say instead of a fleet. Discovery returning entries we could not identify is not
 * an empty fleet, and saying "none found" would hide a schema change behind a calm, wrong
 * answer — so the two surfaces below share one wording rather than each keeping its own.
 */
const empty = (health: FleetHealth): string =>
  health.noSessionId > 0
    ? `<p class="empty">No session could be identified, though ${health.noSessionId} were discovered.</p>`
    : `<p class="empty">No Claude Code sessions found. Is a session running?</p>`;

export interface WatchFrame {
  /** The last fleet that could be read — `null` until one ever could. */
  fleet: Fleet | null;
  /** Why the most recent attempt failed, or `null` if it did not. */
  error: string | null;
  ageMs: number;
  everyMs: number;
}

/**
 * One frame of `tarmac list --watch`. It owes the reader exactly what the page owes: the
 * table, when the reading in it arrived, and whether the last attempt to refresh it failed.
 * The last good table stays on screen through a failure — it is still true, of an earlier
 * moment — with the failure named above the age that keeps climbing underneath it.
 */
export function renderWatch({ fleet, error, ageMs, everyMs }: WatchFrame): string {
  const parts: string[] = [];
  if (fleet) parts.push(renderTable(fleet));
  if (error) parts.push(`! refresh failing — ${error}\n`);
  parts.push(
    // No fleet, no age: "updated 0s ago" before the first reading ever landed would be the
    // same confident lie as a 0% context nobody measured.
    `${fleet ? `updated ${ago(ageMs)} ago · ` : ''}refreshing every ${formatDuration(everyMs)} · ^C to quit\n`,
  );
  return parts.join('\n');
}

/**
 * Whatever was thrown, in words a human reads.
 *
 * `(e as Error).message` is a promise the compiler cannot keep: anything rejected that is not
 * an Error yields `undefined`, and `undefined` is FALSY — so the failure line did not print
 * badly, it did not print at all, and the frame showed the last good table with nothing to
 * say the refresh had stopped working. A silent failure, in the loop whose only job is to
 * make that failure loud.
 */
export function reason(e: unknown): string {
  const said = e instanceof Error ? e.message : String(e);
  return said.trim() === '' || said === 'null' || said === 'undefined'
    ? 'the fleet could not be read, and the failure gave no reason'
    : said;
}

/**
 * Seconds first — the only one of the three time formats here that has to, because it counts
 * a refresh interval rather than a session's life. `age()` and `duration()` above start at
 * minutes, which is right for a column and useless for a ticker. The page's script carries
 * the same rule, in the same words.
 */
function ago(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

/** Which of the three surfaces the shell opens on. */
export type View = 'table' | 'map' | 'history';

export interface PageOptions {
  /**
   * Whether `history.days` is set, which decides what the third tab can offer.
   *
   * Passed in rather than read here, and rendered rather than fetched: the config is the
   * server's, so the sentence about a journal that is off and the two pills that need one
   * ship in the markup. A reader with no journal never watches the ranges flicker from live
   * to refused, and a browser with no JavaScript still gets told why the view is empty.
   */
  historyEnabled?: boolean;
  /**
   * Whether this fleet is the invented one `serve --demo` shows.
   *
   * It is rendered rather than fetched, and it is rendered into the SHELL rather than into the
   * fragment the poll swaps: a screenshot is the whole reason a demo exists, and a marker that
   * arrives with the first tick is a marker missing from every capture taken before it. The
   * fragment is replaced every few seconds; the header is not.
   */
  demo?: boolean;
}

export function renderPage(fleet: Fleet, view: View = 'table', { historyEnabled = false, demo = false }: PageOptions = {}): string {
  // The header's copy. `renderLive` below renders its own, out of this same fleet and through
  // this same function — two calls of one pure renderer over one reading, which is what keeps
  // the pair the reader sees and the pair the script will copy up from being two accounts.
  const gauges = renderLimits(fleet);
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>tarmac — fleet</title>
<style>
  /* --wait is a fourth hue rather than the warning one: a session blocked on a human is not
     a fault, and painting it amber puts it in the same column as "tarmac cannot read this". */
  /* Two planes, not one. Everything on this page used to be a hairline on the same white:
     a card inside a berth was two identical rules nested, and nothing was ever ON anything.
     --bg is now the FLOOR and --surface the panels standing on it, which is the whole of what
     makes a table read as a panel rather than as a document. The old names all survive, so
     every rule written against them still resolves. */
  :root { color-scheme: light dark;
          --fg:#0f1218; --dim:#5f6875;
          --bg:#f3f4f6; --surface:#fff; --surface-2:#f7f8fa;
          /* A hairline is decoration; a control's edge is not. The second is darker and is
             still under the 3:1 a non-text control would need to be identified by — so no
             control on this page is identified by its border alone: the active tab keeps its
             ink and its weight, the scrubber's thumb is ringed in --fg, states keep their hue. */
          --line:#e2e5ea; --line-strong:#b9c1cb;
          --warn:#b45309; --warnbg:#fffbeb; --busy:#047857; --wait:#1d4ed8;
          --shadow-1:0 1px 2px rgba(16,24,40,.06);
          --shadow-2:0 1px 2px rgba(16,24,40,.06), 0 12px 28px -14px rgba(16,24,40,.22);
          /* The lit top edge of a raised surface. It is a dark-mode trick and reads as dirt in
             light, so in light it is nothing — declared all the same, because every rule that
             wants it lists it unconditionally. */
          --edge:0 0 0 0 transparent;
          --r-sm:8px; --r-md:12px; --r-lg:14px; --r-pill:99px;
          --gutter:1.5rem; --maxw:80rem;
          /* The face the numbers wear. Values only — a table set in mono is a terminal dump,
             not an instrument. */
          --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,"Cascadia Mono","Segoe UI Mono","Roboto Mono",monospace;
          /* How faint a chart's line goes when another one is being read. Here rather than in
             the script because it is the one drawing value that differs by theme, and the
             script has no business asking a browser which theme it is in. */
          --fade:.72; --fade-iso:.3; }
  @media (prefers-color-scheme: dark) { :root {
          --fg:#e6eaf0; --dim:#8b97a6;
          --bg:#0a0d11; --surface:#12171e; --surface-2:#171d25;
          --line:#232b35; --line-strong:#454f5e;
          --warn:#fbbf24; --warnbg:color-mix(in srgb,#fbbf24 10%,#12171e); --busy:#34d399; --wait:#93c5fd;
          --shadow-1:0 1px 2px rgba(0,0,0,.55);
          --shadow-2:0 1px 2px rgba(0,0,0,.55), 0 12px 28px -14px rgba(0,0,0,.75);
          --edge:inset 0 1px 0 rgba(255,255,255,.045);
          --fade:.6; } }
  /* Eight categorical hues for the history view, kept apart from the four above: those four
     say what a session is DOING, and a chart that borrowed one would be colouring a project
     with the word for busy. */${HISTORY_PALETTE}
  /* The floor is the html element's, not the body's: the body is now a column with a width, so
     its own background would stop at the column's edge and leave white gutters. */
  html { background:var(--bg); }
  /* A page, not a document. Unbounded, the table spread eight columns over 1440px and the map
     left 400px of dead white on the right — nothing framed the content, so nothing read as a
     product. */
  body { margin-inline:auto; max-width:var(--maxw); padding:1.5rem var(--gutter) 2rem;
         background:var(--bg); color:var(--fg);
         font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",sans-serif; }
  /* The header is a panel like the rest, rather than six unrelated objects on a line. A card
     and not a full-bleed band: a band stopped at the column's width leaves two cut corners at
     the top of the page, and a real full-bleed one needs 100vw, which opens a horizontal
     scrollbar on any OS that draws classic scroll bars. */
  header { display:flex; align-items:center; gap:.85rem; flex-wrap:wrap; margin:0 0 1rem;
           background:var(--surface); border:1px solid var(--line); border-radius:var(--r-lg);
           box-shadow:var(--shadow-1), var(--edge); padding:.6rem .9rem; }
  /* The wordmark in the face the numbers wear. It was the smallest thing on the page that
     mattered — 15.4px beside a 20px dial and an amber badge — and mono separates the name of
     the product from the UI around it for zero bytes and zero claim. */
  h1 { font-family:var(--mono); font-size:1.05rem; font-weight:600; margin:0; letter-spacing:.02em; }
  .meta { color:var(--dim); font-size:.85rem; }${
    demo
      ? `
  /* The demo marker. It borrows the warning's hues rather than the dim chrome the tabs use:
     what it says is not chrome, and a badge a reader's eye files with the furniture is a badge
     that is not in the screenshot as far as anybody looking at the screenshot is concerned.
     Shipped only on a demo, so a plain serve is byte-for-byte the page it always was. */
  /* Filled rather than outlined. It is the one element on this page whose job is to shout, and
     the page around it got quieter: a hairline pill on the header's own white no longer reads
     as a stamp. */
  .demo-tag { background:color-mix(in srgb, var(--warn) 12%, var(--surface)); color:var(--warn); border:1px solid currentColor; border-radius:99px;
              padding:.05rem .55rem; font-size:.75rem; font-weight:600; letter-spacing:.02em; white-space:nowrap; }`
      : ''
  }
  /* Honest, and out of the way of the fleet: three of these stacked at full padding pushed
     the table below the fold on a laptop, which is its own kind of hidden. */
  /* One box, worn by whichever line is up. The replay banner and the line saying the page is
     live take turns in the same place in the flow, so their box is declared once: two rules
     would only ever have to disagree by a pixel of padding for entering a replay to move the
     whole page down, which is the jump this pair exists to remove. The minimum is there
     because only one of the two carries a button, and a button's own line box is taller than
     a line of this text. */
  .warn, .live-state { border:1px solid currentColor; border-radius:var(--r-sm);
          padding:.4rem .7rem; margin:.3rem 0; font-size:.8rem; line-height:1.45; }
  /* And the floor on the two that take turns, never on the box: put on the shared rule it grew
     the offline banner and the noscript warning by 5.5px each — a page redrawn to settle an
     argument between two other elements. It clears the taller of the pair's own contents, which
     is the banner's button: 12px of text in a line box its padding and border take past 21px,
     against 18.56px for a line of the live text. */
  .replaying-note, .live-state { min-height:1.5rem; }
  /* An accent down the left edge instead of a frame at full intensity. What these say is true
     and worth keeping — "1 session reports a status tarmac does not know" — and it is not
     urgent: a full-width amber box above the fleet made the first thing a reader saw a
     warning about a footnote. The mark stays, the shout goes. */
  .warn { background:var(--warnbg); color:var(--fg); border:0;
          border-left:3px solid var(--warn); border-radius:0 var(--r-sm) var(--r-sm) 0; }
  .warn strong { color:var(--warn); }
  .warn:last-of-type { margin-bottom:.9rem; }
  /* The live half: the same box with none of the alarm. Grey on nothing, its border spent on
     holding the size rather than on drawing one — what is normal reads as chrome, and the page
     raises its voice only for the minute that is not now. */
  .live-state:not([hidden]) { display:flex; align-items:baseline; gap:.6rem; flex-wrap:wrap; }
  .live-state { color:var(--dim); border-color:transparent; }
  .live-state strong { font-weight:600; }
  body.replaying .live-state { display:none; }
  /* On the map and nowhere else, like the scrubber it belongs to: the table and the curves have
     no replay, so a line telling them apart from one answers a question their reader cannot
     ask. Written on the body rather than shipped conditionally, so one shell serves all three. */
  body:not([data-view="map"]) #live-state { display:none; }
  /* The footnote: same words, none of the weight. Dim, small, below the fleet and with no box
     around it, because what it carries is true rather than urgent — the threshold that dated a
     reading, the payload shapes nobody has captured yet. It reads as chrome to someone
     scanning their sessions and as an answer to someone who came looking for it. */
  /* 72ch and a rule above it. At 95ch the paragraph ran the width of a 1440px screen, which is
     past the measure anybody reads at, and the page ended on a grey slab. A hairline and a
     column make it the footnote it always was. */
  .note { color:var(--dim); font-size:.75rem; line-height:1.5; margin:1.5rem 0 0; max-width:72ch;
          border-top:1px solid var(--line); padding-top:.75rem; }
  /* One rule for the block, not one per note: two paragraphs each with a line over them is a
     table of contents. */
  /* The margin between two of them is also the clearance between two tap targets: each summary
     draws an overlay .45rem above and below itself, so anything under .9rem here has the first
     note's own bottom edge opening the second. Pinned by test/phone-view. */
  #fleet-notes .note + .note { border-top:0; padding-top:0; margin-top:.95rem; }
  .note code { background:var(--surface-2); border:1px solid var(--line); border-radius:4px; padding:.05rem .3rem; }
  /* The fold. The fact is the summary and stays on the page; what follows from it is one press
     away. The marker is the browser's own — a disclosure a reader already knows how to work
     beats a caret this page would have had to teach. */
  /* The padding is not decoration: it is the half of the 44px thumb target that can be drawn.
     Spent on the overlay instead, the overlay reaches so far past the summary that two stacked
     notes trade taps — the tabs' 7px bug, on a control set in the smallest type here. */
  .note summary { font-size:.75rem; padding:.4rem 0; cursor:pointer; }
  .note summary:focus-visible { outline:2px solid var(--wait); outline-offset:2px; border-radius:4px; }
  details.note[open] summary { margin-bottom:.3rem; }
  /* Two marks, one weight: a reading that has gone cold, and a reading picked out of several
     that were not about the same window. Both say the number beside them may not be what the
     reader takes it for, so neither may end up quieter than the other. */
  .stale, .mixed { color:var(--warn); font-weight:600; }
  /* The one place on the page that had no panel. overflow hidden is also what clips the 3px
     state accent on the first cell to the panel's corners. */
  .wrap { overflow-x:auto; background:var(--surface); border:1px solid var(--line);
          border-radius:var(--r-lg); box-shadow:var(--shadow-1), var(--edge); }
  table { border-collapse:collapse; width:100%; min-width:44rem; }
  /* A shaded head and a row that answers the pointer: the difference between a <table> and a
     view. The head is the nested surface, one step off the panel it sits in. */
  th { text-align:left; font-weight:600; font-size:.7rem; text-transform:uppercase; letter-spacing:.08em;
       color:var(--dim); padding:.45rem .6rem; background:var(--surface-2);
       border-bottom:1px solid var(--line); white-space:nowrap; }
  th:first-child, td:first-child { padding-left:.85rem; }
  th:last-child, td:last-child { padding-right:.85rem; }
  td { padding:.5rem .6rem; border-bottom:1px solid var(--line); white-space:nowrap; }
  /* The panel draws the bottom edge; a last row that draws its own puts two lines there. */
  tbody tr:last-child td { border-bottom:0; }
  /* Only where there is a pointer to hover with. On a touchscreen :hover sticks to whatever was
     tapped last, which would leave one row shaded for as long as the reader looks at it. */
  @media (hover:hover) and (pointer:fine) { tbody tr:hover td { background:var(--surface-2); } }
  td.num { font-variant-numeric:tabular-nums; }
  /* ── the face of a number ────────────────────────────────────────────────────────────
     The values, and only the values. Not a project, not a session name, not a model, not a
     label: a dashboard set entirely in mono is a terminal dump, and the discipline of putting
     the instrument face on the measurements alone is the whole of what separates the two.
     .why is deliberately absent — it holds words ("no reading"), not a reading. */
  .pct, td.num, .gauge .num, .chart-stat, #replay-at, .key .k-val, .asof {
          font-family:var(--mono); font-variant-numeric:tabular-nums; letter-spacing:0; }
  .dim { color:var(--dim); }
  /* Shape + word + border, so the state survives a reader who cannot tell our two hues
     apart, and a print. */
  .pill { display:inline-block; font-size:.8rem; font-weight:600; padding:.05rem .5rem;
          border:1px solid currentColor; border-radius:99px; white-space:nowrap; }
  .pill.busy { color:var(--busy); }
  .pill.waiting { color:var(--wait); }
  .pill.unknown { color:var(--warn); }
  .pill.idle { color:var(--dim); font-weight:400; }
  /* Accented states carry their own hue down the row edge. Bold stays on busy alone — it
     says "working", not "read me first"; waiting's weight is the top of the sort. */
  td:first-child { border-left:3px solid transparent; }
  tr[data-state="busy"] td:first-child { border-left-color:var(--busy); }
  tr[data-state="waiting"] td:first-child { border-left-color:var(--wait); }
  tr[data-state="unknown"] td:first-child { border-left-color:var(--warn); }
  tr[data-state="busy"] .project { font-weight:700; }
  /* The bar reads a magnitude at a glance; the number beside it is what is authoritative.
     Filling it with currentColor made it the heaviest ink on the row — a near-black slab
     shouting a secondary fact. */
  .bar { display:inline-block; width:4.5rem; height:.4rem; border-radius:99px; background:var(--line); vertical-align:middle; margin-right:.45rem; }
  .bar > i { display:block; height:100%; border-radius:99px; background:var(--dim); }
  .empty { color:var(--dim); }
  .freshness { margin-left:auto; color:var(--dim); font-size:.8rem; font-variant-numeric:tabular-nums; }
  /* A line break in the header, and nothing else: it exists only on a phone, where the six
     things up there have to be told which two rows they belong to. Off at every other width,
     where they fit on one. */
  .hdr-break { display:none; }
  .pulse { display:inline-block; width:.4rem; height:.4rem; border-radius:99px; background:var(--busy); margin-right:.4rem; vertical-align:middle; }
  /* The failing state is carried by the banner's words; the dashed frame only repeats it. */
  body.failing .pulse { background:var(--warn); }
  body.failing #live { border:1px dashed var(--warn); border-radius:8px; padding:.5rem; }
  .offline strong { white-space:nowrap; }
  /* The tabs, and what they hide. The shell owns the choice — not the fragment — so a poll
     that swaps the fleet underneath cannot put the reader back on a view they left. */
  /* A segmented control: a sunk track with a raised chip on the tab you are reading, rather
     than three words of which one has a ring round it. The chip is DECORATION — --line-strong
     and the shadow are both under the 3:1 a border would need to identify a control on its
     own, so the ink and the weight stay the signal, exactly as before. */
  nav { display:flex; gap:2px; background:var(--surface-2); border:1px solid var(--line);
        border-radius:var(--r-pill); padding:2px; }
  nav a { color:var(--dim); text-decoration:none; font-size:.8rem; font-weight:600; text-transform:uppercase;
          letter-spacing:.06em; padding:.2rem .6rem; border-radius:var(--r-pill); border:0; }
  nav a[aria-current="page"] { color:var(--fg); background:var(--surface); box-shadow:var(--shadow-1); }
  /* A finger is not a cursor. Every control on this page is a pill sized for a pointer that
     lands on a single pixel — about 26px of box against the 44 a thumb is asked to hit — and
     the fix cannot be more padding: that would redraw the page for everyone to solve a problem
     only a touchscreen has. So the TAPPABLE box grows and the drawn one does not, through an
     invisible overlay that exists only where the pointer is coarse.

     Two rules rather than one: the inset is what is LEFT to reach 44 once the pill's own line
     box and padding are counted, and the way out of a replay is set in smaller type than the
     tabs. Sized as one number for all three, it came out at 41px. The border is NOT part of that
     sum: the overlay's containing block is the control's padding box, so the border sits inside
     the rectangle rather than adding to it. Counting it read 45.2px for a target Chrome laid out
     at 43.2 — the whole feature short of the threshold it exists for, in both rules at once.

     Vertical only. Every control here is already wider than 44px on its own text (the narrowest,
     Map, is 50), so a horizontal inset buys nothing — and at .3rem against a .15rem gap between
     the tabs it made their two overlays overlap by 7px, where a tap meant for Table landed on
     Map because Map's pseudo paints later. */
  nav a, .replay button, .replaying-note button, .hist-range button, .to-now, .key,
  .note summary { position:relative; }
  @media (pointer: coarse) {
    nav a::after, .replay button::after { content:''; position:absolute; inset:-.7rem 0; }
    /* The footnote's fold is a control like the rest of them. Its inset is the smallest here
       because two of them can stand one above the other and the margin between them is the
       whole of their clearance: what 44px needs beyond the summary's own box is bought in
       padding above, not in overlay. */
    .note summary::after { content:''; position:absolute; inset:-.45rem 0; }
    .replaying-note button::after { content:''; position:absolute; inset:-.85rem 0; }${HISTORY_TOUCH_CSS}  }
  body[data-view="table"] .view-map { display:none; }
  body[data-view="map"] .view-table { display:none; }
${HISTORY_CSS}

  /* ── the account's two windows ───────────────────────────────────────────────────────
     In the header, because a rate limit is the account's and not a node's. Slim on purpose:
     the fleet is what the page is about, and these two numbers are the weather it flies in.
     Laid out with flex behind the same :not([hidden]) guard the replay containers carry —
     the replayed pair ships hidden, and a display in a stylesheet beats the attribute. */
  /* Separated from the tabs by a rule rather than by a gap the eye reads as another gap: the
     header holds two groups that have nothing to do with each other, and a line is the cheapest
     way to say so. In the header only — the replayed pair below the banner has no neighbour to
     be divided from. */
  .limits:not([hidden]) { display:flex; gap:1rem; flex-wrap:wrap; align-items:center; }
  header .limits:not([hidden]) { padding-left:.9rem; border-left:1px solid var(--line); }
  .gauge { display:flex; align-items:baseline; gap:.35rem; font-size:.8rem; }
  /* Not upper-cased, alone among the small labels on this page: "5H" is not an hour, and a
     unit that has been shouted reads as a different unit. */
  .gauge .lbl { color:var(--dim); font-weight:600; letter-spacing:.04em; }
  .gauge .num { font-variant-numeric:tabular-nums; font-weight:600; }
  .gauge .reset { color:var(--dim); }
  /* Same bargain as the row bars: a glance at a magnitude, in the quiet ink of a secondary
     fact, beside the number that is the authority. Its own class rather than .bar — that one
     is dropped below 46rem, where a card layout gives every value the name of its column, and
     these two have no column to be named by. */
  .gauge .rail { display:inline-block; width:3.5rem; height:.3rem; border-radius:99px;
          background:var(--line); align-self:center; }
  .gauge .rail > i { display:block; height:100%; border-radius:99px; background:var(--dim); }
  /* Nothing was measured — the dotted track of an unmeasured dial, in the shape of a bar. An
     empty rail is what an account at 0% wears, and the two must not match. */
  .gauge .rail.unmeasured { background:repeating-linear-gradient(90deg,var(--line) 0 2px,transparent 2px 8px); }
  /* The live pair goes down with the live fragment: they are about now, and left up they would
     be the one present-tense number standing over a fleet three hours old. */
  body.replaying #limits { display:none; }
  /* The replayed pair leads the past fleet rather than sitting on top of its totals. */
  #replay-limits { margin-bottom:.2rem; }

  /* ── the scrubber ────────────────────────────────────────────────────────────────────
     Under the map, and only under the map: the record holds what the MAP draws, so a
     scrubber over the table would offer a drag onto rows it cannot fill.
     Everything here lives in the shell for the same reason the tabs do: the /live fragment is
     swapped into innerHTML every five seconds, and a handle inside it would be dragged back
     to the present by a poll nobody asked for. */
  body[data-view="table"] #replay, body[data-view="table"] #replay-view { display:none; }
  /* One fleet at a time, and the whole fragment rather than only its map: the fragment's
     header is the LIVE count, cost and timestamp, and hiding the map alone left it sitting
     directly above the replayed one — two totals of two different moments, the pair dated
     with the present. The warnings above them are about the present too. The failure banner
     is in the shell, so a refresh that breaks mid-replay still says so. */
  body.replaying #live { display:none; }
  /* Both of these are laid out with flex, and both are hidden by the attribute until a script
     raises them — so the display is refused to a hidden one explicitly. The hidden attribute
     is only a UA rule of display:none, and any display a stylesheet gives the same element
     beats it: unguarded, this page came up announcing a replay nobody had asked for. */
  .replay:not([hidden]) { display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; margin-top:1rem;
            padding-top:.7rem; border-top:1px solid var(--line); }
  /* The pair gets a name. A button reading "Play" and a slider under a map, with nothing
     saying what they move, is a control nobody dares touch — which on a phone is most of what
     is on screen. Its own line above them, because dropped into the row it would read as a
     label for the button rather than for the pair, and take width from the slider to do it. */
  .replay .replay-name { flex-basis:100%; font-size:.7rem; font-weight:700; letter-spacing:.07em;
            text-transform:uppercase; color:var(--dim); }
  /* The one filled button on the whole dashboard, and the only place the page spends maximum
     contrast: everything else here is a reading, and this is the single thing a reader is
     invited to press. */
  .replay button { font:inherit; font-size:.8rem; font-weight:600; color:var(--bg); background:var(--fg);
            border:1px solid var(--fg); border-radius:var(--r-pill); padding:.2rem .95rem; cursor:pointer; }
  .replay button:hover:not(:disabled) { opacity:.88; }
  /* Pressed, and it looks it. The WORD on this button says which of the two it does next —
     "Pause" while the day walks — which is right and is also the one thing a glance cannot
     catch: a screenshot of a stopped replay reads exactly like a screenshot of a running one.
     The attribute carries the other fact, the one that can be painted. */
  /* Inverted, now that the resting button is the filled one. The pair is what it always was —
     the WORD says which of the two the next press does, the ATTRIBUTE says which of them is
     happening, and only the second survives a screenshot — so the two paints simply swapped
     ends. Stopped is the solid invitation; running is the same button hollowed out. */
  #play[data-playing="true"] { background:var(--surface); color:var(--fg); border-color:var(--fg); }
  .replay button:disabled { opacity:.4; cursor:default; }
  /* The handle. A range input is drawn by the browser until appearance:none hands its two
     shadow parts over — and what the browser drew was a fat grey groove belonging to no page,
     on the one control a reader of this view spends the most time touching. Both engines are
     spelled out because they name the same two parts differently and neither falls back to the
     other; the values are one pair, so a thumb retuned in one is retuned in both.
     The rail is the track's own hue, the thumb the page's ink, ringed in the background so it
     reads as an object ON the rail rather than a lump of it. */
  /* accent-color goes: it was the last thing on this page a browser drew for us, and on the one
     screen anybody will screenshot. --p is the share of the range already walked, written by the
     script on every input and every step of a play — it is what makes the bar FILL as the day
     runs, which is the whole of the motion in a recording of this view. Firefox has a track
     part for that and needs no variable; webkit has none, so the fill is a gradient stop. */
  .replay input[type="range"] { flex:1; min-width:10rem; -webkit-appearance:none; appearance:none;
            background:transparent; height:1.5rem; margin:0; cursor:pointer; accent-color:auto; }
  .replay input[type="range"]::-webkit-slider-runnable-track { height:6px; border-radius:var(--r-pill);
            background:linear-gradient(to right, var(--dim) 0 var(--p,0%), var(--line) var(--p,0%) 100%); }
  .replay input[type="range"]::-moz-range-track { height:6px; border-radius:var(--r-pill); background:var(--line); }
  .replay input[type="range"]::-moz-range-progress { height:6px; border-radius:var(--r-pill); background:var(--dim); }
  /* The margin is what centres a webkit thumb on its track: that engine lays the thumb out from
     the top of the track box, so half the difference of the two heights is what is owed back.
     Ringed in --fg rather than filled with it: 18:1 against the page, which is what identifies
     the handle — the track's own edge is nowhere near the 3:1 a control would need. */
  .replay input[type="range"]::-webkit-slider-thumb { -webkit-appearance:none; appearance:none;
            width:16px; height:16px; margin-top:-5px; border-radius:var(--r-pill);
            background:var(--surface); border:2px solid var(--fg); box-shadow:var(--shadow-1); cursor:grab; }
  .replay input[type="range"]::-moz-range-thumb { width:16px; height:16px; border-radius:var(--r-pill);
            background:var(--surface); border:2px solid var(--fg); box-shadow:var(--shadow-1); cursor:grab; }
  .replay input[type="range"]:active::-webkit-slider-thumb { cursor:grabbing; }
  .replay input[type="range"]:active::-moz-range-thumb { cursor:grabbing; }
  .replay input[type="range"]:disabled { opacity:.45; cursor:default; }
  /* What appearance:none took away and the page owes back: a control that can be reached by
     tab and not seen once it is there is a control a keyboard reader loses. The hue is the one
     this page already spends on "a human is being waited for", which is what a focus ring is. */
  .replay input[type="range"]:focus-visible, .replay button:focus-visible,
  .replaying-note button:focus-visible { outline:2px solid var(--wait); outline-offset:2px; }
  /* The two things the reader has to be able to read while dragging: the minute under the
     handle, and what the whole range covers. Tabular, so neither jitters as it counts. */
  #replay-at { font-variant-numeric:tabular-nums; font-weight:600; }
  /* One line, and the pointer is told there is more behind it. What came off this line is a
     paragraph of standing prose about the record, which is now the title and a span for a
     screen reader — moved, never dropped: it is what keeps an ungrouped map from reading as a
     rendering that broke. */
  .replay .covers { flex-basis:100%; color:var(--dim); font-size:.75rem; }
  .replay .covers[title] { cursor:help; }
  /* The banner wears the warning style on purpose: a page showing a past minute as though it were the
     fleet is the worst thing this dashboard could do, so it wears the loudest thing it has. */
  /* Sticky, because the handle is at the bottom of a map that can be taller than the
     viewport: a reader dragging with the "this is the past" banner scrolled off the top is
     a reader the banner is not warning. */
  /* The one box on this page still allowed to shout. The banners above it gave up their frame
     for a left accent; this one keeps the whole frame, takes the deeper shadow and lifts off
     the page — because a dashboard showing a past minute as though it were the fleet is the
     worst thing this product could do. */
  .replaying-note:not([hidden]) { display:flex; align-items:baseline; gap:.6rem; flex-wrap:wrap;
            position:sticky; top:0; z-index:1;
            border:1px solid var(--warn); border-left-width:3px; border-radius:var(--r-sm);
            box-shadow:var(--shadow-2); }
  .replaying-note button { font:inherit; font-size:.75rem; font-weight:600; color:inherit;
            background:transparent; border:1px solid currentColor; border-radius:99px;
            padding:.05rem .7rem; cursor:pointer; }

  /* ── the map ─────────────────────────────────────────────────────────────────────────
     One node per session. The arc is the context, its weight is how much that reading may
     be believed, and the halo — the only thing on this page that moves — says a frame
     landed moments ago. A background agent is drawn with none of the three — there is no
     terminal behind it to draw a statusline frame with — and is a strip instead, docked
     under the cards of its berth, printing as text whatever its snapshot did publish.

     Two layouts, each named, because the two surfaces know different things. The live map
     groups by working directory (the berths below); the replay behind the scrubber keeps a
     project name and never the directory it was read in, and a basename is not a directory —
     a frame drawn on it would group two checkouts of one repository into one. So it stays the
     flat grid this view was before, which is the honest drawing of what it holds. */
  .map { gap:.9rem; }
  .map.berths { display:flex; flex-wrap:wrap; align-items:flex-start; }
  /* One cell per node, and every cell the same: the replay is the one surface where the fleet
     changes under a still hand — each position of the handle is another minute, and sessions
     come and go between two of them. A grid whose rows are the size of what is in them redraws
     the page at every step of a scrub, which is what made a drag look like a page breaking.
     The floor has to clear the TALLEST card the record can produce, or it is decoration: a row
     is minmax(floor,auto), so one node taller than the floor pushes its own row and every row
     under it — the jump, by the other road. The card that decides it is a waiting session:
     a dial, a name, a caption clamped to two lines and the two numbers under it, 214px in
     Chrome. One value at every width: the columns narrow on a phone and the cards do not, so a
     floor cut to match them would sit under the cards it is supposed to hold up. */
  /* 14rem and not 13.5: the floor is measured against the tallest card the record can draw,
     and C5's dial takes that card from 215.9px to 223.9. Left at 13.5 it would clear its own
     floor and push its row and every row under it at the minute it appears — the jump this
     grid exists to remove, re-entered by a stroke width. The two are one change. */
  .map.flat { display:grid; grid-template-columns:repeat(auto-fill,minmax(10.5rem,1fr));
          grid-auto-rows:minmax(14rem,auto); }
  /* And what is in a cell sits in the middle of it. A session card hung from the top left 67px
     of white under its last line — 31% of the cell — which inside a bordered box reads as a
     render that failed rather than as air. The agent already had this from #170; the cards
     were the half that never got it. Where a cell is the height of its own content, which is
     every card in a berth, the rule changes nothing. */
  .map.flat .node { justify-content:center; }
  /* The berth: a frame around the nodes read in one directory, and the label is the whole of
     what it claims. Quiet on purpose — a hairline and a caption in the grey the rest of the
     page uses for a heading, because the loud thing on this view is a session's state, and a
     frame that competed with it would be a box drawn around a fact nobody asked about.

     min-width:0 because a berth is a flex ITEM, and a flex item's automatic minimum size is
     its min-content width — here the widest strip docked in it, whose prompt is one nowrap
     line with no length limit. At auto the frame simply grows to fit the prompt: the
     ellipsis on the strip still resolves, against a column that is never narrower than its own
     text, so nothing is ever clipped and the page scrolls sideways instead. The flat grid gave
     the strip a column to be cut to by being a grid; the frame has to say so. */
  .berth { min-width:0; border:1px solid var(--line); border-radius:12px; padding:.6rem .7rem .7rem; }
  .berth-label { margin:0 0 .5rem; font-size:.72rem; font-weight:600; text-transform:uppercase;
          letter-spacing:.06em; color:var(--dim); }
  /* The cards side by side at their own width, wrapping inside the frame when the directory
     holds more of them than the row can take. */
  /* flex-start, not stretch. Two cards with captions of different lengths were drawn to one
     height and the shorter one carried 18.2px of white under its last line — C11.1's problem
     at berth scale. Each card takes its own height instead. The DIALS stay level, which is the
     line a reader scans a row along, and that is why a berth is not centred the way a replay
     cell is: filled cards with a shadow read as two objects of two heights, not as one that
     failed to fill. */
  .berth-cards { display:flex; flex-wrap:wrap; gap:.6rem; align-items:flex-start; }
  .berth-cards .node { width:10.5rem; }
  /* And the strips docked underneath, full width of the frame, one under the other: a strip is
     a line of text, and a line of text in a column half a card wide is an ellipsis where the
     prompt was. Below the cards rather than among them because that is what it is — the
     directory's background work, under the terminals someone is sitting at — and NOT because
     one of those terminals dispatched it, which nothing here knows. */
  .berth-strips { display:flex; flex-direction:column; gap:.4rem; margin-top:.6rem; }
  /* A card standing on the berth's floor rather than a second hairline drawn inside a first.
     Three planes now — floor, berth, card — where there used to be one white and two identical
     borders. The berth keeps no fill and no shadow of its own: a shadow inside a shadow reads
     as neither. */
  .node { background:var(--surface); border:1px solid var(--line); border-radius:var(--r-md);
          box-shadow:var(--shadow-1), var(--edge); padding:.8rem .85rem .7rem;
          display:flex; flex-direction:column; align-items:center; text-align:center; }
  /* A wash of the state's own hue at 4%, under the border that already carries it. It invents
     no information — same hue, same node, quieter than the edge — and it is what makes "these
     four are working" readable across a berth without reading a single word. */
  .node[data-state="busy"] { border-color:color-mix(in srgb, var(--busy) 45%, var(--line));
          background:color-mix(in srgb, var(--busy) 4%, var(--surface)); }
  .node[data-state="waiting"] { border-color:color-mix(in srgb, var(--wait) 45%, var(--line));
          background:color-mix(in srgb, var(--wait) 4%, var(--surface)); }
  /* An agent is not a smaller session — it is a strip. It was a card at three quarters scale,
     which put a dial on a session that has no terminal to draw a statusline frame with: a ring
     that can never fill, captioned with the words of a fault someone could go and repair. The
     honest form is the one the table already speaks in — text on a line, left-aligned, its
     state in the same glyph and in a three-pixel accent down the left edge. */
  /* Behind the scrubber an agent fills its cell like every other node. It kept its own height
     for as long as the grid's rows did — a strip at half a card, sitting at the top of its
     row — and that is exactly what made the map dance: an agent appearing between two minutes
     of a scrub moved every dial under it. The SHAPE stays different, which is the honest part
     (no dial, no arc that could never fill, its text left-aligned); the CELL is the same. */
  /* Its text sits in the middle of whatever box it is given, which in the flat grid is the
     height of a dial: hung from the top of one, two lines of text read as a cell that failed
     to draw. Docked in a berth the box is the text's own height and this does nothing. */
  .node[data-role="agent"] { align-items:stretch; justify-content:center; text-align:left;
          padding:.5rem .7rem .55rem; border-radius:var(--r-sm);
          /* The box goes back to the neutral line the tinted rule above gave it: the accent is
             the channel that carries state here, and a strip outlined in its hue as well was
             the same fact said twice, in two weights, on a shape half the size of a card. */
          border-color:var(--line); border-left-width:3px; border-left-color:var(--dim); }
  /* The recessed fill belongs to the DOCKED strip, not to the agent. In a berth it is an object
     nested under the cards and reads as one; behind the scrubber it is a cell beside other
     cells, and --surface-2 there sinks it in light and lifts it in dark — the same object read
     two opposite ways depending on the theme. In the grid it takes --surface, the shadow and
     the 4% state wash like its neighbours, and the SHAPE goes on being what tells it apart. */
  .berth-strips .node[data-role="agent"] { background:var(--surface-2); box-shadow:none; }
  .node[data-role="agent"][data-state="busy"] { border-left-color:var(--busy); }
  .node[data-role="agent"][data-state="waiting"] { border-left-color:var(--wait); }
  .node[data-role="agent"][data-state="unknown"] { border-left-color:var(--warn); }
  .node[data-role="agent"] .who { margin-top:0; width:100%; }
  /* A cell is 10.5rem wide, and every caption on it is one nowrap line: cut to that column, a
     replayed agent at 320px drew its project as "a…" while the word BACKGROUND beside it kept
     all of its own, and a waiting reason — the one caption this page calls why a node is not
     working — lost two thirds of itself. The cell has height to spare and no width to give, so
     they wrap DOWN it instead. Scoped to the flat grid: a strip docked in a berth is a band the
     width of its frame, and the prompt on it has no length limit — wrapping that one down its
     berth is the paragraph the ellipsis is there to prevent.

     Two lines, then an ellipsis. Free to wrap as far as it likes, a caption is a card free to
     grow — and a card taller than the row floor takes its row and every row under it, which is
     the jump this grid exists to remove, re-entered through the fix for the clipping. A waiting
     reason has no length limit anywhere in this codebase: the source publishes what it likes
     and sessions.ts copies it through. */
  .map.flat .node .sub { white-space:normal; overflow-wrap:anywhere;
          display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-clamp:2; overflow:hidden; }
  .map.flat .node[data-role="agent"] .who { flex-wrap:wrap; }
  /* And the label that says an agent is not a terminal stays beside the name it qualifies. The
     margin that pushes it to the far end of a strip's one line drops it, alone and
     right-aligned, onto a second line the moment that line is allowed to wrap. */
  .map.flat .node[data-role="agent"] .kind { margin-left:0; }
  /* A strip's project, which since the berths is the REPLAY's business alone: a live strip
     prints none — the frame around it says the directory — and behind the scrubber there is no
     frame, and the project is the only name the ring kept. The rule stayed when the markup
     that used to need it went, or that name would sit at the body's own size, a size and a
     half larger than the line it is on, on the one surface this suite renders no markup for. */
  .node[data-role="agent"] .project { font-weight:600; font-size:.8rem; }
  /* What the node calls itself, at the end of its line: an agent's line already reads as a
     sentence, and the kind is the word that says it is not a terminal. This one and the prompt
     below it are scoped to a node like every other rule here: both are words a table cell could
     want the day it grows one, and unprefixed they would take it. */
  .node .kind { margin-left:auto; font-size:.6rem; font-weight:700; text-transform:uppercase;
          letter-spacing:.08em; color:var(--dim); }
  /* The reading on a strip, drawn. The bar is the table's own — same track, same fill, same
     refusal to be coloured by a state or a threshold — and the number beside it is what is
     authoritative, in the face every other number on this page wears. The word stays: a bar
     says a magnitude and never which one. */
  .node .ctx { display:inline-flex; align-items:center; gap:.3rem; white-space:nowrap; }
  .node .bar { display:inline-block; width:2.75rem; height:.3rem; border-radius:var(--r-pill);
          background:var(--line); vertical-align:middle; margin-right:0; }
  .node .bar > i { display:block; height:100%; border-radius:var(--r-pill); background:var(--dim); }
  .node .ctx-pct { font-family:var(--mono); font-variant-numeric:tabular-nums; font-weight:600;
          font-size:.8rem; color:var(--fg); }
  /* The prompt a background session was named after — the strip's own line, now that the berth
     around it carries the directory. One line, clipped: it is a sentence somebody typed, and
     it is the only thing on the strip that has no length limit. */
  .node .prompt { flex:1; min-width:0; color:var(--dim); font-size:.76rem;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  /* Said, not shown: the four glyphs differ in silhouette, so a reader who cannot separate
     two hues still has the state — but a screen reader is handed a bullet and nothing else. */
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
  /* 6rem. On a post the ring IS the product, and at 5.5 with a 5px stroke it was a progress
     graphic. Ships WITH the 14rem row floor above — the taller card is what makes that floor
     necessary. */
  .dial { position:relative; width:6rem; height:6rem; }
  .dial svg { width:100%; height:100%; display:block; overflow:visible; }
  /* Thicker, and the ring becomes a dial rather than a progress graphic. Purely CSS: the
     percentage is carried by stroke-dasharray off DIAL_R, which no stroke width touches. */
  .track { fill:none; stroke:var(--line); stroke-width:6.5; }
  /* Butt caps, not round: a rounded cap adds half a stroke width at each end, which draws a
     1% reading at three times its extent. The prettier cap overstates every small number. */
  .arc { fill:none; stroke:var(--dim); stroke-width:6.5; }
  .node[data-state="busy"] .arc { stroke:var(--busy); }
  /* A reading past the freshness threshold is drawn as what it is: thin, faded, and in the
     warning hue — never the solid arc of a live one. Its EXTENT stays true, because the
     number is still the truth of an earlier moment; and a dash pattern here would overwrite
     stroke-dasharray, which is what carries the percentage. */
  .node[data-reading="stale"] .arc, .node[data-reading="undated"] .arc {
          stroke:var(--warn); stroke-width:3.5; opacity:.7; }
  /* A replayed reading. Its EXTENT is what the record vouches for; its age is the one thing
     the ring never kept, so it may not wear the solid arc that means "as current as a reading
     gets" — nor the warning hue of a stale one, which would claim the opposite. Between the
     two: full colour, a shade lighter, and no date underneath it. */
  .node[data-reading="undatable"] .arc { stroke-width:5.5; opacity:.85; }
  /* Nothing was measured. Keyed on the measurement and never on the age of the file: a
     solid empty ring is what a session measured at 0% wears, and the two must not match. */
  .track.unmeasured { stroke-dasharray:2 6; stroke-linecap:round; }
  /* Once per arrival, not forever: the fragment is replaced on every poll, so a single run
     per swap is what makes the fleet breathe at the rate its frames actually land. A looping
     animation would say "a frame just arrived" for five seconds after it stopped being true. */
  /* What the halo says is that a frame landed, and it says it by being there at all. Its
     COLOUR is free, and it was spending it on a claim: stroked with the busy hue under a lone
     idle override, it pulsed green over an unrecognised status and — since the fourth state — over
     a session halted on a human, in the hue of the one thing it is certainly not doing. Same
     palette as the glyph under the name, off the same four states, so the two channels drawing
     one node cannot end up disagreeing about it. */
  .halo { fill:none; stroke:var(--dim); stroke-width:2; opacity:0; transform-origin:50% 50%;
          animation:halo 1.6s ease-out 1; }
  .node[data-state="busy"] .halo { stroke:var(--busy); }
  .node[data-state="waiting"] .halo { stroke:var(--wait); }
  .node[data-state="unknown"] .halo { stroke:var(--warn); }
  @keyframes halo { from { opacity:.5; transform:scale(1); } to { opacity:0; transform:scale(1.22); } }
  /* Motion is the one thing here nobody can look away from, so it is the first thing a
     reader who asked for less of it stops getting. The reading is still readable without it. */
  /* Scaled, not merely stopped: at rest the halo sits inside the track's own stroke, so
     "animation:none" alone left the one fact it carries invisible. */
  @media (prefers-reduced-motion: reduce) { .halo { animation:none; opacity:.35; transform:scale(1.18); } }
  .val { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
         font-variant-numeric:tabular-nums; }
  /* 650 was a weight the sans had and the system mono faces do not — asked for it, they round
     back to 400 and the number came out lighter than before. 600 is a weight they carry. The
     negative tracking goes with the sans it was measured on. */
  .pct { font-size:1.55rem; font-weight:600; }
  .pct i { font-style:normal; font-size:.62em; font-weight:500; color:var(--dim); }
  .why { font-size:.68rem; color:var(--dim); line-height:1.2; max-width:4.4rem; }
  .why b { display:block; font-size:1.25rem; font-weight:400; }
  .who { margin-top:.5rem; display:flex; align-items:baseline; gap:.3rem; max-width:100%; }
  /* Two fields in one slot, and they are not the same fact. A live card names the SESSION —
     the berth above it says the directory, and two sessions in one checkout are told apart by
     nothing else. A replayed card has only the project: the ring never kept a name, for any
     kind of session, so there is no berth behind the scrubber and no name to put in front. */
  .who .name, .who .project { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .node[data-state="busy"] .who .name, .node[data-state="busy"] .who .project { font-weight:700; }
  .shape { font-size:.7rem; color:var(--dim); }
  .node[data-state="busy"] .shape { color:var(--busy); }
  .node[data-state="waiting"] .shape { color:var(--wait); }
  .node[data-state="unknown"] .shape { color:var(--warn); }
  .sub { color:var(--dim); font-size:.76rem; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  /* The one caption that is not a footnote: it is why this node is not working, and it sits
     directly under the name in the state's own hue rather than in the grey of the rest. */
  .sub.waiting-for { color:var(--wait); font-weight:600; }
  .asof { font-size:.72rem; color:var(--dim); font-variant-numeric:tabular-nums; margin-top:.15rem; }
  .asof.stale { color:var(--warn); font-weight:600; }
  /* The columns narrow here; the row floor does not follow them. A card at 320px is taller than
     one at 1280, not shorter — its captions have less width and more lines — so a floor cut to
     the narrow column would sit under every card on the page and hold nothing up. */
  @media (max-width: 30rem) { .map.flat { grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr)); } .map { gap:.6rem; } }

  /* Below this the table stops being a table. What replaces it is the strip described down at
     the tr rule: two lines per session rather than one card of eight labelled ones. Nothing is
     dropped — a phone that hid the context column would be a phone that rendered "not measured"
     as nothing at all — and the labels that go are the ones whose value says what it is on its
     own, with the exceptions named where they are given a word back. */
  @media (max-width: 46rem) {
    body { padding:.75rem .75rem 1.25rem; }
    /* ── the header, in two lines ──────────────────────────────────────────────────────
       Six objects wrapping as they pleased put five rows of chrome — a name, a badge, tabs,
       two gauges and the age of the reading — above the first session on a 390px screen: the
       fleet started a third of the way down a page that is about the fleet.

       Three now, and the first two are DECLARED rather than left to the wrap: the name and the
       tabs, then the account. The break is a real element in the markup between those two
       groups, zero-height and full-width — NOT "order" on the items around it, which would be
       this sheet moving two readings past each other to get a line break. Nothing here is
       reordered: what the page shows is the order the markup is in.

       Three and not two, and the missing one is arithmetic rather than taste. The account's own
       row is 255px of "5h 62% resets in 59m  7d 43% resets in 4d 11h" and the age of the
       reading is 92 more, against 346 of usable width: the pair is 7px over, and the reset
       countdowns are the only words on this page that appear nowhere else — a phone that
       dropped them would be a phone that cannot tell you when your window opens. So the age
       takes the third row whole rather than a fact being spent on the second.

       A demo badge takes the width it takes and pushes the tabs down, which is a fourth row on
       a demo and none on a serve: it is the one element here whose job is to be in the way. */
    header { gap:.3rem .5rem; padding:.5rem .6rem; margin-bottom:.75rem; }
    .hdr-break { display:block; flex-basis:100%; height:0; }
    /* The rule between the two groups is what the break already says at this width. */
    header .limits:not([hidden]) { gap:.8rem; padding-left:0; border-left:0; }
    .freshness { font-size:.72rem; }
    .gauge { font-size:.72rem; }
    /* The rail goes where the row bar goes, three rules below, and for the same reason: the
       number beside it is the authority, the bar is a second telling of it, and a phone has no
       width for the second telling. What it says in words — "62%", "resets in 1h" — is every
       word it said before. */
    .gauge .rail { display:none; }
    /* The summary's ISO stamp, spent. It is the widest thing on that line and the header two
       lines above already says the same fact in the words a reader uses — "updated 3s ago",
       counted by the shell whether or not a poll ever lands. Hidden rather than dropped: the
       fragment still carries the exact second for anyone who goes looking for it. */
    .meta .stamp { display:none; }
    /* The handle, pinned under the thumb. The scrubber sits at the FOOT of the map and a map on
       a phone is several screens tall: dragging it means the dials it moves are above the fold,
       so the reader scrubs blind, lets go, scrolls up to see what changed and scrolls back. Held
       at the bottom of the viewport, the hand and the thing it is changing are on screen at once.

       Opaque and above what passes under it, or the dials scroll through the slider dragging
       them. The negative margin gives it the page's own gutters back, so the bar reaches the
       edges of the phone and the rule above it reads as an edge rather than a floating line.

       The line under the handle stays. Hiding it for the length of a replay was the obvious way
       to keep the bar short, and it silently undid the fix coversRange and KEEPS argue for
       below: two of the things that line says are standing properties of the RECORD, not of the
       range — nothing replayed here is dated, and the past is drawn ungrouped — and they are in
       the reader's view precisely because they had lived "nowhere the reader can see it", where
       an ungrouped map reads as a rendering that broke. A phone replaying is exactly when a
       reader is staring at one, and a phone has no hover to reach a title with: the two words
       are on the line itself for that reason, and only their paragraph is behind it. */
    body.replaying .replay:not([hidden]) { position:sticky; bottom:0; z-index:3;
         background:var(--bg); border-top:1px solid var(--line);
         padding:.55rem .75rem .8rem; margin:1rem -.75rem 0; }
    /* The panel goes with the table. Below this width the rows ARE cards, and a panel around
       a column of cards is a frame drawn round a frame — the thing the two planes were
       introduced to stop. */
    .wrap { overflow-x:visible; background:transparent; border:0; border-radius:0; box-shadow:none; }
    table, tbody { display:block; }
    table { min-width:0; }
    thead { display:none; }
    /* The card stops being eight labelled lines and becomes the strip the map already speaks.
       Eight lines is 234px of phone: two and a half sessions fill the screen, and "is anything
       waiting on me" costs four screens of scrolling. Two lines instead — who and in what
       state, then the numbers, "ctx 65% · Opus 5 · medium · $20.79 · up 15h", which is the
       line a docked agent has always printed on the map next door.

       Nothing is dropped. The labels that go are the ones whose values wear their own name: a
       "$", "%", a model, a state that is a word. The two that do not get one back below, in
       the strip's own words rather than as a column heading.

       The cell steps out of the layout entirely, with display:contents, so the row is the flex
       container and every VALUE is one of its items. Anything else puts a box between the row
       and the thing being placed, and the order below would have nothing to order. */
    /* And the strip becomes the card the desktop panel used to hold: filled, on the floor, with
       the same hairline and the same shadow as a node on the map. Without the fill it would be
       the one surface on the page still transparent over grey. */
    tr { display:flex; flex-wrap:wrap; align-items:baseline; column-gap:.4rem; row-gap:.05rem;
         background:var(--surface); box-shadow:var(--shadow-1), var(--edge);
         border:1px solid var(--line); border-left-width:3px; border-radius:var(--r-md);
         padding:.5rem .75rem .55rem; margin-bottom:.55rem; }
    /* white-space on the CELL, and not on the row: the desktop rule being undone is
       td { white-space:nowrap }, and an explicit declaration on the cell beats anything the row
       passes down — display:contents takes the cell out of the layout, not out of the cascade.
       Put on the row instead, it read correctly and left the project name 128px past the phone. */
    td { display:contents; white-space:normal; }
    /* The column names are gone from this width, and there is no pseudo-element hiding them for
       a screen reader: both ways of trying were measured against Chrome's accessibility tree and
       neither works. Out of flow (the .sr recipe) the eight labels are read as ONE block after
       the whole table, detached from every value they name — worse than silence. In flow at zero
       size they are pruned from the tree entirely, and they still move the strip. What a reader
       hears is the strip itself: "beacon, beacon-8c, waiting · permission prompt, ctx 65%, Opus
       5, medium, $20.79, up 15h" — named for five of the eight, and unnamed for the project, the
       session and the model. The desktop table names all eight in its thead, and so does every
       JSON surface. Naming them here needs markup, and markup is not what this change is. */
    /* The line break, as an item: zero-height, full-width, wedged between the state and the
       first number. Without it the strip is a paragraph that reflows per session, and a column
       of cards whose second line starts somewhere different each time cannot be scanned. */
    tr::after { content:''; order:4; flex-basis:100%; height:0; }
    tr[data-state="busy"] { border-left-color:var(--busy); }
    tr[data-state="waiting"] { border-left-color:var(--wait); }
    tr[data-state="unknown"] { border-left-color:var(--warn); }
    /* The frames stop sharing a row, and the cards inside one stop being a fixed column so two
       of them still fit across a phone. The berth keeps its hairline: a border around a card
       inside a border around a directory is two hairlines, which is not the weight worth
       spending a claim on — and dropping the frame here would drop the claim with it. */
    .berth { width:100%; padding:.5rem .55rem .6rem; }
    .berth-cards { gap:.5rem; }
    /* min-width:0 for the reason the berth carries it, and here it is the width that was doing
       the capping: a card's automatic minimum is its min-content width unless a specified size
       suggests otherwise, and dropping the fixed column to auto drops that suggestion. A card
       is then as wide as the name on it, and .who .name is one nowrap line — with a
       background session named after its prompt, a name with no length limit. Not the exotic
       case: when nothing in the fleet calls itself interactive, every row is drawn as a card. */
    .berth-cards .node { flex:1 1 8.5rem; width:auto; min-width:0; }
    /* Line one: who, and in what state. The project leads and carries the weight; the session
       name travels beside it in the page's grey. That order is deliberate and it is a red line
       — a background session is NAMED AFTER ITS PROMPT, and a prompt set as the heading of a
       card is a dashboard announcing what its agents were told to do, in the largest type on
       the page. It also has no length limit, so it is the one value here allowed to wrap: the
       page is content-box at this width and .wrap has given up its overflow-x, so a line
       that refuses to break takes the whole document sideways.

       The cell above hands back the white-space the desktop table takes; these two need the
       other half of it, because both can arrive as ONE long token — a project is a directory's
       basename, a background session's name is a prompt — and normal has nowhere to break a
       word. min-width:0 for the same reason the berths carry it: a flex item's automatic
       minimum is its min-content width, which without this is the whole unbroken string. */
    td[data-label="Project"] .v { order:1; font-weight:600; min-width:0; overflow-wrap:anywhere; }
    /* The basis is auto and not 0, which is what decides whether the name breaks INSIDE
       itself. A basis of 0 puts it on the first line however little is left of one: at 390px
       beside a 40-character project that is 44.6px of column, a session id cut across two
       lines, the pill dropped alone underneath and a 63px strip standing at 105.7 — on
       exactly the fleets whose checkout names are long. Its own width is the floor it wraps
       at instead: beside the project where it fits, on the next line whole where it does not.
       That floor is a trade, not a free fix: a name longer than one full line keeps a line of
       its own at EVERY width, where a basis of 0 let it compress back beside the project as
       the screen widened. The accepted side of #108: never cut a name mid-word, at the price
       of a taller strip for prompt-named agents.
       min-width:0 is what still lets it shrink once it is the widest thing on a line of its
       own, which is the wrap the rule above is written for. */
    td[data-label="Session"] .v { order:2; flex:1 1 auto; min-width:0; color:var(--dim);
         white-space:normal; overflow-wrap:anywhere; }
    /* The third value that can arrive as one unbroken token, and the one the two rules above
       missed: a waiting reason is FREE TEXT, so "permission prompt: /Users/…/foo.ts" is a path
       with no space to break at. Wrapping inside the pill (below) breaks a sentence and does
       nothing for a path — at 320px an 84-character token laid the document out at 483px, 455 of
       them this cell, which is the scroll bar the fix beside it had just closed. */
    td[data-label="State"] .v { order:3; min-width:0; overflow-wrap:anywhere; }
    /* The reason a session is waiting is free text: "permission prompt" fits on a phone and a
       sentence does not. Held nowrap, the pill is one unbreakable item on that first line,
       which is the same scroll bar by the other road. It wraps inside its own border instead,
       and the border stops being a capsule once it has three lines to go round: 99px on a box
       that tall is an ellipse whose curve crosses the words. Under half a single line's height,
       the radius is still clamped to a capsule on one line and merely rounded on three. */
    .pill { white-space:normal; border-radius:.9rem; }
    /* Line two: the numbers, each wearing a name of its own. "65%" alone under a line of prompt
       reads as how much of the prompt is done, which is the mistake the map's strip already had
       to fix; "$20.79" and "Opus 5" say what they are without help. */
    td[data-label="Context"] .v, td[data-label="Model"] .v, td[data-label="Effort"] .v,
    td[data-label="Cost"] .v, td[data-label="Uptime"] .v { font-size:.82rem; }
    td[data-label="Context"] .v { order:5; font-variant-numeric:tabular-nums; font-weight:600; }
    td[data-label="Context"] .v::before { content:'ctx '; color:var(--dim); font-weight:400; }
    /* The weight above is for a percentage. A session with no reading renders this same cell as
       "— not chained", and in the number's weight a missing measurement reads like a
       measurement — heavier here than the same words are on the desktop table. */
    td[data-label="Context"] .v .dim { font-weight:400; }
    /* Same two rules again, and the same argument: a model and an effort are not tarmac's own
       words. They are model.display_name and the effort out of a statusline payload, copied
       through verbatim and capped nowhere — a 120-character model laid the document out at
       814px. The three numbers below stay off this list, and NOT because of where they come
       from: a cost is copied out of that same payload and guarded even less (1e999 is legal
       JSON and reaches the cell as $Infinity, where a percentage that shape is refused). It is
       what they are PRINTED through that bounds them — a percentage clamped to 0..100 and
       floored, a duration, and a toFixed(2) that goes exponential long before it goes long.
       None can be a token wider than a phone, and a guard for that is prose that lies. */
    td[data-label="Model"] .v { order:6; min-width:0; overflow-wrap:anywhere; }
    td[data-label="Effort"] .v { order:7; color:var(--dim); min-width:0; overflow-wrap:anywhere; }
    td[data-label="Cost"] .v { order:8; font-variant-numeric:tabular-nums; }
    td[data-label="Uptime"] .v { order:9; color:var(--dim); font-variant-numeric:tabular-nums; }
    td[data-label="Model"] .v::before, td[data-label="Effort"] .v::before,
    td[data-label="Cost"] .v::before { content:'· '; color:var(--dim); font-weight:400; }
    td[data-label="Uptime"] .v::before { content:'· up '; color:var(--dim); font-weight:400; }
    /* A dash is not a value that wears its own name, and a session with no snapshot behind it
       has four of them at once: the percentage, the model, the effort and the cost all come out
       of one statusline frame, so they go missing together. That is not the corner case — it is
       every session until the status line has been chained and each one has drawn a frame, the
       state the page prints a warning about. As a strip it read "ctx — not chained · — · — · —",
       three anonymous dashes in a row, and the same happens one at a time for a session that
       reports no cost. Those three get their column word back; the other two already have one.
       The hook is the markup's own — a missing value is a .dim inside the cell's .v, and a
       present one never puts one there. */
    td[data-label="Model"] .v:has(.dim)::before { content:'· model '; }
    td[data-label="Effort"] .v:has(.dim)::before { content:'· effort '; }
    td[data-label="Cost"] .v:has(.dim)::before { content:'· cost '; }
    /* The table's strip only. The map's bar survives this on specificity — ".node .bar" above
       is 0,2,0 against this rule's 0,1,0, and a media query adds none — so an agent's reading
       is still drawn on the one screen it was reported missing from. No repeat of it here: a
       rule that changes nothing is a rule the next reader has to prove harmless. */
    .bar { display:none; }
${HISTORY_PHONE_CSS}  }
</style>
</head><body data-view="${view}">
<header>
  <h1>tarmac</h1>${
    demo
      ? `
  <!-- Beside the title, in the shell, and never quiet. The one thing a screenshot of this page
       must not be able to do is pass for a real fleet, and the reader who can be misled is not
       the one running the serve — it is whoever is sent the picture afterwards. -->
  <span class="demo-tag" role="status">demo data &mdash; an invented fleet</span>`
      : ''
  }
  <!-- Links, not buttons: the view survives a reload, a bookmark and a browser with
       JavaScript off — the state of a page whose own noscript banner promises it is still
       readable. Both views are in the fragment below either way, so switching costs the
       server nothing and the two can never show readings of different ages. -->
  <nav>
    <a href="/"${view === 'table' ? ' aria-current="page"' : ''}>Table</a>
    <a href="/map"${view === 'map' ? ' aria-current="page"' : ''}>Map</a>
    <a href="/history"${view === 'history' ? ' aria-current="page"' : ''}>History</a>
  </nav>
  <!-- Where the header folds on a phone. An element and not a pseudo, because the alternative
       is "order" on the two groups around it — this page's sheet may move a control and never
       a reading, and both of those are readings. Empty, so there is nothing in it for anyone
       to be read. -->
  <span class="hdr-break" aria-hidden="true"></span>
  <!-- The account's two windows, page-level because that is what they are: a limit belongs to
       the account every session below is spending from, not to any one of them. Their VALUES
       come up from the fragment on every poll (the script's limits-src copy), so the header
       structure can be the shell's without the numbers being as old as the tab. -->
  <div class="limits" id="limits" role="group" aria-label="account rate limits">${gauges}</div>
  <!-- Not "updated just now". If the script never runs — a policy-injected CSP without
       'unsafe-inline', a script error — that text would stand as a permanent lie, and
       <noscript> would not fire to correct it because JavaScript is enabled. The page's one
       honest claim must not default to a claim at all; the first tick fills it in. -->
  <span class="freshness"><span class="pulse" aria-hidden="true"></span><span id="age">updated &mdash;</span></span>
</header>
<div class="warn offline" id="offline" hidden>
  <strong>&#9888; refresh failing</strong> — nothing on this page has moved since the time in the header.
  <span id="why"></span>
</div>
<!-- Which of the two fleets is on screen, said in the place the banner below will stand. The
     banner used to be inserted into the flow the moment a reader took hold of the handle and
     removed again when they let go, so the page dropped a line on the way in and rose one on
     the way out — at the exact moment a reader is comparing two minutes of it. The space is
     spent either way now, and a page that only speaks up when it is showing the past is a page
     that says nothing on the way back. Up with the scrubber and for the same reason: with no
     record there is no second state to be telling this one apart from. -->
<!-- Served up, unlike the controls below it. It is not one of them: it says the page is showing
     the fleet now, which is true of a served page before any script runs and true of one where
     none ever will, and the way BACK from a replay is a button that lives in the banner. Shipped
     hidden it was the fault this pair exists to remove — the map paints, the record lands a
     moment later, and a line appears and pushes the whole fleet down. -->
<div class="live-state" id="live-state">
  <strong>&#9679; live</strong>
  <span>&mdash; the fleet as the header dates it.</span>
</div>
<!-- The one claim on this page that could be a lie, so it is the loudest element on it and it
     carries the minute it is showing. Hidden until a script raises it: with no script there
     is no replay, and a banner about one would be a warning about nothing. -->
<!-- role="status" because it appears without a reload and without focus moving: drawn only,
     it is the page's loudest claim and its most invisible one. -->
<div class="warn replaying-note" id="replaying" role="status" hidden>
  <strong>&#9209; replaying <span id="replay-at"></span></strong>
  <span>&mdash; a reading from the past, not the fleet now.</span>
  <button type="button" id="to-live">Back to live</button>
</div>
<noscript><div class="warn">JavaScript is off, so this page will not refresh itself. Reload it to see the fleet now.</div></noscript>
<div id="live">${renderLive(fleet)}</div>
<!-- Where the past is drawn: the shell's own map, in the place the live one occupies, so
     that swapping the fragment underneath cannot repaint what the reader is scrubbing. -->
<div id="replay-view" hidden>
  <!-- The same pair, for the minute under the reader's hand — and here rather than in the
       header, where the live pair sits. The banner that says "this is the past" is below the
       header: an account drawn above it would be the one past number on the page with nothing
       over it saying so, and the first thing a screen reader reaches, long before the warning.
       Hidden until a script raises it: with no script there is no replay, and an empty gauge
       would be a claim about nothing. -->
  <div class="limits" id="replay-limits" role="group" aria-label="account rate limits, at the minute being replayed" hidden></div>
  <div class="meta" id="replay-meta"></div>
  <div class="map flat" id="replay-map"></div>
</div>
<!-- A dead handle is worse than no handle: this is revealed once the record is in hand, and
     what it says it covers is whatever the record answered with. -->
<div class="replay" id="replay" hidden>
  <!-- "Replay", and nothing about how much of the day it holds: the range is the record's to
       state, in the sentence below, which is built around never calling ten minutes a day. -->
  <span class="replay-name">Replay</span>
  <!-- The word says what the next press does; the attribute says what is happening now, which
       is the half a stylesheet can paint and a glance can catch. -->
  <button type="button" id="play" data-playing="false">Play</button>
  <input type="range" id="scrub" min="0" max="0" step="1" value="0" disabled aria-label="Replay position">
  <div class="covers" id="covers"></div>
  <!-- What the line above could not fit, for a reader who cannot hover a title: the standing
       properties of the record — nothing replayed is dated, and the past is drawn ungrouped.
       Its own element rather than a child of the line, which the script rewrites wholesale. -->
  <span class="sr" id="covers-note"></span>
</div>
${view === 'history' ? renderHistoryView({ historyEnabled, demo }) : ''}
<script>${pageScript(view)}</script>${view === 'history' ? `\n<script>${historyScript()}</script>` : ''}
</body></html>
`;
}

/**
 * Why a poll and not the two the issue offered.
 *
 * A meta refresh cannot render its own failure: the moment `tarmac serve` dies, the browser
 * throws the page away and puts its own error page there — and the one thing worth knowing,
 * "these numbers are forty seconds old and nobody is answering", dies with it.
 *
 * SSE keeps a socket open per tab, and behind that socket sits `claude agents --json` on a
 * server-side timer. A laptop that sleeps leaves the connection half-open and the fleet gets
 * polled for a reader who is not there. A poll is the only one of the three where the client
 * decides — so a hidden tab simply stops asking, and a waking one asks at once.
 *
 * The page therefore owns exactly two facts about the present: when it last heard from the
 * server, and whether the last attempt failed. Everything a reader interprets about NOW is
 * rendered by `renderLive` on the server, where the suite can reach it.
 *
 * The replay below is the one exception, and it is one the issue asks for: scrubbing a day
 * has to be a lookup in samples the page already holds, or every pixel of a drag would be a
 * request and a `claude agents --json` behind it. So a second, smaller renderer lives in the
 * browser — fed the same three words, the same four glyphs and the same dial geometry as the
 * server's, by interpolation rather than by copy, and executed by `test/replay-script`.
 */
export const REFRESH_MS = 5000;

/**
 * How long a request may stay out before the page calls it a failure. Deliberately above the
 * collector's own 15s timeout (`discoverSessions`), so a slow-but-healthy fleet always fails
 * on the server side first and arrives with a real reason instead of this generic one.
 */
const STALL_MS = 20000;

/**
 * How fast play walks the record — one reading per step, so a serve that has seen ten minutes
 * plays for a second and a full day for two and a half minutes. It is a step interval and not
 * a total duration on purpose: the samples are not evenly spaced (a minute the collector
 * missed is a minute nobody recorded), so a fixed run time would silently speed up over the
 * gaps and make the day look busier than it was.
 */
const PLAY_STEP_MS = 100;

/**
 * The same walk for a reader who asked their system for less motion. Play is the one thing
 * here that moves, and the honest answer to that preference is not to take the feature away —
 * it is to stop flickering ten frames a second at someone who said that hurts.
 */
const PLAY_STEP_CALM_MS = 1000;

/**
 * A function, not a constant: it reads the vocabulary and the geometry declared below it, and
 * it takes the view because only one of the two has a scrubber to feed.
 */
function pageScript(view: View): string {
  return `
(function () {
  var live = document.getElementById('live'), age = document.getElementById('age');
  var off = document.getElementById('offline'), why = document.getElementById('why');
  var limits = document.getElementById('limits');
  var last = Date.now(), failing = false, inFlight = false, since = 0, gen = 0;
  // ── the footnotes, across a swap ────────────────────────────────────────────────────
  // The folds live in the fragment this script replaces every five seconds, so a reader who
  // opens one gets about two seconds of it before a new one is built shut — a note less
  // readable folded than it was as a paragraph, which is the opposite of the change. What was
  // opened is remembered by id and put back on the other side of every swap.
  //
  // Capture, because "toggle" does not bubble: it fires on the <details> and nowhere else, so
  // a listener on the container only hears it on the way down. Delegated rather than bound to
  // each note, because the notes are exactly what the swap destroys.
  var openNotes = {};
  live.addEventListener('toggle', function (ev) {
    var t = ev && ev.target;
    if (!t || !t.id || t.id.indexOf('note-') !== 0) return;
    if (t.open) openNotes[t.id] = 1; else delete openNotes[t.id];
  }, true);
  function reopenNotes() {
    for (var k in openNotes) {
      if (!Object.prototype.hasOwnProperty.call(openNotes, k)) continue;
      var d = document.getElementById(k);
      if (d) d.open = true;
    }
  }
  // How many polls in a row have come back with nothing usable, and when the last of them was.
  // On a phone the page is read on a radio, and one dropped request is a tunnel rather than an
  // outage — the banner frames the table off and says the fleet cannot be read, which is the
  // wrong thing to shout five seconds before the next answer lands. It waits for the second
  // consecutive miss; the age upstairs keeps counting meanwhile, so nothing on the page is
  // claiming to be fresher than it is.
  //
  // Consecutive means in a row IN TIME, which is why the stamp is here. A count cleared only by
  // a successful poll is not the same rule: a hidden tab issues no polls, so a miss from before
  // the reader locked their phone sat there for an hour, and the wake-up poll — the likeliest
  // miss of the session, fired while the radio is still reassociating — found it and raised the
  // banner over one dropped request. A miss further back than a few poll intervals starts the
  // count again. The window is bounded at both ends and neither end is arbitrary: below one
  // poll interval two real misses in a row would never meet, and above five a locked phone
  // comes back to a miss from minutes ago being called consecutive with this one.
  var misses = 0, missAt = 0, MISSES_BEFORE_BANNER = 2, MISS_WINDOW_MS = 3 * ${REFRESH_MS};

  function ago(ms) {
    // A clock that steps backwards (an NTP correction, a laptop waking) must not produce
    // "updated -3s ago". Zero is the floor.
    var s = Math.round(Math.max(0, ms) / 1000);
    if (s < 60) return s + 's';
    var m = Math.round(s / 60);
    return m < 60 ? m + 'm' : Math.round(m / 60) + 'h';
  }

  // Called for the one failure that is NOT a missed poll: a request the server accepted and
  // never answered. Twenty seconds of silence from a live connection is not a dropped packet,
  // so it says so at once, without the second miss the count is there to wait for. It does not
  // touch the count: a miss cannot take this banner back down, because a miss never assigns the
  // failing flag anything but true, and only an ANSWER puts it back to false.
  function fail(why_) {
    failing = true;
    // Retired, not merely dropped. Clearing the in-flight flag without moving the generation
    // left the abandoned request still ours, so the answer that arrived twenty seconds later was
    // swapped in and stamped "updated 0s ago" — the freshest label on the page over a fleet read
    // before the stall was declared. The manual has always said such an answer is discarded.
    gen += 1;
    why.textContent = why_;
    off.hidden = false;
    document.body.classList.toggle('failing', true);
  }

  // Always counting, failing or not. A number that keeps ageing in front of the reader is
  // what makes a frozen table impossible to mistake for a live one.
  function tick() {
    // fetch has no timeout in any browser. A server that accepts the connection and never
    // answers would otherwise leave the one-at-a-time guard held forever: no later poll would
    // run, nothing would ever set the failing flag, and the page would sit green and quiet —
    // the half-open-socket failure a poll was chosen over SSE to avoid, re-imported by the
    // guard itself. The deadline sits above the collector's own 15s timeout, so a slow but
    // healthy fleet always fails on the server side first, with a real reason.
    if (inFlight && Date.now() - since > ${STALL_MS}) {
      inFlight = false;
      fail('The server took the request and did not answer within ${STALL_MS / 1000}s.');
    }
    age.textContent = 'updated ' + ago(Date.now() - last) + ' ago';
  }

  function poll() {
    // One at a time. Two overlapping requests can land out of order, and the older answer
    // would then overwrite the newer one and stamp itself as the fresher reading.
    if (inFlight) return;
    inFlight = true;
    since = Date.now();
    var mine = ++gen;
    // An answer to a request we already gave up on must not touch the page: a newer request
    // owns it by then, and letting the old one land is the out-of-order swap by another road.
    var mineStill = function () { return mine === gen; };
    return fetch('/live', { cache: 'no-store' }).then(function (res) {
      // Before anything from this answer is read, let alone swapped into the DOM: loopback
      // says where the bytes came from, not who wrote them. A process that takes the port
      // after tarmac exits, or a proxy in front of it, answers 200 with whatever it likes.
      // Checked ahead of the status too — a stranger's error page must not be quoted as
      // tarmac's own reason.
      if (!res.headers.get('X-Tarmac')) throw new Error('The answer on this port did not come from tarmac.');
      return res.text().then(function (body) {
        if (!res.ok) throw new Error(body.split('\\n').filter(Boolean).join(' ').slice(0, 200));
        // An empty 200 is not an empty fleet. A truncated response, a proxy answering from
        // an empty cache entry, and a fleet of zero sessions are three different facts, and
        // only the last one has anything to say — the server always sends words, even for
        // nothing. Swapping in "" would blank the table and date it "0s ago": a confident,
        // freshly-stamped page claiming a fleet that was never read.
        if (body.trim() === '') throw new Error('The server answered with an empty page.');
        if (!mineStill()) return;
        live.innerHTML = body;
        reopenNotes();
        // The account's gauges, lifted out of the fragment and into the header where they
        // belong. Here rather than in the fragment's own place on the page because a limit is
        // the account's and not a session's; here rather than in the shell alone because the
        // NUMBERS arrive with the fleet, and a five-hour window that stopped counting down
        // would be the one thing on this page still claiming to be about now.
        // Inside the accepted-answer branch on purpose: a body that was refused is a body
        // nothing is read out of, the account's numbers included.
        var src = document.getElementById('limits-src');
        if (src) limits.innerHTML = src.innerHTML;
        last = Date.now();
        failing = false;
        // Consecutive, not cumulative: two blips an hour apart are two blips, and a count that
        // never went back to zero would turn the second one into a permanent banner.
        misses = 0;
      });
    }).catch(function (e) {
      if (!mineStill()) return;
      if (Date.now() - missAt > MISS_WINDOW_MS) misses = 0;
      misses += 1;
      missAt = Date.now();
      // Raised here, never lowered here. Only an ANSWER says the server came back, so this
      // assigns true or nothing at all — derived both ways, the window that starts a fresh count
      // also cleared the alarm, and a reader who locked their phone for ten minutes while the
      // server was down unlocked onto a green page over a fleet nobody could read.
      if (misses >= MISSES_BEFORE_BANNER) failing = true;
      why.textContent = String((e && e.message) || e).slice(0, 200);
    }).then(function () {
      // Not ours to unlock: a request we were given up on must not clear a flag that a newer
      // one is now holding, nor overwrite the state that newer one has set.
      if (!mineStill()) return;
      inFlight = false;
      off.hidden = !failing;
      document.body.classList.toggle('failing', failing);
      tick();
    });
  }

  // ── the day behind the present ──────────────────────────────────────────────────────
  //
  // The record is asked for once, and every drag after that is a lookup in it. The state of
  // the replay lives here rather than in the fragment for the same reason the tabs do: /live
  // is swapped wholesale every five seconds, and the reader's hand is not the server's to move.

  var replay = document.getElementById('replay'), scrub = document.getElementById('scrub');
  var playBtn = document.getElementById('play'), covers = document.getElementById('covers');
  var coversNote = document.getElementById('covers-note');
  var rview = document.getElementById('replay-view'), rmap = document.getElementById('replay-map');
  var rmeta = document.getElementById('replay-meta'), note = document.getElementById('replaying');
  var rlimits = document.getElementById('replay-limits');
  var atEl = document.getElementById('replay-at'), toLive = document.getElementById('to-live');
  var record = null, recordAt = 0, at = -1, replaying = false, playing = null, hgen = 0;

  // The vocabulary and the geometry, handed over rather than written twice: three words for
  // the three kinds of missing, four glyphs for the four states, one dial radius.
  var WHY = ${JSON.stringify(CTX_WHY)}, SHAPE = ${JSON.stringify(SHAPE)};
  var INTERACTIVE = ${JSON.stringify(INTERACTIVE)};
  var ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  var R = ${DIAL_R}, C = 2 * Math.PI * R;
  var STEP = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    ? ${PLAY_STEP_CALM_MS} : ${PLAY_STEP_MS};

  function esc(v) {
    if (v === null || v === undefined || v === '') return '<span class="dim">—</span>';
    return String(v).replace(/[&<>"']/g, function (c) { return ENT[c]; });
  }

  /** A lookup that cannot be answered by Object.prototype. */
  function own(table, key) {
    return Object.prototype.hasOwnProperty.call(table, key);
  }

  function two(n) { return (n < 10 ? '0' : '') + n; }
  // One page, one clock, and it is the one the summary line already dates the fleet on: an ISO
  // instant in UTC. Spelled on the machine's own clock, these minutes and that stamp are the
  // same fleet apparently living in two time zones, the first time anything shows both — an
  // export, a log line, a screenshot with the header in it. Every minute below carries UTC
  // where a reader meets it, because an unlabelled one reads as the reader's own clock and is
  // the same lie facing the other way.
  function hhmm(t) { var d = new Date(t); return two(d.getUTCHours()) + ':' + two(d.getUTCMinutes()); }

  // A day-long ring can straddle one midnight, and "09:14 – 08:59" reads as a span running
  // backwards until the older edge says which day it is. Which midnight is UTC's, like the
  // minutes it separates: counted otherwise, "yesterday" turns up between two minutes of one
  // UTC day and goes missing across the midnight it exists for.
  function edge(t, ref) {
    return hhmm(t) + (new Date(t).getUTCDate() === new Date(ref).getUTCDate() ? '' : ' yesterday');
  }

  // What the range covers, in the record's own terms and in ONE line: the span, how many
  // readings are in it, and how many minutes have none. Never "a day" — that is the size of the
  // ring, and a serve ten minutes old has seen ten minutes.
  //
  // One line because this is the line under the hand of whoever is dragging the handle, and it
  // was three of technical prose. What came off it is below, in KEEPS, and it is MOVED rather
  // than dropped: the standing properties of the record are the honest part of this feature.
  function coversRange() {
    var n = record.samples.length;
    var last = record.samples[n - 1].t;
    return 'Covering ' + edge(record.since, last) + ' – ' + hhmm(last) + ' UTC · '
      + n + ' reading' + (n === 1 ? '' : 's')
      // A gap that says it is a gap is not a gap. The handle steps through readings, not
      // through minutes, and a record with holes in it is not a smooth walk — which is why this
      // one clause stayed on the visible line while the paragraph below it went.
      + (record.missed ? ' · ' + record.missed + ' minute' + (record.missed === 1 ? '' : 's') + ' with no reading' : '')
      // The two words the paragraph below explains, kept where every reader meets them. A title
      // has no hover on a touchscreen and no keyboard, and a hidden span is for a screen reader:
      // moving the whole of it would have left the sighted phone reader — the one this page
      // argues about, staring at an ungrouped map — with neither half, and an ungrouped map that
      // says nothing about being ungrouped reads as a rendering that broke.
      + ' · undated, ungrouped';
  }

  // The two standing properties of the record, off the line and never out of reach: in the
  // title for a pointer, and in a span only a screen reader meets. Both are things this page
  // would otherwise be caught not saying — the ring never kept how old a reading was, and it
  // never kept the directory a node was read in, so a replayed map is undated and ungrouped.
  // Shown less and told nothing, a reader reads an ungrouped map as a rendering that broke.
  var KEEPS = 'The record keeps each reading, not how old that reading was, so nothing replayed'
    + ' here is dated. It keeps a project name and never the directory a node was read in, so the'
    + ' past is drawn ungrouped, in the order the sample carries.'
    // The third of them, and the one that qualifies the range itself rather than what is drawn
    // from it: the record is asked for again only when a tab that has been away comes back, so
    // the minute this range ends on is the last one this page ASKED for. A map left open on a
    // desk all afternoon would otherwise read as a record that stops where the fleet did.
    + ' The range ends where this page last asked for the record, not at this minute.';

  // The line, and what it could not fit. A message that IS the whole of what there is to say
  // carries no second copy of itself: a tooltip repeating the line it sits on is how a reader
  // learns to ignore the next one.
  function say(line, more) {
    covers.textContent = line;
    coversNote.textContent = more;
    if (more === '') covers.removeAttribute('title');
    else covers.setAttribute('title', more);
  }

  // What there is to say when there is no range: a message that is the whole of itself, and
  // carries none of KEEPS — there is nothing replayed for those properties to be true of.
  //
  // A record empty because every reading FAILED is not a record that has just started, and this
  // was the one branch that threw that away: ten hours of a collector that could not run read
  // exactly like a serve thirty seconds old.
  function emptyText() {
    return record.missed
      ? 'Nothing recorded — this serve started at ' + hhmm(record.since) + ' UTC and '
        + record.missed + ' minute' + (record.missed === 1 ? '' : 's') + ' were due and never read.'
      : 'Nothing recorded yet — this serve started at ' + hhmm(record.since) + ' UTC'
        + ' and takes a reading every ' + Math.round(record.cadence / 1000) + 's.';
  }

  // Nothing here touches the state line, and that is the rule rather than an omission: it is
  // served up, and it says the page is showing the fleet as the header dates it — true of a
  // record with a day in it, of one a serve is too young to have taken, and of one that could
  // not be read at all. Hidden on the empty answer it removed a line the server had already
  // painted: a serve samples on an interval with no leading call, so every page opened on a
  // fresh one is answered with an empty sample list for a minute, and the fleet jumped up
  // 42px, 33ms in.
  function ready() {
    var n = record.samples.length;
    replay.hidden = false;
    say(n === 0 ? emptyText() : coversRange(), n === 0 ? '' : KEEPS);
    scrub.max = String(n === 0 ? 0 : n - 1);
    scrub.disabled = n === 0;
    playBtn.disabled = n === 0;
    // The record grows by a reading a minute, so the same index is a smaller share of it every
    // time this runs. Refilled here, or a handle nobody has touched since the last poll draws
    // the fraction of an hour ago.
    fill();
  }

  // Revealed, not hidden, when the record cannot be had: a scrubber that silently never
  // appears is indistinguishable from one this build does not have.
  function noRecord(said) {
    replay.hidden = false;
    scrub.disabled = true;
    playBtn.disabled = true;
    say(said, '');
  }

  function load() {
    // The same generation guard the fleet poll carries, for the same reason and one more.
    // The replaying flag is read when the tab regains focus; the answer lands later, and
    // a reader's hand can arrive in between — so the question is asked AGAIN at the moment of
    // the swap. Without it the record was replaced under a live scrub: the handle pointing at
    // one minute, the map drawing another, out of a record that no longer existed.
    var mine = ++hgen;
    return fetch('/api/history', { cache: 'no-store' }).then(function (res) {
      // The same refusal the fragment makes, for the same reason: what comes back is parsed
      // and drawn into this page, and loopback proves where bytes came from, not who wrote them.
      if (!res.headers.get('X-Tarmac')) throw new Error('The answer on this port did not come from tarmac.');
      return res.text().then(function (body) {
        if (!res.ok) throw new Error(body.split('\\n').filter(Boolean).join(' ').slice(0, 200));
        var got = JSON.parse(body);
        if (!got || !got.samples) throw new Error('the record came back in a shape this page does not know');
        if (mine !== hgen || replaying) return;
        record = got;
        recordAt = Date.now();
        ready();
      });
    }).catch(function (e) {
      if (mine !== hgen) return;
      // A refresh is not a first load. Failing one is no reason to take away a record the page
      // is already holding — and saying "the record could not be read" over one the reader is
      // scrubbing would be false. The fleet poll's own banner already says the server is quiet.
      if (record !== null) return;
      noRecord('The record could not be read — ' + String((e && e.message) || e).slice(0, 200));
    });
  }

  // One node, out of what the ring holds and nothing more. No name, for any kind of session:
  // a background session is named after the prompt it was given, and the ring stores none.
  function nodeOf(x, anchored) {
    // The map's own rule, in the map's own words: an absent kind is not evidence of an agent,
    // and a fleet where nothing calls itself interactive is a fleet whose source moved.
    var role = !anchored || x.kind === null || x.kind === undefined || x.kind === INTERACTIVE ? 'session' : 'agent';
    // Own keys only. A bare read inherits from Object.prototype, so "constructor" and
    // "toString" passed this guard and reached the markup below — into an attribute
    // unescaped, and into the glyph slot as a function body.
    var state = own(SHAPE, x.state) ? x.state : 'unknown';
    var pct = typeof x.ctxPct === 'number' ? x.ctxPct : null;
    // The live view's rule about agents, in the copy of it that ships to the browser: a strip,
    // never a dial. A replay drawing agents as rings while the page one draws them as strips
    // would read as two kinds of thing — and the ring is the surface that can LEAST fill a
    // gauge, since it keeps a reading and never the terminal that produced it. No prompt line:
    // a background session is named after the prompt it was given, and the record stores no
    // names. What it does hold for one is a percentage and what it cost — printed like
    // anywhere else, the percentage labelled as the live strip labels it, since neither a ring
    // nor a column header is here to say which quantity it is. No model and no effort: a
    // sample is not a snapshot, and the record was never given either.
    if (role === 'agent') {
      return '<article class="node" data-role="agent" data-state="' + state + '" data-reading="undatable">'
        + '<div class="who"><span class="shape" aria-hidden="true">' + SHAPE[state] + '</span>'
        + '<span class="sr">' + state + '</span>'
        + '<span class="project">' + esc(x.project) + '</span>'
        + '<span class="kind">' + esc(x.kind) + '</span></div>'
        + (state === 'waiting' && x.waitingFor ? '<div class="sub waiting-for">' + esc(x.waitingFor) + '</div>' : '')
        // The same fragment the server writes for a live strip, in the browser's copy of the
        // renderer: a bar for the magnitude, the number beside it, and the word that says which
        // quantity the bar is about. Clamped, because the track sits in a fixed box and a fill
        // wider than it paints over the text next to it.
        + (pct === null
          ? ''
          : '<div class="sub"><span class="ctx">ctx <span class="bar"><i style="width:'
            + Math.max(0, Math.min(100, pct)) + '%"></i></span>'
            + '<span class="ctx-pct">' + pct + '%</span></span></div>')
        + (typeof x.costUsd === 'number' ? '<div class="sub">$' + x.costUsd.toFixed(2) + '</div>' : '')
        + '</article>';
    }
    // The ring keeps each reading and never how old that reading was, so the arc weight that
    // says how much a reading may be believed cannot be earned here. It is not the live
    // default either: this third value is de-weighted in the stylesheet, and never the warning
    // hue, which would claim the opposite — that the reading is known to be old.
    return '<article class="node" data-role="' + role + '" data-state="' + state + '" data-reading="undatable">'
      // No halo, ever. It means a frame landed moments ago, which is never true of a sample.
      + '<div class="dial"><svg viewBox="0 0 80 80" aria-hidden="true">'
      + '<circle class="track' + (pct === null ? ' unmeasured' : '') + '" cx="40" cy="40" r="' + R + '"/>'
      + (pct === null ? '' : arcOf(pct))
      + '</svg><div class="val">'
      + (pct === null
        ? '<span class="why"><b>—</b>' + esc(own(WHY, x.ctxState) ? WHY[x.ctxState] : 'no reading') + '</span>'
        : '<span class="pct">' + pct + '<i>%</i></span>')
      + '</div></div>'
      + '<div class="who"><span class="shape" aria-hidden="true">' + SHAPE[state] + '</span>'
      + '<span class="sr">' + state + '</span>'
      + '<span class="project">' + esc(x.project) + '</span></div>'
      // The one caption the ring can fill. Guarded on the state as well as on the field: a
      // reason left over beside another state is not a session waiting for anything, and esc()
      // answers an absent field with a dash, which would caption a node "waiting for —".
      + (state === 'waiting' && x.waitingFor ? '<div class="sub waiting-for">' + esc(x.waitingFor) + '</div>' : '')
      + (x.kind === null || x.kind === undefined || x.kind === INTERACTIVE ? '' : '<div class="sub">' + esc(x.kind) + '</div>')
      + (typeof x.costUsd === 'number' ? '<div class="sub">$' + x.costUsd.toFixed(2) + '</div>' : '')
      + '</article>';
  }

  // The server's own arithmetic, off the server's own radius: a fraction of the real
  // circumference, never pathLength, so a browser that ignores it cannot close every ring
  // into a full context window.
  function arcOf(pct) {
    var filled = (Math.min(100, Math.max(0, pct)) / 100) * C;
    var r2 = function (n) { return Math.round(n * 100) / 100; };
    return '<circle class="arc" cx="40" cy="40" r="' + R + '" transform="rotate(-90 40 40)"'
      + ' stroke-dasharray="' + r2(filled) + ' ' + r2(C - filled) + '"/>';
  }

  // ── the account, as it stood that minute ────────────────────────────────────────────
  //
  // The second thing this page interprets twice, and for the same reason as the dials: a
  // replay is a lookup in samples the page already holds, and the ring holds the payload's own
  // rate_limits rather than anything rendered. The vocabulary, the dash and the two windows are
  // handed over below rather than written again; what is mirrored is the arithmetic, and a
  // test compares this output with the server's character for character.
  //
  // What it counts the reset against is the SAMPLE's own clock, never Date.now(). A reset is a
  // moment, and "how long is left" is a question about the minute being replayed: at 09:14 the
  // five-hour window had two hours to run, and it had two hours to run whatever time it is now.
  // Counted against the present, every reset in the record would read as long overdue the
  // moment it aged past — a page announcing an account over its limit for a day that ended.
  var LIMITS = ${JSON.stringify(LIMIT_WINDOWS)}, LIMIT_WHY = ${JSON.stringify(LIMIT_WHY)};
  var DASH = ${JSON.stringify(dash())};

  function left(ms) {
    var m = Math.floor(ms / 60000);
    if (m < 1) return '<1m';
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    if (h < 24) return m % 60 === 0 ? h + 'h' : h + 'h ' + (m % 60) + 'm';
    var d = Math.floor(h / 24);
    return h % 24 === 0 ? d + 'd' : d + 'd ' + (h % 24) + 'h';
  }

  function gaugesOf(rl, now) {
    // Anything can be in a sample: rate_limits is a shape someone else versions, and the ring
    // stored whatever the payload had. None of it may throw in the header of a dashboard.
    var ok = rl !== null && rl !== undefined && typeof rl === 'object' && !Array.isArray(rl);
    var html = '';
    for (var i = 0; i < LIMITS.length; i++) {
      var w = ok ? rl[LIMITS[i].key] : undefined;
      var has = w !== null && w !== undefined && typeof w === 'object' && !Array.isArray(w) && 'used_percentage' in w;
      var v = has ? w.used_percentage : undefined;
      var pct = has && typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? Math.floor(v) : null;
      var at = has && typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? w.resets_at : null;
      var ms = at === null ? null : at * 1000 - now;
      // The server's horizon, off the server's own number: a reset further from the reading than
      // the longest window can be is not this account's reset, whatever it says.
      if (ms !== null && Math.abs(ms) > ${RESET_HORIZON_MS}) ms = null;
      // Presence, never value: a window that is there and null is a number not taken yet, and
      // one that is gone is a schema that moved. Same discriminant as everywhere else here.
      // Read off rl and NOT off ok: rate_limits carrying something that is not a pair of
      // windows — an array, which the snapshot reader lets through — is a schema that moved,
      // not an account nobody measured. Written as !ok, this said the opposite of the server
      // about the very same minute.
      var why = pct !== null ? null : (rl === null || rl === undefined || (has && v === null)) ? 'absent' : 'drift';
      html += '<div class="gauge"><span class="lbl" aria-hidden="true">' + LIMITS[i].label + '</span>'
        + '<span class="sr">' + LIMITS[i].said + '</span>'
        + (pct === null
          ? '<span class="rail unmeasured" aria-hidden="true"></span>'
          : '<span class="rail" aria-hidden="true"><i style="width:' + pct + '%"></i></span>')
        + '<span class="num">' + (pct === null ? DASH : pct + '%') + '</span>'
        + '<span class="reset">'
        + (pct === null
          ? LIMIT_WHY[why]
          : ms === null
            ? 'reset ' + DASH
            : ms > 0 ? 'resets in ' + left(ms) : 'reset was due ' + left(-ms) + ' ago')
        + '</span></div>';
    }
    return html;
  }

  function nodesOf(s) {
    var anchored = false, html = '', i;
    for (i = 0; i < s.sessions.length; i++) if (s.sessions[i].kind === INTERACTIVE) anchored = true;
    // In the order the sample carries, flat. The live map frames its nodes by working
    // directory; the ring holds a project name and never the directory it was read in, and a
    // basename is not a directory — a frame drawn on it would put two checkouts of one
    // repository behind one label. So the past keeps the order the fleet was sorted in, rather
    // than a grouping this page would have to invent a key for.
    for (i = 0; i < s.sessions.length; i++) html += nodeOf(s.sessions[i], anchored);
    return html;
  }

  // The fleet of that minute, counted from that minute. A partial sum is never presented as
  // the total, the same rule the live header follows.
  function metaOf(s) {
    var n = s.sessions.length, busy = 0, cost = 0, reporting = 0;
    for (var i = 0; i < n; i++) {
      if (s.sessions[i].state === 'busy') busy++;
      if (typeof s.sessions[i].costUsd === 'number') { cost += s.sessions[i].costUsd; reporting++; }
    }
    return n + ' session' + (n === 1 ? '' : 's') + ' · ' + busy + ' busy · '
      + (reporting === 0 ? 'cost —'
        : '$' + cost.toFixed(2) + (reporting < n ? ' (' + reporting + '/' + n + ' reporting cost)' : ''));
  }

  /**
   * How much of the record is behind the handle, as the track's own gradient reads it.
   *
   * Webkit gives a range input two shadow parts and no third one for the walked half, so the
   * fill is a stop in the track's background and this is where the stop is. Firefox has
   * ::-moz-range-progress and needs none of it, which is why the value is a token rather than a
   * background written from here: one number, two engines, and the sheet decides what each
   * does with it.
   *
   * A record of one reading has a max of 0 and nothing to divide by. Infinity and NaN are both
   * answers a browser throws the whole gradient away for, leaving a track that never fills for
   * anybody — so a span of nothing is nought per cent, which is where the handle is.
   */
  function fill() {
    var m = Number(scrub.max);
    var share = m > 0 ? (Number(scrub.value) / m) * 100 : 0;
    scrub.style.setProperty('--p', (share >= 0 && share <= 100 ? share : 0).toFixed(2) + '%');
  }

  function draw(i) {
    var s = record && record.samples[i];
    if (!s) return;
    at = i;
    replaying = true;
    scrub.value = String(i);
    fill();
    // The handle's own value is an index, so a reader who cannot see the banner would be read
    // "3" while the fleet on screen is three hours old. The minute travels with the handle.
    var minute = hhmm(s.t) + ' UTC';
    scrub.setAttribute('aria-valuetext', minute);
    atEl.textContent = minute;
    rmeta.textContent = metaOf(s);
    rmap.innerHTML = nodesOf(s);
    // The account of that minute, in the place the live pair occupies — which the body class
    // has just taken down. One allowance on screen at a time, and it is the one belonging to
    // the fleet being shown.
    rlimits.innerHTML = gaugesOf(s.rateLimits, s.t);
    rlimits.hidden = false;
    note.hidden = false;
    rview.hidden = false;
    document.body.classList.toggle('replaying', true);
  }

  function stopPlay() {
    if (playing) { clearInterval(playing); playing = null; }
    playBtn.textContent = 'Play';
    // Both halves, every time: the word for the press that comes next, the attribute for what
    // is happening now. Set here rather than only where a reader clicks, because the walk also
    // ends on its own at the last reading.
    playBtn.setAttribute('data-playing', 'false');
  }

  // Back to now, in one gesture, with nothing of the past left behind a hidden attribute.
  // The position is NOT reset: the handle stays where the reader let go of it, so what it
  // shows and where play would pick up are the same place.
  function present() {
    stopPlay();
    replaying = false;
    note.hidden = true;
    rview.hidden = true;
    rlimits.hidden = true;
    rlimits.innerHTML = '';
    rmap.innerHTML = '';
    scrub.removeAttribute('aria-valuetext');
    document.body.classList.toggle('replaying', false);
  }

  function play() {
    if (playing) { stopPlay(); return; }
    if (!record || record.samples.length === 0) return;
    // From the top when there is nothing to resume: a play button that ends where it started
    // has played nothing.
    draw(at < 0 || at >= record.samples.length - 1 ? 0 : at);
    playBtn.textContent = 'Pause';
    playBtn.setAttribute('data-playing', 'true');
    playing = setInterval(function () {
      // It stops at the end rather than looping back: a day that restarts on its own is a
      // day whose beginning and end are impossible to tell apart.
      if (at >= record.samples.length - 1) { stopPlay(); return; }
      draw(at + 1);
    }, STEP);
  }

  scrub.addEventListener('input', function () { stopPlay(); draw(Number(scrub.value)); });
  playBtn.addEventListener('click', play);
  toLive.addEventListener('click', present);

  setInterval(tick, 1000);
  setInterval(function () { if (!document.hidden) poll(); }, ${REFRESH_MS});
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    poll();
    // The record was answered once, at load. A tab left alone all afternoon holds a record
    // that stops where the reader's attention did — so it is asked again on the way back in.
    // Never while a reader is scrubbing (the record under their hand is not ours to swap, and
    // the load asks that question again when the answer lands), and never for one younger than
    // a single slot. A record that could never be read at all is not retried here: it stays
    // null, the guard holds, and the reader has a sentence saying so rather than a page
    // quietly trying again forever.
    if (!replaying && record !== null && Date.now() - recordAt >= record.cadence) load();
  });
  // Only where there is a scrubber to feed. The table view hides these controls in CSS, and a
  // full ring is megabytes of session ids, projects and costs: fetching and parsing it to
  // write a sentence into an element with display:none is a cost paid on every load of the
  // page most people open first, for a control they cannot see.
  if (${view === 'map'}) load();
})();
`;
}

/**
 * The sort puts waiting first — the one row that is work for the reader — then busy, then
 * unknown, idle last. This is where that order is given its weight — an accent down the row
 * in the state's own hue, a bold name for the ones that are working, a quiet row for the
 * ones that are not.
 *
 * The state travels three ways at once: a shape, a word, and an attribute. Colour alone is
 * no signal to a reader who cannot separate two of ours, and `data-state` is what the narrow
 * layout hangs its accent on once the table has stopped being a table.
 */
function renderRow(r: FleetRow): string {
  const state = stateOf(r);
  const word = stateLabel(state, r);
  // `data-label` is not decoration, and no longer only for the reason it was: the header row is
  // gone below ~46rem, and what the attribute does there is CARRY THE STRIP. The per-column
  // rules select `td[data-label="…"] .v` for their `order`, for their wrapping, and for the five
  // `::before` prefixes that are the only column words left at that width — `ctx `, `· up `, and
  // `· model `/`· effort `/`· cost ` for a value that is a bare dash. One element per cell, since
  // `td` is `display:contents` there: the `.v` IS the row's flex item, and a second sibling in
  // one cell would be a second item placed on an `order` of its own.
  return `<tr data-state="${state}">
    <td data-label="Project" class="project"><span class="v">${esc(r.project)}</span></td>
    <td data-label="Session" class="dim"><span class="v">${esc(r.name)}</span></td>
    <td data-label="State"><span class="v"><span class="pill ${state}">${SHAPE[state]} ${esc(word)}</span></span></td>
    <td data-label="Context" class="num"><span class="v">${ctxCell(r)}</span></td>
    <td data-label="Model"><span class="v">${esc(r.model)}</span></td>
    <td data-label="Effort" class="dim"><span class="v">${esc(r.effort)}</span></td>
    <td data-label="Cost" class="num"><span class="v">${r.costUsd === null ? dash() : '$' + r.costUsd.toFixed(2)}</span></td>
    <td data-label="Uptime" class="num dim"><span class="v">${r.uptimeMs === null ? dash() : esc(duration(r.uptimeMs))}</span></td>
  </tr>`;
}

const SHAPE: Record<NodeState, string> = { busy: '●', waiting: '◐', unknown: '▲', idle: '○' };

/**
 * The state in words, for both surfaces — derived from the state the MODEL decided, never
 * from the row a second time. Two expressions for one fact on one element is how a node ends
 * up shaped `unknown` and captioned `idle`.
 *
 * An unrecognised status is quoted as it came rather than flattened to "unknown": the point
 * of keeping it is that someone reading the page can go and find out what `compacting` means.
 */
const stateWord = (state: NodeState, r: FleetRow): string =>
  state === 'unknown' ? (r.status ?? 'unknown') : state;

/**
 * The same word with the reason attached, for the table — which has one cell per session and
 * no room for a caption of its own. The map keeps them apart instead: the word is what a
 * screen reader is handed in place of the glyph, and repeating the reason there would read it
 * twice, once hidden and once out of the caption below it.
 */
const stateLabel = (state: NodeState, r: FleetRow): string =>
  state === 'waiting' && r.waitingFor ? `${stateWord(state, r)} · ${r.waitingFor}` : stateWord(state, r);

/**
 * Which kind of missing a missing percentage is. One lookup for both surfaces: the table
 * says it beside a dash, the map says it inside an empty dial, and a second copy of these
 * three words is a second chance to describe the same state differently.
 */
const CTX_WHY: Record<string, string> = { fresh: 'no turn yet', drift: 'schema drift', absent: 'not chained' };

/**
 * The map: one node per session, grouped into berths rather than laid out as a graph. An empty
 * fleet is not its business — `renderLive` says that once, above both views, rather than
 * letting each of them render the same sentence and hide one of the two.
 *
 * There are no edges because the sources publish no relationship between two sessions — the
 * one thing they do carry is the working directory, and that is what a berth is drawn around.
 * A frame is the cheapest way to say "these were read in one place" and the hardest to
 * misread as a line between two of them.
 *
 * Everything a reader interprets is decided in `map.ts` and rendered here, on the server,
 * for the same reason the table is: the rules that keep a reading honest are tested, and a
 * copy of them re-derived in browser JavaScript would sit where this suite cannot reach.
 */
export function renderMap(fleet: Fleet): string {
  return `<div class="map berths">${buildMap(fleet).berths.map(renderBerth).join('')}</div>`;
}

/**
 * One berth: a frame, a label, the cards of the directory, and the strips docked under them.
 *
 * The label is the WHOLE of what the frame claims — these nodes were read in this directory.
 * Nothing in here says which node dispatched which, because `claude agents --json` publishes
 * no such field: no order, no position and no line inside the frame means "parent of". The day
 * that relation is published it is drawn between nodes already sitting side by side, and this
 * function is where it would go — inside a berth, without moving one.
 *
 * Named for the reader who is handed no border at all: the frame is a group with the project
 * for its name, and the heading says the same word for one navigating by headings. Each half
 * is drawn only if it has something in it, so an orphan agent's berth is a frame with a strip
 * in it rather than a frame with an empty row above one.
 *
 * `role="group"` explicitly, which is what a named `<section>` would NOT be: that is a region,
 * a landmark, and one per working directory turns a busy machine into a page of landmarks all
 * named after a basename — several of them possibly the same basename, since two checkouts of
 * `atlas` are two berths with one label. The name is what this frame is worth to a screen
 * reader; a place in the landmark index is not, and `group` is the idiom the page already uses
 * for every other named box on it.
 */
function renderBerth({ label, sessions, agents }: Berth): string {
  return `<section class="berth" role="group" aria-label="${esc(label)}"><h2 class="berth-label">${esc(label)}</h2>${
    sessions.length === 0 ? '' : `<div class="berth-cards">${sessions.map(renderNode).join('')}</div>`
  }${agents.length === 0 ? '' : `<div class="berth-strips">${agents.map(renderNode).join('')}</div>`}</section>`;
}

/**
 * One node. Five facts, in five channels that do not depend on colour alone: the arc is how
 * full the context is, the dial's weight is how much that reading may be believed, a dotted
 * dial is no reading at all, the shape beside the name is the session's state, and the halo
 * says one landed moments ago. The words under them are the same ones the table uses for the
 * same conditions — including the halo's, which would otherwise live only in a drawing.
 *
 * One state brings a caption with it. A waiting session is the only one where the shape
 * leaves a question the source can answer — which human answer it is halted on — and it is
 * printed directly under the name, not hidden in a title attribute nobody hovers on a phone.
 *
 * Two shapes, and the split is what a node HAS rather than what it is worth: a session has a
 * terminal, so the dial and its four facts are drawn for it. A background agent has no
 * terminal to draw a frame with, and gets the strip below — same data attributes, same glyph,
 * same words to a screen reader, and whatever its snapshot published, as text on one line.
 */
function renderNode({ row: r, role, state, reading, measured, pulse }: MapNode): string {
  // The model owns "is there a number"; this reads its verdict rather than asking the row a
  // second question. `fresh` and `drift` are the two states where the age of the file and the
  // presence of a reading disagree, and they are the two that matter most.
  const pct = measured ? r.ctxPct : null;
  const value =
    pct === null
      ? `<span class="why"><b>&mdash;</b>${esc(CTX_WHY[r.ctxState] ?? 'no reading')}</span>`
      : `<span class="pct">${pct}<i>%</i></span>`;
  // The reading's own age, and only when it is one the reader must not take for current.
  const asOf =
    reading === 'stale' && r.snapshotAgeMs !== null
      ? `<div class="asof stale">! ${esc(asOfAge(r.snapshotAgeMs))} ago</div>`
      : reading === 'undated'
        ? `<div class="asof stale">! undated</div>`
        : '';
  // The strip. What it dropped was the dial, never the reading: the ring on an agent could
  // never fill — there is no terminal here to draw a statusline frame with — and the middle of
  // it read "not chained", the vocabulary of a repairable fault ("run `tarmac install`") said
  // about a session no install can ever cover. So no gauge, no dash, no reason where the
  // source published nothing, and the three fields it does publish about an agent in text: its
  // state, the kind it calls itself, and the prompt it was named after.
  //
  // Nor a halo: it is a ring drawn inside the dial, and this shape has neither. What it says —
  // a reading landed seconds ago — is the one claim on this page nobody can look away from,
  // and it is not the fact a strip exists to carry.
  //
  // Nor the project: the berth around this strip says the directory once, for every node in
  // it, and a strip that repeated it would print `harbor` four times inside one frame. What
  // the line spends itself on instead is what tells two agents in one berth apart — the prompt
  // it was named after, and the kind it calls itself. Nothing here points at a node beside it:
  // sharing a frame is sharing a directory, and that is all it has ever been.
  if (role === 'agent') {
    // The rule for the rest: the strip prints what that session's snapshot published, and
    // nothing where nothing was published. The percentage, the model and the effort come out
    // of one file — `buildFleet` reads all three off the same object — so an agent the join
    // found a payload for shows all of them, on one line, beside the reading's age when it is
    // one nobody should take for current. The number carries its own label: a card has a ring
    // around it and the table a column header over it, and a bare `61%` under a line of prompt
    // reads as how much of the prompt is done. Each part is dropped on its own field being
    // null — a snapshot with no turn behind it has a model in it and no percentage.
    //
    // The reading is DRAWN now, in the bar the table's Context column already speaks — a
    // magnitude at a glance beside the number that is the authority, track in --line and fill
    // in --dim, coloured by neither the state nor a threshold. What it is not is a small dial:
    // an arc at that size cannot be read (5% and 15% draw the same silhouette), and a ring on
    // an agent is the claim #170 removed. A strip stays a line of text, now with 44x5px of
    // graphic on it.
    //
    // Which is why the percentage leaves the escaped list: `published` puts `esc` over every
    // one of its members, and markup through it would come back as text.
    const ctx =
      pct === null
        ? ''
        : `<span class="ctx">ctx <span class="bar"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></span>` +
          `<span class="ctx-pct">${pct}%</span></span>`;
    const meta = [r.model, r.effort]
      .filter((v): v is string => v !== null && v !== '')
      .map(esc)
      .join(' · ');
    const published = ctx === '' ? meta : meta === '' ? ctx : `${ctx} · ${meta}`;
    return `<article class="node" data-role="${role}" data-state="${state}" data-reading="${reading}">
      <div class="who"><span class="shape" aria-hidden="true">${SHAPE[state]}</span><span class="sr">${esc(stateWord(state, r))}</span><span class="prompt">${esc(r.name)}</span><span class="kind">${esc(r.kind)}</span></div>
      ${state === 'waiting' && r.waitingFor ? `<div class="sub waiting-for">${esc(r.waitingFor)}</div>` : ''}
      ${published === '' ? '' : `<div class="sub">${published}</div>`}
      ${asOf}
    </article>`;
  }
  return `<article class="node" data-role="${role}" data-state="${state}" data-reading="${reading}">
      <div class="dial">
        <svg viewBox="0 0 80 80" aria-hidden="true">${pulse ? `<circle class="halo" cx="40" cy="40" r="${DIAL_R}"/>` : ''}<circle class="track${measured ? '' : ' unmeasured'}" cx="40" cy="40" r="${DIAL_R}"/>${pct === null ? '' : arc(pct)}</svg>
        <div class="val">${value}</div>
        ${pulse ? `<span class="sr">a reading just landed</span>` : ''}
      </div>
      <div class="who"><span class="shape" aria-hidden="true">${SHAPE[state]}</span><span class="sr">${esc(stateWord(state, r))}</span><span class="name">${esc(r.name)}</span></div>
      ${state === 'waiting' && r.waitingFor ? `<div class="sub waiting-for">${esc(r.waitingFor)}</div>` : ''}
      ${r.kind === null || r.kind === INTERACTIVE ? '' : `<div class="sub">${esc(r.kind)}</div>`}
      <div class="sub">${esc(r.model)}${r.effort === null ? '' : ` · ${esc(r.effort)}`}</div>
      ${asOf}
    </article>`;
}

/**
 * How old a dated reading is, in the words both surfaces use.
 *
 * `duration` floors to whole minutes, and `--stale-after` takes seconds — so a 30s reading
 * judged against a 2s threshold rendered "! 0m ago": the "!" saying past the threshold and
 * the "0m" saying brand new, in the same breath. Under a minute the age stops pretending to
 * be a round number.
 */
const asOfAge = (ms: number): string => (ms < 60_000 ? '<1m' : duration(ms));

/** The dial's geometry. One radius, named once, so the arithmetic below cannot drift from it. */
const DIAL_R = 30;
const DIAL_C = 2 * Math.PI * DIAL_R;

/**
 * The filled part of the ring, as a fraction of the circle's real circumference.
 *
 * `pathLength="100"` would say the same thing in far prettier markup — "62 filled, 38 empty"
 * — but it is an attribute browsers have not always honoured on basic shapes, and the way it
 * fails is the one this page cannot afford: the dash array is ignored, the arc closes, and
 * every session reads as a full context window. Two decimals is well under a pixel at this
 * radius, and it keeps the markup diffable.
 */
function arc(pct: number): string {
  const filled = (Math.min(100, Math.max(0, pct)) / 100) * DIAL_C;
  return (
    `<circle class="arc" cx="40" cy="40" r="${DIAL_R}" transform="rotate(-90 40 40)"` +
    ` stroke-dasharray="${round2(filled)} ${round2(DIAL_C - filled)}"/>`
  );
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function ctxCell(r: FleetRow): string {
  if (r.ctxPct === null) {
    return `${dash()} <span class="dim">${esc(CTX_WHY[r.ctxState] ?? '')}</span>`;
  }
  // A stale reading is still the truth — of an earlier moment. Show it, and date it, with
  // the same "!" the terminal marks it with: an age in the same grey as everything else is
  // decoration, and this is the one thing the first live demo got wrong.
  //
  // The age is re-checked rather than asserted. `stale` and a known age are coupled in
  // `buildFleet`, one module away, and a `!` assertion here rendered `duration(null)` as
  // "! 0m ago" — a missing measurement as a zero, contradicting itself in the same breath
  // (the "!" says past the threshold, the "0m" says brand new). The terminal path already
  // re-checked it; the two surfaces are not allowed to disagree about the module's own rule.
  const asOf =
    r.stale && r.snapshotAgeMs !== null ? ` <span class="stale">! ${esc(asOfAge(r.snapshotAgeMs))} ago</span>` : '';
  return `<span class="bar"><i style="width:${Math.min(100, r.ctxPct)}%"></i></span>${r.ctxPct}%${asOf}`;
}

/** A partial sum is never presented as the fleet's total. */
function cost(health: FleetHealth): string {
  if (health.costUsd === null) return `<span class="dim">cost —</span>`;
  const partial = costQualifier(health);
  if (partial === '') return `$${health.costUsd.toFixed(2)}`;
  return `$${health.costUsd.toFixed(2)} <span class="dim">${esc(partial.trim())}</span>`;
}

/**
 * What the total is a total OF. The denominator is the sessions that really carry a cost —
 * counting the ones that merely have a snapshot is how `$0.00` once got printed as the
 * fleet's cost with no qualifier at all.
 */
function costQualifier(health: FleetHealth): string {
  return health.costReporting < health.sessions ? ` (${health.costReporting}/${health.sessions} reporting cost)` : '';
}

const dash = (): string => '<span class="dim">—</span>';

function duration(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function esc(v: unknown): string {
  if (v === null || v === undefined || v === '') return dash();
  return String(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c] as string,
  );
}
