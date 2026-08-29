import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcriptPath, parseAck, analyze, watch } from './ackwatch.js';
import { writeAck } from './ackfile.js';

// ---------------------------------------------------------------------------
// Fixture builders — realistic JSONL record shapes, one JSON object per line.
// ---------------------------------------------------------------------------

const TOKEN = 'xk-correlate-9f3a';

function deliveryRecord(token = TOKEN, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'remove',
    content: `<cross-session-message from="session-abc">Please pick this up. ref:${token}</cross-session-message>`,
    timestamp: '2026-08-21T10:00:00.000Z',
    ...extra,
  });
}

function unrelatedDeliveryRecord(): string {
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'remove',
    content: '<cross-session-message from="session-zzz">unrelated message ref:some-other-token</cross-session-message>',
    timestamp: '2026-08-21T09:59:00.000Z',
  });
}

function stillQueuedRecord(token = TOKEN): string {
  // The message for our token is still sitting in the queue (operation "add",
  // not "remove") — it has not been delivered yet. Content still carries the
  // cross-session-message envelope, but the operation discriminator says this
  // is not a delivery.
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'add',
    content: `<cross-session-message from="session-abc">Please pick this up. ref:${token}</cross-session-message>`,
    timestamp: '2026-08-21T10:00:00.000Z',
  });
}

function nonHandoffQueueRemovalRecord(token = TOKEN): string {
  // A "remove" queue-operation whose content happens to mention our token, but
  // which is not a handoff delivery at all — it never begins with the
  // <cross-session-message envelope. e.g. some ordinary queued note that cites
  // the token for unrelated reasons.
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'remove',
    content: `Reminder: keep an eye on correlation id ref:${token} for the audit log.`,
    timestamp: '2026-08-21T10:00:00.000Z',
  });
}

function endTurnRecord(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Done for now.' }],
    },
    ...extra,
  });
}

function toolUseTurnRecord(): string {
  // Assistant record that is NOT a turn boundary (stop_reason tool_use).
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }],
    },
  });
}

function noStopReasonAssistantRecord(): string {
  // Assistant record mid-stream with no stop_reason at all — not a boundary.
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'thinking out loud' }],
    },
  });
}

function ackRecord(opts: {
  to?: string;
  message?: string;
  isSidechain?: boolean;
} = {}): string {
  const { to = 'session-abc', message = 'ACCEPT — taking this on', isSidechain } = opts;
  return JSON.stringify({
    type: 'assistant',
    ...(isSidechain !== undefined ? { isSidechain } : {}),
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Acknowledging the handoff.' },
        { type: 'tool_use', name: 'SendMessage', input: { to, message } },
      ],
    },
  });
}

function textAckRecord(opts: {
  text?: string;
  isSidechain?: boolean;
  stopReason?: string;
  extraBlocks?: unknown[];
} = {}): string {
  // Fresh mode has no handle for the launching session, so the target
  // acknowledges as plain assistant TEXT instead of a SendMessage tool call.
  const {
    text = 'ACCEPT — taking this on',
    isSidechain,
    stopReason = 'end_turn',
    extraBlocks = [],
  } = opts;
  return JSON.stringify({
    type: 'assistant',
    ...(isSidechain !== undefined ? { isSidechain } : {}),
    message: {
      role: 'assistant',
      stop_reason: stopReason,
      content: [...extraBlocks, { type: 'text', text }],
    },
  });
}

function userRecord(): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
}

function summaryRecord(): string {
  return JSON.stringify({ type: 'summary', summary: 'A short summary of the conversation.' });
}

function sidechainEndTurnRecord(): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Subagent done.' }],
    },
  });
}

function assistantNoUsage(): string {
  // Assistant end_turn record with no usage field — must not crash.
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
    },
  });
}

// ---------------------------------------------------------------------------
// transcriptPath
// ---------------------------------------------------------------------------

describe('transcriptPath', () => {
  it('munges every non-alphanumeric character of the cwd to a dash', () => {
    const p = transcriptPath('/home/user/my.repo', 'sess-123', '/home/user/.claude/projects');
    expect(p).toBe(join('/home/user/.claude/projects', '-home-user-my-repo', 'sess-123.jsonl'));
  });

  it('munges underscores, since underscore is not alphanumeric', () => {
    const p = transcriptPath('/home/user/my_repo_name', 'sess-1', '/proj');
    expect(p).toBe(join('/proj', '-home-user-my-repo-name', 'sess-1.jsonl'));
  });

  it('munges slashes and dots together in a nested path', () => {
    const p = transcriptPath('/home/acoote/.herdr/worktrees/spechub/feat-x', 'abc', '/root');
    expect(p).toBe(join('/root', '-home-acoote--herdr-worktrees-spechub-feat-x', 'abc.jsonl'));
  });

  it('defaults projectsDir to ~/.claude/projects when omitted', () => {
    const p = transcriptPath('/a/b', 'sess');
    expect(p).toContain(join('.claude', 'projects'));
    expect(p.endsWith(join('-a-b', 'sess.jsonl'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseAck
// ---------------------------------------------------------------------------

describe('parseAck', () => {
  it('parses ACCEPT with an em-dash reason', () => {
    expect(parseAck('ACCEPT — taking this on')).toEqual({
      decision: 'accept',
      reason: 'taking this on',
    });
  });

  it('parses DECLINE with a colon reason', () => {
    expect(parseAck('DECLINE: already own conflicting files in this worktree')).toEqual({
      decision: 'decline',
      reason: 'already own conflicting files in this worktree',
    });
  });

  it('is case-insensitive on the leading keyword', () => {
    expect(parseAck('accept - sure thing').decision).toBe('accept');
    expect(parseAck('Decline, not now').decision).toBe('decline');
  });

  it('returns null decision for free text with no leading keyword, preserving the full text', () => {
    const result = parseAck('on it!');
    expect(result.decision).toBeNull();
    expect(result.reason).toBeNull();
  });

  it('does not treat a keyword appearing mid-sentence as a decision', () => {
    expect(parseAck('I will not accept this without more info').decision).toBeNull();
  });

  it('handles ACCEPT with no punctuation and no trailing reason', () => {
    const result = parseAck('ACCEPT');
    expect(result.decision).toBe('accept');
  });
});

// ---------------------------------------------------------------------------
// analyze — pure decision over already-read lines
// ---------------------------------------------------------------------------

describe('analyze — usage errors', () => {
  it('throws when both token and fresh are set', () => {
    expect(() => analyze([], { token: 't', fresh: true })).toThrow();
  });

  it('throws when neither token nor fresh is set', () => {
    expect(() => analyze([], {})).toThrow();
  });
});

describe('analyze — token mode anchoring', () => {
  it('is pending when the delivery record for our token has not appeared yet', () => {
    const lines = [userRecord(), unrelatedDeliveryRecord(), endTurnRecord(), endTurnRecord()];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.anchored).toBe(false);
    expect(result.outcome).toBe('pending');
  });

  it('never reports silence while the message is still queued (no matching delivery)', () => {
    const lines = [endTurnRecord(), endTurnRecord(), endTurnRecord(), endTurnRecord(), endTurnRecord()];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.outcome).not.toBe('silence');
    expect(result.outcome).toBe('pending');
  });

  it('ignores an unrelated delivery record containing a different token', () => {
    const lines = [unrelatedDeliveryRecord(), deliveryRecord(), endTurnRecord()];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.anchored).toBe(true);
    // Only one end_turn after the real anchor — not yet acknowledged or silent.
    expect(result.outcome).toBe('pending');
    expect(result.turnsElapsed).toBe(1);
  });

  it('does not count turn boundaries that occur before the anchor', () => {
    const lines = [
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      deliveryRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.turnsElapsed).toBe(1);
    expect(result.outcome).toBe('pending');
  });

  it('does not anchor on a still-queued record for our token (operation "add", not "remove")', () => {
    // The message is still sitting in the queue, not delivered. Even though
    // many end_turn boundaries pass, the watcher must never mistake "still
    // queued" for "delivered and silent" — that would be a false-positive
    // silence report against a message nobody has even seen yet.
    const lines = [
      stillQueuedRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.anchored).toBe(false);
    expect(result.outcome).toBe('pending');
  });

  it('does not anchor on a "remove" queue-operation whose content is not a cross-session-message delivery', () => {
    // A "remove" record mentions our token, but its content is ordinary queue
    // content — it does not begin with the <cross-session-message envelope
    // that marks an actual handoff delivery. This must not anchor either.
    const lines = [
      nonHandoffQueueRemovalRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.anchored).toBe(false);
    expect(result.outcome).toBe('pending');
  });
});

describe('analyze — fresh mode anchoring', () => {
  it('anchors at the first record of the transcript when fresh', () => {
    const lines = [endTurnRecord(), endTurnRecord()];
    const result = analyze(lines, { fresh: true, turns: 5 });
    expect(result.anchored).toBe(true);
    expect(result.turnsElapsed).toBe(2);
  });

  it('reports acknowledged in fresh mode when a SendMessage ACK appears', () => {
    const lines = [endTurnRecord(), ackRecord({ message: 'ACCEPT — got it' })];
    const result = analyze(lines, { fresh: true, turns: 5 });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.decision).toBe('accept');
  });
});

// ---------------------------------------------------------------------------
// analyze — fresh mode: plain assistant TEXT counts as an ACK too
//
// A freshly launched agent has no handle for the launching session, so it
// acknowledges as ordinary assistant text rather than a SendMessage tool
// call. Fresh mode must recognize that text the same way it recognizes a
// SendMessage ACK; token mode must not (see the describe block below).
// ---------------------------------------------------------------------------

describe('analyze — fresh mode text ACKs', () => {
  it('recognizes a leading ACCEPT text block as an ACK, with to: null', () => {
    const lines = [endTurnRecord(), textAckRecord({ text: 'ACCEPT — taking this on' })];
    const result = analyze(lines, { fresh: true, turns: 5 });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack).toEqual({
      to: null,
      message: 'ACCEPT — taking this on',
      decision: 'accept',
      reason: 'taking this on',
      via: 'text',
    });
  });

  it('recognizes a leading DECLINE text block as an ACK, preserving the reason', () => {
    const lines = [textAckRecord({ text: 'DECLINE: wrong worktree, I own conflicting files' })];
    const result = analyze(lines, { fresh: true, turns: 5 });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.decision).toBe('decline');
    expect(result.ack?.reason).toBe('wrong worktree, I own conflicting files');
    expect(result.ack?.to).toBeNull();
  });

  it('does not treat a mid-sentence "accept" in text as an ACK — enough turns resolve silence instead', () => {
    const lines = [
      textAckRecord({ text: 'I will not accept this without tests' }),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { fresh: true, turns: 5 });
    expect(result.outcome).toBe('silence');
    expect(result.ack).toBeUndefined();
  });

  it('matches a text ACK even with leading whitespace/newline before the keyword', () => {
    const lines = [textAckRecord({ text: '\n  ACCEPT — after leading whitespace' })];
    const result = analyze(lines, { fresh: true, turns: 5 });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.decision).toBe('accept');
    expect(result.ack?.reason).toBe('after leading whitespace');
  });

  it('ignores a text ACK that belongs to a sidechain record', () => {
    const lines = [
      textAckRecord({ text: 'ACCEPT', isSidechain: true }),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { fresh: true, turns: 5 });
    expect(result.outcome).toBe('silence');
    expect(result.ack).toBeUndefined();
  });

  it('recognizes a text ACK even when the content array also holds a tool_use block', () => {
    // Multi-block content array: a tool_use block precedes the text block
    // carrying the ACK, e.g. the agent ran a command before acknowledging.
    const lines = [
      textAckRecord({
        text: 'ACCEPT — after checking git status',
        extraBlocks: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }],
      }),
    ];
    const result = analyze(lines, { fresh: true, turns: 5 });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack).toEqual({
      to: null,
      message: 'ACCEPT — after checking git status',
      decision: 'accept',
      reason: 'after checking git status',
      via: 'text',
    });
  });

  it('still recognizes a SendMessage tool-use ACK in fresh mode (regression guard)', () => {
    const lines = [
      endTurnRecord(),
      ackRecord({ to: 'session-launcher', message: 'ACCEPT — got it via tool call' }),
    ];
    const result = analyze(lines, { fresh: true, turns: 5 });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack).toEqual({
      to: 'session-launcher',
      message: 'ACCEPT — got it via tool call',
      decision: 'accept',
      reason: 'got it via tool call',
      via: 'text',
    });
  });

  it('takes whichever form of ACK appears first at-or-after the anchor — text before a later SendMessage', () => {
    const lines = [
      textAckRecord({ text: 'ACCEPT — text ack came first' }),
      ackRecord({ message: 'ACCEPT — tool ack came second' }),
    ];
    const result = analyze(lines, { fresh: true, turns: 5 });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.message).toBe('ACCEPT — text ack came first');
  });
});

// ---------------------------------------------------------------------------
// analyze — text ACKs are recognized in fresh mode only
//
// Token mode targets an existing, possibly busy session. Its ordinary prose
// must never be mistaken for an acknowledgement — only a SendMessage tool
// call counts there.
// ---------------------------------------------------------------------------

describe('analyze — text ACKs do not count in token mode', () => {
  it('does not recognize a text ACK after the delivery anchor in token mode', () => {
    const lines = [deliveryRecord(), textAckRecord({ text: 'ACCEPT — sure' })];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.outcome).toBe('pending');
    expect(result.ack).toBeUndefined();
  });

  it('resolves silence in token mode despite a text ACK, once enough turn boundaries elapse', () => {
    const lines = [
      deliveryRecord(),
      textAckRecord({ text: 'ACCEPT — sure' }),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.outcome).toBe('silence');
    expect(result.ack).toBeUndefined();
  });
});

describe('analyze — acknowledged outcome', () => {
  it('reports acknowledged with recipient, message, and parsed accept decision', () => {
    const lines = [
      deliveryRecord(),
      endTurnRecord(),
      ackRecord({ to: 'session-abc', message: 'ACCEPT — taking this on' }),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack).toEqual({
      to: 'session-abc',
      message: 'ACCEPT — taking this on',
      decision: 'accept',
      reason: 'taking this on',
      via: 'text',
    });
  });

  it('reports acknowledged with a decline decision and reason', () => {
    const lines = [
      deliveryRecord(),
      ackRecord({ message: 'DECLINE: already own conflicting files in this worktree' }),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.decision).toBe('decline');
    expect(result.ack?.reason).toBe('already own conflicting files in this worktree');
  });

  it('reports acknowledged with a null decision when the message has no leading keyword', () => {
    const lines = [deliveryRecord(), ackRecord({ message: 'on it!' })];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.decision).toBeNull();
    expect(result.ack?.message).toBe('on it!');
  });

  it('an ACK arriving before the Nth turn boundary wins over silence', () => {
    const lines = [
      deliveryRecord(),
      endTurnRecord(),
      endTurnRecord(),
      ackRecord({ message: 'ACCEPT' }),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.outcome).toBe('acknowledged');
  });

  it('ignores a SendMessage tool_use on a sidechain record — not a valid ACK', () => {
    const lines = [
      deliveryRecord(),
      ackRecord({ message: 'ACCEPT', isSidechain: true }),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.outcome).toBe('silence');
  });
});

describe('analyze — silence outcome', () => {
  it('reports silence once N end_turn boundaries elapse at-or-after the anchor with no ACK', () => {
    const lines = [
      deliveryRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.outcome).toBe('silence');
    expect(result.turnsElapsed).toBe(5);
  });

  it('is pending, not silent, with fewer than N boundaries and no ACK', () => {
    const lines = [deliveryRecord(), endTurnRecord(), endTurnRecord(), endTurnRecord(), endTurnRecord()];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.outcome).toBe('pending');
    expect(result.turnsElapsed).toBe(4);
  });

  it('does not count sidechain end_turn records toward the turn boundary total', () => {
    const lines = [
      deliveryRecord(),
      sidechainEndTurnRecord(),
      sidechainEndTurnRecord(),
      sidechainEndTurnRecord(),
      sidechainEndTurnRecord(),
      sidechainEndTurnRecord(),
      sidechainEndTurnRecord(),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.outcome).toBe('pending');
    expect(result.turnsElapsed).toBe(0);
  });

  it('does not count non-end_turn assistant records as turn boundaries (the classic miscount bug)', () => {
    // Six assistant records per boundary: tool_use, tool_use, no-stop-reason, tool_use, tool_use, end_turn.
    // If the implementation counts assistant records instead of end_turn boundaries, this would
    // reach turns=5 with only a single real boundary elapsed, and wrongly report silence.
    const oneRealBoundary = [
      toolUseTurnRecord(),
      toolUseTurnRecord(),
      noStopReasonAssistantRecord(),
      toolUseTurnRecord(),
      toolUseTurnRecord(),
      endTurnRecord(),
    ];
    const lines = [deliveryRecord(), ...oneRealBoundary];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.turnsElapsed).toBe(1);
    expect(result.outcome).toBe('pending');
  });

  it('respects a custom turns count', () => {
    const lines = [deliveryRecord(), endTurnRecord(), endTurnRecord()];
    const result = analyze(lines, { token: TOKEN, turns: 2 });
    expect(result.outcome).toBe('silence');
    expect(result.turnsElapsed).toBe(2);
  });

  it('caps turnsElapsed at the configured turns value', () => {
    const lines = [
      deliveryRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.turnsElapsed).toBe(5);
  });
});

describe('analyze — resilience to malformed input and irrelevant records', () => {
  it('skips unparseable lines without throwing', () => {
    const lines = [
      deliveryRecord(),
      'not json at all {{{',
      '{"type":"assistant","message":{"stop_reason":"end_turn"', // truncated mid-write
      endTurnRecord(),
      '',
      ackRecord({ message: 'ACCEPT' }),
    ];
    expect(() => analyze(lines, { token: TOKEN, turns: 5 })).not.toThrow();
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.outcome).toBe('acknowledged');
  });

  it('tolerates assistant records missing usage entirely', () => {
    const lines = [deliveryRecord(), assistantNoUsage()];
    expect(() => analyze(lines, { token: TOKEN, turns: 5 })).not.toThrow();
  });

  it('ignores interleaved user and summary records', () => {
    const lines = [
      userRecord(),
      deliveryRecord(),
      userRecord(),
      summaryRecord(),
      endTurnRecord(),
      userRecord(),
      ackRecord({ message: 'ACCEPT' }),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.outcome).toBe('acknowledged');
  });
});

// ---------------------------------------------------------------------------
// watch — polling loop over a live transcript file
// ---------------------------------------------------------------------------

describe('watch', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spechub-ackwatch-'));
    file = join(dir, 'session.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('picks up a transcript file that does not exist yet at watch start', async () => {
    expect(existsSync(file)).toBe(false);
    const promise = watch(file, {
      token: TOKEN,
      turns: 2,
      pollIntervalMs: 20,
      timeoutMs: 2000,
    });
    setTimeout(() => {
      writeFileSync(file, deliveryRecord() + '\n' + ackRecord({ message: 'ACCEPT' }) + '\n');
    }, 60);
    const result = await promise;
    expect(result.outcome).toBe('acknowledged');
  });

  it('observes records appended to the file after watching starts', async () => {
    writeFileSync(file, deliveryRecord() + '\n');
    const promise = watch(file, {
      token: TOKEN,
      turns: 2,
      pollIntervalMs: 20,
      timeoutMs: 2000,
    });
    setTimeout(() => {
      appendFileSync(file, endTurnRecord() + '\n');
    }, 40);
    setTimeout(() => {
      appendFileSync(file, endTurnRecord() + '\n');
    }, 80);
    const result = await promise;
    expect(result.outcome).toBe('silence');
    expect(result.turnsElapsed).toBe(2);
  });

  it('gives up with outcome timeout after the configured overall timeout elapses', async () => {
    writeFileSync(file, deliveryRecord() + '\n');
    const result = await watch(file, {
      token: TOKEN,
      turns: 5,
      pollIntervalMs: 15,
      timeoutMs: 100,
    });
    expect(result.outcome).toBe('timeout');
  });

  it('resolves as acknowledged as soon as the ACK appears, well before timeout', async () => {
    writeFileSync(file, deliveryRecord() + '\n');
    const start = Date.now();
    setTimeout(() => {
      appendFileSync(file, ackRecord({ message: 'ACCEPT' }) + '\n');
    }, 30);
    const result = await watch(file, {
      token: TOKEN,
      turns: 5,
      pollIntervalMs: 15,
      timeoutMs: 5000,
    });
    expect(result.outcome).toBe('acknowledged');
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('throws a usage error when both token and fresh are given', async () => {
    await expect(
      watch(file, { token: TOKEN, fresh: true, pollIntervalMs: 10, timeoutMs: 100 })
    ).rejects.toThrow();
  });

  it('throws a usage error when neither token nor fresh is given', async () => {
    await expect(watch(file, { pollIntervalMs: 10, timeoutMs: 100 })).rejects.toThrow();
  });

  it('supports fresh mode, anchoring at the first record once the file appears', async () => {
    const promise = watch(file, {
      fresh: true,
      turns: 1,
      pollIntervalMs: 15,
      timeoutMs: 2000,
    });
    setTimeout(() => {
      writeFileSync(file, endTurnRecord() + '\n');
    }, 30);
    const result = await promise;
    expect(result.outcome).toBe('silence');
    expect(result.turnsElapsed).toBe(1);
  });

  it('resolves acknowledged in fresh mode when a text ACK is appended live (no SendMessage involved)', async () => {
    const promise = watch(file, {
      fresh: true,
      turns: 5,
      pollIntervalMs: 15,
      timeoutMs: 2000,
    });
    setTimeout(() => {
      writeFileSync(file, textAckRecord({ text: 'ACCEPT — got it' }) + '\n');
    }, 30);
    const result = await promise;
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.decision).toBe('accept');
    expect(result.ack?.to).toBeNull();
  });
});

// ===========================================================================
// The handoff file: a second, out-of-band channel
//
// A target can acknowledge by writing a sidecar next to the handoff file
// (`spechub handoff ack`) instead of speaking into its transcript. The
// watcher is given that handoff path as `file`, and from then on it has two
// sources of truth: the sidecar and the transcript. The sidecar is the
// deliberate one, so it wins.
//
// The same option feeds engagement detection: a target that never says a word
// but starts editing the files the handoff named has plainly picked the work
// up, and reporting that as silence would send a nudge to someone already
// working.
// ===========================================================================

/** A tool_use record that is not a turn boundary, with a controllable name and input. */
function toolUseRecord(
  opts: { name?: string; input?: unknown; isSidechain?: boolean } = {}
): string {
  const { name = 'Read', input = { file_path: '/unrelated/other.ts' }, isSidechain } = opts;
  return JSON.stringify({
    type: 'assistant',
    ...(isSidechain !== undefined ? { isSidechain } : {}),
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name, input }],
    },
  });
}

// ---------------------------------------------------------------------------
// analyze — CLI ack sidecar
// ---------------------------------------------------------------------------

describe('analyze — CLI ack sidecar', () => {
  let dir: string;
  let handoffFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spechub-acksidecar-'));
    handoffFile = join(dir, 'handoff-2026-08-23.md');
    writeFileSync(handoffFile, '# Handoff\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSidecar(body: unknown, path = handoffFile + '.ack'): void {
    writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  }

  it('reports acknowledged from the sidecar, with via cli and the reason as the message', () => {
    writeSidecar({
      decision: 'accept',
      reason: 'taking this on',
      sessionId: 'sess-1',
      at: '2026-08-23T10:00:00.000Z',
    });
    const result = analyze([deliveryRecord()], { token: TOKEN, turns: 5, file: handoffFile });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.via).toBe('cli');
    expect(result.ack?.decision).toBe('accept');
    expect(result.ack?.message).toBe('taking this on');
  });

  it('reports a sidecar decline with its reason', () => {
    writeSidecar({
      decision: 'decline',
      reason: 'I own conflicting files in this worktree',
      sessionId: null,
      at: '2026-08-23T10:00:00.000Z',
    });
    const result = analyze([deliveryRecord()], { token: TOKEN, turns: 5, file: handoffFile });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.decision).toBe('decline');
    expect(result.ack?.message).toBe('I own conflicting files in this worktree');
    expect(result.ack?.via).toBe('cli');
  });

  it('has no SendMessage recipient for a sidecar ack, so `to` is null', () => {
    writeSidecar({ decision: 'accept', reason: 'ok', sessionId: null, at: '2026-08-23T10:00:00.000Z' });
    const result = analyze([deliveryRecord()], { token: TOKEN, turns: 5, file: handoffFile });
    expect(result.ack?.to).toBeNull();
  });

  it('reports acknowledged from the sidecar even when the transcript has no anchor yet', () => {
    // The message may still be queued, or the target may never have been given
    // a token at all. A written ack is a written ack.
    writeSidecar({ decision: 'accept', reason: 'on it', sessionId: null, at: '2026-08-23T10:00:00.000Z' });
    const result = analyze([userRecord()], { token: TOKEN, turns: 5, file: handoffFile });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.via).toBe('cli');
  });

  it('reports acknowledged from the sidecar with no transcript at all', () => {
    writeSidecar({ decision: 'accept', reason: 'on it', sessionId: null, at: '2026-08-23T10:00:00.000Z' });
    const result = analyze([], { token: TOKEN, turns: 5, file: handoffFile });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.via).toBe('cli');
  });

  it('lets the sidecar win over a contradicting transcript ACK', () => {
    writeSidecar({
      decision: 'decline',
      reason: 'changed my mind after looking',
      sessionId: null,
      at: '2026-08-23T10:00:00.000Z',
    });
    const lines = [deliveryRecord(), ackRecord({ message: 'ACCEPT — taking this on' })];
    const result = analyze(lines, { token: TOKEN, turns: 5, file: handoffFile });
    expect(result.ack?.via).toBe('cli');
    expect(result.ack?.decision).toBe('decline');
    expect(result.ack?.message).toBe('changed my mind after looking');
  });

  it('honours the sidecar in fresh mode too', () => {
    // The transcript timestamp matters here: fresh mode dates the round by the
    // launch, so a sidecar has to be stamped after the transcript begins.
    writeSidecar({ decision: 'accept', reason: 'fresh and willing', sessionId: null, at: '2026-08-23T10:00:00.000Z' });
    const result = analyze([endTurnRecord({ timestamp: '2026-08-23T09:59:00.000Z' })], {
      fresh: true,
      turns: 5,
      file: handoffFile,
    });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.via).toBe('cli');
  });

  it('ignores a malformed sidecar and falls back to the transcript', () => {
    writeSidecar('{ not json');
    const lines = [
      deliveryRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5, file: handoffFile });
    expect(result.outcome).toBe('silence');
    expect(result.ack).toBeUndefined();
  });

  it('reads the sidecar at exactly <file>.ack and nowhere else', () => {
    // A near-miss path must not be mistaken for an ack.
    writeSidecar(
      { decision: 'accept', reason: 'wrong path', sessionId: null, at: '2026-08-23T10:00:00.000Z' },
      join(dir, 'handoff-2026-08-23.ack')
    );
    const lines = [
      deliveryRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5, file: handoffFile });
    expect(result.outcome).toBe('silence');
  });

  it('behaves exactly as before when file is given but no sidecar exists', () => {
    const lines = [deliveryRecord(), ackRecord({ message: 'ACCEPT — via the transcript' })];
    const result = analyze(lines, { token: TOKEN, turns: 5, file: handoffFile });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.via).toBe('text');
    expect(result.ack?.message).toBe('ACCEPT — via the transcript');
  });

  it('does not throw when file points somewhere that cannot exist', () => {
    const lines = [deliveryRecord(), endTurnRecord()];
    const nowhere = join(dir, 'no-such-dir', 'handoff.md');
    expect(() => analyze(lines, { token: TOKEN, turns: 5, file: nowhere })).not.toThrow();
    expect(analyze(lines, { token: TOKEN, turns: 5, file: nowhere }).outcome).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// analyze — via, on transcript ACKs
// ---------------------------------------------------------------------------

describe('analyze — ack provenance', () => {
  it('marks a SendMessage ACK as via text', () => {
    const lines = [deliveryRecord(), ackRecord({ message: 'ACCEPT' })];
    expect(analyze(lines, { token: TOKEN, turns: 5 }).ack?.via).toBe('text');
  });

  it('marks a fresh-mode text ACK as via text', () => {
    const lines = [textAckRecord({ text: 'ACCEPT — got it' })];
    expect(analyze(lines, { fresh: true, turns: 5 }).ack?.via).toBe('text');
  });
});

// ---------------------------------------------------------------------------
// analyze — engagement
//
// Silence means "nobody picked this up". A target that is visibly working —
// spawning agents, editing files, running commands, or touching the handoff
// file itself — is not silent, whatever it has failed to say. `engaged`
// records that evidence on every result; the outcome only changes once the
// turn budget has run out, because before then the result is still pending.
// ---------------------------------------------------------------------------

describe('analyze — engagement instead of silence', () => {
  const HANDOFF_FILE = '/tmp/spechub-handoffs/handoff-2026-08-23.md';

  function silentRun(...records: string[]): string[] {
    return [
      deliveryRecord(),
      ...records,
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
  }

  it('reports silence, with engaged false, when nothing after the anchor shows work', () => {
    const result = analyze(silentRun(), { token: TOKEN, turns: 5, file: HANDOFF_FILE });
    expect(result.outcome).toBe('silence');
    expect(result.engaged).toBe(false);
  });

  it.each(['Agent', 'Edit', 'Write', 'Bash'])(
    'reports engaged when a %s tool_use appears after the anchor',
    name => {
      const result = analyze(silentRun(toolUseRecord({ name })), {
        token: TOKEN,
        turns: 5,
        file: HANDOFF_FILE,
      });
      expect(result.outcome).toBe('engaged');
      expect(result.engaged).toBe(true);
    }
  );

  it('reports engaged for a tool whose input names the handoff file, whatever the tool is', () => {
    const result = analyze(
      silentRun(toolUseRecord({ name: 'Read', input: { file_path: HANDOFF_FILE } })),
      { token: TOKEN, turns: 5, file: HANDOFF_FILE }
    );
    expect(result.outcome).toBe('engaged');
    expect(result.engaged).toBe(true);
  });

  it('finds the handoff path anywhere in the tool input, not only in a known field', () => {
    const result = analyze(
      silentRun(
        toolUseRecord({
          name: 'Grep',
          input: { pattern: 'TODO', paths: [HANDOFF_FILE], context: { note: 'from the handoff' } },
        })
      ),
      { token: TOKEN, turns: 5, file: HANDOFF_FILE }
    );
    expect(result.outcome).toBe('engaged');
  });

  it('stays silent for an unremarkable tool whose input never mentions the handoff', () => {
    const result = analyze(
      silentRun(toolUseRecord({ name: 'Read', input: { file_path: '/somewhere/else.ts' } })),
      { token: TOKEN, turns: 5, file: HANDOFF_FILE }
    );
    expect(result.outcome).toBe('silence');
    expect(result.engaged).toBe(false);
  });

  it('ignores sidechain tool use — a subagent working is not the target working', () => {
    const result = analyze(silentRun(toolUseRecord({ name: 'Edit', isSidechain: true })), {
      token: TOKEN,
      turns: 5,
      file: HANDOFF_FILE,
    });
    expect(result.outcome).toBe('silence');
    expect(result.engaged).toBe(false);
  });

  it('ignores tool use that happened before the anchor', () => {
    const lines = [
      toolUseRecord({ name: 'Edit' }),
      deliveryRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5, file: HANDOFF_FILE });
    expect(result.outcome).toBe('silence');
    expect(result.engaged).toBe(false);
  });

  it('detects engagement by tool name with no file option given', () => {
    const lines = [
      deliveryRecord(),
      toolUseRecord({ name: 'Write' }),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5 });
    expect(result.outcome).toBe('engaged');
    expect(result.engaged).toBe(true);
  });

  it('carries engaged true on a still-pending result, before the turn budget runs out', () => {
    const lines = [deliveryRecord(), toolUseRecord({ name: 'Bash' }), endTurnRecord()];
    const result = analyze(lines, { token: TOKEN, turns: 5, file: HANDOFF_FILE });
    expect(result.outcome).toBe('pending');
    expect(result.engaged).toBe(true);
  });

  it('reports engaged false on a pending result with no evidence of work', () => {
    const result = analyze([deliveryRecord(), endTurnRecord()], { token: TOKEN, turns: 5 });
    expect(result.outcome).toBe('pending');
    expect(result.engaged).toBe(false);
  });

  it('reports engaged false alongside an acknowledgement that involved no tools', () => {
    const lines = [deliveryRecord(), textAckRecord({ text: 'ACCEPT — got it' })];
    const result = analyze(lines, { fresh: true, turns: 5 });
    expect(result.outcome).toBe('acknowledged');
    expect(result.engaged).toBe(false);
  });

  it('prefers an acknowledgement over engagement when both are present', () => {
    const lines = [
      deliveryRecord(),
      toolUseRecord({ name: 'Edit' }),
      ackRecord({ message: 'ACCEPT — already started' }),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5, file: HANDOFF_FILE });
    expect(result.outcome).toBe('acknowledged');
    expect(result.engaged).toBe(true);
  });

  it('reports engaged on every outcome shape, so callers can always read the field', () => {
    const pending = analyze([userRecord()], { token: TOKEN, turns: 5 });
    expect(pending.anchored).toBe(false);
    expect(pending.engaged).toBe(false);
  });

  it('does not count a SendMessage tool_use on its own as engagement', () => {
    // Otherwise a declining target that says nothing else would read as
    // engaged, which is exactly the opposite of what it told us.
    const lines = [
      deliveryRecord(),
      toolUseRecord({ name: 'SendMessage', input: { to: 'someone-else', message: 'unrelated' } }),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5, file: HANDOFF_FILE });
    expect(result.outcome).toBe('silence');
    expect(result.engaged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analyze — nudged
//
// The caller tells the watcher whether this target has already been nudged
// once. The watcher does not act on it; it echoes it back so the caller can
// decide whether to nudge again or escalate.
// ---------------------------------------------------------------------------

describe('analyze — nudged flag', () => {
  it('defaults nudged to false', () => {
    expect(analyze([deliveryRecord()], { token: TOKEN, turns: 5 }).nudged).toBe(false);
  });

  it('echoes nudged true back on the result', () => {
    expect(analyze([deliveryRecord()], { token: TOKEN, turns: 5, nudged: true }).nudged).toBe(true);
  });

  it('echoes nudged on an acknowledged result too', () => {
    const lines = [deliveryRecord(), ackRecord({ message: 'ACCEPT' })];
    const result = analyze(lines, { token: TOKEN, turns: 5, nudged: true });
    expect(result.outcome).toBe('acknowledged');
    expect(result.nudged).toBe(true);
  });

  it('echoes nudged on a silence result too', () => {
    const lines = [
      deliveryRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
    const result = analyze(lines, { token: TOKEN, turns: 5, nudged: true });
    expect(result.outcome).toBe('silence');
    expect(result.nudged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// watch — the sidecar and the new outcomes, live
// ---------------------------------------------------------------------------

describe('watch — handoff file', () => {
  let dir: string;
  let file: string;
  let handoffFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spechub-ackwatch-file-'));
    file = join(dir, 'session.jsonl');
    handoffFile = join(dir, 'handoff-2026-08-23.md');
    writeFileSync(handoffFile, '# Handoff\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves acknowledged when the sidecar appears, though the transcript never changes', async () => {
    writeFileSync(file, deliveryRecord() + '\n');
    const promise = watch(file, {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      pollIntervalMs: 15,
      timeoutMs: 3000,
    });
    setTimeout(() => {
      writeFileSync(
        handoffFile + '.ack',
        JSON.stringify({
          decision: 'accept',
          reason: 'picked it up',
          sessionId: 'sess-live',
          at: new Date().toISOString(),
        })
      );
    }, 40);
    const result = await promise;
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.via).toBe('cli');
    expect(result.ack?.message).toBe('picked it up');
  });

  it('resolves acknowledged from a sidecar even when no transcript file exists at all', async () => {
    expect(existsSync(file)).toBe(false);
    const promise = watch(file, {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      pollIntervalMs: 15,
      timeoutMs: 3000,
    });
    setTimeout(() => {
      writeFileSync(
        handoffFile + '.ack',
        JSON.stringify({
          decision: 'decline',
          reason: 'busy',
          sessionId: null,
          at: new Date().toISOString(),
        })
      );
    }, 40);
    const result = await promise;
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.decision).toBe('decline');
  });

  it('resolves engaged rather than silence when the target is visibly working', async () => {
    writeFileSync(file, deliveryRecord() + '\n');
    const promise = watch(file, {
      token: TOKEN,
      turns: 2,
      file: handoffFile,
      pollIntervalMs: 15,
      timeoutMs: 3000,
    });
    setTimeout(() => {
      appendFileSync(
        file,
        toolUseRecord({ name: 'Edit', input: { file_path: '/src/thing.ts' } }) +
          '\n' +
          endTurnRecord() +
          '\n' +
          endTurnRecord() +
          '\n'
      );
    }, 40);
    const result = await promise;
    expect(result.outcome).toBe('engaged');
    expect(result.engaged).toBe(true);
  });

  it('still resolves silence when nothing shows work, and reports engaged false', async () => {
    writeFileSync(file, deliveryRecord() + '\n' + endTurnRecord() + '\n' + endTurnRecord() + '\n');
    const result = await watch(file, {
      token: TOKEN,
      turns: 2,
      file: handoffFile,
      pollIntervalMs: 15,
      timeoutMs: 2000,
    });
    expect(result.outcome).toBe('silence');
    expect(result.engaged).toBe(false);
  });

  it('echoes nudged on the resolved result', async () => {
    writeFileSync(file, deliveryRecord() + '\n' + ackRecord({ message: 'ACCEPT' }) + '\n');
    const result = await watch(file, {
      token: TOKEN,
      turns: 5,
      nudged: true,
      pollIntervalMs: 15,
      timeoutMs: 2000,
    });
    expect(result.outcome).toBe('acknowledged');
    expect(result.nudged).toBe(true);
  });

  it('defaults nudged to false on the resolved result', async () => {
    writeFileSync(file, deliveryRecord() + '\n' + ackRecord({ message: 'ACCEPT' }) + '\n');
    const result = await watch(file, {
      token: TOKEN,
      turns: 5,
      pollIntervalMs: 15,
      timeoutMs: 2000,
    });
    expect(result.nudged).toBe(false);
  });

  it('reports engaged and nudged on a timeout result too', async () => {
    writeFileSync(file, deliveryRecord() + '\n' + toolUseRecord({ name: 'Bash' }) + '\n');
    const result = await watch(file, {
      token: TOKEN,
      turns: 5,
      nudged: true,
      file: handoffFile,
      pollIntervalMs: 15,
      timeoutMs: 100,
    });
    expect(result.outcome).toBe('timeout');
    expect(result.engaged).toBe(true);
    expect(result.nudged).toBe(true);
  });
});

// ===========================================================================
// Stale sidecars
//
// A handoff file can be handed over twice, and the sidecar from the first
// round is still sitting there. Reading it would report the second handoff as
// acknowledged before anyone had seen it. `ackAfter` draws the line: only an
// ack stamped at or after that moment counts. `watch` sets it to the moment
// the watch began, so an ack from a previous round is invisible to it.
// ===========================================================================

/** Milliseconds. Old enough to sit clearly on the wrong side of any line. */
const AN_HOUR = 60 * 60 * 1000;

function ackJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: 'accept',
    reason: 'taking this on',
    sessionId: null,
    at: new Date().toISOString(),
    ...overrides,
  });
}

/** A delivered handoff met with enough silence to conclude something. */
function silentTranscript(): string[] {
  return [
    deliveryRecord(),
    endTurnRecord(),
    endTurnRecord(),
    endTurnRecord(),
    endTurnRecord(),
    endTurnRecord(),
  ];
}

describe('analyze — stale sidecar', () => {
  let dir: string;
  let handoffFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spechub-stale-'));
    handoffFile = join(dir, 'handoff-round-two.md');
    writeFileSync(handoffFile, '# Handoff\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSidecar(overrides: Record<string, unknown> = {}): void {
    writeFileSync(handoffFile + '.ack', ackJson(overrides));
  }

  it('ignores a sidecar stamped before ackAfter, concluding from the transcript instead', () => {
    writeSidecar({ at: new Date(Date.now() - AN_HOUR).toISOString() });
    const result = analyze(silentTranscript(), {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      ackAfter: Date.now(),
    });
    expect(result.outcome).toBe('silence');
    expect(result.ack).toBeUndefined();
  });

  it('honours a sidecar stamped after ackAfter', () => {
    writeSidecar({ at: new Date().toISOString(), reason: 'this round' });
    const result = analyze(silentTranscript(), {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      ackAfter: Date.now() - AN_HOUR,
    });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.via).toBe('cli');
    expect(result.ack?.message).toBe('this round');
  });

  it('honours a sidecar stamped at exactly ackAfter — the line is inclusive', () => {
    const at = '2026-08-23T09:00:00.000Z';
    writeSidecar({ at });
    const result = analyze(silentTranscript(), {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      ackAfter: Date.parse(at),
    });
    expect(result.outcome).toBe('acknowledged');
  });

  it('ignores a sidecar one millisecond too old', () => {
    const at = '2026-08-23T09:00:00.000Z';
    writeSidecar({ at });
    const result = analyze(silentTranscript(), {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      ackAfter: Date.parse(at) + 1,
    });
    expect(result.outcome).toBe('silence');
  });

  it('ignores a sidecar whose at cannot be parsed, once ackAfter is set', () => {
    writeSidecar({ at: 'yesterday afternoon' });
    const result = analyze(silentTranscript(), {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      ackAfter: Date.now(),
    });
    expect(result.outcome).toBe('silence');
  });

  it('ignores a sidecar with no at field at all, once ackAfter is set', () => {
    writeFileSync(
      handoffFile + '.ack',
      JSON.stringify({ decision: 'accept', reason: 'undated', sessionId: null })
    );
    const result = analyze(silentTranscript(), {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      ackAfter: Date.now(),
    });
    expect(result.outcome).toBe('silence');
  });

  it('honours an undateable sidecar when no ackAfter is given — nothing to compare it to', () => {
    writeSidecar({ at: 'yesterday afternoon' });
    const result = analyze(silentTranscript(), { token: TOKEN, turns: 5, file: handoffFile });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.via).toBe('cli');
  });

  it('honours an ancient sidecar when no ackAfter is given', () => {
    writeSidecar({ at: new Date(Date.now() - AN_HOUR).toISOString() });
    const result = analyze(silentTranscript(), { token: TOKEN, turns: 5, file: handoffFile });
    expect(result.outcome).toBe('acknowledged');
  });

  it('leaves transcript analysis untouched when ackAfter is set and no sidecar exists', () => {
    const lines = [deliveryRecord(), ackRecord({ message: 'ACCEPT — via the transcript' })];
    const result = analyze(lines, {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      ackAfter: Date.now(),
    });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.via).toBe('text');
  });

  it('falls back to a transcript ACK when the sidecar is too old to count', () => {
    writeSidecar({ at: new Date(Date.now() - AN_HOUR).toISOString(), decision: 'decline' });
    const lines = [deliveryRecord(), ackRecord({ message: 'ACCEPT — this round I will' })];
    const result = analyze(lines, {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      ackAfter: Date.now(),
    });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.via).toBe('text');
    expect(result.ack?.decision).toBe('accept');
  });
});

describe('watch — stale sidecar', () => {
  let dir: string;
  let file: string;
  let handoffFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spechub-stale-watch-'));
    file = join(dir, 'session.jsonl');
    handoffFile = join(dir, 'handoff-round-two.md');
    writeFileSync(handoffFile, '# Handoff\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores a sidecar that was already lying there when the watch began', async () => {
    writeFileSync(handoffFile + '.ack', ackJson({ at: new Date(Date.now() - AN_HOUR).toISOString() }));
    writeFileSync(file, deliveryRecord() + '\n' + endTurnRecord() + '\n' + endTurnRecord() + '\n');
    const result = await watch(file, {
      token: TOKEN,
      turns: 2,
      file: handoffFile,
      pollIntervalMs: 15,
      timeoutMs: 2000,
    });
    expect(result.outcome).toBe('silence');
    expect(result.ack).toBeUndefined();
  });

  it('sees a sidecar written after the watch began', async () => {
    writeFileSync(file, deliveryRecord() + '\n');
    const promise = watch(file, {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      pollIntervalMs: 15,
      timeoutMs: 3000,
    });
    setTimeout(() => {
      writeFileSync(handoffFile + '.ack', ackJson({ reason: 'written during the watch' }));
    }, 40);
    const result = await promise;
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.message).toBe('written during the watch');
  });

  it('replaces a stale sidecar with a fresh one written mid-watch', async () => {
    writeFileSync(
      handoffFile + '.ack',
      ackJson({ at: new Date(Date.now() - AN_HOUR).toISOString(), reason: 'last round' })
    );
    writeFileSync(file, deliveryRecord() + '\n');
    const promise = watch(file, {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      pollIntervalMs: 15,
      timeoutMs: 3000,
    });
    setTimeout(() => {
      writeFileSync(handoffFile + '.ack', ackJson({ reason: 'this round' }));
    }, 40);
    const result = await promise;
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.message).toBe('this round');
  });

  it('honours an explicit ackAfter that predates the sidecar already on disk', async () => {
    writeFileSync(handoffFile + '.ack', ackJson({ at: new Date(Date.now() - AN_HOUR).toISOString() }));
    writeFileSync(file, deliveryRecord() + '\n');
    const result = await watch(file, {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      ackAfter: Date.now() - 2 * AN_HOUR,
      pollIntervalMs: 15,
      timeoutMs: 2000,
    });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.via).toBe('cli');
  });
});

// ===========================================================================
// What the receiver wrote is what the sender reads
// ===========================================================================

describe('the ack round trip', () => {
  let dir: string;
  let handoffFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spechub-roundtrip-'));
    handoffFile = join(dir, 'handoff.md');
    writeFileSync(handoffFile, '# Handoff\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports the reason exactly as writeAck stored it, whitespace already collapsed', () => {
    writeAck({ file: handoffFile, decision: 'accept', reason: 'taking\n  this   on' });
    const result = analyze([deliveryRecord()], { token: TOKEN, turns: 5, file: handoffFile });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.message).toBe('taking this on');
  });

  it('carries a decline and its reason through to the watcher', () => {
    writeAck({ file: handoffFile, decision: 'decline', reason: 'I own conflicting files' });
    const result = analyze([deliveryRecord()], { token: TOKEN, turns: 5, file: handoffFile });
    expect(result.ack?.decision).toBe('decline');
    expect(result.ack?.message).toBe('I own conflicting files');
    expect(result.ack?.via).toBe('cli');
  });

  it('is seen by a watch that started before the ack was written', async () => {
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, deliveryRecord() + '\n');
    const promise = watch(file, {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      pollIntervalMs: 15,
      timeoutMs: 3000,
    });
    setTimeout(() => {
      writeAck({ file: handoffFile, decision: 'accept', reason: 'on it' });
    }, 40);
    const result = await promise;
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.message).toBe('on it');
  });
});

// ===========================================================================
// Engagement by basename
//
// The path the sender knows and the path the receiver types need not match
// character for character — /tmp is a symlink to /private/tmp on macOS, and an
// agent may cite the handoff by name alone. The basename is the part both
// sides always agree on.
// ===========================================================================

describe('analyze — engagement matches the handoff by basename', () => {
  const HANDOFF_FILE = '/tmp/spechub-handoff-x-1.md';

  function silentRunWith(record: string): string[] {
    return [
      deliveryRecord(),
      record,
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
      endTurnRecord(),
    ];
  }

  it('engages on the same file reached by a different prefix', () => {
    // /private/tmp and /tmp are the same directory on macOS. Here the full
    // path is not a substring of the cited one, so only the basename can
    // match them up.
    const result = analyze(
      silentRunWith(
        toolUseRecord({
          name: 'Read',
          input: { file_path: '/private/var/folders/T/spechub-handoff-x-1.md' },
        })
      ),
      { token: TOKEN, turns: 5, file: HANDOFF_FILE }
    );
    expect(result.outcome).toBe('engaged');
    expect(result.engaged).toBe(true);
  });

  it('engages when the cited path merely shares the prefix, too', () => {
    const result = analyze(
      silentRunWith(
        toolUseRecord({ name: 'Read', input: { file_path: '/private/tmp/spechub-handoff-x-1.md' } })
      ),
      { token: TOKEN, turns: 5, file: HANDOFF_FILE }
    );
    expect(result.outcome).toBe('engaged');
  });

  it('engages when the handoff is cited by bare name', () => {
    const result = analyze(
      silentRunWith(
        toolUseRecord({
          name: 'Grep',
          input: { pattern: 'TODO', note: 'per spechub-handoff-x-1.md' },
        })
      ),
      { token: TOKEN, turns: 5, file: HANDOFF_FILE }
    );
    expect(result.outcome).toBe('engaged');
  });

  it('stays silent for a different file in the same directory', () => {
    const result = analyze(
      silentRunWith(
        toolUseRecord({ name: 'Read', input: { file_path: '/tmp/spechub-handoff-x-2.md' } })
      ),
      { token: TOKEN, turns: 5, file: HANDOFF_FILE }
    );
    expect(result.outcome).toBe('silence');
    expect(result.engaged).toBe(false);
  });
});

// ===========================================================================
// startedAt
//
// The watch reports when it began. The caller needs that number to restart a
// watch across a nudge without losing an ack: the receiver may write its
// sidecar in the gap between one watch ending and the next beginning, and the
// second watch is told to accept anything from the first one's start onward.
// Without it there is nothing to pass back in.
// ===========================================================================

describe('watch — startedAt', () => {
  let dir: string;
  let file: string;
  let handoffFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spechub-startedat-'));
    file = join(dir, 'session.jsonl');
    handoffFile = join(dir, 'handoff.md');
    writeFileSync(handoffFile, '# Handoff\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports the moment the watch began on an acknowledged result', async () => {
    writeFileSync(file, deliveryRecord() + '\n' + ackRecord({ message: 'ACCEPT' }) + '\n');
    const before = Date.now();
    const result = await watch(file, {
      token: TOKEN,
      turns: 5,
      pollIntervalMs: 15,
      timeoutMs: 2000,
    });
    const after = Date.now();
    expect(result.outcome).toBe('acknowledged');
    expect(typeof result.startedAt).toBe('number');
    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.startedAt).toBeLessThanOrEqual(after);
  });

  it('reports it on a silence result', async () => {
    writeFileSync(file, deliveryRecord() + '\n' + endTurnRecord() + '\n' + endTurnRecord() + '\n');
    const before = Date.now();
    const result = await watch(file, { token: TOKEN, turns: 2, pollIntervalMs: 15, timeoutMs: 2000 });
    expect(result.outcome).toBe('silence');
    expect(result.startedAt).toBeGreaterThanOrEqual(before);
  });

  it('reports it on an engaged result', async () => {
    writeFileSync(
      file,
      deliveryRecord() +
        '\n' +
        toolUseRecord({ name: 'Edit' }) +
        '\n' +
        endTurnRecord() +
        '\n' +
        endTurnRecord() +
        '\n'
    );
    const before = Date.now();
    const result = await watch(file, { token: TOKEN, turns: 2, pollIntervalMs: 15, timeoutMs: 2000 });
    expect(result.outcome).toBe('engaged');
    expect(result.startedAt).toBeGreaterThanOrEqual(before);
  });

  it('reports it on a timeout result', async () => {
    writeFileSync(file, deliveryRecord() + '\n');
    const before = Date.now();
    const result = await watch(file, { token: TOKEN, turns: 5, pollIntervalMs: 10, timeoutMs: 60 });
    expect(result.outcome).toBe('timeout');
    expect(result.startedAt).toBeGreaterThanOrEqual(before);
  });

  it('is the cutoff a sidecar is measured against: one stamped just before it is ignored', async () => {
    const stampedAt = Date.now() - 1;
    writeFileSync(handoffFile + '.ack', ackJson({ at: new Date(stampedAt).toISOString() }));
    writeFileSync(file, deliveryRecord() + '\n');
    const result = await watch(file, {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      pollIntervalMs: 10,
      timeoutMs: 80,
    });
    expect(result.outcome).toBe('timeout');
    expect(result.startedAt).toBeGreaterThan(stampedAt);
  });

  it('accepts a sidecar stamped at or after it', async () => {
    writeFileSync(file, deliveryRecord() + '\n');
    const promise = watch(file, {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      pollIntervalMs: 10,
      timeoutMs: 3000,
    });
    let stampedAt = 0;
    setTimeout(() => {
      stampedAt = Date.now();
      writeFileSync(handoffFile + '.ack', ackJson({ at: new Date(stampedAt).toISOString() }));
    }, 40);
    const result = await promise;
    expect(result.outcome).toBe('acknowledged');
    expect(result.startedAt).toBeLessThanOrEqual(stampedAt);
  });

  it('reports when the watch began, not the ackAfter it was handed', async () => {
    // startedAt is a fact about this watch. An explicit ackAfter changes what
    // counts as fresh; it does not rewrite when the watch started.
    const ackAfter = Date.now() - 2 * AN_HOUR;
    writeFileSync(file, deliveryRecord() + '\n');
    const before = Date.now();
    const result = await watch(file, {
      token: TOKEN,
      turns: 5,
      ackAfter,
      pollIntervalMs: 10,
      timeoutMs: 60,
    });
    expect(result.startedAt).toBeGreaterThanOrEqual(before);
    expect(result.startedAt).not.toBe(ackAfter);
  });

  it('lets an explicit ackAfter reach back past the watch start — the nudge-restart gap', async () => {
    // The receiver wrote its ack while no watch was running. The restarted
    // watch is told to accept anything from the first watch's start onward,
    // and so it sees it.
    const wroteAckAt = Date.now();
    writeFileSync(handoffFile + '.ack', ackJson({ at: new Date(wroteAckAt).toISOString() }));
    writeFileSync(file, deliveryRecord() + '\n');
    const result = await watch(file, {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      ackAfter: wroteAckAt - 1000,
      pollIntervalMs: 10,
      timeoutMs: 2000,
    });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.via).toBe('cli');
    // At or after, not strictly after: the ack is stamped, two files are
    // written and the watch starts, and all of that can land inside one
    // millisecond. The point being made is that the ack predates the watch,
    // and the acknowledged outcome above is what actually carries it.
    expect(result.startedAt).toBeGreaterThanOrEqual(wroteAckAt);
  });
});

// ===========================================================================
// The launch, not the watch, starts a fresh round
//
// A launched agent is told to acknowledge before doing anything else, and the
// sender cannot start watching until it has recovered the new session id.
// Those two facts put the ack roughly half a minute before the watch. Dating
// the round from the watch discarded that ack and reported a live, accepting
// agent as unacknowledged. Fresh mode reads the launch off the target's own
// transcript instead.
// ===========================================================================

/** An assistant end_turn record stamped at a given instant. */
function stampedTurn(at: number): string {
  return endTurnRecord({ timestamp: new Date(at).toISOString() });
}

describe('analyze — fresh mode dates the round by the launch', () => {
  let dir: string;
  let handoffFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spechub-launchcutoff-'));
    handoffFile = join(dir, 'handoff-fresh.md');
    writeFileSync(handoffFile, '# Handoff\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSidecar(overrides: Record<string, unknown> = {}): void {
    writeFileSync(handoffFile + '.ack', ackJson(overrides));
  }

  it('reports the cut-off it applied, so a discarded ack is never invisible', () => {
    const launchedAt = Date.now() - 60 * 1000;
    const result = analyze([stampedTurn(launchedAt)], { fresh: true, turns: 5, file: handoffFile });
    expect(result.ackAfter).toBe(launchedAt);
  });

  it('takes the launch from the earliest timestamped record, past untimestamped metadata', () => {
    const launchedAt = Date.now() - 60 * 1000;
    const metadata = JSON.stringify({ type: 'mode', mode: 'default' });
    const result = analyze([metadata, stampedTurn(launchedAt)], {
      fresh: true,
      turns: 5,
      file: handoffFile,
    });
    expect(result.ackAfter).toBe(launchedAt);
  });

  it('honours an ack written after the launch but long before any watch could start', () => {
    const launchedAt = Date.now() - 60 * 1000;
    writeSidecar({ at: new Date(launchedAt + 3000).toISOString(), reason: 'took it straight away' });
    const result = analyze([stampedTurn(launchedAt)], { fresh: true, turns: 5, file: handoffFile });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.via).toBe('cli');
    expect(result.ack?.message).toBe('took it straight away');
  });

  it('still ignores a previous target’s decline, which predates this launch', () => {
    const declinedAt = Date.now() - 120 * 1000;
    const launchedAt = Date.now() - 60 * 1000;
    writeSidecar({ decision: 'decline', at: new Date(declinedAt).toISOString(), reason: 'wrong scope' });
    const result = analyze([stampedTurn(launchedAt), stampedTurn(launchedAt + 1000)], {
      fresh: true,
      turns: 2,
      file: handoffFile,
    });
    expect(result.outcome).toBe('silence');
    expect(result.ack).toBeUndefined();
  });

  it('counts nothing while the transcript has not begun — no sidecar can be its answer yet', () => {
    writeSidecar({ at: new Date().toISOString() });
    const result = analyze([], { fresh: true, turns: 5, file: handoffFile });
    expect(result.ackAfter).toBe(Number.POSITIVE_INFINITY);
    expect(result.outcome).toBe('pending');
    expect(result.ack).toBeUndefined();
  });

  it('lets an explicit ackAfter override the launch it read', () => {
    const launchedAt = Date.now() - 60 * 1000;
    const explicit = Date.now();
    writeSidecar({ at: new Date(launchedAt + 3000).toISOString() });
    const result = analyze([stampedTurn(launchedAt)], {
      fresh: true,
      turns: 5,
      file: handoffFile,
      ackAfter: explicit,
    });
    expect(result.ackAfter).toBe(explicit);
    expect(result.outcome).toBe('pending');
    expect(result.ack).toBeUndefined();
    expect(result.staleAck?.decision).toBe('accept');
  });

  it('leaves token mode with no cut-off of its own', () => {
    const result = analyze([deliveryRecord()], { token: TOKEN, turns: 5, file: handoffFile });
    expect(result.ackAfter).toBeUndefined();
  });
});

describe('watch — fresh mode honours an ack written before the watch started', () => {
  let dir: string;
  let file: string;
  let handoffFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spechub-launchwatch-'));
    file = join(dir, 'session.jsonl');
    handoffFile = join(dir, 'handoff-fresh.md');
    writeFileSync(handoffFile, '# Handoff\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports acknowledged, not timeout, when the target acked 40 seconds before the watch', async () => {
    const launchedAt = Date.now() - 60 * 1000;
    writeFileSync(file, stampedTurn(launchedAt) + '\n');
    writeFileSync(
      handoffFile + '.ack',
      ackJson({ at: new Date(launchedAt + 3000).toISOString(), reason: 'taking the OneNote map' })
    );
    const result = await watch(file, {
      fresh: true,
      turns: 5,
      file: handoffFile,
      pollIntervalMs: 10,
      timeoutMs: 300,
    });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.decision).toBe('accept');
    expect(result.ack?.message).toBe('taking the OneNote map');
  });

  it('keeps ignoring a decline that predates the launch', async () => {
    const launchedAt = Date.now() - 60 * 1000;
    writeFileSync(file, stampedTurn(launchedAt) + '\n' + stampedTurn(launchedAt + 1000) + '\n');
    writeFileSync(
      handoffFile + '.ack',
      ackJson({
        decision: 'decline',
        at: new Date(launchedAt - 60 * 1000).toISOString(),
        reason: 'last round said no',
      })
    );
    const result = await watch(file, {
      fresh: true,
      turns: 2,
      file: handoffFile,
      pollIntervalMs: 10,
      timeoutMs: 300,
    });
    expect(result.outcome).toBe('silence');
    expect(result.ack).toBeUndefined();
  });

  it('sees an ack appended live, once the transcript names the launch', async () => {
    const launchedAt = Date.now();
    writeFileSync(file, stampedTurn(launchedAt) + '\n');
    const promise = watch(file, {
      fresh: true,
      turns: 5,
      file: handoffFile,
      pollIntervalMs: 15,
      timeoutMs: 3000,
    });
    setTimeout(() => {
      writeFileSync(handoffFile + '.ack', ackJson({ reason: 'written during the watch' }));
    }, 40);
    const result = await promise;
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.message).toBe('written during the watch');
  });

  it('token mode still dates its round by the watch', async () => {
    writeFileSync(
      handoffFile + '.ack',
      ackJson({ at: new Date(Date.now() - AN_HOUR).toISOString() })
    );
    writeFileSync(file, deliveryRecord() + '\n' + endTurnRecord() + '\n' + endTurnRecord() + '\n');
    const result = await watch(file, {
      token: TOKEN,
      turns: 2,
      file: handoffFile,
      pollIntervalMs: 10,
      timeoutMs: 300,
    });
    expect(result.outcome).toBe('silence');
    expect(result.ack).toBeUndefined();
  });
});

// ===========================================================================
// staleAck: a discarded sidecar is reported, never swallowed
//
// A watch that returns "no answer" while an answer sits on disk is the one
// report that must be impossible. Whatever the cut-off rules out still comes
// back, on the result, beside the outcome it did not change.
// ===========================================================================

describe('analyze — staleAck', () => {
  let dir: string;
  let handoffFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spechub-staleack-'));
    handoffFile = join(dir, 'handoff.md');
    writeFileSync(handoffFile, '# Handoff\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeSidecar(overrides: Record<string, unknown> = {}): void {
    writeFileSync(handoffFile + '.ack', ackJson(overrides));
  }

  it('reports a sidecar the cut-off ruled out, with its decision and its instant', () => {
    const at = new Date(Date.now() - AN_HOUR).toISOString();
    writeSidecar({ at, decision: 'accept', reason: 'ruled out by the cut-off' });
    const result = analyze(silentTranscript(), {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      ackAfter: Date.now(),
    });
    expect(result.outcome).toBe('silence');
    expect(result.ack).toBeUndefined();
    expect(result.staleAck?.decision).toBe('accept');
    expect(result.staleAck?.reason).toBe('ruled out by the cut-off');
    expect(result.staleAck?.at).toBe(at);
    expect(result.staleAck?.via).toBe('cli');
  });

  it('reports an undateable sidecar as stale rather than dropping it', () => {
    writeSidecar({ at: 'yesterday afternoon' });
    const result = analyze(silentTranscript(), {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      ackAfter: Date.now(),
    });
    expect(result.outcome).toBe('silence');
    expect(result.staleAck?.at).toBe('yesterday afternoon');
  });

  it('leaves staleAck unset when the sidecar counted', () => {
    writeSidecar({ at: new Date().toISOString() });
    const result = analyze(silentTranscript(), {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      ackAfter: Date.now() - AN_HOUR,
    });
    expect(result.outcome).toBe('acknowledged');
    expect(result.staleAck).toBeUndefined();
  });

  it('leaves staleAck unset when no sidecar exists', () => {
    const result = analyze(silentTranscript(), {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      ackAfter: Date.now(),
    });
    expect(result.outcome).toBe('silence');
    expect(result.staleAck).toBeUndefined();
  });

  it('reports it beside a transcript ACK that won instead', () => {
    writeSidecar({ at: new Date(Date.now() - AN_HOUR).toISOString(), decision: 'decline' });
    const lines = [deliveryRecord(), ackRecord({ message: 'ACCEPT — this round I will' })];
    const result = analyze(lines, {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      ackAfter: Date.now(),
    });
    expect(result.ack?.via).toBe('text');
    expect(result.staleAck?.decision).toBe('decline');
  });
});

describe('watch — staleAck rides on the negative outcomes', () => {
  let dir: string;
  let file: string;
  let handoffFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spechub-staleackwatch-'));
    file = join(dir, 'session.jsonl');
    handoffFile = join(dir, 'handoff.md');
    writeFileSync(handoffFile, '# Handoff\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('carries the discarded sidecar on a timeout', async () => {
    writeFileSync(
      handoffFile + '.ack',
      ackJson({ at: new Date(Date.now() - AN_HOUR).toISOString(), reason: 'from last round' })
    );
    writeFileSync(file, deliveryRecord() + '\n');
    const result = await watch(file, {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      pollIntervalMs: 10,
      timeoutMs: 60,
    });
    expect(result.outcome).toBe('timeout');
    expect(result.ack).toBeUndefined();
    expect(result.staleAck?.reason).toBe('from last round');
  });

  it('carries it on a silence', async () => {
    writeFileSync(
      handoffFile + '.ack',
      ackJson({ at: new Date(Date.now() - AN_HOUR).toISOString(), reason: 'from last round' })
    );
    writeFileSync(file, deliveryRecord() + '\n' + endTurnRecord() + '\n' + endTurnRecord() + '\n');
    const result = await watch(file, {
      token: TOKEN,
      turns: 2,
      file: handoffFile,
      pollIntervalMs: 10,
      timeoutMs: 500,
    });
    expect(result.outcome).toBe('silence');
    expect(result.staleAck?.reason).toBe('from last round');
  });

  it('drops it once a sidecar that counts replaces it', async () => {
    writeFileSync(
      handoffFile + '.ack',
      ackJson({ at: new Date(Date.now() - AN_HOUR).toISOString(), reason: 'last round' })
    );
    writeFileSync(file, deliveryRecord() + '\n');
    const promise = watch(file, {
      token: TOKEN,
      turns: 5,
      file: handoffFile,
      pollIntervalMs: 15,
      timeoutMs: 3000,
    });
    setTimeout(() => {
      writeFileSync(handoffFile + '.ack', ackJson({ reason: 'this round' }));
    }, 40);
    const result = await promise;
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.message).toBe('this round');
    expect(result.staleAck).toBeUndefined();
  });
});
