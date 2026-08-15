// P1 — Contractual session discovery.
//
// Single source: `claude agents --json`, a CLI surface Claude Code publishes on purpose.
// Tarmac parses NO internal format here: no ~/.claude/projects/*.jsonl, no tmux pane pixels.
//
// Design rule carried over from the fleet's "3rd blindness": a status we do not recognise
// is `null`, never `false`. A release that renames `busy` must make Tarmac say "I don't
// know", not "everything is calm" — the second is a silent outage, the first is a signal.

/** One live Claude Code session, as far as the discovery surface can tell. */
export interface Session {
  sessionId: string | null;
  pid: number | null;
  cwd: string | null;
  name: string | null;
  kind: string | null;
  startedAt: number | null;
  /**
   * The word the entry used for what it is doing — `status` for a session with a process of
   * its own, `state` for a background agent that has none. One field, because it is one fact,
   * and the page quotes whichever word it came as.
   */
  status: string | null;
  /** `null` means "unrecognised status", never "idle". */
  busy: boolean | null;
}

/** What discovery could NOT tell us — carried, never dropped. */
export interface DiscoveryHealth {
  seen: number;
  noSessionId: number;
  unknownStatus: number;
}

export interface ParsedAgents {
  sessions: Session[];
  health: DiscoveryHealth;
}

/**
 * The words a captured payload has actually contained, and what each one says about whether
 * the session is working. Never a list of everything the CLI might one day print: a word that
 * is not here is `null` — "we do not know" — and that is the whole point of the file.
 *
 * `done` arrives on background agents, which report under `state` rather than `status`. It is
 * a finished agent, so it is not working — the same `false` an idle terminal gets, reached
 * from the other end.
 */
const KNOWN_STATUS = new Map<string | null, boolean>([
  ['busy', true],
  ['idle', false],
  ['done', false],
]);

/** @param text raw stdout of `claude agents --json` */
export function parseAgents(text: string): ParsedAgents {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('`claude agents --json` output is not valid JSON');
  }
  if (!Array.isArray(raw)) {
    throw new Error('`claude agents --json`: expected a JSON array');
  }

  const health: DiscoveryHealth = { seen: raw.length, noSessionId: 0, unknownStatus: 0 };
  const sessions: Session[] = [];

  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      health.noSessionId += 1;
      continue;
    }
    const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : null;
    if (!sessionId) health.noSessionId += 1;

    // A background agent carries no `status` at all — its word is under `state`. `status`
    // still wins where both are present: it comes from the agent's own process, and `state`
    // is what the dispatcher believes about an agent whose process may not be on this machine.
    const status =
      typeof entry.status === 'string' ? entry.status : typeof entry.state === 'string' ? entry.state : null;
    const busy = KNOWN_STATUS.has(status) ? (KNOWN_STATUS.get(status) as boolean) : null;
    if (busy === null) health.unknownStatus += 1;

    sessions.push({
      sessionId,
      pid: typeof entry.pid === 'number' ? entry.pid : null,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
      name: typeof entry.name === 'string' ? entry.name : null,
      kind: typeof entry.kind === 'string' ? entry.kind : null,
      startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : null,
      status,
      busy,
    });
  }

  return { sessions, health };
}
