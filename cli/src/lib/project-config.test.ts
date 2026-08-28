import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_KEY_DEFAULTS,
  parseProjectValue,
  projectKeyDefault,
  projectKeySpec,
  type ProjectKeySpec,
} from './project-config.js';
import { BROWSER_MODE_PRIORITY, FALLBACK_FORBIDDEN } from './host-status.js';
import { ConfigValidationError, parseValue } from './global-config.js';

/**
 * The facts this project states in more than one place, and what keeps the
 * copies honest.
 *
 * Every test here compares one statement of a fact against another statement
 * of the same fact. None of them compares a statement against a literal typed
 * into this file: a literal would be a third copy, and a third copy pins
 * nothing. The failure a reader gets therefore always names two files, and
 * fixing it means making one of them derive from the other.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../../');
const srcRoot = resolve(__dirname, '..');

const projectConfigSource = readFileSync(join(srcRoot, 'lib', 'project-config.ts'), 'utf-8');
const configCommandSource = readFileSync(join(srcRoot, 'commands', 'config.ts'), 'utf-8');

/** The `values` of an enum spec, refusing a key the schema calls something else. */
function enumValues(key: string): readonly string[] {
  const spec: ProjectKeySpec | undefined = projectKeySpec(key);
  expect(spec, `the project schema states no key ${key}`).toBeDefined();
  expect(spec, `the project schema does not call ${key} an enum`).toMatchObject({ kind: 'enum' });
  return (spec as { kind: 'enum'; values: readonly string[] }).values;
}

/**
 * The text of one `PROJECT_KEYS` entry, comments stripped.
 *
 * The slice runs from the key to whichever key the schema states next, so an
 * entry written across several lines reads the same as a one-liner. Comments
 * go because a comment naming a value is prose about the schema, not the
 * schema restating the value.
 */
function schemaEntrySource(key: string): string {
  const start = projectConfigSource.indexOf(`'${key}':`);
  expect(start, `project-config.ts states no schema entry for ${key}`).toBeGreaterThan(-1);

  const rest = projectConfigSource.slice(start + key.length);
  const nextKey = rest.search(/\n\s*'?[a-z][a-z_.]*'?:/);
  const entry = nextKey === -1 ? rest : rest.slice(0, nextKey);
  return entry.replace(/\/\/.*$/gm, '');
}

describe('the project schema takes the browser mode names from host-status', () => {
  it('accepts as frontend.browser.mode exactly what BROWSER_MODE_PRIORITY names, in that order', () => {
    expect(enumValues('frontend.browser.mode')).toEqual(BROWSER_MODE_PRIORITY);
  });

  it('accepts as frontend.browser.fallback the forbidden word and then the three modes', () => {
    expect(enumValues('frontend.browser.fallback')).toEqual([
      FALLBACK_FORBIDDEN,
      ...BROWSER_MODE_PRIORITY,
    ]);
  });

  it('reads the mode list from BROWSER_MODE_PRIORITY itself rather than from a copy of it', () => {
    // Identity, not equality. Two lists that agree today are exactly the
    // duplication this pins, and only a schema that names the constant can
    // hold the same array the constant holds.
    expect(
      enumValues('frontend.browser.mode'),
      'frontend.browser.mode states its own list of mode names; host-status.ts owns BROWSER_MODE_PRIORITY'
    ).toBe(BROWSER_MODE_PRIORITY);
  });

  it('spells no browser mode name in the frontend.browser.mode entry', () => {
    const entry = schemaEntrySource('frontend.browser.mode');
    for (const mode of BROWSER_MODE_PRIORITY) {
      expect(
        entry,
        `project-config.ts spells '${mode}' in the frontend.browser.mode entry; host-status.ts owns that name`
      ).not.toContain(`'${mode}'`);
    }
  });

  it('spells neither the forbidden word nor a mode name in the frontend.browser.fallback entry', () => {
    const entry = schemaEntrySource('frontend.browser.fallback');
    for (const value of [FALLBACK_FORBIDDEN, ...BROWSER_MODE_PRIORITY]) {
      expect(
        entry,
        `project-config.ts spells '${value}' in the frontend.browser.fallback entry; host-status.ts owns that name`
      ).not.toContain(`'${value}'`);
    }
  });
});

/**
 * The arguments of the `workflowFlag` call `config check` makes for one
 * `workflow` flag, as source text.
 *
 * Source text rather than a value, because the number that matters is the one
 * the command hands the function, and no export exposes it: `projectWorkflow`
 * is private to the command. A call that states its default derives it names
 * something; a call that restates it spells `true` or `false`.
 */
function workflowFlagArguments(flag: string): string[] {
  for (const call of balancedCalls(configCommandSource, 'workflowFlag(')) {
    const args = splitTopLevel(call);
    if (args.includes(`'${flag}'`)) return args;
  }
  expect.fail(`config.ts makes no workflowFlag call for workflow.${flag}`);
}

/** The inside of every `name(...)` call in `source`, parentheses balanced. */
function balancedCalls(source: string, name: string): string[] {
  const calls: string[] = [];
  let from = source.indexOf(name);

  while (from !== -1) {
    let depth = 0;
    for (let i = from + name.length - 1; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      if (source[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          calls.push(source.slice(from + name.length, i));
          break;
        }
      }
    }
    from = source.indexOf(name, from + name.length);
  }

  return calls;
}

/** One argument list split on its own commas, leaving nested calls whole. */
function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '(' || args[i] === '[') depth += 1;
    if (args[i] === ')' || args[i] === ']') depth -= 1;
    if (args[i] === ',' && depth === 0) {
      parts.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(args.slice(start).trim());

  return parts;
}

describe('the default config check applies is the default config get reports', () => {
  const flags = [
    { flag: 'spec_sync', key: 'workflow.spec_sync' },
    { flag: 'frontend_verification', key: 'workflow.frontend_verification' },
  ];

  for (const { flag, key } of flags) {
    it(`applies for ${flag} the default projectKeyDefault reports for ${key}`, () => {
      const args = workflowFlagArguments(flag);
      const whenUnstated = args[2];

      if (whenUnstated !== undefined && /^(true|false)$/.test(whenUnstated)) {
        expect(
          whenUnstated,
          `config.ts applies ${whenUnstated} for workflow.${flag}, and PROJECT_KEY_DEFAULTS reports ${String(projectKeyDefault(key))} for ${key}`
        ).toBe(projectKeyDefault(key));
        return;
      }

      // No literal left: the call must name the one place the default lives,
      // or it has simply moved the copy somewhere this test cannot see.
      expect(
        args.join(', '),
        `config.ts states no literal default for workflow.${flag} and does not name projectKeyDefault either`
      ).toContain('projectKeyDefault');
    });

    it(`does not restate the ${key} default as a literal`, () => {
      const whenUnstated = workflowFlagArguments(flag)[2];
      expect(
        whenUnstated ?? '',
        `config.ts passes the literal ${String(whenUnstated)} for workflow.${flag}; PROJECT_KEY_DEFAULTS owns that default`
      ).not.toMatch(/^(true|false)$/);
    });
  }
});

/** The message one rejection carries, refusing a call that does not reject. */
function rejectionMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    return (error as Error).message;
  }
  throw new Error('the call was expected to reject the value, and returned instead');
}

/** Every non-test source file under `cli/src`, as absolute paths. */
function sourceFiles(): string[] {
  return readdirSync(srcRoot, { recursive: true, encoding: 'utf-8' })
    .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map(name => join(srcRoot, name));
}

describe('one composer writes the rejection both enum schemas give', () => {
  it('tells a user which host values were allowed, and names the one they typed', () => {
    const message = rejectionMessage(() => parseValue('host.element_picker', 'stagewize'));

    expect(message).toBe(
      'Invalid value "stagewize" for host.element_picker. Allowed values: stagewise, orca-design-mode, none'
    );
  });

  it('tells a user the same thing, the same way, about a project value', () => {
    const message = rejectionMessage(() => parseProjectValue('frontend.browser.mode', 'headles'));

    expect(message).toBe(
      'Invalid value "headles" for frontend.browser.mode. Allowed values: remote, headless, local'
    );
  });

  it('builds that sentence in exactly one place under cli/src', () => {
    const sites: string[] = [];
    for (const file of sourceFiles()) {
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, index) => {
          if (line.includes('Allowed values:')) {
            sites.push(`${file.slice(repoRoot.length + 1)}:${index + 1}`);
          }
        });
    }

    expect(
      sites,
      `the allowed-values rejection is composed at ${sites.join(' and ')}; one composer serves both schemas`
    ).toHaveLength(1);
  });
});

/**
 * The three context-pressure rungs, and the name each language gives them.
 *
 * The hook cannot ask the CLI for these: `spechub config get` exits 2 on an
 * unset key, and the hook runs on `Stop`, where booting node costs the user a
 * pause on every turn. So the copies stay, and this test is what keeps them
 * saying the same thing.
 */
const CONTEXT_PRESSURE_RUNGS = [
  { key: 'workflow.handoff.nudge_warn', python: 'DEFAULT_WARN', yaml: 'nudge_warn' },
  { key: 'workflow.handoff.nudge_severe', python: 'DEFAULT_SEVERE', yaml: 'nudge_severe' },
  { key: 'workflow.handoff.nudge_step', python: 'DEFAULT_STEP', yaml: 'nudge_step' },
];

const HOOK_PATH = 'hooks/context-pressure.sh';
const REFERENCE_PATH = 'docs/config-reference.md';

const hookSource = readFileSync(join(repoRoot, HOOK_PATH), 'utf-8');
const referenceSource = readFileSync(join(repoRoot, REFERENCE_PATH), 'utf-8');

/** What the hook falls back to for one rung, as the python constant states it. */
function hookDefault(name: string): string {
  const match = new RegExp(String.raw`^${name}\s*=\s*(\d+)\s*$`, 'm').exec(hookSource);
  expect(match, `${HOOK_PATH} states no ${name}`).not.toBeNull();
  return (match as RegExpExecArray)[1];
}

/** What the reference table gives as one key's default. */
function referenceTableDefault(key: string): string {
  const row = referenceSource.split('\n').find(line => line.startsWith(`| \`${key}\` |`));
  expect(row, `${REFERENCE_PATH} has no table row for ${key}`).toBeDefined();

  const cell = (row as string).split('|')[3].trim().replaceAll('`', '');
  expect(cell, `${REFERENCE_PATH} gives no number as the default for ${key}`).toMatch(/^\d+$/);
  return cell;
}

/** What the reference's example project.yaml writes for one rung. */
function referenceExampleDefault(name: string): string {
  const match = new RegExp(String.raw`^\s+${name}:\s*(\d+)\s*$`, 'm').exec(referenceSource);
  expect(match, `${REFERENCE_PATH} has no example line for ${name}`).not.toBeNull();
  return (match as RegExpExecArray)[1];
}

describe('the context-pressure defaults agree across TypeScript, the hook and the reference', () => {
  for (const { key, python, yaml } of CONTEXT_PRESSURE_RUNGS) {
    it(`states one value for ${key} in all four places`, () => {
      const schema = PROJECT_KEY_DEFAULTS[key];
      expect(schema, `PROJECT_KEY_DEFAULTS states no default for ${key}`).toBeDefined();

      expect(
        hookDefault(python),
        `${HOOK_PATH} sets ${python} to ${hookDefault(python)}, and cli/src/lib/project-config.ts sets ${key} to ${schema}`
      ).toBe(schema);

      expect(
        referenceTableDefault(key),
        `the ${REFERENCE_PATH} table gives ${key} as ${referenceTableDefault(key)}, and cli/src/lib/project-config.ts sets it to ${schema}`
      ).toBe(schema);

      expect(
        referenceExampleDefault(yaml),
        `the ${REFERENCE_PATH} example writes ${yaml}: ${referenceExampleDefault(yaml)}, and cli/src/lib/project-config.ts sets ${key} to ${schema}`
      ).toBe(schema);
    });
  }
});
