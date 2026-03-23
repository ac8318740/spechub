import { join } from 'node:path';
import { homedir } from 'node:os';

export const SPECHUB_DIR = 'spechub';
export const CHANGES_DIR = 'changes';
export const SPECS_DIR = 'specs';
export const ARCHIVE_DIR = 'archive';
export const CONFIG_FILE = 'config.yaml';
export const DOMAIN_MAP_FILE = 'domain-map.yaml';

export const GLOBAL_CONFIG_DIR = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
  'spechub'
);
export const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, 'config.json');

export const GLOBAL_DATA_DIR = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
  'spechub'
);
