import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { request } from 'node:http';
import { delimiter, join } from 'node:path';

/**
 * Asking the live machine what it can actually do, for `spechub config
 * show`/`check`. Every probe here is bounded: `check` runs on a developer's
 * machine at a moment when something is already suspected broken, so a dead
 * port or a wedged binary must come back as a failed check, never as a hang.
 */

/** How long any single probe may take before it counts as "did not answer". */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Whether `binary` is an executable on PATH.
 *
 * Resolved by hand rather than through `which` or `command -v`: those are an
 * extra binary and a shell builtin respectively, and neither is guaranteed to
 * exist on whatever PATH this process inherited.
 */
export function binaryOnPath(binary: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, binary), constants.X_OK);
      return true;
    } catch {
      // Not here; keep looking.
    }
  }
  return false;
}

/** The first of `binaries` found on PATH, or undefined when none are. */
export function firstBinaryOnPath(binaries: readonly string[]): string | undefined {
  return binaries.find(binaryOnPath);
}

/**
 * Run `binary args...` and report whether it succeeded.
 *
 * Spawned without a shell, so PATH lookup is the kernel's `execvp` and no
 * `/bin/sh` needs to exist. Output is discarded: a probe's answer is its exit
 * status, and letting a child scribble on our stderr would corrupt the report.
 */
export function commandSucceeds(binary: string, args: readonly string[]): boolean {
  const result = spawnSync(binary, [...args], {
    stdio: 'ignore',
    timeout: PROBE_TIMEOUT_MS,
    shell: false,
  });
  return result.status === 0;
}

/**
 * Whether a real CDP endpoint answers on `port` on this machine.
 *
 * The probe is an HTTP GET of `/json/version`, and only an actual HTTP
 * response counts. A bare TCP connect would be cheaper and is tempting, but
 * it is exactly wrong for the case this check exists to catch: remote mode
 * runs over an SSH reverse tunnel, and the forwarded port keeps accepting
 * connections long after the browser or relay behind it has died. Connecting
 * therefore proves nothing; speaking HTTP proves something is home.
 *
 * The deadline covers the whole exchange, not just the connect, so the port
 * that accepts and then says nothing for ever fails rather than hangs.
 */
export function cdpPortAnswers(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (answered: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      resolve(answered);
    };

    const req = request(
      { host, port, path: '/json/version', method: 'GET', timeout: PROBE_TIMEOUT_MS },
      res => {
        res.resume(); // Drain, so the socket can close rather than linger.
        finish(true);
      }
    );

    const deadline = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    req.on('timeout', () => finish(false));
    req.on('error', () => finish(false));
    req.end();
  });
}
