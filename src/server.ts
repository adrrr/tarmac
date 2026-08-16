// P3 — the local dashboard. node:http, localhost, no dependency.
//
// The collector is injected so the server can be exercised without spawning `claude`, and
// so a read-only snapshot directory (the fleet's own, for the demo) is just a parameter.

import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { reason, renderLive, renderPage } from './render.ts';
import type { View } from './render.ts';
import { SOURCE_PHRASE } from './config.ts';
import { createHistory, HISTORY_CADENCE_MS } from './history.ts';
import type { Source } from './config.ts';
import type { Fleet } from './fleet.ts';

/**
 * On every answer, including the refusals and the 500s. The page swaps what this port returns
 * into `innerHTML`, and loopback proves where an answer came from, never who wrote it: a
 * process that takes the port after `tarmac serve` exits, or a proxy standing in front of it,
 * answers 200 with whatever it likes — `<img src=x onerror=…>` included — into a page the
 * user opened themselves. The page refuses to swap anything that does not carry this, so the
 * failures carry it too: their text is what it quotes as the reason.
 */
const IDENTITY = { 'x-tarmac': '1' };

/** The addresses that serve the shell, and which view each one opens on. */
const PAGES = new Map<string, View>([
  ['/', 'table'],
  ['/map', 'map'],
]);

export interface FleetServerDeps {
  collect: () => Promise<Fleet>;
  /**
   * How often the sampler reads the fleet for the record. A parameter for one reason — a
   * suite that waited a minute per sample would not be run — and deliberately not a flag,
   * an environment variable or a config key: one minute is the product, and a cadence a
   * reader could choose is a reader who can make this process spawn `claude` every second.
   */
  sampleEveryMs?: number;
}

export function createFleetServer({ collect, sampleEveryMs = HISTORY_CADENCE_MS }: FleetServerDeps): Server {
  // What this serve has already read, kept for a day and never written down. `since` is the
  // moment this server was made, not the first sample that landed: the span it covers is how
  // long the process has been up, and an hour of it with nothing in it is a fact worth
  // showing rather than an empty record pretending to be a young one.
  const history = createHistory({ since: Date.now(), cadence: sampleEveryMs });
  // One at a time. `claude agents --json` has a 15s deadline of its own, and a fleet slower
  // than a slot would otherwise be answered with a queue of processes instead of one missed
  // minute — the tick that finds a read still running counts the slot and stands down.
  let reading = false;
  const sample = async (): Promise<void> => {
    if (reading) {
      history.miss();
      return;
    }
    reading = true;
    try {
      history.record(await collect());
    } catch {
      // A collector that throws is the normal weather here: `claude` missing, a laptop that
      // was asleep. It costs a slot and nothing else — a throw out of this timer would be an
      // unhandled rejection, and `serve` runs unattended for hours.
      history.miss();
    } finally {
      reading = false;
    }
  };
  const sampler = setInterval(() => void sample(), sampleEveryMs);
  // The sampler is not a reason to stay alive: unref'd it never holds `node --test` open,
  // and it never argues with a Ctrl-C. Unref alone is not enough, though — an interval that
  // is never cleared keeps SPAWNING for a server nobody can reach any more, so it comes off
  // with the server it belongs to.
  sampler.unref();

  const server = http.createServer(async (req, res) => {
    // Loopback binding alone does not stop a DNS-rebinding page in the user's own browser
    // from reading /api/fleet — which carries cwd paths, session ids and costs.
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { ...IDENTITY, 'content-type': 'text/plain; charset=utf-8' });
      res.end('tarmac serves loopback hosts only\n');
      return;
    }

    // The Host check stops another origin READING this port; it does not stop one poking it.
    // Any page the user visits can `fetch(…, {mode:'no-cors'})` here as fast as it likes —
    // CORS hides the answer, but each request still spawns `claude agents --json`. Browsers
    // label their own requests, so a label that says cross-site is refused before anything is
    // spawned; a client that sends no label (curl, a script) is left alone.
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      res.writeHead(403, { ...IDENTITY, 'content-type': 'text/plain; charset=utf-8' });
      res.end('tarmac serves same-origin requests only\n');
      return;
    }

    // `url` is always set on a server-side request; the assertion adds no branch.
    const url = new URL(req.url!, 'http://localhost');

    // `/live` is what the open page asks for every few seconds: the same render as `/`, minus
    // the shell. Serving the whole page there would hand the running script a copy of itself.
    //
    // `/map` is the same page opened on the other view, and deliberately not `/?view=map`:
    // the tabs are plain links, so the view has to be somewhere a reload and a bookmark can
    // both find it. There is no second fragment — one `/live` carries both views, which is
    // what keeps them from ever showing readings of different ages.
    if (
      !PAGES.has(url.pathname) &&
      url.pathname !== '/live' &&
      url.pathname !== '/api/fleet' &&
      url.pathname !== '/api/history'
    ) {
      res.writeHead(404, { ...IDENTITY, 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }

    // Served out of the ring, above the collect below and never through it: this route is
    // what the serve has ALREADY read, and one that collected would let a scrubber spawn
    // `claude agents --json` on every drag of its handle.
    if (url.pathname === '/api/history') {
      res.writeHead(200, {
        ...IDENTITY,
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(history.read(), null, 2));
      return;
    }

    // Read AND render inside the guard, and send nothing until there is something to send.
    // Writing the 200 first and rendering after made the collector's failure a 500 and the
    // renderer's failure a dead daemon: the headers were already on the wire, the throw
    // became an unhandled rejection, and `tarmac serve` — which runs unattended for hours —
    // left the browser holding an answer that never came.
    let type: string;
    let body: string;
    try {
      const fleet: Fleet = await collect();
      if (url.pathname === '/api/fleet') {
        type = 'application/json; charset=utf-8';
        body = JSON.stringify(fleet, null, 2);
      } else {
        type = 'text/html; charset=utf-8';
        body = url.pathname === '/live' ? renderLive(fleet) : renderPage(fleet, PAGES.get(url.pathname)!);
      }
    } catch (e) {
      // Say why. A dashboard that goes blank when its source breaks teaches nothing.
      res.writeHead(500, { ...IDENTITY, 'content-type': 'text/plain; charset=utf-8' });
      res.end(`tarmac could not read the fleet:\n${reason(e)}\n`);
      return;
    }

    // A page whose entire claim is freshness must not be served from a cache: a restored tab
    // re-running the script over stale HTML would re-stamp it "updated just now".
    res.writeHead(200, { ...IDENTITY, 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  });

  // The only shutdown this module has: `close` is what the CLI's Ctrl-C and every test that
  // starts a server go through, and past it there is nobody left to serve the record to.
  server.on('close', () => clearInterval(sampler));
  return server;
}

/**
 * How far past a port NOBODY CHOSE `serve` may walk. A corridor, not a search: wide enough
 * to step over a dashboard someone left running, narrow enough that the refusal at the end
 * of it can still name every port it tried.
 */
export const PORT_FALLBACK_TRIES = 10;

export interface Listening {
  /** The port it bound. */
  port: number;
  /** The port it was asked for, when that is not the one it got — otherwise `null`. */
  movedFrom: number | null;
}

export interface ListenRequest {
  port: number;
  /**
   * Who chose the port. Only `default` may be moved: a port named on the command line, in
   * the environment or in a config file is a decision, and a decision that cannot be
   * honoured is a refusal — never a quiet move to a port the user will not think to open.
   */
  source: Source;
  host?: string;
}

/**
 * Binds the dashboard, and says where it ended up.
 *
 * Rejects rather than exiting: `serve`'s refusals all leave through one catch, as one line
 * naming the knob to turn, and a `listen` that failed on an event three ticks later used to
 * be the single exception to that.
 *
 * It resolves with NO `error` listener left on the server — every one it attached is its own
 * and comes off. A caller that then awaits anything before attaching one is a caller whose
 * next socket error is an unhandled event.
 */
export async function listenFleetServer(
  server: Server,
  { port, source, host = '127.0.0.1' }: ListenRequest,
): Promise<Listening> {
  const walks = source === 'default';
  // `resolveConfig` reports `default` for one number only — 4477 — so the far end of the
  // corridor cannot fall outside the legal range of a port.
  const last = walks ? port + PORT_FALLBACK_TRIES : port;

  for (let candidate = port; ; candidate++) {
    const failure = await attempt(server, candidate, host);
    // The socket, never the number asked for: port 0 is legal and means "pick a free one",
    // and answering `0` there sent `serve` to print a URL nobody can open.
    if (failure === null) {
      return { port: (server.address() as AddressInfo).port, movedFrom: candidate === port ? null : port };
    }

    // A taken port is the only failure the next port can fix. A privileged port, an address
    // this machine does not have, a descriptor limit — none of them get better ten ports
    // later, and reporting them as "all in use" sends the user hunting a process that was
    // never there.
    if (failure.code === 'EADDRINUSE' && candidate < last) continue;

    if (failure.code === 'EADDRINUSE' && walks) {
      throw new Error(`ports ${port}-${last} all in use — pick one with --port <n>`);
    }
    // The source chose `port`. If the walk has moved on, saying "4479 (the default)" would be
    // false — 4479 is a port this module picked, and this module's whole discipline is that a
    // value is reported with whoever actually chose it.
    const whose = candidate === port ? SOURCE_PHRASE[source] : `walked to from ${port}, ${SOURCE_PHRASE[source]}`;
    const why =
      failure.code === 'EADDRINUSE' ? 'already in use, --port <n> picks another' : failure.message;
    throw new Error(`cannot listen on port ${candidate} (${whose}) — ${why}`);
  }
}

/**
 * One bind. Resolves with the error instead of rejecting, so "busy, try the next one" and
 * "this run is over" stay two different things at the call site.
 *
 * Both listeners come off before it settles: `listen` reports through events, and the same
 * server object is reused for every attempt — a handler left behind would answer for the
 * attempt after it.
 */
function attempt(server: Server, port: number, host: string): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      resolve(e);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(null);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}
