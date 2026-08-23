import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { resolveVersion } from './lib/version.js';

const program = new Command()
  .name('spechub')
  .description('CLI for spec-driven development')
  .version(resolveVersion(import.meta.dirname));

// Commands are registered by their own modules
const commands = await Promise.all([
  import('./commands/init.js'),
  import('./commands/list.js'),
  import('./commands/show.js'),
  import('./commands/archive.js'),
  import('./commands/node.js'),
  import('./commands/config.js'),
  import('./commands/feedback.js'),
  import('./commands/handoff.js'),
  import('./commands/lint-prose.js'),
]);

for (const mod of commands) {
  mod.register(program);
}

program.addHelpText(
  'after',
  '\nAny other subcommand runs `spechub-<name>` from your PATH, the way git\n' +
    'does. The terminal workspace installs several: md, diff, dash, tab.'
);

// git-style dispatch: `spechub md x` runs `spechub-md x` when md is not a
// built-in. Keeping those helpers as their own executables matters -
// spechub-md --preview runs on every cursor move in a file manager, and
// paying Node's startup for it would make previews noticeably slower.
const first = process.argv[2];
const known = new Set(
  program.commands.flatMap((c) => [c.name(), ...c.aliases()])
);
if (first && !first.startsWith('-') && !known.has(first)) {
  const result = spawnSync(`spechub-${first}`, process.argv.slice(3), {
    stdio: 'inherit',
  });
  // A spawn error carrying an errno code means there is no such helper, so
  // let commander report the unknown command in its own words.
  const failedToSpawn = result.error !== undefined && 'code' in result.error;
  if (!failedToSpawn) {
    process.exit(result.status ?? 0);
  }
}

// parseAsync, not parse: `handoff watch` has an async action handler, and
// `config check` probes the machine on a promise. parse() would return
// before either settled.
await program.parseAsync();
