import { Command } from 'commander';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { SPECHUB_DIR, CHANGES_DIR } from '../lib/constants.js';
import { findProjectRoot, readProjectConfig } from '../lib/project.js';
import { resolveSchema } from '../lib/schema.js';
import { ensureDir, requireProject } from '../lib/utils.js';

function defaultTemplate(artifact: string, changeName: string): string {
  const templates: Record<string, string> = {
    'proposal.md': `# ${changeName}\n\n## Summary\n\n<!-- What and why -->\n\n## User Stories\n\n### P1 (Must Have)\n\n- As a [user], I want [feature] so that [benefit]\n\n### P2 (Should Have)\n\n### P3 (Nice to Have)\n\n## Acceptance Criteria\n\n- [ ] \n`,
    'design.md': `# ${changeName} – Design\n\n## Approach\n\n<!-- Technical approach and architecture -->\n\n## Components\n\n## API Changes\n\n## Data Model Changes\n\n## Open Questions\n`,
    'tasks.md': `# ${changeName} – Tasks\n\n## Task List\n\n| ID | Task | Status | Dependencies |\n|----|------|--------|-------------|\n| T001 | | todo | – |\n`,
  };
  return templates[artifact] ?? `# ${changeName} – ${artifact}\n`;
}

export function register(program: Command): void {
  const newCmd = program
    .command('new')
    .description('Create new artifacts');

  newCmd
    .command('change')
    .description('Create a new change proposal')
    .argument('<name>', 'change name (kebab-case)')
    .option('--description <text>', 'short description')
    .option('--schema <name>', 'workflow schema override')
    .action((name: string, opts: { description?: string; schema?: string }) => {
      const root = findProjectRoot();
      requireProject(root);

      const changeDir = join(root, SPECHUB_DIR, CHANGES_DIR, name);
      if (existsSync(changeDir)) {
        console.error(chalk.red(`Change '${name}' already exists.`));
        process.exit(1);
      }

      // Determine schema
      const config = readProjectConfig(root);
      const schemaName = opts.schema ?? config?.schema as string ?? 'default';
      const schema = resolveSchema(schemaName, root);

      ensureDir(changeDir);
      ensureDir(join(changeDir, 'specs'));

      // Scaffold artifacts
      const artifacts = schema?.artifacts ?? [
        { name: 'proposal', filename: 'proposal.md' },
        { name: 'design', filename: 'design.md' },
        { name: 'tasks', filename: 'tasks.md' },
      ];

      for (const artifact of artifacts) {
        const filePath = join(changeDir, artifact.filename);
        const content = defaultTemplate(artifact.filename, name);
        writeFileSync(filePath, content, 'utf-8');
      }

      console.log(chalk.green(`Created change: ${name}`));
      console.log(`  ${SPECHUB_DIR}/${CHANGES_DIR}/${name}/`);
      for (const artifact of artifacts) {
        console.log(`    ${artifact.filename}`);
      }
      if (opts.description) {
        console.log(`  Description: ${opts.description}`);
      }
    });
}
