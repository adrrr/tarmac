#!/usr/bin/env node
// tarmac — fleet observability for Claude Code.
//
// Two contractual surfaces, zero internal formats:
//   `claude agents --json`   → which sessions exist, busy or idle
//   statusLine payload       → context, model, effort, cost (via a chained wrapper)
//
// `install` / `uninstall` default to the home this process runs under, print what they are
// about to change, and proceed only on the typed verb (or `--yes`, in writing, for scripts).

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
import { renderPlan, renderSettings, renderTable, restoreMeaning, servingLine } from './render.ts';
import { runWatch } from './watch.ts';

const USAGE = `tarmac — fleet observability for Claude Code

  tarmac list       [--home DIR] [--stale-after D] [--snapshots-dir DIR]
                    [--claude-bin PATH] [--json] [--watch]
        one-shot fleet table — with --watch, redrawn every 5s until ^C
  tarmac serve      [--home DIR] [--port N] [--stale-after D] [--snapshots-dir DIR]
                    [--claude-bin PATH]
        local dashboard
  tarmac install    [--home DIR] [--yes]
        chain the statusline
  tarmac uninstall  [--home DIR] [--yes]
        restore the statusline exactly

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

  Those three settings can also be set, in decreasing order of precedence, by the
  environment (TARMAC_STALE_AFTER, TARMAC_PORT, TARMAC_SNAPSHOTS_DIR) and by
  <home>/.claude/tarmac/config.json ({"staleAfterMs": …, "port": …, "snapshotsDir": …}).
  \`serve\` prints which one won.
`;

try {
  // Parsing is inside the try so that a refusal — a typo'd flag, a duration nobody can read,
  // a config file with a key that does not exist — reaches the user as one line naming the
  // knob to turn, and never as a stack trace.
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === 'help') {
    process.stdout.write(USAGE);
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
      flags: { staleAfter: args.staleAfter, port: args.port, snapshotsDir: args.snapshotsDir },
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
      // Unattended for hours, so it opens by saying what it decided and on whose authority.
      process.stdout.write(renderSettings(config, p.config));

      // The one place the CLI deletes anything: temp files its own wrapper left behind when a
      // terminal died mid-write. Best effort, and it says what it did rather than doing it
      // quietly — this is the user's directory.
      const { reaped, failed } = reapOrphanedTemps(snapshotsDir);
      if (reaped > 0) console.log(`tarmac: reaped ${reaped} orphaned snapshot temp file(s)`);
      if (failed > 0) console.error(`tarmac: could not remove ${failed} orphaned temp file(s) under ${snapshotsDir}`);

      const server = createFleetServer({
        collect: () => collectFleet({ claudeBin: args.claudeBin, snapshotsDir, staleAfterMs, snapshotsDirSource: config.snapshotsDir.source, installed: frozen !== null }),
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
