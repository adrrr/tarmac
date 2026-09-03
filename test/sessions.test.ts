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
    waitingFor: null,
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

// A background agent — the shape captured off a real machine (CC 2.1.232, frozen in
// fixtures/agents-2.1.232.json), the values synthetic per the fixtures standard. It carries
// none of the keys an interactive session does: no `pid`, no `status` — its state lives
// under `state`, and the entry has an `id` of its own: the first 8 hex of its session id.
// Reading only `status` made every satellite on a healthy fleet an amber "unknown".
const BACKGROUND = JSON.stringify([
  {
    id: 'b47e0d19',
    cwd: '/Users/jane/alpha',
    kind: 'background',
    startedAt: 1786727883345,
    sessionId: 'b47e0d19-3c25-4a8e-9f60-1d84c7a3f2b6',
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

// A session halted until a human answers — the shape captured off a real machine (CC 2.1.232,
// frozen in fixtures/agents-2.1.232--waiting.json), the values synthetic per the fixtures
// standard. `waitingFor` is the field that says which human answer, out of a vocabulary the
// surface documents: permission prompt, input needed, sandbox request, worker request,
// dialog open.
const WAITING_ENTRY = JSON.stringify([
  {
    pid: 42713,
    cwd: '/Users/jane/alpha',
    kind: 'interactive',
    startedAt: 1786731044918,
    sessionId: '8c1f6b70-49d2-4e83-a5c7-b21e0f9d3a64',
    name: 'alpha-8c',
    status: 'waiting',
    waitingFor: 'dialog open',
  },
]);

test('a waiting session says so, and says what it is waiting for', () => {
  const { sessions } = parseAgents(WAITING_ENTRY);
  assert.equal(sessions[0].status, 'waiting');
  assert.equal(sessions[0].waitingFor, 'dialog open');
});

// The boolean still cannot answer for it — "is this session working" has no answer here, and
// `false` would read as calm on the one session that needs you. What changes is the COUNT: a
// word the tool knows, and now renders as a state of its own, is not a schema it failed to
// recognise, and the banner that says so must not name it.
test('a waiting session is a state tarmac knows, not an unknown status', () => {
  const { sessions, health } = parseAgents(WAITING_ENTRY);
  assert.equal(sessions[0].busy, null, 'the boolean still says "I cannot answer that"');
  assert.equal(health.unknownStatus, 0);
});

// The reason is a field, and a field can be absent. A waiting session with no reason is still
// waiting: the state comes from `status`, never from the presence of its caption.
test('a waiting session with no reason is still waiting', () => {
  const { sessions, health } = parseAgents(JSON.stringify([{ sessionId: 'a', status: 'waiting' }]));
  assert.equal(sessions[0].status, 'waiting');
  assert.equal(sessions[0].waitingFor, null);
  assert.equal(health.unknownStatus, 0);
});

// The words that outrank their own boolean. `failed` and `stopped` are "not working" and that
// is the least interesting true thing about them; `blocked` is a session halted until a human
// answers something, where "not working" reads as calm and "working" as fine. Unknown is the
// only bucket whose node prints the word itself, so these keep it: an amber node captioned
// `failed` says what no boolean here could.
//
// `waiting` used to be on this list. It has a state of its own now, and a documented reason
// to print beside it — which is more than the amber node ever said.
test('a word the boolean would flatten stays unknown, and reaches the page as it came', () => {
  for (const word of ['failed', 'stopped', 'blocked']) {
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

// `noSessionId` already counted it; the value then went on travelling as `''`, a non-id each
// reader had to neutralise separately (#137) — and fleet health counted the same entry again
// as unfilable. Normalised at the source, absent is `null`, said once.
test('an empty sessionId is no id at all, and does not travel as one', () => {
  const { sessions, health } = parseAgents(JSON.stringify([{ sessionId: '', status: 'idle' }]));
  assert.equal(sessions[0].sessionId, null);
  assert.equal(health.noSessionId, 1);
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
