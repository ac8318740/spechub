/**
 * What `spechub/project.yaml` holds, and every read and write of it.
 *
 * One writer, one reader, one schema, so a value the command accepts is a
 * value every reader of the file already understands.
 *
 * A write replaces the file rather than emptying it and filling it in, so a
 * process killed mid-write leaves the whole old file. Two writers running at
 * once still race: each reads the file, changes its own key and writes the
 * result, so the second one to finish saves a document that never held the
 * first one's change. Nothing here locks, and that is the accepted cost - a
 * configuration tool is driven by a person at a prompt, and the answer to two
 * of them is to run the second command again.
 */

import {
  accessSync,
  chmodSync,
  // Aliased: `constants` is also the name of this project's own constants
  // module, which this file imports below, and one name for two things in one
  // file reads as a mistake at every use of either.
  constants as fsConstants,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  parse as parseYaml,
  stringify as stringifyYaml,
  YAMLMap,
} from 'yaml';
import {
  ConfigFileError,
  ConfigValidationError,
  invalidEnumValue,
  invalidValue,
  parseBooleanWord,
} from './global-config.js';
import { replaceFileAtomically } from './atomic-file.js';
import { BROWSER_FALLBACK_VALUES, BROWSER_MODE_PRIORITY } from './host-status.js';
import { PROFILES_DIR } from './constants.js';
import { findPluginRoot } from './project.js';
import { ensureDir } from './utils.js';

/**
 * What one numeric `spechub/project.yaml` key accepts.
 *
 * `number` on its own is the constraint on none of these keys, and a value
 * outside the range is not caught anywhere else: the code that dials a port
 * or compares a token count refuses it silently, long after the command that
 * wrote it exited 0. So the bound the reader relies on is stated here, where
 * it can be reported to the person typing the value.
 */
export interface NumberSpec {
  kind: 'number';
  /** Whether a fraction is refused, because the value is counted rather than measured. */
  integer?: true;
  /** The lowest value accepted, inclusive. */
  min?: number;
  /** The highest value accepted, inclusive. */
  max?: number;
}

/**
 * What one `spechub/project.yaml` key accepts.
 *
 * `profile` and `context_thresholds` are their own kinds rather than an enum
 * and a string, because neither set is known at compile time: the profile
 * names come from the `profiles/` directory on disk, and a threshold list is
 * a shape rather than a value.
 */
export type ProjectKeySpec =
  | { kind: 'boolean' }
  | NumberSpec
  | { kind: 'string' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'profile' }
  | { kind: 'thresholds' };

/**
 * A whole count of turns or of tokens, which every `workflow.handoff` numeric
 * key but `context_window` holds.
 *
 * All four are compared and counted rather than measured, so a fraction has
 * no meaning and a negative is a threshold that can never be crossed - or,
 * for `ack_turns`, a wait that is over before it starts. Zero is allowed:
 * none of the four is required to be positive.
 */
const COUNT: NumberSpec = { kind: 'number', integer: true, min: 0 };

/**
 * The key that says whether a UI change is verified in a real browser before
 * it lands.
 *
 * Named here, where the schema and the default table both state it, because
 * `spechub config check` reports the flag and has to name the key the user
 * would go and set. A second spelling over there is a row one rename away
 * from sending the user to a key nothing reads.
 */
export const FRONTEND_VERIFICATION_KEY = 'workflow.frontend_verification';

/**
 * Every key `spechub/project.yaml` holds, in the order docs/config-reference.md
 * documents them. This table is the schema: a key absent from it is a key
 * `spechub config set` refuses, so adding a documented key here is the whole
 * job of teaching the command to write it.
 *
 * Section keys such as `workflow` and `frontend.browser` are deliberately
 * absent. They name a block rather than a value, and the reference gives no
 * spelling for assigning a whole block on a command line.
 */
export const PROJECT_KEYS: Readonly<Record<string, ProjectKeySpec>> = {
  profile: { kind: 'profile' },

  'workflow.spec_sync': { kind: 'boolean' },
  'workflow.grilling.questions': { kind: 'enum', values: ['tool', 'inline'] },
  'workflow.tdd.strict': { kind: 'boolean' },
  'workflow.tdd.orchestrator_strict': { kind: 'boolean' },
  [FRONTEND_VERIFICATION_KEY]: { kind: 'boolean' },
  'workflow.maps.tracker': { kind: 'enum', values: ['github', 'files'] },
  'workflow.maps.persist': { kind: 'boolean' },
  'workflow.handoff.agent': { kind: 'string' },
  'workflow.handoff.ack_turns': COUNT,
  'workflow.handoff.self_invoke': { kind: 'boolean' },
  'workflow.handoff.nudge_warn': COUNT,
  'workflow.handoff.nudge_severe': COUNT,
  'workflow.handoff.nudge_step': COUNT,
  'workflow.handoff.context_thresholds': { kind: 'thresholds' },
  'workflow.handoff.context_window': { kind: 'number', integer: true, min: 1 },

  'commands.test': { kind: 'string' },
  'commands.test_collect': { kind: 'string' },
  'commands.build': { kind: 'string' },
  'commands.lint': { kind: 'string' },
  'commands.typecheck': { kind: 'string' },
  'commands.format': { kind: 'string' },

  'directories.source': { kind: 'string' },
  'directories.tests': { kind: 'string' },

  'test_markers.exclude': { kind: 'string' },
  'venv.activate': { kind: 'string' },

  'frontend.directory': { kind: 'string' },
  'frontend.dev_server_url': { kind: 'string' },
  'frontend.dev_server_check': { kind: 'string' },
  'frontend.helpers_dir': { kind: 'string' },
  'frontend.commands.dev': { kind: 'string' },
  'frontend.commands.build': { kind: 'string' },
  'frontend.commands.lint': { kind: 'string' },
  'frontend.commands.test': { kind: 'string' },
  // Both lists come from host-status.ts, which owns the mode names and reads
  // them at run time. A schema spelling them again would be a second list to
  // keep in step, and the file that resolves a mode would not know it existed.
  'frontend.browser.mode': { kind: 'enum', values: BROWSER_MODE_PRIORITY },
  'frontend.browser.fallback': { kind: 'enum', values: BROWSER_FALLBACK_VALUES },
  'frontend.browser.cdp_port': { kind: 'number', integer: true, min: 1, max: 65535 },
};

/** Every project key, in schema order, for a message that has to name them. */
export const PROJECT_KEY_LIST: readonly string[] = Object.keys(PROJECT_KEYS);

/** The spec for `key`, or undefined when the project schema does not know it. */
export function projectKeySpec(key: string): ProjectKeySpec | undefined {
  return PROJECT_KEYS[key];
}

/** The profile names `profiles/` offers, or an empty list when it cannot be read. */
function profileNames(): readonly string[] {
  const pluginRoot = findPluginRoot();
  if (!pluginRoot) return [];
  const dir = join(pluginRoot, PROFILES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.yaml'))
    .map(name => basename(name, '.yaml'))
    .sort();
}

function parseEnum(key: string, raw: string, values: readonly string[]): string {
  if (values.includes(raw)) return raw;
  throw invalidEnumValue(key, raw, values);
}

/**
 * The range clause of a numeric key's expectation, as the message states it.
 *
 * A bound the user got wrong has to be named, not merely implied: someone who
 * typed 70000 for a port learns nothing from "invalid value" and everything
 * from the ceiling.
 */
function numberRange(spec: NumberSpec): string {
  const { min, max } = spec;
  if (min !== undefined && max !== undefined) return ` from ${min} to ${max}`;
  if (min !== undefined) return `, ${min} or more`;
  if (max !== undefined) return `, ${max} or less`;
  return '';
}

/** The whole of what a numeric key accepts, in one sentence. */
function numberExpectation(spec: NumberSpec): string {
  return `Expected a ${spec.integer ? 'whole number' : 'number'}${numberRange(spec)}.`;
}

/**
 * Read `raw` as the number `key` accepts, or throw naming the whole range.
 *
 * One message for every way the value can be wrong. A user who typed `0.5`
 * where a count belongs and a user who typed `-1` made different mistakes,
 * but both need the same sentence to fix them, and splitting it would leave
 * each of them told half of the constraint.
 */
function parseNumber(key: string, raw: string, spec: NumberSpec): number {
  const value = Number(raw);
  const expected = numberExpectation(spec);

  if (raw.trim() === '' || !Number.isFinite(value)) throw invalidValue(key, raw, expected);
  if (spec.integer && !Number.isInteger(value)) throw invalidValue(key, raw, expected);
  if (spec.min !== undefined && value < spec.min) throw invalidValue(key, raw, expected);
  if (spec.max !== undefined && value > spec.max) throw invalidValue(key, raw, expected);

  return value;
}

/** A percentage of the context window, such as `40%`, kept as written. */
const PERCENTAGE = /^\d+(\.\d+)?%$/;

/**
 * One entry of `workflow.handoff.context_thresholds`: a token count as a
 * number, or a percentage as the string the hook resolves against the window.
 * A bare `40` would be forty tokens, so the percent sign has to survive.
 */
function parseThresholdEntry(key: string, entry: unknown): number | string {
  if (typeof entry === 'number' && Number.isFinite(entry)) return entry;

  if (typeof entry === 'string') {
    const text = entry.trim();
    if (PERCENTAGE.test(text)) return text;
    if (text !== '' && Number.isFinite(Number(text))) return Number(text);
  }

  throw invalidValue(
    key,
    typeof entry === 'string' ? entry.trim() : (JSON.stringify(entry) ?? ''),
    'Every entry must be a number of tokens, such as 150000, ' +
      'or a percentage of the context window, such as 40%.'
  );
}

/**
 * The two spellings the reference gives for a threshold ladder: a
 * comma-separated list, `150000,300000`, and YAML flow style,
 * `[150000, 300000]`. Both land as the same list.
 */
function parseThresholds(key: string, raw: string): (number | string)[] {
  const trimmed = raw.trim();
  let entries: unknown[];

  if (trimmed.startsWith('[')) {
    let flow: unknown;
    try {
      flow = parseYaml(trimmed);
    } catch (err) {
      throw invalidValue(key, raw, `Not a YAML list: ${(err as Error).message}`);
    }
    if (!Array.isArray(flow)) throw invalidValue(key, raw, 'Expected a YAML list.');
    entries = flow;
  } else {
    entries = trimmed.split(',');
  }

  if (entries.length === 0) throw invalidValue(key, raw, 'Expected at least one entry.');
  return entries.map(entry => parseThresholdEntry(key, entry));
}

/**
 * Validate and coerce the raw string `raw` for the project key `key`.
 *
 * Throws `ConfigValidationError` for anything the schema refuses, before
 * anything has been written, so a rejected value leaves the file untouched.
 */
export function parseProjectValue(key: string, raw: string): unknown {
  const spec = projectKeySpec(key);
  if (!spec) throw new ConfigValidationError(`Unknown config key "${key}".`);

  switch (spec.kind) {
    case 'boolean':
      return parseBooleanWord(key, raw);
    case 'number':
      return parseNumber(key, raw, spec);
    case 'string':
      return raw;
    case 'enum':
      return parseEnum(key, raw, spec.values);
    case 'profile': {
      const names = profileNames();
      // Nothing to validate against when the profiles directory is out of
      // reach, so take the name as given rather than refuse every value.
      return names.length === 0 ? raw : parseEnum(key, raw, names);
    }
    case 'thresholds':
      return parseThresholds(key, raw);
  }
}

/** The YAML source for one scalar `value`, as it would appear after the colon. */
function scalarSource(value: unknown): string {
  return stringifyYaml(value, { lineWidth: 0 }).trimEnd();
}

/**
 * `src` with the byte range of the scalar at `path` overwritten by `value`, or
 * null when there is no such range to overwrite.
 *
 * This is a candidate, not an answer. Whether the bytes it produces still mean
 * what the caller asked for is `holdsSameDataAs`'s question, and every splice
 * has to pass that before it is written.
 */
function splicedSource(
  src: string,
  doc: ReturnType<typeof parseDocument>,
  path: string[],
  value: unknown
): string | null {
  // A list or a map has no spelling that fits after the colon on one line.
  if (value !== null && typeof value === 'object') return null;

  // Nothing to overwrite unless the file already states this key as a scalar.
  const node: unknown = doc.getIn(path, true);
  if (!isScalar(node) || !node.range) return null;

  // An empty value has a zero-width range sitting flush against the colon, so
  // a splice would leave no space between the two.
  const [start, end] = node.range;
  if (end <= start) return null;

  // A multi-line rendering belongs at the key's own indent, not at column zero.
  const source = scalarSource(value);
  if (source.includes('\n')) return null;

  return src.slice(0, start) + source + src.slice(end);
}

/**
 * Whether `candidate` parses, and holds exactly the data `expected` holds.
 *
 * The comparison covers the whole document rather than the key being written,
 * because a splice that escapes its context corrupts the file beside the key
 * as readily as at it: a value carrying a `,` into a flow mapping truncates
 * the entry and stands the rest of itself up as a key of its own, which an
 * assertion about the target key alone would never see.
 *
 * A parse that throws is a failed verification, not an error to report. The
 * caller has a second way to write to fall back to, and a refusal to fall
 * back on when that one fails the same check.
 */
function holdsSameDataAs(candidate: string, expected: ReturnType<typeof parseDocument>): boolean {
  try {
    const parsed = parseDocument(candidate);
    if (parsed.errors.length > 0) return false;
    return isDeepStrictEqual(parsed.toJS(), expected.toJS());
  } catch {
    return false;
  }
}

/**
 * Which line ending a file uses. Not a formatting preference: on a checkout
 * shared with Windows it is the difference between a diff of one line and a
 * diff of every line.
 */
type LineEnding = '\n' | '\r\n';

/**
 * The line ending most of `src` already uses.
 *
 * The majority decides, because a mixed file is ordinary: a repository with
 * no `.gitattributes` rule collects both endings one hunk at a time, from one
 * contributor on Windows and one on Linux. Following the first break instead
 * answers with whichever editor happened to touch line one, which turns a
 * one-key write into a diff over every line of the smaller half.
 *
 * A tie takes LF, as does an empty file and one with no break at all: LF is
 * what the document interface emits when nothing in the file settles it.
 */
function lineEndingOf(src: string): LineEnding {
  const crlf = (src.match(/\r\n/g) ?? []).length;
  const lf = (src.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/** U+FEFF, the byte-order mark, as a UTF-8 read decodes its three bytes. */
const BYTE_ORDER_MARK = '\uFEFF';

/**
 * `text` carrying the leading byte-order mark `src` arrived with.
 *
 * The mark is not content: it is what an editor put at the front of the file
 * to say how the rest is encoded, and Windows editors write one unasked. The
 * splice keeps it for free, because it copies byte 0 across untouched, but
 * the document interface builds its text from a parse that never held the
 * mark - so a re-emit would change byte 0 of a file the user asked to set one
 * key in. A file that arrived without one gains nothing here.
 */
function withByteOrderMark(text: string, src: string): string {
  if (!src.startsWith(BYTE_ORDER_MARK) || text.startsWith(BYTE_ORDER_MARK)) return text;
  return BYTE_ORDER_MARK + text;
}

/**
 * `text` with every line ending rewritten to `ending`.
 *
 * The document interface emits LF whatever it read, so without this a file
 * that arrived with CRLF comes back with every line ending changed - every
 * line the write never touched included - as the price of setting one key.
 */
function withLineEnding(text: string, ending: LineEnding): string {
  const lf = text.replace(/\r\n/g, '\n');
  return ending === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

/**
 * The reason an fs call failed, in words the user can act on.
 *
 * The codes worth naming are named, because node's own message leads with the
 * code and repeats the path: "EACCES: permission denied, open '...'" tells
 * someone who already knows what EACCES means nothing they did not know, and
 * someone who does not, nothing at all. Anything else falls back to the
 * message's first line, which is still a sentence rather than a stack.
 */
const FS_REASONS: Readonly<Record<string, string>> = {
  EACCES: 'permission denied',
  EPERM: 'permission denied',
  EROFS: 'the filesystem is read-only',
  EISDIR: 'that path is a directory',
  ENOTDIR: 'a directory on that path is a file',
  EMFILE: 'too many open files',
  ENOSPC: 'the disk is full',
};

function fsReason(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
  if (code !== undefined && FS_REASONS[code] !== undefined) return FS_REASONS[code];
  return err instanceof Error ? err.message.split('\n')[0] : String(err);
}

/**
 * A UTF-8 decoder that refuses a byte it cannot read, rather than standing
 * U+FFFD in its place.
 *
 * `ignoreBOM` keeps a leading byte-order mark as a character, which is what
 * `readFileSync(file, 'utf-8')` does and what byte-for-byte fidelity needs:
 * stripping it here would make every write drop a mark the file arrived with.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The text of `file`, or an empty document when it is not there yet.
 *
 * Both the reader and the writer come through here, so a file that cannot be
 * read is reported once rather than in each caller's own words.
 *
 * The decode is fatal on purpose. A lossy one turns a byte the command was
 * never asked to touch into U+FFFD, and the write then saves that - so a
 * hand-edited file loses an accented character in a comment as the silent
 * price of setting an unrelated key, reported as success. Nothing here can
 * re-encode what it could not decode, so the only safe answer is to refuse
 * and leave the file to the user's own editor.
 */
function readSource(file: string): string {
  if (!existsSync(file)) return '';

  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (err) {
    throw new ConfigFileError(`Could not read ${file}: ${fsReason(err)}`);
  }

  try {
    return UTF8.decode(bytes);
  } catch {
    throw new ConfigValidationError(
      `${file} is not valid UTF-8, so it cannot be rewritten without corrupting the bytes ` +
        'that did not decode. Re-save the file as UTF-8 and try again.'
    );
  }
}

/**
 * Put `text` in `file`'s place, as a whole file rather than as a truncate and
 * a refill.
 *
 * `replaceFileAtomically` states why a temp file and a rename, and owns both.
 * What this adds is everything a rename would otherwise take from the user:
 *
 * The link is resolved before anything is replaced, because a rename replaces
 * the NAME. `spechub/project.yaml` is a symlink whenever one file is shared
 * between checkouts, and renaming a temp over the link leaves a regular file
 * where the link was, the real file still holding the old value, and the
 * command exiting 0 about a change nothing will ever read. Resolving first
 * puts the temp file beside the real file and renames over that.
 *
 * The mode is copied onto the temp file before the rename. A fresh file gets
 * whatever the umask gives it, so renaming one over a 0o640 project.yaml
 * silently changes who on the machine can read it.
 *
 * The owner is not copied, and cannot be: a rename gives the new file whoever
 * wrote it as its owner, and its group too outside a setgid directory. A
 * second name for the same inode - a hardlink - keeps the old bytes, because
 * the rename moves this name onto a different inode rather than changing the
 * one both names point at. Both are the price of never leaving a truncated
 * file behind, and both are paid on every write.
 *
 * A file the user may not write is refused here rather than by the rename,
 * which checks the DIRECTORY's mode and so succeeds over a read-only target -
 * turning a refusal into a silent write of a file somebody locked on purpose.
 * The check is a moment ahead of the rename, so a mode changed in between is
 * a mode this does not see; nothing in this module locks, and the answer to a
 * file that changed underneath a write is the same as for two writers at once.
 */
function replaceFile(file: string, text: string): void {
  const present = existsSync(file);
  const target = present ? realpathSync(file) : file;
  const existing = present ? statSync(target) : null;
  if (existing) accessSync(target, fsConstants.W_OK);

  // The directory is named rather than the file, because the directory is
  // what the user has to go and fix: the new bytes are written here before
  // they take the target's name, so a writable file in a directory nobody may
  // write is still a write that cannot happen.
  const directory = dirname(target);
  try {
    accessSync(directory, fsConstants.W_OK);
  } catch (err) {
    throw new ConfigFileError(
      `Could not write ${file}: ${fsReason(err)} on ${directory}. The new file is written ` +
        'there and renamed over the target, so that directory has to be writable too.'
    );
  }

  replaceFileAtomically(target, text, temp => {
    if (existing) chmodSync(temp, existing.mode & 0o777);
  });
}

/**
 * Write `text` over `file`, creating the directory holding it as needed.
 *
 * The only place either writer touches the disk. A read-only file, a
 * directory that cannot be created - every one of these is an ordinary thing
 * to meet on a real checkout, and the user can act on any of them the moment
 * they are told which file and why. `writeFileSync` throwing on its own tells
 * them instead that node's fs module has a line number.
 */
function writeSource(file: string, text: string): void {
  try {
    ensureDir(dirname(file));
    replaceFile(file, text);
  } catch (err) {
    // A failure `replaceFile` already put into words names the path it is
    // about, which is not always this one. Re-wrapping it would bury that
    // path inside a sentence about a different one.
    if (err instanceof ConfigFileError) throw err;
    throw new ConfigFileError(`Could not write ${file}: ${fsReason(err)}`);
  }
}

/**
 * Re-emit `doc` over `file`, carrying across what `src` held and the parse
 * did not: its line endings and its leading byte-order mark. Refuses where
 * the text it built does not read back as the data `doc` holds.
 *
 * The fallback both writers share, and the only place either of them calls
 * `toString`, so neither can re-emit a document without both corrections.
 *
 * docs/adr/0009 checks the splice against this writer and takes this writer
 * as the answer that always works. It is not one. Replacing a block scalar's
 * value keeps the old node's block-literal type, so a value of spaces is
 * emitted as a content line holding only spaces - which every parser reads
 * back as the empty string, and the user is told the value was set. So the
 * emission is checked the way the splice is, against the same whole-document
 * comparison, and the write the splice already refused is refused here too
 * rather than landing a file that means something else.
 */
function writeDocument(
  file: string,
  key: string,
  doc: ReturnType<typeof parseDocument>,
  src: string
): void {
  const text = withByteOrderMark(withLineEnding(emitDocument(file, doc), lineEndingOf(src)), src);
  if (!holdsSameDataAs(text, doc)) {
    throw new ConfigValidationError(
      `Cannot write ${key} to ${file} safely: what the writer emits reads back as a ` +
        'different value, so nothing was written. Change the value, or edit the key by hand.'
    );
  }
  writeSource(file, text);
}

/**
 * `doc` as YAML text, or a refusal the user can act on.
 *
 * Removing the key an anchor sits on leaves every alias to it pointing at
 * nothing, and the emitter refuses such a document with a plain `Error` - one
 * the command's reporter passes straight through as a stack trace naming the
 * bundler's internals. The document is refused either way. What changes here
 * is that the user is told which alias is in the way, and the throw lands
 * before any write, so the file is still byte for byte as it was.
 */
function emitDocument(file: string, doc: ReturnType<typeof parseDocument>): string {
  try {
    return doc.toString();
  } catch (err) {
    throw new ConfigValidationError(
      `Could not rewrite ${file}: ${err instanceof Error ? err.message : String(err)}. ` +
        'Remove the alias, or point it at a key the file still states, and try again.'
    );
  }
}

/** Whether `node` is a YAML scalar holding null, however the file spelled it. */
function isNullScalar(node: unknown): boolean {
  return isScalar(node) && node.value === null;
}

/**
 * An empty block standing in for the null `node`, carrying its comment across.
 *
 * The comment is the user's writing about a block they still have, so it
 * survives even though the block it sat beside is now a mapping and the
 * comment lands under the keys rather than after the colon. Where it reads is
 * a formatting question; whether it is still in the file is not.
 */
function emptyBlockFor(node: unknown, doc: ReturnType<typeof parseDocument>): YAMLMap {
  const map = new YAMLMap(doc.schema);
  if (isScalar(node)) {
    if (node.comment != null) map.comment = node.comment;
    if (node.commentBefore != null) map.commentBefore = node.commentBefore;
  }
  return map;
}

/**
 * Make every block above `path`'s leaf something `setIn` can descend into,
 * refusing the one case where it cannot.
 *
 * `setIn` throws a plain `Error` for any of these, which the command's error
 * reporter passes straight through as a stack trace - so the three shapes it
 * meets are settled here instead, before a single byte is written.
 *
 * A null on the path becomes an empty block. Null and empty block are the same
 * state to every reader, both meaning the block states nothing, and this is
 * the state `config unset` leaves behind when it removes a block's last key -
 * so the tool has to accept its own output. `workflow:`, `workflow: null` and
 * `workflow: ~` are three spellings of it, and a document whose whole contents
 * are null - a file holding only `---` - is the same thing one level up.
 *
 * Anything else on the path is a refusal, not a crash. `workflow: fast`
 * cannot hold `workflow.spec_sync` without discarding `fast`, and a list
 * cannot hold a named key at all, so both say which key is in the way and
 * leave the file exactly as it was. A mapping is the only shape that can hold
 * the key, which is why a list is refused rather than descended into: `setIn`
 * throws on one the same way it throws on a scalar.
 *
 * The document itself is the same question one level up, and the loop below
 * cannot ask it: a file holding only `hello`, or only a list of commands, has
 * no depth above the leaf to walk. So the shape of the contents is settled
 * first, and a document that is neither empty nor a mapping names the file
 * rather than reaching `setIn` and throwing the library's own sentence.
 */
function ensureBlocksAbove(
  file: string,
  doc: ReturnType<typeof parseDocument>,
  path: string[]
): void {
  if (isNullScalar(doc.contents)) doc.contents = emptyBlockFor(doc.contents, doc);
  // A document with no contents at all - an empty file, or one holding only a
  // comment - is not a refusal: `setIn` builds the mapping and every block
  // under it, which is how the command creates a project.yaml from nothing.
  if (doc.contents != null && !isMap(doc.contents)) {
    throw new ConfigValidationError(
      `Cannot set ${path.join('.')}: ${file} holds ` +
        `${isSeq(doc.contents) ? 'a list' : 'a value'}, not a block of keys. ` +
        'Rewrite the file as a block of keys and try again.'
    );
  }

  for (let depth = 1; depth < path.length; depth += 1) {
    const above = path.slice(0, depth);
    // Nothing stated at this depth, so `setIn` creates the rest of the blocks.
    if (!doc.hasIn(above)) return;

    const node: unknown = doc.getIn(above, true);
    // Flow style counts: `workflow: {spec_sync: true}` is a mapping to descend
    // into, and the write puts the new key inside it.
    if (isMap(node)) continue;
    if (isNullScalar(node)) {
      doc.setIn(above, emptyBlockFor(node, doc));
      continue;
    }

    const blocked = above.join('.');
    throw new ConfigValidationError(
      `Cannot set ${path.join('.')}: ${blocked} holds ${isSeq(node) ? 'a list' : 'a value'}, ` +
        `not a block. Change or remove ${blocked} first.`
    );
  }
}

/**
 * One change to a project.yaml, stated as the three things that differ
 * between changing a key and removing one.
 *
 * A writer says what its change is. Which text to trust, and what to do when
 * no text can be trusted, is `writeProjectEdit`'s answer and is given once -
 * so a second writer cannot arrive with a fifth way to corrupt a user's file
 * behind a green success message.
 */
interface ProjectEdit {
  /**
   * Make the document ready to take the change, and say whether there is a
   * change to make - both asked of the document as it was read.
   *
   * Not a predicate: a change that needs the blocks above the key to exist
   * creates them here, and a block that cannot hold the key is refused here,
   * because both have to happen before the splice is built against the old
   * ranges. So this mutates `doc`, and it throws.
   */
  prepare(doc: ReturnType<typeof parseDocument>, path: string[]): boolean;

  /**
   * The source with the change made to the bytes, or null where no such
   * change fits the shape. A candidate, not an answer.
   */
  candidate(src: string, doc: ReturnType<typeof parseDocument>, path: string[]): string | null;

  /** The same change made through the document interface. */
  apply(doc: ReturnType<typeof parseDocument>, path: string[]): void;
}

/**
 * Make one change to the project.yaml at `file`, reporting whether it wrote.
 *
 * There are two ways to write, and the data they produce is the same. The
 * document interface changes the parsed document and re-emits the file,
 * carrying the comments and the key order across but normalising the
 * whitespace before an inline comment, so a run of spaces ahead of a `#`
 * anywhere in the file shortens to one.
 *
 * Splicing edits the bytes of the line the change touches and leaves every
 * other byte exactly as it was, which is what keeps a hand-edited file
 * intact. It is also the riskier one, because a rendering that reads as an
 * ordinary value in one context is syntax in another - `,` `{` `}` `[` `]`
 * inside a flow collection - and a node's range says nothing about the
 * context around it.
 *
 * So neither writer is trusted, both are checked: parse the text a writer
 * produced and compare the data against the change the caller asked for. A
 * write takes the splice when the two agree, the document interface when its
 * own text agrees, and refuses when neither does - which costs one extra
 * parse per write and holds for shapes nobody has thought of yet. The
 * comparison covers the whole document, and docs/adr/0009 says why it is not
 * narrowed to the key that changed.
 */
function writeProjectEdit(file: string, key: string, edit: ProjectEdit): boolean {
  const src = readSource(file);
  const doc = parseProjectDocument(file, src);

  const path = key.split('.');
  if (!edit.prepare(doc, path)) return false;

  // Built against the old nodes' ranges, so before `apply` replaces them.
  const candidate = edit.candidate(src, doc, path);

  edit.apply(doc, path);

  if (candidate !== null && holdsSameDataAs(candidate, doc)) {
    writeSource(file, candidate);
    return true;
  }

  writeDocument(file, key, doc, src);
  return true;
}

/**
 * Write `value` to the dotted `key` of the project.yaml at `file`, creating
 * the file and every block above the key as needed.
 *
 * Always a write: the caller asked for a value, and a file already holding it
 * is still the file the caller asked to state it.
 */
export function setProjectKey(file: string, key: string, value: unknown): void {
  writeProjectEdit(file, key, {
    prepare: (doc, path) => {
      ensureBlocksAbove(file, doc, path);
      return true;
    },
    candidate: (src, doc, path) => splicedSource(src, doc, path, value),
    apply: (doc, path) => doc.setIn(path, value),
  });
}

/**
 * The default `docs/config-reference.md` gives each key, spelled as the
 * reference spells it.
 *
 * Only literals are here. A key whose default the reference describes rather
 * than states - `from the profile`, `inferred from the model id`, one value
 * for Node and another for Python, a path built out of another key - has no
 * single answer to name, and naming one would report a decision the reference
 * never made. `config get` then says the key is unset and stops there.
 */
export const PROJECT_KEY_DEFAULTS: Readonly<Record<string, string>> = {
  'workflow.spec_sync': 'true',
  'workflow.grilling.questions': 'tool',
  'workflow.tdd.strict': 'true',
  'workflow.tdd.orchestrator_strict': 'true',
  [FRONTEND_VERIFICATION_KEY]: 'false',
  'workflow.maps.persist': 'false',
  'workflow.handoff.agent': 'claude',
  'workflow.handoff.ack_turns': '5',
  'workflow.handoff.self_invoke': 'true',
  'workflow.handoff.nudge_warn': '200000',
  'workflow.handoff.nudge_severe': '500000',
  'workflow.handoff.nudge_step': '100000',

  'directories.source': 'src/',
  'directories.tests': 'tests/',

  'frontend.directory': 'frontend/',
  'frontend.dev_server_url': 'http://localhost:3000',
};

/** The documented default for `key`, or undefined where the reference gives none. */
export function projectKeyDefault(key: string): string | undefined {
  return PROJECT_KEY_DEFAULTS[key];
}

/**
 * The documented default for a boolean `key`, for the readers that apply one
 * rather than print it.
 *
 * The table above spells every default the way the reference spells it, which
 * is text, and a reader deciding whether to run a step holds a yes or a no.
 * The two meet here, so a caller needing the boolean names this instead of
 * writing the value down a second time - and `config get` then reports the
 * default `config check` acted on.
 *
 * A key the reference gives no default for has no answer to give. Standing in
 * `false` would apply a decision nobody documented, and it would apply it
 * silently, so this refuses instead - as a plain `Error`, keeping its stack.
 * Nothing a user typed reaches here: the key is written into the source of
 * whichever reader asked, so the reader is the thing to go and fix, and a red
 * line and exit 1 would file that as a value somebody mistyped.
 */
export function projectKeyDefaultFlag(key: string): boolean {
  const stated = projectKeyDefault(key);
  if (stated === undefined) {
    throw new Error(`${key} has no documented default to apply.`);
  }
  return parseBooleanWord(key, stated);
}

/** What one project key holds, or that the file states no value for it. */
export type ProjectKeyRead = { status: 'set'; value: unknown } | { status: 'unset' };

/**
 * `src` parsed, refusing a file the parser cannot read.
 *
 * A reader that guessed at a broken file would answer questions about a
 * document nobody wrote, and a writer that guessed would save the guess.
 */
function parseProjectDocument(file: string, src: string): ReturnType<typeof parseDocument> {
  const doc = parseDocument(src);
  if (doc.errors.length > 0) {
    throw new ConfigValidationError(`Could not parse ${file}: ${doc.errors[0].message}`);
  }
  return doc;
}

/** The value at the dotted `path` of the plain data `data`, or undefined. */
function atPath(data: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((node, part) => {
    if (typeof node !== 'object' || node === null) return undefined;
    return (node as Record<string, unknown>)[part];
  }, data);
}

/**
 * What the project.yaml at `file` states for the dotted `key`.
 *
 * Stated is the question, not resolved. A key the file omits comes back unset
 * even where the reference gives it a default, because the file is what the
 * user edits and the default is what every reader already applies - and the
 * caller has to be able to tell the two apart to report either.
 *
 * A key stated as null is stated. `commands.format: null` means no format
 * step, which is a different answer from the key being absent, so the two
 * cannot collapse into one status.
 */
export function getProjectKey(file: string, key: string): ProjectKeyRead {
  const doc = parseProjectDocument(file, readSource(file));
  const path = key.split('.');
  if (!doc.hasIn(path)) return { status: 'unset' };
  return { status: 'set', value: atPath(doc.toJS(), path) };
}

/** Whether `node` is a mapping holding entries, and so a block rather than a value. */
function isBlock(node: unknown): node is Record<string, unknown> {
  return (
    typeof node === 'object' &&
    node !== null &&
    !Array.isArray(node) &&
    Object.keys(node).length > 0
  );
}

/** One line of the listing: what the file states, and whether the schema knows it. */
export interface ProjectKeyRow {
  /** The dotted path `spechub config set` takes for this value. */
  key: string;
  /** The value the file states, as plain data. */
  value: unknown;
  /**
   * Whether `config get` and `config set` work on this key. A row a listing
   * prints exactly like its neighbours says those two commands work on it, so
   * the reader is told here instead of by an exit 1 they went and earned.
   *
   * `rowIsKnown` decides it, and the schema settles only part of the answer:
   * a literal dotted key is unreachable however known its path looks, and a
   * block header the tool's own `unset` left behind is not the user's mistake
   * to be warned about.
   */
  known: boolean;
}

/**
 * Every value the project.yaml at `file` states, by the dotted path
 * `spechub config set` takes, in the order the file states them.
 *
 * Stated, not resolved: a key the file omits is absent here rather than
 * present with its default, because a listing of defaults would read as a set
 * of decisions this project made.
 *
 * Keys no schema knows are listed too, carrying `known: false`. The question
 * this answers is what the file says, and a line the user wrote is a line
 * they may want to find - hiding it would make the listing disagree with the
 * file it is listing. Marking it is what keeps the listing honest about which
 * rows the other commands accept.
 */
export function listProjectKeys(file: string): ProjectKeyRow[] {
  const rows: ProjectKeyRow[] = [];

  const walk = (node: unknown, path: string[]): void => {
    if (isBlock(node)) {
      for (const [name, child] of Object.entries(node)) walk(child, [...path, name]);
      return;
    }
    if (path.length === 0) return;
    rows.push({ key: path.join('.'), value: node, known: rowIsKnown(path, node) });
  };

  walk(parseProjectDocument(file, readSource(file)).toJS(), []);
  return rows;
}

/** Whether the file states nothing at this key, which is what an emptied block holds. */
function statesNothing(value: unknown): boolean {
  if (value === null) return true;
  return typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

/** Whether the schema knows any key UNDER `key`, and so knows `key` as a block. */
function knowsKeysUnder(key: string): boolean {
  return PROJECT_KEY_LIST.some(known => known.startsWith(`${key}.`));
}

/**
 * Whether `config get` and `config set` work on the row at `path`, which is
 * what the listing's mark is about.
 *
 * Three answers, and the schema settles only one of them.
 *
 * A segment holding a dot is a key nothing can reach. YAML lets a mapping key
 * hold one, so `"workflow.spec_sync": true` is a key whose name contains a
 * dot rather than the `spec_sync` of a `workflow` block - and the dotted path
 * every command takes walks the blocks, so it reads the nested spelling and
 * never this line. However known the path it spells looks, this row is one
 * nothing reads and nothing writes.
 *
 * A row holding nothing at a path the schema knows keys under is the tool's
 * own residue: removing a block's last key leaves the block header standing,
 * by design, and `workflow:` with nothing after the colon is what is left.
 * Marking that would be the tool warning the user about a line it wrote
 * itself, and sending them to look for a mistake that is not there.
 *
 * A row holding nothing at a path nothing is stated under is a different
 * thing: no removal could have left it, so it keeps the mark.
 */
function rowIsKnown(path: string[], value: unknown): boolean {
  if (path.some(part => part.includes('.'))) return false;

  const key = path.join('.');
  if (projectKeySpec(key) !== undefined) return true;
  return statesNothing(value) && knowsKeysUnder(key);
}

/** The index just past the next line break at or after `from`, or the end of `src`. */
function nextLineStart(src: string, from: number): number {
  const at = src.indexOf('\n', from);
  return at === -1 ? src.length : at + 1;
}

/**
 * `src` with the whole line stating `path` cut out, or null when there is no
 * such line to cut.
 *
 * A candidate, not an answer, exactly as `splicedSource` is: whether what it
 * leaves behind still means what the caller asked for is `holdsSameDataAs`'s
 * question.
 *
 * The line goes rather than the value, indentation and any trailing comment
 * included, because those belong to the key being removed. A comment on its
 * own line above stays: it is a line the user wrote about a block they still
 * have, and the data is the same either way.
 */
function removedSource(
  src: string,
  doc: ReturnType<typeof parseDocument>,
  path: string[]
): string | null {
  const parent: unknown = path.length > 1 ? doc.getIn(path.slice(0, -1), true) : doc.contents;
  if (!isMap(parent)) return null;

  const leaf = path[path.length - 1];
  const pair = parent.items.find(item => isScalar(item.key) && item.key.value === leaf);
  if (!pair || !isScalar(pair.key) || !pair.key.range) return null;

  // A block or a list after the colon spans lines this has no range for, and
  // the document interface handles it correctly anyway.
  const value = pair.value;
  if (value != null && !isScalar(value)) return null;

  // From the start of the key's own line, so the indentation goes with it.
  // Anything but whitespace ahead of the key means the pair shares its line
  // with others - a flow mapping - where the line is not the pair's to take.
  const keyStart = pair.key.range[0];
  const lineStart = src.lastIndexOf('\n', keyStart - 1) + 1;
  if (src.slice(lineStart, keyStart).trim() !== '') return null;

  // A block scalar's range already ends past its closing line break. Every
  // other value ends mid-line, with any trailing comment still to come.
  const contentEnd = value?.range ? value.range[1] : pair.key.range[1];
  const end = src[contentEnd - 1] === '\n' ? contentEnd : nextLineStart(src, contentEnd);

  return src.slice(0, lineStart) + src.slice(end);
}

/**
 * Set every mapping the removal emptied to null, deepest first.
 *
 * Nothing is pruned. An empty block reads as the default to every reader
 * already, and taking its key out would take any comment on it too. But the
 * splice leaves an emptied block's key with nothing after the colon, which
 * parses as null, while `deleteIn` leaves an empty mapping - so the two would
 * disagree about the data and every such removal would fall back. This brings
 * the document into line with the splice instead.
 */
function collapseEmptied(doc: ReturnType<typeof parseDocument>, path: string[]): void {
  for (let depth = path.length - 1; depth > 0; depth -= 1) {
    const parentPath = path.slice(0, depth);
    const parent: unknown = doc.getIn(parentPath, true);
    if (!isMap(parent) || parent.items.length > 0) return;
    doc.setIn(parentPath, null);
  }
  if (isMap(doc.contents) && doc.contents.items.length === 0) doc.contents = null;
}

/**
 * Remove the dotted `key` from the project.yaml at `file`, reporting whether
 * it was there to remove.
 *
 * A key the file does not state is not an error and is not a write. The state
 * the caller asked for is the state the file is already in, and rewriting it
 * to change nothing would still cost the user their formatting.
 */
export function unsetProjectKey(file: string, key: string): boolean {
  return writeProjectEdit(file, key, {
    prepare: (doc, path) => doc.hasIn(path),
    candidate: removedSource,
    apply: (doc, path) => {
      doc.deleteIn(path);
      collapseEmptied(doc, path);
    },
  });
}
