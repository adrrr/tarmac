// P3 — the join. Two contractual sources, one row per live session.
//
//   `claude agents --json`  → who exists, and whether it is busy   (the spine)
//   statusline snapshots    → context, model, effort, cost         (the flesh)
//
// The session list is the spine on purpose: a snapshot outlives its session (a recycled
// fleet leaves seven dead files behind), so a snapshot with no live session is a ghost and
// is dropped. The reverse — a session with no snapshot — is a real state and stays visible,
// with telemetry marked `absent` rather than zeroed.
//
// `now` is a parameter, never `Date.now()` inside: a suite whose fixtures are absolute and
// whose clock floats dies quietly the day it crosses a threshold.

import path from 'node:path';
import { DEFAULT_STALE_AFTER_MS } from './config.ts';
import { guardVersions } from './schema.ts';
import { SID_NAME } from './wrapper.ts';
import type { SchemaGuard } from './schema.ts';
import type { DiscoveryHealth, Session } from './sessions.ts';
import type { CtxState, Snapshot } from './snapshots.ts';

/** `absent` is the state of a live session no statusline ever wrote for. */
export type RowCtxState = CtxState | 'absent';

export interface FleetRow {
  sessionId: string | null;
  name: string | null;
  project: string | null;
  cwd: string | null;
  pid: number | null;
  status: string | null;
  busy: boolean | null;
  uptimeMs: number | null;
  ctxState: RowCtxState;
  ctxPct: number | null;
  ctxTokens: number | null;
  ctxWindow: number | null;
  model: string | null;
  effort: string | null;
  costUsd: number | null;
  snapshotAgeMs: number | null;
  stale: boolean;
  rateLimits: Record<string, any> | null;
}

export interface FleetHealth {
  sessions: number;
  covered: number;
  /**
   * Live sessions whose id is not a shape the wrapper files a snapshot under, so their
   * telemetry is not late — it is never coming. Counted apart from `covered` because the
   * two states differ only in what the user should do about them.
   */
  unfilable: number;
  drift: number;
  stale: number;
  discovered: number;
  noSessionId: number;
  schemaBroken: boolean;
  unknownStatus: number;
  busy: number;
  costUsd: number | null;
  /** How many rows really carried a cost — the denominator the total must be read against. */
  costReporting: number;
  /** Whether the Claude Code writing to this fleet is one whose payloads we have ever seen. */
  schemaGuard: SchemaGuard;
  /**
   * The threshold `stale` was decided with. It travels with the data so every renderer names
   * the SAME one the rows were judged against — a `!` explained by a number the renderer
   * happened to keep for itself would be explained by the wrong number the day it moved.
   */
  staleAfterMs: number;
  generatedAt: number;
  // Filled in by the collector, which is the layer that knows where it read from.
  snapshotsError?: string | null;
  snapshotsUnreadable?: number;
  snapshotsDuplicates?: number;
  snapshotsDir?: string;
}

export interface Fleet {
  rows: FleetRow[];
  health: FleetHealth;
}

export interface BuildFleetInput {
  sessions: Session[];
  snapshots: Map<string, Snapshot>;
  now: number;
  staleAfterMs?: number;
  discovery?: DiscoveryHealth | null;
}

export function buildFleet({
  sessions,
  snapshots,
  now,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  discovery = null,
}: BuildFleetInput): Fleet {
  const rows: FleetRow[] = sessions.map((s) => {
    const t = (s.sessionId && snapshots.get(s.sessionId)) || null;
    return {
      sessionId: s.sessionId,
      name: s.name,
      project: s.cwd ? path.basename(s.cwd) : null,
      cwd: s.cwd,
      pid: s.pid,
      status: s.status,
      busy: s.busy,
      uptimeMs: typeof s.startedAt === 'number' ? now - s.startedAt : null,
      ctxState: t ? t.ctxState : 'absent',
      ctxPct: t ? t.ctxPct : null,
      ctxTokens: t ? t.ctxTokens : null,
      ctxWindow: t ? t.ctxWindow : null,
      model: t ? t.model : null,
      effort: t ? t.effort : null,
      costUsd: t ? t.costUsd : null,
      snapshotAgeMs: t ? t.ageMs : null,
      stale: t ? t.ageMs > staleAfterMs : false,
      rateLimits: t ? t.rateLimits : null,
    };
  });

  rows.sort((a, b) => rank(a) - rank(b) || (b.ctxPct ?? -1) - (a.ctxPct ?? -1));

  const covered = rows.filter((r) => r.ctxState !== 'absent').length;
  // A null id is `noSessionId`'s business — a discovery failure, not a naming one.
  const unfilable = rows.filter((r) => r.sessionId !== null && !SID_NAME.test(r.sessionId)).length;
  const drift = rows.filter((r) => r.ctxState === 'drift').length;
  // Having a snapshot and having a cost are different facts, and only the second one is
  // allowed to feed the total.
  const costs = rows.map((r) => r.costUsd).filter((c): c is number => typeof c === 'number');
  // Versions from the LIVE snapshots only — the same `sessions`-is-the-spine rule as
  // everything else here. A recycled fleet leaves dead files behind, and a dead session's
  // Claude Code is not the one running now.
  const ccVersions = sessions
    .map((s) => (s.sessionId ? snapshots.get(s.sessionId) : undefined))
    .filter((t): t is Snapshot => t !== undefined)
    .map((t) => t.ccVersion);

  return {
    rows,
    health: {
      sessions: rows.length,
      covered,
      unfilable,
      drift,
      stale: rows.filter((r) => r.stale).length,
      // Discovery's own blind spots. Dropping them turns a renamed `sessionId` into the
      // cheerful "No Claude Code sessions found" — the exact lie the module forbids.
      discovered: discovery?.seen ?? rows.length,
      noSessionId: discovery?.noSessionId ?? 0,
      // All the telemetry we DO have is drifting: that is a schema change, not a hiccup.
      // Tested tolerance from the fleet: `fresh` never counts, or a recycled fleet would
      // raise this every single night.
      schemaBroken: covered > 0 && drift === covered,
      unknownStatus: rows.filter((r) => r.busy === null).length,
      busy: rows.filter((r) => r.busy === true).length,
      // A sum over 3 of 7 sessions is not the fleet's cost. Same rule as `sumUsage` one
      // layer down: add only what is really a number, and count those — a payload with no
      // `cost` key used to contribute a confident 0 while counting as covered, which made a
      // partial sum print as a complete one. Null when nothing was measured; the renderers
      // qualify the total with `costReporting` whenever it is partial.
      costUsd: costs.length === 0 ? null : round2(costs.reduce((sum, c) => sum + c, 0)),
      costReporting: costs.length,
      schemaGuard: guardVersions(ccVersions),
      staleAfterMs,
      generatedAt: now,
    },
  };
}

// busy first, then unknown (it might be busy), then idle
const rank = (r: FleetRow): number => (r.busy === true ? 0 : r.busy === null ? 1 : 2);
const round2 = (n: number): number => Math.round(n * 100) / 100;
