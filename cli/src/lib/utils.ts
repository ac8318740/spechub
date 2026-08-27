import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import chalk from 'chalk';
import { SPECHUB_DIR, CHANGES_DIR, SPECS_DIR, ARCHIVE_DIR } from './constants.js';

/**
 * Print an error to stderr and exit 1. The optional hint goes on a second
 * line, dimmed, for the "what to do about it" half of the message.
 */
export function fail(message: string, hint?: string): never {
  console.error(chalk.red(message));
  if (hint) console.error(chalk.dim(hint));
  process.exit(1);
}

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
  if (!root) fail('Not in a SpecHub project. Run `/spechub:setup` first.');
}

export function formatDate(): string {
  return new Date().toISOString().split('T')[0];
}
