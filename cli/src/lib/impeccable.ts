/**
 * What SpecHub knows about impeccable, the separate Claude Code plugin a
 * design review calls.
 *
 * Two surfaces report on it - the impeccable row of `spechub config check`,
 * and `spechub design-gate` - and they have to agree on the plugin's name, on
 * the version SpecHub expects, and on what to say about a version that falls
 * short. Each of those is written down once here, so a rename or a bumped
 * expectation cannot land on one surface and miss the other.
 *
 * Nothing here runs impeccable. The version comes from the manifest
 * `lib/claude-plugins.ts` reads, and the launcher is a path this file joins
 * and never stats.
 */

import { join } from 'node:path';
import { majorVersion } from './claude-plugins.js';

/** The design plugin, spelled the way its own manifest spells it. */
export const IMPECCABLE_PLUGIN = 'impeccable';

/** The major version of impeccable SpecHub's design review is written against. */
export const IMPECCABLE_MIN_MAJOR = 4;

/**
 * Where impeccable's launcher sits inside an install path.
 *
 * A plain join, never a check: a caller that wants to know whether the
 * launcher runs is the one that has to find out. Stating the path costs two
 * files read, and stating that it works costs a process started.
 */
export function impeccableLauncher(installPath: string): string {
  return join(installPath, '.claude', 'skills', IMPECCABLE_PLUGIN, 'scripts', IMPECCABLE_PLUGIN);
}

/**
 * What to say about an installed impeccable at `version`, or null when there
 * is nothing to say because it is major 4 or later.
 *
 * Both halves of the answer go in the sentence - what is installed, and what
 * SpecHub wanted - because naming one leaves the reader to look the other up.
 *
 * A null `version` is a manifest that states none, which is its own sentence:
 * the plugin is installed and its version is unreadable, and standing in the
 * registry's number would report a version nothing read.
 */
export function impeccableVersionNote(version: string | null): string | null {
  if (version === null) {
    return (
      `${IMPECCABLE_PLUGIN} is installed, and its manifest states no version to read - ` +
      `SpecHub expects major ${IMPECCABLE_MIN_MAJOR} or later`
    );
  }

  const major = majorVersion(version);
  if (major !== null && major >= IMPECCABLE_MIN_MAJOR) return null;

  return (
    `${IMPECCABLE_PLUGIN} ${version} is installed, and SpecHub expects ` +
    `major ${IMPECCABLE_MIN_MAJOR} or later`
  );
}
