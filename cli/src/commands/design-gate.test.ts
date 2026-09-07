/**
 * `spechub design-gate` - one call that answers whether the design gate is on.
 *
 * Every skill and agent that gates on a design review needs the same answer,
 * and the answer lives in two places: `workflow.design_review` in the
 * project's own file, and whether the impeccable plugin is installed on the
 * machine. This command is the one place that joins them, so a caller runs a
 * command and reads an exit code instead of parsing `config check`.
 *
 * The whole answer is three outcomes and no fourth:
 *   on            - the key is true and impeccable is installed. Exit 0.
 *   on, warned    - the same, with an impeccable too old or unreadable. The
 *                   warning goes to stderr, and the answer is still on.
 *   off           - anything else. One `off: <reason>` line per reason,
 *                   exit 1.
 *
 * Two properties are pinned harder than the rest, because they are what make
 * the command cheap enough to call from a skill:
 *   - it reads two files and runs nothing, so no probe, no orchestrator, and
 *     no impeccable subprocess
 *   - it never exits 2, so a caller can treat the exit code as the boolean
 *     it asked for
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = join(__dirname, '..', '..', 'bin', 'spechub.js');

// ---------------------------------------------------------------------
// Fixtures
//
// These are a deliberate copy of the ones `config.test.ts` uses for the
// impeccable row, not an import from it. Both files describe the same two
// files on disk, and both files write them as literals rather than deriving
// them from anything in this repository - a fixture that asked SpecHub for
// the shape of Claude Code's registry would agree with SpecHub even when
// SpecHub is wrong. Sharing them later is fine; sharing them with the
// implementation never is.
// ---------------------------------------------------------------------

let xdgConfigHome: string;

beforeEach(() => {
  xdgConfigHome = mkdtempSync(join(tmpdir(), 'spechub-design-gate-xdg-'));
});

afterEach(() => {
  rmSync(xdgConfigHome, { recursive: true, force: true });
});

/**
 * Run the built CLI. `path`, when given, fully REPLACES the child's PATH, so
 * a test controls exactly which executables are findable - or, by handing an
 * empty directory, that none are. Node itself is spawned by absolute path, so
 * replacing PATH never stops the CLI starting.
 */
function runCli(
  args: string[],
  opts: { cwd?: string; path?: string[]; env?: NodeJS.ProcessEnv } = {}
) {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: xdgConfigHome };
  if (opts.path) env.PATH = opts.path.join(delimiter);
  Object.assign(env, opts.env ?? {});

  return spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: 'utf-8',
    env,
    cwd: opts.cwd,
    // Bounded, so a command that grew a probe and hung on it fails this suite
    // rather than stalling it.
    timeout: 10_000,
  });
}

/** An empty directory to use as PATH when a test wants NOTHING resolvable. */
function emptyPathDir(): string {
  return mkdtempSync(join(tmpdir(), 'spechub-empty-path-'));
}

/** A temp project root whose `spechub/project.yaml` holds `yaml`. */
function makeProject(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), 'spechub-project-'));
  mkdirSync(join(root, 'spechub'), { recursive: true });
  writeFileSync(join(root, 'spechub', 'project.yaml'), yaml);
  return root;
}

/** A project stating `workflow.design_review: true` - the on-key half of the answer. */
function gatedProject(): string {
  return makeProject('name: design-gate-project\nworkflow:\n  design_review: true\n');
}

/** A project stating the key false - off by a stated value rather than by omission. */
function ungatedProject(): string {
  return makeProject('name: design-gate-project\nworkflow:\n  design_review: false\n');
}

/** A project that never mentions the key, which is the default and is off. */
function silentProject(): string {
  return makeProject('name: design-gate-project\n');
}

/** A directory with no `spechub/` in it or above it. */
function noProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'spechub-no-project-'));
}

/** An isolated HOME, so a read of `~/.claude` sees only what a test wrote. */
function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), 'spechub-home-'));
}

/** The plugin this command reports on, spelled as its manifest spells it. */
const IMPECCABLE_PLUGIN = 'impeccable';

/**
 * The major version SpecHub expects of an installed impeccable.
 *
 * Asserted by value: what counts as new enough is the whole content of the
 * warn-or-stay-quiet decision, so deriving it from the implementation would
 * make the test agree with any number the implementation picked.
 */
const IMPECCABLE_MIN_MAJOR = '4';

/** How a test wants impeccable installed. */
interface ImpeccableInstall {
  /** The version the REGISTRY states, which the manifest can disagree with. */
  registryVersion: string;
  /** The version the MANIFEST states, when it differs from the registry's. */
  manifestVersion?: string;
  /** What a broken install is missing: the manifest file, or its version field. */
  broken?: 'no-manifest' | 'no-version';
  /** The half of the registry key after the `@`, which varies by install source. */
  marketplace?: string;
}

/**
 * Install impeccable under config root `root`, writing the two files Claude
 * Code writes:
 *
 *   <root>/plugins/installed_plugins.json  - the registry, keyed
 *      `<plugin>@<marketplace>` and carrying each install's `installPath`
 *   <installPath>/.claude-plugin/plugin.json - the plugin's own manifest,
 *      and the authoritative statement of its version
 *
 * The two versions are separate inputs because the manifest is the authority
 * and the registry's copy goes stale. A disagreement between them is the only
 * arrangement that shows which file an implementation actually read.
 */
function installImpeccable(root: string, opts: ImpeccableInstall): string {
  const manifest =
    opts.broken === 'no-manifest'
      ? null
      : opts.broken === 'no-version'
        ? { name: IMPECCABLE_PLUGIN }
        : { name: IMPECCABLE_PLUGIN, version: opts.manifestVersion ?? opts.registryVersion };

  const installPath = mkdtempSync(join(tmpdir(), 'spechub-plugin-install-'));
  if (manifest !== null) {
    mkdirSync(join(installPath, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(installPath, '.claude-plugin', 'plugin.json'),
      JSON.stringify(manifest, null, 2) + '\n'
    );
  }

  writeRegistry(root, {
    [`${IMPECCABLE_PLUGIN}@${opts.marketplace ?? IMPECCABLE_PLUGIN}`]: {
      installPath,
      version: opts.registryVersion,
    },
  });
  return installPath;
}

/** Write `installs`, keyed `<plugin>@<marketplace>`, as the whole registry under `root`. */
function writeRegistry(
  root: string,
  installs: Record<string, { installPath: string; version: string }>
): void {
  const plugins: Record<string, unknown[]> = {};
  for (const [key, install] of Object.entries(installs)) {
    plugins[key] = [
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
    join(root, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins }, null, 2) + '\n'
  );
}

/**
 * A HOME whose `.claude` holds impeccable installed as `opts` describes, handed
 * back alongside the install path the launcher path is built from.
 *
 * The install path is a temp directory the test made, so a test asserting the
 * launcher path asserts the whole string rather than a suffix of it.
 */
function homeAndInstall(opts: ImpeccableInstall): { home: string; installPath: string } {
  const home = fakeHome();
  return { home, installPath: installImpeccable(join(home, '.claude'), opts) };
}

/** A HOME whose `.claude` holds impeccable installed exactly as `opts` describes. */
function homeWithImpeccable(opts: ImpeccableInstall): string {
  return homeAndInstall(opts).home;
}

/**
 * Where impeccable's launcher lives inside an install path.
 *
 * The segments are written out here rather than imported, because this path is
 * impeccable's layout and not SpecHub's: a constant shared with the
 * implementation would agree with whatever the implementation joined.
 */
function launcherPath(installPath: string): string {
  return join(installPath, '.claude', 'skills', 'impeccable', 'scripts', 'impeccable');
}

/**
 * Run `spechub design-gate` in `cwd`, against an isolated HOME and a PATH
 * holding only what the test asked for.
 *
 * `CLAUDE_CONFIG_DIR` is emptied for the same reason HOME is replaced: Claude
 * Code reads its config root from that variable, so a machine that happens to
 * set it would send every read of `~/.claude` somewhere no test ever wrote.
 * An empty value is not a value, so this leaves HOME deciding.
 */
function runGate(opts: {
  cwd: string;
  home?: string;
  json?: boolean;
  path?: string[];
  env?: NodeJS.ProcessEnv;
}) {
  return runCli(['design-gate', ...(opts.json ? ['--json'] : [])], {
    cwd: opts.cwd,
    path: opts.path ?? [emptyPathDir()],
    env: {
      HOME: opts.home ?? fakeHome(),
      CLAUDE_CONFIG_DIR: '',
      ...(opts.env ?? {}),
    },
  });
}

/** The non-empty lines of `text`, trimmed - the shape both output halves are asserted as. */
function lines(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
}

/**
 * A directory holding one fake `name` that records having run, and the marker
 * path that proves it. The marker existing after a run is the only evidence
 * that would distinguish reading a file from starting a process.
 */
function tattlingBin(name: string): { dir: string; marker: string } {
  const dir = mkdtempSync(join(tmpdir(), 'spechub-fake-bin-'));
  const marker = join(mkdtempSync(join(tmpdir(), 'spechub-marker-')), `${name}-ran`);
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho ran > '${marker}'\nexit 0\n`);
  chmodSync(file, 0o755);
  return { dir, marker };
}

/**
 * Write a real, runnable launcher into `installPath` that records having run,
 * and hand back the marker that proves it.
 *
 * A launcher that does not exist proves nothing about a command that declines
 * to run it. This plants one that works, so the marker's absence is the
 * command choosing not to start it.
 */
function plantLauncher(installPath: string): string {
  const launcher = launcherPath(installPath);
  const marker = join(mkdtempSync(join(tmpdir(), 'spechub-marker-')), 'launcher-ran');
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, `#!/bin/sh\necho ran > '${marker}'\nexit 0\n`);
  chmodSync(launcher, 0o755);
  return marker;
}

/** What `design-gate --json` prints. */
interface DesignGateJson {
  on: boolean;
  reasons: string[];
  impeccable: { version: string; launcher: string } | null;
}

/** Parse the one JSON object `--json` prints, failing loudly when it printed something else. */
function parseGateJson(stdout: string): DesignGateJson {
  return JSON.parse(stdout) as DesignGateJson;
}

/** The exact reason strings, asserted by value because a caller reads them. */
const REASON_NO_PROJECT = 'no spechub project here';
const REASON_KEY_FALSE = 'workflow.design_review is false';
const REASON_NOT_INSTALLED = 'impeccable is not installed';

/** A version that satisfies the expectation, and one that does not. */
const NEW_ENOUGH = '4.2.0';
const TOO_OLD = '3.9.0';

describe('spechub design-gate', () => {
  // -------------------------------------------------------------------
  // The gate is on
  //
  // On needs both halves: the project asked for the gate, and the machine
  // can run it. Neither half alone is a gate anyone can pass through.
  // -------------------------------------------------------------------
  describe('the gate is on', () => {
    it('prints on and exits 0 when the key is true and impeccable is installed', () => {
      const result = runGate({
        cwd: gatedProject(),
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH }),
      });

      expect(result.stdout.trim()).toBe('on');
      expect(result.status).toBe(0);
    });

    it.each([
      ['a new enough version', { registryVersion: NEW_ENOUGH }],
      ['a version below major 4', { registryVersion: TOO_OLD }],
      ['no manifest to read a version from', { registryVersion: NEW_ENOUGH, broken: 'no-manifest' }],
      ['a manifest stating no version', { registryVersion: NEW_ENOUGH, broken: 'no-version' }],
    ] as [string, ImpeccableInstall][])(
      'is on with %s, because the version never decides the answer',
      (_case, install) => {
        // Installed is the whole question. An old or unreadable impeccable is
        // worth saying something about, and a caller that treated it as off
        // would stop a project's design reviews over a number.
        const result = runGate({ cwd: gatedProject(), home: homeWithImpeccable(install) });

        expect(lines(result.stdout)).toEqual(['on']);
        expect(result.status).toBe(0);
      }
    );

    it('is on when impeccable arrived from a marketplace under another name', () => {
      // The registry key is `<plugin>@<marketplace>`, and the marketplace half
      // is wherever the user installed from. Matching the whole key would find
      // one of the ways the same plugin arrives and miss the rest.
      const result = runGate({
        cwd: gatedProject(),
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH, marketplace: 'some-mirror' }),
      });

      expect(lines(result.stdout)).toEqual(['on']);
      expect(result.status).toBe(0);
    });

    it('finds the project from a subdirectory, the way every other command does', () => {
      const root = gatedProject();
      const deep = join(root, 'src', 'components');
      mkdirSync(deep, { recursive: true });

      const result = runGate({
        cwd: deep,
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH }),
      });

      expect(lines(result.stdout)).toEqual(['on']);
      expect(result.status).toBe(0);
    });

    it('says nothing on stdout but the word on', () => {
      // A caller reads this output. A greeting line, a version banner or a
      // trailing hint alongside the answer would make every caller parse.
      const result = runGate({
        cwd: gatedProject(),
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH }),
      });

      expect(result.stdout).not.toMatch(/off/i);
      expect(lines(result.stdout)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------
  // The gate is off
  //
  // Off always says why. A caller that learns only "off" has to go and run
  // two more commands to find out which half to fix.
  // -------------------------------------------------------------------
  describe('the gate is off', () => {
    it('is off naming the key when the project states it false', () => {
      const result = runGate({
        cwd: ungatedProject(),
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH }),
      });

      expect(lines(result.stdout)).toEqual([`off: ${REASON_KEY_FALSE}`]);
      expect(result.status).toBe(1);
    });

    it('is off naming the key when the project never states it, because the default is false', () => {
      // Unstated and stated-false are the same answer, and the reason has to
      // be the same sentence: a user told the key is false goes and looks at
      // it, and finding nothing there is the fastest way to learn it defaults
      // to off.
      const result = runGate({
        cwd: silentProject(),
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH }),
      });

      expect(lines(result.stdout)).toEqual([`off: ${REASON_KEY_FALSE}`]);
      expect(result.status).toBe(1);
    });

    it('is off naming impeccable when the registry file does not exist', () => {
      const result = runGate({ cwd: gatedProject(), home: fakeHome() });

      expect(lines(result.stdout)).toEqual([`off: ${REASON_NOT_INSTALLED}`]);
      expect(result.status).toBe(1);
    });

    it('is off naming impeccable when the registry names other plugins only', () => {
      const home = fakeHome();
      writeRegistry(join(home, '.claude'), {
        'document-skills@anthropic-agent-skills': {
          installPath: mkdtempSync(join(tmpdir(), 'spechub-other-plugin-')),
          version: '1.0.0',
        },
      });

      const result = runGate({ cwd: gatedProject(), home });

      expect(lines(result.stdout)).toEqual([`off: ${REASON_NOT_INSTALLED}`]);
      expect(result.status).toBe(1);
    });

    it('gives both reasons, one per line, when both halves are missing', () => {
      // Order is the order a user fixes them in: the project key is theirs to
      // set, and installing a plugin is the longer errand.
      const result = runGate({ cwd: silentProject(), home: fakeHome() });

      expect(lines(result.stdout)).toEqual([
        `off: ${REASON_KEY_FALSE}`,
        `off: ${REASON_NOT_INSTALLED}`,
      ]);
      expect(result.status).toBe(1);
    });

    it('gives one reason and no other when there is no project here', () => {
      // Nothing else is knowable. Adding "the key is false" to a directory
      // that holds no project would name a key in a file that does not exist,
      // and send the user to edit nothing.
      const result = runGate({
        cwd: noProjectDir(),
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH }),
      });

      expect(lines(result.stdout)).toEqual([`off: ${REASON_NO_PROJECT}`]);
      expect(result.status).toBe(1);
    });

    it('gives the no-project reason alone even when impeccable is missing too', () => {
      const result = runGate({ cwd: noProjectDir(), home: fakeHome() });

      expect(lines(result.stdout)).toEqual([`off: ${REASON_NO_PROJECT}`]);
      expect(result.status).toBe(1);
    });

    it.each([
      ['the key is false', () => ({ cwd: ungatedProject(), home: fakeHome() })],
      ['impeccable is missing', () => ({ cwd: gatedProject(), home: fakeHome() })],
      ['there is no project', () => ({ cwd: noProjectDir(), home: fakeHome() })],
    ])('exits 1 and never 2 when %s', (_case, arrange) => {
      // The exit code is the answer, so it has two values. A third would make
      // every caller test for it before trusting either of the other two.
      const result = runGate(arrange());

      expect(result.status).toBe(1);
      // Asserted alongside the code, because 1 is also what a crash exits
      // with. The reason lines are what say the command reached an answer.
      expect(lines(result.stdout).length).toBeGreaterThan(0);
      expect(lines(result.stdout).every(line => line.startsWith('off: '))).toBe(true);
    });

    it('writes the reasons to stdout, not stderr', () => {
      // Off is an answer, not an error. A caller reads the answer from stdout
      // whichever way it came out.
      const result = runGate({ cwd: silentProject(), home: fakeHome() });

      expect(result.stdout).toContain(REASON_KEY_FALSE);
      expect(result.stderr).not.toContain(REASON_KEY_FALSE);
    });
  });

  // -------------------------------------------------------------------
  // The version warning
  //
  // SpecHub expects impeccable at major 4 or later. The expectation is worth
  // saying out loud and worth nothing more: it goes to stderr, where a
  // caller reading stdout never sees it, and it leaves the answer alone.
  // -------------------------------------------------------------------
  describe('the version warning', () => {
    it('warns naming the installed version when the major is below 4, and stays on', () => {
      const result = runGate({
        cwd: gatedProject(),
        home: homeWithImpeccable({ registryVersion: TOO_OLD }),
      });

      // Both halves of the answer: what is installed, and what SpecHub wanted.
      // Naming only one leaves the reader to go and look the other up.
      expect(result.stderr).toContain(TOO_OLD);
      expect(result.stderr).toContain(IMPECCABLE_MIN_MAJOR);
      expect(lines(result.stdout)).toEqual(['on']);
      expect(result.status).toBe(0);
    });

    it.each([
      ['the manifest file is missing', 'no-manifest'],
      ['the manifest states no version', 'no-version'],
    ] as const)('warns that it could not read the version when %s, and stays on', (_case, broken) => {
      const result = runGate({
        cwd: gatedProject(),
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH, broken }),
      });

      expect(result.stderr).toMatch(/could not|cannot|unreadable|unknown|no version/i);
      expect(result.stderr).toContain(IMPECCABLE_MIN_MAJOR);
      expect(lines(result.stdout)).toEqual(['on']);
      expect(result.status).toBe(0);
    });

    it('never states a version it did not read', () => {
      // The registry carries a version too, and it is the stale one. Printing
      // it would report a version as installed on the strength of the one file
      // that can disagree with what is on disk.
      const result = runGate({
        cwd: gatedProject(),
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH, broken: 'no-manifest' }),
      });

      // The warning has to be there, and be about impeccable, for its silence
      // about the registry to mean anything: a command that printed nothing
      // would pass on the last assertion alone.
      expect(result.stderr).toContain(IMPECCABLE_PLUGIN);
      expect(result.stderr).toMatch(/could not|cannot|unreadable|unknown|no version/i);
      expect(result.stderr).not.toContain(NEW_ENOUGH);
    });

    it('warns on the manifest version when the registry disagrees with it', () => {
      // The manifest is the authority: an update rewrites the plugin's files
      // before it rewrites the registry entry.
      const result = runGate({
        cwd: gatedProject(),
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH, manifestVersion: TOO_OLD }),
      });

      expect(result.stderr).toContain(TOO_OLD);
      expect(result.stderr).not.toContain(NEW_ENOUGH);
      expect(result.status).toBe(0);
    });

    it('is one line, so a caller logging stderr logs one line', () => {
      const result = runGate({
        cwd: gatedProject(),
        home: homeWithImpeccable({ registryVersion: TOO_OLD }),
      });

      expect(lines(result.stderr)).toHaveLength(1);
      // Naming the version in the same assertion is what makes the count
      // mean "the warning is one line" rather than "something wrote a line".
      expect(lines(result.stderr)[0]).toContain(TOO_OLD);
    });

    it.each([[NEW_ENOUGH], ['4.0.0'], ['10.1.2']])(
      'says nothing at all on %s, which is major 4 or later',
      version => {
        // 10 is here because it is the version a comparison done on the
        // strings rather than the numbers gets wrong: "10" sorts before "4",
        // so a text comparison warns about a newer plugin.
        const result = runGate({
          cwd: gatedProject(),
          home: homeWithImpeccable({ registryVersion: version }),
        });

        expect(result.stderr.trim()).toBe('');
        expect(result.status).toBe(0);
      }
    );

    it('says nothing about the version when the gate is off anyway', () => {
      // The warning explains a gate that is running. A gate that is off is
      // already explained by its reason, and a second sentence about a plugin
      // version would bury it.
      const result = runGate({
        cwd: ungatedProject(),
        home: homeWithImpeccable({ registryVersion: TOO_OLD }),
      });

      expect(result.stderr.trim()).toBe('');
      expect(result.status).toBe(1);
    });
  });

  // -------------------------------------------------------------------
  // --json
  //
  // One object on stdout and nothing else, for the callers that want the
  // reasons as data rather than as sentences. `--json` changes how the
  // answer is written, never what it concluded.
  // -------------------------------------------------------------------
  describe('--json', () => {
    it('accepts the flag at all, rather than rejecting it as an unknown option', () => {
      const result = runGate({
        cwd: gatedProject(),
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH }),
        json: true,
      });

      expect(result.stderr).not.toContain('unknown option');
      expect(result.status).toBe(0);
    });

    it('prints exactly one JSON object on stdout and nothing else', () => {
      // Reserializing and comparing catches both a second object and any stray
      // human line printed alongside it.
      const result = runGate({
        cwd: gatedProject(),
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH }),
        json: true,
      });

      expect(result.stdout.trim()).toBe(JSON.stringify(parseGateJson(result.stdout), null, 2));
    });

    it('reports on with no reasons, the installed version, and the launcher path', () => {
      const install = homeAndInstall({ registryVersion: NEW_ENOUGH });

      const result = runGate({ cwd: gatedProject(), home: install.home, json: true });

      expect(parseGateJson(result.stdout)).toEqual({
        on: true,
        reasons: [],
        impeccable: {
          version: NEW_ENOUGH,
          launcher: launcherPath(install.installPath),
        },
      });
      expect(result.status).toBe(0);
    });

    it('reports the manifest version, not the registry version', () => {
      const install = homeAndInstall({
        registryVersion: NEW_ENOUGH,
        manifestVersion: TOO_OLD,
      });

      const result = runGate({ cwd: gatedProject(), home: install.home, json: true });

      expect(parseGateJson(result.stdout).impeccable).toEqual({
        version: TOO_OLD,
        launcher: launcherPath(install.installPath),
      });
    });

    it('builds the launcher path under the install path the registry states', () => {
      // The registry entry is the only statement of where the plugin lives, so
      // an install anywhere on disk has to produce a launcher under it. A path
      // built from the config root instead would be right only by coincidence.
      const install = homeAndInstall({ registryVersion: NEW_ENOUGH });

      const result = runGate({ cwd: gatedProject(), home: install.home, json: true });

      const launcher = parseGateJson(result.stdout).impeccable?.launcher;
      expect(launcher).toBe(launcherPath(install.installPath));
      expect(launcher?.startsWith('/')).toBe(true);
    });

    it('states the launcher path without checking that the file is there', () => {
      // The fixture install writes a manifest and nothing else, so no launcher
      // file exists under it. The path is a plain join: a caller that wants to
      // know whether the launcher runs is the one that has to find out.
      const install = homeAndInstall({ registryVersion: NEW_ENOUGH });
      expect(existsSync(launcherPath(install.installPath))).toBe(false);

      const result = runGate({ cwd: gatedProject(), home: install.home, json: true });

      expect(parseGateJson(result.stdout).impeccable?.launcher).toBe(
        launcherPath(install.installPath)
      );
      expect(result.status).toBe(0);
    });

    it('reports impeccable as null when it is not installed', () => {
      const result = runGate({ cwd: gatedProject(), home: fakeHome(), json: true });

      expect(parseGateJson(result.stdout)).toEqual({
        on: false,
        reasons: [REASON_NOT_INSTALLED],
        impeccable: null,
      });
      expect(result.status).toBe(1);
    });

    it('reports impeccable as present, and never as the stale registry version, on a broken install', () => {
      // Installed with no readable version is still installed, so null would
      // say the plugin is absent. The registry's number is the one file that
      // goes stale, so repeating it here would state a version nothing read.
      const install = homeAndInstall({ registryVersion: NEW_ENOUGH, broken: 'no-manifest' });

      const result = runGate({ cwd: gatedProject(), home: install.home, json: true });

      const json = parseGateJson(result.stdout);
      expect(json.on).toBe(true);
      expect(json.reasons).toEqual([]);
      expect(json.impeccable).not.toBeNull();
      // The launcher survives an unreadable version, because the two answers
      // come from different files: the path is the registry's install path,
      // and the version is the manifest that is missing.
      expect(json.impeccable?.launcher).toBe(launcherPath(install.installPath));
      expect(JSON.stringify(json.impeccable)).not.toContain(NEW_ENOUGH);
      expect(result.status).toBe(0);
    });

    it('carries both reasons in order when both halves are missing', () => {
      const result = runGate({ cwd: silentProject(), home: fakeHome(), json: true });

      expect(parseGateJson(result.stdout).reasons).toEqual([
        REASON_KEY_FALSE,
        REASON_NOT_INSTALLED,
      ]);
      expect(result.status).toBe(1);
    });

    it('carries the no-project reason alone, with impeccable still reported', () => {
      // The plugin is installed and the JSON says so, launcher and all. The
      // reasons list is the part that stops at "no project", because nothing
      // else is knowable about a project that is not there.
      const install = homeAndInstall({ registryVersion: NEW_ENOUGH });

      const result = runGate({ cwd: noProjectDir(), home: install.home, json: true });

      const json = parseGateJson(result.stdout);
      expect(json.on).toBe(false);
      expect(json.reasons).toEqual([REASON_NO_PROJECT]);
      expect(json.impeccable).toEqual({
        version: NEW_ENOUGH,
        launcher: launcherPath(install.installPath),
      });
      expect(result.status).toBe(1);
    });

    it('prints the same reason strings the human output prints', () => {
      // Two renderings of one answer, not two answers. A JSON reason that
      // read differently would make the two outputs separate contracts.
      const cwd = silentProject();
      const home = fakeHome();

      const text = runGate({ cwd, home });
      const json = runGate({ cwd, home, json: true });

      expect(lines(text.stdout)).toEqual(
        parseGateJson(json.stdout).reasons.map(reason => `off: ${reason}`)
      );
      expect(text.status).toBe(json.status);
    });

    it('still warns on stderr about an old version, alongside the JSON', () => {
      const result = runGate({
        cwd: gatedProject(),
        home: homeWithImpeccable({ registryVersion: TOO_OLD }),
        json: true,
      });

      expect(parseGateJson(result.stdout).on).toBe(true);
      expect(result.stderr).toContain(TOO_OLD);
      expect(result.status).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Where the installed plugins are read from
  //
  // Claude Code's config root is `$CLAUDE_CONFIG_DIR` when that is set and
  // non-empty, and `$HOME/.claude` otherwise. Every read of the registry
  // follows that rule, or a user who moved their config is told the plugin
  // they installed is missing.
  // -------------------------------------------------------------------
  describe('where the installed plugins are read from', () => {
    it('reads CLAUDE_CONFIG_DIR when it is set, not ~/.claude', () => {
      const configDir = mkdtempSync(join(tmpdir(), 'spechub-claude-config-'));
      installImpeccable(configDir, { registryVersion: NEW_ENOUGH });

      const result = runGate({
        cwd: gatedProject(),
        home: fakeHome(),
        env: { CLAUDE_CONFIG_DIR: configDir },
      });

      expect(lines(result.stdout)).toEqual(['on']);
      expect(result.status).toBe(0);
    });

    it('reads CLAUDE_CONFIG_DIR instead of ~/.claude when both hold an install', () => {
      // Not "as well as": the variable moves the config root, so a HOME
      // install is not a second place to look.
      const configDir = mkdtempSync(join(tmpdir(), 'spechub-claude-config-'));
      installImpeccable(configDir, { registryVersion: TOO_OLD });

      const result = runGate({
        cwd: gatedProject(),
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH }),
        env: { CLAUDE_CONFIG_DIR: configDir },
      });

      expect(result.stderr).toContain(TOO_OLD);
      expect(result.status).toBe(0);
    });

    it('falls back to ~/.claude when CLAUDE_CONFIG_DIR is set to an empty value', () => {
      const result = runGate({
        cwd: gatedProject(),
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH }),
        env: { CLAUDE_CONFIG_DIR: '' },
      });

      expect(lines(result.stdout)).toEqual(['on']);
      expect(result.status).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // A plugin the user switched off
  //
  // Claude Code keeps two records under its config root, and a plugin has to
  // satisfy both to run:
  //
  //   plugins/installed_plugins.json - what is on disk
  //   settings.json                  - which of it is switched on, as an
  //      `enabledPlugins` object keyed the same `<plugin>@<marketplace>` way
  //      the registry is
  //
  // A user who switched impeccable off has an install Claude Code will never
  // load, so a gate that stayed on would send every design review to a plugin
  // that cannot start. Off is off, and it is off for the same stated reason
  // as a plugin that was never installed.
  //
  // On is the default, and the default is what every other arrangement means -
  // a key set true, a key that is not there, an `enabledPlugins` that is not
  // there, and a settings file that is missing or unreadable.
  // -------------------------------------------------------------------
  describe('impeccable is switched off in settings.json', () => {
    /**
     * The marketplace impeccable is installed from here, and the whole
     * registry key that makes.
     *
     * Both are written out rather than one built from the other, because the
     * key is what Claude Code writes into two separate files, and matching it
     * across them is the whole behaviour under test.
     */
    const MARKETPLACE = 'pbakaus';
    const PLUGIN_KEY = 'impeccable@pbakaus';

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
     * A HOME holding impeccable installed from `MARKETPLACE` at a new enough
     * version, with `body` written verbatim as its `settings.json`.
     *
     * A null body writes no settings file at all, which is the state a machine
     * that has never switched a plugin off is in.
     */
    function homeWithSettings(body: string | null): string {
      const home = homeWithImpeccable({
        registryVersion: NEW_ENOUGH,
        marketplace: MARKETPLACE,
      });
      if (body !== null) writeSettings(join(home, '.claude'), body);
      return home;
    }

    it('is off naming impeccable when settings.json sets its key false', () => {
      // The project asks for the gate and the plugin is on disk, so the
      // settings file is the only thing deciding this.
      const result = runGate({
        cwd: gatedProject(),
        home: homeWithSettings(enabledPluginsBody({ [PLUGIN_KEY]: false })),
      });

      expect(lines(result.stdout)).toEqual([`off: ${REASON_NOT_INSTALLED}`]);
      expect(result.status).toBe(1);
    });

    it('reports it in --json exactly as a plugin absent from the registry', () => {
      // Two ways to end up with no usable plugin, one answer. A separate
      // reason string or a non-null impeccable object here would make a
      // caller handle switched-off as a third outcome.
      const result = runGate({
        cwd: gatedProject(),
        home: homeWithSettings(enabledPluginsBody({ [PLUGIN_KEY]: false })),
        json: true,
      });

      expect(parseGateJson(result.stdout)).toEqual({
        on: false,
        reasons: [REASON_NOT_INSTALLED],
        impeccable: null,
      });
      expect(result.status).toBe(1);
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
    ] as [string, string | null][])('is on when %s', (_case, body) => {
      // Switched on is the default, so anything short of a false key under
      // this plugin's own key leaves the gate on.
      const result = runGate({ cwd: gatedProject(), home: homeWithSettings(body) });

      expect(lines(result.stdout)).toEqual(['on']);
      expect(result.status).toBe(0);
    });

    describe('where the settings file is read from', () => {
      it('reads settings.json from CLAUDE_CONFIG_DIR, so a false key there turns the gate off', () => {
        // The registry and the settings file are two halves of one config
        // root. Reading one from the variable and the other from HOME would
        // answer from two machines' worth of state at once.
        const configDir = mkdtempSync(join(tmpdir(), 'spechub-claude-config-'));
        installImpeccable(configDir, { registryVersion: NEW_ENOUGH, marketplace: MARKETPLACE });
        writeSettings(configDir, enabledPluginsBody({ [PLUGIN_KEY]: false }));

        const result = runGate({
          cwd: gatedProject(),
          home: homeWithSettings(enabledPluginsBody({ [PLUGIN_KEY]: true })),
          env: { CLAUDE_CONFIG_DIR: configDir },
        });

        expect(lines(result.stdout)).toEqual([`off: ${REASON_NOT_INSTALLED}`]);
        expect(result.status).toBe(1);
      });

      it('ignores ~/.claude/settings.json when CLAUDE_CONFIG_DIR is set', () => {
        const configDir = mkdtempSync(join(tmpdir(), 'spechub-claude-config-'));
        installImpeccable(configDir, { registryVersion: NEW_ENOUGH, marketplace: MARKETPLACE });

        const result = runGate({
          cwd: gatedProject(),
          home: homeWithSettings(enabledPluginsBody({ [PLUGIN_KEY]: false })),
          env: { CLAUDE_CONFIG_DIR: configDir },
        });

        expect(lines(result.stdout)).toEqual(['on']);
        expect(result.status).toBe(0);
      });
    });
  });

  // -------------------------------------------------------------------
  // What the command never does
  //
  // The answer is two file reads. Everything below is a way it could stop
  // being two file reads without any of the assertions above noticing.
  // -------------------------------------------------------------------
  describe('what the command never does', () => {
    it('never runs impeccable, however installed it is', () => {
      // Asking the plugin its own version would make this command slow to
      // call, and would make it depend on a command that a half-written
      // install may not be able to start at all.
      const fake = tattlingBin(IMPECCABLE_PLUGIN);

      const result = runGate({
        cwd: gatedProject(),
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH }),
        path: [fake.dir],
      });

      expect(lines(result.stdout)).toEqual(['on']);
      expect(existsSync(fake.marker)).toBe(false);
    });

    it('never runs the launcher, even when the launcher is there and works', () => {
      // Reporting the path and running it are different jobs. Running it here
      // would put impeccable's startup cost inside every gate check, and make
      // a broken launcher look like a gate that is off.
      const install = homeAndInstall({ registryVersion: NEW_ENOUGH });
      const marker = plantLauncher(install.installPath);

      const result = runGate({ cwd: gatedProject(), home: install.home, json: true });

      expect(parseGateJson(result.stdout).impeccable?.launcher).toBe(
        launcherPath(install.installPath)
      );
      expect(existsSync(marker)).toBe(false);
      expect(result.status).toBe(0);
    });

    it.each([['herdr'], ['orca-ide'], ['orca'], ['agent-browser']])(
      'runs no %s probe',
      binary => {
        // `config check` probes the machine, and that is why it is too slow
        // and too noisy to call from a skill. This command answers from files
        // only, so a probe appearing here would undo the reason it exists.
        const fake = tattlingBin(binary);

        const result = runGate({
          cwd: gatedProject(),
          home: homeWithImpeccable({ registryVersion: NEW_ENOUGH }),
          path: [fake.dir],
        });

        expect(result.status).toBe(0);
        expect(existsSync(fake.marker)).toBe(false);
      }
    );

    it('answers with no global config file on disk at all', () => {
      // The host axes live in the global config, and an undeclared axis is
      // what makes `config check` exit 2. This command reads none of it, so a
      // machine that never ran `spechub config set` still gets an answer.
      const result = runGate({
        cwd: gatedProject(),
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH }),
        env: { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'spechub-empty-xdg-')) },
      });

      expect(lines(result.stdout)).toEqual(['on']);
      expect(result.status).toBe(0);
    });

    it('answers rather than throws on a project file that will not parse', () => {
      // A broken file is a state the user is in, not a bug in this command.
      // Which reason it gives is its own decision; that it reports at all,
      // in the shape every other answer has, is not.
      const root = makeProject('name: broken\nworkflow:\n  design_review: [true\n');

      const result = runGate({
        cwd: root,
        home: homeWithImpeccable({ registryVersion: NEW_ENOUGH }),
      });

      expect(result.stderr).not.toMatch(/\n\s+at /);
      expect(lines(result.stdout).length).toBeGreaterThan(0);
      expect(lines(result.stdout).every(line => line.startsWith('off: '))).toBe(true);
      expect(result.status).toBe(1);
    });
  });

  // -------------------------------------------------------------------
  // Discoverability
  //
  // A command a skill is told to run has to be a command a person can find.
  // -------------------------------------------------------------------
  describe('discoverability', () => {
    it('is listed in spechub --help', () => {
      const result = runCli(['--help'], { path: [emptyPathDir()] });

      expect(result.stdout).toContain('design-gate');
      expect(result.status).toBe(0);
    });

    it('describes itself in its own --help', () => {
      const result = runCli(['design-gate', '--help'], { path: [emptyPathDir()] });

      expect(result.stdout).toContain('--json');
      expect(result.status).toBe(0);
    });
  });
});
