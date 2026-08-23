// Acknowledgement watching: did the agent we handed work to actually pick it up?
//
// A handoff is delivered as a cross-session message. The target answers in one
// of two places: it runs `spechub handoff ack`, which writes a sidecar beside
// the handoff file, or it speaks into its own transcript – the JSONL file
// Claude Code appends one record per line to. This module reads both and
// reports what the target did, said, or failed to say.
//
// Three pieces, smallest first:
//   transcriptPath  – where Claude Code keeps a session's transcript
//   parseAck        – ACCEPT/DECLINE plus a reason, out of free text
//   analyze         – the whole decision, over the lines and the sidecar
//   watch           – a polling loop that re-reads both and calls analyze
//
// The loop re-reads the entire file every tick rather than tailing it. A
// transcript is modest in size, and polling behaves the same on every editor
// and filesystem, where fs.watch does not.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { ACK_DECISIONS, readAck } from './ackfile.js';
import type { AckDecision } from './ackfile.js';

// The decision vocabulary belongs with the sidecar that records it. Re-exported
// because this module is where callers first found it.
export type { AckDecision } from './ackfile.js';

/**
 * Outcomes analyze can report over the evidence it has so far.
 *
 * `engaged` is silence with a caveat: nobody said anything, but somebody is
 * plainly working. It exists so the sender nudges the quiet and leaves the
 * busy alone.
 */
export type AnalyzeOutcome = 'acknowledged' | 'silence' | 'engaged' | 'pending';

/** Outcomes watch resolves with – it never returns while still pending. */
export type WatchOutcome = Exclude<AnalyzeOutcome, 'pending'> | 'timeout';

/**
 * Where an acknowledgement came from. `cli` is the ack sidecar, written by
 * `spechub handoff ack`; `text` is the transcript fallback, matched on a
 * leading keyword.
 */
export type AckVia = 'cli' | 'text';

export interface ParsedAck {
  decision: AckDecision | null;
  reason: string | null;
}

export interface Ack extends ParsedAck {
  /** Which channel carried the acknowledgement. */
  via: AckVia;
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
  /**
   * Path of the handoff file itself. Two jobs: the ack sidecar is read from
   * `<file>.ack`, and a tool call naming this path counts as the target
   * engaging with the work.
   */
  file?: string;
  /** This target has already been nudged once. Echoed back, never acted on. */
  nudged?: boolean;
  /**
   * Epoch milliseconds before which a sidecar does not count. A handoff file
   * outlives the round that produced it, so last round's ack is still lying
   * beside it – answering this round's question with a stale yes. `watch`
   * defaults this to the moment it started.
   */
  ackAfter?: number;
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
  /**
   * Evidence the target is working, whatever it has or has not said. Reported
   * on every outcome, so a caller can read it without checking the outcome
   * first.
   */
  engaged: boolean;
  /** The `nudged` option, handed back so the caller can chain watches. */
  nudged: boolean;
  ack?: Ack;
}

/**
 * What `watch` resolves with: the same shape `analyze` reports, with the
 * outcome narrowed to the ones a finished watch can end on. Defined off
 * `AnalyzeResult` so the two never drift apart as fields are added.
 */
export interface WatchResult extends Omit<AnalyzeResult, 'outcome'> {
  outcome: WatchOutcome;
  /**
   * Epoch milliseconds the watch began – a fact about this watch, not an echo
   * of `ackAfter`. A nudge means stopping one watch and starting another, and
   * the receiver may write its ack in the gap where nothing is looking. The
   * caller feeds this back as the next watch's `ackAfter` to close that gap.
   */
  startedAt: number;
}

// The single source of truth for these defaults. The CLI imports them rather
// than re-typing the numbers in its flag definitions.
export const DEFAULT_TURNS = 5;
export const DEFAULT_POLL_INTERVAL_MS = 1000;
/**
 * The shortest interval a caller can ask for. A watch runs for up to half an
 * hour beside a working agent; a caller passing 0 – a shell default, a missing
 * flag – must not turn that into a filesystem call per event-loop turn.
 */
export const MIN_POLL_INTERVAL_MS = 10;
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
const ACK_PATTERN = new RegExp(
  `^\\s*(${ACK_DECISIONS.join('|')})\\b\\s*[:,;.\\-–—!]*\\s*([\\s\\S]*)$`,
  'i'
);

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
        records.push(parsed);
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
    return { to, message, via: 'text', ...parseAck(message) };
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
    return { to: null, message: text, via: 'text', ...parsed };
  }
  return undefined;
}

/**
 * The acknowledgement the transcript carries on this record, if any.
 *
 * With a handoff `file` in play the transcript is a fallback, and what it
 * falls back on is the ACCEPT/DECLINE keyword. A SendMessage that carries no
 * keyword is then just the target talking – it says nothing about the handoff,
 * and treating it as an ack would let "on it, but about that other thing"
 * close the watch. Without a `file` there is no sidecar to prefer, so any
 * SendMessage still counts, as it always has.
 */
function findTranscriptAck(record: TranscriptRecord, options: AnalyzeOptions): Ack | undefined {
  const sent = findSendMessage(record);
  if (sent && (!sidecarIsAuthoritative(options) || sent.decision !== null)) return sent;
  return options.fresh ? findTextAck(record) : undefined;
}

/**
 * Is there a sidecar to defer to? Knowing the handoff file is what makes one
 * possible, so the option is the whole test.
 */
function sidecarIsAuthoritative(options: AnalyzeOptions): boolean {
  return options.file !== undefined;
}

/**
 * The acknowledgement written beside the handoff file, if the target wrote one
 * this round.
 *
 * `ackAfter` is what makes "this round" mean anything: the handoff file, and
 * any sidecar beside it, outlive the watch that produced them, so a second
 * round would otherwise read last round's yes as an answer to a question
 * nobody has answered yet. An undateable sidecar cannot prove it is current,
 * so it fails the same test.
 *
 * The reason is passed through as written – `writeAck` normalises whitespace
 * on the way in, so there is nothing left to tidy here.
 */
function findSidecarAck(file: string, ackAfter: number | undefined): Ack | undefined {
  const record = readAck(file);
  if (record === null) return undefined;
  if (ackAfter !== undefined && !(Date.parse(record.at) >= ackAfter)) return undefined;
  return {
    to: null,
    message: record.reason,
    via: 'cli',
    decision: record.decision,
    reason: record.reason.length > 0 ? record.reason : null,
  };
}

/**
 * Tools that mean work, not reading. A target that spawns an agent, edits,
 * writes or runs a command has started – whatever it failed to say about it.
 */
const ENGAGEMENT_TOOLS = new Set(['Agent', 'Edit', 'Write', 'Bash']);

/**
 * Does this tool call name the handoff file anywhere in its input?
 *
 * Searching the serialized input rather than a known field is deliberate:
 * every tool spells its paths differently (`file_path`, `path`, `command`,
 * a nested array), and the question is only whether the target went near the
 * handoff at all.
 *
 * The basename counts as well as the full path. The same file reaches an agent
 * under more than one spelling – /tmp and /private/tmp on macOS, a bind mount,
 * a path the agent retyped from memory – and a handoff file's name is specific
 * enough that seeing it quoted is evidence in itself.
 */
function mentionsFile(input: unknown, file: string | undefined): boolean {
  if (file === undefined || file.length === 0 || input === undefined) return false;
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? '';
  } catch {
    // Unserializable input – nothing to read, so nothing to conclude.
    return false;
  }
  const name = basename(file);
  return serialized.includes(file) || (name.length > 0 && serialized.includes(name));
}

/** Evidence, on one record, that the target is doing the work. */
function isEngagement(record: TranscriptRecord, file: string | undefined): boolean {
  if (record.type !== 'assistant') return false;
  const content = record.message?.content;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const { type, name, input } = block as { type?: string; name?: string; input?: unknown };
    if (type !== 'tool_use') continue;
    if (typeof name === 'string' && ENGAGEMENT_TOOLS.has(name)) return true;
    if (mentionsFile(input, file)) return true;
  }
  return false;
}

/** Everything one walk of the transcript can tell us about what happened after the anchor. */
interface Scan {
  /** The first acknowledgement spoken into the transcript, if one was. */
  ack?: Ack;
  /** Completed turns before that acknowledgement, or before the end if none came. */
  boundaries: number;
  /** Evidence of work anywhere in the window – it counts after the ack as well as before. */
  engaged: boolean;
}

/**
 * Walk the records once, from the anchor, collecting everything the verdict
 * needs. Sidechain records are subagent activity and count for nothing.
 *
 * Turn counting stops at the acknowledgement, because `turnsElapsed` means how
 * long the target took to answer. Engagement keeps accruing past it: work is
 * work whenever it happened.
 */
function scanFromAnchor(records: TranscriptRecord[], anchor: number, options: AnalyzeOptions): Scan {
  const scan: Scan = { boundaries: 0, engaged: false };
  if (anchor < 0) return scan;
  for (let i = anchor; i < records.length; i += 1) {
    const record = records[i];
    if (isSidechain(record)) continue;
    if (!scan.engaged) scan.engaged = isEngagement(record, options.file);
    if (scan.ack !== undefined) continue;
    scan.ack = findTranscriptAck(record, options);
    if (scan.ack === undefined && isTurnBoundary(record)) scan.boundaries += 1;
  }
  return scan;
}

/**
 * Let the sidecar overrule what the transcript said.
 *
 * It outranks the transcript because it is the deliberate answer – the target
 * ran a command to write it – and it needs no anchor: a target whose delivery
 * record has not landed yet, or that was never given a token, can still have
 * written one.
 */
function withSidecar(result: AnalyzeResult, options: AnalyzeOptions): AnalyzeResult {
  const sidecarAck =
    options.file === undefined ? undefined : findSidecarAck(options.file, options.ackAfter);
  if (sidecarAck === undefined) return result;
  return { ...result, outcome: 'acknowledged', ack: sidecarAck };
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
 * Decide, over the evidence so far, whether the handoff was acknowledged, met
 * with silence, picked up without a word, or is still in flight.
 *
 * Anchor, scan, verdict: find where to count from, walk once, then read the
 * walk. No clock – `watch` supplies fresh lines by calling this again.
 */
export function analyze(lines: string[], options: AnalyzeOptions): AnalyzeResult {
  requireOneMode(options);
  const turns = options.turns ?? DEFAULT_TURNS;
  const records = parseLines(lines);
  const anchor = resolveAnchor(records, options);
  const scan = scanFromAnchor(records, anchor, options);
  const turnsElapsed = Math.min(scan.boundaries, turns);
  const base = {
    anchored: anchor >= 0,
    turnsElapsed,
    engaged: scan.engaged,
    nudged: options.nudged === true,
  };

  // No anchor: the message is still queued, so silence is not a conclusion we
  // are entitled to draw. Otherwise an ack wins, and failing that the absence
  // of one only means something once the turn budget is spent.
  const quiet: AnalyzeOutcome = scan.engaged ? 'engaged' : 'silence';
  const verdict: AnalyzeResult =
    anchor < 0
      ? { ...base, outcome: 'pending' }
      : scan.ack !== undefined
        ? { ...base, outcome: 'acknowledged', ack: scan.ack }
        : { ...base, outcome: turnsElapsed >= turns ? quiet : 'pending' };

  return withSidecar(verdict, options);
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

/**
 * A cheap fingerprint of the transcript – size and last-write time – so a tick
 * can tell "nothing was appended" from "there is more to read" without reading
 * anything. Null means the stat failed, which forces a real read: that is
 * where a broken path turns into the error `readLines` throws.
 */
function stampTranscript(path: string): string | null {
  try {
    const stats = statSync(path);
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll a transcript, and the ack sidecar beside the handoff file, until the
 * handoff is acknowledged, N turns pass without a word, or the overall timeout
 * elapses.
 */
export async function watch(path: string, options: WatchOptions = {}): Promise<WatchResult> {
  requireOneMode(options);
  // A zero or negative interval would spin the loop as fast as the event loop
  // allows, starving the very file writes it is waiting for.
  const pollIntervalMs = Math.max(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const deadline = started + timeoutMs;
  // Only an ack written from now on answers this watch. A sidecar already on
  // disk belongs to a previous round – unless the caller says otherwise, which
  // is how a re-launched watch keeps counting an ack it already has.
  const watched: WatchOptions = { ...options, ackAfter: options.ackAfter ?? started };

  // The last verdict read off the transcript, and the fingerprint it was read
  // from. Anything cached here is pending – a settled verdict returns below –
  // so it is always a transcript-only result the sidecar may still overrule.
  let cached: AnalyzeResult | null = null;
  let cachedStamp: string | null = null;

  for (;;) {
    const stamp = stampTranscript(path);
    let result: AnalyzeResult;
    if (cached === null || stamp === null || stamp !== cachedStamp) {
      cached = analyze(readLines(path), watched);
      cachedStamp = stamp;
      result = cached;
    } else {
      // Nothing was appended since the last parse, so re-reading the transcript
      // would reach the same verdict. The sidecar is another matter: it is
      // written out of band, and it is what most often ends the watch.
      result = withSidecar(cached, watched);
    }

    if (result.outcome !== 'pending') {
      // Restating `outcome` is not redundant: the spread copies the field at its
      // declared `AnalyzeOutcome` type, which includes 'pending' and so does not
      // fit `WatchResult`. Assigning it again carries the narrowing above through.
      return { ...result, outcome: result.outcome, startedAt: started };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ...result, outcome: 'timeout', startedAt: started };
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}
