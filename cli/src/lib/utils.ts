import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import chalk from 'chalk';
import { SPECHUB_DIR, CHANGES_DIR, SPECS_DIR, ARCHIVE_DIR } from './constants.js';

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function readYaml<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  return parseYaml(readFileSync(path, 'utf-8')) as T;
}

export function readMarkdown(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

export function listChanges(root: string): string[] {
  const dir = join(root, SPECHUB_DIR, CHANGES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== ARCHIVE_DIR)
    .map(e => e.name);
}

export function listSpecs(root: string): string[] {
  const dir = join(root, SPECHUB_DIR, SPECS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
}

export function listArchivedChanges(root: string): string[] {
  const dir = join(root, SPECHUB_DIR, CHANGES_DIR, ARCHIVE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
}

export function requireProject(root: string | null): asserts root is string {
  if (!root) {
    console.error(chalk.red('Not in a SpecHub project. Run `spechub init` first.'));
    process.exit(1);
  }
}

export function formatDate(): string {
  return new Date().toISOString().split('T')[0];
}
