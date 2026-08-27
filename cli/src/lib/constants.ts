import { join } from 'node:path';
import { homedir } from 'node:os';

export const SPECHUB_DIR = 'spechub';
export const CHANGES_DIR = 'changes';
export const MAPS_DIR = 'maps';
export const SPECS_DIR = 'specs';
export const ARCHIVE_DIR = 'archive';
export const PROJECT_FILE = 'project.yaml';
export const DOMAIN_MAP_FILE = 'domain-map.yaml';

/**
 * Where the per-project-type starting configurations live, relative to the
 * plugin root. `/spechub:setup` copies one into a new project.yaml, and
 * `spechub config set profile <name>` validates against the names here.
 */
export const PROFILES_DIR = 'profiles';

/**
 * Files a project carries outside spechub/, written by the setup skill and
 * read back by `spechub config check`. Named here rather than at the point of
 * use so the skill that writes one and the check that looks for it can never
 * drift on to different filenames.
 */
export const AGENT_BROWSER_JSON_FILE = 'agent-browser.json';
export const VERIFICATION_KNOWLEDGE_FILE = 'VERIFICATION-KNOWLEDGE.md';

/** The agent-browser CLI, as it is named on PATH and installed from npm. */
export const AGENT_BROWSER_BIN = 'agent-browser';

/** Where Claude Code keeps its settings, in a project and under a home directory. */
export const CLAUDE_DIR = '.claude';
export const CLAUDE_SETTINGS_FILE = 'settings.json';
export const CLAUDE_LOCAL_SETTINGS_FILE = 'settings.local.json';

/**
 * The output style this plugin ships, spelled the way Claude Code names it in
 * a settings file: the plugin's name, a colon, and the style's basename.
 * Written down once here so the check that reports which style is selected
 * and anything that selects one can never drift apart on the string.
 */
export const SPECHUB_OUTPUT_STYLE = 'spechub:ac-writing-style';

/**
 * The vocabulary the prose linter reads its deny lists from, relative to the
 * plugin root. This is the single place the path is written down; everything
 * else composes it with findPluginRoot().
 */
export const VOCABULARY_PATH = join('skills', 'writing', 'vocabulary.md');

export const GLOBAL_CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
  'spechub'
);
export const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'config.json');

export const GLOBAL_DATA_DIR = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
  'spechub'
);
