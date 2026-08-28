// The ack sidecar: how a handoff target says yes or no in writing.
//
// `spechub handoff ack accept|decline --file <handoff-file>` writes a JSON
// record to `<handoff-file>.ack`, and the sender's watcher polls that exact
// path. The naming is the contract between the two halves, so it lives here
// once and both halves import it.
//
// A sidecar beats a transcript keyword because it is deliberate: the target
// had to run a command, not merely happen to type a word.
import { existsSync, readFileSync } from 'node:fs';
import { replaceFileAtomically } from './atomic-file.js';

/**
 * The two things a target can say. One list, so the CLI's validation, the
 * sidecar reader and the transcript keyword pattern can never disagree about
 * what counts as a decision.
 */
export const ACK_DECISIONS = ['accept', 'decline'] as const;

export type AckDecision = (typeof ACK_DECISIONS)[number];

export function isAckDecision(value: unknown): value is AckDecision {
  return typeof value === 'string' && (ACK_DECISIONS as readonly string[]).includes(value);
}

/** What the sidecar holds, and what `readAck` hands back. */
export interface AckRecord {
  decision: AckDecision;
  /** Why. Empty string when the target gave no reason – never undefined. */
  reason: string;
  /** Session that acknowledged, when it knew its own id. */
  sessionId: string | null;
  /** ISO 8601 instant the ack was written. */
  at: string;
}

export interface WriteAckArgs {
  /** Path of the handoff file being acknowledged – not the sidecar path. */
  file: string;
  /**
   * Free text, so a caller can hand over whatever the user typed. Validated
   * here rather than at the type level – the CLI's argument is a string, and
   * casting it before the check would only move the lie upstream.
   */
  decision: string;
  reason?: string;
  /** Overrides CLAUDE_SESSION_ID, which is the usual source. */
  sessionId?: string;
}

/** The sidecar sits at exactly `<handoff-file>.ack`, extension included. */
export const ACK_SUFFIX = '.ack';

export function ackPath(file: string): string {
  return `${file}${ACK_SUFFIX}`;
}

/**
 * Normalise a decision to `accept` or `decline`, or refuse.
 *
 * Case is forgiven – an agent shouting ACCEPT means accept. Anything else is
 * not: "accept this" is a sentence, and reading a decision out of prose is
 * the guesswork the sidecar exists to replace.
 */
function normaliseDecision(value: unknown): AckDecision {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isAckDecision(text)) {
    throw new Error(
      `Invalid decision ${describeValue(value)}. Expected one of: ${ACK_DECISIONS.join(', ')}.`
    );
  }
  return text;
}

/** Quote a rejected value for an error message, whatever type it turned out to be. */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  try {
    return JSON.stringify(value) ?? 'nothing';
  } catch {
    // Circular, or a BigInt – unprintable, and the type is the useful half anyway.
    return 'a non-serialisable value';
  }
}

/** A blank session id is no session id – record it as null rather than '' or '  '. */
function resolveSessionId(explicit?: string): string | null {
  const candidate = (explicit ?? process.env.CLAUDE_SESSION_ID ?? '').trim();
  return candidate.length > 0 ? candidate : null;
}

/**
 * Flatten a reason to one line.
 *
 * The watcher prints this back to whoever handed the work over, so a reason a
 * shell wrapped over three lines has to read as one there. Normalising on the
 * way in means every reader sees the same string – nobody downstream has to
 * remember to tidy it.
 */
function normaliseReason(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Write the sidecar so a poller never catches it half-written, and say what to
 * do instead when the write fails.
 *
 * `replaceFileAtomically` owns the temp file and the rename; this owns the
 * sentence, because a target told only that a path would not open is a target
 * who now has no way to answer at all.
 */
function writeAtomically(path: string, body: string): void {
  try {
    replaceFileAtomically(path, body);
  } catch (err) {
    throw new Error(
      `Could not write the ack sidecar at ${path}: ${(err as Error).message}. ` +
        'Reply with a message beginning ACCEPT or DECLINE instead, so the sender still hears back.'
    );
  }
}

/**
 * Write the ack sidecar next to the handoff file, and return what was written.
 *
 * Refuses when the handoff file is not there: the path is almost always a typo
 * in that case, and a sidecar beside a file nobody is watching is silence with
 * extra steps.
 */
export function writeAck(args: WriteAckArgs): AckRecord {
  const file = typeof args?.file === 'string' ? args.file : '';
  if (file.length === 0) {
    // Flag-neutral: this is the library talking, and commander already names
    // the flag when the CLI is the one that came up short.
    throw new Error('A handoff file path is required.');
  }
  const decision = normaliseDecision(args?.decision);
  if (file.endsWith(ACK_SUFFIX)) {
    // Acking the sidecar would land the answer at <handoff>.ack.ack, where the
    // watcher – polling <handoff>.ack – would never see it.
    throw new Error(
      `That is a sidecar path, not a handoff file. Pass ${file.slice(0, -ACK_SUFFIX.length)} instead.`
    );
  }
  if (!existsSync(file)) {
    throw new Error(`No handoff file at ${file}. Check the path the handoff gave you.`);
  }

  const record: AckRecord = {
    decision,
    reason: normaliseReason(args.reason),
    sessionId: resolveSessionId(args.sessionId),
    at: new Date().toISOString(),
  };
  // Overwrite, never append: the latest decision is the decision.
  writeAtomically(ackPath(file), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * Read the sidecar for a handoff file, or null when there is nothing usable
 * there.
 *
 * A missing or unreadable-as-JSON sidecar is a null, not a throw: the watcher
 * calls this on every poll tick, so "not written yet" and "written but not
 * valid" both have to mean "no ack yet". A path that cannot be read at all is
 * different – see below.
 */
export function readAck(file: string): AckRecord | null {
  let raw: string;
  try {
    raw = readFileSync(ackPath(file), 'utf-8');
  } catch (err) {
    // Absent means "no ack yet", and the watcher should keep waiting. Anything
    // else – EISDIR, EACCES – means the path is wrong, and swallowing it would
    // hide that behind an apparently ordinary silence for the whole timeout.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const { decision, reason, sessionId, at } = parsed as Record<string, unknown>;
  if (!isAckDecision(decision)) return null;
  return {
    decision,
    reason: typeof reason === 'string' ? reason : '',
    sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null,
    at: typeof at === 'string' ? at : '',
  };
}
