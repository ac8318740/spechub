import { HOST_AXES, getKey, type GlobalConfig } from './global-config.js';

/**
 * The decisions behind `spechub config show` and `spechub config check`.
 *
 * Everything here is pure: it turns already-read config and already-read
 * project settings into answers. Reaching out to the machine (looking for
 * binaries, knocking on ports) lives in `host-probe.ts`, and printing lives in
 * the command. Keeping the three apart is what makes the rules testable
 * without a machine that happens to have Chromium installed.
 */

/** How a browser is reached. Mirrors `frontend.browser.mode` in project.yaml. */
export type BrowserMode = 'remote' | 'headless' | 'local';

/**
 * Browser modes in the order a fallback prefers them: a remote browser is a
 * real one the developer can watch, headless is a real engine they cannot,
 * and local is the last resort because it takes over their own display.
 */
export const BROWSER_MODE_PRIORITY: readonly BrowserMode[] = ['remote', 'headless', 'local'];

/** The `host.browser.*` axis that declares whether each mode is available. */
export const BROWSER_AXIS_KEYS: Readonly<Record<BrowserMode, string>> = {
  remote: 'host.browser.remote',
  headless: 'host.browser.headless',
  local: 'host.browser.local',
};

const BROWSER_AXIS_KEY_SET = new Set<string>(Object.values(BROWSER_AXIS_KEYS));

/** Whether `key` names one of the three `host.browser.*` axes. */
export function isBrowserAxis(key: string): boolean {
  return BROWSER_AXIS_KEY_SET.has(key);
}

/**
 * The dotted keys of every host axis that must be set for this project.
 *
 * The browser axes are marked required in `HOST_AXES` because that is what
 * they are for a project with a UI, but a project with no frontend never
 * drives a browser, so demanding them there would be nagging about nothing.
 */
export function requiredHostAxisKeys({ hasFrontend }: { hasFrontend: boolean }): string[] {
  return HOST_AXES.filter(axis => axis.required)
    .filter(axis => hasFrontend || !isBrowserAxis(axis.key))
    .map(axis => axis.key);
}

/** Which browser modes the host config declares as available, by mode. */
export type DeclaredBrowserModes = Partial<Record<BrowserMode, boolean>>;

/**
 * The browser mode to use when the project's preferred one is not declared
 * available, or undefined when the host declares none of them. An axis the
 * host never mentioned is unavailable rather than assumed working: a mode
 * nobody vouched for is not a fallback, it is a guess.
 */
export function fallbackBrowserMode(declared: DeclaredBrowserModes): BrowserMode | undefined {
  return BROWSER_MODE_PRIORITY.find(mode => declared[mode] === true);
}

/** Read the three `host.browser.*` axes out of `config`, keyed by mode. */
export function declaredBrowserModes(config: GlobalConfig): DeclaredBrowserModes {
  const declared: DeclaredBrowserModes = {};
  for (const mode of BROWSER_MODE_PRIORITY) {
    const result = getKey(config, BROWSER_AXIS_KEYS[mode]);
    if (result.status === 'set' && typeof result.value === 'boolean') {
      declared[mode] = result.value;
    }
  }
  return declared;
}

/** The orchestrator values `host.orchestrator` accepts. */
export type Orchestrator = 'herdr' | 'orca' | 'none';

/**
 * How to ask each orchestrator whether it is actually running. Presence of the
 * binary is not enough – an installed `herdr` with no server behind it cannot
 * be driven – so each probe is a command that only succeeds when the thing
 * answers. `none` has nothing to probe and so appears in neither map.
 */
export const ORCHESTRATOR_PROBES: Readonly<
  Record<Exclude<Orchestrator, 'none'>, { binary: string; args: readonly string[] }>
> = {
  herdr: { binary: 'herdr', args: ['api'] },
  orca: { binary: 'orca-ide', args: ['status', '--json'] },
};

/**
 * Binaries any of which means a Chromium-family browser is installed. Distros
 * and vendors disagree on the name, so all four count as the same capability.
 */
export const CHROMIUM_BINARIES: readonly string[] = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
];

/**
 * The CDP port a remote browser is reached on when the project does not name
 * one. Remote means the tunnelled bridge, which has its own agreed port;
 * anything else is a browser this machine launched with the usual debug port.
 */
export const DEFAULT_REMOTE_CDP_PORT = 19988;
export const DEFAULT_CDP_PORT = 9555;

/** What the current project says about the browser the host has to provide. */
export interface ProjectHostContext {
  /** Whether a project root was found at all. */
  hasProject: boolean;
  /** Whether that project configures a frontend, and so needs a browser. */
  hasFrontend: boolean;
  /** The project's preferred `frontend.browser.mode`, when it names a valid one. */
  preferredMode?: BrowserMode;
  /** The port a remote browser is expected on, defaulted when unstated. */
  cdpPort: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Read the browser-relevant parts of an already-parsed project.yaml. Pass
 * `undefined` for "no project here", which is a perfectly normal state: the
 * host config describes the machine, not any one checkout.
 */
export function projectHostContext(projectYaml: unknown, hasProject = true): ProjectHostContext {
  const project = record(projectYaml);
  const frontend = project ? project.frontend : undefined;
  const hasFrontend = hasProject && frontend !== undefined && frontend !== null;

  const browser = record(frontend)?.browser;
  const rawMode = record(browser)?.mode;
  const preferredMode = BROWSER_MODE_PRIORITY.find(mode => mode === rawMode);

  const rawPort = record(browser)?.cdp_port;
  const cdpPort =
    typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort > 0
      ? rawPort
      : preferredMode === 'remote'
        ? DEFAULT_REMOTE_CDP_PORT
        : DEFAULT_CDP_PORT;

  return { hasProject, hasFrontend, preferredMode, cdpPort };
}
