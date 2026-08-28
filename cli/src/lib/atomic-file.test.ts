import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

/**
 * The two promises `replaceFileAtomically` makes about the attempt that fails,
 * which the CLI suite cannot reach.
 *
 * Every other test of this writer spawns the CLI, and the CLI checks whether
 * the file is writable before it calls the writer at all. So the spawned tests
 * only ever exercise the path where the write succeeds: the temp file's name,
 * and what comes out of a failed attempt, are decided in here and observed
 * nowhere. A module test is the only thing that can watch them.
 */

/**
 * The random half of the temp file's name, held so one test can fix it.
 *
 * `null` means the real thing, which is what all but one test wants. The one
 * that does not needs two attempts in a row to pick the SAME temp path, so it
 * can put something in that path's way, and the only way to arrange that is to
 * stop the name being random for the length of that test.
 */
const randomness = vi.hoisted(() => ({ fixed: null as Buffer | null }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (size: number) => randomness.fixed ?? actual.randomBytes(size),
  };
});

const { replaceFileAtomically } = await import('./atomic-file.js');

/** A temp directory holding one file of `text`, handing back that file's path. */
function fileHolding(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'spechub-atomic-'));
  const file = join(dir, 'project.yaml');
  writeFileSync(file, text, 'utf-8');
  return file;
}

/** What the directory holding `file` holds, so a test can say nothing extra was left behind. */
function entriesBeside(file: string): string[] {
  return readdirSync(join(file, '..')).sort();
}

describe('replaceFileAtomically names each attempt its own temp file', () => {
  it('gives two writes in the same process two different temp paths', () => {
    // The process id is the same for both, so a name built from the pid alone
    // hands back the same string twice and this is the assertion that says so.
    const file = fileHolding('first');
    const temps: string[] = [];

    replaceFileAtomically(file, 'second', (temp) => {
      temps.push(temp);
    });
    replaceFileAtomically(file, 'third', (temp) => {
      temps.push(temp);
    });

    expect(temps).toHaveLength(2);
    expect(temps[0]).not.toBe(temps[1]);
  });

  it('does not write over a temp file a killed run with this pid left behind', () => {
    // The reason the names have to differ, stated as the thing that goes
    // wrong. A run killed between the write and the rename leaves its temp
    // file on disk; pids come round again; and a later run holding that pid
    // would write over a file it did not create and then rename it into place.
    const file = fileHolding('first');
    const temps: string[] = [];

    replaceFileAtomically(file, 'second', (temp) => {
      temps.push(temp);
    });
    const leftover = temps[0];
    writeFileSync(leftover, 'a killed run left this here', 'utf-8');

    replaceFileAtomically(file, 'third', (temp) => {
      temps.push(temp);
    });

    expect(readFileSync(leftover, 'utf-8')).toBe('a killed run left this here');
    expect(readFileSync(file, 'utf-8')).toBe('third');
  });

  it('leaves nothing beside the file it replaced when the write succeeds', () => {
    const file = fileHolding('first');

    replaceFileAtomically(file, 'second');

    expect(entriesBeside(file)).toEqual([basename(file)]);
    expect(readFileSync(file, 'utf-8')).toBe('second');
  });
});

describe('replaceFileAtomically surfaces the failure, not the tidying up after it', () => {
  it('throws the write\'s own error when the temp path is a directory', () => {
    // The temp path is fixed for this test, so the first attempt names it and
    // the second meets a directory sitting in it. That makes both halves fail:
    // the write cannot open a directory, and the cleanup cannot remove one
    // either. The error the caller sees has to be the write's.
    randomness.fixed = Buffer.from([1, 2, 3, 4, 5, 6]);
    try {
      const file = fileHolding('first');
      const temps: string[] = [];
      replaceFileAtomically(file, 'second', (temp) => {
        temps.push(temp);
      });
      mkdirSync(temps[0]);

      let thrown: NodeJS.ErrnoException | undefined;
      try {
        replaceFileAtomically(file, 'third');
      } catch (err) {
        thrown = err as NodeJS.ErrnoException;
      }

      expect(thrown, 'the write onto a directory has to fail').toBeDefined();
      // `open` is the write. Removing the directory fails as `ERR_FS_EISDIR`,
      // which is the error a cleanup allowed to throw would put here instead.
      expect(thrown?.syscall).toBe('open');
      expect(thrown?.code).toBe('EISDIR');
      // The file the caller asked to replace is untouched by the failure.
      expect(readFileSync(file, 'utf-8')).toBe('second');
    } finally {
      randomness.fixed = null;
    }
  });

  it('throws the caller\'s own error when the temp path became a directory before the rename', () => {
    // The same masking, reached without fixing the randomness: the callback
    // gets the temp file, turns it into a directory, and fails. The cleanup
    // then cannot remove what it finds, and the error identity below is what
    // says the caller still got theirs.
    const file = fileHolding('first');
    const failure = new Error('the mode could not be carried across');

    let thrown: unknown;
    try {
      replaceFileAtomically(file, 'second', (temp) => {
        rmSync(temp);
        mkdirSync(temp);
        throw failure;
      });
    } catch (err) {
      thrown = err;
    }

    // Identity, not message: an error rebuilt or replaced on the way out is
    // exactly what this refuses, and two errors reading the same are equal.
    expect(thrown).toBe(failure);
    expect(readFileSync(file, 'utf-8')).toBe('first');
  });

  it('removes the temp file when the write fails and the temp file can be removed', () => {
    const file = fileHolding('first');
    const failure = new Error('the caller could not finish');

    expect(() =>
      replaceFileAtomically(file, 'second', () => {
        throw failure;
      })
    ).toThrow(failure);

    expect(entriesBeside(file)).toEqual([basename(file)]);
    expect(readFileSync(file, 'utf-8')).toBe('first');
  });
});
