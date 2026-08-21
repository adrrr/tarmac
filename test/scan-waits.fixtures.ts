// Lines whose verdict is written down, for the guard's negative test.
//
// They live in their own module because they are DATA that looks exactly like the code the
// guard bans — a bare fetch, a raw client import — and the sweep over the real files would
// report them as offences. It is the one file the sweep skips, which is safe only because it
// holds no calls: every string here is inert until `unboundedWaits` reads it.
//
// Two groups here are shapes a version of the rule waved through, and they are the reason the
// file exists: the raw-client imports the first cut blessed, and the hand-typed budgets that
// reached the suite through a parameter default and a positional argument (#85).

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
  { line: 'await fetch(url, { signal: AbortSignal.timeout( NET_DEADLINE_MS ) });', caught: false, why: 'spaced inside the call' },
  {
    line: 'await fetch(url, { signal: AbortSignal.timeout(NET_DEADLINE_MS_SOMETHING) });',
    caught: true,
    why: 'a name that merely starts like it is not it',
  },
  {
    line: 'const NET_DEADLINE_MS = 4000;',
    caught: true,
    why: 'a local shadow is the literal wearing the constant’s name',
  },
  {
    line: "import { NET_DEADLINE_MS } from './bounded.ts';",
    caught: false,
    why: 'importing it is the point, not a shadow of it',
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
  {
    line: 'export async function waitFor(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {',
    caught: true,
    why: 'a deadline-shaped default is the literal one line further out — the pre-fix shape of rawGet (#84)',
  },
  {
    line: 'async function myGet(url: string, timeoutMs: number = 4000): Promise<number> {',
    caught: true,
    why: 'the annotated form of the same default',
  },
  {
    line: 'export async function pollUntil(pred: () => boolean, waitMs = 3000): Promise<void> {',
    caught: true,
    why: 'deadline-shaped is the name, not the one name rawGet happens to use',
  },
  { line: 'const deadlineMs = 4000;', caught: true, why: 'and a const is the same guess as a default' },
  { line: 'async function poll(pred: () => boolean, budgetMs = 500): Promise<void> {', caught: true, why: 'a budget is a deadline' },
  {
    line: "const status = await rawGet(port, `localhost:${port}`, '/api/fleet', {}, 500);",
    caught: true,
    why: 'the raw client’s deadline is not the caller’s to pick either',
  },
  {
    line: 'export function waitForOutput(child: ChildProcess, marker: RegExp, timeoutMs = NET_DEADLINE_MS): Promise<string> {',
    caught: false,
    why: 'a default that IS the constant is what the rule asks for',
  },
  {
    line: 'const fleet = (rateLimits = limits(), snapshotAgeMs = 1200): Fleet => ({});',
    caught: false,
    why: 'an age the test hands its own fixture is data, not a deadline anything waits on',
  },
  {
    line: 'const out = await waitForOutput(child, /tarmac serving/, 20_000);',
    caught: true,
    why: 'a positional budget is the same guess, made at the call instead of at the default',
  },
  {
    line: 'await waitFor(() => coldLeft(r.dir) === 0, `the cold snapshots to be swept`, 60_000);',
    caught: true,
    why: 'and it is still one when an arrow argument puts a bracket in the way',
  },
  {
    line: 'const out = await waitForOutput(child, /tarmac serving/, NET_DEADLINE_MS);',
    caught: false,
    why: 'passing the constant back in is not a number of your own',
  },
  {
    line: "await waitFor(() => r.sweeps().length === 1, 'the sweep to record that it started');",
    caught: false,
    why: 'taking the default is the point of the default',
  },
  {
    line: 'const t = setTimeout(() => r("still pending"), 5000).unref();',
    caught: false,
    why: 'a timer is not a wait helper — the rule reads the callee, not the last argument',
  },
  {
    line: "assert.equal(await rawGet(new URL(base).port, 'evil.example.com'), 403);",
    caught: false,
    why: 'the 403 is the assertion’s, not the wait’s — five call sites the first cut of the rule reported',
  },
];

/** The plainest raw-client import there is, for the test that `bounded.ts` may still hold it. */
export const RAW_CLIENT_IMPORT = "import http from 'node:http';";

/**
 * A hand-typed budget in the one file where a deadline is the subject and not the tool, for the
 * test that says so in both directions: an offence anywhere else, allowed there.
 */
export const DEADLINE_UNDER_TEST_CALL = 'await assert.rejects(() => waitForOutput(c, /tarmac serving/, 500));';
