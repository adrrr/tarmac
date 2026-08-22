// Sources whose verdict is written down, for the guard's negative test.
//
// They live in their own module because they are DATA that looks exactly like the code the
// guard bans — a bare fetch, a raw client import — and the sweep over the real files would
// report them as offences. It is the one file the sweep skips, which is safe only because it
// holds no calls: every string here is inert until `unboundedWaits` reads it.
//
// Three groups here are shapes a version of the rule waved through, and they are the reason the
// file exists: the raw-client imports the first cut blessed, the hand-typed budgets that reached
// the suite through a parameter default and a positional argument (#85), and the same budget
// again with a line break in it (#93).

export interface Verdict {
  /** What the guard reads: one line, or the several a call split over them is written on. */
  source: string;
  /** Whether the guard is supposed to report it. */
  caught: boolean;
  why: string;
}

/**
 * The #85 defect with a line break in it, which is how it walked past the rule that catches it
 * on one line (#93). Exported as well as listed below, for the test that READS the report rather
 * than counting it: a finding that named a line inside the call would send the reader to an
 * argument instead of to the call to rewrite.
 */
export const SPLIT_WAIT_CALL = `await waitFor(
  () => coldLeft(r.dir) === 0,
  'the cold snapshots to be swept',
  60_000,
);`;

export const VERDICTS: Verdict[] = [
  { source: 'const r = await fetch(url);', caught: true, why: 'a bare fetch' },
  { source: 'const r = await fetch(url, { signal: AbortSignal.timeout(NET_DEADLINE_MS) });', caught: false, why: 'a bounded one' },
  {
    source: 'const r = await fetch(url, { signal: AbortSignal.timeout(4000) });',
    caught: true,
    why: 'a deadline typed by hand is the one that was too short (#73)',
  },
  { source: 'await fetch(url, { signal: AbortSignal.timeout( NET_DEADLINE_MS ) });', caught: false, why: 'spaced inside the call' },
  {
    source: 'await fetch(url, { signal: AbortSignal.timeout(NET_DEADLINE_MS_SOMETHING) });',
    caught: true,
    why: 'a name that merely starts like it is not it',
  },
  {
    source: 'const NET_DEADLINE_MS = 4000;',
    caught: true,
    why: 'a local shadow is the literal wearing the constant’s name',
  },
  {
    source: "import { NET_DEADLINE_MS } from './bounded.ts';",
    caught: false,
    why: 'importing it is the point, not a shadow of it',
  },
  {
    source: 'const r = await fetch(url); // TODO: add AbortSignal.timeout',
    caught: true,
    why: 'a trailing comment must not whitewash it',
  },
  { source: '// never write a bare fetch(url) in this file', caught: false, why: 'prose ABOUT a bare call is not one' },
  {
    source: 'await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(NET_DEADLINE_MS) });',
    caught: false,
    why: 'the // inside a URL does not open a comment',
  },
  { source: "const t = setTimeout(() => {}, 10); // http://example.com/docs", caught: false, why: 'a URL inside a comment' },
  { source: "import http from 'node:http';", caught: true, why: 'the default import' },
  { source: "import { request } from 'node:http';", caught: true, why: 'the named import — the natural way to write it' },
  { source: "import * as h from 'node:http';", caught: true, why: 'the namespace import, whatever the alias is called' },
  { source: "const https = require('node:https');", caught: true, why: 'require, and https as well as http' },
  { source: "import https from 'https';", caught: true, why: 'the bare specifier, without the node: prefix' },
  { source: "import type { Server } from 'node:http';", caught: false, why: 'a type is erased and cannot open a socket' },
  {
    source: 'export async function waitFor(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {',
    caught: true,
    why: 'a deadline-shaped default is the literal one line further out — the pre-fix shape of rawGet (#84)',
  },
  {
    source: 'async function myGet(url: string, timeoutMs: number = 4000): Promise<number> {',
    caught: true,
    why: 'the annotated form of the same default',
  },
  {
    source: 'export async function pollUntil(pred: () => boolean, waitMs = 3000): Promise<void> {',
    caught: true,
    why: 'deadline-shaped is the name, not the one name rawGet happens to use',
  },
  { source: 'const deadlineMs = 4000;', caught: true, why: 'and a const is the same guess as a default' },
  { source: 'async function poll(pred: () => boolean, budgetMs = 500): Promise<void> {', caught: true, why: 'a budget is a deadline' },
  {
    source: "const status = await rawGet(port, `localhost:${port}`, '/api/fleet', {}, 500);",
    caught: true,
    why: 'the raw client’s deadline is not the caller’s to pick either',
  },
  {
    source: 'export function waitForOutput(child: ChildProcess, marker: RegExp, timeoutMs = NET_DEADLINE_MS): Promise<string> {',
    caught: false,
    why: 'a default that IS the constant is what the rule asks for',
  },
  {
    source: 'const fleet = (rateLimits = limits(), snapshotAgeMs = 1200): Fleet => ({});',
    caught: false,
    why: 'an age the test hands its own fixture is data, not a deadline anything waits on',
  },
  {
    source: 'const out = await waitForOutput(child, /tarmac serving/, 20_000);',
    caught: true,
    why: 'a positional budget is the same guess, made at the call instead of at the default',
  },
  {
    source: 'await waitFor(() => coldLeft(r.dir) === 0, `the cold snapshots to be swept`, 60_000);',
    caught: true,
    why: 'and it is still one when an arrow argument puts a bracket in the way',
  },
  {
    source: 'const out = await waitForOutput(child, /tarmac serving/, NET_DEADLINE_MS);',
    caught: false,
    why: 'passing the constant back in is not a number of your own',
  },
  {
    source: "await waitFor(() => r.sweeps().length === 1, 'the sweep to record that it started');",
    caught: false,
    why: 'taking the default is the point of the default',
  },
  {
    source: 'const t = setTimeout(() => r("still pending"), 5000).unref();',
    caught: false,
    why: 'a timer is not a wait helper — the rule reads the callee, not the last argument',
  },
  {
    source: "assert.equal(await rawGet(new URL(base).port, 'evil.example.com'), 403);",
    caught: false,
    why: 'the 403 is the assertion’s, not the wait’s — five call sites the first cut of the rule reported',
  },
  {
    source: SPLIT_WAIT_CALL,
    caught: true,
    why: 'a line break was the way out of the rule above — the same budget, unread (#93)',
  },
  {
    source: `await waitFor(
  () => r.sweeps().length === 1,
  'the sweep to record that it started',
);`,
    caught: true,
    why: 'and a split call taking the default is caught too: the rule reads where the wait is written, not what it carries today',
  },
  {
    source: `const r = await fetch(url, {
  signal: AbortSignal.timeout(NET_DEADLINE_MS),
  headers: { Host: host },
});`,
    caught: true,
    why: 'the fetch rule already failed closed on a break — the two agree now instead of pointing opposite ways',
  },
  {
    source: `export function rawGet(
  port: string,
  path = '/api/fleet',
  timeoutMs = NET_DEADLINE_MS,
): Promise<number | undefined> {`,
    caught: false,
    why: 'a signature is not a call: this is how the ONE home declares the raw client (bounded.ts)',
  },
  {
    source: `async function historyUntil(
  base: string,
  what: string,
  timeoutMs = NET_DEADLINE_MS,
): Promise<HistoryPayload> {`,
    caught: false,
    why: 'and the same shape for a poller, wherever a helper is too long to declare on one line',
  },
];

/** The plainest raw-client import there is, for the test that `bounded.ts` may still hold it. */
export const RAW_CLIENT_IMPORT = "import http from 'node:http';";

/**
 * A hand-typed budget in the one file where a deadline is the subject and not the tool, for the
 * test that says so in both directions: an offence anywhere else, allowed there.
 */
export const DEADLINE_UNDER_TEST_CALL = 'await assert.rejects(() => waitForOutput(c, /tarmac serving/, 500));';

/**
 * The definition half of #85, for the test that a default is ONE finding — inert here like every
 * string in this module, an offence when a real file writes it.
 */
export const HAND_TYPED_DEFAULT_DEFINITION = 'export async function waitFor(pred, what, timeoutMs = 10_000) {';
