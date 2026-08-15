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
    r.busy === true ? 'busy' : r.busy === false ? 'idle' : `?${r.status ?? ''}`,
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
  if (health.stale > 0) {
    warnings.push(
      `${health.stale} reading(s) are older than the ${formatDuration(health.staleAfterMs)} freshness threshold — a statusline is only written when its terminal draws a frame, so an idle session's number is "as of" its last one. Set another with --stale-after.`,
    );
  }
  const skewed = rows.filter(ahead).length;
  if (skewed > 0) {
    warnings.push(`${skewed} reading(s) are dated in the future — ${SKEW}. They are shown undated rather than as brand new.`);
  }
  const schema = schemaNotice(health.schemaGuard);
  if (schema) warnings.push(schema);

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
      : `<div class="view view-table"><div class="wrap"><table>
      <thead><tr>
        <th>Project</th><th>Session</th><th>State</th><th>Context</th><th>Model</th><th>Effort</th><th>Cost</th><th>Uptime</th>
      </tr></thead>
      <tbody>${rows.map(renderRow).join('')}</tbody>
    </table></div></div>
<div class="view view-map">${renderMap(fleet)}</div>`;

  return `<div class="meta">${health.sessions} session${health.sessions === 1 ? '' : 's'} · ${health.busy} busy · ${cost(health)} · ${esc(new Date(health.generatedAt).toISOString())}</div>
${warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
${body}`;
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
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>tarmac — fleet</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --dim:#6b7280; --line:#e5e7eb; --bg:#fff; --warn:#b45309; --warnbg:#fffbeb; --busy:#047857; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e5e7eb; --dim:#9ca3af; --line:#374151; --bg:#0b0f14; --warn:#fbbf24; --warnbg:#231a06; --busy:#34d399; } }
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
  .pill.unknown { color:var(--warn); }
  .pill.idle { color:var(--dim); font-weight:400; }
  /* The weight the sort deserves: busy rows carry an accent and a bold name. */
  td:first-child { border-left:3px solid transparent; }
  tr[data-state="busy"] td:first-child { border-left-color:var(--busy); }
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

  /* ── the map ─────────────────────────────────────────────────────────────────────────
     One node per session. The arc is the context, its weight is how much that reading may
     be believed, and the halo — the only thing on this page that moves — says a frame
     landed moments ago. */
  .map { display:grid; gap:.9rem; grid-template-columns:repeat(auto-fill,minmax(10.5rem,1fr)); }
  .node { border:1px solid var(--line); border-radius:10px; padding:.8rem .85rem .7rem;
          display:flex; flex-direction:column; align-items:center; text-align:center; }
  .node[data-state="busy"] { border-color:color-mix(in srgb, var(--busy) 45%, var(--line)); }
  /* An agent is a smaller body in the same system, next to the session it shares a directory
     with — never inside it. Tinted rather than outlined, and hooked, so it reads as the
     session's dependent without a line claiming a parentage the source never published. */
  .node[data-role="agent"] { padding-top:.55rem; border-color:transparent;
          background:color-mix(in srgb, var(--line) 22%, transparent); }
  .node[data-role="agent"] .dial { width:3.6rem; height:3.6rem; }
  .node[data-role="agent"] .pct { font-size:.95rem; }
  .node[data-role="agent"] .why { font-size:.6rem; max-width:3.4rem; }
  .node[data-role="agent"] .why b { font-size:1rem; }
  .node[data-role="agent"] .project { font-weight:400; }
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
  /* Nothing was measured. Keyed on the measurement and never on the age of the file: a
     solid empty ring is what a session measured at 0% wears, and the two must not match. */
  .track.unmeasured { stroke-dasharray:2 6; stroke-linecap:round; }
  /* Once per arrival, not forever: the fragment is replaced on every poll, so a single run
     per swap is what makes the fleet breathe at the rate its frames actually land. A looping
     animation would say "a frame just arrived" for five seconds after it stopped being true. */
  .halo { fill:none; stroke:var(--busy); stroke-width:2; opacity:0; transform-origin:50% 50%;
          animation:halo 1.6s ease-out 1; }
  .node[data-state="idle"] .halo { stroke:var(--dim); }
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
  .node[data-state="unknown"] .shape { color:var(--warn); }
  .sub { color:var(--dim); font-size:.76rem; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
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
    tr[data-state="unknown"] { border-left-color:var(--warn); }
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
  <!-- Not "updated just now". If the script never runs — a policy-injected CSP without
       'unsafe-inline', a script error — that text would stand as a permanent lie, and
       <noscript> would not fire to correct it because JavaScript is enabled. The page's one
       honest claim must not default to a claim at all; the first tick fills it in. -->
  <span class="freshness"><span class="pulse" aria-hidden="true"></span><span id="age">updated &mdash;</span></span>
</header>
<div class="warn offline" id="offline" hidden>
  <strong>&#9888; refresh failing</strong> — nothing below has moved since the time in the header.
  <span id="why"></span>
</div>
<noscript><div class="warn">JavaScript is off, so this page will not refresh itself. Reload it to see the fleet now.</div></noscript>
<div id="live">${renderLive(fleet)}</div>
<script>${SCRIPT}</script>
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
 * The page therefore owns exactly two facts: when it last heard from the server, and whether
 * the last attempt failed. Everything a reader interprets is rendered by `renderLive` on the
 * server, where the suite can reach it.
 */
export const REFRESH_MS = 5000;

/**
 * How long a request may stay out before the page calls it a failure. Deliberately above the
 * collector's own 15s timeout (`discoverSessions`), so a slow-but-healthy fleet always fails
 * on the server side first and arrives with a real reason instead of this generic one.
 */
const STALL_MS = 20000;

const SCRIPT = `
(function () {
  var live = document.getElementById('live'), age = document.getElementById('age');
  var off = document.getElementById('offline'), why = document.getElementById('why');
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

  setInterval(tick, 1000);
  setInterval(function () { if (!document.hidden) poll(); }, ${REFRESH_MS});
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
})();
`;

/**
 * The sort puts busy first, unknown next, idle last. This is where that order is given its
 * weight — an accent down the row and a bold name for the ones that are working, a quiet row
 * for the ones that are not.
 *
 * The state travels three ways at once: a shape, a word, and an attribute. Colour alone is
 * no signal to a reader who cannot separate two of ours, and `data-state` is what the narrow
 * layout hangs its accent on once the table has stopped being a table.
 */
function renderRow(r: FleetRow): string {
  const state = stateOf(r);
  const word = stateWord(state, r);
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

const SHAPE: Record<NodeState, string> = { busy: '●', unknown: '▲', idle: '○' };

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
 * One node. Four facts, in four channels that do not depend on colour alone: the arc is how
 * full the context is, the dial's weight is how much that reading may be believed, the shape
 * beside the name is the session's state, and the words under it are the same ones the table
 * uses for the same conditions.
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
