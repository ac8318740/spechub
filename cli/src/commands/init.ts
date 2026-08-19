import { Command } from 'commander';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify as toYaml } from 'yaml';
import chalk from 'chalk';
import { SPECHUB_DIR, SPECS_DIR, CONFIG_FILE } from '../lib/constants.js';
import { ensureDir } from '../lib/utils.js';

export function register(program: Command): void {
  program
    .command('init')
    .description('Initialize SpecHub in a project')
    .argument('[path]', 'project directory', '.')
    .option('--force', 'overwrite existing configuration')
    .action((path: string, opts: { force?: boolean }) => {
      const root = resolve(path);
      const dir = join(root, SPECHUB_DIR);

      if (existsSync(dir) && !opts.force) {
        console.error(chalk.yellow(`${SPECHUB_DIR}/ already exists. Use --force to overwrite.`));
        process.exit(1);
      }

      // Create directory structure
      ensureDir(join(dir, SPECS_DIR));

      // Write config
      const config = {
        context: {},
      };
      writeFileSync(join(dir, CONFIG_FILE), toYaml(config), 'utf-8');

      console.log(chalk.green('Initialized SpecHub project:'));
      console.log(`  ${SPECHUB_DIR}/`);
      console.log(`  ${SPECHUB_DIR}/${SPECS_DIR}/`);
      console.log(`  ${SPECHUB_DIR}/${CONFIG_FILE}`);
    });
}
