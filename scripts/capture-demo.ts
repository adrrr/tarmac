// The README's GIF, taken again by one command instead of from somebody's shell history.
//
//   node scripts/capture-demo.ts [path-to-chrome]
//
// It starts `tarmac serve --demo` on a free loopback port, drives a headless Chrome over the
// DevTools protocol through STORYBOARD below, once per colour scheme, and hands the frames to
// ffmpeg, which writes `docs/media/replay-light.gif` and `docs/media/replay-dark.gif`. Needs
// Chrome and ffmpeg on the machine; nothing else, and nothing that ships.
//
// The clock is pinned, on both sides of the socket. The demo dates its fleet off `Date.now()`,
// so a capture left alone prints the hour, the day and the timezone it was taken in, on every
// frame, and two captures of the same fleet never match. Both the serve and the page run at
// CAPTURE_AT, in UTC, which is also the instant the stills next to the GIF were taken at.
//
// Dev tooling: not in `files`, so it never ships. Everything it writes besides the two GIFs
// goes into a temp directory of its own, removed on the way out, and the serve it starts is
// handed an empty home, so no config of the machine it runs on is read.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Sunday 6 September 2026, 16:28 UTC: the instant `map-*.png` and `curves-*.png` show. */
export const CAPTURE_AT = Date.UTC(2026, 8, 6, 16, 28, 0);

/** CSS pixels, taken at device scale 2 and scaled back down, as the stills are. */
const WIDTH = 1100;
const HEIGHT = 900;

/**
 * A page the GIF stops on. `click` is pressed after the page is up, and the frame is taken
 * once the page has had `settle` seconds to draw what the click asked for.
 */
export interface Still {
  kind: 'still';
  path: string;
  click?: string;
  hold: number;
}

/**
 * The map's scrubber walked from the first reading of the record to the last, `frames` evenly
 * spaced stops, each held `each` seconds; the first and the last are held longer, because
 * they are where the reader is told what is happening and where it ended up.
 */
export interface Scrub {
  kind: 'scrub';
  frames: number;
  each: number;
  holdFirst: number;
  holdLast: number;
}

export type Scene = Still | Scrub;

// Table, map, the map's day replayed, the curves at a day and at a week. About 25 seconds: a
// GIF loops, and a reader who missed the table catches it on the next pass.
export const STORYBOARD: Scene[] = [
  { kind: 'still', path: '/', hold: 3.5 },
  { kind: 'still', path: '/map', hold: 3 },
  { kind: 'scrub', frames: 32, each: 0.25, holdFirst: 1.5, holdLast: 2 },
  { kind: 'still', path: '/history', hold: 3 },
  { kind: 'still', path: '/history', click: '#range-7d', hold: 3.5 },
];

/** An ffconcat list. The last file goes in twice: the demuxer ignores the last duration. */
export function concatList(frames: { file: string; seconds: number }[]): string {
  let out = 'ffconcat version 1.0\n';
  for (const f of frames) out += `file '${f.file}'\nduration ${f.seconds}\n`;
  if (frames.length > 0) out += `file '${frames[frames.length - 1].file}'\n`;
  return out;
}

/** `Date` moved to `at`, still ticking. A string, because the page needs the same code. */
const clockAt = (at: number): string =>
  `(() => { const R = Date; const shift = ${at} - R.now();` +
  ` class D extends R { constructor(...a) { if (a.length === 0) super(R.now() + shift); else super(...a); }` +
  ` static now() { return R.now() + shift; } } globalThis.Date = D; })();`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, seconds: number, probe: () => Promise<T | null>): Promise<T> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const got = await probe().catch(() => null);
    if (got !== null) return got;
    await sleep(100);
  }
  throw new Error(`timed out after ${seconds}s waiting for ${what}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** Just enough of the DevTools protocol: numbered calls, answered in any order. */
class Cdp {
  private next = 0;
  private waiting = new Map<number, { ok: (v: any) => void; ko: (e: Error) => void }>();
  private ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
      const w = msg.id === undefined ? undefined : this.waiting.get(msg.id);
      if (w === undefined) return;
      this.waiting.delete(msg.id!);
      if (msg.error !== undefined) w.ko(new Error(msg.error.message));
      else w.ok(msg.result);
    });
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)));
      ws.addEventListener('error', () => reject(new Error(`cannot open ${url}`)));
    });
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.next;
    return new Promise((ok, ko) => {
      this.waiting.set(id, { ok, ko });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression: string): Promise<unknown> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails !== undefined) throw new Error(`page threw on: ${expression}`);
    return r.result.value;
  }
  close(): void {
    this.ws.close();
  }
}

/** Two animation frames: whatever the last event changed has been laid out and painted. */
const painted = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))';

async function shoot(cdp: Cdp, file: string): Promise<string> {
  await cdp.eval(painted);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

async function capture(cdp: Cdp, base: string, scheme: 'light' | 'dark', dir: string): Promise<{ file: string; seconds: number }[]> {
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-color-scheme', value: scheme },
      // The halo is a one-shot animation otherwise, and the stills are taken this way too.
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ],
  });
  const frames: { file: string; seconds: number }[] = [];
  let n = 0;
  const next = (): string => path.join(dir, `${scheme}-${String(n++).padStart(3, '0')}.png`);
  let at = '';
  for (const scene of STORYBOARD) {
    if (scene.kind === 'still') {
      if (scene.path !== at) {
        await cdp.send('Page.navigate', { url: base + scene.path });
        await waitFor(`${scene.path} to load`, 15, async () => ((await cdp.eval('document.readyState')) === 'complete' ? true : null));
        at = scene.path;
        // The shell polls the fleet once it is up; give it that poll and a tick of the clock.
        await sleep(1500);
      }
      if (scene.click !== undefined) {
        await cdp.eval(`document.querySelector(${JSON.stringify(scene.click)}).click()`);
        await sleep(1500);
      }
      frames.push({ file: await shoot(cdp, next()), seconds: scene.hold });
      continue;
    }
    const max = await waitFor('the replay record', 15, async () => {
      const v = Number(await cdp.eval("(() => { const s = document.getElementById('scrub'); return s.disabled ? 0 : s.max; })()"));
      return v > 0 ? v : null;
    });
    for (let i = 0; i < scene.frames; i++) {
      const value = Math.round((i * max) / (scene.frames - 1));
      // The native setter and an `input` event: what a drag of the handle does, and all the
      // page listens to.
      await cdp.eval(
        `(() => { const s = document.getElementById('scrub');` +
          ` Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s, '${value}');` +
          ` s.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      );
      const seconds = i === 0 ? scene.holdFirst : i === scene.frames - 1 ? scene.holdLast : scene.each;
      frames.push({ file: await shoot(cdp, next()), seconds });
    }
  }
  return frames;
}

/** One palette for the whole animation, no dither: flat UI colours stay flat and small. */
function encode(list: string, out: string): void {
  execFileSync(
    'ffmpeg',
    [
      '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
      '-vf', `scale=${WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
      '-fps_mode', 'vfr', '-loop', '0', out,
    ],
    { stdio: 'inherit' },
  );
}

async function main(): Promise<void> {
  const chromeBin =
    process.argv[2] ??
    (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tarmac-capture-'));
  const children: ChildProcess[] = [];
  const stop = (): void => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGTERM');
  };
  process.on('exit', () => {
    stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(1));

  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  const port = await freePort();
  const serve = spawn(
    process.execPath,
    ['--import', `data:text/javascript,${encodeURIComponent(clockAt(CAPTURE_AT))}`, path.join(repo, 'src/cli.ts'),
      'serve', '--demo', '--port', String(port), '--home', home],
    // Only what a serve needs: no TARMAC_* setting of this shell leaks into the capture.
    { env: { PATH: process.env.PATH ?? '', HOME: home, TZ: 'UTC', LANG: 'en_US.UTF-8' }, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  children.push(serve);
  const base = `http://127.0.0.1:${port}`;
  await waitFor('the demo serve', 30, async () => ((await fetch(`${base}/api/fleet`)).ok ? true : null));

  const profile = path.join(tmp, 'chrome');
  const chrome = spawn(
    chromeBin,
    ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--lang=en-US', 'about:blank'],
    { stdio: 'ignore' },
  );
  children.push(chrome);
  const devtools = await waitFor('Chrome', 30, async () => {
    const f = path.join(profile, 'DevToolsActivePort');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n')[0] : null;
  });
  const targets = (await fetch(`http://127.0.0.1:${devtools}/json/list`).then((r) => r.json())) as { type: string; webSocketDebuggerUrl: string }[];
  const page = targets.find((t) => t.type === 'page');
  if (page === undefined) throw new Error('Chrome opened no page');
  const cdp = await Cdp.open(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: clockAt(CAPTURE_AT) });
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false });

  for (const scheme of ['light', 'dark'] as const) {
    const frames = await capture(cdp, base, scheme, tmp);
    const list = path.join(tmp, `${scheme}.ffconcat`);
    fs.writeFileSync(list, concatList(frames));
    const out = path.join(repo, 'docs/media', `replay-${scheme}.gif`);
    encode(list, out);
    const seconds = frames.reduce((s, f) => s + f.seconds, 0);
    process.stderr.write(`capture-demo: ${path.relative(repo, out)}, ${frames.length} frames, ${seconds}s, ${(fs.statSync(out).size / 1e6).toFixed(2)} MB\n`);
  }
  cdp.close();
}

// Importable for the suite, runnable for a capture: only a direct run starts anything.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (e: unknown) => {
      process.stderr.write(`capture-demo: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
