import { readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

/**
 * Resolve the CLI's version.
 *
 * The single source of truth is `.claude-plugin/plugin.json`, and this reads it
 * at runtime rather than baking a copy in at build time. A copy only stays
 * correct if something reruns the build, and the build only reruns when
 * `cli/src/` changes – so bumping the plugin without touching the CLI left the
 * copy behind. That is exactly how the CLI shipped `0.1.0` while the plugin was
 * at 0.14.2.
 *
 * Searches upward rather than using a fixed number of `..` hops, because the
 * bundle runs from `cli/dist/` while the tests run from `cli/src/lib/`, and
 * both should find the same manifest.
 *
 * Falls back to package.json for the case where the CLI runs outside a plugin
 * layout, and to a placeholder if neither is readable – a missing version is
 * never worth crashing over.
 */
export function resolveVersion(startDir: string): string {
  const candidates = [join('.claude-plugin', 'plugin.json'), 'package.json'];

  for (const relative of candidates) {
    let dir = startDir;
    const { root } = parse(dir);

    while (true) {
      try {
        const parsed: unknown = JSON.parse(
          readFileSync(join(dir, relative), 'utf-8')
        );
        const version = (parsed as { version?: unknown }).version;
        if (typeof version === 'string' && version.length > 0) {
          return version;
        }
      } catch {
        // Not here, or not readable. Keep climbing.
      }

      if (dir === root) break;
      dir = dirname(dir);
    }
  }

  return '0.0.0-unknown';
}
