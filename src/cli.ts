#!/usr/bin/env node
// tarmac — fleet observability for Claude Code.
//
// Two contractual surfaces, zero internal formats:
//   `claude agents --json`   → which sessions exist, busy or idle
//   statusLine payload       → context, model, effort, cost (via a chained wrapper)
//
// `install` / `uninstall` default to the home this process runs under, print what they are
// about to change, and proceed only on the typed verb (or `--yes`, in writing, for scripts).

import fs from 'node:fs';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from './args.ts';
import { collectFleet } from './collect.ts';
import type { Fleet } from './fleet.ts';
import { readConfigFile, resolveConfig } from './config.ts';
import { createFleetServer, listenFleetServer } from './server.ts';
import { install, uninstall, paths, planInstall, planUninstall, installedSnapshotsDir, wrapperIsOurs } from './install.ts';
import { confirmTyped } from './prompt.ts';
import { reapOrphanedTemps } from './reap.ts';
import { acquireJournalLock, createHistoryStore, historyDirFor } from './history-store.ts';
import { renderPlan, renderSettings, renderTable, restoreMeaning, servingLine } from './render.ts';
import { runWatch } from './watch.ts';

const USAGE = `tarmac — fleet observability for Claude Code

  tarmac list       [--home DIR] [--stale-after D] [--snapshots-dir DIR]
                    [--claude-bin PATH] [--json] [--watch]
        one-shot fleet table — with --watch, redrawn every 5s until ^C
  tarmac serve      [--home DIR] [--port N] [--stale-after D] [--snapshots-dir DIR]
                    [--claude-bin PATH] [--trust-host HOST] [--history-days N]
        local dashboard
  tarmac install    [--home DIR] [--yes]
        chain the statusline
  tarmac uninstall  [--home DIR] [--yes]
        restore the statusline exactly

  --help           print this text and exit — on any command
  --version, -v    print the version of this build and exit — on any command
  --watch          redraw the table every 5s until ^C, dating every reading
  --home           whose .claude to read or change (default: this home)
  --yes            skip the typed confirmation — required when stdin is not a terminal
  --stale-after    how old a reading may be before it is marked "!" — 90s, 15m, 2h
                   (default: 10m)
  --port           the dashboard's port (default: 4477 — a busy default walks up to the
                   next free port, a port named here refuses instead)
  --snapshots-dir  where the chained statusline drops its payloads
                   (default: $XDG_STATE_HOME/tarmac/snapshots, or
                   <home>/.local/state/tarmac/snapshots)
  --claude-bin     path to the claude CLI (default: claude)
  --trust-host     a Host the dashboard also answers to, besides loopback — repeat it
                   once per host (default: none). For a reverse proxy: give the name
                   your browser shows, without the port, and remember that whoever can
                   reach that name can read this fleet
  --history-days   keep a fleet journal for N days, in a directory beside the snapshots
                   (default: none, and nothing is written to disk). On \`serve\` only,
                   which is the command that samples: one JSON line a minute, no session
                   name and no working directory, about 2 MB a day at eight sessions,
                   and writing stops at 256 MB whatever N says

  Those five settings can also be set, in decreasing order of precedence, by the
  environment (TARMAC_STALE_AFTER, TARMAC_PORT, TARMAC_SNAPSHOTS_DIR, TARMAC_TRUST_HOST,
  TARMAC_HISTORY_DAYS) and by <home>/.claude/tarmac/config.json ({"staleAfterMs": …,
  "port": …, "snapshotsDir": …, "trustHosts": […], "history": {"days": …}}). \`serve\`
  prints which one won.
`;

/**
 * What this build calls itself, read from the `package.json` that ships beside it — the one
 * file npm puts in every tarball whatever `files` says, and the only place the number is
 * written down. `dist/cli.js` sits one directory in exactly as `src/cli.ts` does, so a single
 * relative path answers for the published CLI and for the suite, which runs the source.
 *
 * A version it could not read is not a version: rather than print an "unknown" nobody can act
 * on, this throws and leaves through the same catch as every other refusal here.
 */
function version(): string {
  const at = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(at, 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || pkg.version === '') throw new Error(`${at.href} carries no version`);
  return pkg.version;
}

try {
  // Parsing is inside the try so that a refusal — a typo'd flag, a duration nobody can read,
  // a config file with a key that does not exist — reaches the user as one line naming the
  // knob to turn, and never as a stack trace.
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === 'help') {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  // After `--help`, which answers the wider question, and before any command has begun: a
  // `tarmac install --version` that printed a plan and then waited for a typed word would be
  // a one-line question that hangs a script. Bare, so something other than a person can read it.
  if (args.version) {
    process.stdout.write(`${version()}\n`);
    process.exit(0);
  }

  if (args.command === 'install' || args.command === 'uninstall') {
    const home = args.home ?? os.homedir();
    // The plan is computed first and printed whole: every refusal this operation has in it
    // fires here, so the prompt never appears for something that was going to fail anyway.
    const plan = args.command === 'install' ? planInstall({ home }) : planUninstall({ home });
    process.stdout.write(renderPlan(plan));

    const confirmed = await confirmTyped({
      word: args.command,
      input: process.stdin,
      output: process.stdout,
      isTTY: Boolean(process.stdin.isTTY),
      yes: args.yes,
    });
    // One exit path for everything that refuses, so nothing can leave a half-written stream
    // behind on the way out.
    if (!confirmed) throw new Error('not confirmed — nothing was changed');

    if (plan.action === 'install') {
      const res = install({ home });
      console.log(
        res.alreadyInstalled
          ? `install: already installed — wrapper regenerated, settings.json left alone`
          : `install: statusLine wrapped — undo with \`${plan.undo}\``,
      );
      // What the plan promised, as it actually went: a frame of the OLD wrapper can land in
      // that directory between the two, so the count is reported rather than assumed.
      if (res.legacy !== null)
        console.log(
          `install: cleared ${res.legacy.payloads} runtime payload(s) from ${res.legacy.dir} — they belong in ${res.snapshots}` +
            (res.legacy.kept > 0 ? ` (${res.legacy.kept} file(s) kept, so the directory stays)` : ''),
        );
    } else {
      const { mode } = uninstall({ home });
      console.log(`uninstall: ${mode} — ${restoreMeaning(mode)}`);
    }
  } else {
    // Only the reading commands resolve settings, and only they read the config file: a
    // typo in it must not be what stands between a user and `tarmac uninstall`.
    const p = paths(args.home ?? os.homedir());
    // The installed wrapper's own path, when there is one: the default is where the WRITER
    // writes, not where a reader's environment would have put it. Recomputing it here made
    // `XDG_STATE_HOME` in one process and not the other a silent split.
    const frozen = installedSnapshotsDir(p);
    if (frozen === null && wrapperIsOurs(p))
      console.error(
        `tarmac: ${p.wrapper} is ours but does not say where it writes — falling back to ${p.snapshots}`,
      );
    const config = resolveConfig({
      flags: { staleAfter: args.staleAfter, port: args.port, snapshotsDir: args.snapshotsDir, trustHosts: args.trustHost, historyDays: args.historyDays },
      env: process.env,
      file: readConfigFile(p.config),
      // The installed wrapper's own path, when there is one: the default is where the
      // WRITER writes, not where a reader's environment would have put it. Recomputing it
      // here made `XDG_STATE_HOME` in one process and not the other a silent split.
      defaultSnapshotsDir: frozen ?? p.snapshots,
    });
    const snapshotsDir = config.snapshotsDir.value;
    const staleAfterMs = config.staleAfterMs.value;

    if (args.command === 'serve') {
      // Beside the snapshots, never among them: `reap.ts`, the wrapper's own sweep and the
      // legacy purge in `install.ts` all decide by name inside that directory.
      const historyDir = historyDirFor(snapshotsDir);
      // Unattended for hours, so it opens by saying what it decided and on whose authority.
      process.stdout.write(renderSettings(config, p.config, historyDir));

      // One journal, one owner (#133). The retention is a property of the DIRECTORY and the
      // process applying it was whichever `serve` started last, so a `--history-days 1` run to
      // try the setting out swept the thirty days another serve was keeping. A second serve
      // journals nothing now, and serves everything else exactly as it did.
      const days = config.historyDays.value;
      const { lock, heldBy } = days === null ? { lock: null, heldBy: null } : acquireJournalLock({ dir: historyDir });
      // On stdout, under the settings block it corrects: that block has just named a retention
      // and a directory, and a reader piping it must not be left holding the half of it that
      // did not happen. Same reason `serve` says on stdout which port it walked to.
      if (days !== null && lock === null) {
        const why = heldBy === null ? `could not take the journal lock in ${historyDir}` : `pid ${heldBy} holds the journal in ${historyDir}`;
        console.log(`tarmac: ${why}, so this serve keeps no journal`);
      }
      // Given back on the way out, signals included: Node's default for each of these ends the
      // process without running an exit hook, so a Ctrl-C would leave the lock behind and the
      // next serve would wait five minutes for its heartbeat to go quiet. SIGHUP is in the list
      // because closing the terminal, or losing the ssh session, is how a foreground serve
      // usually dies.
      //
      // Each handler releases and then re-raises, rather than exiting with a number: a serve
      // that answered a supervisor `exited 143` where every other serve answers `killed by
      // SIGTERM` would have made the journal visible to systemd and launchd, which know nothing
      // about it. Nothing about how this process ends may depend on a file in a directory.
      if (lock !== null) {
        process.on('exit', () => lock.release());
        for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
          // Removing THIS handler rather than every handler for the signal: the next hand to
          // register one here would otherwise be dropped by ours, in silence.
          const bye = (): void => {
            lock.release();
            process.off(signal, bye);
            process.kill(process.pid, signal);
          };
          process.on(signal, bye);
        }
      }

      // Temp files its own wrapper left behind when a terminal died mid-write. Best effort, and
      // it says what it did rather than doing it quietly, this being the user's directory. It
      // is no longer the only deletion a `serve` makes: a journal that was asked for applies
      // its retention on `listening`, and says that too. Nothing else here removes anything.
      const { reaped, failed } = reapOrphanedTemps(snapshotsDir);
      if (reaped > 0) console.log(`tarmac: reaped ${reaped} orphaned snapshot temp file(s)`);
      if (failed > 0) console.error(`tarmac: could not remove ${failed} orphaned temp file(s) under ${snapshotsDir}`);

      const server = createFleetServer({
        collect: () => collectFleet({ claudeBin: args.claudeBin, snapshotsDir, staleAfterMs, snapshotsDirSource: config.snapshotsDir.source, installed: frozen !== null }),
        trustedHosts: config.trustHosts.value,
        // No key anywhere is no store, which is no directory and no file: the default is that
        // nothing of this fleet is written down, and it is the default that is the product.
        // No lock is no store either, and for the same reason: no store, no sweep, no line.
        store: days === null || lock === null ? null : createHistoryStore({ dir: historyDir, days, lock }),
      });
      // A port nobody chose is not worth failing over: this walks past a busy 4477 and says
      // where it landed. A port that WAS chosen refuses instead, and the refusal leaves
      // through the same catch as every other one here — one line, naming the knob to turn.
      const bound = await listenFleetServer(server, { port: config.port.value, source: config.port.source });
      // Past `listen`, an error on this socket is not a port refusal and must not be printed
      // as one — nor reach the top as an unhandled event: `serve` runs unattended for hours.
      server.on('error', (e) => {
        console.error(`tarmac: the dashboard stopped listening — ${(e as Error).message}`);
        process.exit(1);
      });
      console.log(servingLine(bound));
    } else {
      const collect = (): Promise<Fleet> =>
        collectFleet({ claudeBin: args.claudeBin, snapshotsDir, staleAfterMs, snapshotsDirSource: config.snapshotsDir.source, installed: frozen !== null });

      if (args.watch) {
        // One redraws a screen, the other is meant to be piped once. Silently letting one win
        // is how someone ends up parsing a frame of terminal art.
        if (args.json) throw new Error('--watch and --json cannot be combined — a watch redraws a screen, --json prints once');

        const stop = new AbortController();
        // Ctrl-C leaves through the loop rather than through the window: the frame in flight
        // finishes, and the process exits 0 like every other reading command.
        //
        // The second one is not politeness, it is the promise every frame prints. Registering
        // a handler replaces Node's default terminate, and the loop only checks the flag
        // between awaits — so a Ctrl-C during a slow `claude agents --json` was swallowed, and
        // so was the next one, for as long as the read took. A watch that prints "^C to quit"
        // has to be leavable with ^C.
        process.on('SIGINT', () => {
          if (stop.signal.aborted) process.exit(130);
          stop.abort();
        });
        await runWatch({
          collect,
          write: (frame) => process.stdout.write(frame),
          // The abort lands DURING the wait, which is the whole point of the wait — so it
          // resolves rather than rejecting, and the loop's own check is what ends it.
          sleep: (ms) => sleep(ms, undefined, { signal: stop.signal }).then(() => {}, () => {}),
          now: () => Date.now(),
          isTTY: Boolean(process.stdout.isTTY),
          signal: stop.signal,
        });
      } else {
        const fleet = await collect();
        process.stdout.write(args.json ? JSON.stringify(fleet, null, 2) + '\n' : renderTable(fleet));
      }
    }
  }
} catch (e) {
  console.error(`tarmac: ${(e as Error).message}`);
  process.exit(1);
}
