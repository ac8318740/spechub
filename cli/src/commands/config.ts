import { Command } from 'commander';
import chalk from 'chalk';
import { GLOBAL_CONFIG_FILE, projectFile } from '../lib/constants.js';
import {
  ConfigFileError,
  ConfigValidationError,
  getKey,
  hostAxis,
  inertDependency,
  parseValue,
  readGlobalConfig,
  setKey,
  unsetKey,
  writeGlobalConfig,
} from '../lib/global-config.js';
import {
  BROWSER_AXIS_KEYS,
  BROWSER_AXIS_LIST,
  declaredBrowserModes,
  FALLBACK_FORBIDDEN,
  frontendHelpersDir,
  projectHostContext,
  projectSettings,
  resolveBrowserMode,
  workflowFlag,
  type BrowserModeProblem,
  type ProjectHostContext,
  type ProjectSettings,
  type ResolvedBrowserMode,
} from '../lib/host-status.js';
import {
  getProjectKey,
  listProjectKeys,
  parseProjectValue,
  PROJECT_KEY_LIST,
  projectKeyDefault,
  projectKeyDefaultFlag,
  projectKeySpec,
  setProjectKey,
  unsetProjectKey,
} from '../lib/project-config.js';
import { findProjectRoot } from '../lib/project.js';
import { readYaml } from '../lib/utils.js';
import {
  CheckReport,
  checkDeclaredBrowserModes,
  checkImpeccable,
  checkOptionalAxes,
  checkOrchestrators,
  checkOutputStyle,
  checkPreferredBrowserMode,
  checkProjectFiles,
  checkRequiredAxes,
} from './config-check.js';
import {
  hostAxisStatuses,
  NO_PROJECT_LINE,
  printHostAxes,
  printProject,
} from './config-show.js';

/**
 * Report the errors the user can act on as a plain red line and exit 1.
 * Anything else is a bug and keeps its stack trace.
 *
 * Both wrappers below hand their `catch` here rather than each stating the
 * rule: a new error class the user is meant to read has one place to be added,
 * so it can never be added to the sync path and missed on the async one.
 */
function reportUserError(err: unknown): never {
  if (err instanceof ConfigValidationError || err instanceof ConfigFileError) {
    console.error(chalk.red(err.message));
    process.exit(1);
  }
  throw err;
}

/** Run a config action, reporting the errors the user can act on. */
function reportingUserErrors(action: () => void): void {
  try {
    action();
  } catch (err) {
    reportUserError(err);
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
    reportUserError(err);
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
 * `host` is what the host checks need to know; `settings` is what `show`
 * reports, and is null when there is no project here. Both come from the same
 * single read of project.yaml, so the facts printed and the facts checked can
 * never disagree about the same file.
 */
export interface LoadedProject {
  /**
   * The `workflow` flags the checks branch on, resolved against their
   * defaults. Held here rather than on either type above: they say nothing
   * about what the host has to provide and nothing `show` reports, but they
   * decide what two of the check rows conclude.
   */
  workflow: ProjectWorkflow;
  /**
   * The directory holding spechub/, or null when there is no project here.
   * Carried so the checks that stat the project's own files have somewhere to
   * stat them from.
   */
  root: string | null;
  host: ProjectHostContext;
  settings: ProjectSettings | null;
  /** `frontend.helpers_dir` as stated, or null. Neither of the two above holds it. */
  helpersDir: string | null;
}

/** What the project's `workflow` block says about the two rows that read it. */
interface ProjectWorkflow {
  /** Whether spec sync runs, and so whether this project owes a domain map. */
  specSync: boolean;
  /** Whether a UI change gets verified in a real browser before it lands. */
  frontendVerification: boolean;
}

/**
 * The two `workflow` flags, each against the default `PROJECT_KEY_DEFAULTS`
 * documents for its key, so `config check` acts on the value `config get`
 * reports. `undefined` is a project.yaml nobody found, which takes both
 * defaults like a file that states neither key.
 */
function projectWorkflow(projectYaml: unknown): ProjectWorkflow {
  return {
    specSync: workflowFlag(projectYaml, 'spec_sync', projectKeyDefaultFlag),
    frontendVerification: workflowFlag(projectYaml, 'frontend_verification', projectKeyDefaultFlag),
  };
}

function loadProject(): LoadedProject {
  const root = findProjectRoot();
  if (!root) {
    return {
      root: null,
      host: projectHostContext(undefined, false),
      settings: null,
      helpersDir: null,
      workflow: projectWorkflow(undefined),
    };
  }

  const yaml = readYaml(projectFile(root));
  return {
    root,
    host: projectHostContext(yaml, true),
    settings: projectSettings(yaml, true),
    helpersDir: frontendHelpersDir(yaml),
    workflow: projectWorkflow(yaml),
  };
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
        'run `/spechub:setup` in the project you want to set up.'
      );
    case 'no-frontend':
      return (
        'This project configures no frontend, so it drives no browser - ' +
        'run `/spechub:setup` if it should have one.'
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

/**
 * Which file a key belongs in. A `host.*` key describes the machine, so it
 * goes to the global config; every other key SpecHub knows describes the
 * project, so it goes to `spechub/project.yaml`. Bare `host` counts as a host
 * key so the "that is a section" message keeps coming from the host schema.
 */
function isHostKey(key: string): boolean {
  return key === 'host' || key.startsWith('host.');
}

/** Refuse `key`, naming the keys `spechub config set` does know. */
function unknownConfigKey(key: string): ConfigValidationError {
  return new ConfigValidationError(
    `Unknown config key "${key}".\n` +
      `Project keys (${projectFile()}): ${PROJECT_KEY_LIST.join(', ')}\n` +
      'Host keys start with host. and are listed in docs/dev-setups.md.'
  );
}

/** Write one `host.*` axis to the global config. */
function setHostKey(key: string, value: string): void {
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
}

/** Which of the three project-key commands is asking where the file is. */
type ProjectKeyUse = 'set' | 'get' | 'unset';

/**
 * Where the project.yaml holding `key` is, refusing the two ways a project key
 * can have nowhere to live: a key neither schema knows, and a directory that
 * is not a SpecHub project. `use` says which command is asking, so the refusal
 * reads as the sentence that command was in the middle of.
 *
 * Each of the three sentences is written out whole, so the line a user reads
 * can be found by grepping for the words they read.
 *
 * Every project-key command asks this first, so all three refuse the same two
 * things in the same words, and none of them opens a file before it has.
 */
function projectFileFor(key: string, use: ProjectKeyUse): string {
  if (!projectKeySpec(key)) throw unknownConfigKey(key);

  const root = findProjectRoot();
  if (!root) {
    switch (use) {
      case 'set':
        throw new ConfigValidationError(
          `There is no SpecHub project here, so ${key} has nowhere to go. Run /spechub:setup first.`
        );
      case 'get':
        throw new ConfigValidationError(
          `There is no SpecHub project here, so ${key} has no value to read. Run /spechub:setup first.`
        );
      case 'unset':
        throw new ConfigValidationError(
          `There is no SpecHub project here, so ${key} has nothing to remove. Run /spechub:setup first.`
        );
    }
  }
  return projectFile(root);
}

/**
 * Write one key to the project's `spechub/project.yaml`.
 *
 * The value is validated before the file is opened, so a value the schema
 * refuses leaves the file exactly as it was.
 */
function setProjectFileKey(key: string, value: string): void {
  const file = projectFileFor(key, 'set');
  const parsed = parseProjectValue(key, value);
  setProjectKey(file, key, parsed);
  console.log(chalk.green(`Set ${key} = ${JSON.stringify(parsed)}`));
}

/**
 * One config value on stdout: a string as written, anything else as JSON.
 *
 * A string is printed raw because the caller is usually a shell wanting the
 * path or the command itself, and quotes it would have to strip are worse than
 * no quotes at all. Everything else needs a spelling, and JSON is the one
 * every reader of this output already parses.
 */
function printConfigValue(value: unknown): void {
  console.log(typeof value === 'string' ? value : JSON.stringify(value));
}

/** Print one `host.*` axis, exiting 2 when the config states no value for it. */
function getHostKey(key: string): void {
  const result = getKey(readGlobalConfig(GLOBAL_CONFIG_FILE), key);
  if (result.status === 'unset') {
    console.error(chalk.yellow(`${key} is unset${qualifier(key, result.required)}`));
    process.exit(2);
  }
  printConfigValue(result.value);
}

/** Remove one `host.*` axis from the global config. */
function unsetHostKey(key: string): void {
  const { config, removed } = unsetKey(readGlobalConfig(GLOBAL_CONFIG_FILE), key);
  if (!removed) {
    console.log(chalk.dim(`${key} was not set`));
    return;
  }
  writeGlobalConfig(config, GLOBAL_CONFIG_FILE);
  console.log(chalk.green(`Removed ${key}`));
}

/**
 * Print one key of the project's `spechub/project.yaml`, exiting 2 when the
 * file states no value for it.
 *
 * Exit 2 is the code the host axes use for the same answer, so a caller
 * branches on "no value here" without knowing which file the key lives in.
 *
 * Where the reference gives the key a literal default, the message names it.
 * The default is what the project actually gets, so a reader told only that
 * the key is unset would still have to go and look the answer up.
 */
function getProjectFileKey(key: string): void {
  const result = getProjectKey(projectFileFor(key, 'get'), key);
  if (result.status === 'unset') {
    const fallback = projectKeyDefault(key);
    const note = fallback === undefined ? '' : ` - the documented default is ${fallback}`;
    console.error(chalk.yellow(`${key} is unset${note}`));
    process.exit(2);
  }
  printConfigValue(result.value);
}

/** Remove one key from the project's `spechub/project.yaml`. */
function unsetProjectFileKey(key: string): void {
  const file = projectFileFor(key, 'unset');
  if (!unsetProjectKey(file, key)) {
    // Not an error: the state the user asked for is the state the file is
    // already in, which is what an unset host axis reports too.
    console.log(chalk.dim(`${key} was not set`));
    return;
  }
  console.log(chalk.green(`Removed ${key}`));
}

/** The note a human row carries when no schema knows its key. */
const UNKNOWN_KEY_MARK = '(unknown key)';

/**
 * Print what the project's `spechub/project.yaml` states, above the host lines.
 *
 * Each side is headed by the file it came out of. The two sets of keys are
 * edited in completely different places, so a listing that ran them together
 * without saying which is which would leave the reader guessing which file to
 * open to change one.
 *
 * A key no schema knows keeps its place in file order and gains a mark. The
 * row is there because the file states it, and the mark is there because
 * `config get` refuses that same key and `config set` will not write it.
 */
function printProjectKeys(root: string | null): void {
  if (!root) {
    console.log(NO_PROJECT_LINE);
    return;
  }

  const file = projectFile(root);
  console.log(chalk.bold(file));
  const rows = listProjectKeys(file);
  if (rows.length === 0) {
    console.log(chalk.dim('This project states no configuration.'));
    return;
  }
  for (const { key, value, known } of rows) {
    const mark = known ? '' : chalk.yellow(` ${UNKNOWN_KEY_MARK}`);
    console.log(`${key} = ${JSON.stringify(value)}${mark}`);
  }
}

/** Every setting the two config files state, project side first. */
function listConfig(asJson: boolean): void {
  const config = readGlobalConfig(GLOBAL_CONFIG_FILE);
  // No key argument, so there is no project key to refuse: outside a
  // project the host axes are still the machine's, and still readable.
  const root = findProjectRoot();

  if (asJson) {
    // The host side keeps the shape it has always had - the config's own
    // `host` object, at the top level, byte for byte. The project keys
    // arrive beside it rather than around it.
    //
    // Rows in a list, in the file's own order, and not an object keyed by
    // the dotted path. A file is free to state `workflow.spec_sync` as one
    // literal key holding a dot AND state the same path nested, and both are
    // lines the human listing prints - keyed by the path they collide, and
    // the first of them goes without a word. Every row says whether a schema
    // knows its key, the known ones included: a caller that had to tell an
    // absent field from a false one would be reading the shape rather than
    // the answer.
    const project = root ? listProjectKeys(projectFile(root)) : null;
    console.log(JSON.stringify({ ...config, project }, null, 2));
    return;
  }

  printProjectKeys(root);
  console.log('');
  console.log(chalk.bold(GLOBAL_CONFIG_FILE));
  if (Object.keys(config).length === 0) {
    console.log(chalk.dim('No configuration set.'));
    return;
  }
  for (const [key, value] of Object.entries(config)) {
    console.log(`${key} = ${JSON.stringify(value)}`);
  }
}

/** The host setup as it stands: every axis, and what the project states. */
async function showConfig(asJson: boolean): Promise<void> {
  const config = readGlobalConfig(GLOBAL_CONFIG_FILE);
  const { host: project, settings } = loadProject();
  const axes = await hostAxisStatuses(config, project);

  if (asJson) {
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
}

/** Every numbered check, against the machine and against the project's files. */
async function checkConfig(asJson: boolean): Promise<void> {
  const config = readGlobalConfig(GLOBAL_CONFIG_FILE);
  const loaded = loadProject();
  const report = new CheckReport();

  checkRequiredAxes(report, config, loaded.host);
  checkOrchestrators(report, config);
  await checkDeclaredBrowserModes(report, config, loaded.host);
  checkPreferredBrowserMode(report, config, loaded.host);
  checkOptionalAxes(report, config);
  checkProjectFiles(report, loaded);
  // Adds to the section `checkProjectFiles` just opened rather than opening
  // one, because impeccable is optional and a section that came and went with
  // an install would renumber the report. `checkImpeccable` says more.
  checkImpeccable(report);
  // The output style lives in Claude Code's settings rather than in the
  // project, so it gets its own section rather than sitting among files the
  // project owns. Without a project root the settings files are still looked
  // for from where the user ran the command.
  checkOutputStyle(report, loaded.root ?? process.cwd());

  report.finish(asJson);
}

/** Which browser mode the frontend verifier should use here, and why. */
function reportBrowserMode(asJson: boolean): void {
  const config = readGlobalConfig(GLOBAL_CONFIG_FILE);
  const project = loadProject().host;
  const resolution = resolveBrowserMode(declaredBrowserModes(config), project);

  // Nothing to report is still an answer, so it goes to stderr and exits
  // 1 whatever the output format: a caller parsing `--json` gets empty
  // stdout rather than an object it would have to check a field on.
  if (resolution.status === 'unresolved') {
    console.error(chalk.red(browserModeProblemMessage(resolution.problem)));
    process.exit(1);
  }

  const reason = browserModeReason(resolution);
  if (asJson) {
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
}

export function register(program: Command): void {
  const configCmd = program
    .command('config')
    .description('Read and change the host and project configuration');

  configCmd
    .command('path')
    .description('Print config file path')
    .action(() => {
      console.log(GLOBAL_CONFIG_FILE);
    });

  configCmd
    .command('list')
    .description('Show every setting the two config files state')
    .option('--json', 'output as JSON')
    .action((opts: { json?: boolean }) => {
      reportingUserErrors(() => {
        listConfig(opts.json === true);
      });
    });

  configCmd
    .command('show')
    .description('Show the host setup: every axis, declared or merely detected')
    .option('--json', 'output as JSON')
    .action(async (opts: { json?: boolean }) => {
      await reportingUserErrorsAsync(() => showConfig(opts.json === true));
    });

  configCmd
    .command('check')
    .description('Check the host setup against what this machine can actually do')
    .option('--json', 'output as JSON')
    .action(async (opts: { json?: boolean }) => {
      await reportingUserErrorsAsync(() => checkConfig(opts.json === true));
    });

  configCmd
    .command('browser-mode')
    .description('Report which browser mode the frontend verifier should use here, and why')
    .option('--json', 'output as JSON')
    .action((opts: { json?: boolean }) => {
      reportingUserErrors(() => {
        reportBrowserMode(opts.json === true);
      });
    });

  configCmd
    .command('get')
    .description('Get a config value')
    .argument('<key>', 'config key')
    .action((key: string) => {
      reportingUserErrors(() => {
        if (isHostKey(key)) getHostKey(key);
        else getProjectFileKey(key);
      });
    });

  configCmd
    .command('set')
    .description('Set a config value')
    .argument('<key>', 'config key')
    .argument('<value>', 'config value')
    // The keys outlive any help string, so the help names where they are
    // written down rather than trying to list them.
    .addHelpText(
      'after',
      '\nReference: docs/dev-setups.md for the host.* axes, ' +
        'docs/config-reference.md for the spechub/project.yaml keys.\n'
    )
    .action((key: string, value: string) => {
      reportingUserErrors(() => {
        if (isHostKey(key)) setHostKey(key, value);
        else setProjectFileKey(key, value);
      });
    });

  configCmd
    .command('unset')
    .description('Remove a config value')
    .argument('<key>', 'config key')
    .action((key: string) => {
      reportingUserErrors(() => {
        if (isHostKey(key)) unsetHostKey(key);
        else unsetProjectFileKey(key);
      });
    });
}
