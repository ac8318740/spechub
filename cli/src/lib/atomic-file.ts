/**
 * Putting a whole file in another file's place, which both writers in this CLI
 * need and neither gets from `writeFileSync`.
 *
 * `writeFileSync` empties the target first and writes second, so a process
 * killed between the two leaves a file of zero bytes - and a reader that
 * arrives in the gap sees one. Writing the bytes somewhere else and renaming
 * means the path only ever holds the whole old file or the whole new one.
 */

import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Where the new bytes wait until they take `path`'s name.
 *
 * Beside the target, because a rename across filesystems is not a rename, it
 * is a copy and a delete - the truncating write again under another name.
 *
 * The pid alone does not name it. A run killed before its cleanup leaves the
 * temp file behind, pids come round again, and the next run holding that pid
 * would write over a file it did not create. The random half is what makes
 * each attempt's temp file its own.
 */
function tempPathFor(path: string): string {
  return `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
}

/**
 * Write `text` and give it `path`'s name, as one whole file.
 *
 * `beforeRename` is handed the temp file while it is still a temp file, for a
 * caller that has to carry something across from the file being replaced - the
 * mode it was set to, which a fresh file gets from the umask instead.
 *
 * A failure leaves nothing behind: the temp file goes, and the error the
 * caller has to see is the one that comes out.
 */
export function replaceFileAtomically(
  path: string,
  text: string,
  beforeRename?: (temp: string) => void
): void {
  const temp = tempPathFor(path);
  try {
    writeFileSync(temp, text, 'utf-8');
    beforeRename?.(temp);
    renameSync(temp, path);
  } catch (err) {
    try {
      // Leave no half-written file for whoever looks in this directory next.
      rmSync(temp, { force: true });
    } catch {
      // `force` covers a temp path that is not there; it does not cover one
      // that is a directory. Throwing from the cleanup would replace the
      // error the caller is meant to read with one about tidying up after it.
    }
    throw err;
  }
}
