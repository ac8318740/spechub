import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SPECHUB_DIR } from './constants.js';

const PLUGIN_MARKER = join('.claude-plugin', 'plugin.json');

/**
 * Walk up from startDir, inclusive, for the nearest directory holding marker.
 *
 * The marker may be a nested path such as `.claude-plugin/plugin.json`, not
 * only a bare filename. Stops at the filesystem root and returns null when no
 * ancestor matches.
 */
export function findUp(startDir: string, marker: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Find the project root by walking up looking for an spechub/ directory.
 */
export function findProjectRoot(from: string = process.cwd()): string | null {
  return findUp(from, SPECHUB_DIR);
}

/**
 * Find the plugin root: the directory holding .claude-plugin/plugin.json.
 *
 * CLAUDE_PLUGIN_ROOT wins when it is set and the directory it names really
 * holds the marker. A stale variable falls back to walking up, so a wrong
 * environment cannot break the CLI.
 *
 * The default start is the running CLI file rather than the user's project
 * root, because the files looked for here ship with the plugin. That resolves
 * for both the bundled layout (<plugin>/cli/dist/index.js) and the source
 * layout (<plugin>/cli/src/lib/project.ts), because Node resolves the
 * ~/.claude/spechub/bin/spechub symlink before setting import.meta.dirname.
 */
export function findPluginRoot(startDir: string = import.meta.dirname): string | null {
  const fromEnv = process.env.CLAUDE_PLUGIN_ROOT;
  if (fromEnv && existsSync(join(fromEnv, PLUGIN_MARKER))) return resolve(fromEnv);
  return findUp(startDir, PLUGIN_MARKER);
}
