import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcriptPath, parseAck, analyze, watch } from './ackwatch.js';

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
