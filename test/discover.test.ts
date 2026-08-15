import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { discoverSessions } from '../src/discover.ts';
import { tempDir } from './sandbox.ts';

/** Writes a fake `claude` executable that prints `out` and exits with `code`. */
function fakeClaude(out: string, code = 0): string {
  const dir = tempDir('tarmac-disc-');
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${out}\nEOF\nexit ${code}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

test('runs the CLI and returns parsed sessions', async () => {
  const bin = fakeClaude(JSON.stringify([{ sessionId: 'a', status: 'idle', name: 'n' }]));
  const { sessions } = await discoverSessions({ claudeBin: bin });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, 'n');
});

test('a missing claude binary fails loudly', async () => {
  await assert.rejects(discoverSessions({ claudeBin: '/nonexistent/claude' }), /claude/);
});

test('a non-zero exit fails loudly rather than reporting an empty fleet', async () => {
  const bin = fakeClaude('boom', 3);
  await assert.rejects(discoverSessions({ claudeBin: bin }), /exit(ed)? 3|not valid JSON/);
});
