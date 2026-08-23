// `spechub lint-prose` – warn about prose that drifts from the writing
// standard. The checks live in lib/prose.ts; this file owns the filesystem, the
// path walking and the output.
//
// The deny lists are read at runtime from the vocabulary that ships with the
// plugin (see VOCABULARY_PATH in lib/constants.ts), so editing that file changes
// the lint with no rebuild.
import { Command } from 'commander';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import chalk from 'chalk';
import fg from 'fast-glob';
import { VOCABULARY_PATH } from '../lib/constants.js';
import { findPluginRoot, findProjectRoot } from '../lib/project.js';
import { fail, readMarkdown } from '../lib/utils.js';
import {
  RULES,
  compileVocabulary,
  isVocabularyFile,
  lintProse,
  parseVocabulary,
  type CompiledEntry,
  type Finding,
} from '../lib/prose.js';

const IGNORED = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/.claude/**'];

// Derived from the rule list so a new rule cannot silently misalign the output.
const RULE_WIDTH = Math.max(...RULES.map(rule => rule.length)) + 2;

const VOCABULARY_HINT =
  'lint-prose reads its word and mark lists from the plugin, not from your project.';

interface LoadedVocabulary {
  entries: CompiledEntry[];
  /** The resolved path the vocabulary was read from. */
  path: string;
  warnings: { line: number; message: string }[];
}

function loadVocabulary(): LoadedVocabulary {
  const pluginRoot = findPluginRoot();
  if (!pluginRoot) {
    fail(
      `Cannot read the vocabulary file: ${VOCABULARY_PATH} ` +
        `(no plugin root found above ${import.meta.dirname})`,
      VOCABULARY_HINT
    );
  }

  const path = join(pluginRoot, VOCABULARY_PATH);
  let markdown: string | null = null;
  try {
    markdown = readMarkdown(path);
  } catch (err) {
    fail(`Cannot read the vocabulary file: ${path} (${(err as Error).message})`, VOCABULARY_HINT);
  }
  if (markdown === null) fail(`Cannot read the vocabulary file: ${path}`, VOCABULARY_HINT);

  const parsed = parseVocabulary(markdown);
  return { entries: compileVocabulary(parsed.entries), path, warnings: parsed.warnings };
}

// ---------------------------------------------------------------------------
// Collecting files. Pure: it neither prints nor exits, so it can be tested
// directly and the caller decides what a missing path is worth.
// ---------------------------------------------------------------------------

export interface CollectResult {
  files: string[];
  missing: string[];
}

function markdownIn(dir: string): string[] {
  return fg.sync('**/*.md', {
    cwd: dir,
    absolute: true,
    ignore: IGNORED,
    dot: false,
    // A symlinked directory is not walked: it would double-report a target
    // reachable another way, and a link to an ancestor would loop forever.
    followSymbolicLinks: false,
  });
}

export function collectFiles(paths: string[], opts: { all?: boolean; root: string }): CollectResult {
  const files: string[] = [];
  const missing: string[] = [];

  if (opts.all) files.push(...markdownIn(opts.root));

  for (const path of paths) {
    const full = resolve(path);
    if (!existsSync(full)) {
      missing.push(path);
      continue;
    }
    if (statSync(full).isDirectory()) {
      files.push(...markdownIn(full));
    } else {
      // An explicit path is linted as given, whether or not it ends in .md.
      files.push(full);
    }
  }

  return { files: [...new Set(files)].sort(), missing };
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

export interface FileReport {
  path: string;
  findings: Finding[];
  /** The vocabulary file itself: looked at, deliberately not linted. */
  skipped?: boolean;
  /** Could not be read; counted, so the denominator stays honest. */
  unreadable?: boolean;
}

export interface Summary {
  /** Files with at least one finding, worst first, ties broken by path. */
  perFile: { path: string; count: number }[];
  total: number;
  filesWithFindings: number;
  /** Every file considered, skipped and unreadable ones included. */
  totalFiles: number;
}

export function summarize(reports: FileReport[]): Summary {
  const counted = reports.filter(report => !report.skipped && !report.unreadable);

  const perFile = counted
    .filter(report => report.findings.length > 0)
    .map(report => ({ path: report.path, count: report.findings.length }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

  return {
    perFile,
    total: counted.reduce((sum, report) => sum + report.findings.length, 0),
    filesWithFindings: perFile.length,
    totalFiles: reports.length,
  };
}

// Pad before colouring: chalk's escape codes would otherwise count as width.
function ruleLabel(rule: Finding['rule']): string {
  const padded = rule.padEnd(RULE_WIDTH);
  switch (rule) {
    case 'vocabulary':
      return chalk.yellow(padded);
    case 'mark':
      return chalk.magenta(padded);
    case 'emoji':
      return chalk.red(padded);
    default:
      return chalk.cyan(padded);
  }
}

// Show a path relative to the walk root, unless the file sits outside it,
// where the absolute path is the readable one.
function displayPath(root: string, file: string): string {
  const rel = relative(root, file);
  return rel === '' || rel.startsWith('..') ? file : rel;
}

// One file in, one FileReport out: read it, lint it, print what it found.
// Exported for its failure handling, not because anything else in the CLI calls
// it. An unreadable file must never end the run, and that guarantee is only
// testable if the function that catches the read failure can be called on its
// own.
export function reportFile(file: string, display: string, vocabulary: CompiledEntry[]): FileReport {
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch {
    // One unreadable file must never end the run.
    console.error(chalk.yellow(`Cannot read, skipping: ${display}`));
    return { path: display, findings: [], unreadable: true };
  }

  const findings = lintProse(text, vocabulary);
  if (findings.length > 0) {
    console.log(chalk.bold(display));
    for (const finding of findings) {
      const where = `${finding.line}:${finding.column}`.padStart(9);
      console.log(`  ${chalk.dim(where)}  ${ruleLabel(finding.rule)} ${finding.message}`);
    }
    console.log('');
  }
  return { path: display, findings };
}

function printVocabularyWarnings(warnings: LoadedVocabulary['warnings'], path: string): void {
  if (warnings.length === 0) return;
  console.error(chalk.yellow(`${path}: ${warnings.length} row(s) dropped while parsing`));
  for (const warning of warnings) {
    console.error(chalk.yellow(`  line ${warning.line}: ${warning.message}`));
  }
  console.error('');
}

// The summary is the point under --all: one line per file, sorted by count, so
// the worst file is at the top of the worklist.
function printSummary(summary: Summary, missing: string[]): void {
  console.log(chalk.bold('Summary'));

  if (missing.length > 0) {
    console.log(chalk.yellow(`  ${missing.length} path(s) not found`));
  }

  if (summary.perFile.length === 0) {
    console.log(chalk.green(`  clean: ${summary.totalFiles} file(s), no findings`));
    return;
  }

  for (const entry of summary.perFile) {
    console.log(`  ${chalk.yellow(String(entry.count).padStart(5))}  ${entry.path}`);
  }
  console.log(
    `  ${chalk.bold(String(summary.total).padStart(5))}  ` +
      `total in ${summary.filesWithFindings} of ${summary.totalFiles} file(s)`
  );
}

export function register(program: Command): void {
  program
    .command('lint-prose')
    .description('Warn about prose that drifts from the writing standard')
    .argument('[paths...]', 'files or directories to lint')
    .option('--all', 'lint every .md file in the repository')
    .action((paths: string[], opts: { all?: boolean }) => {
      const root = findProjectRoot() ?? process.cwd();

      if (paths.length === 0 && !opts.all) {
        fail('Give one or more paths, or --all to lint the repository.');
      }

      const vocabulary = loadVocabulary();
      printVocabularyWarnings(vocabulary.warnings, vocabulary.path);

      const { files, missing } = collectFiles(paths, { all: opts.all, root });
      for (const path of missing) {
        console.error(chalk.yellow(`Not found, skipping: ${path}`));
      }
      if (paths.length > 0 && missing.length === paths.length) {
        fail(
          `None of the ${paths.length} requested path(s) exist.`,
          'Check the paths, or use --all to lint the repository.'
        );
      }

      const reports: FileReport[] = [];
      for (const file of files) {
        const display = displayPath(root, file);
        if (isVocabularyFile(file, vocabulary.path)) {
          console.log(chalk.dim(`${display}: skipped, this is the vocabulary file itself\n`));
          reports.push({ path: display, findings: [], skipped: true });
          continue;
        }
        reports.push(reportFile(file, display, vocabulary.entries));
      }

      printSummary(summarize(reports), missing);
    });
}
