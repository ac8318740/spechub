#!/usr/bin/env node
// The single source of truth for the version is .claude-plugin/plugin.json.
// This copies it into cli/package.json.
//
// Unlike open-designer, this runs on every `npm run build`, not only before a
// publish. The CLI reads its own package.json at runtime to answer
// `spechub --version`, so the plugin copy has to carry the right number too -
// not just the npm tarball.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(__dirname, '..');
const pluginJsonPath = resolve(cliRoot, '..', '.claude-plugin', 'plugin.json');
const packageJsonPath = resolve(cliRoot, 'package.json');

const plugin = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

if (!plugin.version) {
  console.error('plugin.json is missing a version field');
  process.exit(1);
}

if (pkg.version === plugin.version) {
  console.log(`package.json already at ${pkg.version}`);
  process.exit(0);
}

const from = pkg.version;
pkg.version = plugin.version;
writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`package.json synced ${from} -> ${plugin.version}`);
