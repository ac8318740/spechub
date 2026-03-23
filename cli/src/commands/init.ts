import { Command } from 'commander';
import { existsSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify as toYaml } from 'yaml';
import chalk from 'chalk';
import { SPECHUB_DIR, CHANGES_DIR, SPECS_DIR, ARCHIVE_DIR, CONFIG_FILE } from '../lib/constants.js';
import { resolveSchema } from '../lib/schema.js';
import { ensureDir } from '../lib/utils.js';

export function register(program: Command): void {
  program
    .command('init')
    .description('Initialize SpecHub in a project')
    .argument('[path]', 'project directory', '.')
    .option('--force', 'overwrite existing configuration')
    .option('--schema <name>', 'workflow schema to use', 'default')
    .action((path: string, opts: { force?: boolean; schema: string }) => {
      const root = resolve(path);
      const dir = join(root, SPECHUB_DIR);

      if (existsSync(dir) && !opts.force) {
        console.error(chalk.yellow(`${SPECHUB_DIR}/ already exists. Use --force to overwrite.`));
        process.exit(1);
      }

      // Create directory structure
      ensureDir(join(dir, SPECS_DIR));
      ensureDir(join(dir, CHANGES_DIR, ARCHIVE_DIR));

      // Resolve schema
      const schema = resolveSchema(opts.schema);

      // Write config
      const config = {
        schema: opts.schema,
        context: {},
      };
      writeFileSync(join(dir, CONFIG_FILE), toYaml(config), 'utf-8');

      // Copy schema templates if they exist
      if (schema) {
        const templatesDir = join(schema.path, '..', 'templates');
        if (existsSync(templatesDir)) {
          const targetTemplates = join(dir, 'schemas', opts.schema, 'templates');
          ensureDir(targetTemplates);
          cpSync(templatesDir, targetTemplates, { recursive: true });
        }
      }

      console.log(chalk.green('Initialized SpecHub project:'));
      console.log(`  ${SPECHUB_DIR}/`);
      console.log(`  ${SPECHUB_DIR}/${SPECS_DIR}/`);
      console.log(`  ${SPECHUB_DIR}/${CHANGES_DIR}/`);
      console.log(`  ${SPECHUB_DIR}/${CHANGES_DIR}/${ARCHIVE_DIR}/`);
      console.log(`  ${SPECHUB_DIR}/${CONFIG_FILE}`);
      if (schema) {
        console.log(`  Schema: ${opts.schema} (${schema.source})`);
      } else {
        console.log(chalk.yellow(`  Schema '${opts.schema}' not found – using defaults`));
      }
    });
}
