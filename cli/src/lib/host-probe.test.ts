import { describe, it, expect } from 'vitest';
import { runCommand, PROBE_TIMEOUT_MS } from './host-probe.js';

/**
 * `runCommand` bounds how long a probe may run, then reports whether it
 * exited 0 and what it printed.
 *
 * The timeout must be generous enough for a real probe this CLI actually
 * runs: `orca-ide status --json` is an Electron app that takes roughly 2.2
 * seconds to answer. A command that answers within 3 seconds must therefore
 * be reported as having answered, not as having timed out.
 */
describe('runCommand timeout', () => {
  it('reports a command that answers within 3 seconds as exited zero with its output', () => {
    const outcome = runCommand('sh', ['-c', 'sleep 3; echo hello']);
    expect(outcome.exitedZero).toBe(true);
    expect(outcome.stdout).toContain('hello');
  }, 10000);

  it('sets PROBE_TIMEOUT_MS to at least 10 seconds', () => {
    expect(PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(10000);
  });
});
