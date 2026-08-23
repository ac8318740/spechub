import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectFiles, summarize, reportFile } from './lint-prose.js';
import type { FileReport } from './lint-prose.js';
import { findUp, findPluginRoot } from '../lib/project.js';
import { compileVocabulary } from '../lib/prose.js';
import type { Finding } from '../lib/prose.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spechub-lint-prose-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('collectFiles', () => {
  it('returns an explicit path as given, whether or not it ends in .md', () => {
    const txtFile = join(root, 'notes.txt');
    writeFileSync(txtFile, 'plain text, not markdown');
    const result = collectFiles([txtFile], { root });
    expect(result.files).toEqual([txtFile]);
    expect(result.missing).toEqual([]);
  });

  it('walks a directory argument for .md files at any depth', () => {
    mkdirSync(join(root, 'docs', 'deep'), { recursive: true });
    writeFileSync(join(root, 'docs', 'top.md'), '# top');
    writeFileSync(join(root, 'docs', 'deep', 'nested.md'), '# nested');
    writeFileSync(join(root, 'docs', 'deep', 'ignore.txt'), 'not markdown');

    const result = collectFiles([join(root, 'docs')], { root });

    expect(result.files.sort()).toEqual(
      [join(root, 'docs', 'top.md'), join(root, 'docs', 'deep', 'nested.md')].sort()
    );
  });

  it('walks opts.root for every .md file when --all is set', () => {
    mkdirSync(join(root, 'x', 'y'), { recursive: true });
    writeFileSync(join(root, 'x', 'y', 'z.md'), '# z');
    writeFileSync(join(root, 'top.md'), '# top');

    const result = collectFiles([], { all: true, root });

    expect(result.files.sort()).toEqual(
      [join(root, 'top.md'), join(root, 'x', 'y', 'z.md')].sort()
    );
  });

  it('excludes node_modules at any depth, including nested occurrences', () => {
    mkdirSync(join(root, 'a', 'b', 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'node_modules', 'c.md'), '# c');
    writeFileSync(join(root, 'a', 'included.md'), '# included');

    const result = collectFiles([root], { all: true, root });

    expect(result.files).not.toContain(join(root, 'a', 'b', 'node_modules', 'c.md'));
    expect(result.files).toContain(join(root, 'a', 'included.md'));
  });

  it('excludes .git at any depth', () => {
    mkdirSync(join(root, 'a', 'b', '.git'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', '.git', 'c.md'), '# c');
    writeFileSync(join(root, 'a', 'included.md'), '# included');

    const result = collectFiles([root], { all: true, root });

    expect(result.files).not.toContain(join(root, 'a', 'b', '.git', 'c.md'));
    expect(result.files).toContain(join(root, 'a', 'included.md'));
  });

  it('excludes dist at any depth', () => {
    mkdirSync(join(root, 'a', 'b', 'dist'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'dist', 'c.md'), '# c');
    writeFileSync(join(root, 'a', 'included.md'), '# included');

    const result = collectFiles([root], { all: true, root });

    expect(result.files).not.toContain(join(root, 'a', 'b', 'dist', 'c.md'));
    expect(result.files).toContain(join(root, 'a', 'included.md'));
  });

  it('excludes .claude at any depth, including nested skill files', () => {
    mkdirSync(join(root, 'a', '.claude', 'skills'), { recursive: true });
    writeFileSync(join(root, 'a', '.claude', 'skills', 'x.md'), '# x');
    writeFileSync(join(root, 'a', 'included.md'), '# included');

    const result = collectFiles([root], { all: true, root });

    expect(result.files).not.toContain(join(root, 'a', '.claude', 'skills', 'x.md'));
    expect(result.files).toContain(join(root, 'a', 'included.md'));
  });

  it('does not follow a symlinked directory into an already-reachable target', () => {
    const targetDir = join(root, 'target');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'note.md'), '# note');
    const walkDir = join(root, 'walk');
    mkdirSync(walkDir, { recursive: true });
    symlinkSync(targetDir, join(walkDir, 'linked'), 'dir');

    const result = collectFiles([targetDir, walkDir], { root });

    const occurrences = result.files.filter(f => f === join(targetDir, 'note.md'));
    expect(occurrences).toHaveLength(1);
    expect(result.files).not.toContain(join(walkDir, 'linked', 'note.md'));
  });

  it('does not follow a symlink back to an ancestor, and terminates instead of recursing forever', () => {
    // An explicit timeout means a regression to infinite recursion fails
    // this test (timeout) instead of hanging the whole suite forever -
    // `not.toThrow()` alone would never catch that, since a hang never
    // throws.
    const loopRoot = join(root, 'loop-root');
    mkdirSync(join(loopRoot, 'a', 'b'), { recursive: true });
    writeFileSync(join(loopRoot, 'a', 'real.md'), '# real');
    symlinkSync(join(loopRoot, 'a'), join(loopRoot, 'a', 'b', 'loop'), 'dir');

    let result: ReturnType<typeof collectFiles> | undefined;
    expect(() => {
      result = collectFiles([loopRoot], { root });
    }).not.toThrow();
    expect(result!.files).toContain(join(loopRoot, 'a', 'real.md'));
    // The looped-back symlink path must not also surface the same file a
    // second time under its symlinked alias.
    expect(result!.files).not.toContain(join(loopRoot, 'a', 'b', 'loop', 'real.md'));
  }, 5000);

  it('puts a nonexistent path into missing, never into files, and does not throw', () => {
    const missingFile = join(root, 'does-not-exist.md');
    const missingDir = join(root, 'also-missing');

    let result: ReturnType<typeof collectFiles> | undefined;
    expect(() => {
      result = collectFiles([missingFile, missingDir], { root });
    }).not.toThrow();

    expect(result!.files).toEqual([]);
    expect(result!.missing).toEqual([missingFile, missingDir]);
  });

  it('deduplicates files that are reachable more than once', () => {
    mkdirSync(join(root, 'dir'), { recursive: true });
    const explicitFile = join(root, 'dir', 'a.md');
    writeFileSync(explicitFile, '# a');
    writeFileSync(join(root, 'dir', 'b.md'), '# b');

    const result = collectFiles([join(root, 'dir'), explicitFile, join(root, 'dir')], { root });

    // Literal expected array with an exact length: a dedup bug that drops a
    // file entirely (rather than just collapsing duplicates) would still
    // pass a bare Set-based re-dedup assertion, but not this one.
    expect(result.files).toEqual([explicitFile, join(root, 'dir', 'b.md')]);
  });

  it('returns files in a deterministic order, independent of non-alphabetical insertion order', () => {
    mkdirSync(join(root, 'dir'), { recursive: true });
    // Created out of alphabetical order, so a correctly-ordered result
    // cannot be an accident of creation order.
    writeFileSync(join(root, 'dir', 'zebra.md'), '# z');
    writeFileSync(join(root, 'dir', 'apple.md'), '# a');
    writeFileSync(join(root, 'dir', 'mango.md'), '# m');

    const result = collectFiles([join(root, 'dir')], { root });

    expect(result.files).toEqual([
      join(root, 'dir', 'apple.md'),
      join(root, 'dir', 'mango.md'),
      join(root, 'dir', 'zebra.md'),
    ]);
  });
});

describe('summarize', () => {
  // Only the count matters to summarize, so every finding is the same stub.
  const findings = (n: number): Finding[] =>
    Array.from({ length: n }, (_, index) => ({
      line: index + 1,
      column: 1,
      rule: 'vocabulary',
      message: 'stub finding',
    }));

  it('sums findings across all files into total', () => {
    const reports: FileReport[] = [
      { path: 'a.md', findings: findings(2) },
      { path: 'b.md', findings: findings(1) },
      { path: 'c.md', findings: findings(0) },
    ];

    expect(summarize(reports).total).toBe(3);
  });

  it('sorts perFile by count descending, breaking ties by path', () => {
    const reports: FileReport[] = [
      { path: 'z.md', findings: findings(2) },
      { path: 'a.md', findings: findings(2) },
      { path: 'm.md', findings: findings(5) },
    ];

    const summary = summarize(reports);

    expect(summary.perFile).toEqual([
      { path: 'm.md', count: 5 },
      { path: 'a.md', count: 2 },
      { path: 'z.md', count: 2 },
    ]);
  });

  it('counts every file considered in totalFiles, including skipped and unreadable ones', () => {
    const reports: FileReport[] = [
      { path: 'a.md', findings: findings(3) },
      { path: 'clean.md', findings: findings(0) },
      { path: 'vocab.md', findings: [], skipped: true },
      { path: 'broken.md', findings: [], unreadable: true },
    ];

    const summary = summarize(reports);

    expect(summary.totalFiles).toBe(4);
    expect(summary.filesWithFindings).toBe(1);
    expect(summary.total).toBe(3);
  });

  it('keeps a skipped vocabulary file out of perFile despite counting it in totalFiles', () => {
    const reports: FileReport[] = [
      { path: 'a.md', findings: findings(1) },
      { path: 'vocab.md', findings: [], skipped: true },
    ];

    const summary = summarize(reports);

    expect(summary.perFile).toEqual([{ path: 'a.md', count: 1 }]);
    expect(summary.totalFiles).toBe(2);
  });

  it('keeps an unreadable file out of perFile despite counting it in totalFiles', () => {
    const reports: FileReport[] = [
      { path: 'a.md', findings: findings(1) },
      { path: 'broken.md', findings: [], unreadable: true },
    ];

    const summary = summarize(reports);

    expect(summary.perFile).toEqual([{ path: 'a.md', count: 1 }]);
    expect(summary.totalFiles).toBe(2);
  });

  it('returns zeros and empty arrays for an empty report list, without throwing', () => {
    let summary: ReturnType<typeof summarize> | undefined;
    expect(() => {
      summary = summarize([]);
    }).not.toThrow();

    expect(summary).toEqual({ perFile: [], total: 0, filesWithFindings: 0, totalFiles: 0 });
  });
});

describe('findUp', () => {
  it('returns the nearest ancestor containing the marker, starting at startDir itself', () => {
    mkdirSync(join(root, 'here'), { recursive: true });
    writeFileSync(join(root, 'here', 'marker.txt'), 'x');

    expect(findUp(join(root, 'here'), 'marker.txt')).toBe(join(root, 'here'));
  });

  it('walks up past directories that lack the marker', () => {
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'marker.txt'), 'x');

    expect(findUp(join(root, 'a', 'b', 'c'), 'marker.txt')).toBe(join(root, 'a', 'b'));
  });

  it('accepts a nested marker path, not only a bare filename', () => {
    mkdirSync(join(root, 'proj', '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, 'proj', '.claude-plugin', 'plugin.json'), '{}');
    mkdirSync(join(root, 'proj', 'src', 'deep'), { recursive: true });

    const found = findUp(join(root, 'proj', 'src', 'deep'), '.claude-plugin/plugin.json');

    expect(found).toBe(join(root, 'proj'));
  });

  it('returns null and stops at the filesystem root when no ancestor has the marker', () => {
    mkdirSync(join(root, 'lonely', 'nested'), { recursive: true });

    expect(
      findUp(join(root, 'lonely', 'nested'), 'spechub-test-marker-that-does-not-exist.xyz')
    ).toBeNull();
  });

  it('picks the nearest match when two ancestors both hold the marker', () => {
    mkdirSync(join(root, 'far', 'near', 'start'), { recursive: true });
    writeFileSync(join(root, 'marker.txt'), 'far');
    writeFileSync(join(root, 'far', 'near', 'marker.txt'), 'near');

    const found = findUp(join(root, 'far', 'near', 'start'), 'marker.txt');

    expect(found).toBe(join(root, 'far', 'near'));
  });
});

describe('findPluginRoot', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.CLAUDE_PLUGIN_ROOT;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    } else {
      process.env.CLAUDE_PLUGIN_ROOT = savedEnv;
    }
  });

  it('prefers CLAUDE_PLUGIN_ROOT when it really holds .claude-plugin/plugin.json', () => {
    const pluginDir = join(root, 'good-plugin');
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), '{}');
    process.env.CLAUDE_PLUGIN_ROOT = pluginDir;

    // an unrelated ancestor also has a valid marker, to prove the env var wins over walking up
    mkdirSync(join(root, 'elsewhere', '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, 'elsewhere', '.claude-plugin', 'plugin.json'), '{}');

    expect(findPluginRoot(join(root, 'elsewhere'))).toBe(pluginDir);
  });

  it('falls back to walking up when CLAUDE_PLUGIN_ROOT points somewhere invalid', () => {
    const staleDir = join(root, 'stale');
    mkdirSync(staleDir, { recursive: true });
    process.env.CLAUDE_PLUGIN_ROOT = staleDir;

    const pluginDir = join(root, 'real-plugin');
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), '{}');
    mkdirSync(join(pluginDir, 'src'), { recursive: true });

    expect(findPluginRoot(join(pluginDir, 'src'))).toBe(pluginDir);
  });

  it('falls back to walking up when CLAUDE_PLUGIN_ROOT is unset', () => {
    delete process.env.CLAUDE_PLUGIN_ROOT;

    const pluginDir = join(root, 'unset-plugin');
    mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), '{}');
    mkdirSync(join(pluginDir, 'src'), { recursive: true });

    expect(findPluginRoot(join(pluginDir, 'src'))).toBe(pluginDir);
  });
});

describe('reportFile', () => {
  // A small hand-written vocabulary, not the shipped one: 'utilize' is a
  // 'words' section violation with a suggested replacement.
  const testVocabulary = () =>
    compileVocabulary([{ avoid: 'utilize', writeInstead: 'use', note: '', section: 'words' }]);

  /**
   * Whether this environment can read a file chmod'd to 0o000 (root, some
   * sandboxes, certain filesystems).
   *
   * This reads the file directly - it must NOT consult reportFile's return
   * value. reportFile is the code under test: asking it whether it saw the
   * file as unreadable would let a regression that stops marking files
   * unreadable masquerade as "the environment can read anything", skipping
   * the very assertions meant to catch that regression.
   */
  function canReadDespiteNoPermission(file: string): boolean {
    try {
      readFileSync(file, 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  it('returns findings for a readable file that violates the vocabulary, tagged with the display path', () => {
    const file = join(root, 'doc.md');
    writeFileSync(file, 'Please utilize the tool.');
    const display = 'doc.md';

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const report = reportFile(file, display, testVocabulary());

      expect(report.path).toBe(display);
      expect(report.unreadable).toBeFalsy();
      expect(report.findings.length).toBeGreaterThan(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('marks a file unreadable and returns no findings when it cannot be read, without throwing', ctx => {
    const file = join(root, 'secret.md');
    const display = 'secret.md';
    writeFileSync(file, 'Please utilize the tool.');
    chmodSync(file, 0o000);

    try {
      if (canReadDespiteNoPermission(file)) {
        // A process that can still read a 0o000 file (running as root, or
        // some sandboxed test environments) cannot exercise this scenario.
        ctx.skip();
        return;
      }

      let report: ReturnType<typeof reportFile> | undefined;
      expect(() => {
        report = reportFile(file, display, testVocabulary());
      }).not.toThrow();

      expect(report).toEqual({ path: display, findings: [], unreadable: true });
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it('writes a warning naming the file to stderr when the file cannot be read', ctx => {
    const file = join(root, 'secret2.md');
    const display = 'secret2.md';
    writeFileSync(file, 'Please utilize the tool.');
    chmodSync(file, 0o000);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      if (canReadDespiteNoPermission(file)) {
        // See the previous test: probed directly, independent of reportFile.
        ctx.skip();
        return;
      }

      const report = reportFile(file, display, testVocabulary());

      expect(report.unreadable).toBe(true);
      expect(errorSpy).toHaveBeenCalled();
      const printed = errorSpy.mock.calls.map(call => call.join(' ')).join('\n');
      expect(printed).toContain(display);
    } finally {
      errorSpy.mockRestore();
      chmodSync(file, 0o600);
    }
  });

  it('continues past an unreadable file and still reports both files, in processing order', ctx => {
    const goodFile = join(root, 'good.md');
    const goodDisplay = 'good.md';
    writeFileSync(goodFile, 'Please utilize the tool.');

    const badFile = join(root, 'bad.md');
    const badDisplay = 'bad.md';
    writeFileSync(badFile, 'Please utilize the tool.');
    chmodSync(badFile, 0o000);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      if (canReadDespiteNoPermission(badFile)) {
        // See the earlier tests: probed directly, independent of reportFile.
        ctx.skip();
        return;
      }

      const vocabulary = testVocabulary();
      const reports: FileReport[] = [
        reportFile(goodFile, goodDisplay, vocabulary),
        reportFile(badFile, badDisplay, vocabulary),
      ];

      // Both files produced a report, in the order they were processed - the
      // failure on `bad.md` did not stop the run before it got there.
      expect(reports.map(report => report.path)).toEqual([goodDisplay, badDisplay]);
      expect(reports[1].unreadable).toBe(true);

      const summary = summarize(reports);
      expect(summary.totalFiles).toBe(2);
      expect(summary.total).toBe(reports[0].findings.length);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      chmodSync(badFile, 0o600);
    }
  });
});
