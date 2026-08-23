import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveVersion } from './version.js';

const pluginJson = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '.claude-plugin',
  'plugin.json'
);

describe('resolveVersion', () => {
  it('matches the plugin manifest, which is the source of truth', () => {
    const expected = (
      JSON.parse(readFileSync(pluginJson, 'utf-8')) as { version: string }
    ).version;
    expect(resolveVersion(import.meta.dirname)).toBe(expected);
  });

  it('finds the manifest from the built bundle location too', () => {
    const expected = (
      JSON.parse(readFileSync(pluginJson, 'utf-8')) as { version: string }
    ).version;
    expect(resolveVersion(join(import.meta.dirname, '..', '..', 'dist'))).toBe(
      expected
    );
  });

  it('never throws when nothing is findable', () => {
    expect(resolveVersion('/')).toMatch(/^\d|unknown/);
  });
});
