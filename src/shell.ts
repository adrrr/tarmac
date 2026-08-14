// The two directions of one fact: `statusLine.command` is shell source.
//
// Claude Code documents that field as running in a shell, so tarmac writes a PATH into it
// (which must survive word splitting) and later reads a path back out of it (to answer "is
// this command my own wrapper?"). Those are inverse operations, and when they drifted apart
// — quoting that escaped an apostrophe, reading that only stripped the outer quotes — a home
// named `od d's` stopped being recognised as its own install: the wrapper chained itself,
// and one frame forked until the process table gave up. Written as a pair, tested as a pair.

/** Characters a shell leaves alone. Anything else has to be quoted to survive. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+:,.\/-]+$/;

/** `s` as shell source that evaluates back to exactly `s`. Quoted only when it needs to be. */
export function quoteArg(s: string): string {
  return SHELL_SAFE.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The first word of a command line, with quoting removed — i.e. the file it runs. Arguments,
 * pipes and redirects are none of our business; the file is what identity is decided on.
 *
 * @returns `''` when the line cannot be parsed (an unbalanced quote). A command we cannot
 *          read is not one we may guess at: this answer decides whether tarmac deletes a
 *          wrapper, and half a quoted string could name any file at all.
 */
export function firstWord(command: string): string {
  const s = command.trim();
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === ' ' || c === '\t' || c === '\n') break;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) return '';
      out += s.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      const closed = readDoubleQuoted(s, i + 1);
      if (closed === null) return '';
      out += closed.text;
      i = closed.next;
    } else if (c === '\\') {
      if (i + 1 >= s.length) return '';
      out += s[i + 1];
      i += 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Inside double quotes only `\` before `"`, `\`, `$` and a backtick is an escape. */
function readDoubleQuoted(s: string, from: number): { text: string; next: number } | null {
  let text = '';
  for (let i = from; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') return { text, next: i + 1 };
    if (c === '\\' && i + 1 < s.length && ['"', '\\', '$', '`'].includes(s[i + 1]!)) {
      text += s[i + 1];
      i += 1;
      continue;
    }
    text += c;
  }
  return null;
}
