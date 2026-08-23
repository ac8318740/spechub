import { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'node:path';
import { GLOBAL_CONFIG_FILE, PROJECT_FILE, SPECHUB_DIR } from '../lib/constants.js';
import {
  ConfigFileError,
  ConfigValidationError,
  getKey,
  hostAxis,
  HOST_AXES,
  inertDependency,
  parseValue,
  readGlobalConfig,
  setKey,
  unsetKey,
  writeGlobalConfig,
  type GlobalConfig,
} from '../lib/global-config.js';
import {
  BROWSER_AXIS_KEYS,
  BROWSER_MODE_PRIORITY,
  CHROMIUM_BINARIES,
  declaredBrowserModes,
  FALLBACK_FORBIDDEN,
  isBrowserAxis,
  ORCHESTRATOR_AXIS_KEYS,
  ORCHESTRATOR_PROBES,
  ORCHESTRATORS,
  projectHostContext,
  projectSettings,
  requiredHostAxisKeys,
  resolveBrowserMode,
  type BrowserMode,
  type BrowserModeProblem,
  type ProjectHostContext,
  type ProjectSettings,
  type ResolvedBrowserMode,
} from '../lib/host-status.js';
import { cdpPortAnswers, firstBinaryOnPath, runCommand } from '../lib/host-probe.js';
import { findProjectRoot } from '../lib/project.js';
import { readYaml } from '../lib/utils.js';

/**
 * Run a config action, reporting the errors the user can act on as a plain red
 * line and exit 1. Anything else is a bug and keeps its stack trace.
 */
function reportingUserErrors(action: () => void): void {
  try {
    action();
  } catch (err) {
    if (err instanceof ConfigValidationError || err instanceof ConfigFileError) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
    throw err;
  }
}

/**
 * The async twin of `reportingUserErrors`, for the actions that have to wait
 * on the machine (probing ports and binaries) before they can report.
 */
async function reportingUserErrorsAsync(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    if (err instanceof ConfigValidationError || err instanceof ConfigFileError) {
      console.error(chalk.red(err.message));
      process.exit(1);
    }
    throw err;
  }
}

/** `required`/`optional` is only meaningful for keys the host schema knows. */
function qualifier(key: string, required: boolean): string {
  if (key !== 'host' && !hostAxis(key)) return '';
  return ` (${required ? 'required' : 'optional'})`;
}

/**
 * Everything the project under the current directory says, read once.
 *
 * `context` is what the host checks need to know; `settings` is what `show`
 * reports, and is null when there is no project here. Both come from the same
 * single read of project.yaml, so the facts printed and the facts checked can
 * never disagree about the same file.
 */
interface LoadedProject {
  context: ProjectHostContext;
  settings: ProjectSettings | null;
}

function loadProject(): LoadedProject {
  const root = findProjectRoot();
  if (!root) return { context: projectHostContext(undefined, false), settings: null };

  const yaml = readYaml(join(root, SPECHUB_DIR, PROJECT_FILE));
  return { context: projectHostContext(yaml, true), settings: projectSettings(yaml, true) };
}

/**
 * How an axis came to have the value being shown. `declared` means the user
 * wrote it in the config file; `detected` means only that the machine looks
 * that way right now. The two are deliberately never merged: detection is a
 * hint about what to declare, not a substitute for declaring it, and `check`
 * holds the user to what they declared rather than to what happens to be
 * installed today.
 */
type AxisStatus = 'declared' | 'detected' | 'unset';

interface HostAxisStatus {
  key: string;
  required: boolean;
  status: AxisStatus;
  value?: unknown;
}

/**
 * Guess the value of each axis in `wanted` from the live machine.
 *
 * Only the axes the user has not declared are looked at, so a machine with no
 * frontend project never gets its CDP port knocked on for an answer nobody
 * would read.
 */
async function detectHostAxes(
  wanted: ReadonlySet<string>,
  project: ProjectHostContext
): Promise<Map<string, unknown>> {
  const detected = new Map<string, unknown>();

  // Each orchestrator is looked for on its own. Finding one says nothing about
  // the other, and finding neither is not evidence of absence either: an axis
  // with nothing found is left unset rather than detected false, because the
  // binary could simply be somewhere this PATH does not reach.
  for (const name of ORCHESTRATORS) {
    const key = ORCHESTRATOR_AXIS_KEYS[name];
    if (!wanted.has(key)) continue;
    // Any of the orchestrator's binary names counts: Orca is installed as
    // `orca-ide` or as plain `orca` depending on how it was packaged, and
    // either one is the same tool. Detection only looks for the binary and
    // never runs it - `show` describes the machine, it does not test it.
    if (firstBinaryOnPath(ORCHESTRATOR_PROBES[name].binaries)) detected.set(key, true);
  }

  const chromiumKeys = [BROWSER_AXIS_KEYS.headless, BROWSER_AXIS_KEYS.local].filter(key =>
    wanted.has(key)
  );
  if (chromiumKeys.length > 0 && firstBinaryOnPath(CHROMIUM_BINARIES)) {
    for (const key of chromiumKeys) detected.set(key, true);
  }

  // Without a frontend there is no port the project would have us use, so
  // there is nothing to detect rather than a default worth guessing at.
  if (wanted.has(BROWSER_AXIS_KEYS.remote) && project.hasFrontend) {
    if (await cdpPortAnswers(project.cdpPort)) detected.set(BROWSER_AXIS_KEYS.remote, true);
  }

  return detected;
}

/** Every host axis, with whether it is required here and where its value came from. */
async function hostAxisStatuses(
  config: GlobalConfig,
  project: ProjectHostContext
): Promise<HostAxisStatus[]> {
  const required = new Set(requiredHostAxisKeys({ hasFrontend: project.hasFrontend }));

  const declared = new Map<string, unknown>();
  for (const axis of HOST_AXES) {
    const result = getKey(config, axis.key);
    if (result.status === 'set') declared.set(axis.key, result.value);
  }

  const undeclared = new Set(HOST_AXES.map(axis => axis.key).filter(key => !declared.has(key)));
  const detected = await detectHostAxes(undeclared, project);

  return HOST_AXES.map(axis => {
    const base = { key: axis.key, required: required.has(axis.key) };
    if (declared.has(axis.key)) {
      return { ...base, status: 'declared' as const, value: declared.get(axis.key) };
    }
    if (detected.has(axis.key)) {
      return { ...base, status: 'detected' as const, value: detected.get(axis.key) };
    }
    return { ...base, status: 'unset' as const };
  });
}

function formatValue(status: HostAxisStatus): string {
  if (status.status === 'unset') return chalk.dim('-');
  return typeof status.value === 'string' ? status.value : JSON.stringify(status.value);
}

const AXIS_KEY_WIDTH = Math.max(...HOST_AXES.map(axis => axis.key.length));

function printHostAxes(axes: HostAxisStatus[]): void {
  console.log(chalk.bold('Host'));
  for (const axis of axes) {
    const status = axis.status === 'declared' ? chalk.green('declared') : chalk.dim(axis.status);
    console.log(
      `  ${axis.key.padEnd(AXIS_KEY_WIDTH)}  ${formatValue(axis).padEnd(10)}  ` +
        `${status.padEnd(8)}  ${chalk.dim(axis.required ? 'required' : 'optional')}`
    );
  }
}

/** How wide the label column of the Project section is. Chosen to fit the longest label. */
const PROJECT_LABEL_WIDTH = 20;

function projectLine(label: string, value: string): string {
  return `  ${label.padEnd(PROJECT_LABEL_WIDTH)}  ${value}`;
}

/**
 * Print what the project says, above the host table.
 *
 * The project comes first because it is what makes the host table mean
 * anything: whether a browser axis is required at all depends on whether this
 * project has a frontend, so the reader wants that answer before the table
 * rather than after it.
 */
function printProject(settings: ProjectSettings | null): void {
  if (!settings) {
    // No heading here: with nothing to report under it, a `Project` heading
    // would only put a word between the reader and the answer.
    console.log(chalk.dim('No SpecHub project here.'));
    return;
  }

  console.log(chalk.bold('Project'));
  console.log(projectLine('profile', settings.profile ?? chalk.dim('-')));
  for (const [name, command] of Object.entries(settings.commands)) {
    console.log(projectLine(`commands.${name}`, command));
  }

  const browser = settings.browser;
  if (!browser) {
    console.log(chalk.dim('  this project has no frontend configured'));
    return;
  }

  // Only what the project actually states is listed. A browser setting left
  // out is a setting with no answer, and inventing one here would report a
  // decision the project never made.
  if (browser.mode !== null) console.log(projectLine('browser mode', browser.mode));
  if (browser.cdpPort !== null) console.log(projectLine('browser CDP port', String(browser.cdpPort)));
  if (browser.fallback !== null) console.log(projectLine('browser fallback', browser.fallback));
}

/** One numbered check's outcome. Only `fail` ever changes the exit code. */
type CheckOutcome = 'pass' | 'fail' | 'info';

/**
 * Collects the numbered checks `spechub config check` prints, and the two
 * facts that decide its exit code: whether anything required is unset (which
 * outranks everything, because nothing else can be trusted until it is set)
 * and whether anything else failed.
 */
class CheckReport {
  private number = 0;
  private failed = false;
  private missingRequired = false;
  private counts = { pass: 0, fail: 0, info: 0 };

  heading(title: string): void {
    this.number += 1;
    console.log(chalk.bold(`\n${this.number}. ${title}`));
  }

  line(outcome: CheckOutcome, message: string): void {
    this.counts[outcome] += 1;
    if (outcome === 'fail') this.failed = true;
    const label =
      outcome === 'pass'
        ? chalk.green('PASS')
        : outcome === 'fail'
          ? chalk.red('FAIL')
          : chalk.dim('INFO');
    console.log(`   ${label} ${message}`);
  }

  /** A required axis is unset: reported like any failure, but it sets exit 2. */
  missing(message: string): void {
    this.missingRequired = true;
    this.line('fail', message);
  }

  finish(): void {
    console.log(
      `\n${this.counts.pass} passed, ${this.counts.fail} failed, ${this.counts.info} informational`
    );
    // Not process.exit: the report has just been written to what may be a
    // pipe, and exiting outright can drop buffered output on its way out.
    process.exitCode = this.missingRequired ? 2 : this.failed ? 1 : 0;
  }
}

function checkRequiredAxes(
  report: CheckReport,
  config: GlobalConfig,
  project: ProjectHostContext
): void {
  report.heading('Required host axes are set');

  // Each browser axis is required in its own right once the project has a
  // frontend: the three are separate questions about what this machine can
  // do, so declaring one says nothing about the other two. Silence there is
  // a gap in the description of the host, not an answer of "no".
  const why = project.hasFrontend ? ' (this project has a frontend)' : '';

  for (const key of requiredHostAxisKeys({ hasFrontend: project.hasFrontend })) {
    const result = getKey(config, key);
    if (result.status === 'set') {
      report.line('pass', `${key} = ${JSON.stringify(result.value)}`);
    } else {
      const note = isBrowserAxis(key) ? why : '';
      report.missing(`${key} is unset${note} - set it with \`spechub config set ${key} <value>\``);
    }
  }

  // Answering "no" to every orchestrator is a valid setup, not a mistake, so
  // say what that means rather than leaving the user wondering whether they
  // have broken something.
  const declaredFalse = (key: string): boolean => {
    const result = getKey(config, key);
    return result.status === 'set' && result.value === false;
  };
  if (ORCHESTRATORS.every(name => declaredFalse(ORCHESTRATOR_AXIS_KEYS[name]))) {
    report.line('info', 'neither orchestrator is on this host - plain git worktrees will be used');
  }
}

/**
 * Probe every orchestrator the user declared true, each on its own line.
 *
 * One declared true and broken is a real problem whatever the other one says,
 * so the orchestrators are never collapsed into a single outcome. One declared
 * false is left alone entirely: the user said they do not use it, and hunting
 * for it anyway would only nag about a tool they do not want.
 */
function checkOrchestrators(report: CheckReport, config: GlobalConfig): void {
  report.heading('Declared orchestrators respond');

  let probed = false;
  let anyUndeclared = false;

  for (const name of ORCHESTRATORS) {
    const axisKey = ORCHESTRATOR_AXIS_KEYS[name];
    const result = getKey(config, axisKey);
    if (result.status !== 'set') {
      anyUndeclared = true;
      continue;
    }
    if (result.value !== true) continue;

    probed = true;
    const probe = ORCHESTRATOR_PROBES[name];
    // Where a failed probe sends the user, when this orchestrator has a page
    // worth reading. Attached to every failure, because a probe that did not
    // answer is exactly the moment the page is wanted.
    const hint = probe.docs ? ` - see ${probe.docs}` : '';

    const binary = firstBinaryOnPath(probe.binaries);
    if (!binary) {
      report.line(
        'fail',
        `${probe.binaries.join(' or ')} is not on PATH (${axisKey} is true)${hint}`
      );
      continue;
    }

    // The command is built from the binary actually found, not from the
    // preferred name, so the line the user reads is the line they can re-run.
    const command = [binary, ...probe.args].join(' ');
    const outcome = runCommand(binary, probe.args);
    if (!outcome.exitedZero || !probe.answered(outcome.stdout)) {
      report.line('fail', `\`${command}\` did not answer (${axisKey} is true)${hint}`);
      continue;
    }
    report.line('pass', `\`${command}\` answered`);
  }

  // Nothing to probe passes only once every orchestrator has actually been
  // answered for. An unanswered one is a gap check 1 is already reporting, so
  // this stays informational rather than claiming a clean result.
  if (!probed) {
    report.line(
      anyUndeclared ? 'info' : 'pass',
      'no orchestrator is declared true - nothing to probe'
    );
  }
}

/** Whether the machine can currently provide `mode`, and why not when it cannot. */
async function browserModeWorks(
  mode: BrowserMode,
  project: ProjectHostContext
): Promise<{ ok: boolean; detail: string }> {
  if (mode === 'remote') {
    const ok = await cdpPortAnswers(project.cdpPort);
    return {
      ok,
      detail: ok
        ? `CDP port ${project.cdpPort} answered`
        : `nothing answered on CDP port ${project.cdpPort}`,
    };
  }

  const binary = firstBinaryOnPath(CHROMIUM_BINARIES);
  return {
    ok: binary !== undefined,
    detail: binary
      ? `found ${binary} on PATH`
      : `no Chromium or Chrome binary on PATH (looked for ${CHROMIUM_BINARIES.join(', ')})`,
  };
}

async function checkDeclaredBrowserModes(
  report: CheckReport,
  config: GlobalConfig,
  project: ProjectHostContext
): Promise<void> {
  report.heading('Declared browser modes work');

  const declared = declaredBrowserModes(config);
  let probed = false;

  for (const mode of BROWSER_MODE_PRIORITY) {
    const key = BROWSER_AXIS_KEYS[mode];
    // A mode declared false is a decision, not a gap: the user said they do
    // not have it, so going and looking for it anyway would only nag.
    if (declared[mode] !== true) continue;

    probed = true;
    const { ok, detail } = await browserModeWorks(mode, project);
    report.line(ok ? 'pass' : 'fail', `${key} is true and ${detail}`);
  }

  if (!probed) report.line('info', 'no browser mode is declared true - nothing to probe');
}

/** The three `host.browser.*` axis keys, in priority order, as one readable list. */
const BROWSER_AXIS_LIST = BROWSER_MODE_PRIORITY.map(mode => BROWSER_AXIS_KEYS[mode]).join(', ');

function checkPreferredBrowserMode(
  report: CheckReport,
  config: GlobalConfig,
  project: ProjectHostContext
): void {
  report.heading("Project's preferred browser mode is available");

  // A project that named no mode has nothing to check here, whatever the host
  // can do - this check is about a preference being honoured, and there is no
  // preference. `browser-mode` treats the same situation as an answerable
  // question, which is why the two part company before the shared resolver.
  if (!project.hasFrontend || !project.preferredMode) {
    report.line('info', 'this project states no browser mode preference');
    return;
  }

  const preferred = project.preferredMode;
  const resolution = resolveBrowserMode(declaredBrowserModes(config), project);

  if (resolution.status === 'resolved') {
    report.line(
      'pass',
      resolution.fallback
        ? `project prefers ${preferred}, which this host does not declare; ` +
            `falling back to ${resolution.mode}`
        : `project prefers ${preferred} and this host declares it available`
    );
    return;
  }

  // A project that forbids falling back has said the mode it named is the
  // only one it will run against, so another mode being available is not a
  // rescue - naming it here would only suggest a way out the project refuses.
  if (resolution.problem.kind === 'fallback-forbidden') {
    report.line(
      'fail',
      `project prefers ${preferred}, which this host does not declare, and this project ` +
        `sets frontend.browser.fallback to "${FALLBACK_FORBIDDEN}" - so no other mode may ` +
        `stand in (set ${BROWSER_AXIS_KEYS[preferred]} to true, or change the project's ` +
        `fallback)`
    );
    return;
  }

  report.line(
    'fail',
    `project prefers ${preferred}, but this host declares no browser mode available ` +
      `(set one of ${BROWSER_AXIS_LIST} to true)`
  );
}

/**
 * Why this project has no browser mode to be driven with, said to the user.
 *
 * Each shade names the one thing that would fix it, because the fix differs:
 * a checkout with no frontend needs setting up, a machine nobody has
 * described needs describing, and a machine that describes itself as having
 * no browser needs a browser.
 */
function browserModeProblemMessage(problem: BrowserModeProblem): string {
  switch (problem.kind) {
    case 'no-project':
      return (
        'No SpecHub project here, so there is no frontend to drive a browser for - ' +
        'run `/spechub:init` in the project you want to set up.'
      );
    case 'no-frontend':
      return (
        'This project configures no frontend, so it drives no browser - ' +
        'run `/spechub:init` if it should have one.'
      );
    case 'host-undescribed':
      return (
        `This host has not been described yet: none of ${BROWSER_AXIS_LIST} is set - ` +
        'run `/spechub:host` to describe this machine.'
      );
    case 'host-declares-none':
      return (
        'This host declares no browser mode available: every one of ' +
        `${BROWSER_AXIS_LIST} it sets is false - run \`/spechub:host\` to declare one ` +
        'this machine can actually provide.'
      );
    case 'fallback-forbidden':
      return (
        `This project prefers the ${problem.preferred} browser mode, which this host does ` +
        `not declare available, and it sets frontend.browser.fallback to ` +
        `"${FALLBACK_FORBIDDEN}" - so ${problem.available} may not stand in. Set ` +
        `${BROWSER_AXIS_KEYS[problem.preferred]} to true with \`/spechub:host\`, or change ` +
        `this project's frontend.browser.fallback.`
      );
  }
}

/** Why the resolved mode is the one to use, as a sentence the user reads. */
function browserModeReason(resolved: ResolvedBrowserMode): string {
  if (!resolved.preferred) {
    return (
      'the project states no browser mode preference, so ' +
      `${resolved.mode} wins as the first mode this host declares available`
    );
  }
  if (resolved.fallback) {
    return (
      `the project prefers ${resolved.preferred}, which this host does not declare ` +
      `available, so ${resolved.mode} stands in`
    );
  }
  return `the project prefers ${resolved.preferred} and this host declares it available`;
}

function checkOptionalAxes(report: CheckReport, config: GlobalConfig): void {
  report.heading('Optional axes (informational only)');

  for (const axis of HOST_AXES.filter(a => !a.required)) {
    const result = getKey(config, axis.key);
    if (result.status !== 'set') {
      report.line('info', `${axis.key} is unset`);
      continue;
    }

    const dependency = inertDependency(config, axis.key);
    const note = dependency
      ? ` - inert unless ${dependency.key} is ${String(dependency.value)}`
      : '';
    report.line('info', `${axis.key} = ${JSON.stringify(result.value)}${note}`);
  }
}

export function register(program: Command): void {
  const configCmd = program
    .command('config')
    .description('Manage global configuration');

  configCmd
    .command('path')
    .description('Print config file path')
    .action(() => {
      console.log(GLOBAL_CONFIG_FILE);
    });

  configCmd
    .command('list')
    .description('Show all settings')
    .option('--json', 'output as JSON')
    .action((opts: { json?: boolean }) => {
      reportingUserErrors(() => {
        const config = readGlobalConfig(GLOBAL_CONFIG_FILE);
        if (opts.json) {
          console.log(JSON.stringify(config, null, 2));
          return;
        }
        if (Object.keys(config).length === 0) {
          console.log(chalk.dim('No configuration set.'));
          return;
        }
        for (const [key, value] of Object.entries(config)) {
          console.log(`${key} = ${JSON.stringify(value)}`);
        }
      });
    });

  configCmd
    .command('show')
    .description('Show the host setup: every axis, declared or merely detected')
    .option('--json', 'output as JSON')
    .action(async (opts: { json?: boolean }) => {
      await reportingUserErrorsAsync(async () => {
        const config = readGlobalConfig(GLOBAL_CONFIG_FILE);
        const { context: project, settings } = loadProject();
        const axes = await hostAxisStatuses(config, project);

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                hasProject: project.hasProject,
                hasFrontend: project.hasFrontend,
                axes,
                project: settings,
              },
              null,
              2
            )
          );
          return;
        }
        printProject(settings);
        console.log('');
        printHostAxes(axes);
      });
    });

  configCmd
    .command('check')
    .description('Check the host setup against what this machine can actually do')
    .action(async () => {
      await reportingUserErrorsAsync(async () => {
        const config = readGlobalConfig(GLOBAL_CONFIG_FILE);
        const project = loadProject().context;
        const report = new CheckReport();

        checkRequiredAxes(report, config, project);
        checkOrchestrators(report, config);
        await checkDeclaredBrowserModes(report, config, project);
        checkPreferredBrowserMode(report, config, project);
        checkOptionalAxes(report, config);

        report.finish();
      });
    });

  configCmd
    .command('browser-mode')
    .description('Report which browser mode the frontend verifier should use here, and why')
    .option('--json', 'output as JSON')
    .action((opts: { json?: boolean }) => {
      reportingUserErrors(() => {
        const config = readGlobalConfig(GLOBAL_CONFIG_FILE);
        const project = loadProject().context;
        const resolution = resolveBrowserMode(declaredBrowserModes(config), project);

        // Nothing to report is still an answer, so it goes to stderr and exits
        // 1 whatever the output format: a caller parsing `--json` gets empty
        // stdout rather than an object it would have to check a field on.
        if (resolution.status === 'unresolved') {
          console.error(chalk.red(browserModeProblemMessage(resolution.problem)));
          process.exit(1);
        }

        const reason = browserModeReason(resolution);
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                mode: resolution.mode,
                preferred: resolution.preferred ?? null,
                reason,
                fallback: resolution.fallback,
              },
              null,
              2
            )
          );
          return;
        }
        console.log(`${chalk.bold(resolution.mode)} - ${chalk.dim(reason)}`);
      });
    });

  configCmd
    .command('get')
    .description('Get a config value')
    .argument('<key>', 'config key')
    .action((key: string) => {
      reportingUserErrors(() => {
        const result = getKey(readGlobalConfig(GLOBAL_CONFIG_FILE), key);
        if (result.status === 'unset') {
          console.error(chalk.yellow(`${key} is unset${qualifier(key, result.required)}`));
          process.exit(2);
        }
        console.log(
          typeof result.value === 'string' ? result.value : JSON.stringify(result.value)
        );
      });
    });

  configCmd
    .command('set')
    .description('Set a config value')
    .argument('<key>', 'config key')
    .argument('<value>', 'config value')
    .action((key: string, value: string) => {
      reportingUserErrors(() => {
        const parsed = parseValue(key, value);
        const config = setKey(readGlobalConfig(GLOBAL_CONFIG_FILE), key, parsed);
        writeGlobalConfig(config, GLOBAL_CONFIG_FILE);
        console.log(chalk.green(`Set ${key} = ${JSON.stringify(parsed)}`));

        // The value is stored either way; the user just deserves to know when
        // nothing will read it yet.
        const dependency = inertDependency(config, key);
        if (dependency) {
          console.error(
            chalk.yellow(
              `Warning: ${key} has no effect unless ${dependency.key} is ${String(dependency.value)}`
            )
          );
        }
      });
    });

  configCmd
    .command('unset')
    .description('Remove a config value')
    .argument('<key>', 'config key')
    .action((key: string) => {
      reportingUserErrors(() => {
        const { config, removed } = unsetKey(readGlobalConfig(GLOBAL_CONFIG_FILE), key);
        if (!removed) {
          console.log(chalk.dim(`${key} was not set`));
          return;
        }
        writeGlobalConfig(config, GLOBAL_CONFIG_FILE);
        console.log(chalk.green(`Removed ${key}`));
      });
    });
}
