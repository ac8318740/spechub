import { existsSync, mkdirSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import chalk from 'chalk';
import { SPECHUB_DIR, CHANGES_DIR, SPECS_DIR, ARCHIVE_DIR } from './constants.js';
import { findProjectRoot } from './project.js';

/**
 * Print an error to stderr and exit 1. The optional hint goes on a second
 * line, dimmed, for the "what to do about it" half of the message.
 */
export function fail(message: string, hint?: string): never {
  console.error(chalk.red(message));
  if (hint) console.error(chalk.dim(hint));
  process.exit(1);
}

/** An error carrying the dimmed second line `fail` prints under it. */
interface HintedError extends Error {
  hint?: string;
}

/**
 * The hint an error carries, for a caller that catches it and calls `fail`.
 *
 * A thrown error reaches the user through whatever catches it, so the "what to
 * do about it" half has to travel with it rather than be written at the throw.
 */
export function errorHint(err: unknown): string | undefined {
  return (err as HintedError).hint;
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function readYaml<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  return parseYaml(readFileSync(path, 'utf-8')) as T;
}

export function readMarkdown(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

export function listChanges(root: string): string[] {
  const dir = join(root, SPECHUB_DIR, CHANGES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== ARCHIVE_DIR)
    .map(e => e.name);
}

export function listSpecs(root: string): string[] {
  const dir = join(root, SPECHUB_DIR, SPECS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
}

export function listArchivedChanges(root: string): string[] {
  const dir = join(root, SPECHUB_DIR, CHANGES_DIR, ARCHIVE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
}

export function requireProject(root: string | null): asserts root is string {
  if (!root) fail('Not in a SpecHub project. Run `/spechub:setup` first.');
}

/**
 * Wrap a subcommand action so it runs inside a project, with anything it throws
 * reported as a clean CLI error.
 *
 * The wrapper finds the project root, refuses when there is none, then hands
 * the root to the action as its first argument. A subcommand written without
 * it turns a thrown error into a stack trace, which is why the preamble is one
 * wrapper rather than four lines each action repeats.
 */
export function inProject<A extends unknown[]>(action: (root: string, ...args: A) => void) {
  return (...args: A): void => {
    const root = findProjectRoot();
    requireProject(root);
    try {
      action(root, ...args);
    } catch (err) {
      fail((err as Error).message, errorHint(err));
    }
  };
}

export function formatDate(): string {
  return new Date().toISOString().split('T')[0];
}

// A four-byte shared buffer nobody ever writes to, so Atomics.wait on it always
// times out. It is the only way to nap on the main thread without an event loop
// turn, which a synchronous read cannot afford.
const NAP = new Int32Array(new SharedArrayBuffer(4));
const NAP_MS = 5;
const CHUNK_BYTES = 64 * 1024;
// The retry below spins until the producer answers, so something has to say
// when it has waited long enough. The window measures silence, not total
// duration - a producer streaming steadily for a minute is healthy, and one
// that has sent nothing for thirty seconds is not. Thirty seconds is far
// longer than any gap `gh issue list` leaves, and short enough that a caller
// notices rather than assuming the command hung.
const DEFAULT_STDIN_SILENCE_MS = 30_000;
// A genuinely slow producer needs a wider window, and the tests need a much
// narrower one. Both read the same knob.
const STDIN_SILENCE_ENV = 'SPECHUB_STDIN_SILENCE_MS';

// The refusal for a caller that names no sentence of its own. `node diagram
// --stdin` is that caller, and the pipe it names is the one it documents.
const TTY_REFUSAL =
  'nothing is piped into stdin - stdin is a terminal. Pipe the input in, ' +
  'as in `gh issue list --json ... | spechub ...`.';

/** The silence window in milliseconds, from the environment or the default. */
function stdinSilenceMs(): number {
  const raw = Number(process.env[STDIN_SILENCE_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STDIN_SILENCE_MS;
}

/**
 * Read the whole of stdin, synchronously.
 *
 * `readFileSync(0)` alone is not enough. When the producer is slower to answer
 * than this process is to start - `gh issue list | spechub ...` always is - the
 * pipe is still empty on the first read, and a non-blocking fd 0 answers EAGAIN
 * rather than waiting. So the read retries on EAGAIN with a short nap between
 * tries, and stops on the end of the pipe.
 *
 * Two things stop the retry becoming a hang. A terminal on fd 0 means nothing
 * was piped in at all, and a read there would block until the user typed
 * something and pressed ctrl-D, with no prompt to say so - that is refused at
 * entry. A pipe that stays silent is refused at the window.
 *
 * Every successful read restarts that window, so it caps the gap between two
 * pieces of input rather than the whole transfer. A producer streaming for two
 * minutes in steady pieces is never cut off.
 *
 * `ttyRefusal` is the sentence the terminal refusal reads. A caller passes one
 * to name its own flag, because the default names the `gh issue list` pipe and
 * only one caller has that pipe.
 */
export function readStdin(ttyRefusal?: string): string {
  if (process.stdin.isTTY) {
    throw new Error(ttyRefusal ?? TTY_REFUSAL);
  }
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(CHUNK_BYTES);
  const windowMs = stdinSilenceMs();
  let silentAfter = Date.now() + windowMs;
  for (;;) {
    let read: number;
    try {
      read = readSync(0, buffer, 0, buffer.length, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') {
        if (Date.now() >= silentAfter) throw stdinWentSilent(windowMs);
        Atomics.wait(NAP, 0, 0, NAP_MS);
        continue;
      }
      if (code === 'EOF') break;
      throw err;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
    silentAfter = Date.now() + windowMs;
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function stdinWentSilent(windowMs: number): Error {
  const err: HintedError = new Error(
    `stdin has been silent for ${windowMs / 1000} seconds - the pipe is open ` +
      'and nothing has arrived in that time.'
  );
  err.name = 'StdinSilenceError';
  // A genuinely slow producer is a real case, so the refusal names the knob
  // that widens the window rather than leaving the user to find it.
  err.hint = `Set ${STDIN_SILENCE_ENV} to widen the window, in milliseconds.`;
  return err;
}
