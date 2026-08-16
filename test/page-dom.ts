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

class El {
  textContent = '';
  innerHTML = '';
  hidden = false;
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
  private readonly handlers = new Map<string, Array<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(fn);
    this.handlers.set(type, list);
  }
  /** A reader's click, or a drag of the handle — from the test's side of the glass. */
  fire(type: string): void {
    for (const fn of this.handlers.get(type) ?? []) fn();
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
   */
  shell?: Record<string, { hidden: boolean; disabled: boolean }>;
}

/**
 * What the served markup says about each element with an id, so the fake DOM starts where the
 * browser's would. Only the two attributes the script toggles are read.
 */
export function shellState(html: string): Record<string, { hidden: boolean; disabled: boolean }> {
  const state: Record<string, { hidden: boolean; disabled: boolean }> = {};
  for (const m of html.matchAll(/<[a-z]+\s([^>]*\bid="([\w-]+)"[^>]*)>/g)) {
    const [, attrs, id] = m;
    state[id] = { hidden: /\bhidden\b/.test(attrs), disabled: /\bdisabled\b/.test(attrs) };
  }
  return state;
}

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
export function scriptOf(html: string): string {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('the page shipped no script');
  return m[1];
}
