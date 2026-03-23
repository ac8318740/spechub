import { Command } from 'commander';
import chalk from 'chalk';
import { findProjectRoot } from '../lib/project.js';
import { listSchemas } from '../lib/schema.js';

export function register(program: Command): void {
  program
    .command('schemas')
    .description('List available workflow schemas')
    .option('--json', 'output as JSON')
    .action((opts: { json?: boolean }) => {
      const root = findProjectRoot() ?? undefined;
      const schemas = listSchemas(root);

      if (opts.json) {
        console.log(JSON.stringify(schemas.map(s => ({
          name: s.name,
          description: s.description,
          source: s.source,
          artifacts: s.artifacts.map(a => a.name),
        })), null, 2));
        return;
      }

      if (schemas.length === 0) {
        console.log(chalk.dim('No schemas found.'));
        return;
      }

      console.log(chalk.bold(`Schemas (${schemas.length}):\n`));
      for (const s of schemas) {
        console.log(`  ${chalk.cyan(s.name)} ${chalk.dim(`(${s.source})`)}`);
        if (s.description) console.log(`    ${s.description}`);
        console.log(`    Artifacts: ${s.artifacts.map(a => a.name).join(', ')}`);
      }
    });
}
