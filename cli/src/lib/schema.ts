import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { GLOBAL_DATA_DIR } from './constants.js';

export interface SchemaDefinition {
  name: string;
  description?: string;
  artifacts: SchemaArtifact[];
  source: 'project' | 'user' | 'package';
  path: string;
}

export interface SchemaArtifact {
  name: string;
  filename: string;
  description?: string;
  required?: boolean;
  template?: string;
}

const PACKAGE_SCHEMAS_DIR = join(import.meta.dirname, '..', '..', 'schemas');

/**
 * Resolution order: project openspec/schemas/ > user ~/.local/share/spechub/schemas/ > package schemas/
 */
export function resolveSchema(name: string, projectRoot?: string): SchemaDefinition | null {
  const locations: Array<{ dir: string; source: SchemaDefinition['source'] }> = [];

  if (projectRoot) {
    locations.push({ dir: join(projectRoot, 'openspec', 'schemas'), source: 'project' });
  }
  locations.push({ dir: join(GLOBAL_DATA_DIR, 'schemas'), source: 'user' });
  locations.push({ dir: PACKAGE_SCHEMAS_DIR, source: 'package' });

  for (const { dir, source } of locations) {
    const schemaPath = join(dir, name, 'schema.yaml');
    if (existsSync(schemaPath)) {
      const raw = readFileSync(schemaPath, 'utf-8');
      const parsed = parseYaml(raw) as Omit<SchemaDefinition, 'source' | 'path'>;
      return { ...parsed, name, source, path: schemaPath };
    }
  }
  return null;
}

/**
 * List all available schemas across all resolution levels.
 */
export function listSchemas(projectRoot?: string): SchemaDefinition[] {
  const seen = new Set<string>();
  const schemas: SchemaDefinition[] = [];
  const locations: Array<{ dir: string; source: SchemaDefinition['source'] }> = [];

  if (projectRoot) {
    locations.push({ dir: join(projectRoot, 'openspec', 'schemas'), source: 'project' });
  }
  locations.push({ dir: join(GLOBAL_DATA_DIR, 'schemas'), source: 'user' });
  locations.push({ dir: PACKAGE_SCHEMAS_DIR, source: 'package' });

  for (const { dir, source } of locations) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      const schema = resolveSchema(entry.name, projectRoot);
      if (schema) {
        seen.add(entry.name);
        schemas.push(schema);
      }
    }
  }
  return schemas;
}
