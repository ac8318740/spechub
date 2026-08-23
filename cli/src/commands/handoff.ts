// Handoff-side commands, one for each end of a handoff. `handoff watch` is the
// sender's: it observes the target and reports whether the handoff was picked
// up. `handoff ack` is the target's: it writes the acknowledgement the watcher
// is waiting for.
//
// A thin wrapper: every decision lives in lib/ackwatch.ts and lib/ackfile.ts.
// This file only resolves paths, validates flag combinations, and prints.
import { Command } from 'commander';
import { isAbsolute, resolve } from 'node:path';
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TURNS,
  transcriptPath,
  watch,
} from '../lib/ackwatch.js';
import { writeAck } from '../lib/ackfile.js';
import { fail } from '../lib/utils.js';

/**
 * Parse a count flag, rejecting anything that is not a whole number at or above
 * `min`. The floor matters: a zero or blank `--turns` would make the watch
 * report silence on its first tick, before the target could possibly reply.
 */
function parseIntAtLeast(name: string, min: number) {
  return (value: string): number => {
    const parsed = value.trim() === '' ? NaN : Number(value);
    if (!Number.isInteger(parsed) || parsed < min) {
      fail(`Invalid ${name} '${value}'. Expected an integer >= ${min}.`);
    }
    return parsed;
  };
}

interface WatchOpts {
  transcript?: string;
  sessionId?: string;
  cwd?: string;
  token?: string;
  fresh?: boolean;
  file?: string;
  nudged?: boolean;
  ackAfter?: number;
  turns: number;
  pollInterval: number;
  timeout: number;
}

function resolveTranscript(opts: WatchOpts): string {
  const hasDirect = typeof opts.transcript === 'string';
  const hasDerived = typeof opts.sessionId === 'string' || typeof opts.cwd === 'string';
  if (hasDirect && hasDerived) {
    fail('Use --transcript, or --session-id with --cwd, not both.');
  }
  if (hasDirect) {
    const transcript = opts.transcript as string;
    if (transcript.length === 0) {
      fail('--transcript needs a path to the target session transcript (.jsonl).');
    }
    return transcript;
  }
  if (!opts.sessionId || !opts.cwd) {
    fail('Pass --transcript, or both --session-id and --cwd.');
  }
  // The directory name is derived by munging the working directory, so a
  // relative path silently derives the wrong transcript rather than failing.
  if (!isAbsolute(opts.cwd)) {
    fail(`--cwd must be an absolute path, got '${opts.cwd}'.`);
  }
  return transcriptPath(opts.cwd, opts.sessionId);
}

export function register(program: Command): void {
  const handoffCmd = program.command('handoff').description('Hand work to another agent session');

  handoffCmd
    .command('watch')
    .description(
      "Watch a handoff target's transcript and report whether it acknowledged the " +
        'handoff, went silent for N turns, or timed out'
    )
    .option('--transcript <path>', 'path to the target session transcript (.jsonl)')
    .option('--session-id <id>', 'target session id, to derive the transcript path (needs --cwd)')
    .option('--cwd <dir>', 'absolute working directory of the target session (needs --session-id)')
    .option('--token <token>', 'correlation token in the delivered message; anchors on its delivery')
    .option('--fresh', 'target was launched for this handoff; anchor at the transcript start')
    .option(
      '--file <path>',
      'path to the handoff file; its .ack sidecar counts as an acknowledgement, ' +
        'and tool calls naming it count as engagement'
    )
    .option('--nudged', 'this target has already been nudged once; echoed back on the result')
    .option(
      '--ack-after <ms>',
      'epoch milliseconds before which a sidecar ack does not count; pass the ' +
        'previous watch\'s startedAt to cover a nudge gap, or 0 to accept any ack. ' +
        'Defaults to the moment this watch begins',
      parseIntAtLeast('ack-after', 0)
    )
    .option(
      '--turns <n>',
      'turn boundaries to allow before reporting silence',
      parseIntAtLeast('turns', 1),
      DEFAULT_TURNS
    )
    .option(
      '--poll-interval <ms>',
      'milliseconds between re-reads of the transcript',
      parseIntAtLeast('poll interval', 1),
      DEFAULT_POLL_INTERVAL_MS
    )
    .option(
      '--timeout <ms>',
      'milliseconds before giving up',
      parseIntAtLeast('timeout', 1),
      DEFAULT_TIMEOUT_MS
    )
    .action(async (opts: WatchOpts) => {
      // `requireOneMode` in lib/ackwatch.ts is the canonical rule; this repeats
      // it only to print a red error instead of a stack trace. Change both together.
      const hasToken = typeof opts.token === 'string' && opts.token.length > 0;
      if (hasToken === Boolean(opts.fresh)) {
        fail('Pass exactly one of --token or --fresh.');
      }
      // The sender types this against another session's world, where "relative
      // to here" names a different file – or none. Same rule as --cwd.
      if (typeof opts.file === 'string' && !isAbsolute(opts.file)) {
        fail(`--file must be an absolute path, got '${opts.file}'.`);
      }
      const path = resolveTranscript(opts);
      try {
        const result = await watch(path, {
          token: opts.token,
          fresh: opts.fresh,
          file: opts.file,
          nudged: opts.nudged,
          ackAfter: opts.ackAfter,
          turns: opts.turns,
          pollIntervalMs: opts.pollInterval,
          timeoutMs: opts.timeout,
        });
        console.log(JSON.stringify({ transcript: path, ...result }, null, 2));
      } catch (err) {
        fail((err as Error).message);
      }
    });

  handoffCmd
    .command('ack')
    .description(
      'Acknowledge a handoff: write accept or decline, with a reason, to the ' +
        'sidecar beside the handoff file. Run this before any other work.'
    )
    .argument('<decision>', 'accept or decline')
    .argument('[reason...]', 'why – free text, joined into one line')
    .requiredOption('--file <path>', 'path to the handoff file being acknowledged')
    .action((decision: string, reason: string[], opts: { file: string }) => {
      try {
        const record = writeAck({
          // The receiver types this in the directory it is working in, so a
          // relative path is the natural thing to write. Resolving it here is
          // what puts the sidecar beside the real handoff file.
          file: resolve(opts.file),
          decision,
          reason: reason.join(' '),
        });
        // Print what landed on disk, so the target sees its own answer rather
        // than a "done" it has to take on trust.
        console.log(JSON.stringify(record, null, 2));
      } catch (err) {
        fail((err as Error).message);
      }
    });
}
