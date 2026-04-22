import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { GLOBAL_DATA_DIR } from './constants.js';
const PACKAGE_SCHEMAS_DIR = join(import.meta.dirname, '..', '..', 'schemas');
/**
 * Resolution order: project spechub/schemas/ > user ~/.local/share/spechub/schemas/ > package schemas/
 */
export function resolveSchema(name, projectRoot) {
    const locations = [];
    if (projectRoot) {
        locations.push({ dir: join(projectRoot, 'spechub', 'schemas'), source: 'project' });
    }
    locations.push({ dir: join(GLOBAL_DATA_DIR, 'schemas'), source: 'user' });
    locations.push({ dir: PACKAGE_SCHEMAS_DIR, source: 'package' });
    for (const { dir, source } of locations) {
        const schemaPath = join(dir, name, 'schema.yaml');
        if (existsSync(schemaPath)) {
            const raw = readFileSync(schemaPath, 'utf-8');
            const parsed = parseYaml(raw);
            return { ...parsed, name, source, path: schemaPath };
        }
    }
    return null;
}
/**
 * List all available schemas across all resolution levels.
 */
export function listSchemas(projectRoot) {
    const seen = new Set();
    const schemas = [];
    const locations = [];
    if (projectRoot) {
        locations.push({ dir: join(projectRoot, 'spechub', 'schemas'), source: 'project' });
    }
    locations.push({ dir: join(GLOBAL_DATA_DIR, 'schemas'), source: 'user' });
    locations.push({ dir: PACKAGE_SCHEMAS_DIR, source: 'package' });
    for (const { dir, source } of locations) {
        if (!existsSync(dir))
            continue;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory() || seen.has(entry.name))
                continue;
            const schema = resolveSchema(entry.name, projectRoot);
            if (schema) {
                seen.add(entry.name);
                schemas.push(schema);
            }
        }
    }
    return schemas;
}
//# sourceMappingURL=schema.js.map