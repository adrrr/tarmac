// P3 — the renderers. Everything a human reads comes out of this module: the terminal
// table, the install plan, and the dashboard page. One string each, no framework, no build
// step, no external asset: an `npx` tool has no business shipping a bundler.
//
// Rendering rule that matches the data model: a missing measurement renders as an em dash.
// A dashboard that prints `0%` where it means "I could not look" is how a blind sensor
// stays invisible for days. The two surfaces say the same things in their own words — so
// they are written side by side, and the suite can reach both.

import { formatDuration } from './config.ts';
import type { Config, Source } from './config.ts';
import { buildMap, INTERACTIVE, stateOf } from './map.ts';
import type { MapNode, NodeState } from './map.ts';
import { schemaNotice } from './schema.ts';
import { LIMIT_WINDOWS, RESET_HORIZON_MS, readLimits } from './limits.ts';
import type { Gauge, LimitWhy } from './limits.ts';
import { accountLimits, busyOnStaleFleet } from './fleet.ts';
import type { Fleet, FleetHealth, FleetRow } from './fleet.ts';
import type { Plan, UninstallMode, UninstallPlan } from './install.ts';

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
    // A relocation is a change to where the telemetry lands, so it is never implied.
    if (plan.movingFrom !== null)
      rows.push(['↳ moving from', `${plan.movingFrom}   (its payloads are left there, and nothing collects them)`]);
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
export function renderSettings(config: Config, configFile: string): string {
  const rows: Array<[string, string, Source]> = [
    ['freshness', formatDuration(config.staleAfterMs.value), config.staleAfterMs.source],
    ['port', String(config.port.value), config.port.source],
    ['snapshots', config.snapshotsDir.value, config.snapshotsDir.source],
  ];
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
  const body = rows.map((r) => [
    r.project ?? '—',
    stateCell(r),
    r.ctxPct === null ? `— ${r.ctxState}` : `${r.ctxPct}%`,
    // The age of the reading, never implied to be "now".
    r.snapshotAgeMs === null ? '—' : ahead(r) ? '— ahead' : `${age(r.snapshotAgeMs)}${r.stale ? ' !' : ''}`,
    r.model ?? '—',
    r.effort ?? '—',
    r.costUsd === null ? '—' : `$${r.costUsd.toFixed(2)}`,
    r.uptimeMs === null ? '—' : `${Math.round(r.uptimeMs / 3600000)}h`,
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd();

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
  // Covers both "not allowed to look" and "there is nothing there to look at", so the words
  // have to fit an errno as well as a path that points nowhere.
  if (health.snapshotsError) warns.push(`! snapshots unavailable — ${health.snapshotsError}`);
  else if (health.schemaBroken) warns.push('! every snapshot drifted — the statusline payload schema moved');
  else if (health.covered < health.sessions)
    warns.push(
      // The count travels, for the same reason `unreadable` does one line up: without it
      // this line reads as "run install", and for a session id the wrapper declines to file
      // that is advice already taken which can never work.
      health.unfilable > 0
        ? `! statusline chained on ${health.covered}/${health.sessions} sessions — ${health.unfilable} session(s) with an id tarmac never files`
        : `! statusline chained on ${health.covered}/${health.sessions} sessions`,
    );
  if (health.stale > 0)
    warns.push(`! ${health.stale} reading(s) marked "!" are older than ${formatDuration(health.staleAfterMs)} (--stale-after)`);
  const skewed = rows.filter(ahead).length;
  if (skewed > 0) warns.push(`! ${skewed} reading(s) are dated in the future — ${SKEW}`);
  if (health.unknownStatus > 0) warns.push(`! ${health.unknownStatus} session(s) report an unknown status`);
  // Last, and never instead of anything above: this one is a heads-up, not a fault.
  const schema = schemaNotice(health.schemaGuard);
  if (schema) warns.push(`! ${schema}`);

  const total = health.costUsd === null ? 'cost —' : `$${health.costUsd.toFixed(2)}${costQualifier(health)}`;

  return (
    [line(head), ...body.map(line)].join('\n') +
    '\n' +
    (warns.length ? '\n' + warns.join('\n') + '\n' : '') +
    `\n${health.sessions} sessions · ${health.busy} busy · ${total}\n`
  );
}

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
  if (health.snapshotsError) {
    // A permission error is ours to report, not the user's to be blamed for.
    warnings.push(`The snapshot directory could not be used — ${health.snapshotsError}. Context readings are unavailable, and this is not an install problem.`);
  } else if (health.schemaBroken) {
    warnings.push(
      `Every snapshot drifted — Claude Code's statusline schema has probably moved. Context readings are dead until the payload shape is re-checked.`,
    );
  } else if (health.covered < health.sessions) {
    const blind = health.sessions - health.covered;
    warnings.push(
      health.unfilable === 0
        ? `Statusline chained on ${health.covered}/${health.sessions} sessions — the rest report no context. Run \`tarmac install\` and give them one TUI frame.`
        : health.unfilable >= blind
          ? `Statusline chained on ${health.covered}/${health.sessions} sessions — the rest carry a session id that is not the UUID tarmac files snapshots under, so no frame will ever produce one. Installing again will not change that.`
          : `Statusline chained on ${health.covered}/${health.sessions} sessions — ${blind} report no context, and ${health.unfilable} of them will never be filed: the session id is not the UUID tarmac files snapshots under. For the others, run \`tarmac install\` and give them one TUI frame.`,
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
  const notes: string[] = [];
  // Not under the stall banner, which names the same threshold two lines up: the pair reads as
  // the alarm followed by its own excuse, and the excuse is the reading the alarm exists to
  // tell you not to accept.
  if (health.stale > 0 && stalled === 0) {
    notes.push(
      `Readings past the ${formatDuration(health.staleAfterMs)} freshness threshold are dated where they sit — a statusline is only written when its terminal draws a frame, so an idle session's number is "as of" its last one. Set another with --stale-after.`,
    );
  }
  const schema = schemaNotice(health.schemaGuard);
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
<div class="meta">${health.sessions} session${health.sessions === 1 ? '' : 's'} · ${health.busy} busy · ${cost(health)} · ${esc(new Date(health.generatedAt).toISOString())}</div>
${warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
${body}
<div id="fleet-notes">${notes.map((n) => `<div class="note">${esc(n)}</div>`).join('')}</div>`;
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
  const account = accountLimits(rows);
  const gauges = readLimits(account === null ? null : account.rateLimits, health.generatedAt)
    .map(gauge)
    .join('');
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
  return gauges + (stale ? `<span class="stale">! ${esc(asOfAge(account!.ageMs))} ago</span>` : '');
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
    `<span class="reset">${g.pct === null ? LIMIT_WHY[g.why!] : resetWords(g.resetsInMs)}</span></div>`
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
const resetWords = (ms: number | null): string =>
  ms === null ? `reset ${dash()}` : ms > 0 ? `resets in ${left(ms)}` : `reset was due ${left(-ms)} ago`;

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

/** Which of the two surfaces the shell opens on. */
export type View = 'table' | 'map';

export function renderPage(fleet: Fleet, view: View = 'table'): string {
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
  :root { color-scheme: light dark; --fg:#111; --dim:#6b7280; --line:#e5e7eb; --bg:#fff; --warn:#b45309; --warnbg:#fffbeb; --busy:#047857; --wait:#1d4ed8; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e5e7eb; --dim:#9ca3af; --line:#374151; --bg:#0b0f14; --warn:#fbbf24; --warnbg:#231a06; --busy:#34d399; --wait:#93c5fd; } }
  body { margin:0; padding:2rem 1.25rem; background:var(--bg); color:var(--fg);
         font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",sans-serif; }
  header { display:flex; align-items:baseline; gap:1rem; flex-wrap:wrap; margin-bottom:1rem; }
  h1 { font-size:1.1rem; margin:0; letter-spacing:.02em; }
  .meta { color:var(--dim); font-size:.85rem; }
  /* Honest, and out of the way of the fleet: three of these stacked at full padding pushed
     the table below the fold on a laptop, which is its own kind of hidden. */
  .warn { background:var(--warnbg); color:var(--warn); border:1px solid currentColor; border-radius:6px;
          padding:.35rem .65rem; margin:.3rem 0; font-size:.8rem; line-height:1.45; }
  .warn:last-of-type { margin-bottom:.9rem; }
  /* The footnote: same words, none of the weight. Dim, small, below the fleet and with no box
     around it, because what it carries is true rather than urgent — the threshold that dated a
     reading, the payload shapes nobody has captured yet. It reads as chrome to someone
     scanning their sessions and as an answer to someone who came looking for it. */
  .note { color:var(--dim); font-size:.75rem; line-height:1.5; margin:.9rem 0 0; max-width:95ch; }
  .stale { color:var(--warn); font-weight:600; }
  .wrap { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; min-width:44rem; }
  th { text-align:left; font-weight:600; font-size:.75rem; text-transform:uppercase; letter-spacing:.06em;
       color:var(--dim); padding:.4rem .6rem; border-bottom:1px solid var(--line); white-space:nowrap; }
  td { padding:.5rem .6rem; border-bottom:1px solid var(--line); white-space:nowrap; }
  td.num { font-variant-numeric:tabular-nums; }
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
  .pulse { display:inline-block; width:.4rem; height:.4rem; border-radius:99px; background:var(--busy); margin-right:.4rem; vertical-align:middle; }
  /* The failing state is carried by the banner's words; the dashed frame only repeats it. */
  body.failing .pulse { background:var(--warn); }
  body.failing #live { border:1px dashed var(--warn); border-radius:8px; padding:.5rem; }
  .offline strong { white-space:nowrap; }
  /* The tabs, and what they hide. The shell owns the choice — not the fragment — so a poll
     that swaps the fleet underneath cannot put the reader back on a view they left. */
  nav { display:flex; gap:.15rem; }
  nav a { color:var(--dim); text-decoration:none; font-size:.8rem; font-weight:600; text-transform:uppercase;
          letter-spacing:.06em; padding:.15rem .55rem; border-radius:99px; border:1px solid transparent; }
  nav a[aria-current="page"] { color:var(--fg); border-color:var(--line); }
  body[data-view="table"] .view-map { display:none; }
  body[data-view="map"] .view-table { display:none; }

  /* ── the account's two windows ───────────────────────────────────────────────────────
     In the header, because a rate limit is the account's and not a node's. Slim on purpose:
     the fleet is what the page is about, and these two numbers are the weather it flies in.
     Laid out with flex behind the same :not([hidden]) guard the replay containers carry —
     the replayed pair ships hidden, and a display in a stylesheet beats the attribute. */
  .limits:not([hidden]) { display:flex; gap:1rem; flex-wrap:wrap; align-items:center; }
  .gauge { display:flex; align-items:baseline; gap:.35rem; font-size:.8rem; }
  /* Not upper-cased, alone among the small labels on this page: "5H" is not an hour, and a
     unit that has been shouted reads as a different unit. */
  .gauge .lbl { color:var(--dim); font-weight:600; letter-spacing:.04em; }
  .gauge .num { font-variant-numeric:tabular-nums; font-weight:650; }
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
  .replay button { font:inherit; font-size:.8rem; color:var(--fg); background:transparent;
            border:1px solid var(--line); border-radius:99px; padding:.15rem .8rem; cursor:pointer; }
  .replay input[type="range"] { flex:1; min-width:10rem; accent-color:var(--dim); }
  .replay input[type="range"]:disabled { opacity:.4; }
  /* The two things the reader has to be able to read while dragging: the minute under the
     handle, and what the whole range covers. Tabular, so neither jitters as it counts. */
  #replay-at { font-variant-numeric:tabular-nums; font-weight:600; }
  .replay .covers { flex-basis:100%; color:var(--dim); font-size:.75rem; }
  /* The banner wears the warning style on purpose: a page showing a past minute as though it were the
     fleet is the worst thing this dashboard could do, so it wears the loudest thing it has. */
  /* Sticky, because the handle is at the bottom of a map that can be taller than the
     viewport: a reader dragging with the "this is the past" banner scrolled off the top is
     a reader the banner is not warning. */
  .replaying-note:not([hidden]) { display:flex; align-items:baseline; gap:.6rem; flex-wrap:wrap;
            position:sticky; top:0; z-index:1; }
  .replaying-note button { font:inherit; font-size:.75rem; font-weight:600; color:inherit;
            background:transparent; border:1px solid currentColor; border-radius:99px;
            padding:.05rem .7rem; cursor:pointer; }

  /* ── the map ─────────────────────────────────────────────────────────────────────────
     One node per session. The arc is the context, its weight is how much that reading may
     be believed, and the halo — the only thing on this page that moves — says a frame
     landed moments ago. None of the three exists for a background agent, which has no
     terminal to draw a statusline frame with: it is a strip instead, further down. */
  /* Nodes of two heights in one grid: a row of cards may not stretch the strips beside it to
     the height of a dial they do not have. */
  .map { display:grid; gap:.9rem; grid-template-columns:repeat(auto-fill,minmax(10.5rem,1fr));
         align-items:start; }
  .node { border:1px solid var(--line); border-radius:10px; padding:.8rem .85rem .7rem;
          display:flex; flex-direction:column; align-items:center; text-align:center; }
  .node[data-state="busy"] { border-color:color-mix(in srgb, var(--busy) 45%, var(--line)); }
  .node[data-state="waiting"] { border-color:color-mix(in srgb, var(--wait) 45%, var(--line)); }
  /* An agent is not a smaller session — it is a strip. It was a card at three quarters scale,
     which put a dial on a session that has no terminal to draw a statusline frame with: a ring
     that can never fill, captioned with the words of a fault someone could go and repair. The
     honest form is the one the table already speaks in — text on a line, left-aligned, its
     state in the same glyph and in a three-pixel accent down the left edge. */
  .node[data-role="agent"] { align-items:stretch; text-align:left;
          padding:.5rem .7rem .55rem; border-radius:8px;
          background:color-mix(in srgb, var(--line) 18%, transparent);
          /* The box goes back to the neutral line the tinted rule above gave it: the accent is
             the channel that carries state here, and a strip outlined in its hue as well was
             the same fact said twice, in two weights, on a shape half the size of a card. */
          border-color:var(--line); border-left-width:3px; border-left-color:var(--dim); }
  .node[data-role="agent"][data-state="busy"] { border-left-color:var(--busy); }
  .node[data-role="agent"][data-state="waiting"] { border-left-color:var(--wait); }
  .node[data-role="agent"][data-state="unknown"] { border-left-color:var(--warn); }
  .node[data-role="agent"] .who { margin-top:0; width:100%; }
  .node[data-role="agent"] .project { font-weight:600; font-size:.8rem; }
  /* What the node calls itself, set apart from the project it sits beside: an agent's own line
     already reads as a sentence, and the kind is the word that says it is not a terminal. */
  .kind { margin-left:auto; font-size:.6rem; font-weight:700; text-transform:uppercase;
          letter-spacing:.08em; color:var(--dim); }
  /* The prompt a background session was named after. One line, clipped: it is a sentence
     somebody typed, and it is the only thing on the strip that has no length limit. */
  .prompt { color:var(--dim); font-size:.76rem; margin-top:.15rem;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  /* Said, not shown: the three glyphs differ in silhouette, so a reader who cannot separate
     two hues still has the state — but a screen reader is handed a bullet and nothing else. */
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
  .dial { position:relative; width:5.5rem; height:5.5rem; }
  .dial svg { width:100%; height:100%; display:block; overflow:visible; }
  .track { fill:none; stroke:var(--line); stroke-width:5; }
  /* Butt caps, not round: a rounded cap adds half a stroke width at each end, which draws a
     1% reading at three times its extent. The prettier cap overstates every small number. */
  .arc { fill:none; stroke:var(--dim); stroke-width:5; }
  .node[data-state="busy"] .arc { stroke:var(--busy); }
  /* A reading past the freshness threshold is drawn as what it is: thin, faded, and in the
     warning hue — never the solid arc of a live one. Its EXTENT stays true, because the
     number is still the truth of an earlier moment; and a dash pattern here would overwrite
     stroke-dasharray, which is what carries the percentage. */
  .node[data-reading="stale"] .arc, .node[data-reading="undated"] .arc {
          stroke:var(--warn); stroke-width:2.5; opacity:.7; }
  /* A replayed reading. Its EXTENT is what the record vouches for; its age is the one thing
     the ring never kept, so it may not wear the solid arc that means "as current as a reading
     gets" — nor the warning hue of a stale one, which would claim the opposite. Between the
     two: full colour, a shade lighter, and no date underneath it. */
  .node[data-reading="undatable"] .arc { stroke-width:4; opacity:.85; }
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
  .pct { font-size:1.25rem; font-weight:650; letter-spacing:-.01em; }
  .pct i { font-style:normal; font-size:.7em; font-weight:500; color:var(--dim); }
  .why { font-size:.68rem; color:var(--dim); line-height:1.2; max-width:4.4rem; }
  .why b { display:block; font-size:1.25rem; font-weight:400; }
  .who { margin-top:.5rem; display:flex; align-items:baseline; gap:.3rem; max-width:100%; }
  .who .project { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .node[data-state="busy"] .who .project { font-weight:700; }
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
  @media (max-width: 30rem) { .map { grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr)); gap:.6rem; } }

  /* Below this the table stops being a table: one card per session, every value keeping the
     name of the column it came from. Nothing is dropped — a phone that hides the context
     column would be a phone that renders "not measured" as nothing at all. */
  @media (max-width: 46rem) {
    body { padding:1.25rem .75rem; }
    .wrap { overflow-x:visible; }
    table, tbody, tr, td { display:block; }
    table { min-width:0; }
    thead { display:none; }
    tr { border:1px solid var(--line); border-left-width:3px; border-radius:8px;
         padding:.35rem .7rem; margin-bottom:.6rem; }
    tr[data-state="busy"] { border-left-color:var(--busy); }
    tr[data-state="waiting"] { border-left-color:var(--wait); }
    tr[data-state="unknown"] { border-left-color:var(--warn); }
    /* A strip sharing a phone's width with a card is an ellipsis where the prompt was — the
       one line saying what this agent was told to do is the first thing a narrow column takes
       away. It spans the row instead, like the cells below it. */
    .node[data-role="agent"] { grid-column:1 / -1; }
    td, td:first-child { border:0; padding:.2rem 0; white-space:normal;
         display:flex; justify-content:space-between; align-items:baseline; gap:1rem; }
    td::before { content:attr(data-label); color:var(--dim); font-size:.72rem; font-weight:600;
         text-transform:uppercase; letter-spacing:.06em; flex:none; }
    .v { text-align:right; }
    .bar { display:none; }
  }
</style>
</head><body data-view="${view}">
<header>
  <h1>tarmac</h1>
  <!-- Links, not buttons: the view survives a reload, a bookmark and a browser with
       JavaScript off — the state of a page whose own noscript banner promises it is still
       readable. Both views are in the fragment below either way, so switching costs the
       server nothing and the two can never show readings of different ages. -->
  <nav>
    <a href="/"${view === 'table' ? ' aria-current="page"' : ''}>Table</a>
    <a href="/map"${view === 'map' ? ' aria-current="page"' : ''}>Map</a>
  </nav>
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
  <div class="map" id="replay-map"></div>
</div>
<!-- A dead handle is worse than no handle: this is revealed once the record is in hand, and
     what it says it covers is whatever the record answered with. -->
<div class="replay" id="replay" hidden>
  <button type="button" id="play">Play</button>
  <input type="range" id="scrub" min="0" max="0" step="1" value="0" disabled aria-label="Replay position">
  <div class="covers" id="covers"></div>
</div>
<script>${pageScript(view)}</script>
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
 * browser — fed the same three words, the same three glyphs and the same dial geometry as the
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

  function ago(ms) {
    // A clock that steps backwards (an NTP correction, a laptop waking) must not produce
    // "updated -3s ago". Zero is the floor.
    var s = Math.round(Math.max(0, ms) / 1000);
    if (s < 60) return s + 's';
    var m = Math.round(s / 60);
    return m < 60 ? m + 'm' : Math.round(m / 60) + 'h';
  }

  function fail(why_) {
    failing = true;
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
      });
    }).catch(function (e) {
      if (!mineStill()) return;
      failing = true;
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
  var rview = document.getElementById('replay-view'), rmap = document.getElementById('replay-map');
  var rmeta = document.getElementById('replay-meta'), note = document.getElementById('replaying');
  var rlimits = document.getElementById('replay-limits');
  var atEl = document.getElementById('replay-at'), toLive = document.getElementById('to-live');
  var record = null, recordAt = 0, at = -1, replaying = false, playing = null, hgen = 0;

  // The vocabulary and the geometry, handed over rather than written twice: three words for
  // the three kinds of missing, three glyphs for the three states, one dial radius.
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
  function hhmm(t) { var d = new Date(t); return two(d.getHours()) + ':' + two(d.getMinutes()); }

  // A day-long ring can straddle one midnight, and "09:14 – 08:59" reads as a span running
  // backwards until the older edge says which day it is.
  function edge(t, ref) {
    return hhmm(t) + (new Date(t).getDate() === new Date(ref).getDate() ? '' : ' yesterday');
  }

  // What the range covers, in the record's own terms. Never "a day": that is the size of the
  // ring, and a serve ten minutes old has seen ten minutes.
  function coversText() {
    var n = record.samples.length;
    if (n === 0) {
      // A record empty because every reading FAILED is not a record that has just started, and
      // this was the one branch that threw that away: ten hours of a collector that could not
      // run read exactly like a serve thirty seconds old.
      return record.missed
        ? 'Nothing recorded — this serve started at ' + hhmm(record.since) + ' and '
          + record.missed + ' minute' + (record.missed === 1 ? '' : 's') + ' were due and never read.'
        : 'Nothing recorded yet — this serve started at ' + hhmm(record.since)
          + ' and takes a reading every ' + Math.round(record.cadence / 1000) + 's.';
    }
    var last = record.samples[n - 1].t;
    return 'Covering ' + edge(record.since, last) + ' – ' + hhmm(last)
      // Not "when the page loaded": the record is asked for again when a tab that has been
      // away comes back, so the sentence names the last time this page asked rather than a
      // moment it may be hours past.
      + ', as this page last had it — ' + n + ' reading' + (n === 1 ? '' : 's')
      // A gap that says it is a gap is not a gap. The handle steps through readings, not
      // through minutes, and a record with holes in it is not a smooth walk.
      + (record.missed ? ', ' + record.missed + ' minute' + (record.missed === 1 ? '' : 's') + ' with no reading' : '')
      + '. The record keeps each reading, not how old that reading was, so nothing replayed here is dated.';
  }

  function ready() {
    var n = record.samples.length;
    replay.hidden = false;
    covers.textContent = coversText();
    scrub.max = String(n === 0 ? 0 : n - 1);
    scrub.disabled = n === 0;
    playBtn.disabled = n === 0;
  }

  // Revealed, not hidden, when the record cannot be had: a scrubber that silently never
  // appears is indistinguishable from one this build does not have.
  function noRecord(said) {
    replay.hidden = false;
    scrub.disabled = true;
    playBtn.disabled = true;
    covers.textContent = said;
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
    // names. What it does hold for one is what it cost, which is printed like anywhere else.
    if (role === 'agent') {
      return '<article class="node" data-role="agent" data-state="' + state + '" data-reading="undatable">'
        + '<div class="who"><span class="shape" aria-hidden="true">' + SHAPE[state] + '</span>'
        + '<span class="sr">' + state + '</span>'
        + '<span class="project">' + esc(x.project) + '</span>'
        + '<span class="kind">' + esc(x.kind) + '</span></div>'
        + (state === 'waiting' && x.waitingFor ? '<div class="sub waiting-for">' + esc(x.waitingFor) + '</div>' : '')
        + (pct === null ? '' : '<div class="sub">' + pct + '%</div>')
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
    // In the order the sample carries. The live map places an agent beside the session it
    // shares a directory with; the ring holds no directory, so the past is drawn in the order
    // the fleet was sorted in rather than in a grouping this page would have to invent.
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

  function draw(i) {
    var s = record && record.samples[i];
    if (!s) return;
    at = i;
    replaying = true;
    scrub.value = String(i);
    // The handle's own value is an index, so a reader who cannot see the banner would be read
    // "3" while the fleet on screen is three hours old. The minute travels with the handle.
    scrub.setAttribute('aria-valuetext', hhmm(s.t));
    atEl.textContent = hhmm(s.t);
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
  // `data-label` is not decoration: below ~46rem the columns stack, the header row is gone,
  // and a value whose column has no name is a bare "—" that could mean anything.
  // Every cell holds exactly ONE element. Stacked on a phone the label sits left and the
  // value right, and two sibling nodes in one cell get pushed to opposite ends of the card —
  // which is how "63%" once ended up stranded in the middle of a row, under the wrong label.
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
 * The map: one node per session, laid out as a grid rather than a graph. An empty fleet is not
 * its business — `renderLive` says that once, above both views, rather than letting each of
 * them render the same sentence and hide one of the two.
 *
 * There are no edges because the sources publish no relationship between two sessions — the
 * one thing they do carry is the working directory, and that is expressed by putting an
 * agent NEXT to the session it shares a directory with, never by drawing a line that would
 * claim more than the data says.
 *
 * Everything a reader interprets is decided in `map.ts` and rendered here, on the server,
 * for the same reason the table is: the rules that keep a reading honest are tested, and a
 * copy of them re-derived in browser JavaScript would sit where this suite cannot reach.
 */
export function renderMap(fleet: Fleet): string {
  return `<div class="map">${buildMap(fleet).nodes.map(renderNode).join('')}</div>`;
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
 * terminal, so four of those five facts exist for it. A background agent has none, and gets
 * the strip below — same data attributes, same glyph, same words to a screen reader.
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
  // The strip. Everything the card's lower half carried — the percentage, the model, the
  // effort — comes off a statusline snapshot, and a background session has no terminal to draw
  // one: those fields are not late for an agent, they are structurally absent. The dial said so
  // as "not chained", which is the vocabulary of a repairable fault ("run `tarmac install`")
  // for a session no install can ever cover. So the strip claims no context at all — no gauge,
  // no dash, no reason — and carries what the source really publishes about an agent: its
  // state, its project, the kind it calls itself, and the prompt it was named after.
  //
  // Nor a halo: the pulse is drawn inside the dial and announces a frame landing, which is the
  // one event that cannot happen here. Nothing is lost with the shape that held it.
  //
  // The one number that can still appear: should the source ever publish a percentage for a
  // background session, the join has a sessionId to hang it on, and it is printed inline —
  // beside its age when the reading is one nobody should take for current — rather than
  // bringing back a ring that would be empty on every other agent on the page.
  if (role === 'agent') {
    return `<article class="node" data-role="${role}" data-state="${state}" data-reading="${reading}">
      <div class="who"><span class="shape" aria-hidden="true">${SHAPE[state]}</span><span class="sr">${esc(stateWord(state, r))}</span><span class="project">${esc(r.project)}</span><span class="kind">${esc(r.kind)}</span></div>
      <div class="prompt">${esc(r.name)}</div>
      ${state === 'waiting' && r.waitingFor ? `<div class="sub waiting-for">${esc(r.waitingFor)}</div>` : ''}
      ${pct === null ? '' : `<div class="sub">${pct}%</div>`}
      ${asOf}
    </article>`;
  }
  // An agent carries its own project, like every other node. Placement is not a promise —
  // the grid wraps where the viewport says, and the fleet's sort can hand the same agent a
  // different neighbour on the next poll — so nothing here points at the node beside it.
  return `<article class="node" data-role="${role}" data-state="${state}" data-reading="${reading}">
      <div class="dial">
        <svg viewBox="0 0 80 80" aria-hidden="true">${pulse ? `<circle class="halo" cx="40" cy="40" r="${DIAL_R}"/>` : ''}<circle class="track${measured ? '' : ' unmeasured'}" cx="40" cy="40" r="${DIAL_R}"/>${pct === null ? '' : arc(pct)}</svg>
        <div class="val">${value}</div>
        ${pulse ? `<span class="sr">a reading just landed</span>` : ''}
      </div>
      <div class="who"><span class="shape" aria-hidden="true">${SHAPE[state]}</span><span class="sr">${esc(stateWord(state, r))}</span><span class="project">${esc(r.project)}</span></div>
      ${state === 'waiting' && r.waitingFor ? `<div class="sub waiting-for">${esc(r.waitingFor)}</div>` : ''}
      <div class="sub">${esc(r.name)}</div>
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
