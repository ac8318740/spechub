import { existsSync, mkdirSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import chalk from 'chalk';
import { SPECHUB_DIR, CHANGES_DIR, SPECS_DIR, ARCHIVE_DIR } from './constants.js';

/**
 * Print an error to stderr and exit 1. The optional hint goes on a second
 * line, dimmed, for the "what to do about it" half of the message.
 */
export function fail(message: string, hint?: string): never {
  console.error(chalk.red(message));
  if (hint) console.error(chalk.dim(hint));
  process.exit(1);
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
// when it has waited long enough. Thirty seconds is far longer than any `gh
// issue list` takes and short enough that a caller notices rather than assuming
// the command hung.
const STDIN_DEADLINE_MS = 30_000;

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
 * entry. A pipe that is open but silent is refused at the deadline.
 */
export function readStdin(): string {
  if (process.stdin.isTTY) {
    throw new Error(
      'nothing is piped into stdin - stdin is a terminal. Pipe the input in, ' +
        'as in `gh issue list --json ... | spechub ...`.'
    );
  }
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(CHUNK_BYTES);
  const deadline = Date.now() + STDIN_DEADLINE_MS;
  for (;;) {
    let read: number;
    try {
      read = readSync(0, buffer, 0, buffer.length, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') {
        if (Date.now() >= deadline) throw stdinTimedOut();
        Atomics.wait(NAP, 0, 0, NAP_MS);
        continue;
      }
      if (code === 'EOF') break;
      throw err;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function stdinTimedOut(): Error {
  const err = new Error(
    `nothing arrived on stdin within ${STDIN_DEADLINE_MS / 1000} seconds - the ` +
      'pipe is open but the command on the other end has sent nothing.'
  );
  err.name = 'StdinTimeoutError';
  return err;
}
