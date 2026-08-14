// P4 — the schema guard: what tarmac has actually looked at, versus what it is being fed.
//
// Every field this tool reads was OBSERVED on a Claude Code build and frozen in `fixtures/`;
// none of it is promised by a published schema. The defences already in place fire once a
// field has broken — `ctxState: 'drift'` when a key is gone, `schemaBroken` when every
// snapshot drifted. They are the alarm. This is the smoke detector: a build nobody has ever
// captured is a reason to LOOK, never a reason to stop reporting, and never a reason to exit
// non-zero.
//
// It judges EVERY distinct version in flight, not the newest one. A fleet is normally
// running two builds at once — Claude Code updates itself, sessions live for days — and the
// straggler is precisely the session on a shape nobody captured. A first cut compared only
// the highest version seen, which meant one surviving session on a known build vouched for
// six running an unknown one; a release that merely DROPPED `version` was silent that way.
//
// Membership is exact string equality: `2.1.226-rc.1` is not `2.1.226`, and a prerelease
// must not inherit the silence of the release it prefixes.
//
// Known blind spot: the version is read off the statusline payload, so a machine with no
// statusline chained gives this guard nothing to judge — including about `claude agents
// --json`, which carries no version of its own. That fleet gets the "chained on 0/N"
// warning instead, which is about installation, not about schema.

/** The two surfaces tarmac reads, each with its own fixture family. */
export type Surface = 'statusline' | 'agents';

/**
 * The Claude Code versions whose payloads are frozen in `fixtures/` — and therefore the
 * only ones any of this tool's field names have been seen to be true of.
 *
 * Baked into src on purpose: only `dist/` is published, so a released tarmac has no
 * `fixtures/` to read at runtime. `test/schema.test.ts` compares this list against the
 * directory, so the two cannot drift apart in the repo.
 */
export const CHECKED_VERSIONS: Record<Surface, readonly string[]> = {
  statusline: ['2.1.220', '2.1.226'],
  agents: ['2.1.226'],
};

const SURFACE_LABEL: Record<Surface, string> = {
  statusline: 'statusline payload',
  agents: '`claude agents --json`',
};

/** Where a user of a published install can actually go — the script in scripts/ is not one. */
const ISSUES_URL = 'https://github.com/adrrr/tarmac/issues';

export type SchemaGuardState =
  /** every version in flight is covered by a fixture on every surface */
  | 'ok'
  /** at least one real version was never captured on at least one surface */
  | 'unchecked'
  /** at least one live snapshot carries no `version` at all — drift by itself */
  | 'no-version'
  /** no telemetry to judge: nothing chained yet, or an empty fleet */
  | 'nothing';

/** A surface, and the versions in flight it has no fixture for. */
export interface UncheckedSurface {
  surface: Surface;
  versions: string[];
}

export interface SchemaGuard {
  state: SchemaGuardState;
  /** Every distinct Claude Code version seen writing to this fleet, in the order first seen. */
  versions: string[];
  /** How many live snapshots carried no `version` key at all. */
  noVersion: number;
  /** Empty unless something in `versions` has no fixture. */
  unchecked: UncheckedSurface[];
}

/**
 * @param seen the `version` each live snapshot reported — `null` for the ones that had no
 *        such key. Order only affects the order things are named in.
 *
 * The version comes from the statusline payload, which is written by the Claude Code that
 * runs the session — not from `claude --version`, which would describe the binary on PATH
 * and cost a subprocess on every collect. So this reports on the builds actually OBSERVED
 * writing to the fleet.
 */
export function guardVersions(seen: ReadonlyArray<string | null>): SchemaGuard {
  if (seen.length === 0) return { state: 'nothing', versions: [], noVersion: 0, unchecked: [] };

  const versions = [...new Set(seen.filter((v): v is string => typeof v === 'string' && v !== ''))];
  const noVersion = seen.length - seen.filter((v) => typeof v === 'string' && v !== '').length;

  const unchecked: UncheckedSurface[] = [];
  for (const surface of Object.keys(CHECKED_VERSIONS) as Surface[]) {
    const missing = versions.filter((v) => !CHECKED_VERSIONS[surface].includes(v));
    if (missing.length > 0) unchecked.push({ surface, versions: missing });
  }

  // A snapshot that cannot even say which build wrote it is the worse fact, so it leads —
  // but the notice below still reports both.
  const state: SchemaGuardState = noVersion > 0 ? 'no-version' : unchecked.length > 0 ? 'unchecked' : 'ok';
  return { state, versions, noVersion, unchecked };
}

/** What a human should be told, or `null` when there is nothing worth saying. */
export function schemaNotice(guard: SchemaGuard): string | null {
  if (guard.state === 'ok' || guard.state === 'nothing') return null;

  const said: string[] = [];
  if (guard.noVersion > 0) {
    const total = guard.noVersion + guard.versions.length;
    said.push(
      `${guard.noVersion} of ${total} statusline payloads carry no \`version\` — the key tarmac checks its fixtures against is gone on those sessions. ` +
        'That is drift in itself: the readings are still whatever Claude Code sent, but nothing can be checked against a shape anyone has seen.',
    );
  }
  if (guard.unchecked.length > 0) {
    const surfaces = guard.unchecked
      .map((u) => `${SURFACE_LABEL[u.surface]} — ${u.versions.join(', ')} (checked ${CHECKED_VERSIONS[u.surface].join(', ')})`)
      .join('; ');
    said.push(`Claude Code payload shapes that have never been checked: ${surfaces}.`);
  }
  // The advice has to be doable by whoever is reading it — someone who installed with npx
  // and has no scripts/ directory. Capturing a fixture is a maintainer's move, documented
  // in the README, not something to send a user looking for.
  said.push(`Nothing is blocked and no reading is hidden; if a column starts coming up empty, update tarmac or report it at ${ISSUES_URL}.`);
  return said.join(' ');
}
