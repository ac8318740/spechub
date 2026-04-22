import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import chalk from 'chalk';
import { GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILE } from '../lib/constants.js';
import { ensureDir } from '../lib/utils.js';
function readGlobalConfig() {
    if (!existsSync(GLOBAL_CONFIG_FILE))
        return {};
    return JSON.parse(readFileSync(GLOBAL_CONFIG_FILE, 'utf-8'));
}
function writeGlobalConfig(config) {
    ensureDir(GLOBAL_CONFIG_DIR);
    writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
export function register(program) {
    const configCmd = program
        .command('config')
        .description('Manage global configuration');
    configCmd
        .command('path')
        .description('Print config file path')
        .action(() => {
        console.log(GLOBAL_CONFIG_FILE);
    });
    configCmd
        .command('list')
        .description('Show all settings')
        .option('--json', 'output as JSON')
        .action((opts) => {
        const config = readGlobalConfig();
        if (opts.json) {
            console.log(JSON.stringify(config, null, 2));
            return;
        }
        if (Object.keys(config).length === 0) {
            console.log(chalk.dim('No configuration set.'));
            return;
        }
        for (const [key, value] of Object.entries(config)) {
            console.log(`${key} = ${JSON.stringify(value)}`);
        }
    });
    configCmd
        .command('get')
        .description('Get a config value')
        .argument('<key>', 'config key')
        .action((key) => {
        const config = readGlobalConfig();
        if (key in config) {
            const value = config[key];
            console.log(typeof value === 'string' ? value : JSON.stringify(value));
        }
        else {
            process.exit(1);
        }
    });
    configCmd
        .command('set')
        .description('Set a config value')
        .argument('<key>', 'config key')
        .argument('<value>', 'config value')
        .action((key, value) => {
        const config = readGlobalConfig();
        // Auto-coerce booleans and numbers
        if (value === 'true')
            config[key] = true;
        else if (value === 'false')
            config[key] = false;
        else if (!isNaN(Number(value)))
            config[key] = Number(value);
        else
            config[key] = value;
        writeGlobalConfig(config);
        console.log(chalk.green(`Set ${key} = ${JSON.stringify(config[key])}`));
    });
    configCmd
        .command('unset')
        .description('Remove a config value')
        .argument('<key>', 'config key')
        .action((key) => {
        const config = readGlobalConfig();
        delete config[key];
        writeGlobalConfig(config);
        console.log(chalk.green(`Removed ${key}`));
    });
}
//# sourceMappingURL=config.js.map