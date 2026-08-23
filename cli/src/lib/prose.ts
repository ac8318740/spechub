// Prose linting against the writing standard.
//
// This module is pure: no filesystem, no process, no colour. It takes text and
// a parsed vocabulary and returns findings. The command layer in
// commands/lint-prose.ts owns reading files and printing.
//
// The deny lists live in skills/writing/vocabulary.md, not here. The only word
// lists in this file are the irregular past participles and the "-ed"
// adjectives the passive-voice heuristic needs, which are grammar, not style
// policy.

import { resolve } from 'node:path';

/** Every check this module can report, in the order they are documented. */
export const RULES = [
  'vocabulary',
  'mark',
  'emoji',
  'sentence-length',
  'paragraph-length',
  'passive-voice',
  'unterminated-fence',
] as const;

/** The name of one check. */
export type Rule = (typeof RULES)[number];

/** One row of a vocabulary table. */
export interface VocabularyEntry {
  /** The word, phrase or mark to avoid, as written in the table. */
  avoid: string;
  /** The replacement, or null when the fix is to delete the word. */
  writeInstead: string | null;
  /** The note column, empty string when the cell is blank. */
  note: string;
  /** Which table the row came from. */
  section: 'words' | 'marks';
}

/**
 * A vocabulary entry with its matching machinery built once.
 *
 * Compiling is the expensive part of a vocabulary, so a run over many files
 * compiles once and passes the result to every call of `lintProse`.
 */
export interface CompiledEntry extends VocabularyEntry {
  /** The global, case-insensitive pattern that finds this entry in a line. */
  pattern: RegExp;
  /** The lowercase text of `avoid`, for a cheap substring test before the regex. */
  needle: string;
}

/** One problem found in a piece of text. */
export interface Finding {
  /** 1-based line number. */
  line: number;
  /** 1-based column, counted in code points, not UTF-16 units. */
  column: number;
  /** Which check produced this. */
  rule: Rule;
  /** What to do about it, in one line. */
  message: string;
}

/** One row of a vocabulary table that could not be read. */
export interface VocabularyWarning {
  /** 1-based line number of the row that was dropped. */
  line: number;
  /** Why the row was dropped. */
  message: string;
}

/** The result of reading a vocabulary file: the rows that parsed, and the rows that did not. */
export interface ParsedVocabulary {
  entries: VocabularyEntry[];
  warnings: VocabularyWarning[];
}

// The caps come from skills/writing/SKILL.md rule 1 (cap a descriptive
// sentence at 25 words, and an instruction at 20) and rule 4 (break a
// paragraph at six sentences). Change them there first, then here.

/** skills/writing/SKILL.md rule 1: the cap on a descriptive sentence. */
const SENTENCE_LIMIT_PROSE = 25;
/** skills/writing/SKILL.md rule 1: the cap on an instruction, an ordered list item. */
const SENTENCE_LIMIT_INSTRUCTION = 20;
/** skills/writing/SKILL.md rule 4: the cap on a paragraph. */
const PARAGRAPH_LIMIT = 6;

/** The number of columns every vocabulary table row must have. */
const VOCABULARY_COLUMNS = 3;

// ---------------------------------------------------------------------------
// Vocabulary parsing
// ---------------------------------------------------------------------------

/** The cell value meaning "delete the word", an ASCII hyphen and nothing else. */
const DELETE_SENTINEL = '-';

/**
 * Split a table row body on unescaped pipes.
 *
 * A backslash before a pipe makes the pipe cell content, the way Markdown
 * escapes it, so `a\|b` is one cell holding `a|b`.
 */
function splitCells(body: string): string[] {
  const cells: string[] = [];
  let current = '';

  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '\\' && body[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (char === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);

  return cells.map(cell => cell.trim());
}

/** Read a Markdown table row into its cells, or null when the line is not a row. */
function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;

  let body = trimmed.slice(1);
  // A trailing pipe closes the row, unless it is escaped and so is cell content.
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);

  return splitCells(body);
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

/**
 * Parse the two three-column tables in skills/writing/vocabulary.md.
 *
 * Rows are only collected under a `## Words` or `## Marks` heading, so the
 * header comment and any other prose in the file is ignored. The header row and
 * the separator row are dropped. A row with the wrong number of columns is
 * dropped too, and reported as a warning naming its line.
 */
export function parseVocabulary(markdown: string): ParsedVocabulary {
  const entries: VocabularyEntry[] = [];
  const warnings: VocabularyWarning[] = [];
  let section: 'words' | 'marks' | null = null;

  markdown.split('\n').forEach((line, index) => {
    const heading = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (heading) {
      const name = heading[1].toLowerCase();
      section = name === 'words' ? 'words' : name === 'marks' ? 'marks' : null;
      return;
    }

    if (section === null) return;

    const cells = tableCells(line);
    if (cells === null) return;
    if (isSeparatorRow(cells)) return;

    if (cells.length !== VOCABULARY_COLUMNS) {
      warnings.push({
        line: index + 1,
        message:
          `Dropped a malformed vocabulary row: expected ${VOCABULARY_COLUMNS} columns, ` +
          `found ${cells.length}.`,
      });
      return;
    }

    const [avoid, writeInstead, note] = cells;
    if (avoid === '') return;
    if (avoid.toLowerCase() === 'avoid') return;

    entries.push({
      avoid,
      writeInstead: writeInstead === DELETE_SENTINEL ? null : writeInstead,
      note,
      section,
    });
  });

  return { entries, warnings };
}

// ---------------------------------------------------------------------------
// Vocabulary compilation
// ---------------------------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Match a deny-list word as a whole word, case-insensitively. */
function wordPattern(avoid: string): RegExp {
  const leading = /^[A-Za-z0-9_]/.test(avoid) ? '\\b' : '';
  const trailing = /[A-Za-z0-9_]$/.test(avoid) ? '\\b' : '';
  return new RegExp(`${leading}${escapeRegExp(avoid)}${trailing}`, 'gi');
}

/** Match a mark anywhere in the line, whole words being meaningless for punctuation. */
function markPattern(avoid: string): RegExp {
  return new RegExp(escapeRegExp(avoid), 'g');
}

function isCompiled(entry: VocabularyEntry | CompiledEntry): entry is CompiledEntry {
  return (entry as CompiledEntry).pattern instanceof RegExp;
}

/**
 * Build the matching machinery for a vocabulary once.
 *
 * Entries come back longest first, so an occurrence that two entries both cover
 * is reported under the longer one and the shorter one is skipped.
 */
export function compileVocabulary(entries: VocabularyEntry[]): CompiledEntry[] {
  return entries
    .map(entry => ({
      ...entry,
      pattern: entry.section === 'words' ? wordPattern(entry.avoid) : markPattern(entry.avoid),
      needle: entry.avoid.toLowerCase(),
    }))
    .sort((a, b) => b.avoid.length - a.avoid.length);
}

/** Reuse an already compiled entry, compile a plain one, then order longest first. */
function readyVocabulary(vocabulary: VocabularyEntry[] | CompiledEntry[]): CompiledEntry[] {
  const compiled = vocabulary.map(entry =>
    isCompiled(entry) ? entry : compileVocabulary([entry])[0]
  );
  return compiled.sort((a, b) => b.avoid.length - a.avoid.length);
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/**
 * Turn a UTF-16 offset into the 1-based column a human would count.
 *
 * An emoji above the Basic Multilingual Plane is one character on screen but
 * two UTF-16 units, so the two numbers differ on any line that holds one.
 */
function columnAt(text: string, index: number): number {
  let column = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Skip the low half of a surrogate pair: it shares a column with the high half.
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    column++;
  }
  return column;
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

interface CheckLine {
  /** 1-based line number. */
  line: number;
  /** The line with inline code spans and HTML comments blanked out. */
  text: string;
  /** The same, with a blockquote prefix and a leading list marker removed. */
  content: string;
  /** True when the line is inside a region no rule looks at. */
  skipped: boolean;
  isList: boolean;
  /** True for `1.` and `1)` items, which carry the narrower instruction cap. */
  isOrderedList: boolean;
  isHeading: boolean;
}

const BLOCKQUOTE_PREFIX = /^(?:\s*>\s?)+/;
const LIST_MARKER = /^(\s*)([-*+]|\d+[.)])(\s+)/;
const ORDERED_MARKER = /^\d+[.)]$/;
const HEADING = /^\s{0,3}#{1,6}(?:\s|$)/;
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/;

interface OpenFence {
  /** The fence character, a backtick or a tilde. */
  char: string;
  /** How many of them opened the fence: the closing run must be at least as long. */
  length: number;
  /** 1-based line the fence opened on. */
  line: number;
}

/** Blank out inline code spans, keeping every other character in place. */
function maskInlineCode(line: string): string {
  return line
    // A double-backtick span first: it can hold a literal single backtick.
    .replace(/``[\s\S]*?``/g, match => ' '.repeat(match.length))
    .replace(/`[^`]*`/g, match => ' '.repeat(match.length));
}

/**
 * Blank out HTML comment spans on one line, carrying the open/closed state on.
 *
 * A comment can span several lines, so the caller threads `inComment` through
 * the file.
 */
function maskComments(line: string, inComment: boolean): { text: string; inComment: boolean } {
  let out = '';
  let index = 0;
  let open = inComment;

  while (index < line.length) {
    if (open) {
      const end = line.indexOf('-->', index);
      if (end === -1) {
        out += ' '.repeat(line.length - index);
        index = line.length;
      } else {
        out += ' '.repeat(end + 3 - index);
        index = end + 3;
        open = false;
      }
      continue;
    }

    const start = line.indexOf('<!--', index);
    if (start === -1) {
      out += line.slice(index);
      index = line.length;
      continue;
    }
    out += line.slice(index, start);
    out += '    ';
    index = start + 4;
    open = true;
  }

  return { text: out, inComment: open };
}

/**
 * Find the line that closes YAML frontmatter, or -1 when there is none.
 *
 * A `---` on line 1 only opens frontmatter when a later `---` closes it and the
 * lines between look like YAML, meaning at least one `key: value` line.
 * Otherwise the `---` is a thematic break and the rest of the file is ordinary
 * content.
 */
function frontmatterEnd(rawLines: string[]): number {
  if (rawLines.length === 0 || rawLines[0].trim() !== '---') return -1;

  let close = -1;
  for (let i = 1; i < rawLines.length; i++) {
    if (rawLines[i].trim() === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return -1;

  for (let i = 1; i < close; i++) {
    if (/^\s*[A-Za-z_][A-Za-z0-9_.-]*\s*:(\s|$)/.test(rawLines[i])) return close;
  }
  return -1;
}

/**
 * Find the lines of tables written without leading pipes.
 *
 * Such a table is recognised by its delimiter row, the `--- | --- | ---` line.
 * The header row above it and the body rows below it belong to the table too.
 */
function pipelessTableLines(rawLines: string[]): Set<number> {
  const marked = new Set<number>();

  rawLines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed.includes('|')) return;
    // A row that starts with a pipe is caught by the ordinary table rule.
    if (trimmed.startsWith('|')) return;

    const cells = trimmed.split('|').map(cell => cell.trim());
    if (cells.length < 2) return;
    if (!isSeparatorRow(cells)) return;

    marked.add(index);

    const header = index - 1;
    if (header >= 0 && rawLines[header].includes('|') && rawLines[header].trim() !== '') {
      marked.add(header);
    }

    for (let i = index + 1; i < rawLines.length; i++) {
      const body = rawLines[i].trim();
      if (body === '' || !body.includes('|')) break;
      marked.add(i);
    }
  });

  return marked;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

interface Classified {
  lines: CheckLine[];
  /** The fence still open at end of file, when the file has one. */
  unterminated: OpenFence | null;
}

function classify(rawLines: string[]): Classified {
  const lines: CheckLine[] = [];
  const fmEnd = frontmatterEnd(rawLines);
  const pipeless = pipelessTableLines(rawLines);

  let fence: OpenFence | null = null;
  let inComment = false;
  let previousBlank = true;
  let inIndentedCode = false;
  let inListBlock = false;

  const pushSkipped = (line: number): void => {
    lines.push({
      line,
      text: '',
      content: '',
      skipped: true,
      isList: false,
      isOrderedList: false,
      isHeading: false,
    });
  };

  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index];
    const number = index + 1;

    // Frontmatter, when the file opens with a closed YAML block.
    if (fmEnd !== -1 && index <= fmEnd) {
      pushSkipped(number);
      previousBlank = false;
      continue;
    }

    // Inside a code fence, everything is code until a long enough closing run.
    if (fence !== null) {
      const close = FENCE_CLOSE.exec(raw);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      pushSkipped(number);
      previousBlank = false;
      continue;
    }

    const masked = maskComments(raw, inComment);
    inComment = masked.inComment;
    const visible = masked.text;

    if (raw.trim() === '') {
      lines.push({
        line: number,
        text: '',
        content: '',
        skipped: false,
        isList: false,
        isOrderedList: false,
        isHeading: false,
      });
      previousBlank = true;
      inIndentedCode = false;
      continue;
    }

    // A line that is nothing but an HTML comment.
    if (visible.trim() === '') {
      pushSkipped(number);
      previousBlank = false;
      inIndentedCode = false;
      continue;
    }

    const open = FENCE_OPEN.exec(visible);
    if (open) {
      fence = { char: open[1][0], length: open[1].length, line: number };
      pushSkipped(number);
      previousBlank = false;
      inIndentedCode = false;
      continue;
    }

    // A Markdown table row: its cells are data, not prose.
    if (visible.trimStart().startsWith('|') || pipeless.has(index)) {
      pushSkipped(number);
      previousBlank = false;
      inIndentedCode = false;
      continue;
    }

    const withoutQuote = visible.replace(BLOCKQUOTE_PREFIX, '');
    const marker = LIST_MARKER.exec(withoutQuote);
    const indent = indentOf(visible);

    // Track whether we are inside a list, so an indented continuation line of a
    // list item is not read as an indented code block.
    if (marker) inListBlock = true;
    else if (indent < 2) inListBlock = false;

    // An indented code block: four spaces of indent, starting after a blank line.
    if (!inListBlock && indent >= 4 && (previousBlank || inIndentedCode)) {
      inIndentedCode = true;
      pushSkipped(number);
      previousBlank = false;
      continue;
    }
    inIndentedCode = false;

    const text = maskInlineCode(visible);
    const content = marker
      ? maskInlineCode(withoutQuote).slice(marker[0].length)
      : maskInlineCode(withoutQuote);

    lines.push({
      line: number,
      text,
      content,
      skipped: false,
      isList: marker !== null,
      isOrderedList: marker !== null && ORDERED_MARKER.test(marker[2]),
      isHeading: HEADING.test(text),
    });
    previousBlank = false;
  }

  return { lines, unterminated: fence };
}

// ---------------------------------------------------------------------------
// Per-line rules
// ---------------------------------------------------------------------------

function vocabularyMessage(entry: VocabularyEntry, matched: string): string {
  if (entry.writeInstead === null) {
    const reason = entry.note ? ` (${entry.note})` : '';
    return `Avoid "${matched}": cut it${reason}.`;
  }
  return `Avoid "${matched}": write "${entry.writeInstead}" instead.`;
}

function markMessage(entry: VocabularyEntry): string {
  // The replacement is left unquoted: several of these marks are quotes
  // themselves, and nesting them reads as noise.
  if (entry.writeInstead === null) return `Avoid the mark "${entry.avoid}": cut it.`;
  return `Avoid the mark "${entry.avoid}": write ${entry.writeInstead} instead.`;
}

/**
 * Check one line against the vocabulary.
 *
 * Entries arrive longest first. A span already claimed by a longer entry is not
 * offered to a shorter one, so one occurrence yields one finding.
 */
function checkVocabulary(line: CheckLine, vocabulary: CompiledEntry[]): Finding[] {
  const findings: Finding[] = [];
  const { text } = line;
  const lower = text.toLowerCase();
  const claimed: Array<[number, number]> = [];

  for (const entry of vocabulary) {
    // A cheap substring test before the regex: most entries miss most lines.
    if (!lower.includes(entry.needle)) continue;

    entry.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = entry.pattern.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      // A zero-length match would loop forever.
      if (match[0].length === 0) {
        entry.pattern.lastIndex++;
        continue;
      }
      if (claimed.some(([from, to]) => start < to && from < end)) continue;
      claimed.push([start, end]);
      findings.push({
        line: line.line,
        column: columnAt(text, start),
        rule: entry.section === 'words' ? 'vocabulary' : 'mark',
        message:
          entry.section === 'words' ? vocabularyMessage(entry, match[0]) : markMessage(entry),
      });
    }
  }

  return findings;
}

// An emoji is a character with the Unicode property Extended_Pictographic,
// optionally followed by variation selectors, skin-tone modifiers, and further
// zero-width-joined parts, so a joined sequence counts once. The property needs
// the `u` flag, which Node 20 and above supports.
const EMOJI_PART = '\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]*';
const EMOJI = new RegExp(`${EMOJI_PART}(?:\\u200D${EMOJI_PART})*`, 'gu');

// The copyright, registered and trade mark signs carry Extended_Pictographic
// for legacy reasons and read as legal marks in prose, so they are not flagged.
const LEGAL_MARKS = new Set([0x00a9, 0x00ae, 0x2122]);

function checkEmoji(line: CheckLine): Finding[] {
  const findings: Finding[] = [];
  const { text } = line;

  for (const match of text.matchAll(EMOJI)) {
    const code = match[0].codePointAt(0);
    if (code === undefined || LEGAL_MARKS.has(code)) continue;
    findings.push({
      line: line.line,
      column: columnAt(text, match.index),
      rule: 'emoji',
      message: `Remove the emoji "${match[0]}".`,
    });
  }

  return findings;
}

const BE_FORMS = ['am', 'is', 'are', 'was', 'were', 'be', 'been', 'being'];

// Past participles that do not end in "ed". Grammar, not style policy, so this
// list belongs in the code.
const IRREGULAR_PARTICIPLES = new Set([
  'begun', 'bent', 'bound', 'born', 'borne', 'bought', 'broken', 'brought',
  'built', 'burnt', 'caught', 'chosen', 'come', 'cut', 'dealt', 'done',
  'drawn', 'driven', 'eaten', 'fallen', 'felt', 'flown', 'forgotten', 'found',
  'frozen', 'given', 'gone', 'grown', 'heard', 'held', 'hidden', 'hit', 'hurt',
  'kept', 'known', 'laid', 'lain', 'led', 'left', 'lent', 'lost', 'made',
  'meant', 'met', 'paid', 'put', 'read', 'rebuilt', 'redone', 'rewritten',
  'risen', 'run', 'said', 'seen', 'sent', 'set', 'shown', 'shut', 'sold',
  'sought', 'spent', 'split', 'spoken', 'spread', 'stolen', 'stood', 'sung',
  'swept', 'taken', 'taught', 'thought', 'thrown', 'told', 'torn', 'understood',
  'undone', 'woken', 'won', 'worn', 'written',
]);

// Words ending in "ed" that are not past participles. Two kinds: words that
// merely end in the letters, and adjectives that describe a state rather than
// name an action someone did.
const NOT_PARTICIPLES = new Set([
  // Words that only happen to end in "ed".
  'need', 'speed', 'indeed', 'breed', 'creed', 'freed', 'greed', 'agreed',
  'exceed', 'proceed', 'succeed', 'embed', 'sacred', 'naked', 'wicked',
  // Adjectives in "-ed": "the team is tired" names a state, not an action.
  'tired', 'excited', 'bored', 'talented', 'rugged', 'undefined', 'unordered',
  'qualified', 'experienced', 'detailed', 'interested', 'pleased', 'worried',
  'confused', 'concerned', 'surprised', 'complicated', 'dated', 'aged',
  'learned', 'beloved', 'crooked', 'ragged', 'blessed',
]);

function isPastParticiple(word: string): boolean {
  const lower = word.toLowerCase();
  // A hyphenated participle carries its ending on the last part, as in
  // "well-tested".
  const head = lower.slice(lower.lastIndexOf('-') + 1);
  if (IRREGULAR_PARTICIPLES.has(lower) || IRREGULAR_PARTICIPLES.has(head)) return true;
  if (NOT_PARTICIPLES.has(lower) || NOT_PARTICIPLES.has(head)) return false;
  return head.length >= 5 && head.endsWith('ed');
}

// A modifier can sit between the be-form and the participle: "is not run",
// "is being written", "is already written", "is quietly rewritten".
//
// Known gap: only the words listed here and adverbs ending in "ly" are
// covered. A frequency adverb such as "often", "sometimes" or "always" is
// neither, so "The doc is often rewritten." reports nothing.
const PASSIVE_MODIFIER = '(?:not|being|just|also|already|still|never|only|\\w+ly)\\s+';
const PASSIVE = new RegExp(
  `\\b(${BE_FORMS.join('|')})\\s+(?:${PASSIVE_MODIFIER})*([A-Za-z]+(?:-[A-Za-z]+)*)\\b`,
  'gi'
);

function checkPassive(line: CheckLine): Finding[] {
  const findings: Finding[] = [];
  const { text } = line;

  for (const match of text.matchAll(PASSIVE)) {
    if (!isPastParticiple(match[2])) continue;
    findings.push({
      line: line.line,
      column: columnAt(text, match.index),
      rule: 'passive-voice',
      message: `Passive voice: "${match[0].trim()}". Name who does it.`,
    });
  }

  return findings;
}

function checkLine(line: CheckLine, vocabulary: CompiledEntry[]): Finding[] {
  if (line.text.trim() === '') return [];
  return [...checkVocabulary(line, vocabulary), ...checkEmoji(line), ...checkPassive(line)];
}

// ---------------------------------------------------------------------------
// Sentence and paragraph rules
// ---------------------------------------------------------------------------

interface Sentence {
  line: number;
  words: number;
}

/**
 * Group lines into paragraphs. A blank line, a skipped line, a heading or a new
 * list marker starts a new paragraph, so an unterminated heading or list item
 * never runs into the sentence that follows it.
 */
function buildParagraphs(lines: CheckLine[]): CheckLine[][] {
  const paragraphs: CheckLine[][] = [];
  let current: CheckLine[] = [];

  const flush = (): void => {
    if (current.length > 0) paragraphs.push(current);
    current = [];
  };

  for (const line of lines) {
    if (line.skipped || line.text.trim() === '') {
      flush();
      continue;
    }
    if (line.isHeading) {
      flush();
      paragraphs.push([line]);
      continue;
    }
    if (line.isList) {
      flush();
      current = [line];
      continue;
    }
    current.push(line);
  }
  flush();

  return paragraphs;
}

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(token => /[A-Za-z0-9]/.test(token)).length;
}

// Abbreviations that end in a period without ending the sentence.
const ABBREVIATIONS = new Set([
  'e.g.', 'i.e.', 'vs.', 'etc.', 'cf.', 'dr.', 'mr.', 'mrs.', 'ms.', 'fig.', 'no.',
]);

/**
 * Decide whether a period, question mark or exclamation mark ends a sentence.
 *
 * A question mark or an exclamation mark always ends one. A period does not
 * when it closes a known abbreviation, when it follows a single capital letter
 * as a middle initial does, or when the next word starts in lowercase.
 */
function endsSentence(joined: string, end: number, terminator: string): boolean {
  if (terminator.includes('?') || terminator.includes('!')) return true;

  const before = joined.slice(0, end);
  const token = /(\S+)$/.exec(before)?.[1] ?? '';

  if (ABBREVIATIONS.has(token.toLowerCase())) return false;
  if (/^[A-Z]\.$/.test(token)) return false;

  let next = end;
  while (next < joined.length && /\s/.test(joined[next])) next++;
  if (next < joined.length && /[a-z]/.test(joined[next])) return false;

  return true;
}

function sentencesOf(paragraph: CheckLine[]): Sentence[] {
  // Join the paragraph's lines, remembering which line every character came
  // from, so a sentence spanning a line break still reports a real line.
  let joined = '';
  const lineOf: number[] = [];
  for (const line of paragraph) {
    if (joined.length > 0) {
      joined += ' ';
      lineOf.push(line.line);
    }
    joined += line.content;
    for (let i = 0; i < line.content.length; i++) lineOf.push(line.line);
  }

  const sentences: Sentence[] = [];

  const push = (start: number, end: number): void => {
    let cursor = start;
    while (cursor < end && /\s/.test(joined[cursor])) cursor++;
    if (cursor >= end) return;
    const words = countWords(joined.slice(cursor, end));
    if (words === 0) return;
    sentences.push({ line: lineOf[cursor], words });
  };

  const terminator = /[.!?]+(?=\s|$)/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = terminator.exec(joined)) !== null) {
    const end = match.index + match[0].length;
    if (!endsSentence(joined, end, match[0])) continue;
    push(start, end);
    start = end;
  }
  if (start < joined.length) push(start, joined.length);

  return sentences;
}

function checkParagraph(paragraph: CheckLine[]): Finding[] {
  const findings: Finding[] = [];
  const sentences = sentencesOf(paragraph);

  // A heading is a label, not a sentence, so no length cap applies to it.
  if (paragraph[0].isHeading) return findings;

  const instruction = paragraph[0].isOrderedList;
  const limit = instruction ? SENTENCE_LIMIT_INSTRUCTION : SENTENCE_LIMIT_PROSE;
  const where = instruction ? 'an instruction' : 'prose';

  for (const sentence of sentences) {
    if (sentence.words <= limit) continue;
    findings.push({
      line: sentence.line,
      column: 1,
      rule: 'sentence-length',
      message: `Sentence runs ${sentence.words} words, over the ${limit}-word limit for ${where}.`,
    });
  }

  if (sentences.length > PARAGRAPH_LIMIT) {
    findings.push({
      line: paragraph[0].line,
      column: 1,
      rule: 'paragraph-length',
      message: `Paragraph runs ${sentences.length} sentences, over the ${PARAGRAPH_LIMIT}-sentence limit.`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Lint one piece of Markdown text against the writing standard.
 *
 * Findings come back sorted by line, then by column. Code fences, indented code
 * blocks, table rows, YAML frontmatter, HTML comments and inline code spans are
 * not checked. The vocabulary may be plain entries or entries already compiled
 * by `compileVocabulary`, so a run over many files compiles once.
 */
export function lintProse(
  text: string,
  vocabulary: VocabularyEntry[] | CompiledEntry[]
): Finding[] {
  if (text === '') return [];

  const compiled = readyVocabulary(vocabulary);
  const { lines, unterminated } = classify(text.split('\n'));
  const findings: Finding[] = [];

  for (const line of lines) {
    if (line.skipped) continue;
    findings.push(...checkLine(line, compiled));
  }

  for (const paragraph of buildParagraphs(lines)) {
    findings.push(...checkParagraph(paragraph));
  }

  if (unterminated !== null) {
    findings.push({
      line: unterminated.line,
      column: 1,
      rule: 'unterminated-fence',
      message:
        'The rest of the file was skipped as code: ' +
        `unterminated code fence opened at line ${unterminated.line}.`,
    });
  }

  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * True when two paths name the same file.
 *
 * The caller passes the resolved vocabulary path, so this function holds no
 * knowledge of where that file lives. Both paths are resolved, which also
 * normalises away "." and ".." segments, and nothing looser is accepted: a
 * relative path means a path from the current working directory, so a bare
 * `vocabulary.md` and another checkout's `skills/writing/vocabulary.md` are
 * both different files from this repository's, not the same one.
 */
export function isVocabularyFile(filePath: string, vocabularyPath: string): boolean {
  return resolve(filePath) === resolve(vocabularyPath);
}
