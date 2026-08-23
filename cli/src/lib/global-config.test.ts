import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOST_AXES,
  ConfigValidationError,
  readGlobalConfig,
  writeGlobalConfig,
  parseValue,
  setKey,
  getKey,
  unsetKey,
  type GlobalConfig,
} from './global-config.js';

let root: string;
let configFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spechub-global-config-'));
  configFile = join(root, 'config.json');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('HOST_AXES', () => {
  it('declares the seven host axes with kind, required and allowed values', () => {
    const byKey = Object.fromEntries(HOST_AXES.map(a => [a.key, a]));

    expect(byKey['host.orchestrator']).toMatchObject({
      required: true,
      kind: 'enum',
      values: ['herdr', 'orca', 'none'],
    });
    expect(byKey['host.browser.remote']).toMatchObject({ required: true, kind: 'boolean' });
    expect(byKey['host.browser.headless']).toMatchObject({ required: true, kind: 'boolean' });
    expect(byKey['host.browser.local']).toMatchObject({ required: true, kind: 'boolean' });
    expect(byKey['host.preview.tailscale_serve']).toMatchObject({
      required: false,
      kind: 'boolean',
    });
    expect(byKey['host.element_picker']).toMatchObject({
      required: false,
      kind: 'enum',
      values: ['stagewise', 'orca-design-mode', 'none'],
    });
    expect(byKey['host.orca.topology']).toMatchObject({
      required: false,
      kind: 'enum',
      values: ['local', 'remote'],
    });

    expect(HOST_AXES).toHaveLength(7);
  });
});

describe('readGlobalConfig', () => {
  it('returns an empty object when the file does not exist', () => {
    expect(readGlobalConfig(configFile)).toEqual({});
  });

  it('parses an existing JSON config file', () => {
    writeGlobalConfig({ foo: 'bar', host: { orchestrator: 'orca' } }, configFile);
    expect(readGlobalConfig(configFile)).toEqual({ foo: 'bar', host: { orchestrator: 'orca' } });
  });
});

describe('writeGlobalConfig', () => {
  it('creates parent directories that do not yet exist', () => {
    const nestedFile = join(root, 'nested', 'dir', 'config.json');
    expect(existsSync(join(root, 'nested'))).toBe(false);

    writeGlobalConfig({ a: 1 }, nestedFile);

    expect(existsSync(nestedFile)).toBe(true);
    expect(JSON.parse(readFileSync(nestedFile, 'utf-8'))).toEqual({ a: 1 });
  });

  it('writes the config as nested JSON, not flattened dotted keys', () => {
    writeGlobalConfig({ host: { browser: { remote: true } } }, configFile);
    const raw = JSON.parse(readFileSync(configFile, 'utf-8')) as GlobalConfig;
    expect(raw).toEqual({ host: { browser: { remote: true } } });
    expect(raw['host.browser.remote']).toBeUndefined();
  });
});

describe('parseValue: host.* enum axes', () => {
  it('accepts an allowed enum value', () => {
    expect(parseValue('host.orchestrator', 'orca')).toBe('orca');
    expect(parseValue('host.orchestrator', 'herdr')).toBe('herdr');
    expect(parseValue('host.orchestrator', 'none')).toBe('none');
  });

  it('rejects an unknown enum value and names the allowed values', () => {
    expect(() => parseValue('host.orchestrator', 'tmux')).toThrow(ConfigValidationError);
    try {
      parseValue('host.orchestrator', 'tmux');
      throw new Error('expected parseValue to throw');
    } catch (err) {
      expect((err as Error).message).toContain('herdr');
      expect((err as Error).message).toContain('orca');
      expect((err as Error).message).toContain('none');
    }
  });

  it('accepts allowed values for host.element_picker', () => {
    expect(parseValue('host.element_picker', 'stagewise')).toBe('stagewise');
    expect(parseValue('host.element_picker', 'orca-design-mode')).toBe('orca-design-mode');
    expect(parseValue('host.element_picker', 'none')).toBe('none');
  });

  it('rejects an unknown value for host.element_picker', () => {
    expect(() => parseValue('host.element_picker', 'bogus')).toThrow(ConfigValidationError);
  });

  it('accepts allowed values for host.orca.topology', () => {
    expect(parseValue('host.orca.topology', 'local')).toBe('local');
    expect(parseValue('host.orca.topology', 'remote')).toBe('remote');
  });

  it('rejects an unknown value for host.orca.topology and names the allowed values', () => {
    expect(() => parseValue('host.orca.topology', 'bogus')).toThrow(ConfigValidationError);
    try {
      parseValue('host.orca.topology', 'bogus');
      throw new Error('expected parseValue to throw');
    } catch (err) {
      const message = (err as Error).message;
      // "local" and "remote" also appear inside the unrelated "unknown key"
      // message (as substrings of host.browser.local/host.browser.remote), so
      // check for them named together as the allowed-values list rather than
      // as loose substrings, to avoid a false pass off the wrong error.
      expect(message).toContain('local, remote');
    }
  });

  it('rejects values with the wrong case for host.orca.topology (enum values are case-sensitive)', () => {
    expect(() => parseValue('host.orca.topology', 'Local')).toThrow(ConfigValidationError);
    expect(() => parseValue('host.orca.topology', 'REMOTE')).toThrow(ConfigValidationError);
  });
});

describe('parseValue: host.* boolean axes', () => {
  const booleanKeys = [
    'host.browser.remote',
    'host.browser.headless',
    'host.browser.local',
    'host.preview.tailscale_serve',
  ];

  for (const key of booleanKeys) {
    it(`coerces truthy string forms to boolean true for ${key}`, () => {
      for (const raw of ['true', 'yes', 'on', 'TRUE', 'Yes', 'ON']) {
        expect(parseValue(key, raw)).toBe(true);
      }
    });

    it(`coerces falsy string forms to boolean false for ${key}`, () => {
      for (const raw of ['false', 'no', 'off', 'FALSE', 'No', 'OFF']) {
        expect(parseValue(key, raw)).toBe(false);
      }
    });

    it(`rejects a non-boolean value for ${key}`, () => {
      expect(() => parseValue(key, 'maybe')).toThrow(ConfigValidationError);
    });
  }
});

describe('parseValue: unknown host key', () => {
  it('rejects an unknown host.* key and names the allowed keys', () => {
    expect(() => parseValue('host.bogus', 'x')).toThrow(ConfigValidationError);
    try {
      parseValue('host.bogus', 'x');
      throw new Error('expected parseValue to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('host.orchestrator');
      expect(message).toContain('host.browser.remote');
      expect(message).toContain('host.browser.headless');
      expect(message).toContain('host.browser.local');
      expect(message).toContain('host.element_picker');
      expect(message).toContain('host.preview.tailscale_serve');
      expect(message).toContain('host.orca.topology');
    }
  });
});

describe('parseValue: non-host keys', () => {
  it('coerces boolean-looking strings for non-host keys', () => {
    expect(parseValue('editor', 'true')).toBe(true);
    expect(parseValue('editor', 'false')).toBe(false);
  });

  it('coerces numeric strings for non-host keys', () => {
    expect(parseValue('retries', '3')).toBe(3);
  });

  it('leaves other strings as-is for non-host keys', () => {
    expect(parseValue('editor', 'vim')).toBe('vim');
  });
});

describe('setKey', () => {
  it('sets a nested host.* value from a dotted path without mutating the input', () => {
    const before: Record<string, unknown> = {};
    const after = setKey(before, 'host.orchestrator', 'orca');

    expect(before).toEqual({});
    expect(after).toEqual({ host: { orchestrator: 'orca' } });
  });

  it('sets a deeply nested host.* value', () => {
    const after = setKey({}, 'host.browser.remote', true);
    expect(after).toEqual({ host: { browser: { remote: true } } });
  });

  it('merges into an existing host section without clobbering sibling axes', () => {
    const existing = { host: { orchestrator: 'herdr' } };
    const after = setKey(existing, 'host.browser.remote', true);
    expect(after).toEqual({ host: { orchestrator: 'herdr', browser: { remote: true } } });
  });

  it('throws ConfigValidationError for an unknown host.* key', () => {
    expect(() => setKey({}, 'host.bogus', 'x')).toThrow(ConfigValidationError);
  });

  it('preserves existing non-host top-level keys', () => {
    const existing = { editor: 'vim' };
    const after = setKey(existing, 'host.orchestrator', 'orca');
    expect(after).toEqual({ editor: 'vim', host: { orchestrator: 'orca' } });
  });

  it('sets a nested host.orca.topology value from a dotted path', () => {
    const after = setKey({}, 'host.orca.topology', 'local');
    expect(after).toEqual({ host: { orca: { topology: 'local' } } });
  });
});

describe('getKey', () => {
  it('returns status "set" with the whole host object when reading "host"', () => {
    const config = { host: { orchestrator: 'orca', browser: { remote: true } } };
    expect(getKey(config, 'host')).toEqual({
      status: 'set',
      value: { orchestrator: 'orca', browser: { remote: true } },
    });
  });

  it('returns status "unset" with required true when reading "host" and no section exists', () => {
    expect(getKey({}, 'host')).toEqual({ status: 'unset', required: true });
  });

  it('returns status "set" with the value for a set nested axis', () => {
    const config = { host: { orchestrator: 'orca' } };
    expect(getKey(config, 'host.orchestrator')).toEqual({ status: 'set', value: 'orca' });
  });

  it('returns status "unset" with required true for an unset required axis', () => {
    expect(getKey({}, 'host.orchestrator')).toEqual({ status: 'unset', required: true });
  });

  it('returns status "unset" with required false for an unset optional axis', () => {
    expect(getKey({}, 'host.preview.tailscale_serve')).toEqual({
      status: 'unset',
      required: false,
    });
  });

  it('returns the set value for a deeply nested boolean axis', () => {
    const config = { host: { browser: { remote: true } } };
    expect(getKey(config, 'host.browser.remote')).toEqual({ status: 'set', value: true });
  });

  it('returns status "unset" with required false for an unset host.orca.topology axis', () => {
    expect(getKey({}, 'host.orca.topology')).toEqual({ status: 'unset', required: false });
  });

  it('returns the set value for host.orca.topology', () => {
    const config = { host: { orca: { topology: 'remote' } } };
    expect(getKey(config, 'host.orca.topology')).toEqual({ status: 'set', value: 'remote' });
  });
});

describe('unsetKey', () => {
  it('removes a set nested axis, keeps siblings, and does not mutate the input', () => {
    const before = { host: { orchestrator: 'orca', browser: { remote: true } } };

    const result = unsetKey(before, 'host.orchestrator');

    expect(result).toEqual({
      config: { host: { browser: { remote: true } } },
      removed: true,
    });
    expect(before).toEqual({ host: { orchestrator: 'orca', browser: { remote: true } } });
  });

  it('keeps sibling axes when removing one leaf under a shared parent', () => {
    const before = { host: { browser: { remote: true, headless: false } } };

    const result = unsetKey(before, 'host.browser.remote');

    expect(result).toEqual({
      config: { host: { browser: { headless: false } } },
      removed: true,
    });
  });

  it('reports removed: false and leaves config unchanged when the leaf is absent but the parent exists', () => {
    const before = { host: { browser: { headless: true } } };

    const result = unsetKey(before, 'host.browser.remote');

    expect(result).toEqual({
      config: { host: { browser: { headless: true } } },
      removed: false,
    });
  });

  it('reports removed: false and does not create an empty parent when the parent is absent', () => {
    const before = { host: { orchestrator: 'orca' } };

    const result = unsetKey(before, 'host.browser.remote');

    expect(result).toEqual({ config: { host: { orchestrator: 'orca' } }, removed: false });
    expect(result.config.host).not.toHaveProperty('browser');
  });

  it('reports removed: false with an empty config unchanged when nothing is set', () => {
    const result = unsetKey({}, 'host.orchestrator');
    expect(result).toEqual({ config: {}, removed: false });
  });

  it('removes the whole host section for the bare key "host"', () => {
    const before = { editor: 'vim', host: { orchestrator: 'orca', browser: { remote: true } } };

    const result = unsetKey(before, 'host');

    expect(result).toEqual({ config: { editor: 'vim' }, removed: true });
  });

  it('throws ConfigValidationError for an unknown host.* axis, listing allowed keys', () => {
    expect(() => unsetKey({}, 'host.bogus')).toThrow(ConfigValidationError);
    try {
      unsetKey({}, 'host.bogus');
      throw new Error('expected unsetKey to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('host.orchestrator');
      expect(message).toContain('host.browser.remote');
      expect(message).toContain('host.browser.headless');
      expect(message).toContain('host.browser.local');
      expect(message).toContain('host.element_picker');
      expect(message).toContain('host.preview.tailscale_serve');
      expect(message).toContain('host.orca.topology');
    }
  });

  it('removes host.orca.topology when set, and reports removed: false when it was never set', () => {
    const removedResult = unsetKey({ host: { orca: { topology: 'local' } } }, 'host.orca.topology');
    expect(removedResult).toEqual({ config: { host: { orca: {} } }, removed: true });

    const notSetResult = unsetKey({}, 'host.orca.topology');
    expect(notSetResult).toEqual({ config: {}, removed: false });
  });
});

describe('round-trip: set, write, read back, get', () => {
  it('preserves a nested boolean value across a full write/read cycle', () => {
    let config = readGlobalConfig(configFile);
    config = setKey(config, 'host.browser.remote', parseValue('host.browser.remote', 'yes'));
    writeGlobalConfig(config, configFile);

    const reloaded = readGlobalConfig(configFile);
    expect(getKey(reloaded, 'host.browser.remote')).toEqual({ status: 'set', value: true });

    const raw = JSON.parse(readFileSync(configFile, 'utf-8')) as GlobalConfig;
    expect(raw).toEqual({ host: { browser: { remote: true } } });
  });

  it('keeps existing non-host top-level keys alongside a newly set host section', () => {
    writeGlobalConfig({ editor: 'vim', retries: 3 }, configFile);
    let config = readGlobalConfig(configFile);
    config = setKey(config, 'host.orchestrator', 'orca');
    writeGlobalConfig(config, configFile);

    const reloaded = readGlobalConfig(configFile);
    expect(reloaded).toEqual({ editor: 'vim', retries: 3, host: { orchestrator: 'orca' } });
  });

  it('preserves a nested enum value across a full write/read cycle for host.orca.topology', () => {
    let config = readGlobalConfig(configFile);
    config = setKey(config, 'host.orca.topology', parseValue('host.orca.topology', 'remote'));
    writeGlobalConfig(config, configFile);

    const reloaded = readGlobalConfig(configFile);
    expect(getKey(reloaded, 'host.orca.topology')).toEqual({ status: 'set', value: 'remote' });

    const raw = JSON.parse(readFileSync(configFile, 'utf-8')) as GlobalConfig;
    expect(raw).toEqual({ host: { orca: { topology: 'remote' } } });
  });
});
