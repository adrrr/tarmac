// A DOM the size of exactly what the dashboard's script touches, and a clock the test drives.
//
// Why this exists: the page's script was the one part of the product no test could execute,
// and "everything a reader interprets is rendered on the server" stopped being true the
// moment the script started deciding things — that an empty body is a failure, that one
// request runs at a time, that an age never goes negative. Those are interpretation, and a
// mutation run proved the suite could not tell a live script from a deleted one.
//
// It runs the string the browser is actually served — extracted from `renderPage`'s output,
// not a copy — so a rule that is removed from the page is a rule that goes red here. No
// framework, no bundler, no dependency: about eighty lines of the four objects it calls.

/**
 * What a `<canvas>` hands back, reduced to a recorder.
 *
 * The history view draws with a 2d context, and no assertion can read a pixel. What CAN be
 * asserted is that the drawing ran at all and did not throw halfway through, which is the whole
 * failure mode of a chart fed the wrong shape — so the context accepts every call, keeps every
 * property, and remembers the names in order for a test that wants to know a path was built.
 */
class Ctx2D {
  /** Every call, in order, with what it was given. The names say a path was built; the
   *  arguments are the only way a test can read a bar's height or a label's words. */
  readonly calls: Array<{ name: string; args: unknown[] }> = [];
  /** The names alone, for an assertion about the shape of a path rather than its geometry. */
  get names(): string[] {
    return this.calls.map((c) => c.name);
  }
  /** Every argument list one method was called with. */
  argsOf(name: string): unknown[][] {
    return this.calls.filter((c) => c.name === name).map((c) => c.args);
  }
  constructor() {
    return new Proxy(this, {
      get: (target, key: string) => {
        if (key === 'calls') return target.calls;
        if (key === 'names') return target.names;
        if (key === 'argsOf') return target.argsOf.bind(target);
        if (key in target) return (target as any)[key];
        // Anything not set as a property is a method: record the call and answer plausibly.
        return (...args: unknown[]): unknown => {
          target.calls.push({ name: key, args: args });
          return key === 'measureText' ? { width: 0 } : undefined;
        };
      },
      set: (target, key: string, value: unknown) => {
        (target as any)[key] = value;
        return true;
      },
    });
  }
}

class El {
  textContent = '';
  innerHTML = '';
  hidden = false;
  /** What a canvas carries. `clientWidth` is what the drawing sizes itself off. */
  clientWidth = 360;
  width = 0;
  height = 0;
  readonly style: Record<string, string> = {};
  private ctx: Ctx2D | null = null;
  getContext(kind: string): Ctx2D | null {
    if (kind !== '2d') return null;
    return (this.ctx ??= new Ctx2D());
  }
  getBoundingClientRect(): { left: number; width: number } {
    return { left: 0, width: this.clientWidth };
  }
  /** What a range and a button carry. The script writes them; a test reads them back. */
  value = '';
  max = '';
  min = '';
  disabled = false;
  readonly classes = new Set<string>();
  readonly classList = {
    toggle: (name: string, on?: boolean): void => {
      const add = on === undefined ? !this.classes.has(name) : on;
      if (add) this.classes.add(name);
      else this.classes.delete(name);
    },
  };
  private readonly attrs = new Map<string, string>();
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  private readonly handlers = new Map<string, Array<(ev?: unknown) => void>>();
  addEventListener(type: string, fn: (ev?: unknown) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(fn);
    this.handlers.set(type, list);
  }
  /**
   * A reader's click, a tap on a chart, or a drag of the handle — from the test's side of the
   * glass. The event is passed through because the page reads one: a tap carries the x it
   * landed on, and a click on a legend is delegated and has to find its own target.
   */
  fire(type: string, ev: unknown = undefined): void {
    for (const fn of this.handlers.get(type) ?? []) (fn as (e: unknown) => void)(ev);
  }
  /** Drag: the browser sets the value, then tells the page. */
  drag(value: number): void {
    this.value = String(value);
    this.fire('input');
  }
}

interface Timer {
  fn: () => void;
  every: number;
  next: number;
  dead: boolean;
}

/**
 * What the fake server answers. Returning a promise that never settles is the point — and the
 * path is passed because the page now asks two questions: the fleet now, and the day behind it.
 */
export type Respond = (
  call: number,
  url: string,
) => Promise<{ ok: boolean; body: string; headers?: Record<string, string> }>;

export interface Page {
  el(id: string): El;
  body: El;
  /** Move the clock, firing every timer that comes due, and let the promises settle. */
  advance(ms: number): Promise<void>;
  /** How many requests the script has issued — the count that proves a poll is not stuck. */
  calls: number;
  hide(): void;
  show(): Promise<void>;
}

export interface MountOptions {
  /** What the reader asked their operating system for. The play button reads it. */
  reducedMotion?: boolean;
  /**
   * How the shell ships each element, from `shellState`. Without it every element starts
   * visible and enabled, and an assertion that the script REVEALED something passes whether
   * or not the script ran — which is how three tests of the replay banner turned out to be
   * pinning nothing at all.
   *
   * `text` is there for the same reason one step further on: the history view keeps the
   * sentence the SERVER wrote about the ring rather than writing a second copy of it, so an
   * element that starts empty here is a page that starts wrong.
   */
  shell?: Record<string, { hidden: boolean; disabled: boolean; text: string }>;
}

/**
 * What the served markup says about each element with an id, so the fake DOM starts where the
 * browser's would. Only the two attributes the script toggles are read.
 */
export function shellState(html: string): Record<string, { hidden: boolean; disabled: boolean; text: string }> {
  const state: Record<string, { hidden: boolean; disabled: boolean; text: string }> = {};
  for (const m of html.matchAll(/<([a-z]+)\s([^>]*\bid="([\w-]+)"[^>]*)>([^<]*)/g)) {
    const [, , attrs, id, text] = m;
    state[id] = {
      hidden: /\bhidden\b/.test(attrs),
      disabled: /\bdisabled\b/.test(attrs),
      // Only an element whose content is text and nothing else: anything with a child is
      // markup this DOM does not model, and a partial string would be worse than none.
      text: decode(text),
    };
  }
  return state;
}

/** The handful of entities this page's own markup emits. */
const ENTITIES: Record<string, string> = {
  '&middot;': '·',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&mdash;': '—',
};
const decode = (text: string): string => text.replace(/&[a-z#0-9]+;/g, (e) => ENTITIES[e] ?? e);

export function mountPage(
  script: string,
  respond: Respond,
  { reducedMotion = false, shell = {} }: MountOptions = {},
): Page {
  const els = new Map<string, El>();
  const body = new El();
  const timers: Timer[] = [];
  const listeners: Array<() => void> = [];
  let clock = 1_700_000_000_000;
  let hidden = false;
  const page = {
    calls: 0,
  } as Page & { calls: number };

  const el = (id: string): El => {
    let e = els.get(id);
    if (!e) {
      els.set(id, (e = new El()));
      const as = shell[id];
      if (as) {
        e.hidden = as.hidden;
        e.disabled = as.disabled;
        e.textContent = as.text;
      }
    }
    return e;
  };

  const document = {
    getElementById: (id: string): El => el(id),
    get body(): El {
      return body;
    },
    get hidden(): boolean {
      return hidden;
    },
    addEventListener: (type: string, fn: () => void): void => {
      if (type === 'visibilitychange') listeners.push(fn);
    },
  };

  const fetchStub = async (
    url: string,
  ): Promise<{ ok: boolean; headers: { get(n: string): string | null }; text: () => Promise<string> }> => {
    const call = ++page.calls;
    // Default: tarmac answered. A test that wants a stranger on the port says so explicitly.
    const { ok, body: text, headers = { 'x-tarmac': '1' } } = await respond(call, url);
    return {
      ok,
      headers: { get: (n: string): string | null => headers[n.toLowerCase()] ?? null },
      text: async () => text,
    };
  };

  const setIntervalStub = (fn: () => void, every: number): number => {
    timers.push({ fn, every, next: clock + every, dead: false });
    return timers.length;
  };

  const clearIntervalStub = (id: number): void => {
    const t = timers[id - 1];
    if (t) t.dead = true;
  };

  // A real Date with a clock the test drives: the page formats the minute it is replaying, so
  // `new Date(t)` has to be the constructor it is everywhere else.
  class DateStub extends Date {
    static override now(): number {
      return clock;
    }
  }

  const matchMediaStub = (query: string): { matches: boolean } => ({
    matches: reducedMotion && query.includes('reduced-motion'),
  });

  // The script is an IIFE over bare globals; naming them as parameters shadows the real ones,
  // so nothing here can reach the actual document, fetch or clock.
  // eslint-disable-next-line no-new-func
  new Function('document', 'fetch', 'setInterval', 'clearInterval', 'Date', 'matchMedia', script)(
    document,
    fetchStub,
    setIntervalStub,
    clearIntervalStub,
    DateStub,
    matchMediaStub,
  );

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  };

  page.el = el;
  page.body = body;
  page.advance = async (ms: number): Promise<void> => {
    const target = clock + ms;
    for (;;) {
      const due = timers.filter((t) => !t.dead && t.next <= target).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      clock = due.next;
      due.next += due.every;
      due.fn();
      await settle();
    }
    clock = target;
    await settle();
  };
  page.hide = (): void => {
    hidden = true;
  };
  page.show = async (): Promise<void> => {
    hidden = false;
    for (const fn of listeners) fn();
    await settle();
  };
  return page;
}

/** The script exactly as the browser receives it — extracted from the served page. */
export function scriptOf(html: string, nth = 0): string {
  const all = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (all.length <= nth) throw new Error(`the page shipped ${all.length} scripts, not ${nth + 1}`);
  return all[nth][1];
}

/**
 * The history view's own script, which is the SECOND the page carries and only on its own
 * address. Named rather than left as `scriptOf(html, 1)` at every call site: which script is
 * which is a fact about the page, not about each test that mounts one.
 */
export const historyScriptOf = (html: string): string => scriptOf(html, 1);
