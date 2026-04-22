import { existsSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { SPECHUB_DIR, CHANGES_DIR, ARCHIVE_DIR } from '../lib/constants.js';
import { findProjectRoot } from '../lib/project.js';
import { listChanges, requireProject, formatDate, ensureDir } from '../lib/utils.js';
export function register(program) {
    program
        .command('archive')
        .description('Archive a completed change')
        .argument('[name]', 'change name')
        .option('-y, --yes', 'skip confirmation')
        .option('--skip-specs', 'skip living spec updates')
        .action((name, opts) => {
        const root = findProjectRoot();
        requireProject(root);
        // If no name, list changes
        if (!name) {
            const changes = listChanges(root);
            if (changes.length === 0) {
                console.log(chalk.dim('No active changes to archive.'));
                return;
            }
            console.log(chalk.bold('Active changes:'));
            for (const c of changes) {
                console.log(`  ${c}`);
            }
            console.log(chalk.dim('\nRun: spechub archive <name>'));
            return;
        }
        const changeDir = join(root, SPECHUB_DIR, CHANGES_DIR, name);
        if (!existsSync(changeDir)) {
            console.error(chalk.red(`Change '${name}' not found.`));
            process.exit(1);
        }
        const archiveName = `${formatDate()}-${name}`;
        const archiveDir = join(root, SPECHUB_DIR, CHANGES_DIR, ARCHIVE_DIR, archiveName);
        ensureDir(join(root, SPECHUB_DIR, CHANGES_DIR, ARCHIVE_DIR));
        cpSync(changeDir, archiveDir, { recursive: true });
        rmSync(changeDir, { recursive: true });
        console.log(chalk.green(`Archived: ${name}`));
        console.log(`  From: ${SPECHUB_DIR}/${CHANGES_DIR}/${name}/`);
        console.log(`  To:   ${SPECHUB_DIR}/${CHANGES_DIR}/${ARCHIVE_DIR}/${archiveName}/`);
        if (!opts.skipSpecs) {
            console.log(chalk.dim('\nRemember to update living specs if needed.'));
        }
    });
}
//# sourceMappingURL=archive.js.map