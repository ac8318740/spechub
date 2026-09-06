/**
 * `spechub design-gate` - one call that answers whether the design gate is on.
 *
 * The answer lives in two places: `workflow.design_review` in the project's
 * own file, and whether the impeccable plugin is installed on the machine.
 * Every skill and agent that gates on a design review needs both, so this
 * command joins them once and a caller reads an exit code.
 *
 * Three outcomes and no fourth:
 *   on         - the key is true and impeccable is installed. Exit 0.
 *   on, warned - the same, with an impeccable too old or unreadable. The
 *                warning goes to stderr, and the answer is still on.
 *   off        - anything else. One `off: <reason>` line per reason, exit 1.
 *
 * It reads two files and runs nothing: no probe, no orchestrator, and no
 * impeccable subprocess. That is what makes it cheap enough for a skill to
 * call, and it is why `config check` is not the thing a skill calls instead.
 *
 * It never exits 2, so a caller can read the exit code as the boolean it
 * asked for. A project file that will not parse is an answer rather than a
 * crash: an unreadable file states no key, and an unstated key is false.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { findInstalledPlugin, type InstalledPlugin } from '../lib/claude-plugins.js';
import { projectFile } from '../lib/constants.js';
import { workflowFlag } from '../lib/host-status.js';
import {
  IMPECCABLE_PLUGIN,
  impeccableLauncher,
  impeccableVersionNote,
} from '../lib/impeccable.js';
import { DESIGN_REVIEW_KEY, projectKeyDefaultFlag } from '../lib/project-config.js';
import { findProjectRoot } from '../lib/project.js';
import { readYaml } from '../lib/utils.js';

/**
 * Why the gate is off, in the order a user fixes them: the project key is
 * theirs to set, and installing a plugin is the longer errand.
 *
 * Sentences rather than codes, because both outputs print these strings and a
 * person reads them. The JSON carries the same ones, so the two renderings
 * stay one contract instead of becoming two.
 */
const REASON_NO_PROJECT = 'no spechub project here';
const REASON_KEY_FALSE = `${DESIGN_REVIEW_KEY} is false`;
const REASON_NOT_INSTALLED = `${IMPECCABLE_PLUGIN} is not installed`;

/**
 * What `--json` states about an installed impeccable, or null when none is.
 *
 * `version` is what the manifest states. A broken install reports `unknown`
 * rather than the registry's number, because the registry records what was
 * installed and goes stale, and rather than null, because null is how this
 * whole object says the plugin is absent.
 */
interface ImpeccableJson {
  version: string;
  launcher: string;
}

/** The whole answer, as `--json` prints it. */
interface DesignGateJson {
  on: boolean;
  reasons: string[];
  impeccable: ImpeccableJson | null;
}

/** The version a broken install reports: installed, with nothing readable to state. */
const UNKNOWN_VERSION = 'unknown';

/**
 * Whether the project at `root` asks for a design review.
 *
 * A file the parser refuses states nothing, so it takes the documented
 * default the same way a file that never mentions the key does. Guessing at a
 * broken file would answer a question about a document nobody wrote, and
 * throwing would exit on a state the user is in rather than on a bug.
 */
function designReviewAsked(root: string): boolean {
  let yaml: unknown = undefined;
  try {
    yaml = readYaml(projectFile(root));
  } catch {
    yaml = undefined;
  }
  return workflowFlag(yaml, 'design_review', projectKeyDefaultFlag);
}

/**
 * Every reason the gate is off, or an empty list when it is on.
 *
 * No project is the whole answer on its own. Adding "the key is false" would
 * name a key in a file that does not exist, and send the user to edit
 * nothing.
 */
function offReasons(root: string | null, impeccable: InstalledPlugin | null): string[] {
  if (root === null) return [REASON_NO_PROJECT];

  const reasons: string[] = [];
  if (!designReviewAsked(root)) reasons.push(REASON_KEY_FALSE);
  if (impeccable === null) reasons.push(REASON_NOT_INSTALLED);
  return reasons;
}

/** What the JSON states about `impeccable`, which is nothing when none is installed. */
function impeccableJson(impeccable: InstalledPlugin | null): ImpeccableJson | null {
  if (impeccable === null) return null;
  return {
    version: impeccable.version ?? UNKNOWN_VERSION,
    launcher: impeccableLauncher(impeccable.installPath),
  };
}

/**
 * Run the gate and print the answer.
 *
 * The version warning is printed only on a gate that is on. A gate that is
 * off is already explained by its reasons, and a second sentence about a
 * plugin version would bury them.
 */
function runDesignGate(json: boolean): void {
  const root = findProjectRoot();
  const impeccable = findInstalledPlugin(IMPECCABLE_PLUGIN);
  const reasons = offReasons(root, impeccable);
  const on = reasons.length === 0;

  if (on && impeccable !== null) {
    const note = impeccableVersionNote(impeccable.version);
    if (note !== null) console.error(chalk.yellow(note));
  }

  if (json) {
    const answer: DesignGateJson = { on, reasons, impeccable: impeccableJson(impeccable) };
    console.log(JSON.stringify(answer, null, 2));
  } else if (on) {
    console.log('on');
  } else {
    for (const reason of reasons) console.log(`off: ${reason}`);
  }

  if (!on) process.exit(1);
}

export function register(program: Command): void {
  program
    .command('design-gate')
    .description('Answer whether a design review runs here, exiting 0 for on and 1 for off')
    .option('--json', 'print the answer as one JSON object, with the reasons as data')
    .action((opts: { json?: boolean }) => {
      runDesignGate(opts.json === true);
    });
}
