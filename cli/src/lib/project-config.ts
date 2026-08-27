import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
import { ConfigFileError, ConfigValidationError, parseBooleanWord } from './global-config.js';
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
  'workflow.frontend_verification': { kind: 'boolean' },
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
  'frontend.browser.mode': { kind: 'enum', values: ['remote', 'headless', 'local'] },
  // Only `none` acts at read time, but a typo is still worth catching, so the
  // three mode names it could plausibly be confused with are named too.
  'frontend.browser.fallback': { kind: 'enum', values: ['none', 'remote', 'headless', 'local'] },
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

function invalidValue(key: string, raw: string, expected: string): ConfigValidationError {
  return new ConfigValidationError(`Invalid value "${raw}" for ${key}. ${expected}`);
}

function parseEnum(key: string, raw: string, values: readonly string[]): string {
  if (values.includes(raw)) return raw;
  throw invalidValue(key, raw, `Allowed values: ${values.join(', ')}`);
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
 * caller has an answer that always works to fall back to.
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
 * The line ending `src` arrived with.
 *
 * The first break decides. A file has one convention, and a file that mixes
 * them has no answer worth guessing at, so the first one wins rather than a
 * count. An empty file, or one with no break at all, takes LF.
 */
function lineEndingOf(src: string): LineEnding {
  const first = src.indexOf('\n');
  return first > 0 && src[first - 1] === '\r' ? '\r\n' : '\n';
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
    writeFileSync(file, text, 'utf-8');
  } catch (err) {
    throw new ConfigFileError(`Could not write ${file}: ${fsReason(err)}`);
  }
}

/**
 * Re-emit `doc` over `file`, in the line endings the source used.
 *
 * The fallback both writers share, and the only place either of them calls
 * `toString`, so neither can re-emit a document without this correction.
 */
function writeDocument(
  file: string,
  doc: ReturnType<typeof parseDocument>,
  ending: LineEnding
): void {
  writeSource(file, withLineEnding(doc.toString(), ending));
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
 */
function ensureBlocksAbove(doc: ReturnType<typeof parseDocument>, path: string[]): void {
  if (isNullScalar(doc.contents)) doc.contents = emptyBlockFor(doc.contents, doc);

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
 * Write `value` to the dotted `key` of the project.yaml at `file`, creating
 * the file and every block above the key as needed.
 *
 * There are two ways to write, and the data they produce is the same. The
 * document interface is correct by construction: it sets the value on the
 * parsed document and re-emits the file, carrying the comments and the key
 * order across but normalising the whitespace before an inline comment, so a
 * run of spaces ahead of a `#` anywhere in the file shortens to one.
 *
 * Splicing overwrites the old value's byte range in the source and leaves
 * every other byte exactly as it was, which is what keeps a hand-edited file
 * intact. It is also the riskier one, because a rendering that reads as an
 * ordinary value in one context is syntax in another - `,` `{` `}` `[` `]`
 * inside a flow collection - and the range says nothing about the context
 * around it.
 *
 * So the splice is not trusted, it is checked: parse what it produced and
 * compare the data against what the document interface would have written.
 * A write takes the splice when the two agree and the document interface
 * otherwise, which costs one extra parse per write and holds for shapes
 * nobody has thought of yet.
 */
export function setProjectKey(file: string, key: string, value: unknown): void {
  const src = readSource(file);
  const doc = parseProjectDocument(file, src);

  const path = key.split('.');
  ensureBlocksAbove(doc, path);

  // Built against the old node's range, so before `setIn` replaces that node.
  const spliced = splicedSource(src, doc, path, value);

  doc.setIn(path, value);
  if (spliced !== null && holdsSameDataAs(spliced, doc)) {
    writeSource(file, spliced);
    return;
  }

  writeDocument(file, doc, lineEndingOf(src));
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
  'workflow.frontend_verification': 'false',
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

/**
 * Every value the project.yaml at `file` states, by the dotted path
 * `spechub config set` takes, in the order the file states them.
 *
 * Stated, not resolved: a key the file omits is absent here rather than
 * present with its default, because a listing of defaults would read as a set
 * of decisions this project made.
 *
 * Keys no schema knows are listed too. The question this answers is what the
 * file says, and a line the user wrote is a line they may want to find -
 * hiding it would make the listing disagree with the file it is listing.
 */
export function listProjectKeys(file: string): [string, unknown][] {
  const rows: [string, unknown][] = [];

  const walk = (node: unknown, path: string[]): void => {
    if (isBlock(node)) {
      for (const [name, child] of Object.entries(node)) walk(child, [...path, name]);
      return;
    }
    if (path.length > 0) rows.push([path.join('.'), node]);
  };

  walk(parseProjectDocument(file, readSource(file)).toJS(), []);
  return rows;
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
 *
 * The write follows the same rule as `setProjectKey`, for the same reason.
 * The splice takes the pair's line out and leaves every other byte as it was;
 * whether what is left still holds the right data is settled by parsing it
 * and comparing against what the document interface would have produced.
 */
export function unsetProjectKey(file: string, key: string): boolean {
  const src = readSource(file);
  const doc = parseProjectDocument(file, src);

  const path = key.split('.');
  if (!doc.hasIn(path)) return false;

  // Built against the pair's range, so before `deleteIn` takes the pair out.
  const removed = removedSource(src, doc, path);

  doc.deleteIn(path);
  collapseEmptied(doc, path);

  if (removed !== null && holdsSameDataAs(removed, doc)) {
    writeSource(file, removed);
    return true;
  }

  writeDocument(file, doc, lineEndingOf(src));
  return true;
}
