// Finding the locale under which a bracket RANGE is actually wider than ASCII, which is the
// premise of every collation test in this suite. Not a `*.test.ts`, so the runner's glob
// leaves it alone — the same arrangement as `fleet-fixtures.ts`.
//
// This exists because the obvious version of it is wrong. A list of plausible names —
// `['en_US.UTF-8', 'C.UTF-8', …]`, first match wins — hands back `C.UTF-8` on a machine
// that has it and not the other, and `C.UTF-8` collates by CODE POINT: it is UTF-8, it is
// installed, and it cannot pose the question. The guard then runs, asserts, and passes with
// the whole bug present. So the property is MEASURED rather than assumed from a name, and
// measured through the same shell the assertion will use — `a-f` reaching `é` is a fact
// about one libc, one locale and one shell together, not about any of them alone.

import { spawnSync } from 'node:child_process';

/** Every locale installed here — `locale -a` on both macOS and Linux. */
function installed(): string[] {
  const r = spawnSync('locale', ['-a'], { encoding: 'utf8' });
  if (r.error || typeof r.stdout !== 'string') return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * The first installed locale under which `cmd` really does read `[a-f]` as reaching past
 * ASCII, or `undefined` if this machine cannot build the case at all.
 *
 * `é` rather than a hex digit: the question is only ever about what the range picks up
 * BEYOND the sixteen characters the rule enumerates.
 */
export function wideningLocale(cmd: string, prefix: string[] = []): string | undefined {
  for (const locale of installed()) {
    const r = spawnSync(cmd, [...prefix, '-c', 'case "é" in [a-f]) exit 0 ;; esac ; exit 1'], {
      env: { ...process.env, LC_ALL: locale },
      encoding: 'utf8',
    });
    if (!r.error && r.status === 0) return locale;
  }
  return undefined;
}
