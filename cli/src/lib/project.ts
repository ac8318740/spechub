import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SPECHUB_DIR } from './constants.js';

/**
 * Find the project root by walking up looking for an spechub/ directory.
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
