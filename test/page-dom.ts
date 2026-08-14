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
  readonly classes = new Set<string>();
  readonly classList = {
    toggle: (name: string, on?: boolean): void => {
      const add = on === undefined ? !this.classes.has(name) : on;
      if (add) this.classes.add(name);
      else this.classes.delete(name);
    },
  };
}

interface Timer {
  fn: () => void;
  every: number;
  next: number;
}

/** What the fake server answers. Returning a promise that never settles is the point. */
export type Respond = (call: number) => Promise<{ ok: boolean; body: string; headers?: Record<string, string> }>;

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

export function mountPage(script: string, respond: Respond): Page {
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
    if (!e) els.set(id, (e = new El()));
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

  const fetchStub = async (): Promise<{ ok: boolean; headers: { get(n: string): string | null }; text: () => Promise<string> }> => {
    const call = ++page.calls;
    // Default: tarmac answered. A test that wants a stranger on the port says so explicitly.
    const { ok, body: text, headers = { 'x-tarmac': '1' } } = await respond(call);
    return {
      ok,
      headers: { get: (n: string): string | null => headers[n.toLowerCase()] ?? null },
      text: async () => text,
    };
  };

  const setIntervalStub = (fn: () => void, every: number): number => {
    timers.push({ fn, every, next: clock + every });
    return timers.length;
  };

  const DateStub = { now: (): number => clock };

  // The script is an IIFE over bare globals; naming them as parameters shadows the real ones,
  // so nothing here can reach the actual document, fetch or clock.
  // eslint-disable-next-line no-new-func
  new Function('document', 'fetch', 'setInterval', 'Date', script)(document, fetchStub, setIntervalStub, DateStub);

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  };

  page.el = el;
  page.body = body;
  page.advance = async (ms: number): Promise<void> => {
    const target = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.next <= target).sort((a, b) => a.next - b.next)[0];
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
