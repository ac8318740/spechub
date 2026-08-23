import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = join(__dirname, '..', '..', 'bin', 'spechub.js');

/** The shape of the global config file on disk, as touched by this file's assertions. */
interface StoredConfig {
  host: {
    orchestrators: {
      herdr?: boolean;
      orca?: boolean;
    };
    browser: {
      remote?: boolean;
      headless?: boolean;
      local?: boolean;
    };
    orca: {
      topology?: string;
    };
  };
}

/**
 * The `spechub config show --json` output shape, as touched by this file's
 * assertions. Mirrors the contract documented above the "spechub config show"
 * describe block below.
 */
interface ConfigShowAxis {
  key: string;
  required: boolean;
  status: 'declared' | 'detected' | 'unset';
  value?: unknown;
}

/**
 * Only the `commands.*` entries that are actually set (a `null` or empty
 * string value in project.yaml is not set, and is absent here entirely - not
 * present with a `null` value).
 */
interface ConfigShowProjectCommands {
  [key: string]: string;
}

/**
 * What the project SAYS about its browser, not the effective default the
 * probes fall back to. `cdpPort` in particular is `null` when the project
 * states no `cdp_port`, even though a probe elsewhere would use a default
 * port in that situation.
 */
interface ConfigShowProjectBrowser {
  mode: string | null;
  cdpPort: number | null;
  fallback: string | null;
}

interface ConfigShowProject {
  profile: string | null;
  commands: ConfigShowProjectCommands;
  browser: ConfigShowProjectBrowser | null;
}

interface ConfigShowJson {
  hasProject: boolean;
  hasFrontend: boolean;
  axes: ConfigShowAxis[];
  /** null when no project root is found; otherwise the project facts `show` reports. */
  project: ConfigShowProject | null;
}

/**
 * The `spechub config browser-mode --json` output shape, as touched by this
 * file's assertions. Mirrors the contract documented above the "spechub
 * config browser-mode" describe block further down this file.
 */
interface ConfigBrowserModeJson {
  mode: string;
  preferred: string | null;
  reason: string;
  fallback: boolean;
}

let xdgConfigHome: string;

beforeEach(() => {
  xdgConfigHome = mkdtempSync(join(tmpdir(), 'spechub-cli-config-'));
});

afterEach(() => {
  rmSync(xdgConfigHome, { recursive: true, force: true });
});

/**
 * Run the built CLI. `path`, when given, fully REPLACES the child's PATH
 * (rather than extending the inherited one) so tests can deterministically
 * control which fake executables – or none at all – are "installed". Node
 * itself is invoked via `process.execPath` (an absolute path), so replacing
 * PATH never breaks the ability to spawn node.
 */
function runCli(args: string[], opts: { cwd?: string; path?: string[] } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdgConfigHome };
  if (opts.path) {
    env.PATH = opts.path.join(delimiter);
  }
  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: 'utf-8',
    env,
    cwd: opts.cwd,
    // Bounded so a probe that fails to time out on its own end can never hang
    // the test run; well above anything a correct implementation should take.
    timeout: 10_000,
  });
}

function configFilePath(): string {
  return join(xdgConfigHome, 'spechub', 'config.json');
}

/** An empty directory to use as PATH when a test wants NOTHING resolvable. */
function emptyPathDir(): string {
  return mkdtempSync(join(tmpdir(), 'spechub-empty-path-'));
}

/** Create a directory containing one fake executable `name` that exits with `exitCode`. */
function fakeBinDir(name: string, exitCode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'spechub-fake-bin-'));
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\nexit ${exitCode}\n`);
  chmodSync(file, 0o755);
  return dir;
}

/**
 * Like `fakeBinDir`, but the fake executable also writes `stdout` to its
 * standard output (and `stderr`, when given, to its standard error) before
 * exiting with `exitCode`. For probes that read what a command printed, not
 * just whether it succeeded – the Orca probe reads its JSON, not merely its
 * exit status.
 */
function fakeBinDirWithOutput(
  name: string,
  exitCode: number,
  stdout: string,
  stderr = ''
): string {
  const dir = mkdtempSync(join(tmpdir(), 'spechub-fake-bin-'));
  const file = join(dir, name);
  const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  const lines = ['#!/bin/sh'];
  if (stdout) lines.push(`printf '%s' ${shQuote(stdout)}`);
  if (stderr) lines.push(`printf '%s' ${shQuote(stderr)} >&2`);
  lines.push(`exit ${exitCode}`);
  writeFileSync(file, lines.join('\n') + '\n');
  chmodSync(file, 0o755);
  return dir;
}

/** A minimal `orca-ide status --json` / `orca status --json` response body. */
function orcaStatusJson(reachable: boolean, state: string): string {
  return JSON.stringify({ id: '1', ok: true, result: { runtime: { reachable, state } } });
}

/** The reachable-and-ready response that makes the Orca probe pass. */
const ORCA_READY_JSON = orcaStatusJson(true, 'ready');

/** The docs URL a failing Orca probe must point the user at. */
const ORCA_DOCS_URL = 'https://docs.orca.dev/headless-linux';

/** Create a temp project root containing spechub/project.yaml with `yaml` as its body. */
function makeProject(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), 'spechub-project-'));
  mkdirSync(join(root, 'spechub'), { recursive: true });
  writeFileSync(join(root, 'spechub', 'project.yaml'), yaml);
  return root;
}

/** An isolated cwd guaranteed to have no spechub/ directory anywhere above it. */
function noProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'spechub-no-project-'));
}

type FakeServer = { port: number; close: () => Promise<void> };

/**
 * Spawn `script` (a self-contained node -e body) as a SEPARATE child process
 * and wait for it to report the ephemeral port it bound, via a `PORT <n>`
 * line on stdout.
 *
 * This has to be a real child process, not a server started inline in this
 * test process: the test then calls `spawnSync` to run the CLI, which BLOCKS
 * this process until the CLI exits. An in-process server can still accept a
 * connection off the OS listen backlog while blocked, but it can never write
 * a response – so it would make a bare "did the socket connect" probe look
 * identical to a real answering server. Running the fake server in its own
 * process is what lets these tests tell the two probe designs apart (see the
 * "answers on the socket but never speaks HTTP" case below, which is the one
 * that actually distinguishes them).
 */
function spawnChildServer(script: string): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffered = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('fake server child process did not report a port in time'));
    }, 5000);

    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString();
      const match = buffered.match(/PORT (\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      resolve({
        port: Number(match[1]),
        close: () =>
          new Promise<void>(res => {
            child.once('exit', () => res());
            child.kill();
          }),
      });
    };
    child.stdout.on('data', onData);

    child.on('error', err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * A throwaway HTTP server, in its own process, that answers any request –
 * including `/json/version` – with a CDP-shaped JSON body. The positive
 * double for "the CDP port answers".
 */
function startCdpServer(): Promise<FakeServer> {
  return spawnChildServer(`
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        Browser: 'fake/1.0',
        webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/fake',
      }));
    });
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write('PORT ' + server.address().port + '\\n');
    });
  `);
}

/**
 * A throwaway TCP server, in its own process, that accepts connections and
 * then never writes a single byte back and never closes the socket. This is
 * the double that a bare "did the socket connect" probe cannot distinguish
 * from a real answering server, but a probe that actually waits on an HTTP
 * response must fail against (and must not hang doing so).
 */
function startSilentTcpServer(): Promise<FakeServer> {
  return spawnChildServer(`
    const net = require('node:net');
    const server = net.createServer(() => {
      // Accept the connection; deliberately write nothing, ever.
    });
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write('PORT ' + server.address().port + '\\n');
    });
  `);
}

/** A port nothing is listening on (bound then immediately released) for the negative CDP case. */
async function closedPort(): Promise<number> {
  const { port, close } = await startCdpServer();
  await close();
  return port;
}

/** The line of `output` that mentions `needle`, or undefined. Helper for text-mode assertions. */
function lineContaining(output: string, needle: string): string | undefined {
  return output.split('\n').find(line => line.includes(needle));
}

/**
 * Declare both orchestrator booleans in one call.
 *
 * Every check other than check 2 still needs check 1 satisfied before its own
 * outcome can be read off the exit code, and check 1 wants both booleans
 * answered. `false, false` is the "no orchestrator on this host" setup that
 * the retired `host.orchestrator none` used to express.
 */
function declareOrchestrators(herdr: boolean, orca: boolean): void {
  expect(runCli(['config', 'set', 'host.orchestrators.herdr', String(herdr)]).status).toBe(0);
  expect(runCli(['config', 'set', 'host.orchestrators.orca', String(orca)]).status).toBe(0);
}

/**
 * The body of numbered check `n` in `config check` output, heading included.
 *
 * The checks are printed as `N. Title` followed by indented outcome lines, so
 * a section runs from its own heading to the next numbered one. Slicing this
 * way lets a test say "check 2 failed" rather than only "something failed".
 */
function checkSection(output: string, n: number): string {
  const lines = output.split('\n');
  const start = lines.findIndex(line => line.startsWith(`${n}. `));
  if (start === -1) return '';
  const end = lines.findIndex((line, i) => i > start && /^\d+\. /.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

/** The FAIL outcome lines within `output`. */
function failLines(output: string): string[] {
  return output.split('\n').filter(line => line.includes('FAIL'));
}

/**
 * The body of `spechub config show`'s `Project` section, heading excluded,
 * running up to (but not including) the `Host` heading. Empty string when no
 * `Project` heading is found at all. Headings are matched as a whole trimmed
 * line, the same way `console.log(chalk.bold('Host'))` prints when stdout is
 * not a TTY (which is always true under `spawnSync`, so chalk emits no ANSI
 * codes here).
 */
function projectSection(output: string): string {
  const lines = output.split('\n');
  const start = lines.findIndex(line => line.trim() === 'Project');
  if (start === -1) return '';
  const end = lines.findIndex((line, i) => i > start && line.trim() === 'Host');
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n');
}

describe('spechub config set host.*', () => {
  it('sets host.orchestrators.herdr with exit 0 and writes the nested boolean to disk', () => {
    const result = runCli(['config', 'set', 'host.orchestrators.herdr', 'true']);

    expect(result.status).toBe(0);

    const raw = JSON.parse(readFileSync(configFilePath(), 'utf-8')) as StoredConfig;
    expect(raw).toEqual({ host: { orchestrators: { herdr: true } } });
  });

  it('sets host.orchestrators.orca independently, without disturbing herdr', () => {
    expect(runCli(['config', 'set', 'host.orchestrators.herdr', 'true']).status).toBe(0);

    const result = runCli(['config', 'set', 'host.orchestrators.orca', 'false']);

    expect(result.status).toBe(0);

    const raw = JSON.parse(readFileSync(configFilePath(), 'utf-8')) as StoredConfig;
    expect(raw).toEqual({ host: { orchestrators: { herdr: true, orca: false } } });
  });

  it.each(['host.orchestrators.herdr', 'host.orchestrators.orca'])(
    'accepts the same boolean spellings for %s as host.browser.* does',
    key => {
      for (const raw of ['true', 'yes', 'ON']) {
        expect(runCli(['config', 'set', key, raw]).status).toBe(0);
        expect(runCli(['config', 'get', key]).stdout.trim()).toBe('true');
      }
      for (const raw of ['false', 'no', 'OFF']) {
        expect(runCli(['config', 'set', key, raw]).status).toBe(0);
        expect(runCli(['config', 'get', key]).stdout.trim()).toBe('false');
      }
    }
  );

  it.each(['host.orchestrators.herdr', 'host.orchestrators.orca'])(
    'rejects a non-boolean value for %s with exit 1, naming the boolean form',
    key => {
      const result = runCli(['config', 'set', key, 'herdr']);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('boolean');
      expect(result.stderr).toContain('true');
      expect(result.stderr).toContain('false');
    }
  );

  it('rejects the retired host.orchestrator key with exit 1, like any unknown host key', () => {
    const result = runCli(['config', 'set', 'host.orchestrator', 'orca']);

    expect(result.status).toBe(1);
    // Quoted, because the bare key is a prefix of the two that replaced it and
    // so appears in the allowed-keys list of every unknown-key message.
    expect(result.stderr).toContain('Unknown config key "host.orchestrator"');
    expect(result.stderr).toContain('host.orchestrators.herdr');
    expect(result.stderr).toContain('host.orchestrators.orca');
  });

  it('rejects an unknown host.* key with exit 1 and lists allowed host keys', () => {
    const result = runCli(['config', 'set', 'host.bogus', 'x']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('host.orchestrators.herdr');
    expect(result.stderr).toContain('host.orchestrators.orca');
    expect(result.stderr).toContain('host.browser.remote');
  });

  it('stores boolean axes as JSON booleans, accepting yes/no as well as true/false', () => {
    const result = runCli(['config', 'set', 'host.browser.remote', 'yes']);
    expect(result.status).toBe(0);

    const raw = JSON.parse(readFileSync(configFilePath(), 'utf-8')) as StoredConfig;
    expect(raw.host.browser.remote).toBe(true);
  });

  it('sets host.orca.topology to local with exit 0 and writes the nested value to disk', () => {
    const result = runCli(['config', 'set', 'host.orca.topology', 'local']);

    expect(result.status).toBe(0);

    const raw = JSON.parse(readFileSync(configFilePath(), 'utf-8')) as StoredConfig;
    expect(raw).toEqual({ host: { orca: { topology: 'local' } } });
  });

  it('sets host.orca.topology to remote with exit 0 and writes the nested value to disk', () => {
    const result = runCli(['config', 'set', 'host.orca.topology', 'remote']);

    expect(result.status).toBe(0);

    const raw = JSON.parse(readFileSync(configFilePath(), 'utf-8')) as StoredConfig;
    expect(raw).toEqual({ host: { orca: { topology: 'remote' } } });
  });

  it('rejects an unknown value for host.orca.topology with exit 1 and names the allowed values', () => {
    const result = runCli(['config', 'set', 'host.orca.topology', 'bogus']);

    expect(result.status).toBe(1);
    // "local" and "remote" also appear inside the unrelated "unknown key"
    // message (as substrings of host.browser.local/host.browser.remote), so
    // check for them named together as the allowed-values list rather than
    // as loose substrings, to avoid a false pass off the wrong error.
    expect(result.stderr).toContain('local, remote');
  });

  it('rejects an unknown key under host.orca with exit 1 and lists allowed host keys including host.orca.topology', () => {
    const result = runCli(['config', 'set', 'host.orca.bogus', 'x']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('host.orchestrators.orca');
    expect(result.stderr).toContain('host.orca.topology');
  });

  it('rejects an unknown key under host.orchestrators with exit 1', () => {
    const result = runCli(['config', 'set', 'host.orchestrators.tmux', 'true']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('host.orchestrators.herdr');
    expect(result.stderr).toContain('host.orchestrators.orca');
  });
});

describe('spechub config set host.orca.topology warns unless orca is declared', () => {
  it('sets successfully and warns that it has no effect when host.orchestrators.orca is unset', () => {
    const result = runCli(['config', 'set', 'host.orca.topology', 'local']);

    expect(result.status).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('no effect');
    expect(combined).toContain('host.orchestrators.orca');

    const raw = JSON.parse(readFileSync(configFilePath(), 'utf-8')) as StoredConfig;
    expect(raw).toEqual({ host: { orca: { topology: 'local' } } });
  });

  it('sets successfully and warns that it has no effect when host.orchestrators.orca is false', () => {
    declareOrchestrators(true, false);

    const result = runCli(['config', 'set', 'host.orca.topology', 'remote']);

    expect(result.status).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('no effect');
    expect(combined).toContain('host.orchestrators.orca');

    const raw = JSON.parse(readFileSync(configFilePath(), 'utf-8')) as StoredConfig;
    expect(raw.host.orca.topology).toBe('remote');
  });

  it('sets successfully with no "no effect" warning when host.orchestrators.orca is true', () => {
    declareOrchestrators(false, true);

    const result = runCli(['config', 'set', 'host.orca.topology', 'local']);

    expect(result.status).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain('no effect');
  });

  it('warns even when herdr is declared true, since only orca makes topology mean anything', () => {
    declareOrchestrators(true, false);

    const result = runCli(['config', 'set', 'host.orca.topology', 'local']);

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toContain('no effect');
  });
});

describe('spechub config get host', () => {
  it('returns the whole host section as JSON', () => {
    expect(runCli(['config', 'set', 'host.orchestrators.orca', 'true']).status).toBe(0);
    expect(runCli(['config', 'set', 'host.browser.remote', 'true']).status).toBe(0);

    const result = runCli(['config', 'get', 'host']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      orchestrators: { orca: true },
      browser: { remote: true },
    });
  });

  it('includes host.orca.topology in the host section when set', () => {
    expect(runCli(['config', 'set', 'host.orchestrators.orca', 'true']).status).toBe(0);
    expect(runCli(['config', 'set', 'host.orca.topology', 'remote']).status).toBe(0);

    const result = runCli(['config', 'get', 'host']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      orchestrators: { orca: true },
      orca: { topology: 'remote' },
    });
  });
});

describe('spechub config unset host.*', () => {
  it('removes a set axis with exit 0, prints Removed <key>, and the key is gone on disk', () => {
    declareOrchestrators(true, true);

    const result = runCli(['config', 'unset', 'host.orchestrators.orca']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Removed host.orchestrators.orca');

    const raw = JSON.parse(readFileSync(configFilePath(), 'utf-8')) as StoredConfig;
    expect(raw.host?.orchestrators?.orca).toBeUndefined();
    expect(raw.host?.orchestrators?.herdr).toBe(true);
  });

  it('rejects unsetting the retired host.orchestrator key with exit 1', () => {
    const result = runCli(['config', 'unset', 'host.orchestrator']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown config key "host.orchestrator"');
  });

  it('reports "was not set" with exit 0 and does not rewrite the file for a never-set axis', () => {
    expect(runCli(['config', 'set', 'host.orchestrators.orca', 'true']).status).toBe(0);
    const before = statSync(configFilePath());
    const beforeBytes = readFileSync(configFilePath());

    const result = runCli(['config', 'unset', 'host.element_picker']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('was not set');

    const after = statSync(configFilePath());
    const afterBytes = readFileSync(configFilePath());
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('rejects an unknown host.* key with exit 1 and lists allowed host keys', () => {
    const result = runCli(['config', 'unset', 'host.bogus']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('host.orchestrators.herdr');
    expect(result.stderr).toContain('host.orchestrators.orca');
    expect(result.stderr).toContain('host.browser.remote');
  });

  it('removes host.orca.topology with exit 0, prints Removed <key>, and the key is gone on disk', () => {
    expect(runCli(['config', 'set', 'host.orca.topology', 'local']).status).toBe(0);

    const result = runCli(['config', 'unset', 'host.orca.topology']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Removed host.orca.topology');

    const raw = JSON.parse(readFileSync(configFilePath(), 'utf-8')) as StoredConfig;
    expect(raw.host?.orca?.topology).toBeUndefined();
  });

  it('reports "was not set" with exit 0 and does not rewrite the file when host.orca.topology was never set', () => {
    expect(runCli(['config', 'set', 'host.orchestrators.orca', 'true']).status).toBe(0);
    const before = statSync(configFilePath());
    const beforeBytes = readFileSync(configFilePath());

    const result = runCli(['config', 'unset', 'host.orca.topology']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('was not set');

    const after = statSync(configFilePath());
    const afterBytes = readFileSync(configFilePath());
    expect(afterBytes.equals(beforeBytes)).toBe(true);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});

describe('spechub config get host.<axis>', () => {
  it.each(['host.orchestrators.herdr', 'host.orchestrators.orca'])(
    'exits 2 and reports unset + required for the unset required axis %s',
    key => {
      const result = runCli(['config', 'get', key]);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('unset');
      expect(result.stderr).toContain('required');
    }
  );

  it('rejects getting the retired host.orchestrator key with exit 1, not exit 2', () => {
    const result = runCli(['config', 'get', 'host.orchestrator']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown config key "host.orchestrator"');
  });

  it('exits 2 and reports unset + optional for an unset optional axis', () => {
    const result = runCli(['config', 'get', 'host.preview.tailscale_serve']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unset');
    expect(result.stderr).toContain('optional');
  });

  it('prints the stored value after the axis has been set', () => {
    expect(runCli(['config', 'set', 'host.browser.remote', 'yes']).status).toBe(0);

    const result = runCli(['config', 'get', 'host.browser.remote']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('true');
  });

  it('exits 2 and reports unset + optional for host.orca.topology when unset', () => {
    const result = runCli(['config', 'get', 'host.orca.topology']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unset');
    expect(result.stderr).toContain('optional');
  });

  it('prints the stored value for host.orca.topology after it has been set', () => {
    expect(runCli(['config', 'set', 'host.orca.topology', 'local']).status).toBe(0);

    const result = runCli(['config', 'get', 'host.orca.topology']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('local');
  });
});

// -----------------------------------------------------------------------
// spechub config show
//
// Contract assumed for `--json`: an object
//   { hasProject: boolean, hasFrontend: boolean, axes: HostAxisStatus[], project: Project | null }
// where each entry in `axes` is
//   { key: string, required: boolean, status: 'declared'|'detected'|'unset', value?: unknown }
// `value` is present when status is 'declared' or 'detected', and absent (or
// null) when status is 'unset'. Declared and detected are always distinct
// status values – detection never counts as a declaration.
//
// `project` is null when no project root is found. Otherwise it is
//   { profile: string|null, commands: Record<string,string>, browser: Browser|null }
// where `commands` holds only the `commands.*` entries that are set (a
// `null` or empty-string entry in project.yaml is absent, not present as
// null), and `browser` is null when the project has no `frontend`, otherwise
//   { mode: string|null, cdpPort: number|null, fallback: string|null }
// – what the project SAYS, not any effective default a probe would use.
//
// In text mode, `show` prints a `Project` section before the `Host` section,
// reporting the same facts.
// -----------------------------------------------------------------------

describe('spechub config show', () => {
  it('exits 0 and lists all eight host axes when nothing at all is configured', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
    for (const key of [
      'host.orchestrators.herdr',
      'host.orchestrators.orca',
      'host.browser.remote',
      'host.browser.headless',
      'host.browser.local',
      'host.preview.tailscale_serve',
      'host.element_picker',
      'host.orca.topology',
    ]) {
      expect(result.stdout).toContain(key);
    }
  });

  it('does not crash and exits 0 with no project directory anywhere above cwd', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show'], { cwd, path: [emptyPathDir()] });
    expect(result.status).toBe(0);
  });

  it('--json reports required: true for both orchestrator booleans but false for the browser axes with no project', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const byKey = Object.fromEntries(json.axes.map((a): [string, ConfigShowAxis] => [a.key, a]));

    expect(byKey['host.orchestrator']).toBeUndefined();
    expect(byKey['host.orchestrators.herdr'].required).toBe(true);
    expect(byKey['host.orchestrators.orca'].required).toBe(true);
    expect(byKey['host.browser.remote'].required).toBe(false);
    expect(byKey['host.browser.headless'].required).toBe(false);
    expect(byKey['host.browser.local'].required).toBe(false);
  });

  it('--json reports required: false for the browser axes when the project has no frontend configured', () => {
    const cwd = makeProject('name: no-frontend-project\n');
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const byKey = Object.fromEntries(json.axes.map((a): [string, ConfigShowAxis] => [a.key, a]));

    expect(byKey['host.orchestrators.herdr'].required).toBe(true);
    expect(byKey['host.orchestrators.orca'].required).toBe(true);
    expect(byKey['host.browser.remote'].required).toBe(false);
    expect(byKey['host.browser.headless'].required).toBe(false);
    expect(byKey['host.browser.local'].required).toBe(false);
  });

  it('--json reports required: true for all three browser axes when the project has a frontend configured', () => {
    const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const byKey = Object.fromEntries(json.axes.map((a): [string, ConfigShowAxis] => [a.key, a]));

    expect(byKey['host.orchestrators.herdr'].required).toBe(true);
    expect(byKey['host.orchestrators.orca'].required).toBe(true);
    expect(byKey['host.browser.remote'].required).toBe(true);
    expect(byKey['host.browser.headless'].required).toBe(true);
    expect(byKey['host.browser.local'].required).toBe(true);
  });

  it('--json marks a value set via `config set` as status "declared" with its stored value', () => {
    expect(runCli(['config', 'set', 'host.orchestrators.herdr', 'true']).status).toBe(0);

    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const herdr = json.axes.find(a => a.key === 'host.orchestrators.herdr')!;
    expect(herdr.status).toBe('declared');
    expect(herdr.value).toBe(true);
  });

  it('--json marks an orchestrator declared false as "declared", not "unset"', () => {
    expect(runCli(['config', 'set', 'host.orchestrators.orca', 'false']).status).toBe(0);

    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const orca = json.axes.find(a => a.key === 'host.orchestrators.orca')!;
    expect(orca.status).toBe('declared');
    expect(orca.value).toBe(false);
  });

  it('text mode marks both orchestrator booleans as required, and a declared one as declared', () => {
    expect(runCli(['config', 'set', 'host.orchestrators.herdr', 'true']).status).toBe(0);

    const cwd = noProjectDir();
    const result = runCli(['config', 'show'], { cwd, path: [emptyPathDir()] });

    const herdrLine = lineContaining(result.stdout, 'host.orchestrators.herdr');
    expect(herdrLine).toBeDefined();
    expect(herdrLine).toContain('declared');
    expect(herdrLine).toContain('required');

    const orcaLine = lineContaining(result.stdout, 'host.orchestrators.orca');
    expect(orcaLine).toBeDefined();
    expect(orcaLine).toContain('required');
  });

  it('--json marks an axis with no config value and nothing detectable as status "unset" with no value', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const picker = json.axes.find((a: { key: string }) => a.key === 'host.element_picker')!;
    expect(picker.status).toBe('unset');
    expect(picker.value ?? null).toBeNull();
  });

  it('--json detects herdr alone when only the herdr binary is on PATH', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], {
      cwd,
      path: [fakeBinDir('herdr', 0)],
    });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const byKey = Object.fromEntries(json.axes.map((a): [string, ConfigShowAxis] => [a.key, a]));
    expect(byKey['host.orchestrators.herdr'].status).toBe('detected');
    expect(byKey['host.orchestrators.herdr'].value).toBe(true);
    // Detection is per-orchestrator: finding one says nothing about the other.
    expect(byKey['host.orchestrators.orca'].status).toBe('unset');
  });

  it('--json detects orca alone when only the orca-ide binary is on PATH', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], {
      cwd,
      path: [fakeBinDir('orca-ide', 0)],
    });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const byKey = Object.fromEntries(json.axes.map((a): [string, ConfigShowAxis] => [a.key, a]));
    expect(byKey['host.orchestrators.orca'].status).toBe('detected');
    expect(byKey['host.orchestrators.orca'].value).toBe(true);
    expect(byKey['host.orchestrators.herdr'].status).toBe('unset');
  });

  it('--json detects orca via the fallback `orca` binary when orca-ide is not on PATH', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], {
      cwd,
      path: [fakeBinDir('orca', 0)],
    });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const byKey = Object.fromEntries(json.axes.map((a): [string, ConfigShowAxis] => [a.key, a]));
    expect(byKey['host.orchestrators.orca'].status).toBe('detected');
    expect(byKey['host.orchestrators.orca'].value).toBe(true);
  });

  it('--json detects both when both binaries are on PATH', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], {
      cwd,
      path: [fakeBinDir('herdr', 0), fakeBinDir('orca-ide', 0)],
    });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const byKey = Object.fromEntries(json.axes.map((a): [string, ConfigShowAxis] => [a.key, a]));
    expect(byKey['host.orchestrators.herdr'].status).toBe('detected');
    expect(byKey['host.orchestrators.orca'].status).toBe('detected');
  });

  it('--json prefers a declaration over detection, even one that contradicts PATH', () => {
    expect(runCli(['config', 'set', 'host.orchestrators.herdr', 'false']).status).toBe(0);

    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], { cwd, path: [fakeBinDir('herdr', 0)] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const herdr = json.axes.find(a => a.key === 'host.orchestrators.herdr')!;
    expect(herdr.status).toBe('declared');
    expect(herdr.value).toBe(false);
  });

  it('--json reports neither orchestrator as detected when no orchestrator binary is on PATH', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const byKey = Object.fromEntries(json.axes.map((a): [string, ConfigShowAxis] => [a.key, a]));
    expect(byKey['host.orchestrators.herdr'].status).toBe('unset');
    expect(byKey['host.orchestrators.orca'].status).toBe('unset');
  });

  it('--json marks host.browser.headless and host.browser.local as "detected" true when a chromium binary is on PATH', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], {
      cwd,
      path: [fakeBinDir('chromium', 0)],
    });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const byKey = Object.fromEntries(json.axes.map((a): [string, ConfigShowAxis] => [a.key, a]));
    expect(byKey['host.browser.headless'].status).toBe('detected');
    expect(byKey['host.browser.headless'].value).toBe(true);
    expect(byKey['host.browser.local'].status).toBe('detected');
    expect(byKey['host.browser.local'].value).toBe(true);
  });

  it('--json marks host.browser.remote as "detected" true when the project cdp_port answers', async () => {
    const { port, close } = await startCdpServer();
    try {
      const cwd = makeProject(
        `frontend:\n  browser:\n    mode: remote\n    cdp_port: ${port}\n`
      );
      const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

      const json = JSON.parse(result.stdout) as ConfigShowJson;
      const remote = json.axes.find((a: { key: string }) => a.key === 'host.browser.remote')!;
      expect(remote.status).toBe('detected');
      expect(remote.value).toBe(true);
    } finally {
      await close();
    }
  });

  it('--json does not mark host.browser.remote as detected when the project cdp_port is closed', async () => {
    const port = await closedPort();
    const cwd = makeProject(`frontend:\n  browser:\n    mode: remote\n    cdp_port: ${port}\n`);
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const remote = json.axes.find((a: { key: string }) => a.key === 'host.browser.remote')!;
    expect(remote.status).toBe('unset');
  });

  it('--json prints valid, parseable JSON in one call (no interleaved prose)', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout) as ConfigShowJson).not.toThrow();
  });
});

// -----------------------------------------------------------------------
// spechub config show — Project section (text mode)
//
// `show` reports the project before the host: a `Project` heading, then the
// facts read from spechub/project.yaml, then the existing `Host` heading and
// its table. The old dim one-line project summary that used to trail the
// Host table is gone - those facts now live only in the Project section.
// -----------------------------------------------------------------------

describe('spechub config show — Project section', () => {
  it('prints the Project heading before the Host heading', () => {
    const cwd = makeProject('profile: node-typescript\n');
    const result = runCli(['config', 'show'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
    const projectIndex = result.stdout.indexOf('Project');
    const hostIndex = result.stdout.indexOf('Host');
    expect(projectIndex).toBeGreaterThanOrEqual(0);
    expect(hostIndex).toBeGreaterThan(projectIndex);
  });

  it('says there is no SpecHub project here as the first thing printed, with no project root, and still prints the full Host section at exit 0', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
    const firstLine = result.stdout.split('\n').find(line => line.trim() !== '');
    expect(firstLine).toBeDefined();
    expect(firstLine).toMatch(/no SpecHub project/i);

    for (const key of [
      'host.orchestrators.herdr',
      'host.orchestrators.orca',
      'host.browser.remote',
      'host.browser.headless',
      'host.browser.local',
      'host.preview.tailscale_serve',
      'host.element_picker',
      'host.orca.topology',
    ]) {
      expect(result.stdout).toContain(key);
    }
  });

  it('shows profile and every set commands.* entry, by name and value, and omits null-valued commands entirely', () => {
    const cwd = makeProject(
      'profile: node-typescript\n' +
        'commands:\n' +
        '  test: "check-suite-cmd"\n' +
        '  test_collect: null\n' +
        '  build: "assemble-artifact-cmd"\n' +
        '  lint: "polish-code-cmd"\n' +
        '  typecheck: "verify-types-cmd"\n' +
        '  format: null\n'
    );
    const result = runCli(['config', 'show'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
    const section = projectSection(result.stdout);
    expect(section).toContain('node-typescript');

    const testLine = lineContaining(section, 'check-suite-cmd');
    expect(testLine).toBeDefined();
    expect(testLine).toContain('test');

    const buildLine = lineContaining(section, 'assemble-artifact-cmd');
    expect(buildLine).toBeDefined();
    expect(buildLine).toContain('build');

    const lintLine = lineContaining(section, 'polish-code-cmd');
    expect(lintLine).toBeDefined();
    expect(lintLine).toContain('lint');

    const typecheckLine = lineContaining(section, 'verify-types-cmd');
    expect(typecheckLine).toBeDefined();
    expect(typecheckLine).toContain('typecheck');

    // A `null`-valued command is not set, so it must not appear at all - not
    // even as a name with no value.
    expect(section).not.toContain('test_collect');
    expect(section).not.toContain('format');
  });

  it('shows frontend.browser.mode, cdp_port and fallback in the Project section when present', () => {
    const cwd = makeProject(
      'frontend:\n' + '  browser:\n' + '    mode: local\n' + '    cdp_port: 24680\n' + '    fallback: none\n'
    );
    const result = runCli(['config', 'show'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
    const section = projectSection(result.stdout);
    expect(section).toContain('local');
    expect(section).toContain('24680');
    expect(section).toContain('none');
  });

  it('shows profile and commands but says the project has no frontend configured when frontend is absent', () => {
    const cwd = makeProject(
      'profile: node-typescript\n' + 'commands:\n' + '  test: "check-suite-cmd"\n'
    );
    const result = runCli(['config', 'show'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
    const section = projectSection(result.stdout);
    expect(section).toContain('node-typescript');
    expect(section).toContain('check-suite-cmd');
    expect(section).toMatch(/no frontend configured/i);
  });

  it('does not repeat the project browser mode or cdp_port anywhere after the Host table (no trailing duplicate summary)', () => {
    const cwd = makeProject(
      'frontend:\n' + '  browser:\n' + '    mode: cloud-relay-xyz\n' + '    cdp_port: 24681\n'
    );
    const result = runCli(['config', 'show'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
    // Both values must appear exactly once in the whole of stdout - inside
    // the Project section, and nowhere else. The old behaviour printed a
    // second, dim one-line summary AFTER the Host table repeating these same
    // facts; if that line came back, either count below would rise to 2.
    // The mode string is made up (not one of remote/headless/local)
    // precisely so it cannot also turn up as a substring of a
    // host.browser.* axis key in the table below.
    const modeCount = (result.stdout.match(/cloud-relay-xyz/g) ?? []).length;
    const portCount = (result.stdout.match(/24681/g) ?? []).length;
    expect(modeCount).toBe(1);
    expect(portCount).toBe(1);
  });

  it('omits a commands.* entry whose value is an empty string or only whitespace, same as null', () => {
    const cwd = makeProject(
      'commands:\n' + '  test: ""\n' + '  lint: "   "\n' + '  build: "assemble-artifact-cmd"\n'
    );
    const result = runCli(['config', 'show'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
    const section = projectSection(result.stdout);
    const buildLine = lineContaining(section, 'assemble-artifact-cmd');
    expect(buildLine).toBeDefined();
    expect(buildLine).toContain('build');

    // An empty string and a whitespace-only string are not "set", exactly
    // like a null value - the entry must not appear at all, not even as a
    // name with no value.
    expect(section).not.toContain('commands.test');
    expect(section).not.toContain('commands.lint');
  });
});

// -----------------------------------------------------------------------
// spechub config show --json — the `project` object
// -----------------------------------------------------------------------

describe('spechub config show --json — project object', () => {
  it('project is null when no project root is found', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    expect(json.project).toBeNull();
  });

  it('project.profile is the stated string when the project sets one', () => {
    const cwd = makeProject('profile: node-typescript\n');
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    expect(json.project?.profile).toBe('node-typescript');
  });

  it('project.profile is null when the project sets no profile', () => {
    const cwd = makeProject('commands:\n  test: "check-suite-cmd"\n');
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    expect(json.project?.profile).toBeNull();
  });

  it('project.commands holds only the entries that are set, dropping null-valued entries entirely', () => {
    const cwd = makeProject(
      'commands:\n' +
        '  test: "check-suite-cmd"\n' +
        '  test_collect: null\n' +
        '  build: "assemble-artifact-cmd"\n' +
        '  format: null\n'
    );
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    expect(json.project?.commands.test).toBe('check-suite-cmd');
    expect(json.project?.commands.build).toBe('assemble-artifact-cmd');
    expect(json.project?.commands).not.toHaveProperty('test_collect');
    expect(json.project?.commands).not.toHaveProperty('format');
  });

  it('project.commands is an empty object when the project sets no commands at all', () => {
    const cwd = makeProject('profile: node-typescript\n');
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    expect(json.project?.commands).toEqual({});
  });

  it('project.browser is null when the project has no frontend configured', () => {
    const cwd = makeProject('profile: node-typescript\n');
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    expect(json.project?.browser).toBeNull();
  });

  it('project.browser reports mode, cdpPort and fallback exactly as stated', () => {
    const cwd = makeProject(
      'frontend:\n' +
        '  browser:\n' +
        '    mode: remote\n' +
        '    cdp_port: 24680\n' +
        '    fallback: headless\n'
    );
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    expect(json.project?.browser).toEqual({ mode: 'remote', cdpPort: 24680, fallback: 'headless' });
  });

  it('project.browser.cdpPort is null (not a default port) when the project has a frontend but states no cdp_port', () => {
    const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    // This is the project's own statement, not the effective default a probe
    // would fall back to (19988 for remote) - those are different questions.
    expect(json.project?.browser?.cdpPort).toBeNull();
  });

  it('project.browser has mode, cdpPort and fallback all null when the project has a frontend but no browser subsection at all', () => {
    const cwd = makeProject('frontend:\n  something: true\n');
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    expect(json.project?.browser).toEqual({ mode: null, cdpPort: null, fallback: null });
  });

  it('project.commands drops an entry whose value is an empty string or only whitespace, same as null', () => {
    const cwd = makeProject(
      'commands:\n' + '  test: ""\n' + '  lint: "   "\n' + '  build: "assemble-artifact-cmd"\n'
    );
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    expect(json.project?.commands.build).toBe('assemble-artifact-cmd');
    expect(json.project?.commands).not.toHaveProperty('test');
    expect(json.project?.commands).not.toHaveProperty('lint');
  });
});

// -----------------------------------------------------------------------
// spechub config check
// -----------------------------------------------------------------------

describe('spechub config check', () => {
  it('exits 2 when both orchestrator booleans are unset', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(2);
  });

  it.each([
    ['host.orchestrators.herdr', 'host.orchestrators.orca'],
    ['host.orchestrators.orca', 'host.orchestrators.herdr'],
  ])('exits 2 when %s is declared but %s is still unset', (declaredKey, missingKey) => {
    // The two booleans are independently required: answering one is not an
    // answer for the other, because a host can run both or neither.
    expect(runCli(['config', 'set', declaredKey, 'true']).status).toBe(0);

    const cwd = noProjectDir();
    const result = runCli(['config', 'check'], { cwd, path: [fakeBinDir('herdr', 0), fakeBinDir('orca-ide', 0)] });

    expect(result.status).toBe(2);
    expect(failLines(checkSection(result.stdout, 1)).join('\n')).toContain(missingKey);
  });

  it('exits 0 with no project when both orchestrators are declared false and browser axes are unset', () => {
    declareOrchestrators(false, false);

    const cwd = noProjectDir();
    const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
  });

  it('passes check 1 and says plain git worktrees will be used when both orchestrators are false', () => {
    declareOrchestrators(false, false);

    const cwd = noProjectDir();
    const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
    const section = checkSection(result.stdout, 1);
    expect(failLines(section)).toEqual([]);
    expect(section).toMatch(/plain git worktrees/i);
  });

  it('exits 0 in a project without a frontend even though the browser axes are unset', () => {
    declareOrchestrators(false, false);

    const cwd = makeProject('name: no-frontend-project\n');
    const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
  });

  it('exits 2 in a project with a frontend when the browser axes are unset', () => {
    declareOrchestrators(false, false);

    const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
    const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(2);
  });

  it('exits 2 in a project with a frontend when only host.browser.remote is declared and headless/local are still unset', () => {
    // The three browser axes are each independently required – declaring one
    // of them does not satisfy the requirement for the other two. Pins the
    // strict per-axis reading (as opposed to treating the three as one
    // group question that any single declaration answers).
    declareOrchestrators(false, false);
    expect(runCli(['config', 'set', 'host.browser.remote', 'true']).status).toBe(0);

    const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
    const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(2);
  });

  it('exits 0 once required axes are all set, isolated from the preferred-mode check (check 1 alone)', () => {
    declareOrchestrators(false, false);
    expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
    expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
    expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

    // A project preferring a browser mode requires *some* declared-true mode
    // (covered separately under check 4 below); a project with no frontend
    // has no such preference, so this isolates check 1 (required axes set).
    const cwd = makeProject('name: no-frontend-project\n');
    const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
  });

  it('exits 2 when the required-unset failure and another check failure both apply (unset takes precedence)', () => {
    declareOrchestrators(true, false);
    // host.browser.* left unset (required, since the project has a frontend)
    // while herdr is declared true but its binary is not on PATH at all
    // (which would independently fail check 2).
    const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
    const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(2);
  });

  describe('declared orchestrators respond (check 2)', () => {
    it('heads the check with "Declared orchestrators respond", not a single-orchestrator heading', () => {
      declareOrchestrators(false, false);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(checkSection(result.stdout, 2)).toContain('Declared orchestrators respond');
    });

    it('exits 0 when herdr is declared true and the herdr binary answers `herdr api` successfully', () => {
      declareOrchestrators(true, false);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [fakeBinDir('herdr', 0)] });

      expect(result.status).toBe(0);
    });

    it('exits 1 when herdr is declared true but no herdr binary is on PATH', () => {
      declareOrchestrators(true, false);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
      expect(failLines(checkSection(result.stdout, 2)).join('\n')).toContain('herdr');
    });

    it('exits 1 when herdr is declared true and the binary is present but its server does not answer', () => {
      declareOrchestrators(true, false);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [fakeBinDir('herdr', 1)] });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
    });

    it('exits 0 when orca is declared true and orca-ide answers `orca-ide status --json` successfully', () => {
      declareOrchestrators(false, true);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDirWithOutput('orca-ide', 0, ORCA_READY_JSON)],
      });

      expect(result.status).toBe(0);
    });

    it('exits 1 when orca is declared true but no orca-ide binary is on PATH', () => {
      declareOrchestrators(false, true);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
      expect(failLines(checkSection(result.stdout, 2)).join('\n')).toContain('orca');
    });

    it('exits 1 when orca is declared true and orca-ide is present but its server does not answer', () => {
      declareOrchestrators(false, true);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [fakeBinDir('orca-ide', 1)] });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
    });

    it('probes every declared orchestrator, giving each its own line, when both are true', () => {
      declareOrchestrators(true, true);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDir('herdr', 0), fakeBinDirWithOutput('orca-ide', 0, ORCA_READY_JSON)],
      });

      expect(result.status).toBe(0);
      const outcomes = checkSection(result.stdout, 2)
        .split('\n')
        .filter(line => line.includes('PASS'));
      expect(outcomes.filter(line => line.includes('herdr'))).toHaveLength(1);
      expect(outcomes.filter(line => line.includes('orca'))).toHaveLength(1);
    });

    it('fails and names the failing orchestrator when one of two declared true does not answer', () => {
      declareOrchestrators(true, true);

      // herdr answers; orca-ide is not installed at all.
      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [fakeBinDir('herdr', 0)] });

      expect(result.status).toBe(1);
      const fails = failLines(checkSection(result.stdout, 2));
      expect(fails).toHaveLength(1);
      expect(fails[0]).toContain('orca');
      expect(fails[0]).not.toContain('herdr');
    });

    it('fails and names herdr when it is the one of two declared true that does not answer', () => {
      declareOrchestrators(true, true);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDirWithOutput('orca-ide', 0, ORCA_READY_JSON)],
      });

      expect(result.status).toBe(1);
      const fails = failLines(checkSection(result.stdout, 2));
      expect(fails).toHaveLength(1);
      expect(fails[0]).toContain('herdr');
    });

    it('passes with nothing to probe when both orchestrators are declared false', () => {
      declareOrchestrators(false, false);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
      const section = checkSection(result.stdout, 2);
      expect(failLines(section)).toEqual([]);
      expect(section).toMatch(/nothing to probe/i);
    });

    it('does not probe an orchestrator declared false even when its binary is on PATH and broken', () => {
      declareOrchestrators(true, false);

      // A broken orca-ide is on PATH, but orca is declared false, so looking
      // for it would only nag about a tool the user said they do not use.
      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDir('herdr', 0), fakeBinDir('orca-ide', 1)],
      });

      expect(result.status).toBe(0);
      expect(failLines(checkSection(result.stdout, 2))).toEqual([]);
    });
  });

  describe("orca's probe reads the JSON, not just the exit status (check 2)", () => {
    it('exits 0 when orca-ide exits 0 and prints reachable:true, state:"ready"', () => {
      declareOrchestrators(false, true);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDirWithOutput('orca-ide', 0, ORCA_READY_JSON)],
      });

      expect(result.status).toBe(0);
    });

    it('exits 1 when orca-ide reports reachable:false, whatever the state', () => {
      declareOrchestrators(false, true);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDirWithOutput('orca-ide', 0, orcaStatusJson(false, 'ready'))],
      });

      expect(result.status).toBe(1);
      expect(failLines(checkSection(result.stdout, 2)).join('\n')).toContain('orca');
    });

    it.each(['starting', 'stopped'])(
      'exits 1 when orca-ide reports reachable:true but state is "%s", not "ready"',
      state => {
        declareOrchestrators(false, true);

        const cwd = noProjectDir();
        const result = runCli(['config', 'check'], {
          cwd,
          path: [fakeBinDirWithOutput('orca-ide', 0, orcaStatusJson(true, state))],
        });

        expect(result.status).toBe(1);
      }
    );

    it('exits 1 when orca-ide exits 0 but its stdout is not JSON at all', () => {
      declareOrchestrators(false, true);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDirWithOutput('orca-ide', 0, 'not json')],
      });

      expect(result.status).toBe(1);
    });

    it('exits 1 when orca-ide exits 0 with valid JSON that has no result.runtime', () => {
      declareOrchestrators(false, true);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDirWithOutput('orca-ide', 0, JSON.stringify({ ok: true }))],
      });

      expect(result.status).toBe(1);
    });

    it('exits 1 when orca-ide exits non-zero even though its stdout is ready-and-reachable JSON', () => {
      declareOrchestrators(false, true);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDirWithOutput('orca-ide', 1, ORCA_READY_JSON)],
      });

      expect(result.status).toBe(1);
    });

    it('exits 0 when the ready JSON is on stdout even with several lines of noise on stderr', () => {
      declareOrchestrators(false, true);

      const noisyStderr =
        '[warn] Electron: this app is not signed\n' +
        'GPU process launch failed\n' +
        'looks like json but is not: {"reachable":false,"state":"stopped"}\n';

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDirWithOutput('orca-ide', 0, ORCA_READY_JSON, noisyStderr)],
      });

      expect(result.status).toBe(0);
    });

    it('prefers orca-ide over plain orca when both are on PATH: orca-ide answers, plain orca is junk', () => {
      declareOrchestrators(false, true);

      const orcaIdeDir = fakeBinDirWithOutput('orca-ide', 0, ORCA_READY_JSON);
      const orcaDir = fakeBinDirWithOutput('orca', 0, 'junk, must not be the one read');

      // Plain `orca` is listed FIRST on PATH, with orca-ide second, so a pass
      // here can only be explained by a genuine preference for orca-ide over
      // orca - not by orca-ide merely happening to come first on PATH.
      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [orcaDir, orcaIdeDir] });

      expect(result.status).toBe(0);
    });

    it('falls back to plain orca when orca-ide is not on PATH: ready JSON passes', () => {
      declareOrchestrators(false, true);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDirWithOutput('orca', 0, ORCA_READY_JSON)],
      });

      expect(result.status).toBe(0);
    });

    it('falls back to plain orca when orca-ide is not on PATH: non-ready JSON fails', () => {
      declareOrchestrators(false, true);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDirWithOutput('orca', 0, orcaStatusJson(false, 'ready'))],
      });

      expect(result.status).toBe(1);
    });

    it('names orca-ide and the docs URL in the failure line when orca-ide is the one probed', () => {
      declareOrchestrators(false, true);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDirWithOutput('orca-ide', 0, 'not json')],
      });

      const fails = failLines(checkSection(result.stdout, 2));
      expect(fails).toHaveLength(1);
      expect(fails[0]).toContain('orca-ide status --json');
      expect(fails[0]).toContain(ORCA_DOCS_URL);
    });

    it('names plain orca, not orca-ide, in the failure line for the fallback binary', () => {
      declareOrchestrators(false, true);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDirWithOutput('orca', 0, 'not json')],
      });

      const fails = failLines(checkSection(result.stdout, 2));
      expect(fails).toHaveLength(1);
      expect(fails[0]).toContain('orca status --json');
      expect(fails[0]).not.toContain('orca-ide');
      expect(fails[0]).toContain(ORCA_DOCS_URL);
    });

    it('names the command that answered in the passing line', () => {
      declareOrchestrators(false, true);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDirWithOutput('orca-ide', 0, ORCA_READY_JSON)],
      });

      const section = checkSection(result.stdout, 2);
      const passLine = section.split('\n').find(line => line.includes('PASS'));
      expect(passLine).toBeDefined();
      expect(passLine).toContain('orca-ide status --json');
    });

    it('leaves herdr passing on exit status alone: herdr exiting 0 while printing non-JSON stdout still passes', () => {
      declareOrchestrators(true, false);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDirWithOutput('herdr', 0, 'not json')],
      });

      expect(result.status).toBe(0);
    });
  });

  describe('browser mode probes (check 3)', () => {
    it.each(['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'])(
      'exits 0 when host.browser.headless is declared true and %s is on PATH',
      binaryName => {
        declareOrchestrators(false, false);
        expect(runCli(['config', 'set', 'host.browser.headless', 'true']).status).toBe(0);

        const cwd = makeProject('name: no-frontend-project\n');
        const result = runCli(['config', 'check'], {
          cwd,
          path: [fakeBinDir(binaryName, 0)],
        });

        expect(result.status).toBe(0);
      }
    );

    it('exits 1 when host.browser.headless is declared true but no chromium/chrome binary is on PATH', () => {
      declareOrchestrators(false, false);
      expect(runCli(['config', 'set', 'host.browser.headless', 'true']).status).toBe(0);

      const cwd = makeProject('name: no-frontend-project\n');
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
    });

    it('exits 1 when host.browser.local is declared true but no chromium/chrome binary is on PATH', () => {
      declareOrchestrators(false, false);
      expect(runCli(['config', 'set', 'host.browser.local', 'true']).status).toBe(0);

      const cwd = makeProject('name: no-frontend-project\n');
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
    });

    it('does not probe for chromium/chrome when host.browser.headless and host.browser.local are declared false', () => {
      declareOrchestrators(false, false);
      expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

      const cwd = makeProject('name: no-frontend-project\n');
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
    });

    it('exits 0 when host.browser.remote is declared true and the project cdp_port answers', async () => {
      const { port, close } = await startCdpServer();
      try {
        declareOrchestrators(false, false);
        expect(runCli(['config', 'set', 'host.browser.remote', 'true']).status).toBe(0);
        // headless/local are each independently required in a frontend
        // project – declare them too so check 1 is satisfied and this test
        // isolates check 3's remote probe.
        expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
        expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

        const cwd = makeProject(
          `frontend:\n  browser:\n    mode: remote\n    cdp_port: ${port}\n`
        );
        const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

        expect(result.status).toBe(0);
      } finally {
        await close();
      }
    });

    it('exits 1 when host.browser.remote is declared true but the project cdp_port is closed', async () => {
      const port = await closedPort();
      declareOrchestrators(false, false);
      expect(runCli(['config', 'set', 'host.browser.remote', 'true']).status).toBe(0);
      // headless/local are each independently required in a frontend
      // project – declare them too so check 1 is satisfied and this test
      // isolates check 3's remote probe.
      expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

      const cwd = makeProject(`frontend:\n  browser:\n    mode: remote\n    cdp_port: ${port}\n`);
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
    });

    it('exits 1 when host.browser.remote is declared true but the CDP port only accepts the connection and never answers HTTP', async () => {
      const { port, close } = await startSilentTcpServer();
      try {
        declareOrchestrators(false, false);
        expect(runCli(['config', 'set', 'host.browser.remote', 'true']).status).toBe(0);
        expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
        expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

        const cwd = makeProject(
          `frontend:\n  browser:\n    mode: remote\n    cdp_port: ${port}\n`
        );
        const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

        // A TCP connect alone must NOT be enough for this to pass: the port
        // accepts the connection but the process behind it never speaks
        // HTTP, which is exactly what a dead browser/relay behind a still-up
        // SSH reverse tunnel looks like.
        expect(result.status).toBe(1);
        expect(result.stderr).not.toContain('unknown command');
      } finally {
        await close();
      }
    });
  });

  describe("project's preferred browser mode (check 4)", () => {
    it('exits 0 when the project prefers remote and host.browser.remote is declared true', async () => {
      const { port, close } = await startCdpServer();
      try {
        declareOrchestrators(false, false);
        expect(runCli(['config', 'set', 'host.browser.remote', 'true']).status).toBe(0);
        expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
        expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

        const cwd = makeProject(
          `frontend:\n  browser:\n    mode: remote\n    cdp_port: ${port}\n`
        );
        const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

        expect(result.status).toBe(0);
      } finally {
        await close();
      }
    });

    it('exits 0 and reports the fallback mode when the project prefers remote but only headless is declared true', () => {
      declareOrchestrators(false, false);
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'true']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDir('chromium', 0)],
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('headless');
    });

    it('exits 1 when the project prefers a mode and none of the browser axes are declared true', () => {
      declareOrchestrators(false, false);
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
    });
  });

  describe('check 4 honours frontend.browser.fallback', () => {
    // Common to every case below: project prefers remote, the host declares
    // remote unavailable and headless available (local unavailable), and
    // both orchestrators are declared (both false, so check 1 and check 2
    // never muddy the exit code). A real chromium binary is on PATH so
    // check 3 - which independently probes host.browser.headless because it
    // is declared true - passes too, isolating check 4's own outcome.
    function declareRemotePreferredHeadlessAvailable(): void {
      declareOrchestrators(false, false);
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'true']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);
    }

    it('fallback: none fails check 4 and exits 1, even though headless is available to fall back to', () => {
      declareRemotePreferredHeadlessAvailable();

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n    fallback: none\n');
      const result = runCli(['config', 'check'], { cwd, path: [fakeBinDir('chromium', 0)] });

      expect(result.status).toBe(1);
      const fails = failLines(checkSection(result.stdout, 4));
      expect(fails).toHaveLength(1);
      // Names the preferred mode, and must not claim to have fallen back to
      // headless - falling back is exactly what "none" forbids.
      expect(fails[0]).toContain('remote');
      expect(fails[0]).not.toContain('falling back to headless');
      expect(fails[0].toLowerCase()).toContain('fallback');
    });

    it('fallback unset passes check 4 and reports the fallback to headless (unchanged behaviour)', () => {
      declareRemotePreferredHeadlessAvailable();

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
      const result = runCli(['config', 'check'], { cwd, path: [fakeBinDir('chromium', 0)] });

      expect(result.status).toBe(0);
      expect(checkSection(result.stdout, 4)).toContain('headless');
    });

    it('fallback: headless passes check 4 and reports the fallback to headless, same as unset', () => {
      declareRemotePreferredHeadlessAvailable();

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n    fallback: headless\n');
      const result = runCli(['config', 'check'], { cwd, path: [fakeBinDir('chromium', 0)] });

      expect(result.status).toBe(0);
      expect(checkSection(result.stdout, 4)).toContain('headless');
    });

    it('fallback: local still falls back to headless, because only "none" overrides the remote>headless>local order', () => {
      declareRemotePreferredHeadlessAvailable();

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n    fallback: local\n');
      const result = runCli(['config', 'check'], { cwd, path: [fakeBinDir('chromium', 0)] });

      expect(result.status).toBe(0);
      const section = checkSection(result.stdout, 4);
      expect(section).toContain('headless');
      expect(section).not.toContain('falling back to local');
    });

    it('fallback: none passes when the host already declares the preferred mode true - there is nothing to fall back to', async () => {
      const { port, close } = await startCdpServer();
      try {
        declareOrchestrators(false, false);
        expect(runCli(['config', 'set', 'host.browser.remote', 'true']).status).toBe(0);
        expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
        expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

        const cwd = makeProject(
          `frontend:\n  browser:\n    mode: remote\n    cdp_port: ${port}\n    fallback: none\n`
        );
        const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

        expect(result.status).toBe(0);
      } finally {
        await close();
      }
    });

    it('fallback: none still fails when no browser mode is declared true at all (unchanged behaviour)', () => {
      declareOrchestrators(false, false);
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n    fallback: none\n');
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
    });
  });

  describe('optional axes are informational only (check 5)', () => {
    it('exits 0 with host.preview.tailscale_serve, host.element_picker and host.orca.topology all left unset', () => {
      declareOrchestrators(false, false);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
    });

    it('reports host.orca.topology as inert when host.orchestrators.orca is false', () => {
      declareOrchestrators(true, false);
      expect(runCli(['config', 'set', 'host.orca.topology', 'local']).status).toBe(0);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [fakeBinDir('herdr', 0)] });

      expect(result.status).toBe(0);
      const line = lineContaining(checkSection(result.stdout, 5), 'host.orca.topology');
      expect(line).toBeDefined();
      expect(line).toContain('inert');
      expect(line).toContain('host.orchestrators.orca');
    });

    it('reports host.orca.topology as inert when host.orchestrators.orca is unset', () => {
      expect(runCli(['config', 'set', 'host.orchestrators.herdr', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.orca.topology', 'local']).status).toBe(0);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      const line = lineContaining(checkSection(result.stdout, 5), 'host.orca.topology');
      expect(line).toBeDefined();
      expect(line).toContain('inert');
    });

    it('does not report host.orca.topology as inert when host.orchestrators.orca is true', () => {
      declareOrchestrators(false, true);
      expect(runCli(['config', 'set', 'host.orca.topology', 'remote']).status).toBe(0);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDirWithOutput('orca-ide', 0, ORCA_READY_JSON)],
      });

      expect(result.status).toBe(0);
      const line = lineContaining(checkSection(result.stdout, 5), 'host.orca.topology');
      expect(line).toBeDefined();
      expect(line).not.toContain('inert');
    });
  });
});

// -----------------------------------------------------------------------
// spechub config browser-mode [--json]
//
// Answers one question: which browser mode should the frontend verifier
// actually use on this machine, and why. It resolves purely from what is
// already declared - the global config's `host.browser.<mode>` booleans and
// the project's `frontend.browser.mode` / `frontend.browser.fallback` - and
// never probes the machine (no port knocking, no binary lookup), so `path`
// is set to `emptyPathDir()` throughout this suite: a correct implementation
// must reach the same answer with nothing at all on PATH.
//
// A mode is "enabled" when its `host.browser.<mode>` axis is declared exactly
// `true` (an unset axis and a `false` one are both "not enabled"). Priority
// order among modes is remote > headless > local.
//
// Resolution, in the order it is decided (numbered to match the rule labels
// on the describe blocks below, not the order they are declared in):
//   Rule 6. No SpecHub project here, or the project has no frontend
//      configured -> exit 1, stderr names `/spechub:init`, stdout stays
//      empty. Outranks everything else, even a host that declares every
//      mode available.
//   Rule 5. No mode is enabled at all -> exit 1, stderr names
//      `/spechub:host`, in one of two distinct messages: nothing declared at
//      all, or all three declared false.
//   Rule 1. The project states a preferred mode (`frontend.browser.mode` is
//      one of remote/headless/local) and it is enabled -> that mode wins,
//      not a fallback.
//   The project states a preferred mode that is NOT enabled:
//     Rule 3. `frontend.browser.fallback` is the literal "none" -> exit 1,
//        stderr names the preferred mode, names `frontend.browser.fallback`,
//        and names `/spechub:host`.
//     Rule 2. anything else (including a fallback value naming a mode - only
//        "none" is special) -> the first enabled mode in priority order
//        wins, and this IS a fallback.
//   Rule 4. The project states no preferred mode at all (but has a
//      frontend) -> the first enabled mode in priority order wins, and this
//      is NOT a fallback - there was no preference to fall back from, so
//      `fallback: none` changes nothing here either.
//
// Exit codes are 0 or 1 only, never 2.
//
// `--json` prints a single object `{ mode, preferred, reason, fallback }` on
// success: `mode` is the resolved mode string, `preferred` is the project's
// stated mode or `null` when it states none, `reason` is a non-empty human
// sentence, and `fallback` is `true` only when the resolved mode differs from
// a stated preference (never true when there was no preference to begin
// with). On every failure, `--json` prints no JSON object at all - stdout
// stays empty, and the message goes to stderr as plain text.
// -----------------------------------------------------------------------

describe('spechub config browser-mode', () => {
  describe('no project / no frontend outranks everything (rule 6)', () => {
    it('exits 1 naming /spechub:init with no SpecHub project anywhere above cwd', () => {
      const cwd = noProjectDir();
      const result = runCli(['config', 'browser-mode'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('/spechub:init');
      expect(result.stdout).toBe('');
    });

    it('exits 1 naming /spechub:init when the project has no frontend configured', () => {
      const cwd = makeProject('name: no-frontend-project\n');
      const result = runCli(['config', 'browser-mode'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('/spechub:init');
      expect(result.stdout).toBe('');
    });

    it('exits 1 naming /spechub:init even when the host declares every browser mode available, for a no-frontend project', () => {
      declareOrchestrators(false, false);
      expect(runCli(['config', 'set', 'host.browser.remote', 'true']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'true']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'true']).status).toBe(0);

      const cwd = makeProject('name: no-frontend-project\n');
      const result = runCli(['config', 'browser-mode'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('/spechub:init');
    });

    it('--json prints no JSON object on the no-project failure - stdout stays empty', () => {
      const cwd = noProjectDir();
      const result = runCli(['config', 'browser-mode', '--json'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('/spechub:init');
    });
  });

  describe('no mode enabled at all (rule 5, two distinct messages)', () => {
    it('exits 1 naming /spechub:host, with a different message when nothing is declared than when all three are declared false', () => {
      const yaml = 'frontend:\n  browser:\n    mode: remote\n';

      // Shade A: the project has a frontend, but none of the three
      // host.browser.* axes has been declared at all - the host has not been
      // described yet, which is a different situation from the host actively
      // saying it has nothing available (shade B, below).
      const cwdA = makeProject(yaml);
      const resultA = runCli(['config', 'browser-mode'], { cwd: cwdA, path: [emptyPathDir()] });
      expect(resultA.status).toBe(1);
      expect(resultA.stderr).toContain('/spechub:host');
      expect(resultA.stdout).toBe('');
      expect(resultA.stderr).toContain('has not been described yet');
      expect(resultA.stderr).not.toContain('declares no browser mode available');

      // Shade B: all three axes are declared, and all false.
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

      const cwdB = makeProject(yaml);
      const resultB = runCli(['config', 'browser-mode'], { cwd: cwdB, path: [emptyPathDir()] });
      expect(resultB.status).toBe(1);
      expect(resultB.stderr).toContain('/spechub:host');
      expect(resultB.stdout).toBe('');
      expect(resultB.stderr).toContain('declares no browser mode available');
      expect(resultB.stderr).not.toContain('has not been described yet');

      // Belt and braces: whatever the exact wording, the two shades must
      // never collapse into one identical message.
      expect(resultB.stderr).not.toBe(resultA.stderr);
    });

    it('--json prints no JSON object when no mode is enabled at all', () => {
      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
      const result = runCli(['config', 'browser-mode', '--json'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('/spechub:host');
    });
  });

  describe('preferred mode declared available (rule 1)', () => {
    it('resolves to the preferred mode, exit 0, and the mode name appears in plain output', () => {
      expect(runCli(['config', 'set', 'host.browser.remote', 'true']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
      const result = runCli(['config', 'browser-mode'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('remote');
    });

    it('--json reports mode=remote, preferred=remote, fallback=false, and a non-empty reason', () => {
      expect(runCli(['config', 'set', 'host.browser.remote', 'true']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
      const result = runCli(['config', 'browser-mode', '--json'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout) as ConfigBrowserModeJson;
      const { reason, ...rest } = json;
      expect(rest).toEqual({ mode: 'remote', preferred: 'remote', fallback: false });
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(0);
    });

    it('fallback: none does not cause a failure when the preferred mode itself is declared available - nothing to fall back from', () => {
      expect(runCli(['config', 'set', 'host.browser.remote', 'true']).status).toBe(0);

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n    fallback: none\n');
      const result = runCli(['config', 'browser-mode', '--json'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout) as ConfigBrowserModeJson;
      expect(json.mode).toBe('remote');
      expect(json.fallback).toBe(false);
    });
  });

  describe('preferred mode not declared available, fallback allowed (rule 2)', () => {
    it('falls back to the next available mode in priority order, and plain output names both the preferred and chosen mode', () => {
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'true']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'true']).status).toBe(0);

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
      const result = runCli(['config', 'browser-mode'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('remote');
      expect(result.stdout).toContain('headless');
    });

    it('--json reports mode=headless, preferred=remote, fallback=true', () => {
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'true']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'true']).status).toBe(0);

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
      const result = runCli(['config', 'browser-mode', '--json'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout) as ConfigBrowserModeJson;
      expect(json.mode).toBe('headless');
      expect(json.preferred).toBe('remote');
      expect(json.fallback).toBe(true);
      expect(json.reason).toContain('remote');
      expect(json.reason).toContain('headless');
    });

    it('falls back to local when only local is declared available', () => {
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'true']).status).toBe(0);

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
      const result = runCli(['config', 'browser-mode', '--json'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout) as ConfigBrowserModeJson;
      expect(json.mode).toBe('local');
      expect(json.fallback).toBe(true);
    });

    it('a fallback value naming a mode does not override the remote > headless > local priority order', () => {
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'true']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'true']).status).toBe(0);

      // fallback names "local", but headless outranks local in priority order
      // and is also declared available - only the literal "none" is special.
      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n    fallback: local\n');
      const result = runCli(['config', 'browser-mode', '--json'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout) as ConfigBrowserModeJson;
      expect(json.mode).toBe('headless');
    });
  });

  describe('preferred mode not declared available, fallback forbidden (rule 3)', () => {
    it('exits 1 naming the preferred mode, frontend.browser.fallback, and /spechub:host, even though another mode is available', () => {
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'true']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'true']).status).toBe(0);

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n    fallback: none\n');
      const result = runCli(['config', 'browser-mode'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('remote');
      expect(result.stderr).toContain('frontend.browser.fallback');
      expect(result.stderr).toContain('/spechub:host');
    });

    it('--json prints no JSON object on the fallback:none failure', () => {
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'true']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'true']).status).toBe(0);

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n    fallback: none\n');
      const result = runCli(['config', 'browser-mode', '--json'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('remote');
      expect(result.stderr).toContain('frontend.browser.fallback');
    });
  });

  describe('no preferred mode stated (rule 4)', () => {
    it('resolves to the first available mode in priority order, and plain output says the project states no preference', () => {
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'true']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'true']).status).toBe(0);

      // The project has a frontend but states no frontend.browser.mode.
      const cwd = makeProject('frontend:\n  something: true\n');
      const result = runCli(['config', 'browser-mode'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('headless');
      expect(result.stdout.toLowerCase()).toMatch(/no.*preference/);
    });

    it('--json reports mode=headless, preferred=null, fallback=false', () => {
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'true']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'true']).status).toBe(0);

      const cwd = makeProject('frontend:\n  something: true\n');
      const result = runCli(['config', 'browser-mode', '--json'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout) as ConfigBrowserModeJson;
      expect(json.mode).toBe('headless');
      expect(json.preferred).toBeNull();
      // Not a fallback: there was no stated preference to fall back from.
      expect(json.fallback).toBe(false);
      expect(json.reason.toLowerCase()).toMatch(/no.*preference/);
    });

    it('fallback: none changes nothing when the project states no preference, since there is nothing to fall back from', () => {
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'true']).status).toBe(0);

      const cwd = makeProject('frontend:\n  browser:\n    fallback: none\n');
      const result = runCli(['config', 'browser-mode', '--json'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout) as ConfigBrowserModeJson;
      expect(json.mode).toBe('local');
      expect(json.preferred).toBeNull();
      expect(json.fallback).toBe(false);
    });

    it('exits 1 naming /spechub:host when the project states no preference and no mode is enabled at all', () => {
      const cwd = makeProject('frontend:\n  something: true\n');
      const result = runCli(['config', 'browser-mode'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('/spechub:host');
      expect(result.stdout).toBe('');
    });
  });

  describe('exit codes and JSON well-formedness', () => {
    it('never exits 2 - only 0 or 1, on both a failure case and a success case', () => {
      const cases: Array<{ yaml: string; setup?: () => void; expectedStatus: number }> = [
        { yaml: 'frontend:\n  browser:\n    mode: remote\n', expectedStatus: 1 }, // rule 5
        {
          yaml: 'frontend:\n  browser:\n    mode: remote\n',
          setup: () => {
            expect(runCli(['config', 'set', 'host.browser.remote', 'true']).status).toBe(0);
          },
          expectedStatus: 0,
        }, // rule 1
      ];

      for (const { yaml, setup, expectedStatus } of cases) {
        setup?.();
        const cwd = makeProject(yaml);
        const result = runCli(['config', 'browser-mode'], { cwd, path: [emptyPathDir()] });
        expect(result.status).not.toBe(2);
        expect(result.status).toBe(expectedStatus);
      }
    });

    it('--json prints valid, parseable JSON in one call on success (no interleaved prose)', () => {
      expect(runCli(['config', 'set', 'host.browser.remote', 'true']).status).toBe(0);

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
      const result = runCli(['config', 'browser-mode', '--json'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
      expect(() => JSON.parse(result.stdout) as ConfigBrowserModeJson).not.toThrow();
    });
  });
});
