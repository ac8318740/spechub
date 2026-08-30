// Node #218: `spechub archive`, `spechub list` and `spechub show` each open
// with `findProjectRoot()` then `requireProject(root)`, and neither wraps its
// body. Anything the body throws reaches the user as a raw Node stack trace.
//
// `cli/src/commands/node.ts` already solves this with an `inProject` wrapper
// that catches and routes through `fail(message, hint)`. #218 moves that
// wrapper into the CLI's lib and routes these three through it.
//
// These tests spawn the built CLI and build real temporary projects on disk,
// the same way node.test.ts and config.test.ts do. No mocks. A throw is
// forced by making a real filesystem operation fail: a directory that cannot
// be read, a file that cannot be read, a directory that cannot be written
// into.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = join(__dirname, '..', '..', 'bin', 'spechub.js');

/** The refusal `requireProject` prints when no ancestor holds a spechub/ directory. */
const NOT_A_PROJECT = 'Not in a SpecHub project. Run `/spechub:setup` first.';

function runCli(args: string[], opts: { cwd?: string } = {}) {
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: 'utf-8',
    cwd: opts.cwd,
    env: { ...process.env },
    // Bounded so a hung child can never hang the test run.
    timeout: 10_000,
  });
}

/** The shape `spechub list --json` prints for one entry. */
interface ListItemJson {
  name: string;
  type: 'change' | 'spec';
  path: string;
  modified?: string;
  artifacts?: string[];
}

/** The shape `spechub show <spec> --json` prints. */
interface ShowSpecJson {
  name: string;
  type: 'spec';
  content: string;
}

/**
 * A temp SpecHub project holding one change with one artifact, one spec, and
 * an existing archive directory.
 *
 * Every command under test needs a project that actually has something in it:
 * `list` needs a change to walk into, `show` needs a spec to read, `archive`
 * needs a change to copy and a destination to copy it to.
 */
function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'spechub-project-cmds-'));
  mkdirSync(join(root, 'spechub'), { recursive: true });
  writeFileSync(join(root, 'spechub', 'project.yaml'), '# test project\n');
  mkdirSync(changeDir(root), { recursive: true });
  writeFileSync(join(changeDir(root), 'proposal.md'), '# Proposal\n\nSome prose.\n');
  mkdirSync(specDir(root), { recursive: true });
  writeFileSync(join(specDir(root), 'spec.md'), '# Spec\n\nSome prose.\n');
  mkdirSync(archiveDir(root), { recursive: true });
  return root;
}

const CHANGE_NAME = 'mychange';
const SPEC_NAME = 'myspec';

function changeDir(root: string): string {
  return join(root, 'spechub', 'changes', CHANGE_NAME);
}

function specDir(root: string): string {
  return join(root, 'spechub', 'specs', SPEC_NAME);
}

function archiveDir(root: string): string {
  return join(root, 'spechub', 'changes', 'archive');
}

/**
 * Every path this file chmod'd, and the mode to put back.
 *
 * A test that fails partway through must still leave a deletable temp
 * directory behind, so the restore runs from `afterEach` rather than from the
 * test body.
 */
let chmodded: Array<{ path: string; mode: number }> = [];

function denyAccess(path: string, mode: number, restoreTo: number): void {
  chmodSync(path, mode);
  chmodded.push({ path, mode: restoreTo });
}

/**
 * Whether this process can still read a directory chmod'd to 0o000 (it can as
 * root, and in some sandboxes and on some filesystems).
 *
 * This probes the filesystem directly. Asking the CLI whether it saw an error
 * would let a regression that stops erroring masquerade as "the environment
 * can read anything", skipping the very assertion meant to catch it.
 */
function canReadDirDespiteNoPermission(dir: string): boolean {
  try {
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** Whether this process can still read a file chmod'd to 0o000. See above. */
function canReadFileDespiteNoPermission(file: string): boolean {
  try {
    readFileSync(file, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this process can still create a directory inside a read-only one.
 *
 * Probes by creating and removing a directory the CLI never touches, so the
 * probe cannot change what the command under test then finds.
 */
function canWriteDespiteReadOnly(dir: string): boolean {
  const probe = join(dir, '.write-probe');
  try {
    mkdirSync(probe);
    rmSync(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** The reason a skipped test prints, so a skip never reads as a pass. */
const SKIP_READ = 'this process can still read the path chmod 000 denies – running as root?';
const SKIP_WRITE = 'this process can still write into the read-only path – running as root?';

/**
 * Assert stderr carries a clean one-line CLI error and no Node stack trace.
 *
 * A stack trace shows itself three ways: `at <frame>` lines, `node:internal`
 * or `node:fs` source paths, and the `Node.js v<version>` trailer an uncaught
 * exception prints. None may appear.
 */
function expectCleanError(stderr: string): void {
  expect(stderr).not.toMatch(/^\s*at /m);
  expect(stderr).not.toContain('node:internal');
  expect(stderr).not.toContain('node:fs');
  expect(stderr).not.toMatch(/^Node\.js v/m);
  // The message itself, plus at most a hint line under it.
  const lines = stderr.trim().split('\n').filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.length).toBeLessThanOrEqual(2);
  // The error still says what went wrong, rather than being swallowed.
  expect(stderr).toMatch(/permission denied/i);
}

let root: string;
/** A directory with no spechub/ anywhere above it, for the refusal tests. */
let outside: string;

beforeEach(() => {
  root = makeProject();
  outside = mkdtempSync(join(tmpdir(), 'spechub-outside-'));
});

afterEach(() => {
  for (const { path, mode } of chmodded) {
    try {
      chmodSync(path, mode);
    } catch {
      // The path may already be gone; the removal below is what matters.
    }
  }
  chmodded = [];
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// spechub list
// ---------------------------------------------------------------------------

describe('spechub list', () => {
  it('reports an unreadable change directory as a clean error, with no stack trace', ctx => {
    denyAccess(changeDir(root), 0o000, 0o755);
    if (canReadDirDespiteNoPermission(changeDir(root))) {
      ctx.skip(SKIP_READ);
      return;
    }

    const result = runCli(['list'], { cwd: root });

    expect(result.status).toBe(1);
    expectCleanError(result.stderr);
  });

  it('refuses outside a SpecHub project', () => {
    const result = runCli(['list'], { cwd: outside });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(NOT_A_PROJECT);
  });

  it('still lists the changes in a readable project', () => {
    const result = runCli(['list'], { cwd: root });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(CHANGE_NAME);
  });

  it('still prints the changes as JSON in a readable project', () => {
    const result = runCli(['list', '--json'], { cwd: root });

    expect(result.status).toBe(0);
    const items = JSON.parse(result.stdout) as ListItemJson[];
    expect(items.map(item => item.name)).toEqual([CHANGE_NAME]);
    expect(items[0].artifacts).toEqual(['proposal']);
  });
});

// ---------------------------------------------------------------------------
// spechub show
// ---------------------------------------------------------------------------

describe('spechub show', () => {
  it('reports an unreadable spec.md as a clean error, with no stack trace', ctx => {
    const specFile = join(specDir(root), 'spec.md');
    denyAccess(specFile, 0o000, 0o644);
    if (canReadFileDespiteNoPermission(specFile)) {
      ctx.skip(SKIP_READ);
      return;
    }

    const result = runCli(['show', SPEC_NAME], { cwd: root });

    expect(result.status).toBe(1);
    expectCleanError(result.stderr);
  });

  it('reports an unreadable change artifact as a clean error, with no stack trace', ctx => {
    const artifact = join(changeDir(root), 'proposal.md');
    denyAccess(artifact, 0o000, 0o644);
    if (canReadFileDespiteNoPermission(artifact)) {
      ctx.skip(SKIP_READ);
      return;
    }

    const result = runCli(['show', CHANGE_NAME], { cwd: root });

    expect(result.status).toBe(1);
    expectCleanError(result.stderr);
  });

  it('refuses outside a SpecHub project', () => {
    const result = runCli(['show', SPEC_NAME], { cwd: outside });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(NOT_A_PROJECT);
  });

  it('still prints the spec in a readable project', () => {
    const result = runCli(['show', SPEC_NAME], { cwd: root });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# Spec');
  });

  it('still prints the spec as JSON in a readable project', () => {
    const result = runCli(['show', SPEC_NAME, '--json'], { cwd: root });

    expect(result.status).toBe(0);
    const shown = JSON.parse(result.stdout) as ShowSpecJson;
    expect(shown.name).toBe(SPEC_NAME);
    expect(shown.type).toBe('spec');
    expect(shown.content).toContain('# Spec');
  });
});

// ---------------------------------------------------------------------------
// spechub archive
// ---------------------------------------------------------------------------

describe('spechub archive', () => {
  it('reports an unwritable archive destination as a clean error, with no stack trace', ctx => {
    denyAccess(archiveDir(root), 0o500, 0o755);
    if (canWriteDespiteReadOnly(archiveDir(root))) {
      ctx.skip(SKIP_WRITE);
      return;
    }

    const result = runCli(['archive', CHANGE_NAME, '--yes'], { cwd: root });

    expect(result.status).toBe(1);
    expectCleanError(result.stderr);
  });

  it('refuses outside a SpecHub project', () => {
    const result = runCli(['archive', CHANGE_NAME], { cwd: outside });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(NOT_A_PROJECT);
  });

  it('still archives a change in a writable project', () => {
    const result = runCli(['archive', CHANGE_NAME, '--yes'], { cwd: root });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Archived: ${CHANGE_NAME}`);
    expect(readdirSync(archiveDir(root)).some(name => name.endsWith(CHANGE_NAME))).toBe(true);
  });

  it('still lists the active changes when given no name', () => {
    const result = runCli(['archive'], { cwd: root });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(CHANGE_NAME);
  });
});
