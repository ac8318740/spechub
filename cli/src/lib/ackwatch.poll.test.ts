import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The poll interval is a floor, not a suggestion.
//
// `watch` runs for up to half an hour beside a working agent. A caller that
// passes 0 — a shell default, a missing flag, an over-eager caller wanting to
// hear back sooner — must not turn that into a loop that re-reads the
// transcript as fast as the event loop will let it, for thirty minutes.
//
// The observable is how often it goes to the filesystem, so this file counts
// filesystem calls. It lives apart from ackwatch.test.ts because the counting
// is done by mocking node:fs, which is a per-file decision.
// ---------------------------------------------------------------------------

const counter = vi.hoisted(() => ({ calls: 0 }));

// Count every trip to the filesystem. How often `watch` goes back to the disk
// is the only outward sign of how fast its loop is turning.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (path: string) => {
      counter.calls += 1;
      return actual.readFileSync(path, 'utf-8');
    },
    statSync: (path: string) => {
      counter.calls += 1;
      return actual.statSync(path);
    },
    existsSync: (path: string) => {
      counter.calls += 1;
      return actual.existsSync(path);
    },
  };
});

import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch } from './ackwatch.js';

const TOKEN = 'xk-correlate-9f3a';

function deliveryRecord(): string {
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'remove',
    content: `<cross-session-message from="session-abc">Pick this up. ref:${TOKEN}</cross-session-message>`,
  });
}

function ackRecord(message: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'session-abc', message } }],
    },
  });
}

describe('watch — a poll interval of zero', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spechub-ackwatch-poll-'));
    file = join(dir, 'session.jsonl');
    counter.calls = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not re-read the transcript as fast as it can', async () => {
    writeFileSync(file, deliveryRecord() + '\n');
    counter.calls = 0;
    const result = await watch(file, {
      token: TOKEN,
      turns: 5,
      pollIntervalMs: 0,
      timeoutMs: 200,
    });
    expect(result.outcome).toBe('timeout');
    // The budget has to clear the honest cost of a floored loop without
    // admitting an unfloored one. At a 10ms floor a 200ms watch turns about
    // 20 times, and a tick that both stats and reads costs two calls — so
    // roughly 40. Unfloored, the loop turns once per millisecond and costs
    // hundreds. 60 sits in the gap, and is not a claim about how many calls
    // one tick should make.
    expect(counter.calls).toBeLessThanOrEqual(60);
  });

  it('still honours the overall timeout rather than returning early', async () => {
    writeFileSync(file, deliveryRecord() + '\n');
    const start = Date.now();
    const result = await watch(file, {
      token: TOKEN,
      turns: 5,
      pollIntervalMs: 0,
      timeoutMs: 200,
    });
    expect(result.outcome).toBe('timeout');
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
  });

  it('still notices an acknowledgement', async () => {
    writeFileSync(file, deliveryRecord() + '\n');
    setTimeout(() => {
      appendFileSync(file, ackRecord('ACCEPT — got it') + '\n');
    }, 40);
    const result = await watch(file, {
      token: TOKEN,
      turns: 5,
      pollIntervalMs: 0,
      timeoutMs: 4000,
    });
    expect(result.outcome).toBe('acknowledged');
    expect(result.ack?.decision).toBe('accept');
  });
});
