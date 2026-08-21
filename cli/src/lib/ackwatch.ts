// Acknowledgement watching: did the agent we handed work to actually pick it up?
//
// A handoff is delivered as a cross-session message. The target either replies
// with a SendMessage acknowledgement or says nothing. This module reads the
// target's Claude Code transcript – the JSONL file Claude Code appends one
// record per line to – and reports which of those happened.
//
// Three pieces, smallest first:
//   transcriptPath  – where Claude Code keeps a session's transcript
//   parseAck        – ACCEPT/DECLINE plus a reason, out of free text
//   analyze         – the whole decision, as a pure function over lines
//   watch           – a polling loop that re-reads the file and calls analyze
//
// The loop re-reads the entire file every tick rather than tailing it. A
// transcript is modest in size, and polling behaves the same on every editor
// and filesystem, where fs.watch does not.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type AckDecision = 'accept' | 'decline';

/** Outcomes analyze can report over the lines it has been given so far. */
export type AnalyzeOutcome = 'acknowledged' | 'silence' | 'pending';

/** Outcomes watch resolves with – it never returns while still pending. */
export type WatchOutcome = 'acknowledged' | 'silence' | 'timeout';

export interface ParsedAck {
  decision: AckDecision | null;
  reason: string | null;
}

export interface Ack extends ParsedAck {
  /**
   * Recipient the target addressed the acknowledgement to (SendMessage `to`).
   * `null` for a fresh-mode text ACK, which has no recipient to address —
   * a freshly launched agent has no handle for the launching session.
   */
  to: string | null;
  /** Raw acknowledgement text, before decision parsing. */
  message: string;
}

export interface AnalyzeOptions {
  /**
   * Correlation token embedded in the delivered message. Anchors the analysis
   * at the moment that message was actually delivered. Mutually exclusive with
   * `fresh`.
   */
  token?: string;
  /**
   * The target was launched for this handoff, so the whole transcript belongs
   * to it and the anchor is its first record. Mutually exclusive with `token`.
   */
  fresh?: boolean;
  /** Turn boundaries to allow before calling it silence. Default 5. */
  turns?: number;
}

export interface WatchOptions extends AnalyzeOptions {
  /** Milliseconds between re-reads of the transcript. Default 1000. */
  pollIntervalMs?: number;
  /** Milliseconds before giving up entirely. Default 30 minutes. */
  timeoutMs?: number;
}

export interface AnalyzeResult {
  outcome: AnalyzeOutcome;
  /** Whether the record the analysis counts from has appeared yet. */
  anchored: boolean;
  /** Turn boundaries seen at or after the anchor, capped at `turns`. */
  turnsElapsed: number;
  ack?: Ack;
}

/**
 * What `watch` resolves with: the same shape `analyze` reports, with the
 * outcome narrowed to the ones a finished watch can end on. Defined off
 * `AnalyzeResult` so the two never drift apart as fields are added.
 */
export interface WatchResult extends Omit<AnalyzeResult, 'outcome'> {
  outcome: WatchOutcome;
}

// The single source of truth for these defaults. The CLI imports them rather
// than re-typing the numbers in its flag definitions.
export const DEFAULT_TURNS = 5;
export const DEFAULT_POLL_INTERVAL_MS = 1000;
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

const CROSS_SESSION_PREFIX = '<cross-session-message';

/**
 * Where Claude Code stores a session's transcript.
 *
 * The directory name is the absolute working directory with every
 * non-alphanumeric character replaced by a dash – so `/home/u/my.repo`
 * becomes `-home-u-my-repo`.
 */
export function transcriptPath(cwd: string, sessionId: string, projectsDir?: string): string {
  const base = projectsDir ?? join(homedir(), '.claude', 'projects');
  return join(base, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}

// A decision only counts when it leads the message – "I will not accept this"
// is not a decline. Any run of separator punctuation between the keyword and
// the reason is swallowed, so "ACCEPT — x", "ACCEPT: x" and "ACCEPT, x" agree.
const ACK_PATTERN = /^\s*(accept|decline)\b[\s]*[:,;.\-–—!]*\s*([\s\S]*)$/i;

/** Pull a leading ACCEPT/DECLINE and the reason that follows it out of free text. */
export function parseAck(text: string): ParsedAck {
  const match = ACK_PATTERN.exec(text ?? '');
  if (!match) return { decision: null, reason: null };
  const decision = match[1].toLowerCase() as AckDecision;
  const reason = match[2].trim();
  return { decision, reason: reason.length > 0 ? reason : null };
}

interface TranscriptRecord {
  type?: string;
  operation?: string;
  content?: unknown;
  isSidechain?: boolean;
  message?: {
    stop_reason?: string | null;
    content?: unknown;
  };
}

/** Parse the lines we can and drop the ones we cannot – a transcript is often mid-write. */
function parseLines(lines: string[]): TranscriptRecord[] {
  const records: TranscriptRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') {
        records.push(parsed as TranscriptRecord);
      }
    } catch {
      // Truncated or garbage line – ignore it and keep going.
    }
  }
  return records;
}

/**
 * Sidechain records are subagent activity, not the target agent talking. They
 * count for nothing: not as an acknowledgement, not as a turn boundary.
 */
function isSidechain(record: TranscriptRecord): boolean {
  return record.isSidechain === true;
}

function isDelivery(record: TranscriptRecord, token: string): boolean {
  if (record.type !== 'queue-operation' || record.operation !== 'remove') return false;
  const content = record.content;
  if (typeof content !== 'string') return false;
  return content.startsWith(CROSS_SESSION_PREFIX) && content.includes(token);
}

/** A completed assistant turn – not every assistant record, only the ones that ended one. */
function isTurnBoundary(record: TranscriptRecord): boolean {
  return record.type === 'assistant' && record.message?.stop_reason === 'end_turn';
}

function findSendMessage(record: TranscriptRecord): Ack | undefined {
  if (record.type !== 'assistant') return undefined;
  const content = record.message?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const { type, name, input } = block as {
      type?: string;
      name?: string;
      input?: { to?: unknown; message?: unknown };
    };
    if (type !== 'tool_use' || name !== 'SendMessage') continue;
    const to = typeof input?.to === 'string' ? input.to : '';
    const message = typeof input?.message === 'string' ? input.message : '';
    return { to, message, ...parseAck(message) };
  }
  return undefined;
}

/**
 * Fresh mode only: a plain assistant TEXT block that leads with ACCEPT or
 * DECLINE also counts as an ACK. A freshly launched agent has no handle for
 * the launching session, so it has no SendMessage recipient to address – it
 * can only speak the acknowledgement as ordinary text. Reuses `parseAck` so
 * the leading-match rule (and its mid-sentence exclusion) never drifts
 * between the two forms.
 */
function findTextAck(record: TranscriptRecord): Ack | undefined {
  if (record.type !== 'assistant') return undefined;
  const content = record.message?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const { type, text } = block as { type?: string; text?: unknown };
    if (type !== 'text' || typeof text !== 'string') continue;
    const parsed = parseAck(text);
    if (parsed.decision === null) continue;
    return { to: null, message: text, ...parsed };
  }
  return undefined;
}

function resolveAnchor(records: TranscriptRecord[], options: AnalyzeOptions): number {
  if (options.fresh) return records.length > 0 ? 0 : -1;
  // Safe: `requireOneMode` has already run, so with `fresh` unset the token is
  // present and non-empty.
  const token = options.token as string;
  return records.findIndex(record => !isSidechain(record) && isDelivery(record, token));
}

/**
 * The canonical rule for the two anchoring modes: exactly one of `token` or
 * `fresh`. The CLI checks the same thing up front so it can print a red error
 * instead of a stack trace – change the two together.
 */
function requireOneMode(options: AnalyzeOptions): void {
  const hasToken = typeof options.token === 'string' && options.token.length > 0;
  const hasFresh = Boolean(options.fresh);
  if (hasToken && hasFresh) {
    throw new Error('Pass either a token or fresh, not both.');
  }
  if (!hasToken && !hasFresh) {
    throw new Error('Pass a token (anchor on delivery) or fresh (anchor at transcript start).');
  }
}

/**
 * Decide, over the transcript lines read so far, whether the handoff was
 * acknowledged, met with silence, or is still in flight.
 *
 * Pure: no clock, no filesystem. The loop in `watch` supplies fresh lines.
 */
export function analyze(lines: string[], options: AnalyzeOptions): AnalyzeResult {
  requireOneMode(options);
  const turns = options.turns ?? DEFAULT_TURNS;
  const records = parseLines(lines);
  const anchor = resolveAnchor(records, options);

  // Nothing to count from yet – the message is still queued, so silence is not
  // a conclusion we are entitled to draw.
  if (anchor < 0) {
    return { outcome: 'pending', anchored: false, turnsElapsed: 0 };
  }

  let boundaries = 0;
  for (let i = anchor; i < records.length; i += 1) {
    const record = records[i];
    if (isSidechain(record)) continue;
    const ack = findSendMessage(record) ?? (options.fresh ? findTextAck(record) : undefined);
    if (ack) {
      return {
        outcome: 'acknowledged',
        anchored: true,
        turnsElapsed: Math.min(boundaries, turns),
        ack,
      };
    }
    if (isTurnBoundary(record)) boundaries += 1;
  }

  const turnsElapsed = Math.min(boundaries, turns);
  return {
    outcome: turnsElapsed >= turns ? 'silence' : 'pending',
    anchored: true,
    turnsElapsed,
  };
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf-8').split('\n');
  } catch (err) {
    // Only "the file is not there" means "not written yet": a freshly launched
    // agent writes its transcript on its first record, so absent and empty are
    // the same thing to us. Every other failure – EACCES, EISDIR,
    // ERR_STRING_TOO_LONG – means the path is broken, and swallowing it would
    // turn a typo into a 30-minute wait that then reads as "no ack". Rethrow
    // instead: `watch` propagates it and the CLI turns it into a red exit 1.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll a transcript until the handoff is acknowledged, N turns pass without a
 * word, or the overall timeout elapses.
 */
export async function watch(path: string, options: WatchOptions = {}): Promise<WatchResult> {
  requireOneMode(options);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  let last: AnalyzeResult = { outcome: 'pending', anchored: false, turnsElapsed: 0 };

  for (;;) {
    last = analyze(readLines(path), options);
    if (last.outcome === 'acknowledged' || last.outcome === 'silence') {
      // Restating `outcome` is not redundant: the spread copies the field at its
      // declared `AnalyzeOutcome` type, which includes 'pending' and so does not
      // fit `WatchResult`. Assigning it again carries the narrowing above through.
      return { ...last, outcome: last.outcome };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { outcome: 'timeout', anchored: last.anchored, turnsElapsed: last.turnsElapsed };
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}
