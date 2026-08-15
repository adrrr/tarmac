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
  const { sessions } = parseAgents(JSON.stringify([{ sessionId: 'a', status: 'transmogrifying' }]));
  assert.equal(sessions[0].busy, null);
  assert.equal(sessions[0].status, 'transmogrifying');
});

test('missing status yields busy=null', () => {
  const { sessions } = parseAgents(JSON.stringify([{ sessionId: 'a' }]));
  assert.equal(sessions[0].busy, null);
});

// A background agent, captured verbatim off a real machine. It carries none of the keys an
// interactive session does: no `pid`, no `status` — its state lives under `state`, and the
// entry has an `id` of its own beside the session id. Reading only `status` made every
// satellite on a healthy fleet an amber "unknown".
const BACKGROUND = JSON.stringify([
  {
    id: '6ea4b4ee',
    cwd: '/Users/jane/alpha',
    kind: 'background',
    startedAt: 1786727883345,
    sessionId: '6ea4b4ee-8852-44d5-a1bb-b38b703797db',
    name: 'sweep the stale branches',
    state: 'done',
  },
]);

test('a background agent reports its state under `state`, and it is read', () => {
  const { sessions } = parseAgents(BACKGROUND);
  assert.equal(sessions[0].status, 'done', 'the word the source used, kept as it came');
  assert.equal(sessions[0].busy, false, 'a finished agent is not working');
});

// The banner it used to raise says "report a status tarmac does not know" — on a fleet where
// nothing is wrong and the only agent has simply finished.
test('a finished background agent is not counted as an unknown status', () => {
  assert.equal(parseAgents(BACKGROUND).health.unknownStatus, 0);
});

// `status` is the field an entry with a live process carries, and it wins: `state` is the
// fallback for the entries that have none, never a second opinion about the ones that do.
test('`status` is read ahead of `state` when an entry carries both', () => {
  const { sessions } = parseAgents(JSON.stringify([{ sessionId: 'a', status: 'busy', state: 'done' }]));
  assert.equal(sessions[0].busy, true);
  assert.equal(sessions[0].status, 'busy');
});

// `working` is the state that matters in practice, and the one this fix was nearly written
// without. `claude agents --json` — no `--all`, which is what tarmac runs — keeps a background
// entry with no process of its own only while it is working or blocked, and drops the finished
// ones. So a running agent, the thing you open a dashboard to look at, is the entry that was
// going amber and raising the banner.
test('a running background agent is working, and a finished one is not', () => {
  const busyFor = (state: string): boolean | null =>
    parseAgents(JSON.stringify([{ sessionId: 'a', state }])).sessions[0].busy;
  assert.equal(busyFor('working'), true);
  assert.equal(busyFor('done'), false);
});

// The words that outrank their own boolean. `failed` and `stopped` are "not working" and that
// is the least interesting true thing about them; `blocked` and `waiting` are a session halted
// until a human answers something, where "not working" reads as calm and "working" as fine.
// Unknown is the only bucket whose node prints the word itself, so these keep it: an amber
// node captioned `failed` says what no boolean here could.
test('a word the boolean would flatten stays unknown, and reaches the page as it came', () => {
  for (const word of ['failed', 'stopped', 'blocked', 'waiting']) {
    const { sessions, health } = parseAgents(JSON.stringify([{ sessionId: 'a', state: word }]));
    assert.equal(sessions[0].busy, null, word);
    assert.equal(sessions[0].status, word);
    assert.equal(health.unknownStatus, 1, word);
  }
});

// The 3rd-blindness rule reaches the new field too: reading `state` is not licence to guess
// at a vocabulary no captured payload has ever shown.
test('a state word tarmac has never seen is unknown, never idle', () => {
  const { sessions, health } = parseAgents(JSON.stringify([{ sessionId: 'a', state: 'churning' }]));
  assert.equal(sessions[0].busy, null);
  assert.equal(sessions[0].status, 'churning');
  assert.equal(health.unknownStatus, 1);
});

test('health counts what the schema failed to give us', () => {
  const { health } = parseAgents(
    JSON.stringify([
      { sessionId: 'a', status: 'idle' },
      { sessionId: 'b', status: 'transmogrifying' },
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
