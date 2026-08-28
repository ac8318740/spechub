import chalk from 'chalk';
import { getKey, HOST_AXES, type GlobalConfig } from '../lib/global-config.js';
import {
  BROWSER_AXIS_KEYS,
  CHROMIUM_BINARIES,
  ORCHESTRATOR_AXIS_KEYS,
  ORCHESTRATOR_PROBES,
  ORCHESTRATORS,
  requiredHostAxisKeys,
  type ProjectHostContext,
  type ProjectSettings,
} from '../lib/host-status.js';
import { cdpPortAnswers, firstBinaryOnPath } from '../lib/host-probe.js';

/**
 * What `spechub config show` reports: every host axis with where its value
 * came from, and what the project under the current directory states.
 *
 * `show` describes, it does not judge. Nothing here decides an exit code and
 * nothing here fails; the judging is `config check`, in `config-check.ts`.
 */

/**
 * What `show` and `list` both say where the command ran outside a SpecHub
 * project. Two listings, one sentence: the answer is the same one either way,
 * and a reader who meets it in both should not have to wonder whether the
 * wording means something different in one of them.
 */
export const NO_PROJECT_LINE = chalk.dim('No SpecHub project here.');

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
export async function hostAxisStatuses(
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

export function printHostAxes(axes: HostAxisStatus[]): void {
  console.log(chalk.bold('Host'));
  for (const axis of axes) {
    const status = axis.status === 'declared' ? chalk.green('declared') : chalk.dim(axis.status);
    console.log(
      `  ${axis.key.padEnd(AXIS_KEY_WIDTH)}  ${formatValue(axis).padEnd(10)}  ` +
        `${status.padEnd(8)}  ${chalk.dim(axis.required ? 'required' : 'optional')}`
    );
  }
}

/**
 * How wide the label column of the Project section is.
 *
 * Wide enough for the labels this file writes down. A `commands.<name>` label
 * carries a name out of the user's own file, which can be longer than any of
 * them - that row then runs past the column and its value sits one space
 * along, which is a row that reads a little worse rather than a row that is
 * wrong.
 */
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
export function printProject(settings: ProjectSettings | null): void {
  if (!settings) {
    // No heading here: with nothing to report under it, a `Project` heading
    // would only put a word between the reader and the answer.
    console.log(NO_PROJECT_LINE);
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
