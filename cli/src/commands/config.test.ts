import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readdirSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

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
 * The `spechub/project.yaml` keys this file's project-key assertions read
 * back. Values are `unknown` rather than their documented type on purpose:
 * half the point of the validation tests is that a boolean key holds a real
 * boolean and a numeric key a real number, and a typed field would hide the
 * very mistake being looked for.
 */
interface StoredProjectYaml {
  profile?: unknown;
  workflow?: {
    spec_sync?: unknown;
    frontend_verification?: unknown;
    design_review?: unknown;
    grilling?: { questions?: unknown };
    tdd?: { strict?: unknown; orchestrator_strict?: unknown };
    maps?: { tracker?: unknown; persist?: unknown };
    handoff?: {
      self_invoke?: unknown;
      ack_turns?: unknown;
      nudge_warn?: unknown;
      context_window?: unknown;
      context_thresholds?: unknown;
    };
  };
  commands?: Record<string, unknown>;
  directories?: Record<string, unknown>;
  frontend?: { browser?: { mode?: unknown; fallback?: unknown; cdp_port?: unknown } };
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

/**
 * One row of `spechub config check --json`.
 *
 * `id` is the stable handle a caller branches on. `message` is the same
 * sentence the human output prints, and is deliberately NOT what a caller is
 * expected to read for meaning - it can be reworded without breaking anyone.
 */
interface ConfigCheckJsonRow {
  id: string;
  status: 'pass' | 'fail' | 'info';
  message: string;
}

/** The `spechub config check --json` output shape. */
interface ConfigCheckJson {
  checks: ConfigCheckJsonRow[];
}

/**
 * The identifiers `check --json` gives the project rows.
 *
 * These are asserted by value on purpose: the whole point of a machine
 * readable mode is that a caller can say "the domain map row failed" without
 * matching prose, so the identifiers are part of the contract and renaming
 * one is a breaking change.
 */
const CHECK_ROW_IDS = {
  domainMap: 'domain-map',
  agentBrowser: 'agent-browser',
  agentBrowserJson: 'agent-browser-json',
  verificationKnowledge: 'verification-knowledge',
  frontendVerification: 'frontend-verification',
  outputStyle: 'output-style',
  impeccable: 'impeccable',
} as const;

/**
 * The identifier `check --json` gives check 4's row.
 *
 * Kept apart from `CHECK_ROW_IDS` because that constant names the rows about
 * this checkout's own files, which sections 6 and 7 print. Check 4 is one of
 * the numbered five and reports on the machine honouring a project's stated
 * preference, so it belongs beside them rather than among the project rows.
 * A caller branches on it the same way, so it is asserted by value all the
 * same.
 */
const PREFERRED_BROWSER_MODE_ROW = 'preferred-browser-mode';

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
 *
 * `env`, when given, is applied LAST, so a test can override
 * `XDG_CONFIG_HOME` (to use a config file it wrote itself rather than the
 * per-test one) or `HOME` (to isolate reads of `~/.claude/settings.json`
 * from whatever the machine running the suite happens to have there).
 */
function runCli(args: string[], opts: { cwd?: string; path?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdgConfigHome };
  if (opts.path) {
    env.PATH = opts.path.join(delimiter);
  }
  Object.assign(env, opts.env ?? {});
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
const ORCA_DOCS_URL = 'https://github.com/stablyai/orca/blob/main/docs/reference/headless-linux-server.md';

/** Create a temp project root containing spechub/project.yaml with `yaml` as its body. */
function makeProject(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), 'spechub-project-'));
  mkdirSync(join(root, 'spechub'), { recursive: true });
  writeFileSync(join(root, 'spechub', 'project.yaml'), yaml);
  return root;
}

/**
 * A temp project root whose `spechub/project.yaml` is a SYMLINK to a file
 * held elsewhere, handing back the root, the link and the file behind it.
 *
 * A shared project.yaml is linked in exactly this way: one copy kept in a
 * dotfiles directory or in the main checkout, and a link to it from every
 * worktree that reads it. The link is the path every command is handed, and
 * the file behind it is the one the user edits and the one git tracks.
 */
function makeSymlinkedProject(yaml: string): { root: string; link: string; target: string } {
  const root = mkdtempSync(join(tmpdir(), 'spechub-symlinked-project-'));
  mkdirSync(join(root, 'spechub'), { recursive: true });
  mkdirSync(join(root, 'real'), { recursive: true });
  const target = join(root, 'real', 'project.yaml');
  writeFileSync(target, yaml);
  const link = join(root, 'spechub', 'project.yaml');
  symlinkSync(target, link);
  return { root, link, target };
}

/** An isolated cwd guaranteed to have no spechub/ directory anywhere above it. */
function noProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'spechub-no-project-'));
}

/**
 * A project root holding `spechub/` and nothing inside it - no project.yaml
 * at all. Still a project, because `findProjectRoot` looks for the directory.
 */
function projectWithoutYaml(): string {
  const root = mkdtempSync(join(tmpdir(), 'spechub-project-'));
  mkdirSync(join(root, 'spechub'), { recursive: true });
  return root;
}

/**
 * The raw text of a project's `spechub/project.yaml`, comments and all.
 *
 * Read as text rather than parsed because most of what the project-key tests
 * below pin - a header comment, an inline comment, the order of the keys, the
 * quoting of a value - has no representation in the parsed object at all.
 */
function readProjectYaml(root: string): string {
  return readFileSync(join(root, 'spechub', 'project.yaml'), 'utf-8');
}

/**
 * The raw bytes of a project's `spechub/project.yaml`.
 *
 * `readProjectYaml` decodes as UTF-8, and a byte that is not valid UTF-8 comes
 * back through it as U+FFFD - so a decoded read cannot tell a file whose bytes
 * survived from one whose bytes were replaced. Both look the same. The bytes
 * are the only evidence.
 */
function readProjectYamlBytes(root: string): Buffer {
  return readFileSync(join(root, 'spechub', 'project.yaml'));
}

/**
 * Overwrite an existing project's `spechub/project.yaml` with raw `bytes`.
 *
 * `makeProject` takes a string, which node encodes as UTF-8 on the way out, so
 * a fixture that has to put a specific byte on disk - a latin-1 `0xE9` that no
 * UTF-8 decoder will accept - cannot be written as one.
 */
function writeProjectYamlBytes(root: string, bytes: Buffer): void {
  writeFileSync(join(root, 'spechub', 'project.yaml'), bytes);
}

/** A project's `spechub/project.yaml` parsed, for assertions about values rather than formatting. */
function parseProjectYaml(root: string): StoredProjectYaml {
  return parseYaml(readProjectYaml(root)) as StoredProjectYaml;
}

/**
 * A project's `spechub/project.yaml` parsed, reported with the file's own text
 * when it no longer parses.
 *
 * `parseProjectYaml` throws the parser's message, which names a line and a
 * column of a file the failure output never shows. The corruption the splice
 * tests below look for is whitespace - an eaten line break, a missing space
 * after a colon, a block scalar left at column zero - so the text is the
 * evidence, and a message naming line 2 without it says nothing.
 */
function parseProjectYamlShowingFile(root: string): StoredProjectYaml {
  try {
    return parseProjectYaml(root);
  } catch (err) {
    throw new Error(
      `spechub/project.yaml no longer parses after the write: ${(err as Error).message}\n` +
        `----- file on disk -----\n${readProjectYaml(root)}\n----- end of file -----`
    );
  }
}

/**
 * The value at dotted `key` in a parsed project.yaml, or undefined when any
 * step of the path is missing. Lets a parametrised test name the key it set
 * and read that same key back, rather than hand-writing one property chain
 * per case.
 */
function atKey(parsed: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    if (typeof node !== 'object' || node === null) return undefined;
    return (node as Record<string, unknown>)[part];
  }, parsed);
}

/**
 * The key names of the mapping at dotted `key`, sorted, or an empty list when
 * that path holds no mapping at all.
 *
 * `atKey` answers what a key holds, which cannot see a key the write INVENTED.
 * A value spliced into a flow collection can end one entry early and leave the
 * rest of itself parsing as a further key of the same mapping, so the file
 * still parses and every sibling still reads back - the whole key set is the
 * only assertion that catches it.
 */
function keysAt(parsed: unknown, key: string): string[] {
  const node = atKey(parsed, key);
  if (typeof node !== 'object' || node === null) return [];
  return Object.keys(node).sort();
}

/** Write `body` to `spechub/domain-map.yaml` under an existing project root. */
function writeDomainMap(root: string, body: string): void {
  mkdirSync(join(root, 'spechub'), { recursive: true });
  writeFileSync(join(root, 'spechub', 'domain-map.yaml'), body);
}

/** A well-formed domain map holding exactly three domains. */
const DOMAIN_MAP_THREE = [
  'domains:',
  '  cli:',
  '    paths:',
  '      - cli/src/',
  '  skills:',
  '    paths:',
  '      - skills/',
  '  hooks:',
  '    paths:',
  '      - hooks/',
  '',
].join('\n');

/** Write `body` verbatim to `agent-browser.json` in the project root. */
function writeAgentBrowserJson(root: string, body: string): void {
  writeFileSync(join(root, 'agent-browser.json'), body);
}

/**
 * The `agent-browser.json` body naming `port`, written the way the `setup`
 * skill writes it: a single `cdp` key holding the port as a string.
 */
function agentBrowserJsonFor(port: number): string {
  return JSON.stringify({ cdp: String(port) }, null, 2) + '\n';
}

/** The `frontend.helpers_dir` every frontend fixture in this file names. */
const HELPERS_DIR = 'fe/helpers/';

/** Create `<root>/<HELPERS_DIR>/VERIFICATION-KNOWLEDGE.md` with a stub body. */
function writeVerificationKnowledge(root: string): void {
  const dir = join(root, HELPERS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'VERIFICATION-KNOWLEDGE.md'), '# Verification knowledge\n');
}

/**
 * A project.yaml body for a project that configures a frontend, naming
 * `helpers_dir` and a CDP port but deliberately NO `frontend.browser.mode`.
 *
 * Stating no preferred mode keeps check 4 informational and check 3 silent,
 * so a test of the project rows never has to arrange a browser on top of what
 * it is actually pinning.
 */
function frontendProjectYaml(cdpPort: number): string {
  return (
    'frontend:\n' +
    `  helpers_dir: "${HELPERS_DIR}"\n` +
    '  browser:\n' +
    `    cdp_port: ${cdpPort}\n`
  );
}

/** An isolated HOME, so reads of `~/.claude/settings.json` see only what a test put there. */
function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), 'spechub-home-'));
}

/** Write `body` verbatim to `<dir>/.claude/<name>`, creating `.claude/` as needed. */
function writeClaudeSettings(dir: string, name: string, body: string): void {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', name), body);
}

/** A `.claude/settings.json`-shaped body selecting `style` as the output style. */
function outputStyleSettings(style: string): string {
  return JSON.stringify({ outputStyle: style }, null, 2) + '\n';
}

/** The output style the plugin ships, which `check` reports on but never forces on. */
const SPECHUB_OUTPUT_STYLE = 'spechub:ac-writing-style';

// ---------------------------------------------------------------------
// Installed Claude Code plugins
//
// The helpers below build, in a temp directory, the two files Claude Code
// writes when a plugin is installed. Both shapes are Claude Code's, not
// SpecHub's, so they are written here as literals rather than derived from
// anything in this repository - a fixture that asked SpecHub for the shape
// would agree with SpecHub even when SpecHub is wrong.
//
//   <config root>/plugins/installed_plugins.json  - the registry, saying
//      which plugins are installed and where each one lives. Keys are
//      `<plugin>@<marketplace>`, and the marketplace half varies by where
//      the user installed from.
//   <installPath>/.claude-plugin/plugin.json      - the installed plugin's
//      own manifest, and the authoritative statement of its version. The
//      registry carries a version too, and it can be stale.
//
// The config root is `$CLAUDE_CONFIG_DIR` when that is set and non-empty,
// and `$HOME/.claude` otherwise.
// ---------------------------------------------------------------------

/** The registry file Claude Code writes under config root `root`. */
function installedPluginsPath(root: string): string {
  return join(root, 'plugins', 'installed_plugins.json');
}

/** One installed plugin, as a test wants it written into the registry. */
interface PluginInstall {
  /** The registry key, `<plugin>@<marketplace>`. */
  key: string;
  /** Where the plugin's own files live, and where its manifest is read from. */
  installPath: string;
  /** The version the REGISTRY states, which need not match the manifest. */
  version: string;
}

/** Write `installs` as the whole `installed_plugins.json` under config root `root`. */
function writeInstalledPlugins(root: string, installs: PluginInstall[]): void {
  const plugins: Record<string, unknown[]> = {};
  for (const install of installs) {
    plugins[install.key] = [
      {
        scope: 'user',
        installPath: install.installPath,
        version: install.version,
        installedAt: '2026-01-01T00:00:00.000Z',
        lastUpdated: '2026-01-01T00:00:00.000Z',
      },
    ];
  }

  mkdirSync(join(root, 'plugins'), { recursive: true });
  writeFileSync(
    installedPluginsPath(root),
    JSON.stringify({ version: 2, plugins }, null, 2) + '\n'
  );
}

/**
 * A temp directory standing in for one plugin's install path, holding the
 * manifest `manifest` at `.claude-plugin/plugin.json`.
 *
 * A `null` manifest writes no manifest file at all - the install path exists
 * and states nothing, which is what a half-written install looks like.
 */
function pluginInstallDir(manifest: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'spechub-plugin-install-'));
  if (manifest !== null) {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify(manifest, null, 2) + '\n'
    );
  }
  return dir;
}

/** The plugin `spechub config check` reports on, spelled as its manifest spells it. */
const IMPECCABLE_PLUGIN = 'impeccable';

/**
 * The major version SpecHub expects of an installed impeccable.
 *
 * Asserted by value: what counts as new enough is the whole content of the
 * pass-or-inform decision, so a test deriving it from the implementation
 * would agree with any number the implementation picked.
 */
const IMPECCABLE_MIN_MAJOR = '4';

/** How a test wants impeccable installed. */
interface ImpeccableInstall {
  /** The version the registry states, which the manifest can disagree with. */
  registryVersion: string;
  /** The version the manifest states, when it differs from the registry's. */
  manifestVersion?: string;
  /** What a broken install is missing: the manifest file, or its version field. */
  broken?: 'no-manifest' | 'no-version';
  /** The half of the registry key after the `@`, which varies by install source. */
  marketplace?: string;
}

/**
 * Install impeccable under config root `root` and hand back its install path.
 *
 * The registry version and the manifest version are separate inputs because
 * the manifest is the authority: a disagreement between the two is a case
 * that has to be arrangeable, and it is the only way to tell which file an
 * implementation actually read.
 */
function installImpeccable(root: string, opts: ImpeccableInstall): string {
  const manifest =
    opts.broken === 'no-manifest'
      ? null
      : opts.broken === 'no-version'
        ? { name: IMPECCABLE_PLUGIN }
        : { name: IMPECCABLE_PLUGIN, version: opts.manifestVersion ?? opts.registryVersion };

  const installPath = pluginInstallDir(manifest);
  writeInstalledPlugins(root, [
    {
      key: `${IMPECCABLE_PLUGIN}@${opts.marketplace ?? IMPECCABLE_PLUGIN}`,
      installPath,
      version: opts.registryVersion,
    },
  ]);
  return installPath;
}

/** A HOME whose `.claude` holds impeccable installed exactly as `opts` describes. */
function homeWithImpeccable(opts: ImpeccableInstall): string {
  const home = fakeHome();
  installImpeccable(join(home, '.claude'), opts);
  return home;
}

/** What a test declares on the `host` side of the global config file. */
interface HostDeclarations {
  orchestrators?: { herdr?: boolean; orca?: boolean };
  browser?: { remote?: boolean; headless?: boolean; local?: boolean };
  orca?: { topology?: string };
}

/**
 * Every host axis declared, with nothing that makes the machine checks
 * probe anything: no orchestrator to reach, no browser mode to find.
 *
 * This is the quiet baseline for the project-row tests below - checks 1 to 5
 * all pass or go informational under it, so any FAIL a test sees is the
 * project row it is actually pinning.
 */
const HOST_QUIET: HostDeclarations = {
  orchestrators: { herdr: false, orca: false },
  browser: { remote: false, headless: false, local: false },
};

/**
 * Run `spechub config check` against a global config written directly, an
 * isolated HOME, and a PATH holding only what the test asked for.
 *
 * Writing the config file rather than driving `spechub config set` is worth a
 * word: `runCli` spawns a real process, and declaring five axes through the
 * CLI costs five spawns before the run being measured even starts. The file
 * format is the one `writeGlobalConfig` produces and the `StoredConfig`
 * assertions elsewhere in this file already pin, so nothing is being assumed
 * here that is not tested somewhere.
 */
function runCheck(opts: {
  cwd: string;
  host?: HostDeclarations;
  path?: string[];
  home?: string;
  json?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  const xdg = mkdtempSync(join(tmpdir(), 'spechub-check-xdg-'));
  mkdirSync(join(xdg, 'spechub'), { recursive: true });
  writeFileSync(
    join(xdg, 'spechub', 'config.json'),
    JSON.stringify({ host: opts.host ?? HOST_QUIET }, null, 2) + '\n'
  );

  return runCli(['config', 'check', ...(opts.json ? ['--json'] : [])], {
    cwd: opts.cwd,
    path: opts.path ?? [emptyPathDir()],
    env: {
      XDG_CONFIG_HOME: xdg,
      HOME: opts.home ?? fakeHome(),
      // Emptied for the same reason HOME is replaced: Claude Code reads its
      // config root from this variable, so a machine that happens to set it
      // would send every read of `~/.claude` somewhere the test never wrote.
      // An empty value is not a value, so this leaves HOME deciding.
      CLAUDE_CONFIG_DIR: '',
      ...(opts.env ?? {}),
    },
  });
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
 * The outcome lines within numbered check `n`, its heading excluded.
 *
 * Rows print as three spaces, an outcome label and the message, and every
 * message is a single line, so counting these counts the rows the section
 * actually printed. Used where the number of rows is the point - a section
 * that gained a row it should not have is otherwise invisible to assertions
 * that only look for the row they came for.
 */
function sectionRows(output: string, n: number): string[] {
  return checkSection(output, n)
    .split('\n')
    .filter(line => /^ {3}(PASS|FAIL|INFO) /.test(line));
}

/**
 * The `check --json` row carrying `id`, parsed out of `stdout`, or undefined.
 *
 * The status is what a caller branches on, and several suites below need to
 * read one row's status out of a run rather than walk the whole object, so
 * the lookup lives here rather than being rewritten beside each of them.
 */
function checkJsonRow(stdout: string, id: string): ConfigCheckJsonRow | undefined {
  return (JSON.parse(stdout) as ConfigCheckJson).checks.find(check => check.id === id);
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

// ---------------------------------------------------------------------
// Project keys
//
// `spechub config set` writes two files, not one. A `host.*` key describes
// the machine and belongs in the global config; every other key SpecHub
// knows describes the project and belongs in `spechub/project.yaml`. The
// tests above pin the machine half. These pin the project half, and the two
// rules that make it worth having at all: a key nobody knows is refused
// rather than stored somewhere no reader looks, and a write into a file
// somebody hand-edited leaves their comments and their formatting alone.
//
// Every test here goes through `runSet`, so each one gets a global config
// directory of its own and can assert that nothing was written into it.
// ---------------------------------------------------------------------

/**
 * Run `spechub config set` in `cwd` against a global config directory of its
 * own, handing back where that directory's config file would be.
 *
 * The per-test `xdgConfigHome` is not reused, for two reasons. A `beforeAll`
 * runs before the `beforeEach` that creates it, so a shared arrangement would
 * otherwise spawn against the real `~/.config`. And routing is the thing
 * under test: "the project key did not land in the global config" is only an
 * assertion if the test knows which file that would have been.
 */
function runSet(key: string, value: string, cwd: string) {
  const xdg = mkdtempSync(join(tmpdir(), 'spechub-set-xdg-'));
  const result = runCli(['config', 'set', key, value], {
    cwd,
    env: { XDG_CONFIG_HOME: xdg },
  });
  return { ...result, globalConfigFile: join(xdg, 'spechub', 'config.json') };
}

/**
 * Run one `spechub config <subcommand>` in `cwd` against a global config
 * directory of its own, handing back where that directory's config file would
 * be.
 *
 * The read-side twin of `runSet`, isolated for the same two reasons. A
 * `beforeAll` runs before the `beforeEach` that creates the shared
 * `xdgConfigHome`, so a shared arrangement would otherwise reach the real
 * `~/.config`. And routing is part of what is under test: "the project key
 * was not read out of the global config" is only an assertion when the test
 * knows which file that would have been.
 */
function runProjectConfig(args: string[], cwd: string) {
  const xdg = mkdtempSync(join(tmpdir(), 'spechub-project-xdg-'));
  const result = runCli(['config', ...args], { cwd, env: { XDG_CONFIG_HOME: xdg } });
  return { ...result, globalConfigFile: join(xdg, 'spechub', 'config.json') };
}

/** `spechub config get <key>` in `cwd`, isolated the way `runSet` is. */
function runGet(key: string, cwd: string) {
  return runProjectConfig(['get', key], cwd);
}

/** `spechub config unset <key>` in `cwd`, isolated the way `runSet` is. */
function runUnset(key: string, cwd: string) {
  return runProjectConfig(['unset', key], cwd);
}

/**
 * Assert that `result` reported a problem rather than crashed out of it.
 *
 * An exit code of 1 alone does not tell the two apart: an uncaught throw exits
 * 1 too, and prints a stack trace naming the library frame that threw. So the
 * absence of the stack is the assertion. Two markers, because a crash shows
 * one or both: the indented `at` frames every V8 trace prints, and the
 * `node:fs` module line a throw from inside `writeFileSync` leads with.
 *
 * Both streams are checked. Where the trace lands is not the point - the user
 * seeing a library's internals instead of a sentence about their own file is.
 */
function expectNoStackTrace(result: { stdout: string; stderr: string }): void {
  const combined = result.stdout + result.stderr;
  expect(combined).not.toContain('    at ');
  expect(combined).not.toContain('node:fs');
}

/**
 * A hand-edited `project.yaml`: a header comment, blank lines between blocks,
 * an inline comment on one key, and quoted command strings.
 *
 * Every one of those is something a parse-and-rewrite round trip throws away
 * without saying so, which is why the fixture carries all of them at once and
 * the tests below name each separately.
 */
const HAND_EDITED_PROJECT = [
  '# Written by /spechub:setup, hand-edited since. Keep the comments.',
  'profile: node-typescript',
  '',
  'workflow:',
  '  spec_sync: true',
  '  grilling:',
  '    questions: tool      # tool | inline',
  '  tdd:',
  '    strict: true',
  '    orchestrator_strict: true',
  '',
  'commands:',
  '  test: "npm --prefix cli test"',
  '  build: "npm --prefix cli run build"',
  '',
  'directories:',
  '  source: "cli/src/"',
  '  tests: "tests/"',
  '',
].join('\n');

describe('spechub config set, project keys', () => {
  describe('routing', () => {
    it('writes a project key to spechub/project.yaml and creates no global config file at all', () => {
      const root = makeProject('name: routed-project\n');

      const result = runSet('workflow.tdd.strict', 'false', root);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('workflow.tdd.strict');
      expect(atKey(parseProjectYaml(root), 'workflow.tdd.strict')).toBe(false);
      // The bug this replaces: the value landed in the global config, under a
      // key nothing ever reads back out of that file.
      expect(existsSync(result.globalConfigFile)).toBe(false);
    });

    it('leaves spechub/project.yaml byte-identical when the key is a host axis', () => {
      const root = makeProject(HAND_EDITED_PROJECT);
      const before = readProjectYaml(root);

      const result = runSet('host.orchestrators.herdr', 'true', root);

      expect(result.status).toBe(0);
      const raw = JSON.parse(readFileSync(result.globalConfigFile, 'utf-8')) as StoredConfig;
      expect(raw).toEqual({ host: { orchestrators: { herdr: true } } });
      expect(readProjectYaml(root)).toBe(before);
    });

    it('refuses a key neither schema knows with exit 1, writing to neither file', () => {
      const root = makeProject(HAND_EDITED_PROJECT);
      const before = readProjectYaml(root);

      const result = runSet('workflow.bogus', 'x', root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Unknown config key "workflow.bogus"');
      expect(readProjectYaml(root)).toBe(before);
      expect(existsSync(result.globalConfigFile)).toBe(false);
    });

    it.each([
      ['workflow.bogus', 'workflow.spec_sync'],
      ['frontend.browser.bogus', 'frontend.browser.mode'],
      ['bogus', 'workflow.spec_sync'],
      // Claude Code owns outputStyle, and section 10 of the reference
      // promises `config set` cannot change it. It is neither schema's key,
      // so the unknown-key path is what has to say so.
      ['outputStyle', 'workflow.spec_sync'],
    ])('refuses %s and names %s, a key it does know', (unknown, known) => {
      const result = runSet(unknown, 'x', makeProject('name: unknown-key-project\n'));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(known);
    });

    it('refuses a project key outside a SpecHub project, writing nothing anywhere', () => {
      const cwd = noProjectDir();

      const result = runSet('workflow.tdd.strict', 'false', cwd);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/no SpecHub project/i);
      expect(existsSync(join(cwd, 'spechub'))).toBe(false);
      expect(existsSync(result.globalConfigFile)).toBe(false);
    });
  });

  describe('a write into a hand-edited file keeps the comments and the formatting', () => {
    // One arrangement read six ways. Each `it` names one thing a round trip
    // through a YAML parser would have silently thrown away.
    let text: string;
    let parsed: StoredProjectYaml;

    beforeAll(() => {
      const root = makeProject(HAND_EDITED_PROJECT);
      expect(runSet('workflow.tdd.strict', 'false', root).status).toBe(0);
      text = readProjectYaml(root);
      parsed = parseProjectYaml(root);
    });

    /**
     * The write this whole block is about.
     *
     * Every assertion here is about what the write LEFT ALONE, and a command
     * that wrote nothing at all satisfies all of them vacuously. Each test
     * names the write before it names what survived it, so none of them can
     * go green against a file nobody touched.
     */
    function expectTheWriteLanded(): void {
      expect(atKey(parsed, 'workflow.tdd.strict')).toBe(false);
    }

    it('keeps the header comment on the first line', () => {
      expectTheWriteLanded();

      expect(text.split('\n')[0]).toBe(
        '# Written by /spechub:setup, hand-edited since. Keep the comments.'
      );
    });

    it('keeps an inline comment on a key it did not touch, spacing included', () => {
      expectTheWriteLanded();

      expect(text).toContain('    questions: tool      # tool | inline');
    });

    it('keeps the order of the top-level blocks it did not touch', () => {
      expectTheWriteLanded();

      expect(text.indexOf('profile:')).toBeLessThan(text.indexOf('workflow:'));
      expect(text.indexOf('workflow:')).toBeLessThan(text.indexOf('commands:'));
      expect(text.indexOf('commands:')).toBeLessThan(text.indexOf('directories:'));
    });

    it('keeps the order of the sibling keys around the one it changed', () => {
      expectTheWriteLanded();

      expect(text.indexOf('spec_sync')).toBeLessThan(text.indexOf('grilling'));
      expect(text.indexOf('grilling')).toBeLessThan(text.indexOf('tdd'));
    });

    it('keeps the quoting of the values it did not touch', () => {
      expectTheWriteLanded();

      expect(text).toContain('  test: "npm --prefix cli test"');
      expect(text).toContain('  source: "cli/src/"');
    });

    it('changes the one key it was given and no other', () => {
      expect(atKey(parsed, 'workflow.tdd.strict')).toBe(false);
      expect(atKey(parsed, 'workflow.tdd.orchestrator_strict')).toBe(true);
      expect(atKey(parsed, 'workflow.spec_sync')).toBe(true);
      expect(atKey(parsed, 'profile')).toBe('node-typescript');
      expect(atKey(parsed, 'commands.test')).toBe('npm --prefix cli test');
    });
  });

  /**
   * The three shapes of write the in-place splice gets wrong.
   *
   * The splice rewrites the old value's byte range and leaves every other byte
   * alone, which is what keeps a hand-edited file intact. Three cases fall
   * outside what a byte range describes on its own: a block scalar whose range
   * runs past the line break that ends it, a key stated with no value at all
   * whose range is zero-width and starts flush against the colon, and a new
   * value spanning lines, which has to be emitted at the key's own indent
   * rather than at column zero.
   *
   * Each one exited 0 with a green "Set ..." line over a file that no longer
   * parses, so every test here asserts both halves: the command succeeded AND
   * the file survived it, values and siblings included.
   */
  describe('a write the in-place splice cannot take at face value', () => {
    /** A `commands` block stating `test` as a block scalar of style `style`. */
    function blockScalarProject(style: string): string {
      return [
        'commands:',
        `  test: ${style}`,
        '    npm test &&',
        '    npm run lint',
        '  build: "npm run build"',
        '  lint: "npm run lint"',
        '',
      ].join('\n');
    }

    it.each(['>', '|'])(
      'replaces a %s block scalar without swallowing the line break that ends it',
      (style) => {
        const root = makeProject(blockScalarProject(style));

        const result = runSet('commands.test', 'npm test', root);

        expect(result.status).toBe(0);
        const parsed = parseProjectYamlShowingFile(root);
        expect(atKey(parsed, 'commands.test')).toBe('npm test');
        // The key straight after the block scalar is the one that vanishes:
        // the splice eats the newline before it and glues the two lines into
        // one. Reading the sibling back is the only assertion that sees it.
        expect(atKey(parsed, 'commands.build')).toBe('npm run build');
        expect(atKey(parsed, 'commands.lint')).toBe('npm run lint');
      }
    );

    it('keeps the space after the colon when the key was stated with no value', () => {
      const root = makeProject(
        ['commands:', '  test:', '  build: "npm run build"', ''].join('\n')
      );

      const result = runSet('commands.test', 'npm test', root);

      expect(result.status).toBe(0);
      const parsed = parseProjectYamlShowingFile(root);
      expect(atKey(parsed, 'commands.test')).toBe('npm test');
      expect(atKey(parsed, 'commands.build')).toBe('npm run build');
    });

    it('keeps the space after the colon when the empty key is the last in the file', () => {
      // Same zero-width range with nothing after it, so a fix that works by
      // looking at the following line has to handle there not being one.
      const root = makeProject(['commands:', '  build: "npm run build"', '  test:', ''].join('\n'));

      const result = runSet('commands.test', 'npm test', root);

      expect(result.status).toBe(0);
      const parsed = parseProjectYamlShowingFile(root);
      expect(atKey(parsed, 'commands.test')).toBe('npm test');
      expect(atKey(parsed, 'commands.build')).toBe('npm run build');
    });

    it('indents a new value that spans lines under the key that holds it', () => {
      const root = makeProject(
        ['commands:', '  test: "npm test"', '  build: "npm run build"', ''].join('\n')
      );

      const result = runSet('commands.test', 'line one\nline two', root);

      expect(result.status).toBe(0);
      const parsed = parseProjectYamlShowingFile(root);
      expect(atKey(parsed, 'commands.test')).toBe('line one\nline two');
      expect(atKey(parsed, 'commands.build')).toBe('npm run build');
    });

    it('indents a value that spans lines to the depth of the key, not a fixed one', () => {
      // Four spaces rather than two, so an indent hard-coded to the shallow
      // case still fails here.
      const root = makeProject(
        [
          'frontend:',
          '  commands:',
          '    test: "npm --prefix web test"',
          '    build: "npm --prefix web build"',
          '',
        ].join('\n')
      );

      const result = runSet('frontend.commands.test', 'first line\nsecond line', root);

      expect(result.status).toBe(0);
      const parsed = parseProjectYamlShowingFile(root);
      expect(atKey(parsed, 'frontend.commands.test')).toBe('first line\nsecond line');
      expect(atKey(parsed, 'frontend.commands.build')).toBe('npm --prefix web build');
    });

    /**
     * The fourth shape: a scalar that sits inside a FLOW collection.
     *
     * The three above are about the node being replaced. This one is about the
     * context that node sits in, which the splice never looks at. A plain
     * scalar in `commands: { test: old, build: keep }` passes every guard -
     * it is plain, its range is non-zero, and the new value renders on one
     * line - so the splice takes it and writes a value rendered for BLOCK
     * context into a flow one. There `,` `{` `}` `[` `]` are syntax rather
     * than ordinary characters, and the value ends the entry, the mapping or
     * the sequence early.
     *
     * The failure comes two ways. A `,` leaves a file that still parses and
     * still holds every sibling, with the value truncated and the rest of it
     * standing as a key of its own - so only the exact value and the whole key
     * set see it. The brackets and braces leave a file that does not parse at
     * all. Both exit 0 with a green "Set ..." line, so every test here asserts
     * the whole contract: the command succeeded, the file parses, the key
     * holds exactly what was asked for, every sibling survives, and no key
     * exists that was not there before.
     *
     * Flow style is legal hand-edited YAML, and a `commands.*` value holding a
     * brace - `-exec rm {} ;` - is an ordinary shell command.
     *
     * What none of these pin is HOW the file comes back. Re-emitting the
     * document is a fair fix, and it turns flow style into block style and
     * requotes the value, so nothing below asserts either.
     */
    describe('a scalar inside a flow collection', () => {
      /** A `commands` block in flow style: the target first, one sibling after. */
      const FLOW_COMMANDS = 'commands: { test: old, build: keep }\n';

      /** The same block with the target LAST, so a truncation runs off the end. */
      const FLOW_COMMANDS_TARGET_LAST = 'commands: { build: keep, test: old }\n';

      it.each([
        // The three reported repros, in order.
        ['a comma, which ends the entry', 'run a, then b'],
        ['a closing brace, which ends the mapping', "find . -name '*.tmp' -exec rm {} ;"],
        ['a closing bracket', 'grep foo] bar'],
        // The same bug reached through the other three flow indicators.
        ['an opening brace, which starts a nested mapping', 'jq {foo} data.json'],
        ['an opening bracket, which starts a nested sequence', 'awk [start of range'],
        ['a lone closing brace', 'sh -c cleanup}'],
        // A mapping indicator in BOTH contexts, so the block renderer already
        // has to quote it. Here as the control: if this one ever fails, the
        // fix broke something the plain renderer was already getting right.
        ['a colon and a space, a mapping indicator in either context', 'sh -c echo done: ok'],
      ])(
        'writes a value holding %s into a flow mapping, exactly, inventing no key',
        (_indicator, value) => {
          const root = makeProject(FLOW_COMMANDS);

          const result = runSet('commands.test', value, root);

          expect(result.status).toBe(0);
          const parsed = parseProjectYamlShowingFile(root);
          expect(atKey(parsed, 'commands.test')).toBe(value);
          expect(atKey(parsed, 'commands.build')).toBe('keep');
          expect(keysAt(parsed, 'commands')).toEqual(['build', 'test']);
        }
      );

      it('writes a comma into the LAST entry of a flow mapping, inventing no key', () => {
        // The truncated tail has no sibling behind it to run into, so a fix
        // that works by looking at what follows the value has to handle the
        // value being what the mapping ends on.
        const root = makeProject(FLOW_COMMANDS_TARGET_LAST);

        const result = runSet('commands.test', 'run a, then b', root);

        expect(result.status).toBe(0);
        const parsed = parseProjectYamlShowingFile(root);
        expect(atKey(parsed, 'commands.test')).toBe('run a, then b');
        expect(atKey(parsed, 'commands.build')).toBe('keep');
        expect(keysAt(parsed, 'commands')).toEqual(['build', 'test']);
      });

      it('writes a comma into a flow mapping nested inside another flow mapping', () => {
        const root = makeProject('workflow: { handoff: { agent: claude, ack_turns: 5 } }\n');

        const result = runSet('workflow.handoff.agent', 'claude, then codex', root);

        expect(result.status).toBe(0);
        const parsed = parseProjectYamlShowingFile(root);
        expect(atKey(parsed, 'workflow.handoff.agent')).toBe('claude, then codex');
        expect(atKey(parsed, 'workflow.handoff.ack_turns')).toBe(5);
        // Both levels, because a value that escapes the inner mapping lands as
        // a key of the outer one, where `workflow.handoff` still reads back
        // whole and only the outer key set says anything is wrong.
        expect(keysAt(parsed, 'workflow.handoff')).toEqual(['ack_turns', 'agent']);
        expect(keysAt(parsed, 'workflow')).toEqual(['handoff']);
      });

      it('writes a bracket into a flow mapping that holds a flow sequence', () => {
        // The sibling is the one list-shaped key, stated in flow style, so a
        // `]` in the value has a real sequence to be confused with.
        const root = makeProject(
          'workflow: { handoff: { agent: claude, context_thresholds: [150000, 300000] } }\n'
        );

        const result = runSet('workflow.handoff.agent', 'claude] fallback', root);

        expect(result.status).toBe(0);
        const parsed = parseProjectYamlShowingFile(root);
        expect(atKey(parsed, 'workflow.handoff.agent')).toBe('claude] fallback');
        expect(atKey(parsed, 'workflow.handoff.context_thresholds')).toEqual([150000, 300000]);
        expect(keysAt(parsed, 'workflow.handoff')).toEqual(['agent', 'context_thresholds']);
      });

      it('writes a comma into a document that is one flow mapping from the first byte', () => {
        // Flow all the way up, so there is no block ancestor to fall back to
        // and the whole file is the collection the value has to stay inside.
        const root = makeProject(
          '{ profile: node-typescript, commands: { test: old, build: keep } }\n'
        );

        const result = runSet('commands.test', 'run a, then b', root);

        expect(result.status).toBe(0);
        const parsed = parseProjectYamlShowingFile(root);
        expect(atKey(parsed, 'commands.test')).toBe('run a, then b');
        expect(atKey(parsed, 'commands.build')).toBe('keep');
        expect(atKey(parsed, 'profile')).toBe('node-typescript');
        expect(keysAt(parsed, 'commands')).toEqual(['build', 'test']);
        // The root mapping too: a value that escapes `commands` lands as a
        // top-level key, which no assertion inside `commands` can see.
        expect(Object.keys(parsed as object).sort()).toEqual(['commands', 'profile']);
      });
    });
  });

  /**
   * File shapes the splice already gets right, pinned so a fix for the three
   * above cannot quietly trade one of them away. Every one of these passes
   * today; each is here as a regression guard, not as a new requirement.
   */
  describe('file shapes the splice already handles, and has to keep handling', () => {
    /** A two-key `commands` block, both values double-quoted. */
    const QUOTED_COMMANDS = [
      'commands:',
      '  test: "npm --prefix cli test"',
      '  build: "npm run build"',
      '',
    ].join('\n');

    it('replaces a double-quoted value and leaves its siblings quoted as they were', () => {
      const root = makeProject(QUOTED_COMMANDS);

      const result = runSet('commands.test', 'npm test', root);

      expect(result.status).toBe(0);
      const parsed = parseProjectYamlShowingFile(root);
      expect(atKey(parsed, 'commands.test')).toBe('npm test');
      expect(atKey(parsed, 'commands.build')).toBe('npm run build');
      expect(readProjectYaml(root)).toContain('  build: "npm run build"');
    });

    it('writes a value containing a # without the rest of the line becoming a comment', () => {
      const root = makeProject(QUOTED_COMMANDS);

      const result = runSet('commands.test', 'npm test # fast', root);

      expect(result.status).toBe(0);
      const parsed = parseProjectYamlShowingFile(root);
      expect(atKey(parsed, 'commands.test')).toBe('npm test # fast');
      expect(atKey(parsed, 'commands.build')).toBe('npm run build');
    });

    /** The same leaf name, `test`, stated at two different depths. */
    const SAME_LEAF_TWICE = [
      'commands:',
      '  test: "npm --prefix cli test"',
      'frontend:',
      '  commands:',
      '    test: "npm --prefix web test"',
      '',
    ].join('\n');

    it.each([
      ['commands.test', 'frontend.commands.test', 'npm --prefix web test'],
      ['frontend.commands.test', 'commands.test', 'npm --prefix cli test'],
    ])('writes %s and leaves %s alone', (target, other, otherValue) => {
      const root = makeProject(SAME_LEAF_TWICE);

      const result = runSet(target, 'echo written', root);

      expect(result.status).toBe(0);
      const parsed = parseProjectYamlShowingFile(root);
      expect(atKey(parsed, target)).toBe('echo written');
      expect(atKey(parsed, other)).toBe(otherValue);
    });

    it('leaves an anchor and the alias pointing at it resolving as they did', () => {
      const root = makeProject(
        [
          'commands:',
          '  test: &cli "npm --prefix cli test"',
          '  test_collect: *cli',
          '  build: "npm run build"',
          '',
        ].join('\n')
      );

      const result = runSet('commands.build', 'make build', root);

      expect(result.status).toBe(0);
      const parsed = parseProjectYamlShowingFile(root);
      expect(atKey(parsed, 'commands.build')).toBe('make build');
      expect(atKey(parsed, 'commands.test')).toBe('npm --prefix cli test');
      expect(atKey(parsed, 'commands.test_collect')).toBe('npm --prefix cli test');
    });

    it('keeps CRLF line endings on the lines around the one it rewrote', () => {
      const root = makeProject(QUOTED_COMMANDS.split('\n').join('\r\n'));

      const result = runSet('commands.test', 'npm test', root);

      expect(result.status).toBe(0);
      const parsed = parseProjectYamlShowingFile(root);
      expect(atKey(parsed, 'commands.test')).toBe('npm test');
      expect(atKey(parsed, 'commands.build')).toBe('npm run build');
      // A bare LF anywhere means the writer normalised the line endings of a
      // file it was asked to leave otherwise byte-identical.
      expect(readProjectYaml(root)).not.toMatch(/(?<!\r)\n/);
    });

    it('writes into a file that ends without a trailing newline', () => {
      const root = makeProject(
        'commands:\n  build: "npm run build"\n  test: "npm --prefix cli test"'
      );

      const result = runSet('commands.test', 'npm test', root);

      expect(result.status).toBe(0);
      const parsed = parseProjectYamlShowingFile(root);
      expect(atKey(parsed, 'commands.test')).toBe('npm test');
      expect(atKey(parsed, 'commands.build')).toBe('npm run build');
    });

    it('writes the right byte range when non-ASCII text sits earlier in the file', () => {
      // A byte range measured in bytes and applied to a JavaScript string
      // indexed in UTF-16 code units drifts by the width of everything above
      // it, so the multi-byte characters go before the key being written.
      const header = '# Réglages du projet 変更あり. Ne pas réécrire les commentaires.';
      const root = makeProject(
        [
          header,
          'profile: node-typescript',
          '',
          'commands:',
          '  lint: "ruff check café"',
          '  test: "npm --prefix cli test"',
          '',
        ].join('\n')
      );

      const result = runSet('commands.test', 'npm test', root);

      expect(result.status).toBe(0);
      const parsed = parseProjectYamlShowingFile(root);
      expect(atKey(parsed, 'commands.test')).toBe('npm test');
      expect(atKey(parsed, 'commands.lint')).toBe('ruff check café');
      expect(readProjectYaml(root)).toContain(header);
    });

    it('writes into a block indented by eight spaces, keeping that indent', () => {
      const root = makeProject(
        [
          'commands:',
          '        test: "npm --prefix cli test"',
          '        build: "npm run build"',
          '',
        ].join('\n')
      );

      const result = runSet('commands.test', 'npm test', root);

      expect(result.status).toBe(0);
      const parsed = parseProjectYamlShowingFile(root);
      expect(atKey(parsed, 'commands.test')).toBe('npm test');
      expect(atKey(parsed, 'commands.build')).toBe('npm run build');
      // Parsing alone would accept the key re-indented to two spaces along
      // with its whole block; the file has to still state it at eight.
      expect(readProjectYaml(root)).toMatch(/^ {8}test: /m);
    });
  });

  /**
   * A file that arrived with CRLF line endings, through every write that
   * cannot take the in-place splice.
   *
   * The splice leaves every byte it did not overwrite exactly as it was, so a
   * CRLF file keeps its line endings for free, and the test above pins that.
   * The other path re-emits the whole document through the YAML writer, which
   * emits LF - so setting one key rewrites the line ending of every line in
   * the file. That is a diff touching the whole file for a one-key change,
   * and a file whose line endings no longer match the rest of the checkout.
   *
   * Four shapes take that path, and each is a case below: a key the file does
   * not yet state (no old value whose range could be overwritten), a value
   * that spans lines (no one-line rendering to splice in), an existing block
   * scalar (the splice swallows the line break that ends it, so the write's
   * own check rejects what it built), and an existing empty value (a
   * zero-width range sitting flush against the colon).
   *
   * What none of these pin is HOW the file comes back otherwise. Re-emitting
   * the document requotes values and shortens the run of spaces before an
   * inline comment, and the reference already says so, so nothing here
   * asserts either.
   */
  describe('a fallback write keeps the line endings the file arrived with', () => {
    /** `lines`, written without endings for readability, joined with CRLF. */
    function crlf(lines: string[]): string {
      return lines.join('\r\n');
    }

    const CRLF_FALLBACK_CASES: [string, string[], string][] = [
      [
        'the file does not yet state the key',
        ['commands:', '  build: "npm run build"', ''],
        'npm test',
      ],
      [
        'the value spans lines',
        ['commands:', '  test: "npm --prefix cli test"', '  build: "npm run build"', ''],
        'line one\nline two',
      ],
      [
        'the old value is a block scalar',
        [
          'commands:',
          '  test: |',
          '    npm test &&',
          '    npm run lint',
          '  build: "npm run build"',
          '',
        ],
        'npm test',
      ],
      [
        'the old value is empty',
        ['commands:', '  test:', '  build: "npm run build"', ''],
        'npm test',
      ],
    ];

    it.each(CRLF_FALLBACK_CASES)('keeps CRLF throughout when %s', (_shape, lines, value) => {
      const root = makeProject(crlf(lines));

      const result = runSet('commands.test', value, root);

      expect(result.status).toBe(0);
      const parsed = parseProjectYamlShowingFile(root);
      expect(atKey(parsed, 'commands.test')).toBe(value);
      expect(atKey(parsed, 'commands.build')).toBe('npm run build');
      // A bare LF anywhere means the writer normalised the line endings of
      // the whole file in order to write one key - including every line it
      // never touched, and including any line break inside the value it
      // wrote, which a block scalar rendering puts in the file for real.
      expect(readProjectYaml(root)).not.toMatch(/(?<!\r)\n/);
    });
  });

  /**
   * A file that states BOTH line endings, through the same fallback write.
   *
   * The cases above are all-CRLF files, where "the endings the file arrived
   * with" has one answer. A file that mixes them has no single answer, and
   * mixed files are ordinary: a repository without a `.gitattributes` rule
   * collects them one hunk at a time, from one contributor on Windows and one
   * on Linux. Reading the FIRST line break and rewriting the whole file to
   * match answers with whichever editor happened to touch line one, which
   * turns a one-key write into a diff over every line of the smaller half.
   *
   * The rule below is the majority: the ending more of the file's lines
   * already use wins. A tie keeps LF, because LF is what the writer emits
   * when nothing in the file settles the question.
   *
   * Each fixture puts the MINORITY ending on line one, so a writer that
   * samples the first break gets the wrong answer on all three.
   */
  describe('a fallback write takes the line endings most of the file uses', () => {
    /** One LF, then two CRLF. */
    const MOSTLY_CRLF = 'commands:\n  build: "npm run build"\r\n  lint: "npm run lint"\r\n';

    /** One CRLF, then two LF. */
    const MOSTLY_LF = 'commands:\r\n  build: "npm run build"\n  lint: "npm run lint"\n';

    /** Two CRLF, then two LF - split evenly, with CRLF first. */
    const HALF_AND_HALF =
      'commands:\r\n  build: "npm run build"\r\n' +
      '  lint: "npm run lint"\n  typecheck: "npm run typecheck"\n';

    /**
     * Set a key the file does not yet state, which has no old value whose
     * range could be overwritten and so cannot take the in-place splice.
     */
    function setUnstatedKey(source: string): string {
      const root = makeProject(source);

      const result = runSet('commands.test', 'npm test', root);

      expect(result.status).toBe(0);
      const parsed = parseProjectYamlShowingFile(root);
      expect(atKey(parsed, 'commands.test')).toBe('npm test');
      expect(atKey(parsed, 'commands.build')).toBe('npm run build');
      return readProjectYaml(root);
    }

    it('re-emits CRLF when more of the file already ends its lines that way', () => {
      // A bare LF anywhere means the writer followed the single line that
      // disagreed with the rest of the file.
      expect(setUnstatedKey(MOSTLY_CRLF)).not.toMatch(/(?<!\r)\n/);
    });

    it('re-emits LF when more of the file already ends its lines that way', () => {
      // A CR anywhere means the same mistake pointing the other way: one
      // CRLF line on top dragged every LF line below it across.
      expect(setUnstatedKey(MOSTLY_LF)).not.toContain('\r');
    });

    it('re-emits LF when the file splits evenly between the two', () => {
      // Nothing in the file settles a tie, so the tie goes to the ending the
      // writer emits on its own rather than to whichever came first.
      expect(setUnstatedKey(HALF_AND_HALF)).not.toContain('\r');
    });
  });

  describe('a project with spechub/ but no project.yaml', () => {
    it('creates spechub/project.yaml holding the key it was given', () => {
      const root = projectWithoutYaml();

      const result = runSet('workflow.maps.tracker', 'files', root);

      expect(result.status).toBe(0);
      expect(existsSync(join(root, 'spechub', 'project.yaml'))).toBe(true);
      expect(atKey(parseProjectYaml(root), 'workflow.maps.tracker')).toBe('files');
    });
  });

  describe('boolean project keys', () => {
    // Every boolean key the reference documents, each set with a different
    // one of the six spellings the host axes accept, in one project. Read
    // once at the end, so the file also has to survive six writes in a row.
    const BOOLEAN_CASES: [string, string, boolean][] = [
      ['workflow.spec_sync', 'yes', true],
      ['workflow.tdd.strict', 'ON', true],
      ['workflow.tdd.orchestrator_strict', 'false', false],
      ['workflow.frontend_verification', 'no', false],
      ['workflow.maps.persist', 'true', true],
      ['workflow.handoff.self_invoke', 'OFF', false],
      ['workflow.design_review', 'yes', true],
    ];

    let text: string;
    let parsed: StoredProjectYaml;

    beforeAll(() => {
      const root = makeProject('name: boolean-project\n');
      for (const [key, raw] of BOOLEAN_CASES) {
        expect(runSet(key, raw, root).status).toBe(0);
      }
      text = readProjectYaml(root);
      parsed = parseProjectYaml(root);
    });

    it.each(BOOLEAN_CASES)('stores %s written as "%s" as the boolean %s', (key, _raw, expected) => {
      expect(atKey(parsed, key)).toBe(expected);
    });

    it('writes the booleans as YAML booleans, not as the words the user typed', () => {
      // `yes`, `ON` and `OFF` all parse back as booleans under YAML 1.1, so
      // the parsed assertions above would pass even if the raw spelling were
      // written straight through. The file itself has to say true or false.
      expect(text).toMatch(/spec_sync:\s*true\s*$/m);
      expect(text).toMatch(/self_invoke:\s*false\s*$/m);
      expect(text).not.toMatch(/\bON\b|\bOFF\b/);
      expect(text).not.toMatch(/:\s*(yes|no)\s*$/im);
    });

    it('rejects a non-boolean value for a boolean key with exit 1, naming the boolean form', () => {
      const result = runSet('workflow.spec_sync', 'sometimes', makeProject('name: bool-reject\n'));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('boolean');
      expect(result.stderr).toContain('true');
      expect(result.stderr).toContain('false');
    });
  });

  describe('workflow.design_review, the key that turns the design gate on', () => {
    // A boolean like every other boolean, and pinned separately because it is
    // the newest one: a key the schema half-knows would still pass the shared
    // arrangement above, which writes six keys before it reads any of them.
    it.each([
      ['yes', 'true'],
      ['no', 'false'],
      ['true', 'true'],
      ['false', 'false'],
      ['ON', 'true'],
      ['OFF', 'false'],
    ])('takes "%s" and reads back as %s', (raw, expected) => {
      const root = makeProject('name: design-review-project\n');

      expect(runSet('workflow.design_review', raw, root).status).toBe(0);

      const read = runGet('workflow.design_review', root);
      expect(read.status).toBe(0);
      expect(read.stdout.trim()).toBe(expected);
    });

    it('writes a YAML boolean under workflow, not the word the user typed', () => {
      const root = makeProject('name: design-review-project\n');

      expect(runSet('workflow.design_review', 'yes', root).status).toBe(0);

      expect(atKey(parseProjectYaml(root), 'workflow.design_review')).toBe(true);
      expect(readProjectYaml(root)).toMatch(/design_review:\s*true\s*$/m);
    });

    it('rejects a non-boolean value with exit 1, the way every boolean key does', () => {
      const result = runSet(
        'workflow.design_review',
        'sometimes',
        makeProject('name: design-review-reject\n')
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('boolean');
    });
  });

  describe('enumerated project keys', () => {
    const ENUM_CASES: [string, string][] = [
      ['workflow.grilling.questions', 'inline'],
      ['workflow.maps.tracker', 'github'],
      ['frontend.browser.mode', 'headless'],
      ['frontend.browser.fallback', 'none'],
    ];

    let parsed: StoredProjectYaml;

    beforeAll(() => {
      // No `frontend` block in the fixture, so the two browser keys also pin
      // that a set creates the blocks above the key it was given.
      const root = makeProject('name: enum-project\n');
      for (const [key, value] of ENUM_CASES) {
        expect(runSet(key, value, root).status).toBe(0);
      }
      parsed = parseProjectYaml(root);
    });

    it.each(ENUM_CASES)('stores the allowed value %s = %s', (key, value) => {
      expect(atKey(parsed, key)).toBe(value);
    });

    const ENUM_REJECT_CASES: [string, string[]][] = [
      ['workflow.grilling.questions', ['tool', 'inline']],
      ['workflow.maps.tracker', ['github', 'files']],
      ['frontend.browser.mode', ['remote', 'headless', 'local']],
      ['frontend.browser.fallback', ['none']],
    ];

    it.each(ENUM_REJECT_CASES)(
      'rejects a value outside the set for %s and names the set',
      (key, allowed) => {
        const result = runSet(key, 'nonesuch-value', makeProject('name: enum-reject\n'));

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(key);
        for (const value of allowed) {
          expect(result.stderr).toContain(value);
        }
      }
    );
  });

  describe('numeric project keys', () => {
    let parsed: StoredProjectYaml;

    beforeAll(() => {
      const root = makeProject('name: number-project\n');
      expect(runSet('workflow.handoff.ack_turns', '8', root).status).toBe(0);
      expect(runSet('frontend.browser.cdp_port', '19988', root).status).toBe(0);
      parsed = parseProjectYaml(root);
    });

    const NUMBER_CASES: [string, number][] = [
      ['workflow.handoff.ack_turns', 8],
      ['frontend.browser.cdp_port', 19988],
    ];

    it.each(NUMBER_CASES)('stores %s as the number %s, not as a string', (key, expected) => {
      expect(atKey(parsed, key)).toBe(expected);
    });

    it('rejects a non-number for a numeric key with exit 1, saying a number is wanted', () => {
      const result = runSet(
        'workflow.handoff.nudge_warn',
        'soon',
        makeProject('name: number-reject\n')
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('workflow.handoff.nudge_warn');
      expect(result.stderr).toMatch(/number/i);
    });
  });

  describe('workflow.handoff.context_thresholds, the one list-shaped key', () => {
    /** The parsed `context_thresholds` after setting it to `raw` in a fresh project. */
    function setThresholds(raw: string): unknown {
      const root = makeProject('name: thresholds-project\n');
      expect(runSet('workflow.handoff.context_thresholds', raw, root).status).toBe(0);
      return atKey(parseProjectYaml(root), 'workflow.handoff.context_thresholds');
    }

    it('stores a comma-separated list of token counts as a list of numbers', () => {
      expect(setThresholds('150000,300000')).toEqual([150000, 300000]);
    });

    it('stores a comma-separated list of percentages as a list of strings, percent sign kept', () => {
      // The hook reads a percentage as a string and resolves it against the
      // context window; a bare 40 would be forty tokens, not forty percent.
      expect(setThresholds('40%,70%')).toEqual(['40%', '70%']);
    });

    it('accepts the YAML flow spelling the reference gives, brackets and all', () => {
      expect(setThresholds('[150000, 300000]')).toEqual([150000, 300000]);
    });

    it('rejects an entry that is neither a number nor a percentage with exit 1', () => {
      const result = runSet(
        'workflow.handoff.context_thresholds',
        'soon,later',
        makeProject('name: thresholds-reject\n')
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/number/i);
      expect(result.stderr).toMatch(/percentage|percent|%/i);
    });
  });

  describe('a rejected value writes nothing at all', () => {
    it('leaves spechub/project.yaml byte-identical after a value the schema refuses', () => {
      const root = makeProject(HAND_EDITED_PROJECT);
      const before = readProjectYaml(root);

      const result = runSet('workflow.grilling.questions', 'nonesuch-value', root);

      expect(result.status).toBe(1);
      // Not "the key is unchanged" but "the file is unchanged": a write that
      // rejected the value after rewriting the file would still have cost the
      // user their comments.
      expect(readProjectYaml(root)).toBe(before);
    });
  });

  describe('a key written here reaches the thing that reads it', () => {
    it('turns the domain-map row informational once workflow.spec_sync is set to false', () => {
      // The round trip that matters: `config set` writes the file, and the
      // reader is a separate process reading it back off disk. A project with
      // no domain map fails that row until spec sync goes off.
      const cwd = makeProject('name: round-trip-project\n');
      expect(runSet('workflow.spec_sync', 'false', cwd).status).toBe(0);

      const result = runCheck({ cwd, path: [emptyPathDir()], json: true });

      expect(checkJsonRow(result.stdout, CHECK_ROW_IDS.domainMap)?.status).toBe('info');
      expect(result.status).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------
// project.yaml shapes a write has to survive
//
// Every test above hands `config set` a file whose blocks are blocks and
// whose bytes decode. These hand it the files a user actually ends up with: a
// key holding a value where the path wants to descend, a block emptied to
// null, a document marker with nothing under it, a byte that is not UTF-8, a
// file the process may not write.
//
// None of these is exotic and one of them the tool writes itself - `config
// unset` on the last key of a block leaves exactly the file `config set` then
// cannot write into. What they share is the shape of the failure: the command
// either ends the process with a library's stack trace, or changes bytes it
// was never asked to touch and reports success. Both are the same bug seen
// from two sides - a file shape nobody decided what to do about.
//
// So each block below pins the decision rather than the mechanism: which of
// these the command has to handle, which it has to refuse, and what a refusal
// has to say and leave behind.
// ---------------------------------------------------------------------

describe('spechub config set when the path descends through a value', () => {
  /**
   * A key stating a value where the path expects a block, per case: the key
   * to set, the key standing in the way, and the file that arranges it.
   *
   * This is not a spelling the schema can refuse. `workflow` is a real block
   * name and `spec_sync` is a real key under it, so the key is known and the
   * value is valid; the file is what makes the write impossible. Nothing can
   * be written without overwriting the value already there, which is the
   * user's data and not the command's to discard - so the answer is to refuse
   * and say which key is in the way.
   */
  const SCALAR_ON_THE_PATH: [string, string, string][] = [
    ['workflow.spec_sync', 'workflow', 'workflow: fast\n'],
    ['workflow.tdd.strict', 'workflow.tdd', 'workflow:\n  tdd: strict\n'],
    ['commands.test', 'commands', 'profile: node-typescript\ncommands: "npm test"\n'],
  ];

  it.each(SCALAR_ON_THE_PATH)(
    'refuses to set %s while %s holds a value, naming that key',
    (key, blocked, yaml) => {
      const root = makeProject(yaml);

      const result = runSet(key, 'true', root);

      expect(result.status).toBe(1);
      // The whole point of the case. `doc.setIn` throws a plain Error, which
      // the command's error reporter re-throws, so today this prints the
      // library's frames and the user never learns which key to fix.
      expectNoStackTrace(result);
      // Named by its full dotted path, the way the user would type it: the
      // leaf alone ("tdd") does not say where in the file to look.
      expect(result.stderr).toContain(blocked);
      expect(result.stderr).toMatch(/value|scalar/i);
      expect(result.stderr).toMatch(/block|mapping|section/i);
    }
  );

  it.each(SCALAR_ON_THE_PATH)(
    'leaves the file byte-identical when %s is refused because of %s',
    (key, _blocked, yaml) => {
      const root = makeProject(yaml);
      const before = readProjectYaml(root);

      const result = runSet(key, 'true', root);

      expect(result.status).toBe(1);
      // A refusal is not a write. The value in the way is the user's, and a
      // command that half-rewrote the file on its way out would cost them
      // their formatting to tell them it did nothing.
      expect(readProjectYaml(root)).toBe(before);
      expect(existsSync(result.globalConfigFile)).toBe(false);
    }
  );
});

/**
 * A block `config unset` emptied still takes a `config set`.
 *
 * This is the tool breaking its own file. `config unset` on the last key of a
 * block deliberately leaves the block's key with nothing after the colon,
 * because that is what the in-place splice produces and the document writer
 * is brought into line with it. That parses as null. `config set` then walks
 * that same path, finds null where it wants a mapping, and crashes - so two
 * of the tool's own commands, run in order, leave the user stuck.
 *
 * Null intermediate and empty block are the same state as far as every reader
 * is concerned: both read as the block stating nothing. A write has to treat
 * them the same way too.
 */
describe('spechub config set into a block left empty', () => {
  it('sets a deeper key under the block whose last key config unset removed', () => {
    const root = makeProject('profile: node-typescript\nworkflow:\n  spec_sync: true\n');

    const removed = runUnset('workflow.spec_sync', root);
    expect(removed.status).toBe(0);
    // The state the removal leaves behind, stated as its own assertion so the
    // sequence cannot pass because the removal quietly stopped doing this.
    expect(atKey(parseProjectYaml(root), 'workflow')).toBeNull();

    const result = runSet('workflow.tdd.strict', 'true', root);

    expect(result.status).toBe(0);
    expectNoStackTrace(result);
    const parsed = parseProjectYamlShowingFile(root);
    expect(atKey(parsed, 'workflow.tdd.strict')).toBe(true);
    expect(atKey(parsed, 'profile')).toBe('node-typescript');
    // Both, in the file's own text: the block that was emptied and the key now
    // under it. The data assertion above is satisfied by a file that dropped
    // the emptied block and started a fresh one somewhere else, which is a
    // different file from the one the user had.
    const text = readProjectYaml(root);
    expect(text).toMatch(/^workflow:\s*$/m);
    expect(text).toMatch(/^\s+strict: true\s*$/m);
  });

  it('sets the same key back after config unset emptied the block that held it', () => {
    const root = makeProject('workflow:\n  tdd:\n    strict: true\n');

    expect(runUnset('workflow.tdd.strict', root).status).toBe(0);

    const result = runSet('workflow.tdd.strict', 'false', root);

    expect(result.status).toBe(0);
    expectNoStackTrace(result);
    // Set, removed, set again is the shortest sequence a user runs by
    // accident: change your mind, change it back.
    expect(atKey(parseProjectYamlShowingFile(root), 'workflow.tdd.strict')).toBe(false);
  });

  it.each([
    ['a key with nothing after the colon', 'workflow:\nprofile: node-typescript\n'],
    ['an explicit null', 'workflow: null\nprofile: node-typescript\n'],
    ['a tilde', 'workflow: ~\nprofile: node-typescript\n'],
  ])('treats %s as an empty block and writes the key under it', (_case, yaml) => {
    const root = makeProject(yaml);

    const result = runSet('workflow.spec_sync', 'false', root);

    expect(result.status).toBe(0);
    expectNoStackTrace(result);
    const parsed = parseProjectYamlShowingFile(root);
    expect(atKey(parsed, 'workflow.spec_sync')).toBe(false);
    expect(atKey(parsed, 'profile')).toBe('node-typescript');
  });
});

/**
 * A file stating no data at all is a file to write into, not a file to refuse.
 *
 * An empty project.yaml already works, and a file holding only a comment
 * works. A file holding only `---` does not, which is a distinction with
 * nothing behind it: all three state no data, and the document marker is a
 * line YAML tooling and hand-editing both leave lying around.
 */
describe('spechub config set into a document stating nothing', () => {
  it.each([
    ['a document marker alone', '---\n'],
    ['a document marker over a comment', '---\n# nothing set yet\n'],
    // The two that already work, kept beside them: a fix for the marker has
    // to keep handling the shapes that never broke.
    ['an empty file', ''],
    ['a comment alone', '# nothing set yet\n'],
  ])('writes the key into %s', (_case, body) => {
    const root = makeProject(body);

    const result = runSet('workflow.spec_sync', 'false', root);

    expect(result.status).toBe(0);
    expectNoStackTrace(result);
    expect(atKey(parseProjectYamlShowingFile(root), 'workflow.spec_sync')).toBe(false);
  });
});

/**
 * A file whose bytes are not UTF-8 is refused, not silently rewritten.
 *
 * Every read here decodes as UTF-8, and an undecodable byte decodes to U+FFFD
 * rather than failing - so a write re-emits the document with the replacement
 * character in place of the byte, and reports success. The corruption is in
 * bytes the write was never asked to touch, in a file the user hand-edited,
 * with nothing said about it.
 *
 * Refusing is the only safe answer available: the command cannot re-encode
 * what it could not decode, and it must not write a file it has already
 * damaged in memory. The user's own editor is where the encoding gets fixed.
 */
describe('spechub config set on a file that is not valid UTF-8', () => {
  /**
   * A project.yaml whose comment holds `é` as the single latin-1 byte 0xE9.
   *
   * Assembled as a Buffer rather than written as a string: node encodes a
   * string as UTF-8 on the way to disk, so `0xE9` written as a character
   * arrives as the two bytes `0xC3 0xA9` and the file is valid UTF-8 after
   * all - the fixture has to put the byte itself on disk.
   */
  const LATIN1_PROJECT = Buffer.concat([
    Buffer.from('# caf', 'utf-8'),
    Buffer.from([0xe9]),
    Buffer.from(' notes, hand-edited\nworkflow:\n  spec_sync: true\n', 'utf-8'),
  ]);

  /** The UTF-8 encoding of U+FFFD, what a lossy decode leaves in the byte's place. */
  const REPLACEMENT_CHARACTER = Buffer.from([0xef, 0xbf, 0xbd]);

  let root: string;
  let result: ReturnType<typeof runSet>;

  beforeAll(() => {
    root = makeProject('# replaced below\n');
    writeProjectYamlBytes(root, LATIN1_PROJECT);
    result = runSet('workflow.tdd.strict', 'false', root);
  });

  it('refuses with exit 1, saying the file is not valid UTF-8', () => {
    expect(result.status).toBe(1);
    expectNoStackTrace(result);
    expect(result.stderr).toMatch(/UTF-?8/i);
    expect(result.stderr).toContain(join(root, 'spechub', 'project.yaml'));
  });

  it('leaves the file byte-identical, the undecodable byte included', () => {
    // Bytes, not text: a decoded read cannot tell a byte that survived from a
    // byte that was replaced, because it renders both as U+FFFD.
    expect(readProjectYamlBytes(root).equals(LATIN1_PROJECT)).toBe(true);
  });

  it('does not put the replacement character in the byte\'s place', () => {
    // The corruption itself, named on its own. Byte-identity above covers it,
    // but this is the assertion that says what went wrong when it fails.
    expect(readProjectYamlBytes(root).includes(REPLACEMENT_CHARACTER)).toBe(false);
  });

  it('does not write the key it was asked to set', () => {
    expect(atKey(parseProjectYaml(root), 'workflow.tdd.strict')).toBeUndefined();
    expect(existsSync(result.globalConfigFile)).toBe(false);
  });
});

/**
 * A file the process may not write is reported, not crashed on.
 *
 * A read-only project.yaml is an ordinary thing to meet - a checkout on a
 * locked-down machine, a file someone chmodded to stop themselves editing it -
 * and the user can act on it the moment they are told which file and why.
 * `writeFileSync` throwing EACCES tells them instead that node's fs module
 * has a line 2430.
 */
describe('spechub config set on a file it may not write', () => {
  // Root ignores the mode bits, so there is nothing to arrange under it.
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(asRoot)('refuses with exit 1, naming the file and the reason', () => {
    const root = makeProject(HAND_EDITED_PROJECT);
    const before = readProjectYaml(root);
    const file = join(root, 'spechub', 'project.yaml');
    chmodSync(file, 0o444);

    try {
      const result = runSet('workflow.tdd.strict', 'false', root);

      expect(result.status).toBe(1);
      expectNoStackTrace(result);
      expect(result.stderr).toContain(file);
      expect(result.stderr).toMatch(/permission|read-only|not writable|could not write|cannot write/i);
      expect(readProjectYaml(root)).toBe(before);
    } finally {
      chmodSync(file, 0o644);
    }
  });
});

/**
 * A value the file cannot be made to hold is refused, not written and called
 * a success.
 *
 * ADR 0009 made the splice verify its own result against the document
 * interface, because the splice was the half getting it wrong. The document
 * interface was the baseline it compared against, and nothing checks the
 * baseline. This is the shape where the baseline is the one that is wrong.
 *
 * Replacing a block scalar with a value of only spaces keeps the old node's
 * block style, and the emitter writes a content line holding nothing but
 * spaces. No parser reads that back as spaces - it comes back as the empty
 * string. So the splice refuses the write, correctly, hands off to the
 * document interface, and the document interface loses the value behind a
 * green "Set commands.test" and exit 0.
 *
 * The rule the tests below state is about the RESULT, not about either
 * writer: nothing lands whose re-read value differs from what was asked for.
 * Where no writer can produce such a file, the command refuses - exit 1, the
 * file untouched, and one line naming the key.
 */
describe('spechub config set when no writer can produce the value asked for', () => {
  /**
   * `commands` stating `test` as a block scalar of `style`, with `lint` after
   * it - the shape the corruption needs. The sibling matters: it is what keeps
   * the block scalar's content indented, and the space-only line the emitter
   * writes has to sit inside that indent.
   */
  function blockScalarWithSibling(style: string): string {
    return [
      'commands:',
      `  test: ${style}`,
      '    line one',
      '    line two',
      '  lint: eslint',
      '',
    ].join('\n');
  }

  /** The same block scalar with nothing after it, so it ends the file. */
  function blockScalarAtTheEnd(style: string): string {
    return [
      'commands:',
      '  lint: eslint',
      `  test: ${style}`,
      '    line one',
      '    line two',
      '',
    ].join('\n');
  }

  /**
   * The cases no writer can take: a block scalar with a sibling after it,
   * replaced by spaces. Named, then the style, then the value, because `%s`
   * renders a value of spaces as nothing at all.
   */
  const REFUSED: [string, string, string][] = [
    ['one space over a literal block scalar', '|', ' '],
    ['two spaces over a literal block scalar', '|', '  '],
    ['one space over a folded block scalar', '>', ' '],
    ['two spaces over a folded block scalar', '>', '  '],
  ];

  it.each(REFUSED)('refuses %s, with no success line anywhere', (_case, style, value) => {
    const root = makeProject(blockScalarWithSibling(style));

    const result = runSet('commands.test', value, root);

    expect(result.status).toBe(1);
    expectNoStackTrace(result);
    // The bug seen from the user's side: a green line saying the value was
    // set, over a file that no longer holds it.
    expect(result.stdout + result.stderr).not.toContain('Set commands.test');
  });

  it.each(REFUSED)(
    'leaves the file byte-identical when it refuses %s',
    (_case, style, value) => {
      const root = makeProject(blockScalarWithSibling(style));
      const before = readProjectYaml(root);
      // Read from the file the test wrote, not typed out here: a literal and a
      // folded scalar of the same lines hold different strings, and restating
      // either of them would be this test claiming to know YAML's rules.
      const untouched = atKey(parseYaml(before), 'commands.test');

      const result = runSet('commands.test', value, root);

      expect(result.status).toBe(1);
      expect(readProjectYaml(root)).toBe(before);
      // Stated separately from the bytes: this is the value that went missing,
      // and it is what the failure output should say when a fix half-works.
      expect(atKey(parseProjectYamlShowingFile(root), 'commands.test')).toBe(untouched);
      expect(atKey(parseProjectYamlShowingFile(root), 'commands.lint')).toBe('eslint');
      expect(existsSync(result.globalConfigFile)).toBe(false);
    }
  );

  it.each(REFUSED)('says in one line which key it could not write, refusing %s', (_case, style, value) => {
    const root = makeProject(blockScalarWithSibling(style));

    const result = runSet('commands.test', value, root);

    // One line, because a refusal the user can act on is a sentence, and a
    // stack trace or a dump of the document is neither readable nor theirs.
    const lines = result.stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('commands.test');
    expect(lines[0]).toMatch(/cannot|could not|unable|refus/i);
    expect(lines[0]).toMatch(/safe|safely|read back|reads back|round-?trip/i);
  });

  /**
   * The neighbours the refusal must NOT swallow.
   *
   * The same value in the same style writes correctly when the block scalar
   * ends the file, and every ordinary value writes correctly either way. A
   * refusal that covers these is a refusal of block scalars, which is a
   * different and worse command.
   */
  const STILL_WRITTEN: [string, string, string][] = [
    ['one space over a literal block scalar', '|', ' '],
    ['two spaces over a literal block scalar', '|', '  '],
    ['one space over a folded block scalar', '>', ' '],
    ['two spaces over a folded block scalar', '>', '  '],
  ];

  it.each(STILL_WRITTEN)(
    'still writes %s when that block scalar ends the file',
    (_case, style, value) => {
      const root = makeProject(blockScalarAtTheEnd(style));

      const result = runSet('commands.test', value, root);

      expect(result.status).toBe(0);
      expectNoStackTrace(result);
      expect(atKey(parseProjectYamlShowingFile(root), 'commands.test')).toBe(value);
      expect(atKey(parseProjectYamlShowingFile(root), 'commands.lint')).toBe('eslint');
    }
  );

  it.each(['|', '>'])(
    'still writes an ordinary value over a %s block scalar with a sibling after it',
    (style) => {
      const root = makeProject(blockScalarWithSibling(style));

      const result = runSet('commands.test', 'npm test', root);

      expect(result.status).toBe(0);
      expectNoStackTrace(result);
      expect(atKey(parseProjectYamlShowingFile(root), 'commands.test')).toBe('npm test');
      expect(atKey(parseProjectYamlShowingFile(root), 'commands.lint')).toBe('eslint');
    }
  );

  it.each(['|', '>'])(
    'still writes an empty value over a %s block scalar with a sibling after it',
    (style) => {
      // The value that LOOKS like the refused one and is not: an empty string
      // asked for is an empty string read back, so the write is honest and
      // has to go through.
      const root = makeProject(blockScalarWithSibling(style));

      const result = runSet('commands.test', '', root);

      expect(result.status).toBe(0);
      expectNoStackTrace(result);
      expect(atKey(parseProjectYamlShowingFile(root), 'commands.test')).toBe('');
      expect(atKey(parseProjectYamlShowingFile(root), 'commands.lint')).toBe('eslint');
    }
  );
});

/**
 * A project.yaml whose whole document is not a mapping is reported, not
 * crashed on.
 *
 * The walk down to the key settles a null, a value or a list at every depth
 * ABOVE the leaf, and never asks what the document itself is. So a file
 * holding one scalar, or one list, reaches the document interface as a
 * document with no keys to set - and the library throws its own sentence out
 * of the bundle, with the frames to match.
 *
 * Neither file is exotic. A truncated write, a paste into the wrong file, a
 * project.yaml someone started as a list of commands: each leaves a file the
 * user can fix in a second once they are told which file and what is wrong
 * with it.
 *
 * `config unset` already answers both correctly, so it is pinned here beside
 * them - the fix belongs on the write path and must not reach across.
 */
describe('spechub config set on a document that is not a mapping', () => {
  const NOT_A_MAPPING: [string, string][] = [
    ['a scalar', 'hello\n'],
    ['a list', '- one\n- two\n'],
  ];

  it.each(NOT_A_MAPPING)(
    'refuses with exit 1 and no stack trace when the document is %s',
    (_case, body) => {
      const root = makeProject(body);

      const result = runSet('workflow.spec_sync', 'true', root);

      expect(result.status).toBe(1);
      // The whole case. Today the library's Error goes uncaught, so the user
      // reads a bundled line number instead of a sentence about their file.
      expectNoStackTrace(result);
    }
  );

  it.each(NOT_A_MAPPING)('names the file and the problem in one line when the document is %s', (_case, body) => {
    const root = makeProject(body);

    const result = runSet('workflow.spec_sync', 'true', root);

    const lines = result.stderr.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(join(root, 'spechub', 'project.yaml'));
    expect(lines[0]).toMatch(/mapping|block|keys|collection|section/i);
  });

  it.each(NOT_A_MAPPING)('leaves the file byte-identical when the document is %s', (_case, body) => {
    const root = makeProject(body);
    const before = readProjectYaml(root);

    const result = runSet('workflow.spec_sync', 'true', root);

    expect(result.status).toBe(1);
    expect(readProjectYaml(root)).toBe(before);
    expect(existsSync(result.globalConfigFile)).toBe(false);
  });

  it.each(NOT_A_MAPPING)(
    'still reports the key was not set, leaving the file alone, when unset meets %s',
    (_case, body) => {
      const root = makeProject(body);
      const before = readProjectYaml(root);

      const result = runUnset('workflow.spec_sync', root);

      expect(result.status).toBe(0);
      expectNoStackTrace(result);
      expect(result.stdout).toContain('was not set');
      expect(readProjectYaml(root)).toBe(before);
    }
  );
});

/**
 * A byte-order mark the file arrived with is still there afterwards.
 *
 * A leading U+FEFF is not content. It is a mark an editor put at the front of
 * the file to say how the rest is encoded, and Windows editors write one
 * without being asked. Dropping it changes byte 0 of a file the user only
 * asked to set one key in, and every other tool that reads the file reads a
 * different first byte from then on. Inventing one is the same mistake
 * pointing the other way, and puts a stray character in front of a document
 * that was fine.
 *
 * Both write paths are pinned, because they meet the mark differently. The
 * splice carries byte 0 across untouched and keeps it for free. The re-emit
 * builds its text from the parsed document, which never held the mark at all.
 */
describe('spechub config set and unset, a leading byte-order mark', () => {
  /** U+FEFF, the mark itself. A UTF-8 read decodes its three bytes to this. */
  const BOM = '﻿';

  it('survives a splice write, which overwrites one value in place', () => {
    const root = makeProject(BOM + HAND_EDITED_PROJECT);

    const result = runSet('commands.test', 'npm test', root);

    expect(result.status).toBe(0);
    expect(readProjectYaml(root).startsWith(BOM)).toBe(true);
    expect(atKey(parseProjectYamlShowingFile(root), 'commands.test')).toBe('npm test');
  });

  it('survives a fallback write, which re-emits the whole document', () => {
    // `commands.lint` is a key this fixture does not state, so there is no
    // old value whose range could be overwritten and the write re-emits.
    const root = makeProject(BOM + HAND_EDITED_PROJECT);

    const result = runSet('commands.lint', 'npm run lint', root);

    expect(result.status).toBe(0);
    expect(readProjectYaml(root).startsWith(BOM)).toBe(true);
    const parsed = parseProjectYamlShowingFile(root);
    expect(atKey(parsed, 'commands.lint')).toBe('npm run lint');
    expect(atKey(parsed, 'commands.test')).toBe('npm --prefix cli test');
  });

  it('survives an unset that re-emits the whole document', () => {
    // Removing one entry of a flow mapping cannot be done by deleting a line,
    // so this removal takes the re-emitting path rather than the in-place one.
    const root = makeProject(
      BOM + 'commands: { test: "npm --prefix cli test", build: "npm run build" }\n'
    );

    const result = runUnset('commands.test', root);

    expect(result.status).toBe(0);
    expect(readProjectYaml(root).startsWith(BOM)).toBe(true);
    const parsed = parseProjectYamlShowingFile(root);
    expect(atKey(parsed, 'commands.test')).toBeUndefined();
    expect(atKey(parsed, 'commands.build')).toBe('npm run build');
  });

  it('is not invented on a file that never had one', () => {
    const root = makeProject(HAND_EDITED_PROJECT);

    const result = runSet('commands.lint', 'npm run lint', root);

    expect(result.status).toBe(0);
    // Anywhere in the file, not only at the front: a mark that is not byte 0
    // is not a mark at all, just a stray character sitting in the document.
    expect(readProjectYaml(root)).not.toContain(BOM);
  });
});

/**
 * The write replaces project.yaml rather than emptying it and filling it in.
 *
 * `writeFileSync` truncates first and writes second, so a process killed
 * between the two leaves a project.yaml of zero bytes - the user's comments,
 * their formatting and every key they had set gone, with no copy anywhere to
 * put back. Writing a temp file beside it and renaming over the target means
 * the file on disk is only ever the whole old one or the whole new one.
 *
 * Beside it, not elsewhere: a rename across filesystems is not a rename, it
 * is a copy and a delete, which is the truncating write again under another
 * name. So the temp file belongs in `spechub/`.
 *
 * The two things a temp-and-rename breaks if it is written carelessly get
 * their own tests below - the mode of the file it replaces, and the refusal
 * to write a file the user made read-only.
 */
describe('spechub config set replaces spechub/project.yaml atomically', () => {
  // Root ignores the mode bits, so the read-only case has nothing to arrange.
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  /** Everything `spechub/` holds after the write, sorted. */
  function spechubDirEntries(root: string): string[] {
    return readdirSync(join(root, 'spechub')).sort();
  }

  it('puts a different file in place, rather than rewriting the one it was given', () => {
    const root = makeProject(HAND_EDITED_PROJECT);
    const file = join(root, 'spechub', 'project.yaml');
    const before = statSync(file).ino;

    const result = runSet('workflow.tdd.strict', 'false', root);

    expect(result.status).toBe(0);
    // The inode is the evidence, and the only evidence a test can collect
    // without racing the write: truncating keeps the file it was handed, and
    // renaming puts a file that was built elsewhere in its place.
    expect(statSync(file).ino).not.toBe(before);
    expect(atKey(parseProjectYamlShowingFile(root), 'workflow.tdd.strict')).toBe(false);
  });

  it('leaves no temp file behind in spechub/ after the write lands', () => {
    const root = makeProject(HAND_EDITED_PROJECT);

    const result = runSet('workflow.tdd.strict', 'false', root);

    expect(result.status).toBe(0);
    // A half-written file the user has to find and delete themselves is its
    // own bug, and one that shows up in their next `git status`.
    expect(spechubDirEntries(root)).toEqual(['project.yaml']);
  });

  it('keeps the permission mode the file already had', () => {
    const root = makeProject(HAND_EDITED_PROJECT);
    const file = join(root, 'spechub', 'project.yaml');
    chmodSync(file, 0o640);

    const result = runSet('workflow.tdd.strict', 'false', root);

    expect(result.status).toBe(0);
    // A temp file is created with whatever the process umask gives it, not
    // with the mode of the file it is about to replace. Renaming one over a
    // 0o640 project.yaml silently changes who on the machine can read it.
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  it.skipIf(asRoot)('still refuses a read-only file, and leaves no temp file behind', () => {
    const root = makeProject(HAND_EDITED_PROJECT);
    const file = join(root, 'spechub', 'project.yaml');
    const before = readProjectYaml(root);
    chmodSync(file, 0o444);

    try {
      const result = runSet('workflow.tdd.strict', 'false', root);

      // Renaming over a read-only file SUCCEEDS whenever the directory allows
      // it, because the mode being checked is the directory's. So a write
      // that only tries and reports what happened turns this refusal into a
      // silent write of a file the user locked on purpose - and the check has
      // to happen before the temp file is built, not after.
      expect(result.status).toBe(1);
      expectNoStackTrace(result);
      expect(result.stderr).toContain(file);
      expect(readProjectYaml(root)).toBe(before);
      expect(spechubDirEntries(root)).toEqual(['project.yaml']);
      expect(statSync(file).mode & 0o777).toBe(0o444);
    } finally {
      chmodSync(file, 0o644);
    }
  });
});

/**
 * A write into a symlinked project.yaml follows the link.
 *
 * `spechub/project.yaml` is a symlink whenever one file is shared between
 * checkouts - kept in a dotfiles directory, or in the main clone with every
 * worktree linking to it. The link is the only path any command here is
 * handed, and the file behind it is the one that is edited and tracked.
 *
 * Writing a temp file beside the link and renaming over it replaces the LINK.
 * The user is left with a regular file where their link was, holding the new
 * value, and the real file still holding the old one - so the thing that
 * reads the config keeps reading the value the user just changed, and the
 * command that did it exited 0 with a green line saying it had worked. Every
 * assertion here is therefore about both ends: the link is still a link, and
 * the file behind it holds the new value.
 *
 * Both write paths are pinned, because they build their text differently and
 * a fix applied to one is not applied to the other. `unset` too - it writes
 * the same way, and losing a link there costs the same.
 */
describe('spechub config set and unset through a symlinked spechub/project.yaml', () => {
  /** The project the link points at, parsed. Never read through the link. */
  function parseTarget(target: string): unknown {
    return parseYaml(readFileSync(target, 'utf-8'));
  }

  it('writes through the link on the splice path, which overwrites one value in place', () => {
    const { root, link, target } = makeSymlinkedProject(HAND_EDITED_PROJECT);

    const result = runSet('commands.test', 'vitest run', root);

    expect(result.status).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(atKey(parseTarget(target), 'commands.test')).toBe('vitest run');
  });

  it('writes through the link on the fallback path, which re-emits the whole document', () => {
    // `commands.lint` is a key this fixture does not state, so there is no
    // old value whose range could be overwritten and the write re-emits.
    const { root, link, target } = makeSymlinkedProject(HAND_EDITED_PROJECT);

    const result = runSet('commands.lint', 'npm run lint', root);

    expect(result.status).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const parsed = parseTarget(target);
    expect(atKey(parsed, 'commands.lint')).toBe('npm run lint');
    expect(atKey(parsed, 'commands.test')).toBe('npm --prefix cli test');
  });

  it('removes a key through the link, deleting the line the file states it on', () => {
    const { root, link, target } = makeSymlinkedProject(HAND_EDITED_PROJECT);

    const result = runUnset('workflow.tdd.strict', root);

    expect(result.status).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const parsed = parseTarget(target);
    expect(atKey(parsed, 'workflow.tdd.strict')).toBeUndefined();
    expect(atKey(parsed, 'workflow.tdd.orchestrator_strict')).toBe(true);
  });

  it('removes a key through the link on the re-emitting path too', () => {
    // Removing one entry of a flow mapping cannot be done by deleting a line,
    // so this removal builds its text the other way and is a second write to
    // get wrong.
    const { root, link, target } = makeSymlinkedProject(
      'commands: { test: "npm --prefix cli test", build: "npm run build" }\n'
    );

    const result = runUnset('commands.test', root);

    expect(result.status).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const parsed = parseTarget(target);
    expect(atKey(parsed, 'commands.test')).toBeUndefined();
    expect(atKey(parsed, 'commands.build')).toBe('npm run build');
  });
});

/**
 * A numeric key refuses what the code reading it refuses.
 *
 * `number` is not the constraint on any of these keys. A CDP port is dialled,
 * so it has to be a port; a turn count and a token count are counted, so they
 * have to be whole and cannot be negative. Accepting `-5` writes a value that
 * the reader then rejects - at which point the failure surfaces somewhere else
 * entirely, long after the command that could have named it exited 0.
 */
describe('spechub config set, the range a numeric project key accepts', () => {
  describe('frontend.browser.cdp_port takes a TCP port', () => {
    it.each(['-5', '0', '9222.75', '65536', '70000'])(
      'refuses %s, naming the key and the range, and writing nothing',
      raw => {
        const root = makeProject(HAND_EDITED_PROJECT);
        const before = readProjectYaml(root);

        const result = runSet('frontend.browser.cdp_port', raw, root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('frontend.browser.cdp_port');
        expect(result.stderr).toMatch(/integer|whole number/i);
        // The upper bound stated, not just "invalid": a user who typed 70000
        // has to learn what the ceiling is.
        expect(result.stderr).toContain('65535');
        expect(readProjectYaml(root)).toBe(before);
      }
    );

    it.each(['1', '9222', '19988', '65535'])('accepts %s, the bounds included', raw => {
      const root = makeProject('name: port-project\n');

      const result = runSet('frontend.browser.cdp_port', raw, root);

      expect(result.status).toBe(0);
      expect(atKey(parseProjectYaml(root), 'frontend.browser.cdp_port')).toBe(Number(raw));
    });
  });

  describe('the handoff counts take a count', () => {
    /**
     * The four `workflow.handoff` keys that hold a count: one of turns, three
     * of tokens. All four are compared and counted rather than measured, so a
     * fraction is meaningless and a negative is a threshold that can never be
     * crossed - or, for `ack_turns`, a wait that is over before it starts.
     */
    const COUNT_KEYS = [
      'workflow.handoff.ack_turns',
      'workflow.handoff.nudge_warn',
      'workflow.handoff.nudge_severe',
      'workflow.handoff.nudge_step',
    ] as const;

    const REFUSED = ['-1', '-200000', '2.5', '0.5'];

    it.each(COUNT_KEYS.flatMap(key => REFUSED.map(raw => [key, raw] as [string, string])))(
      'refuses %s = %s, naming the key and writing nothing',
      (key, raw) => {
        const root = makeProject(HAND_EDITED_PROJECT);
        const before = readProjectYaml(root);

        const result = runSet(key, raw, root);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(key);
        expect(result.stderr).toMatch(/integer|whole number/i);
        expect(readProjectYaml(root)).toBe(before);
      }
    );

    it.each(COUNT_KEYS)('says a negative is the problem when %s is given one', key => {
      const result = runSet(key, '-1', makeProject('name: count-project\n'));

      expect(result.status).toBe(1);
      // "Expected an integer" alone would send someone off checking their
      // spelling; the bound is what they got wrong.
      expect(result.stderr).toMatch(/negative|non-negative|0 or more|zero or more|at least 0/i);
    });

    it.each(COUNT_KEYS)('accepts 0 for %s, since none of these counts is required to be positive', key => {
      const root = makeProject('name: count-project\n');

      const result = runSet(key, '0', root);

      expect(result.status).toBe(0);
      expect(atKey(parseProjectYaml(root), key)).toBe(0);
    });

    it.each(COUNT_KEYS)('accepts an ordinary whole count for %s', key => {
      const root = makeProject('name: count-project\n');

      const result = runSet(key, '12', root);

      expect(result.status).toBe(0);
      expect(atKey(parseProjectYaml(root), key)).toBe(12);
    });
  });
});

/**
 * `frontend.framework` is not a project key any more.
 *
 * Nothing ever read it. The setup interview asked for a framework name and
 * wrote it down, and no skill, agent or command opened the file to find out
 * what it said. A key with no reader is a question the user answers for
 * nobody, so it is gone - and a key that is gone has to be refused the way
 * any other unknown key is, rather than quietly accepted and written to a
 * file nothing consults.
 */
describe('spechub config set frontend.framework, a key that no longer exists', () => {
  it('refuses it as an unknown key with exit 1, writing to neither file', () => {
    const root = makeProject(HAND_EDITED_PROJECT);
    const before = readProjectYaml(root);

    const result = runSet('frontend.framework', 'react', root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown config key "frontend.framework"');
    // Named alongside the keys it does know, so the refusal reads as "that
    // key is gone" rather than "that value is wrong".
    expect(result.stderr).toContain('frontend.helpers_dir');
    expect(readProjectYaml(root)).toBe(before);
    expect(existsSync(result.globalConfigFile)).toBe(false);
  });

  it.each(['get', 'unset'])('refuses it from config %s too', subcommand => {
    // The read side learns the project schema in the same change, so it has
    // to learn it without this key: a `get` that knew `frontend.framework`
    // would report a default for a key the reference no longer documents.
    const result = runProjectConfig(
      [subcommand, 'frontend.framework'],
      makeProject(HAND_EDITED_PROJECT)
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown config key "frontend.framework"');
  });
});

/**
 * There is no command-line spelling for null.
 *
 * On a command line `null` is the four-character word, and the reference
 * gives no way to type "no value". Clearing a key is `config unset`, which
 * takes the key out of the file so it falls back to its documented default.
 *
 * The two are not interchangeable. A key holding null and a key the file does
 * not state read differently: `commands.format` stated as null means no
 * format step, and `commands.format` absent means the profile's value. So a
 * `set` that stored a null would silently make a decision the user typed a
 * word for.
 */
describe('spechub config set <key> null does not store a null', () => {
  it('takes the word as a string, and leaves unset as the way to clear the key', () => {
    const root = makeProject('commands:\n  format: "prettier --write ."\n');

    expect(runSet('commands.format', 'null', root).status).toBe(0);

    const stored = atKey(parseProjectYaml(root), 'commands.format');
    expect(stored).not.toBeNull();
    expect(stored).toBe('null');
    // And the file itself says so. A bare `null` or `~` after the colon would
    // read back as the null the command must not store, whatever the command
    // printed on its way out.
    expect(readProjectYaml(root)).not.toMatch(/^\s*format:\s*(null|~)\s*$/m);

    // Read back through the command, which must not report a key holding the
    // word "null" as a key with no value.
    const got = runGet('commands.format', root);
    expect(got.status).toBe(0);
    expect(got.stdout).toContain('null');

    // Removal is the way to clear it, and it leaves the key genuinely unset.
    expect(runUnset('commands.format', root).status).toBe(0);
    const cleared = runGet('commands.format', root);
    expect(cleared.status).toBe(2);
    expect(cleared.stderr).toContain('unset');
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
// spechub config get / unset / list, project keys
//
// `config set` already routes by key: a `host.*` key describes the machine
// and goes to the global config, and every other key SpecHub knows describes
// the project and goes to `spechub/project.yaml`. The three commands that
// read and remove have to route the same way, or a key `set` just wrote reads
// back as unset and cannot be removed at all.
//
// The contract each one takes on, for a project key:
//   `get`    prints the value the project file states, exit 0. A key the file
//            does not state exits 2 - the code the host axes already use for
//            an unset value - and names the default the reference documents,
//            because the default is what the project actually gets.
//   `unset`  removes the key from the file, keeping every comment and the
//            surrounding formatting, so the key falls back to its default.
//            Removing a key the file does not state is not an error.
//   `list`   prints the keys the project states alongside the host axes,
//            labelled so a reader can tell which file holds which.
//
// All three refuse a key neither schema knows, and all three refuse a project
// key outside a SpecHub project, exactly the way `config set` refuses one.
// Every `host.*` assertion above keeps holding: this teaches the commands a
// second file, it does not change what they do with the first.
// -----------------------------------------------------------------------

describe('spechub config get, project keys', () => {
  describe('a key the file states', () => {
    // `HAND_EDITED_PROJECT` already states each key read here, so no value
    // has to be written through the CLI before it can be read back.
    it.each([
      ['workflow.spec_sync', 'true'],
      ['workflow.tdd.orchestrator_strict', 'true'],
    ])('prints %s as %s, read out of spechub/project.yaml', (key, printed) => {
      const result = runGet(key, makeProject(HAND_EDITED_PROJECT));

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(printed);
      // The value came out of the project file, so nothing went looking in -
      // or creating - the global config on the way.
      expect(existsSync(result.globalConfigFile)).toBe(false);
    });

    it('prints a numeric key as the number the file states', () => {
      const root = makeProject('workflow:\n  handoff:\n    ack_turns: 8\n');

      const result = runGet('workflow.handoff.ack_turns', root);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('8');
    });

    it('prints a string key, without the quoting the file happens to use', () => {
      // The file states `tests: "tests/"`. What the user asked for is the
      // path, not the YAML source that holds it.
      const result = runGet('directories.tests', makeProject(HAND_EDITED_PROJECT));

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('tests/');
    });
  });

  describe('a key the file does not state', () => {
    it.each([
      ['workflow.tdd.strict', 'true'],
      ['workflow.frontend_verification', 'false'],
      ['workflow.grilling.questions', 'tool'],
      ['workflow.handoff.ack_turns', '5'],
      ['workflow.design_review', 'false'],
    ])('exits 2 for the unstated %s and names its documented default, %s', (key, fallback) => {
      const result = runGet(key, makeProject('name: defaults-project\n'));

      // The same exit code the host axes use for an unset value, so a caller
      // branches on "no value here" without knowing which file the key
      // lives in.
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(key);
      expect(result.stderr).toContain('unset');
      // The default is what the project actually gets, so a reader told only
      // "unset" would still have to go and look the answer up.
      expect(result.stderr).toContain(fallback);
    });

    it('exits 2 and reports unset for a key the reference gives no default at all', () => {
      // `workflow.maps.tracker` has no default: the map skill picks one at
      // the moment it first writes a map down, and writes the key. So there
      // is no default to name here, and the command still has to say the
      // file states no value rather than inventing one.
      const result = runGet('workflow.maps.tracker', makeProject('name: no-default-project\n'));

      expect(result.status).toBe(2);
      expect(result.stderr).toContain('unset');
    });
  });

  describe('the two ways a key can be refused', () => {
    it('refuses a project key outside a SpecHub project with exit 1, writing nothing', () => {
      const cwd = noProjectDir();

      const result = runGet('workflow.tdd.strict', cwd);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/no SpecHub project/i);
      expect(existsSync(join(cwd, 'spechub'))).toBe(false);
      expect(existsSync(result.globalConfigFile)).toBe(false);
    });

    it('refuses a key neither schema knows with exit 1, naming a project key it does know', () => {
      const result = runGet('workflow.bogus', makeProject(HAND_EDITED_PROJECT));

      // Exit 1, not the 2 reserved for a key that exists and has no value:
      // there is nothing here to have a value.
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Unknown config key "workflow.bogus"');
      // The message `config set` already gives. An unknown key is refused
      // against both schemas, so the list the user is shown has to name the
      // project keys too, not only the host axes.
      expect(result.stderr).toContain('workflow.spec_sync');
    });
  });
});

describe('spechub config unset, project keys', () => {
  describe('removing a key a hand-edited file states', () => {
    // One arrangement read six ways, the way the `config set` suite above
    // reads its own. Each `it` names one thing a removal must not cost.
    let text: string;
    let parsed: StoredProjectYaml;
    let result: ReturnType<typeof runUnset>;

    beforeAll(() => {
      const root = makeProject(HAND_EDITED_PROJECT);
      result = runUnset('workflow.tdd.strict', root);
      text = readProjectYaml(root);
      parsed = parseProjectYaml(root);
    });

    it('exits 0 and says which key it removed', () => {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Removed workflow.tdd.strict');
    });

    it('leaves the key stated nowhere in the file', () => {
      expect(atKey(parsed, 'workflow.tdd.strict')).toBeUndefined();
      // Not only absent from the parsed data: absent from the text. A value
      // rewritten to `false` would read back as a decision nobody made.
      expect(text).not.toMatch(/^\s*strict:/m);
    });

    it('keeps the sibling stated inside the same block', () => {
      expect(atKey(parsed, 'workflow.tdd.orchestrator_strict')).toBe(true);
      expect(keysAt(parsed, 'workflow.tdd')).toEqual(['orchestrator_strict']);
    });

    it('keeps the header comment and the inline comment on another key', () => {
      expect(text).toContain('# Written by /spechub:setup, hand-edited since. Keep the comments.');
      expect(text).toContain('# tool | inline');
    });

    it('keeps the other blocks, their order and their quoting', () => {
      expect(text).toContain('  test: "npm --prefix cli test"');
      expect(text).toContain('  source: "cli/src/"');
      expect(atKey(parsed, 'profile')).toBe('node-typescript');
      expect(atKey(parsed, 'workflow.spec_sync')).toBe(true);
    });

    it('writes nothing to the global config', () => {
      expect(existsSync(result.globalConfigFile)).toBe(false);
    });
  });

  describe('the key falls back to its default once it is gone', () => {
    it('round-trips one key: set it, get it, unset it, get it back as unset', () => {
      const root = makeProject(HAND_EDITED_PROJECT);

      expect(runSet('workflow.tdd.strict', 'false', root).status).toBe(0);

      const stated = runGet('workflow.tdd.strict', root);
      expect(stated.status).toBe(0);
      expect(stated.stdout.trim()).toBe('false');

      expect(runUnset('workflow.tdd.strict', root).status).toBe(0);

      const gone = runGet('workflow.tdd.strict', root);
      expect(gone.status).toBe(2);
      expect(gone.stderr).toContain('unset');
      // The documented default is the opposite of the value just removed, so
      // a fallback that kept reading the old value shows here rather than
      // hiding behind a default that happened to agree with it.
      expect(gone.stderr).toContain('true');
    });

    it('round-trips workflow.design_review the same way, back to the default false', () => {
      const root = makeProject('name: design-review-project\n');

      expect(runSet('workflow.design_review', 'true', root).status).toBe(0);

      const stated = runGet('workflow.design_review', root);
      expect(stated.status).toBe(0);
      expect(stated.stdout.trim()).toBe('true');

      expect(runUnset('workflow.design_review', root).status).toBe(0);
      expect(atKey(parseProjectYaml(root), 'workflow.design_review')).toBeUndefined();

      const gone = runGet('workflow.design_review', root);
      expect(gone.status).toBe(2);
      expect(gone.stderr).toContain('unset');
      // The default is the opposite of the value just removed, so a fallback
      // still reading the removed value shows here rather than hiding behind
      // a default that happened to agree with it.
      expect(gone.stderr).toContain('false');
    });
  });

  describe('removing a key the file does not state', () => {
    it('exits 0 saying it was not set, and leaves the file byte-identical', () => {
      const root = makeProject(HAND_EDITED_PROJECT);
      const before = readProjectYaml(root);

      const result = runUnset('workflow.maps.persist', root);

      // Not an error: the state the user asked for is the state the file is
      // already in, the same way an unset host axis reports and exits 0.
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('was not set');
      // Not "the key is still absent" but "the file is unchanged": a removal
      // that rewrote the file to remove nothing would still have cost the
      // user their formatting.
      expect(readProjectYaml(root)).toBe(before);
    });
  });

  describe('the two ways a key can be refused', () => {
    it('refuses a project key outside a SpecHub project with exit 1, writing nothing', () => {
      const cwd = noProjectDir();

      const result = runUnset('workflow.tdd.strict', cwd);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/no SpecHub project/i);
      expect(existsSync(join(cwd, 'spechub'))).toBe(false);
      expect(existsSync(result.globalConfigFile)).toBe(false);
    });

    it('refuses a key neither schema knows with exit 1, leaving the file alone', () => {
      const root = makeProject(HAND_EDITED_PROJECT);
      const before = readProjectYaml(root);

      const result = runUnset('workflow.bogus', root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Unknown config key "workflow.bogus"');
      expect(result.stderr).toContain('workflow.spec_sync');
      expect(readProjectYaml(root)).toBe(before);
    });
  });
});

/**
 * A removal that would leave a YAML alias with no anchor is refused, not
 * crashed out of.
 *
 * An anchor and an alias are how a hand-edited file states one value twice -
 * `test: &t npm test` and `lint: *t`. Remove the key carrying the anchor and
 * the alias below it points at nothing, so the emitter cannot write the
 * document out and throws. Left uncaught that reaches the user as a stack
 * trace naming the YAML library's own frames, about a file they can see and a
 * removal they asked for.
 *
 * The file survives either way - the throw happens while the new text is
 * being built, before anything is written - so what is wrong is only what the
 * user is told. Every other refusal this command makes is one red sentence,
 * and this one has to be as well.
 */
describe('spechub config unset when the removal would orphan a YAML alias', () => {
  /** The anchor name, distinctive enough that finding it in a message means something. */
  const ANCHOR = 'shared_test_command';

  /** `commands.test` carries the anchor; `commands.lint` is the alias to it. */
  const ANCHORED_PROJECT = [
    'commands:',
    `  test: &${ANCHOR} npm test`,
    `  lint: *${ANCHOR}`,
    '',
  ].join('\n');

  let root: string;
  let result: ReturnType<typeof runUnset>;
  let before: string;

  beforeAll(() => {
    root = makeProject(ANCHORED_PROJECT);
    before = readProjectYaml(root);
    result = runUnset('commands.test', root);
  });

  it('reports the problem rather than crashing out of it', () => {
    expect(result.status).toBe(1);
    expectNoStackTrace(result);
  });

  it('names the alias that would be left pointing at nothing', () => {
    // The user has to know which of their lines is the obstacle. There is
    // only one anchor in this file and several ways to spell the sentence, so
    // the anchor name is the whole assertion.
    expect(result.stderr).toContain(ANCHOR);
  });

  it('leaves the file byte-identical', () => {
    expect(readProjectYaml(root)).toBe(before);
  });
});

/**
 * One row under `project` in `spechub config list --json`.
 *
 * `key` is the dotted path `config set` takes, `value` is what the file
 * states, parsed, and `known` says whether any schema knows that key - false
 * for exactly the keys `config get` refuses, so a caller can find the rows it
 * cannot act on without matching prose.
 */
interface ConfigListProjectRow {
  key: string;
  value: unknown;
  known: boolean;
}

/**
 * The `spechub config list --json` output shape, as touched by this file's
 * assertions. `host` is the global config's own nesting, reported as it is
 * stored, and is not rows.
 *
 * `project` is an ARRAY, in the file's own order, and not an object keyed by
 * the dotted path. A file is free to state `workflow.spec_sync: true` as one
 * literal quoted key AND state the same path nested, and both are rows the
 * human listing prints. Keyed by the dotted path they collide, and the first
 * of them is dropped without a word. An array cannot collide, and it carries
 * the order the human listing already promises.
 */
interface ConfigListJson {
  host?: unknown;
  project?: ConfigListProjectRow[];
}

/** Every row `list --json` gives for dotted `key`, in the order it reported them. */
function projectRows(json: ConfigListJson, key: string): ConfigListProjectRow[] {
  return (json.project ?? []).filter(row => row.key === key);
}

describe('spechub config list', () => {
  /** A project stating two keys, in two different blocks. */
  const LISTED_PROJECT = [
    'workflow:',
    '  tdd:',
    '    strict: false',
    '',
    'commands:',
    '  test: "npm --prefix cli test"',
    '',
  ].join('\n');

  /**
   * Run `spechub config list` in `cwd` against a global config written
   * directly, the way `runCheck` does.
   *
   * Writing the file rather than driving `spechub config set` keeps this to
   * one spawned process per run: declaring two axes through the CLI would
   * cost two spawns before the run being asserted on even starts.
   */
  function listWithHost(cwd: string, host: HostDeclarations, flags: string[] = []) {
    const xdg = mkdtempSync(join(tmpdir(), 'spechub-list-xdg-'));
    mkdirSync(join(xdg, 'spechub'), { recursive: true });
    writeFileSync(join(xdg, 'spechub', 'config.json'), JSON.stringify({ host }, null, 2) + '\n');
    return runCli(['config', 'list', ...flags], { cwd, env: { XDG_CONFIG_HOME: xdg } });
  }

  describe('a project and a host that each state something', () => {
    let result: ReturnType<typeof listWithHost>;

    beforeAll(() => {
      result = listWithHost(makeProject(LISTED_PROJECT), {
        orchestrators: { herdr: true },
        browser: { remote: true },
      });
    });

    it('exits 0', () => {
      expect(result.status).toBe(0);
    });

    it('prints the keys the project states, by the dotted paths config set takes', () => {
      // The dotted path is the spelling every other command uses, so a key
      // read out of this listing can be pasted straight into a `set`.
      expect(result.stdout).toContain('workflow.tdd.strict');
      expect(result.stdout).toContain('commands.test');
      expect(result.stdout).toContain('npm --prefix cli test');
    });

    it('prints the host axes alongside them, in the same run', () => {
      expect(result.stdout).toContain('herdr');
      expect(result.stdout).toContain('remote');
    });

    it('names the file each side came out of', () => {
      // Two files, two sets of keys. A listing that ran them together without
      // saying which is which leaves a reader guessing where to go and change
      // one, and the two files are edited in completely different places.
      expect(result.stdout).toContain('project.yaml');
      expect(result.stdout).toContain('config.json');
    });

    it('lists what the project file states, not every key that has a default', () => {
      // `list` reports the files, not the resolved configuration. A key the
      // file omits takes its default, and printing it here would read as a
      // decision this project made.
      expect(result.stdout).not.toContain('workflow.spec_sync');
      expect(result.stdout).not.toContain('workflow.maps.persist');
    });
  });

  it('still lists the host axes outside a SpecHub project, without failing', () => {
    // `list` names no key, so there is no project key to refuse here. The
    // host axes are the machine's, and they are readable from anywhere.
    const result = listWithHost(noProjectDir(), { orchestrators: { herdr: true } });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('herdr');
  });

  /**
   * A key the file states that no schema knows is listed, and marked.
   *
   * `list` reports the file rather than the resolved configuration, so a key
   * nothing knows is still in the listing: hiding it would make the listing
   * disagree with the file it is listing, and send the user looking for a
   * line they can plainly see in their editor. But `config get` refuses that
   * same key and `config set` will not write it, so a row printed exactly
   * like its neighbours tells the user those two commands are broken. The
   * mark is what says the key is the problem.
   *
   * `venv` is the case that made this worth doing. The schema knows
   * `venv.activate` and nothing else under `venv`, so a file stating `venv`
   * as a leaf states a key `config get` refuses and `config set` will not
   * write - and the mark is what says so.
   *
   * The value here is a real one on purpose. A leaf holding NOTHING - `venv:`
   * with no value, or `venv: {}` - is the shape the tool's own `unset` leaves
   * behind, and carries no mark; that case has its own suite below.
   */
  describe('a key the file states that no schema knows', () => {
    /** The value the unknown key holds, spelled once so both modes assert the same string. */
    const VENV_ACTIVATE = 'source .venv/bin/activate';

    /** A project stating a known key, then an unknown one, then a known one. */
    const UNKNOWN_KEY_PROJECT = [
      'workflow:',
      '  tdd:',
      '    strict: false',
      '',
      `venv: "${VENV_ACTIVATE}"`,
      '',
      'commands:',
      '  test: "npm --prefix cli test"',
      '',
    ].join('\n');

    /** The note the human listing puts on a row no schema knows. */
    const UNKNOWN_MARK = '(unknown key)';

    let root: string;
    let text: ReturnType<typeof listWithHost>;
    let json: ConfigListJson;

    beforeAll(() => {
      root = makeProject(UNKNOWN_KEY_PROJECT);
      text = listWithHost(root, { orchestrators: { herdr: true } });
      json = JSON.parse(
        listWithHost(root, { orchestrators: { herdr: true } }, ['--json']).stdout
      ) as ConfigListJson;
    });

    it('exits 0, because an unknown key in the file is not an error to report', () => {
      expect(text.status).toBe(0);
    });

    it('keeps the row in the place the file states it, ahead of the key below it', () => {
      // File order, not sorted order and not known-keys-first: the listing is
      // read beside the file, and a row that moved is a row the user has to
      // hunt for.
      const keys = text.stdout
        .split('\n')
        .filter(line => /^(workflow\.|venv|commands\.)/.test(line))
        .map(line => line.split(' ')[0]);
      expect(keys).toEqual(['workflow.tdd.strict', 'venv', 'commands.test']);
    });

    it('marks that row, and still prints the value the file states', () => {
      const line = lineContaining(text.stdout, 'venv =');
      expect(line).toBeDefined();
      expect(line).toContain(UNKNOWN_MARK);
      expect(line).toContain(VENV_ACTIVATE);
    });

    it('leaves the rows a schema does know unmarked', () => {
      // The mark means something only if most rows do not carry it.
      expect(lineContaining(text.stdout, 'workflow.tdd.strict')).not.toContain(UNKNOWN_MARK);
      expect(lineContaining(text.stdout, 'commands.test')).not.toContain(UNKNOWN_MARK);
    });

    it('--json says of every row whether a schema knows its key', () => {
      // Every row, not only the unmarked ones: a caller that has to tell an
      // absent field from a false one is reading the shape, not the answer.
      // Asserted as the whole array, because the rows ARE the answer - a
      // fourth row nobody asked for is as wrong as a missing field.
      expect(json.project).toEqual([
        { key: 'workflow.tdd.strict', value: false, known: true },
        { key: 'venv', value: VENV_ACTIVATE, known: false },
        { key: 'commands.test', value: 'npm --prefix cli test', known: true },
      ]);
    });

    it('changes nothing about what config get does with that key', () => {
      // The listing marks the key. It does not start accepting it, and `get`
      // still has exactly one answer for a key no schema knows.
      const unknown = runGet('venv', root);

      expect(unknown.status).toBe(1);
      expect(unknown.stderr).toContain('Unknown config key "venv"');
      expect(runGet('commands.test', root).status).toBe(0);
    });
  });

  /**
   * A file that states one path twice, once literally and once nested.
   *
   * YAML lets a key hold a dot. `"workflow.spec_sync": true` is a mapping key
   * whose name happens to contain one, and it is a completely different key
   * from `spec_sync` inside a `workflow` block - which the same file is free
   * to state as well. Both are lines in the file, so both are rows in a
   * listing that reports the file.
   *
   * They are two rows sharing one dotted path, and that is what an object
   * keyed by the dotted path cannot hold: the second row overwrites the
   * first, so the listing loses a line the user can plainly see. The rows are
   * an array for that reason, and file order comes free with it.
   *
   * The literal key is UNKNOWN, however known the path it spells looks.
   * `config get workflow.spec_sync` walks the blocks and never sees it, so
   * that key reads as unset while a line stating it sits in the file, and
   * `config set workflow.spec_sync` writes the nested spelling beside it
   * rather than changing it. A row nothing can read and nothing will write is
   * exactly what the mark is for.
   */
  describe('a file that states one path as a literal dotted key and again nested', () => {
    /** The literal key first, the nested spelling second, a third key after both. */
    const DOTTED_KEY_PROJECT = [
      '"workflow.spec_sync": true',
      '',
      'workflow:',
      '  spec_sync: false',
      '',
      'commands:',
      '  test: "npm --prefix cli test"',
      '',
    ].join('\n');

    /** The note the human listing puts on a row no schema knows. */
    const UNKNOWN_MARK = '(unknown key)';

    let root: string;
    let text: ReturnType<typeof listWithHost>;
    let json: ConfigListJson;

    beforeAll(() => {
      root = makeProject(DOTTED_KEY_PROJECT);
      text = listWithHost(root, { orchestrators: { herdr: true } });
      json = JSON.parse(
        listWithHost(root, { orchestrators: { herdr: true } }, ['--json']).stdout
      ) as ConfigListJson;
    });

    it('exits 0, because a file stating a path twice is not an error to report', () => {
      expect(text.status).toBe(0);
    });

    it('--json keeps both rows, with the value each of them states', () => {
      // Two rows, not one: the file states two lines and the listing reports
      // the file. Which value wins is a question for `get`, not for a listing.
      expect(projectRows(json, 'workflow.spec_sync').map(row => row.value)).toEqual([true, false]);
    });

    it("--json reports the rows in the file's own order", () => {
      // The same order the human listing prints, and the order the user reads
      // beside their editor. Asserted as the whole array, so a row that moved
      // or a row that vanished both show here.
      expect(json.project).toEqual([
        { key: 'workflow.spec_sync', value: true, known: false },
        { key: 'workflow.spec_sync', value: false, known: true },
        { key: 'commands.test', value: 'npm --prefix cli test', known: true },
      ]);
    });

    it('--json calls the literal key unknown and the nested one known', () => {
      // The two rows share a dotted path and differ on this. A caller looking
      // for the rows it cannot act on gets the literal one and nothing else.
      expect(projectRows(json, 'workflow.spec_sync').map(row => row.known)).toEqual([false, true]);
    });

    it('prints both rows in text mode as well, marking only the literal one', () => {
      const lines = text.stdout.split('\n').filter(line => line.startsWith('workflow.spec_sync '));

      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain(UNKNOWN_MARK);
      expect(lines[1]).not.toContain(UNKNOWN_MARK);
    });

    it('answers config get out of the nested spelling, which is why the other is unknown', () => {
      // The reason the literal row carries the mark, stated as behaviour: the
      // key `get` answers with is the nested one, whatever the literal line
      // above it says.
      const read = runGet('workflow.spec_sync', root);

      expect(read.status).toBe(0);
      expect(read.stdout.trim()).toBe('false');
    });
  });

  /**
   * A block header the tool's own `unset` left behind is not an unknown key.
   *
   * Removing a block's last key removes the key, not the block: `workflow:`
   * stays, holding nothing, and every reader takes the default for everything
   * under it. That is the documented behaviour, and it is the tool that wrote
   * the line.
   *
   * A listing that then prints `workflow = null (unknown key)` in yellow is
   * the tool warning the user about its own residue, and sending them to look
   * for a mistake in a file where there is none. So a row holding nothing at
   * a path some key is stated UNDER counts as known, and carries no mark. A
   * row holding nothing at a path nothing is stated under is a different
   * thing entirely - nobody wrote it by accident, and it keeps the mark.
   */
  describe('a row left holding nothing at a path a schema knows keys under', () => {
    /** The note the human listing puts on a row no schema knows. */
    const UNKNOWN_MARK = '(unknown key)';

    /**
     * List `root`, reading both modes off one arrangement.
     *
     * Each case below states its own file, so the arrangement cannot be
     * shared, and each still wants the text row and the JSON row from it.
     */
    function listBothWays(root: string): { text: string; json: ConfigListJson } {
      const host: HostDeclarations = { orchestrators: { herdr: true } };
      const text = listWithHost(root, host);
      expect(text.status).toBe(0);
      return {
        text: text.stdout,
        json: JSON.parse(listWithHost(root, host, ['--json']).stdout) as ConfigListJson,
      };
    }

    /** The listed line for dotted `key`, insisting the row was printed at all. */
    function rowLine(text: string, key: string): string {
      const line = lineContaining(text, `${key} =`);
      expect(line, `the listing prints no row for ${key}`).toBeDefined();
      return line as string;
    }

    it('leaves no mark on the block header an unset emptied', () => {
      const root = makeProject(
        ['workflow:', '  spec_sync: true', '', 'commands:', '  test: "npm test"', ''].join('\n')
      );
      expect(runUnset('workflow.spec_sync', root).status).toBe(0);

      const { text, json } = listBothWays(root);

      // The removal leaves `workflow:` standing, so there is a row to report.
      // What it must not carry is the warning.
      expect(rowLine(text, 'workflow')).not.toContain(UNKNOWN_MARK);
      expect(projectRows(json, 'workflow')).toEqual([{ key: 'workflow', value: null, known: true }]);
    });

    it('leaves no mark on an empty map either', () => {
      // `workflow: {}` states the same nothing in the other spelling, and a
      // file that arrived from an editor or a generator may hold it.
      const root = makeProject(
        ['workflow: {}', '', 'commands:', '  test: "npm test"', ''].join('\n')
      );

      const { text, json } = listBothWays(root);

      expect(rowLine(text, 'workflow')).not.toContain(UNKNOWN_MARK);
      expect(projectRows(json, 'workflow')).toEqual([{ key: 'workflow', value: {}, known: true }]);
    });

    it('leaves no mark on an emptied block nested inside another', () => {
      // `workflow.handoff` is a path several keys are stated under, and the
      // same removal empties it. A rule written only for a top-level block
      // still marks this one.
      const root = makeProject(
        [
          'workflow:',
          '  handoff:',
          '    ack_turns: 5',
          '',
          'commands:',
          '  test: "npm test"',
          '',
        ].join('\n')
      );
      expect(runUnset('workflow.handoff.ack_turns', root).status).toBe(0);

      const { text, json } = listBothWays(root);

      expect(rowLine(text, 'workflow.handoff')).not.toContain(UNKNOWN_MARK);
      expect(projectRows(json, 'workflow.handoff')).toEqual([
        { key: 'workflow.handoff', value: null, known: true },
      ]);
    });

    it('still marks a key holding nothing that no schema knows a key under', () => {
      // The mark has to keep meaning something. `plugins` is not a path any
      // key is stated under, so nothing the tool does could have left it, and
      // a user who typed it wants to be told.
      const root = makeProject(['plugins:', '', 'commands:', '  test: "npm test"', ''].join('\n'));

      const { text, json } = listBothWays(root);

      expect(rowLine(text, 'plugins')).toContain(UNKNOWN_MARK);
      expect(projectRows(json, 'plugins')).toEqual([{ key: 'plugins', value: null, known: false }]);
    });
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
  it('exits 0 and lists all nine host axes when nothing at all is configured', () => {
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
      'host.terminal_workspace',
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
      'host.terminal_workspace',
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
    writeDomainMap(cwd, DOMAIN_MAP_THREE);
    const result = runCli(['config', 'check'], {
      cwd,
      path: [emptyPathDir()],
      env: { HOME: fakeHome() },
    });

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
    writeDomainMap(cwd, DOMAIN_MAP_THREE);
    const result = runCli(['config', 'check'], {
      cwd,
      path: [emptyPathDir()],
      env: { HOME: fakeHome() },
    });

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

    it('exits 0 when herdr is declared true and the herdr binary answers `herdr api snapshot` successfully', () => {
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
        writeDomainMap(cwd, DOMAIN_MAP_THREE);
        const result = runCli(['config', 'check'], {
          cwd,
          path: [fakeBinDir(binaryName, 0)],
          env: { HOME: fakeHome() },
        });

        expect(result.status).toBe(0);
      }
    );

    it('exits 1 when host.browser.headless is declared true but no chromium/chrome binary is on PATH', () => {
      declareOrchestrators(false, false);
      expect(runCli(['config', 'set', 'host.browser.headless', 'true']).status).toBe(0);

      // The domain map every project owes is satisfied, so the exit code
      // reads on check 3's headless probe and nothing else.
      const cwd = makeProject('name: no-frontend-project\n');
      writeDomainMap(cwd, DOMAIN_MAP_THREE);
      const result = runCli(['config', 'check'], {
        cwd,
        path: [emptyPathDir()],
        env: { HOME: fakeHome() },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
    });

    it('exits 1 when host.browser.local is declared true but no chromium/chrome binary is on PATH', () => {
      declareOrchestrators(false, false);
      expect(runCli(['config', 'set', 'host.browser.local', 'true']).status).toBe(0);

      // The domain map every project owes is satisfied, so the exit code
      // reads on check 3's local probe and nothing else.
      const cwd = makeProject('name: no-frontend-project\n');
      writeDomainMap(cwd, DOMAIN_MAP_THREE);
      const result = runCli(['config', 'check'], {
        cwd,
        path: [emptyPathDir()],
        env: { HOME: fakeHome() },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('unknown command');
    });

    it('does not probe for chromium/chrome when host.browser.headless and host.browser.local are declared false', () => {
      declareOrchestrators(false, false);
      expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

      const cwd = makeProject('name: no-frontend-project\n');
      writeDomainMap(cwd, DOMAIN_MAP_THREE);
      const result = runCli(['config', 'check'], {
        cwd,
        path: [emptyPathDir()],
        env: { HOME: fakeHome() },
      });

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

        // A project that configures a frontend owes the frontend project
        // rows too - agent-browser on PATH, an agreeing agent-browser.json
        // and a verification knowledge base - as well as the domain map
        // every project owes. Satisfying all of them keeps the exit code
        // this test reads about check 3's remote probe and nothing else.
        const cwd = makeProject(
          `frontend:\n  helpers_dir: "${HELPERS_DIR}"\n  browser:\n    mode: remote\n    cdp_port: ${port}\n`
        );
        writeDomainMap(cwd, DOMAIN_MAP_THREE);
        writeAgentBrowserJson(cwd, agentBrowserJsonFor(port));
        writeVerificationKnowledge(cwd);
        const result = runCli(['config', 'check'], {
          cwd,
          path: [fakeBinDir('agent-browser', 0)],
          env: { HOME: fakeHome() },
        });

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

      // The domain map and the three frontend project rows are satisfied so
      // that the exit code reads on check 3's remote probe alone.
      const cwd = makeProject(
        `frontend:\n  helpers_dir: "${HELPERS_DIR}"\n  browser:\n    mode: remote\n    cdp_port: ${port}\n`
      );
      writeDomainMap(cwd, DOMAIN_MAP_THREE);
      writeAgentBrowserJson(cwd, agentBrowserJsonFor(port));
      writeVerificationKnowledge(cwd);
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDir('agent-browser', 0)],
        env: { HOME: fakeHome() },
      });

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

        // The domain map and the three frontend project rows are satisfied so
        // that the exit code reads on check 3's remote probe alone.
        const cwd = makeProject(
          `frontend:\n  helpers_dir: "${HELPERS_DIR}"\n  browser:\n    mode: remote\n    cdp_port: ${port}\n`
        );
        writeDomainMap(cwd, DOMAIN_MAP_THREE);
        writeAgentBrowserJson(cwd, agentBrowserJsonFor(port));
        writeVerificationKnowledge(cwd);
        const result = runCli(['config', 'check'], {
          cwd,
          path: [fakeBinDir('agent-browser', 0)],
          env: { HOME: fakeHome() },
        });

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

        // The domain map and the three frontend project rows are satisfied
        // so that the exit code reads on check 4 alone.
        const cwd = makeProject(
          `frontend:\n  helpers_dir: "${HELPERS_DIR}"\n  browser:\n    mode: remote\n    cdp_port: ${port}\n`
        );
        writeDomainMap(cwd, DOMAIN_MAP_THREE);
        writeAgentBrowserJson(cwd, agentBrowserJsonFor(port));
        writeVerificationKnowledge(cwd);
        const result = runCli(['config', 'check'], {
          cwd,
          path: [fakeBinDir('agent-browser', 0)],
          env: { HOME: fakeHome() },
        });

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

      // The port is stated only so agent-browser.json has a number to agree
      // with: the host declares remote false, so nothing knocks on it. With
      // the domain map and the frontend rows satisfied too, the exit code
      // reads on check 4 alone.
      const cdpPort = 9222;
      const cwd = makeProject(
        `frontend:\n  helpers_dir: "${HELPERS_DIR}"\n  browser:\n    mode: remote\n    cdp_port: ${cdpPort}\n`
      );
      writeDomainMap(cwd, DOMAIN_MAP_THREE);
      writeAgentBrowserJson(cwd, agentBrowserJsonFor(cdpPort));
      writeVerificationKnowledge(cwd);
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDir('chromium', 0), fakeBinDir('agent-browser', 0)],
        env: { HOME: fakeHome() },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('headless');
    });

    it('exits 1 when the project prefers a mode and none of the browser axes are declared true', () => {
      declareOrchestrators(false, false);
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);

      // The port is stated only so agent-browser.json has a number to agree
      // with: every axis is false, so nothing knocks on it. With the domain
      // map and the frontend rows satisfied too, the exit code reads on
      // check 4 alone.
      const cdpPort = 9222;
      const cwd = makeProject(
        `frontend:\n  helpers_dir: "${HELPERS_DIR}"\n  browser:\n    mode: remote\n    cdp_port: ${cdpPort}\n`
      );
      writeDomainMap(cwd, DOMAIN_MAP_THREE);
      writeAgentBrowserJson(cwd, agentBrowserJsonFor(cdpPort));
      writeVerificationKnowledge(cwd);
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDir('agent-browser', 0)],
        env: { HOME: fakeHome() },
      });

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
    //
    // The cases that read the exit code also satisfy the project rows: the
    // domain map every project owes, and - because these projects configure
    // a frontend - agent-browser on PATH, an agreeing agent-browser.json and
    // a verification knowledge base. A missing one of those is an ordinary
    // failure, so leaving any unsatisfied would move the exit code for a
    // reason that has nothing to do with fallback.
    function declareRemotePreferredHeadlessAvailable(): void {
      declareOrchestrators(false, false);
      expect(runCli(['config', 'set', 'host.browser.remote', 'false']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'true']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'false']).status).toBe(0);
    }

    it('fallback: none fails check 4 and exits 1, even though headless is available to fall back to', () => {
      declareRemotePreferredHeadlessAvailable();

      // The port is stated only so agent-browser.json has a number to agree
      // with: the host declares remote false, so nothing knocks on it. With
      // the domain map and the frontend rows satisfied too, the exit code
      // reads on check 4 alone.
      const cdpPort = 9222;
      const cwd = makeProject(
        `frontend:\n  helpers_dir: "${HELPERS_DIR}"\n  browser:\n    mode: remote\n    cdp_port: ${cdpPort}\n    fallback: none\n`
      );
      writeDomainMap(cwd, DOMAIN_MAP_THREE);
      writeAgentBrowserJson(cwd, agentBrowserJsonFor(cdpPort));
      writeVerificationKnowledge(cwd);
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDir('chromium', 0), fakeBinDir('agent-browser', 0)],
        env: { HOME: fakeHome() },
      });

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

      const cdpPort = 9222;
      const cwd = makeProject(
        `frontend:\n  helpers_dir: "${HELPERS_DIR}"\n  browser:\n    mode: remote\n    cdp_port: ${cdpPort}\n`
      );
      writeDomainMap(cwd, DOMAIN_MAP_THREE);
      writeAgentBrowserJson(cwd, agentBrowserJsonFor(cdpPort));
      writeVerificationKnowledge(cwd);
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDir('chromium', 0), fakeBinDir('agent-browser', 0)],
        env: { HOME: fakeHome() },
      });

      expect(result.status).toBe(0);
      expect(checkSection(result.stdout, 4)).toContain('headless');
    });

    it('fallback: headless passes check 4 and reports the fallback to headless, same as unset', () => {
      declareRemotePreferredHeadlessAvailable();

      const cdpPort = 9222;
      const cwd = makeProject(
        `frontend:\n  helpers_dir: "${HELPERS_DIR}"\n  browser:\n    mode: remote\n    cdp_port: ${cdpPort}\n    fallback: headless\n`
      );
      writeDomainMap(cwd, DOMAIN_MAP_THREE);
      writeAgentBrowserJson(cwd, agentBrowserJsonFor(cdpPort));
      writeVerificationKnowledge(cwd);
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDir('chromium', 0), fakeBinDir('agent-browser', 0)],
        env: { HOME: fakeHome() },
      });

      expect(result.status).toBe(0);
      expect(checkSection(result.stdout, 4)).toContain('headless');
    });

    it('fallback: local still falls back to headless, because only "none" overrides the remote>headless>local order', () => {
      declareRemotePreferredHeadlessAvailable();

      const cdpPort = 9222;
      const cwd = makeProject(
        `frontend:\n  helpers_dir: "${HELPERS_DIR}"\n  browser:\n    mode: remote\n    cdp_port: ${cdpPort}\n    fallback: local\n`
      );
      writeDomainMap(cwd, DOMAIN_MAP_THREE);
      writeAgentBrowserJson(cwd, agentBrowserJsonFor(cdpPort));
      writeVerificationKnowledge(cwd);
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDir('chromium', 0), fakeBinDir('agent-browser', 0)],
        env: { HOME: fakeHome() },
      });

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
          `frontend:\n  helpers_dir: "${HELPERS_DIR}"\n  browser:\n    mode: remote\n    cdp_port: ${port}\n    fallback: none\n`
        );
        writeDomainMap(cwd, DOMAIN_MAP_THREE);
        writeAgentBrowserJson(cwd, agentBrowserJsonFor(port));
        writeVerificationKnowledge(cwd);
        const result = runCli(['config', 'check'], {
          cwd,
          path: [fakeBinDir('agent-browser', 0)],
          env: { HOME: fakeHome() },
        });

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

      // The port is stated only so agent-browser.json has a number to agree
      // with: every axis is false, so nothing knocks on it. With the domain
      // map and the frontend rows satisfied too, the exit code reads on
      // check 4 alone.
      const cdpPort = 9222;
      const cwd = makeProject(
        `frontend:\n  helpers_dir: "${HELPERS_DIR}"\n  browser:\n    mode: remote\n    cdp_port: ${cdpPort}\n    fallback: none\n`
      );
      writeDomainMap(cwd, DOMAIN_MAP_THREE);
      writeAgentBrowserJson(cwd, agentBrowserJsonFor(cdpPort));
      writeVerificationKnowledge(cwd);
      const result = runCli(['config', 'check'], {
        cwd,
        path: [fakeBinDir('agent-browser', 0)],
        env: { HOME: fakeHome() },
      });

      expect(result.status).toBe(1);
    });
  });

  // -------------------------------------------------------------------
  // Check 4's row carries its answer in its status
  //
  // The `preferred-browser-mode` row reports on one thing: whether the mode
  // this project asked for is one this host says it can provide. So it has
  // four outcomes and no fifth.
  //   pass    the project has a frontend, names a mode, and the host declares
  //           a mode that honours it - its own, or one standing in for it
  //   info    the project has a frontend and names no mode
  //   fail    the project names a mode the host cannot honour
  //   absent  the project configures no frontend, so it asked for nothing
  //
  // Absent rather than informational is the part worth stating. A caller
  // deciding whether to offer the user a fix reads the identifier and the
  // status and nothing else, and the two situations that used to share `info`
  // want opposite answers: a project that named no mode has a gap worth
  // offering to fill, and a project with no frontend needs nothing at all.
  // The frontend file rows already work this way - a project with no frontend
  // gets no row for them rather than a row saying it has none - so this is
  // the row joining a rule the section already follows.
  //
  // Every case here reads the row out of `--json` by its identifier. The
  // status is the contract; the sentence beside it can be reworded.
  // -------------------------------------------------------------------

  describe("check 4's row carries its answer in its status", () => {
    /** A project that configures a frontend and states `body` under its browser. */
    function frontendBrowser(body: string[]): string {
      return ['frontend:', `  helpers_dir: "${HELPERS_DIR}"`, '  browser:', ...body, ''].join('\n');
    }

    /**
     * Check 4's row from a `--json` run in `cwd` under `host`, or undefined.
     *
     * Nothing on PATH, because this check probes nothing: it weighs what the
     * project stated against what the host declared, both read off disk.
     */
    function preferredRow(cwd: string, host: HostDeclarations) {
      const result = runCheck({ cwd, host, path: [emptyPathDir()], json: true });
      return checkJsonRow(result.stdout, PREFERRED_BROWSER_MODE_ROW);
    }

    it('passes when the project names a mode this host declares available', () => {
      const cwd = makeProject(frontendBrowser(['    mode: headless']));

      const row = preferredRow(cwd, {
        orchestrators: { herdr: false, orca: false },
        browser: { remote: false, headless: true, local: false },
      });

      expect(row?.status).toBe('pass');
    });

    it('reports info when the project has a frontend and names no mode', () => {
      // The gap: this project drives a browser and never said which, so a
      // caller has something to offer the user.
      const row = preferredRow(makeProject(frontendProjectYaml(9222)), HOST_QUIET);

      expect(row?.status).toBe('info');
    });

    it('carries no row at all when the project configures no frontend', () => {
      // Not `info`. A project with no frontend asked for nothing, so there is
      // no preference to report on - and an informational row here is
      // indistinguishable, on status alone, from the genuine gap above.
      const row = preferredRow(makeProject('name: backend-only-project\n'), HOST_QUIET);

      expect(row).toBeUndefined();
    });

    it('carries no row outside a SpecHub project either', () => {
      // No project is no frontend, so the same rule decides it. Nothing here
      // may fall through to a row about a preference nobody could have made.
      expect(preferredRow(noProjectDir(), HOST_QUIET)).toBeUndefined();
    });

    const FAIL_CASES: [string, HostDeclarations, string[]][] = [
      [
        'the host declares no browser mode available at all',
        {
          orchestrators: { herdr: false, orca: false },
          browser: { remote: false, headless: false, local: false },
        },
        ['    mode: remote'],
      ],
      [
        'the project forbids the one mode the host does declare from standing in',
        {
          orchestrators: { herdr: false, orca: false },
          browser: { remote: false, headless: true, local: false },
        },
        ['    mode: remote', '    fallback: none'],
      ],
    ];

    it.each(FAIL_CASES)('still fails when %s', (_case, host, body) => {
      const row = preferredRow(makeProject(frontendBrowser(body)), host);

      expect(row?.status).toBe('fail');
    });
  });

  describe('section 4 keeps its heading and its number with no row to print', () => {
    let backend: ReturnType<typeof runCheck>;
    let frontend: ReturnType<typeof runCheck>;

    beforeAll(() => {
      // A backend project with nothing wrong with it, so the only thing
      // moving in its report is the row that went away.
      const plain = makeProject('name: backend-only-project\n');
      writeDomainMap(plain, DOMAIN_MAP_THREE);
      backend = runCheck({ cwd: plain, path: [emptyPathDir()] });

      const withFrontend = makeProject(frontendProjectYaml(9222));
      writeDomainMap(withFrontend, DOMAIN_MAP_THREE);
      writeAgentBrowserJson(withFrontend, agentBrowserJsonFor(9222));
      writeVerificationKnowledge(withFrontend);
      frontend = runCheck({ cwd: withFrontend, path: [fakeBinDir('agent-browser', 0)] });
    });

    it('prints section 4, heading and number intact, with no rows under it', () => {
      // The heading stays because the numbers are load-bearing: `checkSection`
      // slices by them and a dozen tests above address a check by its number,
      // so a section that vanished when it had nothing to say would renumber
      // every section after it and leave those tests reading the wrong body.
      expect(checkSection(backend.stdout, 4)).toContain(
        "Project's preferred browser mode is available"
      );
      expect(sectionRows(backend.stdout, 4)).toEqual([]);
    });

    it('leaves sections 5, 6 and 7 exactly where they were, and prints no eighth', () => {
      expect(checkSection(backend.stdout, 5)).toContain('Optional axes (informational only)');
      expect(checkSection(backend.stdout, 6)).toContain("This project's files");
      expect(checkSection(backend.stdout, 7)).toContain('Writing style');
      expect(backend.stdout).not.toMatch(/^8\. /m);
    });

    it('exits 0: a section with no rows is not a failure', () => {
      expect(backend.status).toBe(0);
      expect(failLines(backend.stdout)).toEqual([]);
    });

    it('still gives section 4 its one row for a project that configures a frontend', () => {
      expect(sectionRows(frontend.stdout, 4)).toHaveLength(1);
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

  // ---------------------------------------------------------------------
  // Project rows
  //
  // Checks 1 to 5 are all about the machine and the project's browser
  // preference. The project rows below are about the checkout itself: the
  // domain map every project needs, the three rows a project only has once
  // it configures a frontend, and the output style.
  //
  // A project row that fails is a plain failure (exit 1). It never sets the
  // exit code to 2, which stays reserved for a required host axis nobody has
  // declared - until that is answered nothing else can be trusted, and a
  // missing domain map is not that kind of problem.
  //
  // Every test in this section runs under `runCheck`, which supplies an
  // isolated global config, an isolated HOME and a PATH holding only what the
  // test asked for. The default host declarations (`HOST_QUIET`) make checks
  // 1 to 5 pass or go informational, so a FAIL line seen here is the project
  // row being pinned and nothing else.
  // ---------------------------------------------------------------------

  describe('the domain map row (project rows)', () => {
    /** The domain map row's line, wherever in the report it ends up. */
    function domainMapLine(output: string): string | undefined {
      return lineContaining(output, 'domain-map.yaml');
    }

    it('passes and states how many domains the map holds when spechub/domain-map.yaml is present', () => {
      const cwd = makeProject('name: mapped-project\n');
      writeDomainMap(cwd, DOMAIN_MAP_THREE);

      const result = runCheck({ cwd });

      expect(result.status).toBe(0);
      const line = domainMapLine(result.stdout);
      expect(line).toBeDefined();
      expect(line).toContain('PASS');
      // The map holds three domains, and the row is supposed to say so - a
      // map that exists but describes two paths out of forty is the failure
      // mode a bare "exists" line cannot show.
      expect(line).toMatch(/\b3\b/);
    });

    it('fails and says spec sync skips silently when spechub/domain-map.yaml is absent', () => {
      const cwd = makeProject('name: unmapped-project\n');

      const result = runCheck({ cwd });

      expect(result.status).toBe(1);
      const fails = failLines(result.stdout);
      expect(fails).toHaveLength(1);
      expect(fails[0]).toContain('domain-map.yaml');
      // Naming the consequence, not just the missing file: the whole reason
      // this is a failure is that spec sync goes quiet rather than erroring.
      expect(fails[0].toLowerCase()).toContain('spec sync');
      expect(fails[0].toLowerCase()).toContain('living spec');
    });

    it('fails on a malformed spechub/domain-map.yaml rather than crashing with a stack trace', () => {
      const cwd = makeProject('name: broken-map-project\n');
      writeDomainMap(cwd, 'domains: {cli: [unclosed\n');

      const result = runCheck({ cwd });

      // The report must still be printed, with the malformed map as one
      // ordinary failure line in it. A parse error escaping as an unhandled
      // throw would print a stack to stderr and no report at all.
      expect(result.stderr).not.toMatch(/\n\s+at /);
      const fails = failLines(result.stdout);
      expect(fails).toHaveLength(1);
      expect(fails[0]).toContain('domain-map.yaml');
      expect(result.status).toBe(1);
    });

    it('checks the domain map in a project with no frontend, since every project needs one', () => {
      // Same as the absent case above, but stated as its own pin: the domain
      // map row is not one of the frontend-only rows, and a project that
      // drives no browser is still expected to have a map.
      const cwd = makeProject('name: no-frontend-project\n');

      const result = runCheck({ cwd, path: [emptyPathDir()] });

      const line = domainMapLine(result.stdout);
      expect(line).toBeDefined();
      expect(line).toContain('FAIL');
    });
  });

  describe('the domain map row respects workflow.spec_sync (project rows)', () => {
    /** A project that has turned spec sync off, with no domain map written. */
    function specSyncOffProject(): string {
      return makeProject('name: unmapped-project\nworkflow:\n  spec_sync: false\n');
    }

    // One arrangement read two ways: the human report shows the row is no
    // longer a failure, and the JSON shows the status a caller branches on.
    let text: ReturnType<typeof runCheck>;
    let json: ReturnType<typeof runCheck>;

    beforeAll(() => {
      const cwd = specSyncOffProject();
      text = runCheck({ cwd, path: [emptyPathDir()] });
      json = runCheck({ cwd, path: [emptyPathDir()], json: true });
    });

    it('reports the missing domain map as informational when workflow.spec_sync is false', () => {
      // A project that turned spec sync off has no use for the map, so a
      // missing one is the state the user asked for, not a problem found.
      expect(checkJsonRow(json.stdout, CHECK_ROW_IDS.domainMap)?.status).toBe('info');
      expect(failLines(text.stdout)).toEqual([]);
    });

    it('exits 0 with spec sync off and no domain map, since nothing else is wrong', () => {
      expect(text.status).toBe(0);
      expect(json.status).toBe(0);
    });

    it('still says the map is missing, so the cost of turning spec sync back on stays visible', () => {
      const line = lineContaining(text.stdout, 'domain-map.yaml');
      expect(line).toBeDefined();
      expect(line).toContain('INFO');
      // Informational is not silent: someone weighing spec sync back on has
      // to be able to see that the map is the thing they would owe.
      expect(line?.toLowerCase()).toMatch(/missing|absent|not present|no domain map/);
    });

    it('keeps the id domain-map when the row goes informational, so one branch reads both outcomes', () => {
      expect(checkJsonRow(json.stdout, CHECK_ROW_IDS.domainMap)).toBeDefined();
    });

    it.each([
      ['workflow.spec_sync is left unset, since true is the default', 'name: unmapped-project\n'],
      [
        'workflow.spec_sync is explicitly true',
        'name: unmapped-project\nworkflow:\n  spec_sync: true\n',
      ],
    ])('still fails the missing domain map when %s', (_case, yaml) => {
      const result = runCheck({ cwd: makeProject(yaml), path: [emptyPathDir()], json: true });

      expect(checkJsonRow(result.stdout, CHECK_ROW_IDS.domainMap)?.status).toBe('fail');
      expect(result.status).toBe(1);
    });
  });

  /**
   * A map that names no domains fails, the same way an absent one does.
   *
   * The row reports a consequence, not a file: spec sync reads the map, finds
   * the domains it should update, and updates them. A map stating `domains:
   * {}` gives it nothing to find, so spec sync skips silently and the living
   * specs stop being updated - which is word for word the failure the row
   * exists to report. "maps 0 domains", reported as a pass, is that failure
   * described accurately and then filed as success.
   */
  describe('the domain map row when the map names no domains (project rows)', () => {
    /** The two spellings of a `domains` mapping with nothing in it. */
    const NO_DOMAINS: [string, string][] = [
      ['a flow mapping with no entries', 'domains: {}\n'],
      ['a key with nothing after the colon', 'domains:\n'],
    ];

    /** A project stating `body` as its whole domain map. */
    function projectMapping(body: string): string {
      const cwd = makeProject('name: empty-map-project\n');
      writeDomainMap(cwd, body);
      return cwd;
    }

    /**
     * The clause after the first " - " of a check message: what the row says
     * the cost is, as opposed to what it found.
     *
     * Compared rather than hardcoded, so this pins that the two outcomes state
     * the same consequence without also freezing the sentence they state it
     * in - the wording is the report's to improve.
     */
    function consequenceClause(message: string): string {
      const at = message.indexOf(' - ');
      return at === -1 ? '' : message.slice(at + 3);
    }

    /** The domain-map row's message from a JSON check run in `cwd`. */
    function domainMapMessage(cwd: string): string {
      const result = runCheck({ cwd, path: [emptyPathDir()], json: true });
      return checkJsonRow(result.stdout, CHECK_ROW_IDS.domainMap)?.message ?? '';
    }

    it.each(NO_DOMAINS)('fails when the map states %s', (_case, body) => {
      const result = runCheck({ cwd: projectMapping(body), path: [emptyPathDir()], json: true });

      expect(checkJsonRow(result.stdout, CHECK_ROW_IDS.domainMap)?.status).toBe('fail');
      expect(result.status).toBe(1);
    });

    it.each(NO_DOMAINS)(
      'states the consequence a missing map states when the map states %s',
      (_case, body) => {
        const clause = consequenceClause(domainMapMessage(makeProject('name: unmapped\n')));
        expect(clause).not.toBe('');

        expect(consequenceClause(domainMapMessage(projectMapping(body)))).toBe(clause);
      }
    );

    it('does not report zero domains as a count of what it mapped', () => {
      const result = runCheck({ cwd: projectMapping('domains: {}\n'), path: [emptyPathDir()] });

      const line = lineContaining(result.stdout, 'domain-map.yaml');
      expect(line).toBeDefined();
      expect(line).toContain('FAIL');
      // "maps 0 domains" reads as a map doing its job on an empty repo, which
      // is not what a repo with a project.yaml in it is.
      expect(line).not.toMatch(/maps 0 domain/);
    });
  });

  /**
   * `workflow.spec_sync` is read with the same boolean spellings `config set`
   * writes it with.
   *
   * `off`, `on`, `yes` and `no` are boolean words `config set` accepts and
   * turns into `false` or `true` on the way to disk. Written into the file by
   * hand they are strings, which the reader ignores - so the file says spec
   * sync is off, the check treats it as on, and the row demands a map that
   * nothing is going to read. One command's vocabulary has to be the other's,
   * or the file means one thing when the tool wrote it and another when the
   * user did.
   *
   * Pinned through the domain map row because that is what the flag changes:
   * a project with no map fails while spec sync is on and goes informational
   * once it is off.
   */
  describe('the domain map row honours the boolean words config set takes (project rows)', () => {
    /** The domain-map row's status for a project stating `spec_sync: <word>` and holding no map. */
    function rowStatus(word: string): string | undefined {
      const cwd = makeProject(`name: worded-project\nworkflow:\n  spec_sync: ${word}\n`);
      const result = runCheck({ cwd, path: [emptyPathDir()], json: true });
      return checkJsonRow(result.stdout, CHECK_ROW_IDS.domainMap)?.status;
    }

    it.each(['false', 'off', 'no', 'FALSE', 'Off', 'NO'])(
      'reads %s as spec sync being off, so the missing map is informational',
      word => {
        expect(rowStatus(word)).toBe('info');
      }
    );

    it.each(['true', 'on', 'yes', 'TRUE', 'On', 'YES'])(
      'reads %s as spec sync being on, so the missing map still fails',
      word => {
        expect(rowStatus(word)).toBe('fail');
      }
    );

    it('leaves a word that is not one of the six reading as the default', () => {
      // The guard on the two above: a reader that took any non-empty string as
      // a stated value would turn a typo into a decision. `true` is the
      // documented default, so an unreadable value keeps the map owed.
      expect(rowStatus('maybe')).toBe('fail');
    });
  });

  describe('the frontend-only project rows (project rows)', () => {
    /** PATH holding an `agent-browser` executable and nothing else. */
    function agentBrowserOnPath(): string[] {
      return [fakeBinDir('agent-browser', 0)];
    }

    /**
     * A project that configures a frontend with every project row satisfied:
     * a domain map, an `agent-browser.json` agreeing with the project's
     * `frontend.browser.cdp_port`, and a verification knowledge base.
     */
    function healthyFrontendProject(cdpPort = 9222): string {
      const root = makeProject(frontendProjectYaml(cdpPort));
      writeDomainMap(root, DOMAIN_MAP_THREE);
      writeAgentBrowserJson(root, agentBrowserJsonFor(cdpPort));
      writeVerificationKnowledge(root);
      return root;
    }

    /** A frontend project with everything but `agent-browser.json`. */
    function frontendProjectWithoutBrowserJson(cdpPort = 9222): string {
      const root = makeProject(frontendProjectYaml(cdpPort));
      writeDomainMap(root, DOMAIN_MAP_THREE);
      writeVerificationKnowledge(root);
      return root;
    }

    describe('every frontend row satisfied', () => {
      // One run, several assertions: `runCheck` spawns a real process, so the
      // healthy case is arranged once and read four ways.
      let result: ReturnType<typeof runCheck>;

      beforeAll(() => {
        result = runCheck({
          cwd: healthyFrontendProject(),
          path: agentBrowserOnPath(),
        });
      });

      it('exits 0 with no failing line anywhere in the report', () => {
        expect(failLines(result.stdout)).toEqual([]);
        expect(result.status).toBe(0);
      });

      it('passes the agent-browser row when the tool is on PATH', () => {
        // The tool row, told from the config-file row by the file row naming
        // `agent-browser.json` - the tool's own name is a prefix of it.
        const line = result.stdout
          .split('\n')
          .find(l => l.includes('agent-browser') && !l.includes('agent-browser.json'));
        expect(line).toBeDefined();
        expect(line).toContain('PASS');
      });

      it('passes the agent-browser.json row when its port agrees with frontend.browser.cdp_port', () => {
        const line = lineContaining(result.stdout, 'agent-browser.json');
        expect(line).toBeDefined();
        expect(line).toContain('PASS');
      });

      it('passes the verification knowledge base row when it exists under frontend.helpers_dir', () => {
        const line = lineContaining(result.stdout, 'fe/helpers');
        expect(line).toBeDefined();
        expect(line).toContain('PASS');
      });
    });

    it('fails and names the install command when agent-browser is not on PATH', () => {
      const cwd = healthyFrontendProject();

      const result = runCheck({ cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      const fails = failLines(result.stdout);
      expect(fails).toHaveLength(1);
      expect(fails[0]).toContain('agent-browser');
      expect(fails[0]).toContain('npm install -g agent-browser');
    });

    it('fails when agent-browser.json is absent from the project root', () => {
      const cwd = frontendProjectWithoutBrowserJson();

      const result = runCheck({ cwd, path: agentBrowserOnPath() });

      expect(result.status).toBe(1);
      const fails = failLines(result.stdout);
      expect(fails).toHaveLength(1);
      expect(fails[0]).toContain('agent-browser.json');
    });

    it('fails and states both ports when agent-browser.json disagrees with frontend.browser.cdp_port', () => {
      const cwd = frontendProjectWithoutBrowserJson(9222);
      writeAgentBrowserJson(cwd, agentBrowserJsonFor(19988));

      const result = runCheck({ cwd, path: agentBrowserOnPath() });

      expect(result.status).toBe(1);
      const fails = failLines(result.stdout);
      expect(fails).toHaveLength(1);
      // Both numbers, because "they disagree" is not actionable on its own -
      // the user has to know which file to change to which value.
      expect(fails[0]).toContain('9222');
      expect(fails[0]).toContain('19988');
    });

    it('fails on malformed JSON in agent-browser.json rather than crashing', () => {
      const cwd = frontendProjectWithoutBrowserJson();
      writeAgentBrowserJson(cwd, '{ "cdp": ');

      const result = runCheck({ cwd, path: agentBrowserOnPath() });

      expect(result.stderr).not.toMatch(/\n\s+at /);
      const fails = failLines(result.stdout);
      expect(fails).toHaveLength(1);
      expect(fails[0]).toContain('agent-browser.json');
      expect(result.status).toBe(1);
    });

    it('fails when nothing exists at the path frontend.helpers_dir names', () => {
      const root = makeProject(frontendProjectYaml(9222));
      writeDomainMap(root, DOMAIN_MAP_THREE);
      writeAgentBrowserJson(root, agentBrowserJsonFor(9222));

      const result = runCheck({ cwd: root, path: agentBrowserOnPath() });

      expect(result.status).toBe(1);
      const fails = failLines(result.stdout);
      expect(fails).toHaveLength(1);
      expect(fails[0]).toContain('fe/helpers');
    });

    it('fails a project with no frontend for none of the frontend-only rows, with nothing at all on PATH', () => {
      // agent-browser is not installed, there is no agent-browser.json and
      // no helpers directory - and none of that is this project's business,
      // because it configures no frontend to verify.
      const cwd = makeProject('name: no-frontend-project\n');
      writeDomainMap(cwd, DOMAIN_MAP_THREE);

      const result = runCheck({ cwd, path: [emptyPathDir()] });

      expect(failLines(result.stdout)).toEqual([]);
      expect(result.status).toBe(0);
    });
  });

  describe('the frontend verification row (project rows)', () => {
    /** PATH holding an `agent-browser` executable and nothing else. */
    function agentBrowserOnPath(): string[] {
      return [fakeBinDir('agent-browser', 0)];
    }

    /**
     * A frontend project with every other project row satisfied, so the
     * verification row is the only thing moving. `workflow` is appended
     * verbatim, letting a test state the key true, state it false, or state
     * no workflow block at all.
     */
    function verificationProject(workflow = ''): string {
      const root = makeProject(frontendProjectYaml(9222) + workflow);
      writeDomainMap(root, DOMAIN_MAP_THREE);
      writeAgentBrowserJson(root, agentBrowserJsonFor(9222));
      writeVerificationKnowledge(root);
      return root;
    }

    /** The frontend verification row's line, wherever in the report it ends up. */
    function verificationLine(output: string): string | undefined {
      return output.split('\n').find(line => /frontend[_ ]verification/i.test(line));
    }

    describe('a frontend project with verification turned off', () => {
      // One arrangement, four assertions: `runCheck` spawns a real process,
      // so the off case is arranged once and read in both output modes.
      let text: ReturnType<typeof runCheck>;
      let json: ReturnType<typeof runCheck>;

      beforeAll(() => {
        const cwd = verificationProject('workflow:\n  frontend_verification: false\n');
        text = runCheck({ cwd, path: agentBrowserOnPath() });
        json = runCheck({ cwd, path: agentBrowserOnPath(), json: true });
      });

      it('reports frontend-verification as informational when the project has a frontend and the flag is false', () => {
        expect(checkJsonRow(json.stdout, CHECK_ROW_IDS.frontendVerification)?.status).toBe('info');
      });

      it('names workflow.frontend_verification on the line, so the key to change is readable', () => {
        const line = verificationLine(text.stdout);
        expect(line).toBeDefined();
        expect(line).toContain('INFO');
      });

      it("prints the row among the project's own files (check 6), not in a section of its own", () => {
        expect(verificationLine(checkSection(text.stdout, 6))).toBeDefined();
      });

      it('leaves the exit code at 0, because an informational row is not a failure', () => {
        expect(failLines(text.stdout)).toEqual([]);
        expect(text.status).toBe(0);
        expect(json.status).toBe(0);
      });
    });

    it.each([
      ['the project states no workflow block at all', ''],
      ['workflow states other keys but not frontend_verification', 'workflow:\n  spec_sync: true\n'],
    ])('reports frontend-verification as informational when %s', (_case, workflow) => {
      // Anything other than the literal true leaves verification off, so an
      // absent key reads the same as one written false.
      const result = runCheck({
        cwd: verificationProject(workflow),
        path: agentBrowserOnPath(),
        json: true,
      });

      expect(checkJsonRow(result.stdout, CHECK_ROW_IDS.frontendVerification)?.status).toBe('info');
    });

    it('passes frontend-verification when the project has a frontend and workflow.frontend_verification is true', () => {
      const cwd = verificationProject('workflow:\n  frontend_verification: true\n');

      const result = runCheck({ cwd, path: agentBrowserOnPath(), json: true });

      expect(checkJsonRow(result.stdout, CHECK_ROW_IDS.frontendVerification)?.status).toBe('pass');
      expect(result.status).toBe(0);
    });

    it('carries no frontend verification row for a project that configures no frontend', () => {
      // Nothing to verify means there is no setting to turn on, so the row
      // is absent rather than informational - the same rule the other
      // frontend-only rows already follow.
      const cwd = makeProject('name: no-frontend-project\n');
      writeDomainMap(cwd, DOMAIN_MAP_THREE);

      const result = runCheck({ cwd, path: [emptyPathDir()], json: true });

      expect(checkJsonRow(result.stdout, CHECK_ROW_IDS.frontendVerification)).toBeUndefined();
      expect(verificationLine(result.stdout)).toBeUndefined();
    });
  });

  describe('a directory that is not a SpecHub project (project rows)', () => {
    it('says the directory is not a SpecHub project instead of failing every project row', () => {
      const cwd = noProjectDir();

      const result = runCheck({ cwd, path: [emptyPathDir()] });

      // There is no project.yaml, so there is no domain map to want, no
      // frontend to configure and no rows to fail. Saying so once is the
      // useful answer; five failures about files a non-project was never
      // going to have is noise.
      expect(failLines(result.stdout)).toEqual([]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/\bno(t)?\b[^\n]{0,20}SpecHub project/i);
    });
  });

  describe('the output style row (project rows)', () => {
    /** The output style row's line, wherever in the report it ends up. */
    function outputStyleLine(output: string): string | undefined {
      return output.split('\n').find(line => /output ?style/i.test(line));
    }

    /** A project with nothing wrong with it, so the output style row is the only thing moving. */
    function styledProject(): string {
      const root = makeProject('name: styled-project\n');
      writeDomainMap(root, DOMAIN_MAP_THREE);
      return root;
    }

    it('reports the style ~/.claude/settings.json selects when it is the only file that sets one', () => {
      const home = fakeHome();
      writeClaudeSettings(home, 'settings.json', outputStyleSettings(SPECHUB_OUTPUT_STYLE));

      const result = runCheck({ cwd: styledProject(), home });

      expect(result.status).toBe(0);
      const line = outputStyleLine(result.stdout);
      expect(line).toBeDefined();
      expect(line).toContain(SPECHUB_OUTPUT_STYLE);
      // The status carries the answer, not just the prose: a caller deciding
      // whether to offer the writing style has to be able to read "already
      // selected" off the outcome alone.
      expect(line).toContain('PASS');
    });

    it('reports .claude/settings.json winning over ~/.claude/settings.json', () => {
      const home = fakeHome();
      writeClaudeSettings(home, 'settings.json', outputStyleSettings('user-file-style'));
      const cwd = styledProject();
      writeClaudeSettings(cwd, 'settings.json', outputStyleSettings('project-file-style'));

      const result = runCheck({ cwd, home });

      const line = outputStyleLine(result.stdout);
      expect(line).toBeDefined();
      expect(line).toContain('project-file-style');
      // The losing value must not be reported as the one in force - that is
      // the whole content of "which one wins".
      expect(line).not.toContain('user-file-style');
    });

    it('reports .claude/settings.local.json winning over .claude/settings.json', () => {
      const home = fakeHome();
      const cwd = styledProject();
      writeClaudeSettings(cwd, 'settings.json', outputStyleSettings('project-file-style'));
      writeClaudeSettings(cwd, 'settings.local.json', outputStyleSettings('local-file-style'));

      const result = runCheck({ cwd, home });

      const line = outputStyleLine(result.stdout);
      expect(line).toBeDefined();
      expect(line).toContain('local-file-style');
      expect(line).not.toContain('project-file-style');
      // Names the file that won, not only the value, so the user knows where
      // to go and change it.
      expect(line).toContain('settings.local.json');
    });

    it('reports that nothing sets outputStyle when no settings file names one', () => {
      const result = runCheck({ cwd: styledProject(), home: fakeHome() });

      expect(result.status).toBe(0);
      const line = outputStyleLine(result.stdout);
      expect(line).toBeDefined();
      expect(line).toContain('INFO');
      expect(line).toMatch(/not set|none|no output style/i);
    });

    it('stays informational, not a failure, when a settings file selects some style other than the plugin one', () => {
      const home = fakeHome();
      writeClaudeSettings(home, 'settings.json', outputStyleSettings('some-other-style'));

      const result = runCheck({ cwd: styledProject(), home });

      // The plugin never forces its own style on, so a project that has
      // chosen something else is a fact to report, not a problem to fix.
      expect(failLines(result.stdout)).toEqual([]);
      expect(result.status).toBe(0);
      const line = outputStyleLine(result.stdout);
      expect(line).toBeDefined();
      expect(line).toContain('INFO');
      expect(line).toContain('some-other-style');
    });

    it('reports a malformed settings file rather than crashing on it', () => {
      const home = fakeHome();
      writeClaudeSettings(home, 'settings.json', '{ "outputStyle": ');

      const result = runCheck({ cwd: styledProject(), home });

      expect(result.stderr).not.toMatch(/\n\s+at /);
      const line = outputStyleLine(result.stdout);
      expect(line).toBeDefined();
      expect(line).toContain('settings.json');
      expect(line).toMatch(/could not|cannot|unreadable|malformed|invalid|not valid/i);
      // Unreadable is not the same as unset, and neither is a required-axis
      // gap, so this can never be the exit code reserved for one.
      expect(result.status).not.toBe(2);
    });

    it.each([
      ['the spechub writing style is selected', 'pass', outputStyleSettings(SPECHUB_OUTPUT_STYLE)],
      ['a different style is selected', 'info', outputStyleSettings('some-other-style')],
      ['no settings file names a style', 'info', ''],
      ['a settings file will not parse', 'fail', '{ "outputStyle": '],
    ])('reports %s as %s in --json', (_case, status, body) => {
      // The empty body means "write no settings file at all"; every other
      // value is written verbatim to ~/.claude/settings.json.
      const home = fakeHome();
      if (body) writeClaudeSettings(home, 'settings.json', body);

      const result = runCheck({ cwd: styledProject(), home, json: true });

      expect(checkJsonRow(result.stdout, CHECK_ROW_IDS.outputStyle)?.status).toBe(status);
    });

    it('passes on the spechub writing style even when it wins only by precedence over another file', () => {
      const home = fakeHome();
      writeClaudeSettings(home, 'settings.json', outputStyleSettings('some-other-style'));
      const cwd = styledProject();
      writeClaudeSettings(cwd, 'settings.local.json', outputStyleSettings(SPECHUB_OUTPUT_STYLE));

      const result = runCheck({ cwd, home });

      const line = outputStyleLine(result.stdout);
      expect(line).toBeDefined();
      expect(line).toContain('PASS');
      expect(line).toContain(SPECHUB_OUTPUT_STYLE);
      // Passing does not stop the row naming the file that won - which style
      // is on is only actionable alongside where to go and change it.
      expect(line).toContain('settings.local.json');
      expect(line).not.toContain('some-other-style');
      expect(result.status).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // The impeccable row (project rows)
  //
  // impeccable is a separate Claude Code plugin, installed on the machine
  // rather than stated in the project. `check` reports whether it is there
  // and whether it is new enough, and it reports by reading the two files
  // Claude Code writes - it never runs impeccable itself.
  //
  // The row has three outcomes and no fourth:
  //   PASS  - installed at major 4 or later. The message names the version.
  //   INFO  - installed and older than that, or installed with a version
  //           that cannot be read. The message names what was found.
  //   absent - not installed. No row at all, in either output mode.
  //
  // It never FAILS, and it never moves the exit code. impeccable is optional,
  // so a project that has never heard of it must not be told it has a
  // problem, and a script running `check` in CI must not start failing the
  // day someone uninstalls a plugin.
  // ---------------------------------------------------------------------
  describe('the impeccable row (project rows)', () => {
    /** A project with nothing wrong with it, so the impeccable row is the only thing moving. */
    function impeccableProject(): string {
      const root = makeProject('name: impeccable-project\n');
      writeDomainMap(root, DOMAIN_MAP_THREE);
      return root;
    }

    /**
     * `config check --json` against a clean project and a HOME installing
     * `install`, or installing nothing when `install` is null.
     */
    function runWith(install: ImpeccableInstall | null, json = true) {
      return runCheck({
        cwd: impeccableProject(),
        home: install ? homeWithImpeccable(install) : fakeHome(),
        json,
      });
    }

    /** The impeccable row of one `--json` run, or undefined when the report carries none. */
    function rowOf(result: { stdout: string }): ConfigCheckJsonRow | undefined {
      return checkJsonRow(result.stdout, CHECK_ROW_IDS.impeccable);
    }

    /** The impeccable row's message, refusing a report that carries no row. */
    function messageOf(result: { stdout: string }): string {
      const row = rowOf(result);
      expect(row, 'the report carries no impeccable row').toBeDefined();
      return (row as ConfigCheckJsonRow).message;
    }

    describe('an installed impeccable', () => {
      it.each([['4.0.0'], ['4.2.0'], ['10.1.2']])(
        'passes on %s, which is major 4 or later',
        version => {
          // 10 is here because it is the version a comparison done on the
          // strings rather than on the numbers gets wrong: "10" sorts before
          // "4", so a string comparison calls a newer plugin too old.
          const result = runWith({ registryVersion: version });

          expect(rowOf(result)?.status).toBe('pass');
          expect(messageOf(result)).toContain(version);
        }
      );

      it.each([['3.9.0'], ['0.1.0']])(
        'reports %s as informational, because it is older than major 4',
        version => {
          const result = runWith({ registryVersion: version });

          expect(rowOf(result)?.status).toBe('info');
          // Both halves of the answer: what is installed, and what SpecHub
          // wanted. A message naming only one of them leaves the reader to
          // go and look the other up.
          expect(messageOf(result)).toContain(version);
          expect(messageOf(result)).toContain(IMPECCABLE_MIN_MAJOR);
        }
      );

      it('is detected under a marketplace name other than its own', () => {
        // The registry key is `<plugin>@<marketplace>`, and the marketplace
        // half is wherever the user installed from. Matching the whole key
        // would find only one of the ways the same plugin can arrive.
        const result = runWith({ registryVersion: '4.2.0', marketplace: 'some-mirror' });

        expect(rowOf(result)?.status).toBe('pass');
        expect(messageOf(result)).toContain('4.2.0');
      });
    });

    describe("the manifest, not the registry, states the installed version", () => {
      it('reports the manifest version when the registry states a newer one', () => {
        const result = runWith({ registryVersion: '4.2.0', manifestVersion: '3.9.0' });

        expect(rowOf(result)?.status).toBe('info');
        expect(messageOf(result)).toContain('3.9.0');
        // The registry's number is the stale one, so repeating it would tell
        // the user a version they do not have.
        expect(messageOf(result)).not.toContain('4.2.0');
      });

      it('reports the manifest version when the registry states an older one', () => {
        const result = runWith({ registryVersion: '3.9.0', manifestVersion: '4.2.0' });

        expect(rowOf(result)?.status).toBe('pass');
        expect(messageOf(result)).toContain('4.2.0');
      });
    });

    describe('impeccable is not installed', () => {
      it('carries no impeccable row when the registry file does not exist', () => {
        const result = runWith(null);

        expect(rowOf(result)).toBeUndefined();
      });

      it('carries no impeccable row when the registry names other plugins only', () => {
        const home = fakeHome();
        writeInstalledPlugins(join(home, '.claude'), [
          {
            key: 'document-skills@anthropic-agent-skills',
            installPath: pluginInstallDir({ name: 'document-skills', version: '1.0.0' }),
            version: '1.0.0',
          },
        ]);

        const result = runCheck({ cwd: impeccableProject(), home, json: true });

        expect(rowOf(result)).toBeUndefined();
      });

      it('names impeccable nowhere in the human report either', () => {
        // A row absent from `--json` and printed to a human anyway would be
        // two reports rather than two renderings of one.
        const result = runWith(null, false);

        expect(result.stdout).not.toMatch(/impeccable/i);
      });
    });

    describe('an install whose version cannot be read', () => {
      it.each([
        ['the manifest file is missing', 'no-manifest'],
        ['the manifest states no version', 'no-version'],
      ] as const)('reports it as informational when %s', (_case, broken) => {
        const result = runWith({ registryVersion: '4.2.0', broken });

        // Informational, not passing: an unreadable version is not evidence
        // of a new enough one. Informational, not failing: the plugin is
        // still optional, and a broken install is not the project's problem.
        expect(rowOf(result)?.status).toBe('info');
        expect(messageOf(result)).toMatch(/could not|cannot|unreadable|unknown|no version/i);
      });

      it('says nothing about a version it never read', () => {
        // The registry carries a version too, and it is not the authority.
        // Printing it here would report a version as installed on the
        // strength of the one file that can be stale.
        const result = runWith({ registryVersion: '4.2.0', broken: 'no-manifest' });

        expect(messageOf(result)).not.toContain('4.2.0');
      });
    });

    describe('the row never fails and never moves the exit code', () => {
      it.each([
        ['not installed at all', null],
        ['installed and new enough', { registryVersion: '4.2.0' }],
        ['installed and too old', { registryVersion: '3.9.0' }],
        ['installed with no readable version', { registryVersion: '4.2.0', broken: 'no-manifest' }],
      ] as [string, ImpeccableInstall | null][])(
        'exits 0 with no FAIL line when impeccable is %s',
        (_case, install) => {
          const cwd = impeccableProject();
          const home = install ? homeWithImpeccable(install) : fakeHome();

          const text = runCheck({ cwd, home, json: false });
          const json = runCheck({ cwd, home, json: true });

          expect(failLines(text.stdout)).toEqual([]);
          expect(text.status).toBe(0);
          expect(json.status).toBe(0);
          // An install produces a row, and no arrangement produces a failing
          // one. Asserting both together is what stops "never fails" from
          // being satisfied by a row that is never printed.
          if (install) expect(rowOf(json)).toBeDefined();
          expect(rowOf(json)?.status).not.toBe('fail');
        }
      );

      it('leaves every other row exactly as it was when impeccable is installed', () => {
        // The impeccable row is the only difference the install may make. A
        // row that changed status alongside it would be this check reaching
        // into an answer that is not its own.
        const cwd = impeccableProject();
        const withPlugin = runCheck({
          cwd,
          home: homeWithImpeccable({ registryVersion: '4.2.0' }),
          json: true,
        });
        const without = runCheck({ cwd, home: fakeHome(), json: true });

        const others = (result: { stdout: string }): ConfigCheckJsonRow[] =>
          (JSON.parse(result.stdout) as ConfigCheckJson).checks.filter(
            check => check.id !== CHECK_ROW_IDS.impeccable
          );

        expect(rowOf(withPlugin)).toBeDefined();
        expect(others(withPlugin)).toEqual(others(without));
        expect(withPlugin.status).toBe(without.status);
      });
    });

    describe('where the installed plugins are read from', () => {
      it('reads CLAUDE_CONFIG_DIR when it is set, not ~/.claude', () => {
        const configDir = mkdtempSync(join(tmpdir(), 'spechub-claude-config-'));
        installImpeccable(configDir, { registryVersion: '4.2.0' });

        const result = runCheck({
          cwd: impeccableProject(),
          home: fakeHome(),
          json: true,
          env: { CLAUDE_CONFIG_DIR: configDir },
        });

        expect(rowOf(result)?.status).toBe('pass');
        expect(messageOf(result)).toContain('4.2.0');
      });

      it('reads CLAUDE_CONFIG_DIR instead of ~/.claude when both hold an install', () => {
        // Not "as well as": the variable moves the config root, so a HOME
        // install is not a second place to look.
        const configDir = mkdtempSync(join(tmpdir(), 'spechub-claude-config-'));
        installImpeccable(configDir, { registryVersion: '3.9.0' });

        const result = runCheck({
          cwd: impeccableProject(),
          home: homeWithImpeccable({ registryVersion: '4.2.0' }),
          json: true,
          env: { CLAUDE_CONFIG_DIR: configDir },
        });

        expect(rowOf(result)?.status).toBe('info');
        expect(messageOf(result)).toContain('3.9.0');
      });

      it('falls back to ~/.claude when CLAUDE_CONFIG_DIR is set to an empty value', () => {
        const result = runCheck({
          cwd: impeccableProject(),
          home: homeWithImpeccable({ registryVersion: '4.2.0' }),
          json: true,
          env: { CLAUDE_CONFIG_DIR: '' },
        });

        expect(rowOf(result)?.status).toBe('pass');
      });
    });

    // -------------------------------------------------------------------
    // A plugin the user switched off
    //
    // Claude Code keeps two records under its config root, and a plugin has
    // to satisfy both to run:
    //
    //   plugins/installed_plugins.json - what is on disk
    //   settings.json                  - which of it is switched on, as an
    //      `enabledPlugins` object keyed the same `<plugin>@<marketplace>`
    //      way the registry is
    //
    // A user who switched impeccable off has an install Claude Code will
    // never load, so a row calling it installed would report a plugin that
    // cannot run. Off is off: no row, exactly as if it were never installed.
    //
    // On is the default, and the default is what every other arrangement
    // means - a key set true, a key that is not there, an `enabledPlugins`
    // that is not there, and a settings file that is missing or unreadable.
    // -------------------------------------------------------------------
    describe('a plugin switched off in settings.json (project rows)', () => {
      /**
       * The marketplace impeccable is installed from here, and the whole
       * registry key that makes.
       *
       * Both are written out rather than one built from the other, because
       * the key is what Claude Code writes into two separate files, and
       * matching it across them is the whole behaviour under test.
       */
      const MARKETPLACE = 'pbakaus';
      const PLUGIN_KEY = 'impeccable@pbakaus';

      /** The version installed throughout this block, new enough to pass on its own. */
      const INSTALLED_VERSION = '4.2.0';

      /** Write `body` verbatim as `<root>/settings.json`, creating `root` as needed. */
      function writeSettings(root: string, body: string): void {
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, 'settings.json'), body);
      }

      /** A `settings.json` body whose `enabledPlugins` is exactly `enabled`. */
      function enabledPluginsBody(enabled: Record<string, boolean>): string {
        return JSON.stringify({ enabledPlugins: enabled }, null, 2) + '\n';
      }

      /**
       * A HOME holding impeccable installed from `MARKETPLACE`, with `body`
       * written verbatim as its `settings.json`.
       *
       * A null body writes no settings file at all, which is the state a
       * machine that has never switched a plugin off is in.
       */
      function homeWithSettings(body: string | null): string {
        const home = homeWithImpeccable({
          registryVersion: INSTALLED_VERSION,
          marketplace: MARKETPLACE,
        });
        if (body !== null) writeSettings(join(home, '.claude'), body);
        return home;
      }

      it('carries no impeccable row when settings.json sets its key false', () => {
        const result = runCheck({
          cwd: impeccableProject(),
          home: homeWithSettings(enabledPluginsBody({ [PLUGIN_KEY]: false })),
          json: true,
        });

        expect(rowOf(result)).toBeUndefined();
      });

      it('names impeccable nowhere in the human report either when its key is false', () => {
        // Absent from `--json` and printed to a human anyway would be two
        // reports rather than two renderings of one.
        const result = runCheck({
          cwd: impeccableProject(),
          home: homeWithSettings(enabledPluginsBody({ [PLUGIN_KEY]: false })),
          json: false,
        });

        expect(result.stdout).not.toMatch(/impeccable/i);
      });

      it.each([
        ['the key is set true', enabledPluginsBody({ [PLUGIN_KEY]: true })],
        [
          'enabledPlugins switches other plugins off only',
          enabledPluginsBody({ 'document-skills@anthropic-agent-skills': false }),
        ],
        ['the false key names a different marketplace', enabledPluginsBody({ 'impeccable@other': false })],
        ['settings.json states no enabledPlugins at all', '{}\n'],
        ['settings.json will not parse', '{ "enabledPlugins": '],
        ['there is no settings.json', null],
      ] as [string, string | null][])('keeps the row when %s', (_case, body) => {
        // Switched on is the default, so anything short of a false key under
        // this plugin's own key leaves the plugin running.
        const result = runCheck({
          cwd: impeccableProject(),
          home: homeWithSettings(body),
          json: true,
        });

        expect(rowOf(result)?.status).toBe('pass');
        expect(messageOf(result)).toContain(INSTALLED_VERSION);
      });

      describe('where the settings file is read from', () => {
        it('reads settings.json from CLAUDE_CONFIG_DIR, so a false key there carries the row away', () => {
          // The registry and the settings file are two halves of one config
          // root. Reading one from the variable and the other from HOME would
          // answer from two machines' worth of state at once.
          const configDir = mkdtempSync(join(tmpdir(), 'spechub-claude-config-'));
          installImpeccable(configDir, {
            registryVersion: INSTALLED_VERSION,
            marketplace: MARKETPLACE,
          });
          writeSettings(configDir, enabledPluginsBody({ [PLUGIN_KEY]: false }));

          const result = runCheck({
            cwd: impeccableProject(),
            home: homeWithSettings(enabledPluginsBody({ [PLUGIN_KEY]: true })),
            json: true,
            env: { CLAUDE_CONFIG_DIR: configDir },
          });

          expect(rowOf(result)).toBeUndefined();
        });

        it('ignores ~/.claude/settings.json when CLAUDE_CONFIG_DIR is set', () => {
          const configDir = mkdtempSync(join(tmpdir(), 'spechub-claude-config-'));
          installImpeccable(configDir, {
            registryVersion: INSTALLED_VERSION,
            marketplace: MARKETPLACE,
          });

          const result = runCheck({
            cwd: impeccableProject(),
            home: homeWithSettings(enabledPluginsBody({ [PLUGIN_KEY]: false })),
            json: true,
            env: { CLAUDE_CONFIG_DIR: configDir },
          });

          expect(rowOf(result)?.status).toBe('pass');
          expect(messageOf(result)).toContain(INSTALLED_VERSION);
        });
      });
    });

    it('prints the installed version in the human report too', () => {
      const result = runWith({ registryVersion: '4.2.0' }, false);

      const line = result.stdout.split('\n').find(text => /impeccable/i.test(text));
      expect(line).toBeDefined();
      expect(line).toContain('PASS');
      expect(line).toContain('4.2.0');
    });

    it('never runs impeccable, however installed it is', () => {
      // Detection is two file reads. Running the plugin to ask it its
      // version would make `check` slow, and would make it depend on a
      // command that a broken install may not be able to start at all.
      const marker = join(mkdtempSync(join(tmpdir(), 'spechub-impeccable-marker-')), 'ran');
      const binDir = mkdtempSync(join(tmpdir(), 'spechub-fake-bin-'));
      const command = join(binDir, IMPECCABLE_PLUGIN);
      writeFileSync(command, `#!/bin/sh\necho ran > '${marker}'\nexit 0\n`);
      chmodSync(command, 0o755);

      const result = runCheck({
        cwd: impeccableProject(),
        home: homeWithImpeccable({ registryVersion: '4.2.0' }),
        path: [binDir],
        json: true,
      });

      expect(rowOf(result)?.status).toBe('pass');
      expect(existsSync(marker)).toBe(false);
    });
  });

  describe('project rows and the exit code', () => {
    it('exits 1, never 2, when a project row fails and every required host axis is declared', () => {
      const cwd = makeProject('name: unmapped-project\n');

      const result = runCheck({ cwd });

      expect(failLines(result.stdout)).toHaveLength(1);
      expect(result.status).toBe(1);
    });

    it('exits 2 when a required host axis is unset and a project row fails too (unset still wins)', () => {
      // A frontend project makes all three browser axes required; declaring
      // only the orchestrators leaves them unset. The domain map is missing
      // at the same time, so a project row fails alongside.
      const cwd = makeProject(frontendProjectYaml(9222));

      const result = runCheck({
        cwd,
        host: { orchestrators: { herdr: false, orca: false } },
        path: [emptyPathDir()],
      });

      expect(failLines(result.stdout).join('\n')).toContain('domain-map.yaml');
      expect(result.status).toBe(2);
    });
  });

  // ---------------------------------------------------------------------
  // spechub config check --json
  //
  // One JSON object on stdout and nothing else, indented by two spaces, the
  // same way `config show --json` and `config browser-mode --json` print.
  //
  // The object is `{ checks: [ { id, status, message } ] }`. `id` is the
  // stable handle: a caller asks "did `domain-map` fail" rather than reading
  // the sentence, so identifiers are asserted by value here while `message`
  // is only ever asserted to exist and be non-empty.
  //
  // The exit code does not depend on the output format. `--json` changes how
  // the report is written, not what it concluded.
  // ---------------------------------------------------------------------

  describe('spechub config check --json', () => {
    /** The row with `id`, or undefined. */
    function row(json: ConfigCheckJson, id: string): ConfigCheckJsonRow | undefined {
      return json.checks.find(check => check.id === id);
    }

    describe('a healthy project with a frontend', () => {
      // The run is shared (one spawned process for six assertions), but the
      // parse is not: parsing in `beforeAll` would turn a command that does
      // not print JSON into a suite-level error and hide which assertion was
      // being made.
      let result: ReturnType<typeof runCheck>;
      const json = (): ConfigCheckJson => JSON.parse(result.stdout) as ConfigCheckJson;

      beforeAll(() => {
        const root = makeProject(frontendProjectYaml(9222));
        writeDomainMap(root, DOMAIN_MAP_THREE);
        writeAgentBrowserJson(root, agentBrowserJsonFor(9222));
        writeVerificationKnowledge(root);

        result = runCheck({
          cwd: root,
          path: [fakeBinDir('agent-browser', 0)],
          json: true,
        });
      });

      it('accepts --json at all, rather than rejecting it as an unknown option', () => {
        expect(result.stderr).not.toContain('unknown option');
        expect(result.status).toBe(0);
      });

      it('prints exactly one JSON object on stdout and nothing else', () => {
        // Reserializing and comparing catches both a second object and any
        // stray human line printed alongside the JSON.
        expect(result.stdout.trim()).toBe(JSON.stringify(json(), null, 2));
        expect(result.stdout).not.toMatch(/^\d+\. /m);
      });

      it('indents the JSON by two spaces, the same as config show --json', () => {
        expect(result.stdout).toContain('\n  "checks"');
      });

      it('gives every row a stable identifier, a status and the human-readable message', () => {
        expect(json().checks.length).toBeGreaterThan(0);
        for (const check of json().checks) {
          expect(typeof check.id).toBe('string');
          expect(check.id).not.toBe('');
          expect(['pass', 'fail', 'info']).toContain(check.status);
          expect(typeof check.message).toBe('string');
          expect(check.message).not.toBe('');
        }
      });

      it('gives every row an identifier no other row shares, so branching on one is unambiguous', () => {
        const ids = json().checks.map(check => check.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it('carries all six project rows under their contract identifiers, the four file rows passing', () => {
        const parsed = json();
        // Every id but impeccable's. That row reports on a plugin installed
        // on the MACHINE rather than on anything in the project, and this
        // arrangement gives the CLI a HOME with no plugins installed at all,
        // so the row is legitimately absent here.
        const projectRows = Object.values(CHECK_ROW_IDS).filter(
          id => id !== CHECK_ROW_IDS.impeccable
        );
        for (const id of projectRows) {
          expect(row(parsed, id), `no row with id "${id}"`).toBeDefined();
        }
        expect(row(parsed, CHECK_ROW_IDS.impeccable)).toBeUndefined();
        expect(row(parsed, CHECK_ROW_IDS.domainMap)?.status).toBe('pass');
        expect(row(parsed, CHECK_ROW_IDS.agentBrowser)?.status).toBe('pass');
        expect(row(parsed, CHECK_ROW_IDS.agentBrowserJson)?.status).toBe('pass');
        expect(row(parsed, CHECK_ROW_IDS.verificationKnowledge)?.status).toBe('pass');
      });
    });

    describe('a project missing its domain map and configuring no frontend', () => {
      let result: ReturnType<typeof runCheck>;
      const json = (): ConfigCheckJson => JSON.parse(result.stdout) as ConfigCheckJson;

      beforeAll(() => {
        result = runCheck({
          cwd: makeProject('name: unmapped-project\n'),
          path: [emptyPathDir()],
          json: true,
        });
      });

      it('marks the failing row failed by identifier, not by prose', () => {
        const parsed = json();
        expect(row(parsed, CHECK_ROW_IDS.domainMap)?.status).toBe('fail');
        expect(parsed.checks.filter(check => check.status === 'fail')).toHaveLength(1);
      });

      it('carries no frontend-only row for a project that configures no frontend', () => {
        const parsed = json();
        expect(row(parsed, CHECK_ROW_IDS.agentBrowser)).toBeUndefined();
        expect(row(parsed, CHECK_ROW_IDS.agentBrowserJson)).toBeUndefined();
        expect(row(parsed, CHECK_ROW_IDS.verificationKnowledge)).toBeUndefined();
        expect(row(parsed, CHECK_ROW_IDS.frontendVerification)).toBeUndefined();
      });

      it('still carries the rows every project gets', () => {
        const parsed = json();
        expect(row(parsed, CHECK_ROW_IDS.domainMap)).toBeDefined();
        expect(row(parsed, CHECK_ROW_IDS.outputStyle)).toBeDefined();
      });
    });

    it('exits the same with --json as without it', () => {
      const cwd = makeProject('name: unmapped-project\n');

      const text = runCheck({ cwd, path: [emptyPathDir()] });
      const json = runCheck({ cwd, path: [emptyPathDir()], json: true });

      expect(text.status).toBe(1);
      expect(json.status).toBe(text.status);
    });
  });

  describe('the five existing checks keep their numbers', () => {
    let result: ReturnType<typeof runCheck>;

    beforeAll(() => {
      const root = makeProject(frontendProjectYaml(9222));
      writeDomainMap(root, DOMAIN_MAP_THREE);
      writeAgentBrowserJson(root, agentBrowserJsonFor(9222));
      writeVerificationKnowledge(root);

      result = runCheck({ cwd: root, path: [fakeBinDir('agent-browser', 0)] });
    });

    it('numbers the existing five 1 to 5 and starts the project rows at 6', () => {
      // `checkSection` slices the report by `^N. ` headings, and many tests
      // above address a check by its number. Renumbering the existing five
      // would leave those tests reading a different check's body and still
      // passing, so the numbers are pinned here where the breakage is loud.
      expect(checkSection(result.stdout, 1)).toContain('Required host axes are set');
      expect(checkSection(result.stdout, 2)).toContain('Declared orchestrators respond');
      expect(checkSection(result.stdout, 3)).toContain('Declared browser modes work');
      expect(checkSection(result.stdout, 4)).toContain(
        "Project's preferred browser mode is available"
      );
      expect(checkSection(result.stdout, 5)).toContain('Optional axes (informational only)');
      expect(result.stdout).toMatch(/^6\. /m);
    });

    it('keeps the human output shape once the project rows are printed', () => {
      expect(result.stdout).toContain('domain-map.yaml');
      expect(result.stdout).toMatch(/^\d+\. /m);
      expect(result.stdout).toMatch(/^ {3}(PASS|FAIL|INFO) /m);
      expect(result.stdout).toMatch(/^\d+ passed, \d+ failed, \d+ informational$/m);
    });
  });

  describe('the report is seven sections, and section 6 holds every project row', () => {
    let frontend: ReturnType<typeof runCheck>;
    let bare: ReturnType<typeof runCheck>;

    beforeAll(() => {
      const root = makeProject(frontendProjectYaml(9222));
      writeDomainMap(root, DOMAIN_MAP_THREE);
      writeAgentBrowserJson(root, agentBrowserJsonFor(9222));
      writeVerificationKnowledge(root);
      frontend = runCheck({ cwd: root, path: [fakeBinDir('agent-browser', 0)] });

      const plain = makeProject('name: no-frontend-project\n');
      writeDomainMap(plain, DOMAIN_MAP_THREE);
      bare = runCheck({ cwd: plain, path: [emptyPathDir()] });
    });

    it('heads sections 6 and 7 unchanged and prints no eighth section', () => {
      // A new row belongs in an existing section. Growing the report by a
      // section instead would renumber nothing but still move where a reader
      // (and `checkSection`) expects the writing style to be.
      expect(checkSection(frontend.stdout, 6)).toContain("This project's files");
      expect(checkSection(frontend.stdout, 7)).toContain('Writing style');
      expect(frontend.stdout).not.toMatch(/^8\. /m);
    });

    it('gives section 6 five rows for a project that configures a frontend', () => {
      // The domain map, agent-browser, agent-browser.json, the verification
      // knowledge base and frontend verification. Counting them is what
      // catches a row added twice or a row quietly dropped.
      expect(sectionRows(frontend.stdout, 6)).toHaveLength(5);
    });

    it('gives section 6 one row for a project that configures no frontend', () => {
      expect(sectionRows(bare.stdout, 6)).toHaveLength(1);
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
//      configured -> exit 1, stderr names `/spechub:setup`, stdout stays
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
    it('exits 1 naming /spechub:setup with no SpecHub project anywhere above cwd', () => {
      const cwd = noProjectDir();
      const result = runCli(['config', 'browser-mode'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('/spechub:setup');
      expect(result.stdout).toBe('');
    });

    it('exits 1 naming /spechub:setup when the project has no frontend configured', () => {
      const cwd = makeProject('name: no-frontend-project\n');
      const result = runCli(['config', 'browser-mode'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('/spechub:setup');
      expect(result.stdout).toBe('');
    });

    it('exits 1 naming /spechub:setup even when the host declares every browser mode available, for a no-frontend project', () => {
      declareOrchestrators(false, false);
      expect(runCli(['config', 'set', 'host.browser.remote', 'true']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.headless', 'true']).status).toBe(0);
      expect(runCli(['config', 'set', 'host.browser.local', 'true']).status).toBe(0);

      const cwd = makeProject('name: no-frontend-project\n');
      const result = runCli(['config', 'browser-mode'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('/spechub:setup');
    });

    it('--json prints no JSON object on the no-project failure - stdout stays empty', () => {
      const cwd = noProjectDir();
      const result = runCli(['config', 'browser-mode', '--json'], { cwd, path: [emptyPathDir()] });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('/spechub:setup');
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
