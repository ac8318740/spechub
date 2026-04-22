import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { SPECHUB_DIR, CONFIG_FILE } from './constants.js';
/**
 * Find the project root by walking up looking for an spechub/ directory.
 */
export function findProjectRoot(from = process.cwd()) {
    let dir = resolve(from);
    while (true) {
        if (existsSync(join(dir, SPECHUB_DIR)))
            return dir;
        const parent = resolve(dir, '..');
        if (parent === dir)
            return null;
        dir = parent;
    }
}
/**
 * Read the project config (spechub/config.yaml).
 */
export function readProjectConfig(root) {
    const configPath = join(root, SPECHUB_DIR, CONFIG_FILE);
    if (!existsSync(configPath))
        return null;
    const raw = readFileSync(configPath, 'utf-8');
    return parseYaml(raw);
}
/**
 * Resolve the spechub directory path from a given root.
 */
export function spechubDir(root) {
    return join(root, SPECHUB_DIR);
}
//# sourceMappingURL=project.js.map