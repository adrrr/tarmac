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
   * its own, `state` for a background agent that has none. One field, because it is one fact.
   * It is what both surfaces print when `busy` below is `null`, so a word nothing here
   * recognises reaches the reader as it came rather than as "unknown".
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
 * What each word this surface prints says about the one question the boolean asks: is this
 * session working. A word that does not answer it is absent, and absent means `null` — "we do
 * not know" — which is the whole point of the file.
 *
 * The first two arrive on a session with a process of its own; the other two are a background
 * agent's `state`, which is where its word lives instead.
 *
 * Some words are left out ON PURPOSE rather than for want of a payload. `failed` and `stopped`
 * are "not working", and that is the least interesting true thing about them; `blocked` and
 * `waiting` are a session halted until a human answers something, where `false` reads as calm
 * on a session that needs you and `true` as fine on one that has stopped. Unknown is the only
 * bucket whose node prints the word itself, so those keep it: an amber node captioned `failed`
 * says what neither boolean could.
 */
const KNOWN_STATUS = new Map<string | null, boolean>([
  ['busy', true],
  ['idle', false],
  ['working', true],
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
