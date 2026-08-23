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
    orchestrator?: string;
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

interface ConfigShowJson {
  hasProject: boolean;
  hasFrontend: boolean;
  axes: ConfigShowAxis[];
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

describe('spechub config set host.*', () => {
  it('sets an allowed enum value with exit 0 and writes the nested value to disk', () => {
    const result = runCli(['config', 'set', 'host.orchestrator', 'orca']);

    expect(result.status).toBe(0);

    const raw = JSON.parse(readFileSync(configFilePath(), 'utf-8')) as StoredConfig;
    expect(raw).toEqual({ host: { orchestrator: 'orca' } });
  });

  it('rejects an unknown enum value with exit 1 and names the allowed values', () => {
    const result = runCli(['config', 'set', 'host.orchestrator', 'tmux']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('herdr');
    expect(result.stderr).toContain('orca');
    expect(result.stderr).toContain('none');
  });

  it('rejects an unknown host.* key with exit 1 and lists allowed host keys', () => {
    const result = runCli(['config', 'set', 'host.bogus', 'x']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('host.orchestrator');
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
    expect(result.stderr).toContain('host.orchestrator');
    expect(result.stderr).toContain('host.orca.topology');
  });
});

describe('spechub config set host.orca.topology warns when orchestrator is not orca', () => {
  it('sets successfully and warns that it has no effect when host.orchestrator is unset', () => {
    const result = runCli(['config', 'set', 'host.orca.topology', 'local']);

    expect(result.status).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('no effect');
    expect(combined).toContain('orca');

    const raw = JSON.parse(readFileSync(configFilePath(), 'utf-8')) as StoredConfig;
    expect(raw).toEqual({ host: { orca: { topology: 'local' } } });
  });

  it('sets successfully and warns that it has no effect when host.orchestrator is set to something other than orca', () => {
    expect(runCli(['config', 'set', 'host.orchestrator', 'herdr']).status).toBe(0);

    const result = runCli(['config', 'set', 'host.orca.topology', 'remote']);

    expect(result.status).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('no effect');

    const raw = JSON.parse(readFileSync(configFilePath(), 'utf-8')) as StoredConfig;
    expect(raw.host.orca.topology).toBe('remote');
  });

  it('sets successfully with no "no effect" warning when host.orchestrator is orca', () => {
    expect(runCli(['config', 'set', 'host.orchestrator', 'orca']).status).toBe(0);

    const result = runCli(['config', 'set', 'host.orca.topology', 'local']);

    expect(result.status).toBe(0);
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain('no effect');
  });
});

describe('spechub config get host', () => {
  it('returns the whole host section as JSON', () => {
    expect(runCli(['config', 'set', 'host.orchestrator', 'orca']).status).toBe(0);
    expect(runCli(['config', 'set', 'host.browser.remote', 'true']).status).toBe(0);

    const result = runCli(['config', 'get', 'host']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      orchestrator: 'orca',
      browser: { remote: true },
    });
  });

  it('includes host.orca.topology in the host section when set', () => {
    expect(runCli(['config', 'set', 'host.orchestrator', 'orca']).status).toBe(0);
    expect(runCli(['config', 'set', 'host.orca.topology', 'remote']).status).toBe(0);

    const result = runCli(['config', 'get', 'host']);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      orchestrator: 'orca',
      orca: { topology: 'remote' },
    });
  });
});

describe('spechub config unset host.*', () => {
  it('removes a set axis with exit 0, prints Removed <key>, and the key is gone on disk', () => {
    expect(runCli(['config', 'set', 'host.orchestrator', 'orca']).status).toBe(0);

    const result = runCli(['config', 'unset', 'host.orchestrator']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Removed host.orchestrator');

    const raw = JSON.parse(readFileSync(configFilePath(), 'utf-8')) as StoredConfig;
    expect(raw.host?.orchestrator).toBeUndefined();
  });

  it('reports "was not set" with exit 0 and does not rewrite the file for a never-set axis', () => {
    expect(runCli(['config', 'set', 'host.orchestrator', 'orca']).status).toBe(0);
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
    expect(result.stderr).toContain('host.orchestrator');
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
    expect(runCli(['config', 'set', 'host.orchestrator', 'orca']).status).toBe(0);
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
  it('exits 2 and reports unset + required for an unset required axis', () => {
    const result = runCli(['config', 'get', 'host.orchestrator']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unset');
    expect(result.stderr).toContain('required');
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
//   { hasProject: boolean, hasFrontend: boolean, axes: HostAxisStatus[] }
// where each entry in `axes` is
//   { key: string, required: boolean, status: 'declared'|'detected'|'unset', value?: unknown }
// `value` is present when status is 'declared' or 'detected', and absent (or
// null) when status is 'unset'. Declared and detected are always distinct
// status values – detection never counts as a declaration.
// -----------------------------------------------------------------------

describe('spechub config show', () => {
  it('exits 0 and lists all seven host axes when nothing at all is configured', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
    for (const key of [
      'host.orchestrator',
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

  it('--json reports required: true for host.orchestrator but false for the browser axes with no project', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const byKey = Object.fromEntries(json.axes.map((a): [string, ConfigShowAxis] => [a.key, a]));

    expect(byKey['host.orchestrator'].required).toBe(true);
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

    expect(byKey['host.orchestrator'].required).toBe(true);
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

    expect(byKey['host.orchestrator'].required).toBe(true);
    expect(byKey['host.browser.remote'].required).toBe(true);
    expect(byKey['host.browser.headless'].required).toBe(true);
    expect(byKey['host.browser.local'].required).toBe(true);
  });

  it('--json marks a value set via `config set` as status "declared" with its stored value', () => {
    expect(runCli(['config', 'set', 'host.orchestrator', 'herdr']).status).toBe(0);

    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const orchestrator = json.axes.find((a: { key: string }) => a.key === 'host.orchestrator')!;
    expect(orchestrator.status).toBe('declared');
    expect(orchestrator.value).toBe('herdr');
  });

  it('text mode marks a declared axis as declared on the line naming it', () => {
    expect(runCli(['config', 'set', 'host.orchestrator', 'herdr']).status).toBe(0);

    const cwd = noProjectDir();
    const result = runCli(['config', 'show'], { cwd, path: [emptyPathDir()] });

    const line = lineContaining(result.stdout, 'host.orchestrator');
    expect(line).toBeDefined();
    expect(line).toContain('declared');
  });

  it('--json marks an axis with no config value and nothing detectable as status "unset" with no value', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const picker = json.axes.find((a: { key: string }) => a.key === 'host.element_picker')!;
    expect(picker.status).toBe('unset');
    expect(picker.value ?? null).toBeNull();
  });

  it('--json marks host.orchestrator as "detected" (not "declared") when the herdr binary is on PATH but nothing was set', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], {
      cwd,
      path: [fakeBinDir('herdr', 0)],
    });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const orchestrator = json.axes.find((a: { key: string }) => a.key === 'host.orchestrator')!;
    expect(orchestrator.status).toBe('detected');
    expect(orchestrator.status).not.toBe('declared');
  });

  it('--json does not report host.orchestrator as detected when no orchestrator binary is on PATH', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'show', '--json'], { cwd, path: [emptyPathDir()] });

    const json = JSON.parse(result.stdout) as ConfigShowJson;
    const orchestrator = json.axes.find((a: { key: string }) => a.key === 'host.orchestrator')!;
    expect(orchestrator.status).toBe('unset');
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
// spechub config check
// -----------------------------------------------------------------------

describe('spechub config check', () => {
  it('exits 2 when a required axis (host.orchestrator) is unset', () => {
    const cwd = noProjectDir();
    const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(2);
  });

  it('exits 0 with no project when host.orchestrator is "none" and browser axes are unset', () => {
    expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);

    const cwd = noProjectDir();
    const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
  });

  it('exits 0 in a project without a frontend even though the browser axes are unset', () => {
    expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);

    const cwd = makeProject('name: no-frontend-project\n');
    const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(0);
  });

  it('exits 2 in a project with a frontend when the browser axes are unset', () => {
    expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);

    const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
    const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(2);
  });

  it('exits 2 in a project with a frontend when only host.browser.remote is declared and headless/local are still unset', () => {
    // The three browser axes are each independently required – declaring one
    // of them does not satisfy the requirement for the other two. Pins the
    // strict per-axis reading (as opposed to treating the three as one
    // group question that any single declaration answers).
    expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);
    expect(runCli(['config', 'set', 'host.browser.remote', 'true']).status).toBe(0);

    const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
    const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(2);
  });

  it('exits 0 once required axes are all set, isolated from the preferred-mode check (check 1 alone)', () => {
    expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);
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
    expect(runCli(['config', 'set', 'host.orchestrator', 'herdr']).status).toBe(0);
    // host.browser.* left unset (required, since the project has a frontend)
    // while host.orchestrator is set to a binary that is not on PATH at all
    // (which would independently fail check 2).
    const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
    const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

    expect(result.status).toBe(2);
  });

  describe('orchestrator probe (check 2)', () => {
    it('exits 0 when host.orchestrator is herdr and the herdr binary answers `herdr api` successfully', () => {
      expect(runCli(['config', 'set', 'host.orchestrator', 'herdr']).status).toBe(0);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [fakeBinDir('herdr', 0)] });

      expect(result.status).toBe(0);
    });

    it('exits 1 when host.orchestrator is herdr but no herdr binary is on PATH', () => {
      expect(runCli(['config', 'set', 'host.orchestrator', 'herdr']).status).toBe(0);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
    });

    it('exits 1 when host.orchestrator is herdr and the herdr binary is present but its server does not answer', () => {
      expect(runCli(['config', 'set', 'host.orchestrator', 'herdr']).status).toBe(0);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [fakeBinDir('herdr', 1)] });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
    });

    it('exits 0 when host.orchestrator is orca and the orca-ide binary answers `orca-ide status --json` successfully', () => {
      expect(runCli(['config', 'set', 'host.orchestrator', 'orca']).status).toBe(0);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [fakeBinDir('orca-ide', 0)] });

      expect(result.status).toBe(0);
    });

    it('exits 1 when host.orchestrator is orca but no orca-ide binary is on PATH', () => {
      expect(runCli(['config', 'set', 'host.orchestrator', 'orca']).status).toBe(0);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
    });

    it('exits 1 when host.orchestrator is orca and orca-ide is present but its server does not answer', () => {
      expect(runCli(['config', 'set', 'host.orchestrator', 'orca']).status).toBe(0);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [fakeBinDir('orca-ide', 1)] });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
    });

    it('exits 0 when host.orchestrator is none, regardless of what is on PATH (nothing to probe)', () => {
      expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
    });
  });

  describe('browser mode probes (check 3)', () => {
    it.each(['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'])(
      'exits 0 when host.browser.headless is declared true and %s is on PATH',
      binaryName => {
        expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);
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
      expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'true']).status).toBe(0);

      const cwd = makeProject('name: no-frontend-project\n');
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
    });

    it('exits 1 when host.browser.local is declared true but no chromium/chrome binary is on PATH', () => {
      expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'true']).status).toBe(0);

      const cwd = makeProject('name: no-frontend-project\n');
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
    });

    it('does not probe for chromium/chrome when host.browser.headless and host.browser.local are declared false', () => {
      expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

      const cwd = makeProject('name: no-frontend-project\n');
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
    });

    it('exits 0 when host.browser.remote is declared true and the project cdp_port answers', async () => {
      const { port, close } = await startCdpServer();
      try {
        expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);
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
      expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);
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
        expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);
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
        expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);
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
      expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);
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
      expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

      const cwd = makeProject('frontend:\n  browser:\n    mode: remote\n');
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
    });
  });

  describe('optional axes are informational only (check 5)', () => {
    it('exits 0 with host.preview.tailscale_serve, host.element_picker and host.orca.topology all left unset', () => {
      expect(runCli(['config', 'set', 'host.orchestrator', 'none']).status).toBe(0);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(0);
    });

    it('exits 0 and does not fail when host.orca.topology is set but host.orchestrator is not orca (reported inert)', () => {
      expect(runCli(['config', 'set', 'host.orchestrator', 'herdr']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.orca.topology', 'local']).status).toBe(0);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [fakeBinDir('herdr', 0)] });

      expect(result.status).toBe(0);
      const line = lineContaining(result.stdout, 'orca.topology');
      expect(line).toBeDefined();
    });

    it('exits 0 and does not fail when host.orca.topology is set and host.orchestrator is orca', () => {
      expect(runCli(['config', 'set', 'host.orchestrator', 'orca']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.orca.topology', 'remote']).status).toBe(0);

      const cwd = noProjectDir();
      const result = runCli(['config', 'check'], { cwd, path: [fakeBinDir('orca-ide', 0)] });

      expect(result.status).toBe(0);
    });
  });
});
