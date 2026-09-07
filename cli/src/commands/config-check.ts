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
  domainMapFile,
  SPECHUB_OUTPUT_STYLE,
  VERIFICATION_KNOWLEDGE_FILE,
} from '../lib/constants.js';
import {
  getKey,
  HOST_AXES,
  inertDependency,
  type GlobalConfig,
} from '../lib/global-config.js';
import {
  agentBrowserCdpPort,
  BROWSER_AXIS_KEYS,
  BROWSER_AXIS_LIST,
  BROWSER_MODE_PRIORITY,
  CHROMIUM_BINARIES,
  declaredBrowserModes,
  domainCount,
  FALLBACK_FORBIDDEN,
  isBrowserAxis,
  outputStyleOf,
  ORCHESTRATOR_AXIS_KEYS,
  ORCHESTRATOR_PROBES,
  ORCHESTRATORS,
  requiredHostAxisKeys,
  resolveBrowserMode,
  type BrowserMode,
  type ProjectHostContext,
} from '../lib/host-status.js';
import { findInstalledPlugin } from '../lib/claude-plugins.js';
import { IMPECCABLE_PLUGIN, impeccableVersionNote } from '../lib/impeccable.js';
import { cdpPortAnswers, firstBinaryOnPath, runCommand } from '../lib/host-probe.js';
import { FRONTEND_VERIFICATION_KEY } from '../lib/project-config.js';
import { readYaml } from '../lib/utils.js';
import type { LoadedProject } from './config.js';

/**
 * What `spechub config check` reports: the numbered checks, and the exit code
 * they add up to.
 *
 * `LoadedProject` is the one thing that crosses back to `config.ts`, and it
 * crosses as a type only. The command reads the project once and hands the
 * result here; nothing in this file goes and reads it again.
 */

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
export class CheckReport {
  private sections: CheckSection[] = [];
  private failed = false;
  private missingRequired = false;

  heading(title: string): void {
    this.sections.push({ title, rows: [] });
  }

  line(status: CheckOutcome, id: string, message: string): void {
    if (status === 'fail') this.failed = true;

    // Every check opens with a heading, so a row arriving before one is a bug
    // in the check that added it. Indexing the empty array instead would
    // report that as a property of `undefined`, from inside the reporter,
    // naming neither the row nor the check it came from.
    const section = this.sections[this.sections.length - 1];
    if (!section) throw new Error(`the check row ${id} was added before any heading`);
    section.rows.push({ id, status, message });
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

export function checkRequiredAxes(
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
export function checkOrchestrators(report: CheckReport, config: GlobalConfig): void {
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

export async function checkDeclaredBrowserModes(
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

export function checkPreferredBrowserMode(
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

export function checkOptionalAxes(report: CheckReport, config: GlobalConfig): void {
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

/**
 * Whether `path` is a file, as opposed to absent or a directory of that name.
 *
 * One call rather than an `existsSync` and then a `statSync`: the file can go
 * between the two, and a check that crashed on that would report a file being
 * deleted underneath it as a stack trace out of the reporter.
 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The domain map's path within a project, as the user would write it. */
const DOMAIN_MAP_PATH = domainMapFile();

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
  const path = domainMapFile(root);

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
  reportFrontendVerificationFlag(report, verification);
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
function reportFrontendVerificationFlag(report: CheckReport, enabled: boolean): void {
  const id = 'frontend-verification';
  const key = FRONTEND_VERIFICATION_KEY;

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

/**
 * The project's own files: the map every project needs, and the frontend's
 * three.
 *
 * `loaded` rather than `project`, which in the three checks above is the
 * `ProjectHostContext` this one reaches through `loaded.host`. One name for
 * two types in one file is a name that has to be read twice everywhere.
 */
export function checkProjectFiles(report: CheckReport, loaded: LoadedProject): void {
  report.heading("This project's files and design tools");

  if (!loaded.root) {
    // Nothing here is this directory's business: without spechub/ there is no
    // map to want and no frontend to configure. One line saying so beats a
    // column of failures about files a non-project was never going to have.
    report.line('info', 'no-project', 'No SpecHub project here, so there are no project files to check');
    return;
  }

  checkDomainMap(report, loaded.root, loaded.workflow.specSync);
  if (loaded.host.hasFrontend) {
    checkFrontendFiles(
      report,
      loaded.root,
      loaded.host,
      loaded.helpersDir,
      loaded.workflow.frontendVerification
    );
  }
}

/**
 * Whether impeccable is installed, and whether it is new enough.
 *
 * impeccable is a separate Claude Code plugin, so this row reports on the
 * machine rather than on a file the project owns. It is optional, which
 * decides the three outcomes: installed and new enough passes, installed and
 * older or unreadable is a note, and not installed prints no row at all. It
 * never fails, so a project that has never heard of impeccable is never told
 * it has a problem, and a script running `check` in continuous integration
 * never starts failing the day someone uninstalls a plugin.
 *
 * No heading of its own. The report's section numbers are load-bearing - the
 * checks above address each other by number - and a section that appeared
 * only when a plugin happened to be installed would move the writing style
 * from section 7 to section 8 on some machines and not others. So the row
 * joins the section the caller opened last, and that section is headed "and
 * design tools" for this row rather than for the project files around it.
 */
export function checkImpeccable(report: CheckReport): void {
  const id = 'impeccable';
  const found = findInstalledPlugin(IMPECCABLE_PLUGIN);
  if (!found) return;

  // The registry states a version too, and it goes unread on purpose: it
  // records what was installed, so printing it here would name a version the
  // user may no longer have. `impeccableVersionNote` is the same sentence
  // `spechub design-gate` warns with, so the two surfaces cannot drift.
  const note = impeccableVersionNote(found.version);
  if (note !== null) {
    report.line('info', id, note);
    return;
  }

  report.line(
    'pass',
    id,
    `${IMPECCABLE_PLUGIN} ${found.version} is installed, so a design review has a designer to call`
  );
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
export function checkOutputStyle(report: CheckReport, root: string): void {
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
