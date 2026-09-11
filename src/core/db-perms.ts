/**
 * Owner-only permissions for the memory database (RFC §5, STRIDE:I).
 * The DB summarizes a developer's codebase — on shared hosts it must not be
 * readable by other accounts. `0600` is applied best effort after creation:
 * SQLite creates the file itself, so mkdir's mode flag cannot cover it.
 */
import fs from 'node:fs';

export function secureDbFile(dbFile: string): void {
  try {
    fs.chmodSync(dbFile, 0o600);
  } catch {
    // Non-POSIX filesystems (some network mounts) may refuse chmod —
    // restrictive-umask creation is the fallback, never a hard failure.
  }
}
