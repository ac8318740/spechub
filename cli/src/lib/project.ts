import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SPECHUB_DIR, CONFIG_FILE } from './constants.js';

export interface ProjectConfig {
  schema?: string;
  context?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Find the project root by walking up looking for an openspec/ directory.
 */
export function findProjectRoot(from: string = process.cwd()): string | null {
  let dir = resolve(from);
  while (true) {
    if (existsSync(join(dir, SPECHUB_DIR))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Read the project config (openspec/config.yaml).
 */
export function readProjectConfig(root: string): ProjectConfig | null {
  const configPath = join(root, SPECHUB_DIR, CONFIG_FILE);
  if (!existsSync(configPath)) return null;
  const raw = readFileSync(configPath, 'utf-8');
  return parseYaml(raw) as ProjectConfig;
}

/**
 * Resolve the openspec directory path from a given root.
 */
export function spechubDir(root: string): string {
  return join(root, SPECHUB_DIR);
}
