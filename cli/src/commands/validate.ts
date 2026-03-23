import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { SPECHUB_DIR, CHANGES_DIR, SPECS_DIR } from '../lib/constants.js';
import { findProjectRoot, readProjectConfig } from '../lib/project.js';
import { resolveSchema } from '../lib/schema.js';
import { listChanges, listSpecs, requireProject } from '../lib/utils.js';

interface ValidationResult {
  name: string;
  type: 'change' | 'spec';
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function validateChange(root: string, name: string, strict: boolean): ValidationResult {
  const result: ValidationResult = { name, type: 'change', valid: true, errors: [], warnings: [] };
  const changeDir = join(root, SPECHUB_DIR, CHANGES_DIR, name);

  if (!existsSync(changeDir)) {
    result.valid = false;
    result.errors.push('Change directory does not exist');
    return result;
  }

  // Check for proposal.md (always required)
  const proposalPath = join(changeDir, 'proposal.md');
  if (!existsSync(proposalPath)) {
    result.valid = false;
    result.errors.push('Missing required artifact: proposal.md');
  } else {
    const content = readFileSync(proposalPath, 'utf-8');
    if (content.trim().length < 50) {
      result.warnings.push('proposal.md appears to be a stub (< 50 chars)');
      if (strict) {
        result.valid = false;
        result.errors.push('proposal.md too short in strict mode');
      }
    }
  }

  return result;
}

function validateSpec(root: string, name: string, strict: boolean): ValidationResult {
  const result: ValidationResult = { name, type: 'spec', valid: true, errors: [], warnings: [] };
  const specDir = join(root, SPECHUB_DIR, SPECS_DIR, name);
  const specFile = join(specDir, 'spec.md');

  if (!existsSync(specFile)) {
    result.valid = false;
    result.errors.push('Missing spec.md');
    return result;
  }

  const content = readFileSync(specFile, 'utf-8');

  // Check for [PLANNED] items (living specs should only document what IS implemented)
  if (content.includes('[PLANNED]')) {
    result.warnings.push('Contains [PLANNED] items – living specs document what is implemented, not roadmap');
    if (strict) {
      result.valid = false;
      result.errors.push('[PLANNED] items not allowed in strict mode');
    }
  }

  return result;
}

export function register(program: Command): void {
  program
    .command('validate')
    .description('Validate changes and/or specs')
    .argument('[name]', 'specific item to validate')
    .option('--all', 'validate everything')
    .option('--changes', 'validate all changes')
    .option('--specs', 'validate all specs')
    .option('--strict', 'strict validation')
    .option('--json', 'output as JSON')
    .action((name: string | undefined, opts: { all?: boolean; changes?: boolean; specs?: boolean; strict?: boolean; json?: boolean }) => {
      const root = findProjectRoot();
      requireProject(root);

      const strict = opts.strict ?? false;
      const results: ValidationResult[] = [];

      if (name) {
        // Validate specific item
        const changeDir = join(root, SPECHUB_DIR, CHANGES_DIR, name);
        const specDir = join(root, SPECHUB_DIR, SPECS_DIR, name);
        if (existsSync(changeDir)) results.push(validateChange(root, name, strict));
        if (existsSync(specDir)) results.push(validateSpec(root, name, strict));
        if (results.length === 0) {
          console.error(chalk.red(`'${name}' not found as a change or spec.`));
          process.exit(1);
        }
      } else {
        const doChanges = opts.all || opts.changes || (!opts.specs);
        const doSpecs = opts.all || opts.specs;

        if (doChanges) {
          for (const c of listChanges(root)) results.push(validateChange(root, c, strict));
        }
        if (doSpecs) {
          for (const s of listSpecs(root)) results.push(validateSpec(root, s, strict));
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      if (results.length === 0) {
        console.log(chalk.dim('Nothing to validate.'));
        return;
      }

      let allValid = true;
      for (const r of results) {
        const icon = r.valid ? chalk.green('✓') : chalk.red('✗');
        console.log(`${icon} ${r.type}: ${r.name}`);
        for (const e of r.errors) console.log(chalk.red(`    error: ${e}`));
        for (const w of r.warnings) console.log(chalk.yellow(`    warn: ${w}`));
        if (!r.valid) allValid = false;
      }

      if (!allValid) process.exit(1);
    });
}
