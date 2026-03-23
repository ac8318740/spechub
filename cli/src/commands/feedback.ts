import { Command } from 'commander';
import { execSync } from 'node:child_process';
import chalk from 'chalk';

const ISSUES_URL = 'https://github.com/ac8318740/spechub/issues/new';

export function register(program: Command): void {
  program
    .command('feedback')
    .description('Submit feedback or report an issue')
    .argument('<message>', 'feedback message')
    .option('--body <text>', 'additional details')
    .action((message: string, opts: { body?: string }) => {
      const title = encodeURIComponent(message);
      const body = opts.body ? encodeURIComponent(opts.body) : '';
      const url = `${ISSUES_URL}?title=${title}&body=${body}`;

      try {
        // Try to open in browser
        const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        execSync(`${openCmd} "${url}"`, { stdio: 'ignore' });
        console.log(chalk.green('Opened feedback form in browser.'));
      } catch {
        console.log(`Submit feedback at:\n  ${url}`);
      }
    });
}
