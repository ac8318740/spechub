import { existsSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { SPECHUB_DIR, CHANGES_DIR } from '../lib/constants.js';
import { findProjectRoot, readProjectConfig } from '../lib/project.js';
import { resolveSchema } from '../lib/schema.js';
import { requireProject } from '../lib/utils.js';
export function register(program) {
    program
        .command('status')
        .description('Show artifact completion status for a change')
        .option('--change <name>', 'change name')
        .option('--json', 'output as JSON')
        .action((opts) => {
        const root = findProjectRoot();
        requireProject(root);
        if (!opts.change) {
            console.error(chalk.red('Specify a change with --change <name>'));
            process.exit(1);
        }
        const changeDir = join(root, SPECHUB_DIR, CHANGES_DIR, opts.change);
        if (!existsSync(changeDir)) {
            console.error(chalk.red(`Change '${opts.change}' not found.`));
            process.exit(1);
        }
        const config = readProjectConfig(root);
        const schemaName = config?.schema ?? 'default';
        const schema = resolveSchema(schemaName, root);
        const artifacts = schema?.artifacts ?? [
            { name: 'proposal', filename: 'proposal.md', required: true },
            { name: 'design', filename: 'design.md', required: false },
            { name: 'tasks', filename: 'tasks.md', required: false },
        ];
        const statuses = artifacts.map(a => ({
            name: a.name,
            filename: a.filename,
            required: a.required ?? false,
            exists: existsSync(join(changeDir, a.filename)),
        }));
        if (opts.json) {
            console.log(JSON.stringify({ change: opts.change, artifacts: statuses }, null, 2));
            return;
        }
        console.log(chalk.bold(`Status: ${opts.change}\n`));
        for (const s of statuses) {
            const icon = s.exists ? chalk.green('✓') : (s.required ? chalk.red('✗') : chalk.dim('–'));
            const label = s.required ? s.name : chalk.dim(s.name);
            console.log(`  ${icon} ${label} (${s.filename})`);
        }
    });
}
//# sourceMappingURL=status.js.map