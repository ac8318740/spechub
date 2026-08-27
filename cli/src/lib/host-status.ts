import { HOST_AXES, getKey, parseBooleanWord, type GlobalConfig } from './global-config.js';

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
 * Both orchestrator booleans are always required: each is a separate yes/no
 * about this machine, and answering one says nothing about the other. The
 * browser axes are marked required in `HOST_AXES` because that is what they
 * are for a project with a UI, but a project with no frontend never drives a
 * browser, so demanding them there would be nagging about nothing.
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

/** The orchestrators a host can run. Each has its own `host.orchestrators.*` boolean. */
export type Orchestrator = 'herdr' | 'orca';

/**
 * Every orchestrator, in the order callers report them, so a listing and a set
 * of probes always come out the same way round.
 */
export const ORCHESTRATORS: readonly Orchestrator[] = ['herdr', 'orca'];

/** The `host.orchestrators.*` axis that declares whether each one runs here. */
export const ORCHESTRATOR_AXIS_KEYS: Readonly<Record<Orchestrator, string>> = {
  herdr: 'host.orchestrators.herdr',
  orca: 'host.orchestrators.orca',
};

/**
 * Narrow an unknown value to a plain object, or undefined when it is anything
 * else. The gateway for reading untyped input – parsed JSON, a parsed YAML
 * file – one level at a time without ever asserting a shape nobody checked.
 */
function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Whether Orca's `status --json` output says its runtime is up and usable.
 *
 * Orca's status command exits 0 whenever it can answer at all, including when
 * the runtime behind it is stopped or still starting, so the exit status alone
 * says nothing. The JSON body is where the real answer is: `reachable` says a
 * runtime responded, and `state` says what it responded with. Only a runtime
 * that is both reachable and in state `ready` can actually be driven.
 *
 * The output is whatever a binary on the user's PATH happened to print, so
 * every step is checked rather than assumed: text that is not JSON, JSON that
 * is not an object, and JSON missing `result.runtime` all mean not ready
 * rather than a crash.
 */
export function orcaRuntimeIsReady(stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return false;
  }
  const runtime = record(record(record(parsed)?.result)?.runtime);
  return runtime?.reachable === true && runtime?.state === 'ready';
}

/**
 * How to ask one orchestrator whether it is actually running.
 *
 * Presence of the binary is not enough – an installed `herdr` with no server
 * behind it cannot be driven – so a probe is a command that only counts as an
 * answer when the thing behind it responds. What responding means differs from
 * one orchestrator to the next, so each one carries its own rule rather than
 * the code that runs the probes growing a branch per orchestrator.
 */
export interface OrchestratorProbe {
  /**
   * Binary names to look for, most preferred first. Orca ships as `orca-ide`
   * but is also installed as plain `orca`, and the two are the same tool.
   */
  binaries: readonly string[];
  /** The arguments that ask it whether it is running. */
  args: readonly string[];
  /**
   * Whether what the command printed counts as an answer, given that it has
   * already exited 0. Exiting 0 is necessary for every orchestrator; this is
   * the extra condition on top of that, and is simply always true for an
   * orchestrator whose exit status is the whole answer.
   */
  answered: (stdout: string) => boolean;
  /** Where to send a user whose probe failed, when there is a page for it. */
  docs?: string;
}

/**
 * How to ask each orchestrator whether it is actually running. A host running
 * neither simply has nothing to probe.
 */
export const ORCHESTRATOR_PROBES: Readonly<Record<Orchestrator, OrchestratorProbe>> = {
  // `herdr api` fails outright when no server is behind it, so its exit status
  // is the whole answer and there is nothing to read in what it printed.
  herdr: { binaries: ['herdr'], args: ['api'], answered: () => true },
  orca: {
    binaries: ['orca-ide', 'orca'],
    args: ['status', '--json'],
    answered: orcaRuntimeIsReady,
    docs: 'https://github.com/stablyai/orca/blob/main/docs/reference/headless-linux-server.md',
  },
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
  /**
   * The project's `frontend.browser.fallback`, exactly as written, or
   * undefined when it states none. Held verbatim rather than interpreted here
   * so that one place - `projectAllowsFallback` - decides what a value means.
   */
  fallback?: string;
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

  const rawFallback = record(browser)?.fallback;
  const fallback = typeof rawFallback === 'string' ? rawFallback : undefined;

  return { hasProject, hasFrontend, preferredMode, cdpPort, fallback };
}

/**
 * The one `frontend.browser.fallback` value that means anything: the project
 * refuses to run against any browser other than the mode it named.
 */
export const FALLBACK_FORBIDDEN = 'none';

/**
 * Whether this project accepts a browser mode other than the one it prefers.
 *
 * Only the literal `none` forbids it. Every other value, including one naming
 * a mode, leaves the host's own order (remote, then headless, then local)
 * alone: a project that wanted a particular mode would have named it as its
 * mode, so a second mode name here is not an instruction anyone should act on.
 */
export function projectAllowsFallback(project: ProjectHostContext): boolean {
  return project.fallback !== FALLBACK_FORBIDDEN;
}

/**
 * Why no browser mode could be resolved. Each shade is a different situation
 * with a different way out, so they are kept apart as data and the caller
 * turns the one it got into a sentence. The resolver never prints and never
 * throws: a host with no browser is an ordinary answer, not a crash.
 */
export type BrowserModeProblem =
  /** There is no SpecHub project here at all. */
  | { kind: 'no-project' }
  /** There is a project, but it configures no frontend, so it drives no browser. */
  | { kind: 'no-frontend' }
  /** Not one of the three `host.browser.*` axes has been declared either way. */
  | { kind: 'host-undescribed' }
  /** The axes that are declared are all false: this host offers no browser. */
  | { kind: 'host-declares-none' }
  /**
   * The project prefers a mode this host does not declare, and forbids
   * standing in another one. `available` is the mode that would have stood in,
   * carried so the caller can say what is being refused.
   */
  | { kind: 'fallback-forbidden'; preferred: BrowserMode; available: BrowserMode };

/** A browser mode this project can actually be driven with here. */
export interface ResolvedBrowserMode {
  status: 'resolved';
  /** The mode to use. */
  mode: BrowserMode;
  /** The project's stated preference, or undefined when it states none. */
  preferred?: BrowserMode;
  /** True only when `mode` differs from a preference the project stated. */
  fallback: boolean;
}

/** Which browser mode to use here, or why there is none. */
export type BrowserModeResolution =
  | ResolvedBrowserMode
  | { status: 'unresolved'; problem: BrowserModeProblem };

/**
 * Which browser mode this machine should drive for this project, decided from
 * what is declared and nothing else.
 *
 * Both `spechub config browser-mode` and check 4 of `spechub config check`
 * ask this same question, so they ask it here rather than each carrying its
 * own copy of the priority-and-fallback rules and drifting apart.
 *
 * The order matters. A project with no frontend is settled first, because a
 * project that drives no browser has no question to answer however well the
 * host is described. A host offering nothing comes next, because it is a gap
 * in the description of the machine, and mentioning a fallback the machine
 * does not have would only send the user chasing one. Only then does the
 * project's own preference decide anything.
 */
export function resolveBrowserMode(
  declared: DeclaredBrowserModes,
  project: ProjectHostContext
): BrowserModeResolution {
  if (!project.hasProject) return { status: 'unresolved', problem: { kind: 'no-project' } };
  if (!project.hasFrontend) return { status: 'unresolved', problem: { kind: 'no-frontend' } };

  const available = fallbackBrowserMode(declared);
  if (!available) {
    // A host nobody has described yet is a different situation from one that
    // describes itself as having no browser: the first needs answering, the
    // second needs a browser. Anything partly answered counts as the second,
    // because the axes that were answered all said no.
    const anyDeclared = BROWSER_MODE_PRIORITY.some(mode => declared[mode] !== undefined);
    return {
      status: 'unresolved',
      problem: { kind: anyDeclared ? 'host-declares-none' : 'host-undescribed' },
    };
  }

  const preferred = project.preferredMode;
  if (!preferred) {
    // No preference stated, so the first mode the host declares wins outright.
    // This is not a fallback: there was nothing to fall back from, which is
    // also why `frontend.browser.fallback` has no say here, `none` included.
    return { status: 'resolved', mode: available, fallback: false };
  }

  if (declared[preferred] === true) {
    return { status: 'resolved', mode: preferred, preferred, fallback: false };
  }

  if (!projectAllowsFallback(project)) {
    return { status: 'unresolved', problem: { kind: 'fallback-forbidden', preferred, available } };
  }

  return { status: 'resolved', mode: available, preferred, fallback: true };
}

/** What a project states about the browser, as stated - no defaults filled in. */
export interface ProjectBrowserSettings {
  /** `frontend.browser.mode`, or null when unstated. */
  mode: string | null;
  /**
   * `frontend.browser.cdp_port`, or null when unstated. Deliberately not the
   * port a probe would end up using: `ProjectHostContext.cdpPort` answers
   * "which port do we knock on", and this answers "what did the project say",
   * which are different questions with different right answers.
   */
  cdpPort: number | null;
  /** `frontend.browser.fallback`, or null when unstated. */
  fallback: string | null;
}

/**
 * The project settings `spechub config show` reports, read once and shared by
 * the text listing and the JSON output so the two can never drift apart.
 */
export interface ProjectSettings {
  /** The top-level `profile`, or null when the project sets none. */
  profile: string | null;
  /** Only the `commands.*` entries that are actually set, by name. */
  commands: Record<string, string>;
  /** What the project says about its browser, or null when it has no frontend. */
  browser: ProjectBrowserSettings | null;
}

/** A non-empty string, or null for every other value including an empty one. */
function statedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Read the settings `show` reports off an already-parsed project.yaml, or
 * null when there is no project here at all.
 *
 * The file is whatever the user wrote, so nothing is assumed: a `commands`
 * entry only counts when its value is a non-empty string, because a null, a
 * number or a nested table is not a command anyone could run.
 */
export function projectSettings(projectYaml: unknown, hasProject = true): ProjectSettings | null {
  if (!hasProject) return null;

  const project = record(projectYaml);
  const frontend = project?.frontend;
  const hasFrontend = frontend !== undefined && frontend !== null;
  const browser = record(record(frontend)?.browser);

  const commands: Record<string, string> = {};
  for (const [name, value] of Object.entries(record(project?.commands) ?? {})) {
    const command = statedString(value);
    if (command !== null) commands[name] = command;
  }

  const rawPort = browser?.cdp_port;
  const cdpPort =
    typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort > 0 ? rawPort : null;

  return {
    profile: statedString(project?.profile),
    commands,
    browser: hasFrontend
      ? { mode: statedString(browser?.mode), cdpPort, fallback: statedString(browser?.fallback) }
      : null,
  };
}

/**
 * The project's `frontend.helpers_dir`, or null when it states none.
 *
 * Kept out of both `ProjectHostContext` and `ProjectSettings`: it is not part
 * of what the host has to provide, and it is not one of the facts `show`
 * reports. Only `check` wants it, to find the verification knowledge base.
 */
export function frontendHelpersDir(projectYaml: unknown): string | null {
  return statedString(record(record(projectYaml)?.frontend)?.helpers_dir);
}

/**
 * The boolean a project states at `workflow.<key>`, or `whenUnstated` when it
 * states nothing there - or states something no boolean can be read out of.
 *
 * The default is the caller's to name rather than this function's, because
 * the two keys `check` reads default opposite ways: spec sync runs unless a
 * project turns it off, and frontend verification stays off until a project
 * turns it on.
 *
 * A string goes through the same parser `spechub config set` writes these
 * keys with. `off`, `on`, `yes` and `no` are words the command accepts and
 * turns into `false` or `true` on the way to disk, but the YAML core schema
 * reads them as strings - so a user who typed one by hand would otherwise
 * have the line ignored, and the file would mean one thing written by the
 * tool and another written by them. `parseBooleanWord` is reused rather than
 * matched again here, so the two commands cannot end up with two vocabularies.
 *
 * A string it refuses falls back to `whenUnstated`, because a typo is not a
 * decision: taking any non-empty string as true would turn `mabye` into an
 * answer the user never gave.
 */
export function workflowFlag(projectYaml: unknown, key: string, whenUnstated: boolean): boolean {
  const value = record(record(projectYaml)?.workflow)?.[key];
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return whenUnstated;

  try {
    return parseBooleanWord(`workflow.${key}`, value);
  } catch {
    return whenUnstated;
  }
}

/**
 * How many domains a parsed domain map describes, or null when it describes
 * no `domains` mapping at all.
 *
 * The count is the point rather than mere existence: a map that names two
 * domains in a repo with forty is the failure a bare "the file is there" line
 * cannot show.
 */
export function domainCount(domainMapYaml: unknown): number | null {
  const domains = record(record(domainMapYaml)?.domains);
  return domains ? Object.keys(domains).length : null;
}

/**
 * The CDP port a parsed `agent-browser.json` names, or null when it names
 * none readable as a port.
 *
 * The file is written with the port as a string, so both a string and a
 * number are accepted: what matters is which port the tool will dial, not
 * which JSON type it was spelled with.
 */
export function agentBrowserCdpPort(agentBrowserJson: unknown): number | null {
  const cdp = record(agentBrowserJson)?.cdp;
  if (typeof cdp === 'number') return Number.isInteger(cdp) && cdp > 0 ? cdp : null;
  if (typeof cdp !== 'string') return null;
  const port = Number(cdp.trim());
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** The `outputStyle` a parsed Claude Code settings file selects, or null. */
export function outputStyleOf(settingsJson: unknown): string | null {
  return statedString(record(settingsJson)?.outputStyle);
}
