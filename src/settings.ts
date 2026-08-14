// P2 — pure settings surgery. No filesystem here, so every branch is cheap to test.
//
// Two promises the product makes about `settings.json`:
//   1. NON-DESTRUCTIVE — an existing statusLine is wrapped (still rendered), never replaced.
//   2. REVERSIBLE — what we removed is handed back to the caller so it can be stored and
//      put back verbatim.
//
// Anything we do not understand is REFUSED, not overwritten. A statusLine shape we cannot
// chain is a user's working display; guessing would break their terminal.

/**
 * Someone else's settings.json. Deliberately loose: it is user-authored JSON of a shape
 * that grows with every Claude Code release, and the ONE key we understand is `statusLine`.
 * The runtime guards below are the real type check.
 */
export type Settings = Record<string, any>;

/** The only statusLine shape tarmac knows how to chain. Extra keys are the user's display config. */
export interface StatusLineCommand {
  type: 'command';
  command: string;
  [key: string]: unknown;
}

export interface ChainResult {
  settings: Settings;
  previous: StatusLineCommand | null;
  alreadyInstalled: boolean;
}

export interface UnchainResult {
  settings: Settings;
  /** `false` ⇒ we touched nothing. */
  restored: boolean;
}

export interface IdentityOptions {
  isSameCommand?: (a: string, b: string) => boolean;
}

export interface ChainOptions extends IdentityOptions {
  /**
   * How to SPELL the wrapper in `statusLine.command`, when the path alone is not valid
   * shell source — Claude Code documents that field as running in a shell, so a path with
   * a space in it has to reach the shell quoted. Defaults to the path itself.
   */
  commandSpelling?: string;
}

// Identity of "is this command OUR wrapper?" is NOT string equality. `/tmp/x` and
// `/private/tmp/x` are the same file on macOS; so are a bind mount and a firmlink. Getting
// this wrong makes tarmac wrap its own wrapper — an unbounded recursion at every TUI frame,
// with the user's real statusline erased from the only file that named it. The comparator
// is injected because this module stays pure; `install.ts` passes a filesystem-aware one.
const stringEquality = (a: string, b: string): boolean => a === b;

/**
 * @param settings parsed settings.json (may be {})
 * @param wrapperPath absolute path to the tarmac wrapper
 */
export function chainStatusLine(
  settings: Settings,
  wrapperPath: string,
  { isSameCommand = stringEquality, commandSpelling }: ChainOptions = {},
): ChainResult {
  const next = structuredClone(settings ?? {});
  const current = next.statusLine;

  if (isOurs(current, wrapperPath, isSameCommand)) {
    return { settings: next, previous: null, alreadyInstalled: true };
  }

  let previous: StatusLineCommand | null = null;
  if (current !== undefined && current !== null) {
    if (!isChainableCommand(current)) {
      throw new Error(
        'refusing to replace an unrecognised statusLine (expected {type:"command", command:"…"})',
      );
    }
    previous = structuredClone(current);
  }

  // Swap ONLY the command. Every other key (`padding: 0` is flush-left, and more may come)
  // is the user's display configuration: dropping it changes what they see, which is the
  // one thing chaining promises not to do.
  next.statusLine = { ...(previous ?? {}), type: 'command', command: commandSpelling ?? wrapperPath };
  return { settings: next, previous, alreadyInstalled: false };
}

/**
 * @param settings parsed settings.json as it stands now
 * @param previous the statusLine recorded at install time
 * @param wrapperPath the wrapper we installed
 */
export function unchainStatusLine(
  settings: Settings,
  previous: StatusLineCommand | null,
  wrapperPath: string,
  { isSameCommand = stringEquality }: IdentityOptions = {},
): UnchainResult {
  const next = structuredClone(settings ?? {});
  // Someone else owns the statusLine now — hands off. The caller MUST learn that nothing
  // was undone, or it deletes the wrapper that line still points at.
  if (!isOurs(next.statusLine, wrapperPath, isSameCommand)) return { settings: next, restored: false };
  if (previous) next.statusLine = structuredClone(previous);
  else delete next.statusLine;
  return { settings: next, restored: true };
}

function isChainableCommand(v: unknown): v is StatusLineCommand {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as StatusLineCommand).type === 'command' &&
    typeof (v as StatusLineCommand).command === 'string' &&
    (v as StatusLineCommand).command !== ''
  );
}

function isOurs(v: unknown, wrapperPath: string, isSameCommand: (a: string, b: string) => boolean): boolean {
  return isChainableCommand(v) && isSameCommand(v.command, wrapperPath);
}
