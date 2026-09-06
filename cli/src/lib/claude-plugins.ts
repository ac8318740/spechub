import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeConfigRoot } from './constants.js';

/**
 * What SpecHub can learn about another Claude Code plugin, by reading the two
 * files Claude Code writes when it installs one.
 *
 *   <config root>/plugins/installed_plugins.json  - the registry, saying which
 *      plugins are installed and where each one lives. Keys are
 *      `<plugin>@<marketplace>`, and the marketplace half is wherever the user
 *      installed from.
 *   <installPath>/.claude-plugin/plugin.json      - the installed plugin's own
 *      manifest, and the authoritative statement of its version.
 *
 * Reading beats running. Asking a plugin its own version means starting it,
 * which is slow, and which a half-written install may not manage at all.
 *
 * The registry carries a version too, and it is the stale one: it records what
 * was installed, and an update rewrites the files before it rewrites the entry.
 * So nothing here reports the registry's number.
 */

/** The registry file, under config root `root`. */
const REGISTRY_PATH = join('plugins', 'installed_plugins.json');

/** One installed plugin's manifest, within its install path. */
const MANIFEST_PATH = join('.claude-plugin', 'plugin.json');

/** One plugin the registry names. */
export interface InstalledPlugin {
  /** Where the plugin's files live, as the registry states it. */
  installPath: string;
  /**
   * The version its manifest states, or null when no manifest states one.
   *
   * Null is a real answer rather than an error: the plugin is installed, and
   * its version cannot be read. A caller that wants a version has to say what
   * it does when there is none, so the type makes it.
   */
  version: string | null;
}

/** Parse JSON without ever throwing, because a file the user broke is an answer. */
function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch {
    return undefined;
  }
}

/** The `plugins` block of the registry, or an empty one when nothing states it. */
function registryPlugins(root: string): Record<string, unknown> {
  const parsed = readJson(join(root, REGISTRY_PATH));
  if (typeof parsed !== 'object' || parsed === null) return {};

  const plugins = (parsed as { plugins?: unknown }).plugins;
  if (typeof plugins !== 'object' || plugins === null) return {};
  return plugins as Record<string, unknown>;
}

/** Where the registry says `entries` is installed, or null when it says nowhere. */
function installPathOf(entries: unknown): string | null {
  if (!Array.isArray(entries) || entries.length === 0) return null;

  const first = entries[0] as { installPath?: unknown } | null;
  if (typeof first !== 'object' || first === null) return null;
  return typeof first.installPath === 'string' ? first.installPath : null;
}

/** The version `installPath`'s manifest states, or null when it states none. */
function manifestVersion(installPath: string): string | null {
  const parsed = readJson(join(installPath, MANIFEST_PATH));
  if (typeof parsed !== 'object' || parsed === null) return null;

  const version = (parsed as { version?: unknown }).version;
  return typeof version === 'string' && version !== '' ? version : null;
}

/**
 * The plugin named `name`, or null when Claude Code has none installed.
 *
 * The registry key is `<plugin>@<marketplace>`, so only the half before the
 * `@` is matched: the same plugin arrives under a different marketplace name
 * depending on where the user installed it from, and matching the whole key
 * would find one of those ways and miss the rest.
 */
export function findInstalledPlugin(name: string): InstalledPlugin | null {
  const plugins = registryPlugins(claudeConfigRoot());

  for (const [key, entries] of Object.entries(plugins)) {
    if (key.split('@')[0] !== name) continue;

    const installPath = installPathOf(entries);
    if (installPath === null) return { installPath: '', version: null };
    return { installPath, version: manifestVersion(installPath) };
  }

  return null;
}

/**
 * The major number of `version`, or null when it does not start with one.
 *
 * A number rather than the string it was cut from, because the comparison a
 * caller makes is numeric: `10` sorts before `4` as text, so a string
 * comparison calls a newer plugin too old.
 */
export function majorVersion(version: string): number | null {
  const head = version.split('.')[0];
  if (!/^\d+$/.test(head)) return null;
  return Number.parseInt(head, 10);
}
