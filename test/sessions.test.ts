import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgents } from '../src/sessions.ts';

// Fixture shape captured from the real machine, CC 2.1.226 (see fixtures/agents-2.1.226.json).
const ONE = JSON.stringify([
  {
    pid: 66956,
    cwd: '/Users/jane/alpha',
    kind: 'interactive',
    startedAt: 1786237453919,
    sessionId: 'ea6a607c-42e0-4773-af4d-ae5f5938d819',
    name: 'alpha-7a',
    status: 'busy',
  },
]);

test('maps a live agent entry to a session record', () => {
  const { sessions } = parseAgents(ONE);
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0], {
    sessionId: 'ea6a607c-42e0-4773-af4d-ae5f5938d819',
    pid: 66956,
    cwd: '/Users/jane/alpha',
    name: 'alpha-7a',
    kind: 'interactive',
    startedAt: 1786237453919,
    status: 'busy',
    busy: true,
  });
});

test('idle status maps to busy=false', () => {
  const { sessions } = parseAgents(JSON.stringify([{ sessionId: 'a', status: 'idle' }]));
  assert.equal(sessions[0].busy, false);
});

// The 3rd-blindness lesson from the fleet: a release renaming `busy` must NOT read as
// "everything is calm". Unknown status is null, never coerced to idle.
test('unknown status yields busy=null, never false', () => {
  const { sessions } = parseAgents(JSON.stringify([{ sessionId: 'a', status: 'working' }]));
  assert.equal(sessions[0].busy, null);
  assert.equal(sessions[0].status, 'working');
});

test('missing status yields busy=null', () => {
  const { sessions } = parseAgents(JSON.stringify([{ sessionId: 'a' }]));
  assert.equal(sessions[0].busy, null);
});

test('health counts what the schema failed to give us', () => {
  const { health } = parseAgents(
    JSON.stringify([
      { sessionId: 'a', status: 'idle' },
      { sessionId: 'b', status: 'working' },
      { pid: 3, status: 'idle' },
    ]),
  );
  assert.deepEqual(health, { seen: 3, noSessionId: 1, unknownStatus: 1 });
});

test('an empty fleet is a valid answer, not an error', () => {
  const { sessions, health } = parseAgents('[]');
  assert.deepEqual(sessions, []);
  assert.equal(health.seen, 0);
});

test('non-array payload throws — the discovery surface changed', () => {
  assert.throws(() => parseAgents('{"agents":[]}'), /expected a JSON array/);
});

test('unparseable output throws rather than reporting an empty fleet', () => {
  assert.throws(() => parseAgents('command not found'), /not valid JSON/);
});

test('a non-object entry is skipped but counted as seen', () => {
  const { sessions, health } = parseAgents(JSON.stringify(['nope', { sessionId: 'a', status: 'idle' }]));
  assert.equal(sessions.length, 1);
  assert.equal(health.seen, 2);
  assert.equal(health.noSessionId, 1);
});
