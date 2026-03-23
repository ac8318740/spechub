import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf-8')
);

const program = new Command()
  .name('spechub')
  .description('CLI for spec-driven development')
  .version(pkg.version);

// Commands are registered by their own modules
const commands = await Promise.all([
  import('./commands/init.js'),
  import('./commands/new-change.js'),
  import('./commands/list.js'),
  import('./commands/show.js'),
  import('./commands/status.js'),
  import('./commands/instructions.js'),
  import('./commands/archive.js'),
  import('./commands/validate.js'),
  import('./commands/config.js'),
  import('./commands/schemas.js'),
  import('./commands/feedback.js'),
]);

for (const mod of commands) {
  mod.register(program);
}

program.parse();
