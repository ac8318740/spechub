import { describe, it, expect } from 'vitest';
import { requiredHostAxisKeys, fallbackBrowserMode } from './host-status.js';

/**
 * Pure decision logic behind `spechub config show`/`spechub config check`.
 *
 * These two functions do not exist yet (this whole file is expected to fail
 * to even load until `src/lib/host-status.ts` is created), but the behaviour
 * they must have is fully determined by the requirement:
 *
 * - `requiredHostAxisKeys({ hasFrontend })` returns the dotted keys of every
 *   host axis that is required given whether the current project has a
 *   frontend configured. `host.orchestrator` is always required. The three
 *   `host.browser.*` axes are required only when `hasFrontend` is true. No
 *   other axis is ever required.
 *
 * - `fallbackBrowserMode(declared)` picks the browser mode to use when the
 *   project's preferred mode is not declared available, in priority order
 *   remote > headless > local, from whichever of `declared.remote`,
 *   `declared.headless`, `declared.local` are `true`. It returns `undefined`
 *   when none are declared true.
 */

describe('requiredHostAxisKeys', () => {
  it('requires only host.orchestrator when the project has no frontend configured', () => {
    const keys = requiredHostAxisKeys({ hasFrontend: false });

    expect(keys).toContain('host.orchestrator');
    expect(keys).not.toContain('host.browser.remote');
    expect(keys).not.toContain('host.browser.headless');
    expect(keys).not.toContain('host.browser.local');
  });

  it('also requires the three browser axes when the project has a frontend configured', () => {
    const keys = requiredHostAxisKeys({ hasFrontend: true });

    expect(keys).toEqual(
      expect.arrayContaining([
        'host.orchestrator',
        'host.browser.remote',
        'host.browser.headless',
        'host.browser.local',
      ])
    );
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
