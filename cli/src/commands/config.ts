import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_BROWSER_BIN,
  AGENT_BROWSER_JSON_FILE,
  CLAUDE_DIR,
  CLAUDE_LOCAL_SETTINGS_FILE,
  CLAUDE_SETTINGS_FILE,
  DOMAIN_MAP_FILE,
  GLOBAL_CONFIG_FILE,
  PROJECT_FILE,
  SPECHUB_DIR,
  SPECHUB_OUTPUT_STYLE,
  VERIFICATION_KNOWLEDGE_FILE,
} from '../lib/constants.js';
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
  agentBrowserCdpPort,
  BROWSER_AXIS_KEYS,
  BROWSER_MODE_PRIORITY,
  CHROMIUM_BINARIES,
  declaredBrowserModes,
  domainCount,
  FALLBACK_FORBIDDEN,
  frontendHelpersDir,
  isBrowserAxis,
  outputStyleOf,
  ORCHESTRATOR_AXIS_KEYS,
  ORCHESTRATOR_PROBES,
  ORCHESTRATORS,
  projectHostContext,
  projectSettings,
  requiredHostAxisKeys,
  resolveBrowserMode,
  workflowFlag,
  type BrowserMode,
  type BrowserModeProblem,
  type ProjectHostContext,
  type ProjectSettings,
  type ResolvedBrowserMode,
} from '../lib/host-status.js';
import { cdpPortAnswers, firstBinaryOnPath, runCommand } from '../lib/host-probe.js';
import {
  getProjectKey,
  listProjectKeys,
  parseProjectValue,
  PROJECT_KEY_LIST,
  projectKeyDefault,
  projectKeySpec,
  setProjectKey,
  unsetProjectKey,
} from '../lib/project-config.js';
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
  context: ProjectHostContext;
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
 * The two `workflow` flags, each against its own default: spec sync runs
 * unless a project turns it off, and frontend verification stays off until a
 * project turns it on. `undefined` is a project.yaml nobody found, which
 * takes both defaults like a file that states neither key.
 */
function projectWorkflow(projectYaml: unknown): ProjectWorkflow {
  return {
    specSync: workflowFlag(projectYaml, 'spec_sync', true),
    frontendVerification: workflowFlag(projectYaml, 'frontend_verification', false),
  };
}

function loadProject(): LoadedProject {
  const root = findProjectRoot();
  if (!root) {
    return {
      root: null,
      context: projectHostContext(undefined, false),
      settings: null,
      helpersDir: null,
      workflow: projectWorkflow(undefined),
    };
  }

  const yaml = readYaml(join(root, SPECHUB_DIR, PROJECT_FILE));
  return {
    root,
    context: projectHostContext(yaml, true),
    settings: projectSettings(yaml, true),
    helpersDir: frontendHelpersDir(yaml),
    workflow: projectWorkflow(yaml),
  };
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
 * One line of the report.
 *
 * `id` is the stable handle `--json` callers branch on, and every row carries
 * one - a contract with identifiers on some rows and not others would leave a
 * caller matching prose for the rest. `message` is the sentence a human
 * reads, and is deliberately not the machine-readable part: it can be
 * reworded without breaking anyone.
 */
interface CheckRow {
  id: string;
  status: CheckOutcome;
  message: string;
}

/** One numbered section of the report, and the rows printed under it. */
interface CheckSection {
  title: string;
  rows: CheckRow[];
}

const OUTCOME_LABELS: Readonly<Record<CheckOutcome, string>> = {
  pass: chalk.green('PASS'),
  fail: chalk.red('FAIL'),
  info: chalk.dim('INFO'),
};

/**
 * Collects the numbered checks `spechub config check` reports, and the two
 * facts that decide its exit code: whether anything required is unset (which
 * outranks everything, because nothing else can be trusted until it is set)
 * and whether anything else failed.
 *
 * Nothing is printed as it is collected. The whole report is buffered and
 * rendered at `finish`, because the same rows have to come out either as
 * numbered sections or as one JSON object, and a check that printed as it
 * went could only ever produce the first.
 */
class CheckReport {
  private sections: CheckSection[] = [];
  private failed = false;
  private missingRequired = false;

  heading(title: string): void {
    this.sections.push({ title, rows: [] });
  }

  line(status: CheckOutcome, id: string, message: string): void {
    if (status === 'fail') this.failed = true;
    this.sections[this.sections.length - 1].rows.push({ id, status, message });
  }

  /** A required axis is unset: reported like any failure, but it sets exit 2. */
  missing(id: string, message: string): void {
    this.missingRequired = true;
    this.line('fail', id, message);
  }

  private rows(): CheckRow[] {
    return this.sections.flatMap(section => section.rows);
  }

  private printText(): void {
    this.sections.forEach((section, index) => {
      console.log(chalk.bold(`\n${index + 1}. ${section.title}`));
      for (const row of section.rows) {
        console.log(`   ${OUTCOME_LABELS[row.status]} ${row.message}`);
      }
    });

    const counts = { pass: 0, fail: 0, info: 0 };
    for (const row of this.rows()) counts[row.status] += 1;
    console.log(`\n${counts.pass} passed, ${counts.fail} failed, ${counts.info} informational`);
  }

  finish(asJson: boolean): void {
    if (asJson) {
      // The section numbers are a reading aid for a human and carry no
      // meaning a caller could use, so JSON gets the flat list of rows and
      // the identifiers that actually name them.
      console.log(JSON.stringify({ checks: this.rows() }, null, 2));
    } else {
      this.printText();
    }
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
    const id = `required-axis:${key}`;
    if (result.status === 'set') {
      report.line('pass', id, `${key} = ${JSON.stringify(result.value)}`);
    } else {
      const note = isBrowserAxis(key) ? why : '';
      report.missing(
        id,
        `${key} is unset${note} - set it with \`spechub config set ${key} <value>\``
      );
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
    report.line(
      'info',
      'no-orchestrator',
      'neither orchestrator is on this host - plain git worktrees will be used'
    );
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
    const id = `orchestrator:${name}`;
    const probe = ORCHESTRATOR_PROBES[name];
    // Where a failed probe sends the user, when this orchestrator has a page
    // worth reading. Attached to every failure, because a probe that did not
    // answer is exactly the moment the page is wanted.
    const hint = probe.docs ? ` - see ${probe.docs}` : '';

    const binary = firstBinaryOnPath(probe.binaries);
    if (!binary) {
      report.line(
        'fail',
        id,
        `${probe.binaries.join(' or ')} is not on PATH (${axisKey} is true)${hint}`
      );
      continue;
    }

    // The command is built from the binary actually found, not from the
    // preferred name, so the line the user reads is the line they can re-run.
    const command = [binary, ...probe.args].join(' ');
    const outcome = runCommand(binary, probe.args);
    if (!outcome.exitedZero || !probe.answered(outcome.stdout)) {
      report.line('fail', id, `\`${command}\` did not answer (${axisKey} is true)${hint}`);
      continue;
    }
    report.line('pass', id, `\`${command}\` answered`);
  }

  // Nothing to probe passes only once every orchestrator has actually been
  // answered for. An unanswered one is a gap check 1 is already reporting, so
  // this stays informational rather than claiming a clean result.
  if (!probed) {
    report.line(
      anyUndeclared ? 'info' : 'pass',
      'orchestrator:none',
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
    report.line(ok ? 'pass' : 'fail', `browser-mode:${mode}`, `${key} is true and ${detail}`);
  }

  if (!probed) {
    report.line('info', 'browser-mode:none', 'no browser mode is declared true - nothing to probe');
  }
}

/** The three `host.browser.*` axis keys, in priority order, as one readable list. */
const BROWSER_AXIS_LIST = BROWSER_MODE_PRIORITY.map(mode => BROWSER_AXIS_KEYS[mode]).join(', ');

function checkPreferredBrowserMode(
  report: CheckReport,
  config: GlobalConfig,
  project: ProjectHostContext
): void {
  report.heading("Project's preferred browser mode is available");

  // A project that configures no frontend asked for nothing, so there is no
  // row rather than a row saying so. The status is what a caller branches on,
  // and an informational row here would be indistinguishable from the case
  // below - which is the opposite situation, a real gap worth offering to
  // fill. The frontend file rows already work this way.
  const id = 'preferred-browser-mode';
  if (!project.hasFrontend) return;

  // A project that named no mode has nothing to weigh here, whatever the host
  // can do: this check is about a preference being honoured, and there is no
  // preference. `browser-mode` treats the same situation as an answerable
  // question, which is why the two part company before the shared resolver.
  if (!project.preferredMode) {
    report.line('info', id, 'this project states no browser mode preference');
    return;
  }

  const preferred = project.preferredMode;
  const resolution = resolveBrowserMode(declaredBrowserModes(config), project);

  if (resolution.status === 'resolved') {
    report.line(
      'pass',
      id,
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
      id,
      `project prefers ${preferred}, which this host does not declare, and this project ` +
        `sets frontend.browser.fallback to "${FALLBACK_FORBIDDEN}" - so no other mode may ` +
        `stand in (set ${BROWSER_AXIS_KEYS[preferred]} to true, or change the project's ` +
        `fallback)`
    );
    return;
  }

  report.line(
    'fail',
    id,
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

function checkOptionalAxes(report: CheckReport, config: GlobalConfig): void {
  report.heading('Optional axes (informational only)');

  for (const axis of HOST_AXES.filter(a => !a.required)) {
    const id = `optional-axis:${axis.key}`;
    const result = getKey(config, axis.key);
    if (result.status !== 'set') {
      report.line('info', id, `${axis.key} is unset`);
      continue;
    }

    const dependency = inertDependency(config, axis.key);
    const note = dependency
      ? ` - inert unless ${dependency.key} is ${String(dependency.value)}`
      : '';
    report.line('info', id, `${axis.key} = ${JSON.stringify(result.value)}${note}`);
  }
}

/**
 * The first line of whatever a parser threw.
 *
 * A YAML parse error carries a source excerpt on the lines after its message,
 * and the report prints one line per outcome, so only the first line of the
 * complaint is ever shown. The file name is already in the sentence around
 * it, which is the half the user needs to act.
 */
function firstLineOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0];
}

/** What came of trying to read a JSON file. */
type JsonFileRead =
  | { status: 'missing' }
  | { status: 'unreadable'; detail: string }
  | { status: 'read'; value: unknown };

/**
 * Read and parse a JSON file without ever throwing.
 *
 * There is no shared JSON reader in the CLI, and a check that crashed on a
 * file the user has broken would be reporting the one thing it exists to
 * report as a stack trace. Every parse here is guarded for that reason.
 */
function readJsonFile(path: string): JsonFileRead {
  if (!existsSync(path)) return { status: 'missing' };
  try {
    return { status: 'read', value: JSON.parse(readFileSync(path, 'utf-8')) as unknown };
  } catch (err) {
    return { status: 'unreadable', detail: firstLineOf(err) };
  }
}

/** Whether `path` is a file, as opposed to absent or a directory of that name. */
function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** The domain map's path within a project, as the user would write it. */
const DOMAIN_MAP_PATH = join(SPECHUB_DIR, DOMAIN_MAP_FILE);

/** Where the install instructions for the browser driver send the user. */
const AGENT_BROWSER_INSTALL = `npm install -g ${AGENT_BROWSER_BIN}`;

/**
 * The domain map, which every project needs whether or not it has a UI.
 *
 * A missing map is a failure rather than a note because of how it fails: spec
 * sync finds no domains, updates nothing and says nothing, so the living
 * specs quietly stop tracking the code while everything still looks fine.
 *
 * `specSync` is what makes that a failure. A project that set
 * `workflow.spec_sync` to false has nothing reading the map, so a missing one
 * is the state it asked for rather than a problem found - the row still says
 * the map is absent, because that is the cost of turning spec sync back on,
 * but it says it as a note. The row keeps its identifier either way, so one
 * caller branch reads both outcomes.
 */
function checkDomainMap(report: CheckReport, root: string, specSync: boolean): void {
  const id = 'domain-map';
  const consequence =
    'spec sync then skips silently and the living specs stop being updated';
  const path = join(root, DOMAIN_MAP_PATH);

  if (!existsSync(path)) {
    report.line(
      specSync ? 'fail' : 'info',
      id,
      specSync
        ? `${DOMAIN_MAP_PATH} is missing - ${consequence}`
        : `${DOMAIN_MAP_PATH} is missing, and workflow.spec_sync is false - nothing reads the ` +
          'map, so it is only owed if spec sync goes back on'
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = readYaml(path);
  } catch (err) {
    report.line('fail', id, `${DOMAIN_MAP_PATH} is not valid YAML: ${firstLineOf(err)}`);
    return;
  }

  // A map naming nothing is a missing map with extra steps. Spec sync opens
  // it, finds no domains to update, updates none and says nothing - which is
  // the failure this row exists to report, whether the `domains` mapping is
  // absent or present and empty. "maps 0 domains" reported as a pass is that
  // failure described accurately and then filed as success.
  const domains = domainCount(parsed);
  if (domains === null || domains === 0) {
    report.line('fail', id, `${DOMAIN_MAP_PATH} names no domains - ${consequence}`);
    return;
  }
  report.line(
    'pass',
    id,
    `${DOMAIN_MAP_PATH} maps ${domains} ${domains === 1 ? 'domain' : 'domains'}`
  );
}

/**
 * The three things a project needs before its frontend can be verified: the
 * driver on PATH, a config file pointing it at the right port, and somewhere
 * for the verifier to keep what it learns.
 *
 * Only asked of a project that configures a frontend. A project that drives
 * no browser is not missing any of this; it simply has no use for it.
 */
function checkFrontendFiles(
  report: CheckReport,
  root: string,
  project: ProjectHostContext,
  helpersDir: string | null,
  verification: boolean
): void {
  if (firstBinaryOnPath([AGENT_BROWSER_BIN])) {
    report.line('pass', 'agent-browser', `${AGENT_BROWSER_BIN} is on PATH`);
  } else {
    report.line(
      'fail',
      'agent-browser',
      `${AGENT_BROWSER_BIN} is not on PATH - install it with \`${AGENT_BROWSER_INSTALL}\``
    );
  }

  checkAgentBrowserJson(report, root, project.cdpPort);
  checkVerificationKnowledge(report, root, helpersDir);
  checkFrontendVerification(report, verification);
}

/**
 * `agent-browser.json` names the port the driver dials, and project.yaml
 * names the port the browser is expected on. The two disagreeing is a
 * verifier that connects to nothing, so both numbers go in the message: which
 * file to change to which value is the whole of the fix.
 *
 * `expected` is the port the rest of the CLI resolves to, defaults included,
 * so a project stating no `cdp_port` is still held to the default its browser
 * mode implies rather than let off the check.
 */
function checkAgentBrowserJson(report: CheckReport, root: string, expected: number): void {
  const id = 'agent-browser-json';
  const read = readJsonFile(join(root, AGENT_BROWSER_JSON_FILE));

  if (read.status === 'missing') {
    report.line(
      'fail',
      id,
      `${AGENT_BROWSER_JSON_FILE} is missing from the project root - ` +
        `${AGENT_BROWSER_BIN} needs one naming CDP port ${expected}`
    );
    return;
  }
  if (read.status === 'unreadable') {
    report.line('fail', id, `${AGENT_BROWSER_JSON_FILE} is not valid JSON: ${read.detail}`);
    return;
  }

  const port = agentBrowserCdpPort(read.value);
  if (port === null) {
    report.line('fail', id, `${AGENT_BROWSER_JSON_FILE} names no cdp port - it should name ${expected}`);
    return;
  }
  if (port !== expected) {
    report.line(
      'fail',
      id,
      `${AGENT_BROWSER_JSON_FILE} names CDP port ${port} but this project uses ${expected} - ` +
        'set both to the same port'
    );
    return;
  }
  report.line('pass', id, `${AGENT_BROWSER_JSON_FILE} names CDP port ${port}, matching this project`);
}

/**
 * The verification knowledge base, which is a file and not the directory
 * holding it: an empty `helpers_dir` left behind by a half-finished setup
 * would pass a check that only looked for the directory, and the verifier
 * would then have nowhere to write what it learns.
 */
function checkVerificationKnowledge(
  report: CheckReport,
  root: string,
  helpersDir: string | null
): void {
  const id = 'verification-knowledge';
  if (helpersDir === null) {
    report.line(
      'fail',
      id,
      `frontend.helpers_dir is unset, so there is nowhere for ${VERIFICATION_KNOWLEDGE_FILE} to live`
    );
    return;
  }

  const relative = join(helpersDir, VERIFICATION_KNOWLEDGE_FILE);
  if (!isFile(join(root, relative))) {
    report.line(
      'fail',
      id,
      `${relative} is missing - the frontend verifier keeps what it learns there`
    );
    return;
  }
  report.line('pass', id, `${relative} is present`);
}

/**
 * Whether this project verifies a UI change in a real browser before it
 * lands, which is the last thing the three rows above are all for.
 *
 * Off is a choice and not a problem, so the row is informational rather than
 * a failure - but it names the key, because "verification is off" is only
 * actionable next to where to turn it on. Only a project that configures a
 * frontend gets the row at all: with no UI there is nothing to verify, so
 * there is no setting to be off.
 */
function checkFrontendVerification(report: CheckReport, enabled: boolean): void {
  const id = 'frontend-verification';
  const key = 'workflow.frontend_verification';

  if (!enabled) {
    report.line(
      'info',
      id,
      `${key} is not true, so a UI change lands unverified - set it to true to run the ` +
        'frontend verifier'
    );
    return;
  }
  report.line('pass', id, `${key} is true, so a UI change is verified in a browser before it lands`);
}

/** The project's own files: the map every project needs, and the frontend's three. */
function checkProjectFiles(report: CheckReport, project: LoadedProject): void {
  report.heading("This project's files");

  if (!project.root) {
    // Nothing here is this directory's business: without spechub/ there is no
    // map to want and no frontend to configure. One line saying so beats a
    // column of failures about files a non-project was never going to have.
    report.line('info', 'no-project', 'No SpecHub project here, so there are no project files to check');
    return;
  }

  checkDomainMap(report, project.root, project.workflow.specSync);
  if (project.context.hasFrontend) {
    checkFrontendFiles(
      report,
      project.root,
      project.context,
      project.helpersDir,
      project.workflow.frontendVerification
    );
  }
}

/** One Claude Code settings file, named the way the user would refer to it. */
interface SettingsFile {
  label: string;
  path: string;
}

/**
 * Claude Code's settings files, highest precedence first.
 *
 * `homedir()` is read here rather than at module load so that HOME is the one
 * the process was actually given.
 */
function settingsFiles(root: string): SettingsFile[] {
  return [
    {
      label: join(CLAUDE_DIR, CLAUDE_LOCAL_SETTINGS_FILE),
      path: join(root, CLAUDE_DIR, CLAUDE_LOCAL_SETTINGS_FILE),
    },
    {
      label: join(CLAUDE_DIR, CLAUDE_SETTINGS_FILE),
      path: join(root, CLAUDE_DIR, CLAUDE_SETTINGS_FILE),
    },
    {
      label: join('~', CLAUDE_DIR, CLAUDE_SETTINGS_FILE),
      path: join(homedir(), CLAUDE_DIR, CLAUDE_SETTINGS_FILE),
    },
  ];
}

/**
 * Which output style is in force, and which file put it there.
 *
 * The status carries the answer rather than only the prose: a caller deciding
 * whether to offer the writing style reads `pass` as "already selected" and
 * `info` as "not selected", without matching a sentence. The plugin never
 * forces its own style on, so someone else's style and no style at all are
 * both notes rather than problems. A settings file that will not parse is the
 * one failure here: it breaks Claude Code itself, not just this row, so the
 * user needs to see it in red.
 *
 * The file that wins is named, because "which style is on" is only actionable
 * alongside "where to go and change it".
 */
function checkOutputStyle(report: CheckReport, root: string): void {
  const id = 'output-style';
  report.heading('Writing style');

  for (const file of settingsFiles(root)) {
    const read = readJsonFile(file.path);
    if (read.status === 'missing') continue;
    if (read.status === 'unreadable') {
      report.line(
        'fail',
        id,
        `${file.label} is not valid JSON, so the outputStyle it selects cannot be read: ${read.detail}`
      );
      return;
    }

    const style = outputStyleOf(read.value);
    if (style === null) continue;
    report.line(
      style === SPECHUB_OUTPUT_STYLE ? 'pass' : 'info',
      id,
      `outputStyle is ${style}, selected by ${file.label}`
    );
    return;
  }

  report.line('info', id, 'outputStyle is not set by any settings file, so Claude Code uses its default');
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
      `Project keys (${join(SPECHUB_DIR, PROJECT_FILE)}): ${PROJECT_KEY_LIST.join(', ')}\n` +
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

/**
 * Where the project.yaml holding `key` is, refusing the two ways a project key
 * can have nowhere to live: a key neither schema knows, and a directory that
 * is not a SpecHub project. `purpose` says what the key was wanted for, so the
 * refusal reads as the sentence the command was in the middle of.
 *
 * Every project-key command asks this first, so all three refuse the same two
 * things in the same words, and none of them opens a file before it has.
 */
function projectFileFor(key: string, purpose: string): string {
  if (!projectKeySpec(key)) throw unknownConfigKey(key);

  const root = findProjectRoot();
  if (!root) {
    throw new ConfigValidationError(
      `There is no SpecHub project here, so ${key} ${purpose}. Run /spechub:setup first.`
    );
  }
  return join(root, SPECHUB_DIR, PROJECT_FILE);
}

/**
 * Write one key to the project's `spechub/project.yaml`.
 *
 * The value is validated before the file is opened, so a value the schema
 * refuses leaves the file exactly as it was.
 */
function setProjectFileKey(key: string, value: string): void {
  const file = projectFileFor(key, 'has nowhere to go');
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
  const result = getProjectKey(projectFileFor(key, 'has no value to read'), key);
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
  const file = projectFileFor(key, 'has nothing to remove');
  if (!unsetProjectKey(file, key)) {
    // Not an error: the state the user asked for is the state the file is
    // already in, which is what an unset host axis reports too.
    console.log(chalk.dim(`${key} was not set`));
    return;
  }
  console.log(chalk.green(`Removed ${key}`));
}

/**
 * Print what the project's `spechub/project.yaml` states, above the host lines.
 *
 * Each side is headed by the file it came out of. The two sets of keys are
 * edited in completely different places, so a listing that ran them together
 * without saying which is which would leave the reader guessing which file to
 * open to change one.
 */
function printProjectKeys(root: string | null): void {
  if (!root) {
    console.log(chalk.dim('No SpecHub project here.'));
    return;
  }

  const file = join(root, SPECHUB_DIR, PROJECT_FILE);
  console.log(chalk.bold(file));
  const rows = listProjectKeys(file);
  if (rows.length === 0) {
    console.log(chalk.dim('This project states no configuration.'));
    return;
  }
  for (const [key, value] of rows) console.log(`${key} = ${JSON.stringify(value)}`);
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
        const config = readGlobalConfig(GLOBAL_CONFIG_FILE);
        // No key argument, so there is no project key to refuse: outside a
        // project the host axes are still the machine's, and still readable.
        const root = findProjectRoot();

        if (opts.json) {
          // The host side keeps the shape it has always had - the config's own
          // `host` object, at the top level, byte for byte. The project keys
          // arrive beside it rather than around it.
          const project = root
            ? Object.fromEntries(listProjectKeys(join(root, SPECHUB_DIR, PROJECT_FILE)))
            : null;
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
    .option('--json', 'output as JSON')
    .action(async (opts: { json?: boolean }) => {
      await reportingUserErrorsAsync(async () => {
        const config = readGlobalConfig(GLOBAL_CONFIG_FILE);
        const loaded = loadProject();
        const project = loaded.context;
        const report = new CheckReport();

        checkRequiredAxes(report, config, project);
        checkOrchestrators(report, config);
        await checkDeclaredBrowserModes(report, config, project);
        checkPreferredBrowserMode(report, config, project);
        checkOptionalAxes(report, config);
        checkProjectFiles(report, loaded);
        // The output style lives in Claude Code's settings rather than in the
        // project, so it gets its own section rather than sitting among files
        // the project owns. Without a project root the settings files are
        // still looked for from where the user ran the command.
        checkOutputStyle(report, loaded.root ?? process.cwd());

        report.finish(opts.json === true);
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
