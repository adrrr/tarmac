// Builders for a fleet row and its health, shared by every suite that needs one.
// Not a `*.test.ts`, so the runner's glob leaves it alone.

import { guardVersions } from '../src/schema.ts';
import type { FleetHealth, FleetRow } from '../src/fleet.ts';

export const NOW = 1786240000000;

export const row = (over: Partial<FleetRow> = {}): FleetRow => ({
  sessionId: 's1',
  name: 'alpha-7a',
  project: 'alpha',
  cwd: '/Users/jane/alpha',
  pid: 42,
  status: 'idle',
  busy: false,
  uptimeMs: 3600_000,
  ctxState: 'ok',
  ctxPct: 26,
  ctxTokens: 256390,
  ctxWindow: null,
  model: 'Fable 5',
  effort: 'max',
  costUsd: 27.75,
  snapshotAgeMs: 1200,
  stale: false,
  rateLimits: null,
  ...over,
});

export const health = (over: Partial<FleetHealth> = {}): FleetHealth => ({
  sessions: 1,
  covered: 1,
  drift: 0,
  stale: 0,
  discovered: 1,
  noSessionId: 0,
  schemaBroken: false,
  unknownStatus: 0,
  busy: 0,
  costUsd: 27.75,
  costReporting: 1,
  schemaGuard: guardVersions(['2.1.226']),
  staleAfterMs: 600_000,
  generatedAt: NOW,
  ...over,
});
