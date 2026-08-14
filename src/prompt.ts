// The confirmation that replaced the spike's blanket refusal of the real HOME.
//
// It asks for a WORD, not a keystroke: `y` is the answer people give without reading, and
// what is about to change is a working terminal's status line. And it never treats silence
// as consent — a closed pipe answers nothing, so a non-TTY stdin is refused outright and
// scripts have to say `--yes` on the command line, deliberately, in writing.

import readline from 'node:readline';

export interface ConfirmOptions {
  /** The word the user must type — the verb they ran. */
  word: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Is stdin a terminal, i.e. can a human actually answer? */
  isTTY: boolean;
  /** `--yes`: the deliberate, written opt-out. */
  yes: boolean;
}

/** @throws when there is no way to ask and no `--yes` — never returns a guessed answer. */
export async function confirmTyped({ word, input, output, isTTY, yes }: ConfirmOptions): Promise<boolean> {
  if (yes) return true;
  if (!isTTY) {
    throw new Error(`stdin is not a terminal, so nothing can be confirmed — pass --yes to ${word} without asking`);
  }
  output.write(`Type "${word}" to proceed, anything else to abort: `);
  return (await readLine(input)) === word;
}

/** The first line, trimmed. A stream that ends without one has said nothing at all. */
async function readLine(input: NodeJS.ReadableStream): Promise<string> {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) return line.trim();
    return '';
  } finally {
    rl.close();
  }
}
