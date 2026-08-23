import { join } from 'node:path';
import { homedir } from 'node:os';

export const SPECHUB_DIR = 'spechub';
export const CHANGES_DIR = 'changes';
export const MAPS_DIR = 'maps';
export const SPECS_DIR = 'specs';
export const ARCHIVE_DIR = 'archive';
export const CONFIG_FILE = 'config.yaml';
export const DOMAIN_MAP_FILE = 'domain-map.yaml';

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
