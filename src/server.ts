// P3 — the local dashboard. node:http, localhost, no dependency.
//
// The collector is injected so the server can be exercised without spawning `claude`, and
// so a read-only snapshot directory (the fleet's own, for the demo) is just a parameter.

import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { reason, renderLive, renderPage } from './render.ts';
import type { View } from './render.ts';
import { hostName, SOURCE_PHRASE } from './config.ts';
import { createHistory, HISTORY_CADENCE_MS } from './history.ts';
import type { FleetHistory, HistorySample } from './history.ts';
import { HISTORY_RANGES } from './history-range.ts';
import type { HistoryRange, RangeHistory } from './history-range.ts';
import type { HistoryStore } from './history-store.ts';
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
  ['/history', 'history'],
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
  /**
   * The hosts this serve answers to BESIDES loopback — empty by default, which is the whole
   * of the privacy stance and what every serve nobody configured still does.
   *
   * It exists for one situation: a reverse proxy in front of this port forwards the Host the
   * browser typed, and no proxy presents a loopback one, so `tailscale serve`, caddy and nginx
   * all met a 403 with no supported answer (#105). Naming a host here says, in writing, that
   * anyone who can make a browser send that Host — anyone on that tailnet, anyone the proxy
   * lets in — may read this fleet's working directories, session ids and costs.
   */
  trustedHosts?: readonly string[];
  /**
   * Where each tick's reading is ALSO written down, when a reader set `history.days`. Absent
   * is the default and the product: nothing on disk unless someone asked for it.
   *
   * The store is handed the sample the ring kept rather than a fleet of its own, so it cannot
   * become a second sampler with a schedule of its own, and so the file and `/api/history`
   * cannot disagree about the same minute.
   */
  store?: HistoryStore | null;
  /**
   * How long a range read off that journal is worth serving again. A parameter for the same one
   * reason `sampleEveryMs` is one: a suite that waited a minute to watch a cache expire would
   * not be run. One minute is the product, and it is not a flag, a variable or a config key.
   */
  rangeCacheMs?: number;
  /**
   * Where the journal's own troubles are said out loud. `serve` runs unattended for hours, so
   * a journal that quietly stopped writing would leave a reader believing they have a week of
   * history until the day they go looking for it.
   */
  report?: (line: string) => void;
  /**
   * The ring this serve keeps its last 24 hours in. Its own by default, empty and filling one
   * minute at a time, which is what every real serve does.
   *
   * Injected for the same reason `collect` is: `serve --demo` opens on a record that is already
   * a day long, and building it by playing an invented day through the SAME `record` a sampler
   * calls is what keeps the replay a reduction of the demo rather than a second account of it.
   */
  history?: FleetHistory;
  /**
   * Whether the fleet `collect` answers is the invented one. It reaches the page and nothing
   * else — the server neither builds the demo nor knows what is in it.
   */
  demo?: boolean;
}

export function createFleetServer({
  collect,
  sampleEveryMs = HISTORY_CADENCE_MS,
  trustedHosts = [],
  store = null,
  rangeCacheMs = 60_000,
  report = (line) => console.error(line),
  history = createHistory({ since: Date.now(), cadence: sampleEveryMs }),
  demo = false,
}: FleetServerDeps): Server {
  // Normalised HERE rather than trusted to arrive that way. This is the last thing between a
  // foreign origin and the fleet, so it owns both sides of its own comparison — the config
  // parser cuts a name the same way, and neither leans on the other having done it.
  //
  // The empty one is dropped for the same reason, and it is not tidiness: a name that
  // normalises to nothing is a name that every Host normalising to nothing matches — `:8443`,
  // a lone bracket — which would be a guard standing open on a list that looks set. Nothing
  // reachable from a flag, a variable or a file gets here empty; that is the parser's promise,
  // and this is the guard not resting on it.
  const trusted = new Set(trustedHosts.map((h) => hostName(h.trim()).toLowerCase()).filter((h) => h !== ''));
  // The page wears a badge; this is the same fact for machines. The HTML shell is one of four
  // surfaces this port answers, and the other three are JSON and a fragment a consumer may
  // archive or forward — where an invented fleet with nothing on it saying so becomes a real
  // one the moment the response body travels alone. On every answer for the same reason
  // IDENTITY is: the refusals and the 500s of a demo serve are the demo's too.
  const identity = demo ? { ...IDENTITY, 'x-tarmac-demo': '1' } : IDENTITY;
  // Which rule refused, decided once. With hosts named, "loopback hosts only" would read as a
  // flag that never took; with none, this is the sentence it has always been, to the byte. The
  // Host itself is never quoted back: it is the one string on the request the caller wrote.
  const refusal = trusted.size === 0
    ? 'tarmac serves loopback hosts only\n'
    : 'tarmac serves loopback and trusted hosts only\n';
  // What this serve has already read, kept for a day and never written down, is the ring above
  // — its `since` is the moment it was made, not the first sample that landed, so the span it
  // covers is how long the process has been up and an hour of it with nothing in it is a fact
  // worth showing rather than an empty record pretending to be a young one.
  //
  // One at a time. `claude agents --json` has a 15s deadline of its own, and a fleet slower
  // than a slot would otherwise be answered with a queue of processes instead of one missed
  // minute — the tick that finds a read still running counts the slot and stands down.
  let reading = false;
  // Said on the CHANGE, never on the tick. A read-only journal directory is a fact that holds
  // for hours, and a line a minute about it is a log a reader learns to scroll past, which is
  // the same as never having printed it. A failure that comes back after a run of good writes
  // is a new fact and says so again, which is what the two flags below are for.
  let misses = 0;
  let failing = false;
  let saidStopped: string | null = null;
  const journal = (taken: HistorySample): void => {
    if (store === null) return;
    // Structurally best effort, not best effort by argument. The store swallows its own
    // filesystem trouble, so nothing in here can throw today; but this is called from inside
    // the sampler's try, where a throw would be caught as A FLEET READING THAT FAILED and
    // counted as a missed minute in `/api/history` on top of the sample already pushed. The
    // journal is not allowed to make the record of the fleet wrong, whatever it does to itself.
    try {
      store.append(taken);
      const stats = store.stats();
      if (stats.stopped !== saidStopped) {
        saidStopped = stats.stopped;
        if (stats.stopped !== null) report(`tarmac: the fleet journal has stopped, ${stats.stopped}`);
      }
      const missed = stats.misses > misses;
      misses = stats.misses;
      if (missed && !failing) {
        report(`tarmac: could not write to the fleet journal in ${store.dir}; that reading is lost`);
      }
      failing = missed;
    } catch {
      // Including a `report` a caller wrote that throws: this one is not ours to be right.
    }
  };
  // A week or a month of journal, held for a minute after it was read.
  //
  // The entry is the READING, not the answer, and it is stored before anything is awaited: two
  // requests that arrive together, or a page that asks for the week and the month at once, share
  // one pass over the files rather than starting a second one behind the first. The files are
  // tens of megabytes and the thread they are read on is the thread that samples the fleet.
  //
  // A minute, because the journal gains one line a minute: a cache that lived longer would be a
  // page showing an hour that has already been written to.
  // `at` is when the read FINISHED, and `null` while it has not: a read dated by its start goes
  // stale on a slow disk while it is still running, and the next request then opens the same
  // month a second time, in parallel, which is the one thing this exists to prevent.
  //
  // That half is held by construction rather than by a test in this suite, which is worth knowing
  // before editing it: the TTL below has tests, and "one read, however many requests arrive during
  // it" is this shape, kept simple enough to read. The entry goes in the map before anything is
  // awaited, and nothing takes it out while it is running. It IS measurable, by counting the calls
  // a request makes to `fs/promises.readFile`, which is how the regression this comment used to
  // deny was found; what a test for it costs is a module-wide patch of `node:fs`, and that is the
  // trade this file made rather than the impossibility it claimed.
  interface Cached {
    at: number | null;
    reading: Promise<RangeHistory>;
  }
  const ranges = new Map<HistoryRange, Cached>();
  const rangeOf = (store: HistoryStore, range: HistoryRange): Promise<RangeHistory> => {
    const now = Date.now();
    const held = ranges.get(range);
    if (held !== undefined && (held.at === null || now - held.at < rangeCacheMs)) return held.reading;
    const entry: Cached = { at: null, reading: undefined as unknown as Promise<RangeHistory> };
    // Asked of the STORE, which owns both ends of its own journal: this route never learns where
    // the days come from, so the invented week `serve --demo` carries arrives here as an ordinary
    // range read and the demo gets no rendering path of its own (#156).
    //
    // Read once per range per minute rather than per request: the store walks its directory to
    // answer, and a journal that stopped at its cap stays stopped for hours, so a minute-old
    // answer to that question is the same answer.
    entry.reading = store.read(range, now).then(
      (answer) => {
        entry.at = Date.now();
        return answer;
      },
      (e) => {
        // A read that failed leaves nothing behind to be served for the rest of the minute. Only
        // its own entry, though: a slow failure that cleared the map would drop the good answer a
        // later request had already put there.
        if (ranges.get(range) === entry) ranges.delete(range);
        throw e;
      },
    );
    ranges.set(range, entry);
    return entry.reading;
  };

  const sample = async (): Promise<void> => {
    // First, and outside the try: the journal's lock says this process is alive, which is a
    // fact about the tick and not about the reading. A collector that has been throwing for
    // five minutes would otherwise leave the lock looking abandoned to the next serve.
    store?.heartbeat();
    if (reading) {
      history.miss(Date.now());
      return;
    }
    reading = true;
    try {
      journal(history.record(await collect()));
    } catch {
      // A collector that throws is the normal weather here: `claude` missing, a laptop that
      // was asleep. It costs a slot and nothing else — a throw out of this timer would be an
      // unhandled rejection, and `serve` runs unattended for hours.
      history.miss(Date.now());
    } finally {
      reading = false;
    }
  };

  const server = http.createServer(async (req, res) => {
    // Loopback binding alone does not stop a DNS-rebinding page in the user's own browser
    // from reading /api/fleet — which carries cwd paths, session ids and costs. Whatever a
    // reader trusted on top of that is a name, exactly: matched whole, never as a prefix, a
    // suffix or a pattern, so trusting one host can never be trusting a family of them.
    if (!isLoopbackHost(req.headers.host) && !isTrustedHost(req.headers.host, trusted)) {
      res.writeHead(403, { ...identity, 'content-type': 'text/plain; charset=utf-8' });
      res.end(refusal);
      return;
    }

    // The Host check stops another origin READING this port; it does not stop one poking it.
    // Any page the user visits can `fetch(…, {mode:'no-cors'})` here as fast as it likes —
    // CORS hides the answer, but each request still spawns `claude agents --json`. Browsers
    // label their own requests, so a label that says cross-site is refused before anything is
    // spawned; a client that sends no label (curl, a script) is left alone.
    const site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
      res.writeHead(403, { ...identity, 'content-type': 'text/plain; charset=utf-8' });
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
      res.writeHead(404, { ...identity, 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }

    // Served out of the ring, above the collect below and never through it: this route is
    // what the serve has ALREADY read, and one that collected would let a scrubber spawn
    // `claude agents --json` on every drag of its handle.
    // The same route, one question further back: `range` sends it to the journal on disk for the
    // week or the month the ring cannot hold. No range is the ring, and `24h` is the name of
    // that, so a page may say which one it wants without asking for a different route.
    if (url.pathname === '/api/history' && url.searchParams.has('range')) {
      const asked = url.searchParams.get('range')!;
      if (asked !== '24h') {
        if (!isRange(asked)) {
          // The value is not quoted back, for the reason the refused Host is not: it is a string
          // the caller wrote, and the page swaps a refusal's text into `innerHTML` as its reason.
          res.writeHead(400, { ...identity, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end(`tarmac serves /api/history for 24h, ${HISTORY_RANGES.join(' and ')}; no range is the last 24h\n`);
          return;
        }
        // Off is not the same answer as an empty week: a page that could not tell them apart
        // would draw a flat line over a month the fleet was busy for.
        let body: object;
        try {
          body = store === null ? { enabled: false, range: asked } : { enabled: true, ...(await rangeOf(store, asked)) };
        } catch (e) {
          // Nothing in `readRange` is allowed to throw, and this is the seam that keeps a day
          // when something does from being a request that hangs instead of an answer.
          res.writeHead(500, { ...identity, 'content-type': 'text/plain; charset=utf-8' });
          res.end(`tarmac could not read the fleet journal:\n${reason(e)}\n`);
          return;
        }
        res.writeHead(200, {
          ...identity,
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(body));
        return;
      }
    }

    if (url.pathname === '/api/history') {
      res.writeHead(200, {
        ...identity,
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      // Not indented, alone among the JSON answers here. `/api/fleet` pretty-prints ONE
      // reading, which a person reads in a terminal; this is up to 1440 of them, where the
      // indentation is 40% of a body no human will ever open — megabytes of whitespace on
      // every poll of the replay.
      res.end(JSON.stringify(history.read()));
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
        // Whether there is a journal is the config's answer and the server is the one holding
        // it, so the view ships knowing — rather than drawing three live ranges and taking two
        // of them back once a fetch has been out and come home refused.
        body =
          url.pathname === '/live'
            ? renderLive(fleet)
            : renderPage(fleet, PAGES.get(url.pathname)!, { historyEnabled: store !== null, demo });
      }
    } catch (e) {
      // Say why. A dashboard that goes blank when its source breaks teaches nothing.
      res.writeHead(500, { ...identity, 'content-type': 'text/plain; charset=utf-8' });
      res.end(`tarmac could not read the fleet:\n${reason(e)}\n`);
      return;
    }

    // A page whose entire claim is freshness must not be served from a cache: a restored tab
    // re-running the script over stale HTML would re-stamp it "updated just now".
    res.writeHead(200, { ...identity, 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  });

  // The sampler lives exactly as long as the serving does. Started at construction it kept
  // reading the fleet for a server whose `listen` had refused — a port named on the command
  // line and taken — into a ring no request could ever reach; and never cleared, it did the
  // same for every server a suite had closed behind it.
  //
  // `close` is the only shutdown this module has. `tarmac serve` itself has no graceful one:
  // Ctrl-C ends the process, which takes the timer with it. Unref'ing is the belt to that
  // braces — it keeps the sampler from being a reason `node --test`, or anything else that
  // embeds this server, stays alive — and it is deliberately not the thing relied on.
  let sampler: NodeJS.Timeout | null = null;
  server.on('listening', () => {
    if (sampler !== null) return;
    // A demo does not sample. Its collector answers one frozen minute, so every tick would
    // record that same minute into the ring and push a minute of the invented day off the far
    // end: one slot a minute, until a serve left up overnight is showing 1440 copies of one
    // reading. That is the flat chart this whole feature exists to replace. The record it was
    // handed is the record it keeps, and the live view stays honestly dated either way.
    if (demo) return;
    // The journal's retention, applied before the first line of this run is written and once a
    // local day after that (the store keeps that half itself). Here rather than in the CLI so
    // that the store `serve` prunes with is, provably, the store `serve` writes with: a `serve`
    // that built one and forgot to hand it over would otherwise sweep and journal nothing.
    if (store !== null) {
      const { removed, failed } = store.prune();
      if (removed > 0) report(`tarmac: removed ${removed} journal file(s) older than ${store.days} days from ${store.dir}`);
      if (failed > 0) report(`tarmac: could not remove ${failed} journal file(s) under ${store.dir}`);
    }
    sampler = setInterval(() => void sample(), sampleEveryMs);
    sampler.unref();
  });
  server.on('close', () => {
    if (sampler === null) return;
    clearInterval(sampler);
    sampler = null;
  });
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

/** One of the ranges the journal reader knows, matched whole. */
const isRange = (asked: string): asked is HistoryRange => (HISTORY_RANGES as readonly string[]).includes(asked);

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = hostName(host);
  return name === 'localhost' || name === '127.0.0.1' || name === '::1';
}

/**
 * One of the names the reader wrote down, matched whole — never as a prefix, a suffix or a
 * pattern, and no wildcard is accepted into that list or honoured against a request.
 *
 * What is matched is the name `hostName` cuts out, and that cut is the loopback check's, kept
 * shared rather than tightened: it drops the port, and it drops a leading `[` or a trailing
 * `]` whether or not they pair. So `[name` and `name]` reach the comparison as `name`, exactly
 * as `[localhost` has always reached it as `localhost`. Nothing is opened by it — `Host` is a
 * forbidden header, a browser derives it from the URL, and a client free to type the header is
 * free to type the name itself — and narrowing it here would change what the default answers.
 *
 * The port is not part of the name on either side: a proxy presents `name:8443` on one setup
 * and a bare `name` on 443, and the port in a `Host` header is chosen by whoever sends it, so
 * matching on it would have refused half the setups this exists for and barred nobody. Case is
 * not part of it either — host names are case-insensitive, and the loopback names above are
 * left exactly as strict as they have always been rather than loosened to match.
 *
 * `host` is whichever `Host` node reports; it reports the first when a request carries two.
 */
function isTrustedHost(host: string | undefined, trusted: ReadonlySet<string>): boolean {
  if (!host || trusted.size === 0) return false;
  return trusted.has(hostName(host).toLowerCase());
}
