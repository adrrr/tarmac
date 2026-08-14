// P1 — runs the contractual discovery command and hands its stdout to the parser.
//
// Fails loudly on every failure mode (binary missing, non-zero exit, unparseable output).
// An observability tool that answers "0 sessions" when it simply could not look is worse
// than one that answers nothing.

import { execFile } from 'node:child_process';
import { parseAgents } from './sessions.ts';
import type { ParsedAgents } from './sessions.ts';

export interface DiscoverOptions {
  claudeBin?: string;
  timeoutMs?: number;
}

export function discoverSessions({ claudeBin = 'claude', timeoutMs = 15000 }: DiscoverOptions = {}): Promise<ParsedAgents> {
  return new Promise((resolve, reject) => {
    execFile(claudeBin, ['agents', '--json'], { timeout: timeoutMs, maxBuffer: 8 << 20 }, (err, stdout) => {
      if (err) {
        const why =
          err.code === 'ENOENT'
            ? `${claudeBin}: not found`
            : `${claudeBin} agents --json: exited ${err.code ?? '?'}${err.signal ? ` (${err.signal})` : ''}`;
        reject(new Error(why));
        return;
      }
      try {
        resolve(parseAgents(stdout));
      } catch (e) {
        reject(e);
      }
    });
  });
}
