import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { SPECHUB_DIR, CHANGES_DIR } from '../lib/constants.js';
import { findProjectRoot, readProjectConfig } from '../lib/project.js';
import { resolveSchema } from '../lib/schema.js';
import { requireProject } from '../lib/utils.js';

export function register(program: Command): void {
  program
    .command('instructions')
    .description('Output enriched instructions for creating an artifact')
    .argument('<artifact>', 'artifact name (proposal, design, tasks, apply)')
    .option('--change <name>', 'change name')
    .option('--schema <name>', 'schema override')
    .option('--json', 'output as JSON')
    .action((artifact: string, opts: { change?: string; schema?: string; json?: boolean }) => {
      const root = findProjectRoot();
      requireProject(root);

      const config = readProjectConfig(root);
      const schemaName = opts.schema ?? config?.schema as string ?? 'default';
      const schema = resolveSchema(schemaName, root);

      if (!schema) {
        console.error(chalk.red(`Schema '${schemaName}' not found.`));
        process.exit(1);
      }

      // Find the artifact in schema
      const artifactDef = schema.artifacts.find(a => a.name === artifact);
      if (!artifactDef) {
        console.error(chalk.red(`Artifact '${artifact}' not defined in schema '${schemaName}'.`));
        console.error(`Available: ${schema.artifacts.map(a => a.name).join(', ')}`);
        process.exit(1);
      }

      // Load template if it exists
      let template = '';
      if (artifactDef.template) {
        const templatePath = join(schema.path, '..', 'templates', artifactDef.template);
        if (existsSync(templatePath)) {
          template = readFileSync(templatePath, 'utf-8');
        }
      }

      // Load existing change context
      let context: Record<string, string> = {};
      if (opts.change) {
        const changeDir = join(root, SPECHUB_DIR, CHANGES_DIR, opts.change);
        if (existsSync(changeDir)) {
          // Read existing artifacts as context
          for (const a of schema.artifacts) {
            const filePath = join(changeDir, a.filename);
            if (existsSync(filePath) && a.name !== artifact) {
              context[a.name] = readFileSync(filePath, 'utf-8');
            }
          }
        }
      }

      const result = {
        artifact: artifactDef.name,
        schema: schemaName,
        change: opts.change ?? null,
        template,
        context,
        description: artifactDef.description ?? '',
      };

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.bold(`Instructions: ${artifact}`));
      if (artifactDef.description) {
        console.log(`\n${artifactDef.description}`);
      }
      if (template) {
        console.log(chalk.dim('\n--- Template ---\n'));
        console.log(template);
      }
      if (Object.keys(context).length > 0) {
        console.log(chalk.dim('\n--- Context (existing artifacts) ---'));
        for (const [name, content] of Object.entries(context)) {
          console.log(chalk.dim(`\n[${name}]`));
          console.log(content.slice(0, 500) + (content.length > 500 ? '...' : ''));
        }
      }
    });
}
