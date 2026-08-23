import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { basename } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAck, readAck, ackPath, ACK_DECISIONS, isAckDecision } from './ackfile.js';

// ---------------------------------------------------------------------------
// The ack sidecar: a handoff target says accept or decline by writing a file
// next to the handoff, at exactly <handoff-path>.ack. The watcher on the other
// side polls for that path, so the naming is a contract, not a detail.
// ---------------------------------------------------------------------------

type WriteAckArgs = Parameters<typeof writeAck>[0];

/** Cast for the malformed-input cases — the point is what happens at runtime. */
function badArgs(args: Record<string, unknown>): WriteAckArgs {
  return args as unknown as WriteAckArgs;
}

let dir: string;
let handoffFile: string;
let sidecar: string;
let originalSessionId: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spechub-ackfile-'));
  handoffFile = join(dir, 'handoff-2026-08-23.md');
  sidecar = handoffFile + '.ack';
  writeFileSync(handoffFile, '# Handoff\n\nPick this up.\n');
  originalSessionId = process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalSessionId === undefined) delete process.env.CLAUDE_SESSION_ID;
  else process.env.CLAUDE_SESSION_ID = originalSessionId;
});

function readSidecar(path = sidecar): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// writeAck — where the file lands and what it holds
// ---------------------------------------------------------------------------

describe('writeAck — sidecar location', () => {
  it('writes the sidecar at exactly the handoff path plus .ack', () => {
    writeAck({ file: handoffFile, decision: 'accept', reason: 'taking this on' });
    expect(existsSync(sidecar)).toBe(true);
  });

  it('leaves the handoff file itself untouched', () => {
    const before = readFileSync(handoffFile, 'utf-8');
    writeAck({ file: handoffFile, decision: 'decline', reason: 'wrong worktree' });
    expect(readFileSync(handoffFile, 'utf-8')).toBe(before);
  });

  it('appends .ack rather than replacing the handoff file extension', () => {
    writeAck({ file: handoffFile, decision: 'accept', reason: '' });
    // handoff-2026-08-23.ack would be the wrong path — the watcher polls
    // <file>.ack and would never see it.
    expect(existsSync(join(dir, 'handoff-2026-08-23.ack'))).toBe(false);
    expect(existsSync(handoffFile + '.ack')).toBe(true);
  });
});

describe('writeAck — sidecar contents', () => {
  it('records the decision, reason, sessionId and timestamp as JSON', () => {
    writeAck({
      file: handoffFile,
      decision: 'accept',
      reason: 'taking this on',
      sessionId: 'sess-123',
    });
    const record = readSidecar();
    expect(record.decision).toBe('accept');
    expect(record.reason).toBe('taking this on');
    expect(record.sessionId).toBe('sess-123');
    expect(typeof record.at).toBe('string');
  });

  it('stamps at as an ISO 8601 timestamp', () => {
    writeAck({ file: handoffFile, decision: 'accept', reason: '' });
    const at = readSidecar().at as string;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(at).toISOString()).toBe(at);
  });

  it('stores a decline decision', () => {
    writeAck({ file: handoffFile, decision: 'decline', reason: 'I own conflicting files' });
    const record = readSidecar();
    expect(record.decision).toBe('decline');
    expect(record.reason).toBe('I own conflicting files');
  });

  it('accepts an empty reason and stores it as an empty string', () => {
    writeAck({ file: handoffFile, decision: 'accept', reason: '' });
    expect(readSidecar().reason).toBe('');
  });

  it('stores an omitted reason as an empty string, never undefined or missing', () => {
    writeAck(badArgs({ file: handoffFile, decision: 'accept' }));
    expect(readSidecar().reason).toBe('');
  });

  it('overwrites an existing sidecar rather than appending to it', () => {
    writeAck({ file: handoffFile, decision: 'accept', reason: 'first' });
    writeAck({ file: handoffFile, decision: 'decline', reason: 'changed my mind' });
    const record = readSidecar();
    expect(record.decision).toBe('decline');
    expect(record.reason).toBe('changed my mind');
  });
});

describe('writeAck — decision normalisation', () => {
  it('lowercases an uppercase decision', () => {
    writeAck(badArgs({ file: handoffFile, decision: 'ACCEPT', reason: 'shouty' }));
    expect(readSidecar().decision).toBe('accept');
  });

  it('lowercases a mixed-case decision', () => {
    writeAck(badArgs({ file: handoffFile, decision: 'Decline', reason: 'nope' }));
    expect(readSidecar().decision).toBe('decline');
  });

  it('rejects a decision that is neither accept nor decline', () => {
    expect(() => writeAck(badArgs({ file: handoffFile, decision: 'maybe', reason: '' }))).toThrow();
    expect(existsSync(sidecar)).toBe(false);
  });

  it('names both decisions it will take in the refusal', () => {
    // The words come from ACK_DECISIONS, so the message can never drift from
    // the values the code actually accepts.
    expect(() =>
      writeAck(badArgs({ file: handoffFile, decision: 'maybe', reason: '' }))
    ).toThrow(/accept/i);
    expect(() =>
      writeAck(badArgs({ file: handoffFile, decision: 'maybe', reason: '' }))
    ).toThrow(/decline/i);
  });

  it('rejects an empty decision', () => {
    expect(() => writeAck(badArgs({ file: handoffFile, decision: '', reason: '' }))).toThrow();
  });

  it('rejects a missing decision', () => {
    expect(() => writeAck(badArgs({ file: handoffFile, reason: '' }))).toThrow();
  });

  it('does not treat a leading-keyword sentence as a decision', () => {
    expect(() =>
      writeAck(badArgs({ file: handoffFile, decision: 'accept this', reason: '' }))
    ).toThrow();
  });
});

describe('writeAck — file validation', () => {
  it('rejects a missing file option', () => {
    expect(() => writeAck(badArgs({ decision: 'accept', reason: '' }))).toThrow();
  });

  it('rejects an empty file option', () => {
    expect(() => writeAck(badArgs({ file: '', decision: 'accept', reason: '' }))).toThrow();
  });

  it('refuses to write when the handoff file does not exist', () => {
    const missing = join(dir, 'no-such-handoff.md');
    expect(() => writeAck({ file: missing, decision: 'accept', reason: '' })).toThrow();
    expect(existsSync(missing + '.ack')).toBe(false);
  });

  it('names the missing path in the error, so the caller can see the typo', () => {
    const missing = join(dir, 'no-such-handoff.md');
    expect(() => writeAck({ file: missing, decision: 'accept', reason: '' })).toThrow(missing);
  });
});

describe('writeAck — session id', () => {
  it('uses the sessionId option when given', () => {
    process.env.CLAUDE_SESSION_ID = 'from-env';
    writeAck({ file: handoffFile, decision: 'accept', reason: '', sessionId: 'from-option' });
    expect(readSidecar().sessionId).toBe('from-option');
  });

  it('falls back to CLAUDE_SESSION_ID when no sessionId option is given', () => {
    process.env.CLAUDE_SESSION_ID = 'sess-from-env';
    writeAck({ file: handoffFile, decision: 'accept', reason: '' });
    expect(readSidecar().sessionId).toBe('sess-from-env');
  });

  it('records null when neither the option nor the environment supplies one', () => {
    writeAck({ file: handoffFile, decision: 'accept', reason: '' });
    expect(readSidecar().sessionId).toBeNull();
  });

  it('records null rather than an empty string when CLAUDE_SESSION_ID is blank', () => {
    process.env.CLAUDE_SESSION_ID = '';
    writeAck({ file: handoffFile, decision: 'accept', reason: '' });
    expect(readSidecar().sessionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readAck — the other half of the contract
// ---------------------------------------------------------------------------

describe('readAck', () => {
  it('reads back what writeAck wrote', () => {
    writeAck({
      file: handoffFile,
      decision: 'decline',
      reason: 'already own conflicting files',
      sessionId: 'sess-9',
    });
    const record = readAck(handoffFile);
    expect(record).not.toBeNull();
    expect(record?.decision).toBe('decline');
    expect(record?.reason).toBe('already own conflicting files');
    expect(record?.sessionId).toBe('sess-9');
    expect(typeof record?.at).toBe('string');
  });

  it('takes the handoff path, not the sidecar path', () => {
    writeAck({ file: handoffFile, decision: 'accept', reason: 'ok' });
    expect(readAck(handoffFile)?.decision).toBe('accept');
  });

  it('returns null when no sidecar exists', () => {
    expect(readAck(handoffFile)).toBeNull();
  });

  it('returns null when the handoff file itself does not exist', () => {
    expect(readAck(join(dir, 'nothing-here.md'))).toBeNull();
  });

  it('returns null for a sidecar holding malformed JSON', () => {
    writeFileSync(sidecar, '{not json at all');
    expect(readAck(handoffFile)).toBeNull();
  });

  it('returns null for a sidecar holding JSON that is not an object', () => {
    writeFileSync(sidecar, '"just a string"');
    expect(readAck(handoffFile)).toBeNull();
  });

  it('returns null for an empty sidecar', () => {
    writeFileSync(sidecar, '');
    expect(readAck(handoffFile)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The decision vocabulary
//
// One list, in one place. The type, the guard and the error text all derive
// from it, so a third decision could never be half-added.
// ---------------------------------------------------------------------------

describe('ACK_DECISIONS', () => {
  it('is exactly accept and decline, in that order', () => {
    expect([...ACK_DECISIONS]).toEqual(['accept', 'decline']);
  });

  it('recognises each of its own members', () => {
    for (const decision of ACK_DECISIONS) {
      expect(isAckDecision(decision)).toBe(true);
    }
  });

  it('rejects anything that is not one of them', () => {
    expect(isAckDecision('maybe')).toBe(false);
    expect(isAckDecision('accept this')).toBe(false);
    expect(isAckDecision('')).toBe(false);
    expect(isAckDecision(null)).toBe(false);
    expect(isAckDecision(undefined)).toBe(false);
    expect(isAckDecision(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The path the caller passes
// ---------------------------------------------------------------------------

describe('writeAck — the handoff path, not the sidecar path', () => {
  // The sidecar exists in each of these, so "that file is not there" cannot be
  // the reason it refuses — the .ack suffix has to be.
  it('refuses a file that already ends in .ack', () => {
    // Otherwise the ack lands at handoff.md.ack.ack and the watcher, polling
    // handoff.md.ack, waits forever.
    writeFileSync(sidecar, 'pre-existing');
    expect(() => writeAck({ file: sidecar, decision: 'accept', reason: 'oops' })).toThrow();
  });

  it('names the handoff file in that refusal', () => {
    writeFileSync(sidecar, 'pre-existing');
    expect(() => writeAck({ file: sidecar, decision: 'accept', reason: 'oops' })).toThrow(
      handoffFile
    );
  });

  it('writes nothing when it refuses', () => {
    writeFileSync(sidecar, 'pre-existing');
    expect(() => writeAck({ file: sidecar, decision: 'accept', reason: 'oops' })).toThrow();
    expect(existsSync(sidecar + '.ack')).toBe(false);
    expect(readFileSync(sidecar, 'utf-8')).toBe('pre-existing');
  });
});

// ---------------------------------------------------------------------------
// Reason normalisation
//
// The watcher reports the reason back to whoever handed the work over. A
// reason wrapped over three lines by a shell must read as one line there, so
// the normalisation happens once, on the way in.
// ---------------------------------------------------------------------------

describe('writeAck — reason normalisation', () => {
  it('collapses a run of spaces to one', () => {
    writeAck({ file: handoffFile, decision: 'accept', reason: 'taking    this   on' });
    expect(readSidecar().reason).toBe('taking this on');
  });

  it('collapses newlines to a single space', () => {
    writeAck({ file: handoffFile, decision: 'accept', reason: 'taking\nthis\non' });
    expect(readSidecar().reason).toBe('taking this on');
  });

  it('collapses tabs and mixed whitespace runs', () => {
    writeAck({ file: handoffFile, decision: 'accept', reason: 'taking\t \n this on' });
    expect(readSidecar().reason).toBe('taking this on');
  });

  it('trims the ends', () => {
    writeAck({ file: handoffFile, decision: 'accept', reason: '\n  taking this on  \n' });
    expect(readSidecar().reason).toBe('taking this on');
  });

  it('stores a whitespace-only reason as an empty string', () => {
    writeAck({ file: handoffFile, decision: 'accept', reason: '  \n\t ' });
    expect(readSidecar().reason).toBe('');
  });

  it('leaves an already-clean reason alone', () => {
    writeAck({ file: handoffFile, decision: 'decline', reason: 'I own conflicting files' });
    expect(readSidecar().reason).toBe('I own conflicting files');
  });
});

// ---------------------------------------------------------------------------
// Session id — blank is not an id
// ---------------------------------------------------------------------------

describe('writeAck — blank session ids', () => {
  it('records null for a whitespace-only CLAUDE_SESSION_ID', () => {
    process.env.CLAUDE_SESSION_ID = '\n';
    writeAck({ file: handoffFile, decision: 'accept', reason: '' });
    expect(readSidecar().sessionId).toBeNull();
  });

  it('records null for a CLAUDE_SESSION_ID of spaces and tabs', () => {
    process.env.CLAUDE_SESSION_ID = ' \t ';
    writeAck({ file: handoffFile, decision: 'accept', reason: '' });
    expect(readSidecar().sessionId).toBeNull();
  });

  it('records null for a whitespace-only sessionId option', () => {
    writeAck({ file: handoffFile, decision: 'accept', reason: '', sessionId: '   ' });
    expect(readSidecar().sessionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Writing failures
//
// The ack is the receiver's only way to answer. If the write fails it must say
// so loudly, and say what to do instead — otherwise the receiver silently
// believes it has acknowledged and the sender waits out the full timeout.
// ---------------------------------------------------------------------------

describe('writeAck — when the write itself fails', () => {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(asRoot)('throws when the sidecar cannot be written', () => {
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    const lockedHandoff = join(locked, 'handoff.md');
    writeFileSync(lockedHandoff, '# Handoff\n');
    chmodSync(locked, 0o555);
    try {
      expect(() => writeAck({ file: lockedHandoff, decision: 'accept', reason: 'ok' })).toThrow();
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it.skipIf(asRoot)('names the sidecar path it could not write', () => {
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    const lockedHandoff = join(locked, 'handoff.md');
    writeFileSync(lockedHandoff, '# Handoff\n');
    chmodSync(locked, 0o555);
    try {
      expect(() => writeAck({ file: lockedHandoff, decision: 'accept', reason: 'ok' })).toThrow(
        lockedHandoff + '.ack'
      );
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it.skipIf(asRoot)('falls back to telling the receiver to say ACCEPT or DECLINE instead', () => {
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    const lockedHandoff = join(locked, 'handoff.md');
    writeFileSync(lockedHandoff, '# Handoff\n');
    chmodSync(locked, 0o555);
    try {
      expect(() => writeAck({ file: lockedHandoff, decision: 'accept', reason: 'ok' })).toThrow(
        'ACCEPT or DECLINE'
      );
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

// ---------------------------------------------------------------------------
// Atomicity
//
// The watcher polls. It must never catch the sidecar half-written, and it must
// never be handed a stray temp file to puzzle over.
// ---------------------------------------------------------------------------

describe('writeAck — atomicity', () => {
  it('leaves exactly the handoff file and its sidecar behind', () => {
    writeAck({ file: handoffFile, decision: 'accept', reason: 'ok' });
    expect(readdirSync(dir).sort()).toEqual(
      [basename(handoffFile), basename(handoffFile) + '.ack'].sort()
    );
  });

  it('leaves no residue after overwriting an existing sidecar', () => {
    writeAck({ file: handoffFile, decision: 'accept', reason: 'first' });
    writeAck({ file: handoffFile, decision: 'decline', reason: 'second' });
    expect(readdirSync(dir).sort()).toEqual(
      [basename(handoffFile), basename(handoffFile) + '.ack'].sort()
    );
  });

  it('exposes the sidecar path it writes to', () => {
    expect(ackPath(handoffFile)).toBe(handoffFile + '.ack');
  });
});

// ---------------------------------------------------------------------------
// readAck — absent is not the same as broken
// ---------------------------------------------------------------------------

describe('readAck — failures that are not absence', () => {
  it('throws when the sidecar path is a directory', () => {
    // ENOENT means "no ack yet" and the watcher should keep waiting. Anything
    // else means the path is wrong, and swallowing it would hide that behind
    // an apparently ordinary silence.
    mkdirSync(sidecar);
    expect(() => readAck(handoffFile)).toThrow();
  });

  it('still returns null when the sidecar is simply absent', () => {
    expect(readAck(handoffFile)).toBeNull();
  });
});
