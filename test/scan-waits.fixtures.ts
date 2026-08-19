// Lines whose verdict is written down, for the guard's negative test.
//
// They live in their own module because they are DATA that looks exactly like the code the
// guard bans — a bare fetch, a raw client import — and the sweep over the real files would
// report them as offences. It is the one file the sweep skips, which is safe only because it
// holds no calls: every string here is inert until `unboundedWaits` reads it.
//
// The last three are the shapes the first version of the rule waved through. They are the
// reason this file exists.

export interface Verdict {
  line: string;
  /** Whether the guard is supposed to report this line. */
  caught: boolean;
  why: string;
}

export const VERDICTS: Verdict[] = [
  { line: 'const r = await fetch(url);', caught: true, why: 'a bare fetch' },
  { line: 'const r = await fetch(url, { signal: AbortSignal.timeout(NET_DEADLINE_MS) });', caught: false, why: 'a bounded one' },
  {
    line: 'const r = await fetch(url, { signal: AbortSignal.timeout(4000) });',
    caught: true,
    why: 'a deadline typed by hand is the one that was too short (#73)',
  },
  {
    line: 'const r = await fetch(url); // TODO: add AbortSignal.timeout',
    caught: true,
    why: 'a trailing comment must not whitewash it',
  },
  { line: '// never write a bare fetch(url) in this file', caught: false, why: 'prose ABOUT a bare call is not one' },
  {
    line: 'await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(NET_DEADLINE_MS) });',
    caught: false,
    why: 'the // inside a URL does not open a comment',
  },
  { line: "const t = setTimeout(() => {}, 10); // http://example.com/docs", caught: false, why: 'a URL inside a comment' },
  { line: "import http from 'node:http';", caught: true, why: 'the default import' },
  { line: "import { request } from 'node:http';", caught: true, why: 'the named import — the natural way to write it' },
  { line: "import * as h from 'node:http';", caught: true, why: 'the namespace import, whatever the alias is called' },
  { line: "const https = require('node:https');", caught: true, why: 'require, and https as well as http' },
  { line: "import https from 'https';", caught: true, why: 'the bare specifier, without the node: prefix' },
  { line: "import type { Server } from 'node:http';", caught: false, why: 'a type is erased and cannot open a socket' },
];

/** The plainest raw-client import there is, for the test that `bounded.ts` may still hold it. */
export const RAW_CLIENT_IMPORT = "import http from 'node:http';";
