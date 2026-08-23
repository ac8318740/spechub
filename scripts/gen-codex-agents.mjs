#!/usr/bin/env node
// Generate Codex subagent definitions from the SpecHub agent markdown.
//
// agents/<name>.md  ->  agents/codex/<name>.toml
//
// The markdown is the single source of truth. The TOML is generated and
// committed, and CI fails if it drifts - the same arrangement as cli/dist.
// Never hand-edit the TOML.
//
// Codex parses agent files with deny_unknown_fields: one unrecognised key and
// it discards the whole file with a log line nobody reads. So this emits only
// keys Codex actually applies, and refuses to guess at anything else.
//
//   name                    required
//   description             required, non-blank
//   developer_instructions  required - the markdown body
//
// Deliberately not emitted:
//   model  - ours says "opus", a Claude alias that means nothing to Codex.
//            Omitting it makes a subagent inherit the parent's model, which is
//            the behaviour we want anyway.
//   color  - no Codex equivalent.
//   sandbox_mode / mcp_servers - Codex parses then silently ignores both; a
//            child agent may never escalate past its parent. Emitting them
//            would imply a guarantee that does not exist.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'agents');
const outDir = join(srcDir, 'codex');

/**
 * Read YAML frontmatter as flat key/value pairs.
 *
 * Hand-rolled rather than pulled from a library because this script must run
 * with no node_modules, in CI and from a plugin checkout alike. It only has to
 * handle `key: scalar` lines, and it throws on anything else rather than
 * quietly returning a half-parsed object.
 */
function parseFrontmatter(text, file) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: no YAML frontmatter`);

  const fields = {};
  for (const line of match[1].split('\n')) {
    if (line.trim() === '') continue;
    const sep = line.indexOf(':');
    if (sep === -1) throw new Error(`${file}: cannot parse frontmatter line: ${line}`);
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return { fields, body: match[2].trim() };
}

/** Emit a TOML basic string. */
function tomlString(value) {
  return JSON.stringify(value);
}

/**
 * Emit a TOML multi-line basic string.
 *
 * Multi-line basic strings honour backslash escapes, so a literal backslash in
 * the body has to be doubled or TOML reads it as an escape. A run of three or
 * more quotes would also close the string early, so the third quote is escaped.
 */
function tomlMultiline(value) {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"""/g, '""\\"');
  return `"""\n${escaped}\n"""`;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const written = [];
for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.md')).sort()) {
  const { fields, body } = parseFrontmatter(
    readFileSync(join(srcDir, file), 'utf-8'),
    file
  );

  for (const required of ['name', 'description']) {
    if (!fields[required]) throw new Error(`${file}: missing ${required}`);
  }
  if (!body) throw new Error(`${file}: empty body, nothing to instruct with`);

  const toml = [
    '# Generated from agents/' + file + ' by scripts/gen-codex-agents.mjs.',
    '# Do not edit. Change the markdown and re-run the generator.',
    '',
    `name = ${tomlString(fields.name)}`,
    `description = ${tomlString(fields.description)}`,
    '',
    `developer_instructions = ${tomlMultiline(body)}`,
    '',
  ].join('\n');

  const out = basename(file, '.md') + '.toml';
  writeFileSync(join(outDir, out), toml, 'utf-8');
  written.push(out);
}

console.log(`generated ${written.length} Codex agent definitions: ${written.join(', ')}`);
