import { describe, it, expect } from 'vitest';
import {
  requiredHostAxisKeys,
  fallbackBrowserMode,
  projectHostContext,
  ORCHESTRATOR_PROBES,
  ORCHESTRATORS,
} from './host-status.js';

/**
 * Pure decision logic behind `spechub config show`/`spechub config check`.
 *
 * These two functions do not exist yet (this whole file is expected to fail
 * to even load until `src/lib/host-status.ts` is created), but the behaviour
 * they must have is fully determined by the requirement:
 *
 * - `requiredHostAxisKeys({ hasFrontend })` returns the dotted keys of every
 *   host axis that is required given whether the current project has a
 *   frontend configured. Both orchestrator booleans,
 *   `host.orchestrators.herdr` and `host.orchestrators.orca`, are always
 *   required: each is a separate yes/no about this machine, and answering one
 *   says nothing about the other. The three `host.browser.*` axes are
 *   required only when `hasFrontend` is true. No other axis is ever required.
 *
 * - `fallbackBrowserMode(declared)` picks the browser mode to use when the
 *   project's preferred mode is not declared available, in priority order
 *   remote > headless > local, from whichever of `declared.remote`,
 *   `declared.headless`, `declared.local` are `true`. It returns `undefined`
 *   when none are declared true.
 */

describe('requiredHostAxisKeys', () => {
  it('requires only the two orchestrator booleans when the project has no frontend configured', () => {
    const keys = requiredHostAxisKeys({ hasFrontend: false });

    expect(keys).toEqual(
      expect.arrayContaining(['host.orchestrators.herdr', 'host.orchestrators.orca'])
    );
    expect(keys).not.toContain('host.browser.remote');
    expect(keys).not.toContain('host.browser.headless');
    expect(keys).not.toContain('host.browser.local');
  });

  it('also requires the three browser axes when the project has a frontend configured', () => {
    const keys = requiredHostAxisKeys({ hasFrontend: true });

    expect(keys).toEqual(
      expect.arrayContaining([
        'host.orchestrators.herdr',
        'host.orchestrators.orca',
        'host.browser.remote',
        'host.browser.headless',
        'host.browser.local',
      ])
    );
  });

  it('never asks for the retired single host.orchestrator axis', () => {
    for (const hasFrontend of [false, true]) {
      expect(requiredHostAxisKeys({ hasFrontend })).not.toContain('host.orchestrator');
    }
  });

  it('never marks the optional axes as required, with or without a frontend', () => {
    for (const hasFrontend of [false, true]) {
      const keys = requiredHostAxisKeys({ hasFrontend });
      expect(keys).not.toContain('host.preview.tailscale_serve');
      expect(keys).not.toContain('host.element_picker');
      expect(keys).not.toContain('host.orca.topology');
    }
  });
});

describe('fallbackBrowserMode', () => {
  it('prefers remote when remote, headless and local are all declared true', () => {
    expect(fallbackBrowserMode({ remote: true, headless: true, local: true })).toBe('remote');
  });

  it('falls back to headless when remote is not declared true', () => {
    expect(fallbackBrowserMode({ remote: false, headless: true, local: true })).toBe('headless');
  });

  it('falls back to local when only local is declared true', () => {
    expect(fallbackBrowserMode({ remote: false, headless: false, local: true })).toBe('local');
  });

  it('returns undefined when nothing is declared true', () => {
    expect(fallbackBrowserMode({ remote: false, headless: false, local: false })).toBeUndefined();
  });

  it('treats an axis missing from the input as unavailable, not as true', () => {
    expect(fallbackBrowserMode({})).toBeUndefined();
    expect(fallbackBrowserMode({ headless: true })).toBe('headless');
  });
});

/**
 * `projectHostContext` reads `frontend.browser.fallback` verbatim off the
 * already-parsed project.yaml and surfaces it as a `fallback` field on the
 * returned context, alongside `hasProject`/`hasFrontend`/`preferredMode`/
 * `cdpPort`. It states the literal string found (e.g. "none", "headless") -
 * it does not interpret or validate it in any way here - and is `undefined`
 * whenever the project states no fallback, has no frontend at all, or does
 * not exist.
 */
describe('projectHostContext fallback', () => {
  it('surfaces frontend.browser.fallback verbatim when the project states one', () => {
    const ctx = projectHostContext({
      frontend: { browser: { mode: 'remote', fallback: 'none' } },
    });
    expect(ctx.fallback).toBe('none');
  });

  it('surfaces a fallback value that names one of the browser modes, unmodified', () => {
    const ctx = projectHostContext({
      frontend: { browser: { mode: 'remote', fallback: 'local' } },
    });
    expect(ctx.fallback).toBe('local');
  });

  it('leaves fallback undefined when the project has a frontend but states no fallback', () => {
    const ctx = projectHostContext({ frontend: { browser: { mode: 'remote' } } });
    expect(ctx.fallback).toBeUndefined();
  });

  it('leaves fallback undefined when the project has no frontend at all', () => {
    const ctx = projectHostContext({ profile: 'node-typescript' });
    expect(ctx.fallback).toBeUndefined();
  });

  it('leaves fallback undefined when there is no project at all', () => {
    const ctx = projectHostContext(undefined, false);
    expect(ctx.fallback).toBeUndefined();
  });
});

/**
 * An orchestrator probe answers one question: is this orchestrator actually
 * running on this machine? Its exit status is the whole answer, so a probe
 * that cannot exit 0 on a healthy host fails every host it is pointed at.
 *
 * A command group is exactly that kind of probe. `herdr api` groups
 * `snapshot` and `schema` and takes no action of its own: it prints its
 * subcommands and exits 2, running server or not. The probe has to name the
 * subcommand that reads live state.
 */
describe('ORCHESTRATOR_PROBES', () => {
  it('gives every orchestrator a command to run', () => {
    for (const name of ORCHESTRATORS) {
      expect(ORCHESTRATOR_PROBES[name].args.length).toBeGreaterThan(0);
    }
  });

  it('probes herdr with the api subcommand that reads live state, not the bare api group', () => {
    expect(ORCHESTRATOR_PROBES.herdr.args).toEqual(['api', 'snapshot']);
  });

  it('probes orca with the status subcommand', () => {
    expect(ORCHESTRATOR_PROBES.orca.args).toEqual(['status', '--json']);
  });
});
