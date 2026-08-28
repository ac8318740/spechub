import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface GlobalConfig {
  [key: string]: unknown;
}

interface HostAxisBase {
  /** Dotted config key, e.g. `host.browser.remote`. */
  key: string;
  /** Whether the axis must be set for the host to be fully described. */
  required: boolean;
  /**
   * Another axis this one only means something alongside. The axis is still
   * stored and validated whatever that other axis says – recording a setting
   * before switching to the tool it describes is reasonable – so callers warn
   * rather than refuse.
   */
  meaningfulWhen?: { key: string; value: boolean | string };
}

/**
 * One dev-setup axis under the `host.*` section of the global config.
 *
 * Enum values are matched case-sensitively, so `host.element_picker` accepts
 * `stagewise` but not `Stagewise`. Boolean values are not: `yes`, `Yes` and
 * `YES` are all true. Enums name real tools whose spelling is fixed; booleans
 * are just a yes/no the user types by hand.
 */
export type HostAxis =
  | (HostAxisBase & { kind: 'enum'; values: readonly string[] })
  | (HostAxisBase & { kind: 'boolean' });

export const HOST_AXES: readonly HostAxis[] = [
  // One boolean per orchestrator rather than one enum naming the orchestrator.
  // A machine can have both installed, or neither, so each is its own yes/no
  // and answering one says nothing about the other. Both are required: a host
  // is only fully described once every orchestrator has been answered for.
  { key: 'host.orchestrators.herdr', kind: 'boolean', required: true },
  { key: 'host.orchestrators.orca', kind: 'boolean', required: true },
  { key: 'host.browser.remote', kind: 'boolean', required: true },
  { key: 'host.browser.headless', kind: 'boolean', required: true },
  { key: 'host.browser.local', kind: 'boolean', required: true },
  { key: 'host.preview.tailscale_serve', kind: 'boolean', required: false },
  {
    key: 'host.element_picker',
    kind: 'enum',
    required: false,
    values: ['stagewise', 'orca-design-mode', 'none'],
  },
  {
    // How Orca runs: `local` is a desktop app on the developer's own machine,
    // `remote` a headless `orca serve` elsewhere, viewed through a paired
    // client. Says nothing about anything unless Orca runs on this host.
    key: 'host.orca.topology',
    kind: 'enum',
    required: false,
    values: ['local', 'remote'],
    meaningfulWhen: { key: 'host.orchestrators.orca', value: true },
  },
];

/** A config key or value that failed validation. Callers report these as user errors. */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/** The config file exists but could not be read as JSON. Also a user error. */
export class ConfigFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigFileError';
  }
}

const TRUE_VALUES = ['true', 'yes', 'on'];
const FALSE_VALUES = ['false', 'no', 'off'];

/**
 * Read `raw` as a boolean, case-insensitively, or throw naming every spelling
 * that would have worked.
 *
 * Both schemas share this. A `host.*` axis and a `project.yaml` boolean are
 * the same yes/no typed by hand, so `on` meaning true in one file and nothing
 * in the other would be a distinction the user has no way to remember.
 */
export function parseBooleanWord(key: string, raw: string): boolean {
  const normalized = raw.toLowerCase();
  if (TRUE_VALUES.includes(normalized)) return true;
  if (FALSE_VALUES.includes(normalized)) return false;
  throw invalidValue(
    key,
    raw,
    `Expected a boolean: ${TRUE_VALUES.join('/')} or ${FALSE_VALUES.join('/')}`
  );
}

/**
 * Refuse `raw` for `key`, naming what the key expected instead.
 *
 * The opening half of every rejection either schema gives, so a user who
 * learns to read one reads the rest the same way and a reader looking for the
 * wording finds one place holding it.
 */
export function invalidValue(key: string, raw: string, expected: string): ConfigValidationError {
  return new ConfigValidationError(`Invalid value "${raw}" for ${key}. ${expected}`);
}

/**
 * Refuse `raw` for the enum key `key`, naming every value it does accept.
 *
 * Both schemas hold enum keys and both owe the user this sentence. It is
 * composed here, below both of them, because two sites composing it is two
 * wordings waiting to drift - and the user typing a value into either one is
 * the same user.
 */
export function invalidEnumValue(
  key: string,
  raw: string,
  values: readonly string[]
): ConfigValidationError {
  return invalidValue(key, raw, `Allowed values: ${values.join(', ')}`);
}

/** The axis `key` names, or undefined when it names no axis. */
export function hostAxis(key: string): HostAxis | undefined {
  return HOST_AXES.find(axis => axis.key === key);
}

function unknownHostKey(key: string): ConfigValidationError {
  const allowed = HOST_AXES.map(axis => axis.key).join(', ');
  return new ConfigValidationError(`Unknown config key "${key}". Allowed host keys: ${allowed}`);
}

function hostIsASection(): ConfigValidationError {
  return new ConfigValidationError(
    '`host` is a section; set an axis such as host.orchestrators.herdr'
  );
}

/**
 * Throw if `key` names a `host.*` axis that does not exist. Bare `host` passes:
 * the whole section can be read and removed, just not assigned to.
 */
export function assertReadableKey(key: string): void {
  if (key.startsWith('host.') && !hostAxis(key)) throw unknownHostKey(key);
}

function assertSettableKey(key: string): void {
  if (key === 'host') throw hostIsASection();
  assertReadableKey(key);
}

/** Read the global config from `file`, or `{}` when it does not exist yet. */
export function readGlobalConfig(file: string): GlobalConfig {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf-8');
  try {
    return JSON.parse(raw) as GlobalConfig;
  } catch (err) {
    throw new ConfigFileError(`Could not parse ${file}: ${(err as Error).message}`);
  }
}

/** Write the global config to `file` as nested JSON, creating parent directories. */
export function writeGlobalConfig(config: GlobalConfig, file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Validate and coerce a raw string value for `key`.
 *
 * `host.*` keys are checked against their axis. Other keys keep the loose
 * coercion the config command has always used: booleans, numbers, else string.
 */
export function parseValue(key: string, raw: string): unknown {
  if (key !== 'host' && !key.startsWith('host.')) {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw.trim() !== '' && !Number.isNaN(Number(raw))) return Number(raw);
    return raw;
  }

  assertSettableKey(key);
  const axis = hostAxis(key) as HostAxis;

  if (axis.kind === 'enum') {
    if (!axis.values.includes(raw)) throw invalidEnumValue(key, raw, axis.values);
    return raw;
  }

  return parseBooleanWord(key, raw);
}

/**
 * Return a copy of `config` with the dotted `key` set to `value`.
 * Dotted keys become nested objects; the input config is not mutated.
 */
export function setKey(config: GlobalConfig, key: string, value: unknown): GlobalConfig {
  assertSettableKey(key);

  const next = structuredClone(config);
  const parts = key.split('.');
  const leaf = parts.pop() as string;

  let cursor: Record<string, unknown> = next;
  for (const part of parts) {
    const child = cursor[part];
    if (typeof child !== 'object' || child === null || Array.isArray(child)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[leaf] = value;
  return next;
}

/**
 * Return a copy of `config` with the dotted `key` removed, and whether the key
 * was there to remove, so the caller can say so rather than claiming a delete.
 */
export function unsetKey(
  config: GlobalConfig,
  key: string
): { config: GlobalConfig; removed: boolean } {
  assertReadableKey(key);

  const next = structuredClone(config);
  const parts = key.split('.');
  const leaf = parts.pop() as string;

  let cursor: Record<string, unknown> = next;
  for (const part of parts) {
    const child = cursor[part];
    if (typeof child !== 'object' || child === null || Array.isArray(child)) {
      return { config: next, removed: false };
    }
    cursor = child as Record<string, unknown>;
  }

  if (!(leaf in cursor)) return { config: next, removed: false };
  delete cursor[leaf];
  return { config: next, removed: true };
}

export type GetResult =
  | { status: 'set'; value: unknown }
  | { status: 'unset'; required: boolean };

/**
 * Look up the dotted `key`. An unset key reports whether it is required, so
 * callers can tell a missing mandatory axis from a missing optional one.
 */
export function getKey(config: GlobalConfig, key: string): GetResult {
  assertReadableKey(key);

  let cursor: unknown = config;
  for (const part of key.split('.')) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      cursor = undefined;
      break;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor !== undefined) return { status: 'set', value: cursor };

  const required = key === 'host' ? true : (hostAxis(key)?.required ?? false);
  return { status: 'unset', required };
}

/**
 * The dependency `key` declares but `config` does not currently meet, or
 * undefined when the axis means something as things stand. Callers say so and
 * carry on: a setting that does nothing yet is worth mentioning, not refusing.
 */
export function inertDependency(
  config: GlobalConfig,
  key: string
): { key: string; value: boolean | string } | undefined {
  const dependency = hostAxis(key)?.meaningfulWhen;
  if (!dependency) return undefined;

  const current = getKey(config, dependency.key);
  const met = current.status === 'set' && current.value === dependency.value;
  return met ? undefined : dependency;
}
