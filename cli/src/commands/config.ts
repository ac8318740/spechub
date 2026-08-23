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
  fallbackBrowserMode,
  isBrowserAxis,
  ORCHESTRATOR_PROBES,
  projectHostContext,
  requiredHostAxisKeys,
  type BrowserMode,
  type Orchestrator,
  type ProjectHostContext,
} from '../lib/host-status.js';
import { cdpPortAnswers, commandSucceeds, firstBinaryOnPath } from '../lib/host-probe.js';
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

/** What the project under the current directory says, or "no project here". */
function loadProjectContext(): ProjectHostContext {
  const root = findProjectRoot();
  if (!root) return projectHostContext(undefined, false);
  return projectHostContext(readYaml(join(root, SPECHUB_DIR, PROJECT_FILE)), true);
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

  if (wanted.has('host.orchestrator')) {
    const running = (Object.keys(ORCHESTRATOR_PROBES) as Exclude<Orchestrator, 'none'>[]).find(
      name => firstBinaryOnPath([ORCHESTRATOR_PROBES[name].binary]) !== undefined
    );
    if (running) detected.set('host.orchestrator', running);
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

function printHostAxes(project: ProjectHostContext, axes: HostAxisStatus[]): void {
  console.log(chalk.bold('Host'));
  for (const axis of axes) {
    const status = axis.status === 'declared' ? chalk.green('declared') : chalk.dim(axis.status);
    console.log(
      `  ${axis.key.padEnd(AXIS_KEY_WIDTH)}  ${formatValue(axis).padEnd(10)}  ` +
        `${status.padEnd(8)}  ${chalk.dim(axis.required ? 'required' : 'optional')}`
    );
  }

  const where = !project.hasProject
    ? 'no SpecHub project here'
    : project.hasFrontend
      ? `project frontend: browser mode ${project.preferredMode ?? 'unspecified'}, ` +
        `CDP port ${project.cdpPort}`
      : 'project has no frontend configured';
  console.log(chalk.dim(`\n${where}`));
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
}

function checkOrchestrator(report: CheckReport, config: GlobalConfig): void {
  report.heading('Declared orchestrator responds');

  const result = getKey(config, 'host.orchestrator');
  if (result.status !== 'set') {
    report.line('info', 'host.orchestrator is unset - nothing to probe');
    return;
  }

  const orchestrator = result.value as Orchestrator;
  if (orchestrator === 'none') {
    report.line('pass', 'host.orchestrator is none - nothing to probe');
    return;
  }

  const probe = ORCHESTRATOR_PROBES[orchestrator];
  if (!probe) {
    report.line('info', `host.orchestrator is ${String(orchestrator)} - no probe known`);
    return;
  }

  const command = [probe.binary, ...probe.args].join(' ');
  if (!firstBinaryOnPath([probe.binary])) {
    report.line('fail', `${probe.binary} is not on PATH (host.orchestrator is ${orchestrator})`);
    return;
  }
  if (!commandSucceeds(probe.binary, probe.args)) {
    report.line('fail', `\`${command}\` did not answer (host.orchestrator is ${orchestrator})`);
    return;
  }
  report.line('pass', `\`${command}\` answered`);
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

function checkPreferredBrowserMode(
  report: CheckReport,
  config: GlobalConfig,
  project: ProjectHostContext
): void {
  report.heading("Project's preferred browser mode is available");

  if (!project.hasFrontend || !project.preferredMode) {
    report.line('info', 'this project states no browser mode preference');
    return;
  }

  const preferred = project.preferredMode;
  const declared = declaredBrowserModes(config);
  if (declared[preferred] === true) {
    report.line('pass', `project prefers ${preferred} and this host declares it available`);
    return;
  }

  const fallback = fallbackBrowserMode(declared);
  if (fallback) {
    report.line(
      'pass',
      `project prefers ${preferred}, which this host does not declare; ` +
        `falling back to ${fallback}`
    );
    return;
  }

  report.line(
    'fail',
    `project prefers ${preferred}, but this host declares no browser mode available ` +
      `(set one of ${BROWSER_MODE_PRIORITY.map(m => BROWSER_AXIS_KEYS[m]).join(', ')} to true)`
  );
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
    const note = dependency ? ` - inert unless ${dependency.key} is ${dependency.value}` : '';
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
        const project = loadProjectContext();
        const axes = await hostAxisStatuses(config, project);

        if (opts.json) {
          console.log(
            JSON.stringify(
              { hasProject: project.hasProject, hasFrontend: project.hasFrontend, axes },
              null,
              2
            )
          );
          return;
        }
        printHostAxes(project, axes);
      });
    });

  configCmd
    .command('check')
    .description('Check the host setup against what this machine can actually do')
    .action(async () => {
      await reportingUserErrorsAsync(async () => {
        const config = readGlobalConfig(GLOBAL_CONFIG_FILE);
        const project = loadProjectContext();
        const report = new CheckReport();

        checkRequiredAxes(report, config, project);
        checkOrchestrator(report, config);
        await checkDeclaredBrowserModes(report, config, project);
        checkPreferredBrowserMode(report, config, project);
        checkOptionalAxes(report, config);

        report.finish();
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
              `Warning: ${key} has no effect unless ${dependency.key} is ${dependency.value}`
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
