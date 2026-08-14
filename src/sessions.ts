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

const KNOWN_STATUS = new Map<string | null, boolean>([
  ['busy', true],
  ['idle', false],
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

    const status = typeof entry.status === 'string' ? entry.status : null;
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
