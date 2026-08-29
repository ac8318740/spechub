import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { Command } from 'commander';
import { register } from './handoff.js';

// ---------------------------------------------------------------------------
// The CLI wrapper. Every decision lives in lib/, so these tests only check
// that the flags exist, that they reach the library, and that `ack` writes the
// sidecar and prints what it wrote.
// ---------------------------------------------------------------------------

let dir: string;
let handoffFile: string;
let originalSessionId: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spechub-handoff-cli-'));
  handoffFile = join(dir, 'handoff-2026-08-23.md');
  writeFileSync(handoffFile, '# Handoff\n');
  originalSessionId = process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  if (originalSessionId === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = originalSessionId;
});

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  register(program);
  return program;
}

function subcommand(name: string): Command {
  const handoff = buildProgram().commands.find(c => c.name() === 'handoff');
  expect(handoff, 'handoff command is registered').toBeDefined();
  const cmd = (handoff as Command).commands.find(c => c.name() === name);
  expect(cmd, `handoff ${name} is registered`).toBeDefined();
  return cmd as Command;
}

function longFlags(cmd: Command): string[] {
  return cmd.options.map(o => o.long).filter((l): l is string => typeof l === 'string');
}

/** Run the CLI as a user would type it, capturing what it printed. */
async function run(...argv: string[]): Promise<string> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await buildProgram().parseAsync(argv, { from: 'user' });
  return log.mock.calls.map(call => String(call[0])).join('\n');
}

/** Run a CLI invocation that must be refused, and return everything it complained. */
async function runFailing(...argv: string[]): Promise<string> {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(a => String(a)).join(' '));
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit');
  });
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: str => {
      errors.push(str);
    },
  });
  register(program);
  await expect(program.parseAsync(argv, { from: 'user' })).rejects.toThrow();
  return errors.join('\n');
}

function readSidecar(): Record<string, unknown> {
  return JSON.parse(readFileSync(handoffFile + '.ack', 'utf-8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// handoff watch — the new flags
// ---------------------------------------------------------------------------

describe('handoff watch flags', () => {
  it('accepts --file, so the watcher can see the ack sidecar', () => {
    expect(longFlags(subcommand('watch'))).toContain('--file');
  });

  it('accepts --nudged, so the caller can say this target was already prodded', () => {
    expect(longFlags(subcommand('watch'))).toContain('--nudged');
  });

  it('keeps the flags it already had', () => {
    const flags = longFlags(subcommand('watch'));
    for (const flag of ['--transcript', '--session-id', '--cwd', '--token', '--fresh', '--turns']) {
      expect(flags).toContain(flag);
    }
  });

  it('takes a path argument for --file rather than treating it as a boolean', () => {
    const option = subcommand('watch').options.find(o => o.long === '--file');
    expect(option?.required || option?.optional).toBe(true);
  });

  it('treats --nudged as a boolean flag, defaulting to false', () => {
    const option = subcommand('watch').options.find(o => o.long === '--nudged');
    expect(option?.required).toBe(false);
    expect(option?.optional).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handoff ack
// ---------------------------------------------------------------------------

describe('handoff ack', () => {
  it('is registered as a subcommand of handoff', () => {
    expect(subcommand('ack').name()).toBe('ack');
  });

  it('accepts --file', () => {
    expect(longFlags(subcommand('ack'))).toContain('--file');
  });

  it('writes the sidecar next to the handoff file', async () => {
    await run('handoff', 'ack', 'accept', '--file', handoffFile, 'taking', 'this', 'on');
    expect(existsSync(handoffFile + '.ack')).toBe(true);
    expect(readSidecar().decision).toBe('accept');
  });

  it('joins the trailing words into a single reason', async () => {
    await run('handoff', 'ack', 'accept', '--file', handoffFile, 'taking', 'this', 'on');
    expect(readSidecar().reason).toBe('taking this on');
  });

  it('records a decline with its reason', async () => {
    await run('handoff', 'ack', 'decline', '--file', handoffFile, 'I', 'own', 'conflicting', 'files');
    expect(readSidecar().decision).toBe('decline');
    expect(readSidecar().reason).toBe('I own conflicting files');
  });

  it('accepts a decision with no reason at all', async () => {
    await run('handoff', 'ack', 'accept', '--file', handoffFile);
    expect(readSidecar().decision).toBe('accept');
    expect(readSidecar().reason).toBe('');
  });

  it('lowercases an uppercase decision', async () => {
    await run('handoff', 'ack', 'ACCEPT', '--file', handoffFile, 'shouty');
    expect(readSidecar().decision).toBe('accept');
  });

  it('prints the written record as JSON on stdout', async () => {
    const output = await run('handoff', 'ack', 'accept', '--file', handoffFile, 'on', 'it');
    const printed = JSON.parse(output) as Record<string, unknown>;
    expect(printed.decision).toBe('accept');
    expect(printed.reason).toBe('on it');
    expect(typeof printed.at).toBe('string');
  });

  it('prints what it actually wrote to disk', async () => {
    const output = await run('handoff', 'ack', 'decline', '--file', handoffFile, 'busy');
    expect(JSON.parse(output)).toEqual(readSidecar());
  });

  it('picks up the session id from CLAUDE_SESSION_ID', async () => {
    process.env.CLAUDE_SESSION_ID = 'sess-from-env';
    await run('handoff', 'ack', 'accept', '--file', handoffFile, 'ok');
    expect(readSidecar().sessionId).toBe('sess-from-env');
  });

  it('refuses a decision that is neither accept nor decline, saying what it wanted', async () => {
    const errors = await runFailing('handoff', 'ack', 'maybe', '--file', handoffFile);
    expect(errors).toMatch(/accept|decline/i);
    expect(existsSync(handoffFile + '.ack')).toBe(false);
  });

  it('refuses to run without --file, saying so', async () => {
    const errors = await runFailing('handoff', 'ack', 'accept');
    expect(errors).toMatch(/file/i);
  });

  it('refuses when the handoff file does not exist, naming the path', async () => {
    const missing = join(dir, 'no-such-handoff.md');
    const errors = await runFailing('handoff', 'ack', 'accept', '--file', missing);
    expect(errors).toContain(missing);
    expect(existsSync(missing + '.ack')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Relative paths
//
// The two commands sit on opposite sides of the handoff and are typed in
// different places. `ack` is typed by the receiver, in the directory it is
// working in, so a relative path is the natural thing to write and resolving
// it is a kindness. `watch` is run by the sender against another session's
// world, where "relative to here" means nothing — so it insists on absolute,
// exactly as --cwd already does.
// ---------------------------------------------------------------------------

describe('handoff ack — relative paths', () => {
  it('resolves a relative --file against the working directory', async () => {
    const rel = relative(process.cwd(), handoffFile);
    expect(isAbsolute(rel)).toBe(false);
    await run('handoff', 'ack', 'accept', '--file', rel, 'ok');
    expect(existsSync(resolve(process.cwd(), rel) + '.ack')).toBe(true);
  });

  it('lands the sidecar next to the real handoff file, not next to the relative path', async () => {
    const rel = relative(process.cwd(), handoffFile);
    await run('handoff', 'ack', 'accept', '--file', rel, 'ok');
    expect(existsSync(handoffFile + '.ack')).toBe(true);
    expect(readSidecar().decision).toBe('accept');
  });

  it('still accepts an absolute --file', async () => {
    await run('handoff', 'ack', 'accept', '--file', handoffFile, 'ok');
    expect(existsSync(handoffFile + '.ack')).toBe(true);
  });
});

describe('handoff watch — --file must be absolute', () => {
  it('refuses a relative --file', async () => {
    const errors = await runFailing(
      'handoff',
      'watch',
      '--transcript',
      join(dir, 'session.jsonl'),
      '--fresh',
      '--file',
      'relative-handoff.md',
      '--turns',
      '1',
      '--timeout',
      '50'
    );
    expect(errors).toMatch(/absolute/i);
  });

  it('names the flag it is complaining about', async () => {
    const errors = await runFailing(
      'handoff',
      'watch',
      '--transcript',
      join(dir, 'session.jsonl'),
      '--fresh',
      '--file',
      'relative-handoff.md',
      '--turns',
      '1',
      '--timeout',
      '50'
    );
    expect(errors).toContain('--file');
  });

  it('accepts an absolute --file', async () => {
    // Nothing to watch, so it times out — the point is that it got that far.
    const output = await run(
      'handoff',
      'watch',
      '--transcript',
      join(dir, 'session.jsonl'),
      '--fresh',
      '--file',
      handoffFile,
      '--turns',
      '1',
      '--poll-interval',
      '10',
      '--timeout',
      '60'
    );
    expect(JSON.parse(output)).toMatchObject({ outcome: 'timeout' });
  });
});

// ---------------------------------------------------------------------------
// --ack-after and startedAt
//
// A nudge means stopping one watch and starting another. The receiver may
// write its ack in the gap, where no watch is looking. `startedAt` on the
// first result and `--ack-after` on the second close that gap: the restarted
// watch accepts anything stamped from the first one's start onward.
// ---------------------------------------------------------------------------

/** Write a sidecar next to the handoff file, stamped as given. */
function writeSidecarAt(at: number, reason = 'picked it up'): void {
  writeFileSync(
    handoffFile + '.ack',
    JSON.stringify({ decision: 'accept', reason, sessionId: null, at: new Date(at).toISOString() })
  );
}

/** A watch that has nothing to read, so only the sidecar can decide it. */
function watchArgs(...extra: string[]): string[] {
  return [
    'handoff',
    'watch',
    '--transcript',
    join(dir, 'session.jsonl'),
    '--fresh',
    '--file',
    handoffFile,
    '--turns',
    '5',
    '--poll-interval',
    '10',
    '--timeout',
    '80',
    ...extra,
  ];
}

describe('handoff watch — startedAt in the printed result', () => {
  it('prints startedAt as a number', async () => {
    const before = Date.now();
    const output = await run(...watchArgs());
    const printed = JSON.parse(output) as Record<string, unknown>;
    expect(typeof printed.startedAt).toBe('number');
    expect(printed.startedAt as number).toBeGreaterThanOrEqual(before);
  });
});

describe('handoff watch — --ack-after', () => {
  it('is a flag on watch', () => {
    expect(longFlags(subcommand('watch'))).toContain('--ack-after');
  });

  it('takes a value rather than acting as a boolean', () => {
    const option = subcommand('watch').options.find(o => o.long === '--ack-after');
    expect(option?.required || option?.optional).toBe(true);
  });

  it('accepts a sidecar written before the watch began but after the given time', async () => {
    const wroteAckAt = Date.now() - 60_000;
    writeSidecarAt(wroteAckAt, 'wrote it during the gap');
    const output = await run(...watchArgs('--ack-after', String(wroteAckAt - 1000)));
    const printed = JSON.parse(output) as Record<string, unknown>;
    expect(printed.outcome).toBe('acknowledged');
    expect(printed.ack).toMatchObject({ via: 'cli', message: 'wrote it during the gap' });
  });

  it('ignores that same sidecar without the flag, because this transcript never began', async () => {
    // watchArgs watches a transcript that does not exist, so --fresh has no
    // launch to date the round by and nothing on disk can answer it.
    writeSidecarAt(Date.now() - 60_000, 'wrote it during the gap');
    const output = await run(...watchArgs());
    expect(JSON.parse(output)).toMatchObject({ outcome: 'timeout' });
  });

  it('reports the discarded sidecar as staleAck rather than dropping it', async () => {
    writeSidecarAt(Date.now() - 60_000, 'wrote it during the gap');
    const output = await run(...watchArgs());
    const printed = JSON.parse(output) as Record<string, unknown>;
    expect(printed.outcome).toBe('timeout');
    expect(printed.staleAck).toMatchObject({ via: 'cli', reason: 'wrote it during the gap' });
  });
});

// ---------------------------------------------------------------------------
// --fresh dates the round by the launch
//
// The sender cannot start watching until it has recovered the new session id,
// and the target is told to acknowledge before doing anything else. So the ack
// lands before the watch on the documented path, and the cut-off has to reach
// back to the launch to see it.
// ---------------------------------------------------------------------------

describe('handoff watch — --fresh anchors the cut-off at the launch', () => {
  /** Write a transcript whose only record is stamped at the given instant. */
  function writeTranscriptStartedAt(at: number): void {
    writeFileSync(
      join(dir, 'session.jsonl'),
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(at).toISOString(),
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
      }) + '\n'
    );
  }

  it('reports acknowledged for an ack written well before the watch started', async () => {
    const launchedAt = Date.now() - 60_000;
    writeTranscriptStartedAt(launchedAt);
    writeSidecarAt(launchedAt + 3_000, 'acked before the sender could watch');
    const output = await run(...watchArgs());
    const printed = JSON.parse(output) as Record<string, unknown>;
    expect(printed.outcome).toBe('acknowledged');
    expect(printed.ack).toMatchObject({ via: 'cli', reason: 'acked before the sender could watch' });
  });

  it('prints the cut-off it applied as ackAfter', async () => {
    const launchedAt = Date.now() - 60_000;
    writeTranscriptStartedAt(launchedAt);
    const output = await run(...watchArgs());
    expect(JSON.parse(output)).toMatchObject({ ackAfter: launchedAt });
  });

  it('still ignores a sidecar written before the launch', async () => {
    const launchedAt = Date.now() - 60_000;
    writeTranscriptStartedAt(launchedAt);
    writeSidecarAt(launchedAt - 60_000, 'the previous target declined');
    const output = await run(...watchArgs());
    const printed = JSON.parse(output) as Record<string, unknown>;
    expect(printed.outcome).not.toBe('acknowledged');
    expect(printed.ack).toBeUndefined();
    expect(printed.staleAck).toMatchObject({ reason: 'the previous target declined' });
  });

  it('treats 0 as "any ack, however old"', async () => {
    writeSidecarAt(Date.now() - 24 * 60 * 60 * 1000, 'from yesterday');
    const output = await run(...watchArgs('--ack-after', '0'));
    expect(JSON.parse(output)).toMatchObject({ outcome: 'acknowledged' });
  });

  it('still ignores a sidecar older than the time it was given', async () => {
    const wroteAckAt = Date.now() - 60_000;
    writeSidecarAt(wroteAckAt);
    const output = await run(...watchArgs('--ack-after', String(wroteAckAt + 1000)));
    expect(JSON.parse(output)).toMatchObject({ outcome: 'timeout' });
  });

  it('refuses a value that is not a number', async () => {
    const errors = await runFailing(...watchArgs('--ack-after', 'yesterday'));
    expect(errors).toMatch(/integer/i);
    expect(errors).toMatch(/ack.?after/i);
  });

  it('refuses a negative value', async () => {
    const errors = await runFailing(...watchArgs('--ack-after', '-1'));
    expect(errors).toMatch(/integer/i);
    expect(errors).toMatch(/ack.?after/i);
  });

  it('refuses a fractional value', async () => {
    const errors = await runFailing(...watchArgs('--ack-after', '1.5'));
    expect(errors).toMatch(/integer/i);
    expect(errors).toMatch(/ack.?after/i);
  });
});
