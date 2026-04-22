import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { SPECHUB_DIR, CHANGES_DIR, SPECS_DIR } from '../lib/constants.js';
import { findProjectRoot } from '../lib/project.js';
import { listChanges, listSpecs, requireProject } from '../lib/utils.js';
export function register(program) {
    program
        .command('list')
        .description('List active changes or specs')
        .option('--specs', 'list specs instead of changes')
        .option('--changes', 'list changes (default)')
        .option('--json', 'output as JSON')
        .option('--sort <order>', 'sort order: name or recent', 'recent')
        .action((opts) => {
        const root = findProjectRoot();
        requireProject(root);
        const showSpecs = opts.specs && !opts.changes;
        const items = [];
        if (showSpecs) {
            for (const name of listSpecs(root)) {
                const specDir = join(root, SPECHUB_DIR, SPECS_DIR, name);
                const specFile = join(specDir, 'spec.md');
                items.push({
                    name,
                    type: 'spec',
                    path: specDir,
                    modified: existsSync(specFile)
                        ? statSync(specFile).mtime.toISOString().split('T')[0]
                        : undefined,
                });
            }
        }
        else {
            for (const name of listChanges(root)) {
                const changeDir = join(root, SPECHUB_DIR, CHANGES_DIR, name);
                const artifacts = existsSync(changeDir)
                    ? readdirSync(changeDir)
                        .filter(f => f.endsWith('.md'))
                        .map(f => f.replace('.md', ''))
                    : [];
                items.push({
                    name,
                    type: 'change',
                    path: changeDir,
                    artifacts,
                });
            }
        }
        if (opts.sort === 'name') {
            items.sort((a, b) => a.name.localeCompare(b.name));
        }
        if (opts.json) {
            console.log(JSON.stringify(items, null, 2));
            return;
        }
        if (items.length === 0) {
            console.log(chalk.dim(showSpecs ? 'No specs found.' : 'No active changes.'));
            return;
        }
        const label = showSpecs ? 'Specs' : 'Active Changes';
        console.log(chalk.bold(`${label} (${items.length}):\n`));
        for (const item of items) {
            console.log(`  ${chalk.cyan(item.name)}`);
            if (item.artifacts?.length) {
                console.log(`    Artifacts: ${item.artifacts.join(', ')}`);
            }
            if (item.modified) {
                console.log(`    Modified: ${item.modified}`);
            }
        }
    });
}
//# sourceMappingURL=list.js.map