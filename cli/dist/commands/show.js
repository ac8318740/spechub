import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { SPECHUB_DIR, CHANGES_DIR, SPECS_DIR } from '../lib/constants.js';
import { findProjectRoot } from '../lib/project.js';
import { requireProject } from '../lib/utils.js';
export function register(program) {
    program
        .command('show')
        .description('Display a change or spec')
        .argument('[name]', 'change or spec name')
        .option('--json', 'output as JSON')
        .option('--type <type>', 'force type: change or spec')
        .action((name, opts) => {
        const root = findProjectRoot();
        requireProject(root);
        if (!name) {
            console.error(chalk.red('Provide a change or spec name.'));
            process.exit(1);
        }
        // Auto-detect type
        const changeDir = join(root, SPECHUB_DIR, CHANGES_DIR, name);
        const specDir = join(root, SPECHUB_DIR, SPECS_DIR, name);
        let type;
        let targetDir;
        if (opts.type === 'spec' || (!opts.type && !existsSync(changeDir) && existsSync(specDir))) {
            type = 'spec';
            targetDir = specDir;
        }
        else if (existsSync(changeDir)) {
            type = 'change';
            targetDir = changeDir;
        }
        else if (existsSync(specDir)) {
            type = 'spec';
            targetDir = specDir;
        }
        else {
            console.error(chalk.red(`'${name}' not found as a change or spec.`));
            process.exit(1);
        }
        if (type === 'spec') {
            const specFile = join(targetDir, 'spec.md');
            if (!existsSync(specFile)) {
                console.error(chalk.red(`Spec '${name}' has no spec.md file.`));
                process.exit(1);
            }
            const content = readFileSync(specFile, 'utf-8');
            if (opts.json) {
                console.log(JSON.stringify({ name, type: 'spec', content }, null, 2));
            }
            else {
                console.log(content);
            }
            return;
        }
        // Change: show all artifacts
        const files = readdirSync(targetDir).filter(f => f.endsWith('.md'));
        const artifacts = {};
        for (const file of files) {
            artifacts[file.replace('.md', '')] = readFileSync(join(targetDir, file), 'utf-8');
        }
        if (opts.json) {
            console.log(JSON.stringify({ name, type: 'change', artifacts }, null, 2));
            return;
        }
        for (const [artifact, content] of Object.entries(artifacts)) {
            console.log(chalk.bold.underline(`${artifact}`));
            console.log(content);
            console.log();
        }
    });
}
//# sourceMappingURL=show.js.map