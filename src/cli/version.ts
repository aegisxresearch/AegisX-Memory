/**
 * Build identity, in one place: `--version` and doctor's "is the registered
 * MCP entry the build you are running?" check both read it.
 *
 * `--version` used to print the package.json string alone — `1.0.0` since the
 * first commit, through dozens of behavioral changes, which once made a user
 * (reasonably) ask why a fresh install still said 1.0.0. The commit and date
 * are the real build identity; the semver moves only at tagged releases.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION_BASE } from '../core/version.js';

// Re-exported so CLI-side callers keep one import path for build identity.
export { VERSION_BASE };

/** The checkout this module was compiled into: `…/src/cli` or `…/dist/cli`, two levels up. */
export function checkoutRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * `1.30.0 (abc1234 · 2026-09-13)`, computed at *command time*, best effort: a
 * copy run outside a git checkout (npm tarball, someone's bare `dist/`) omits
 * the suffix instead of failing — the base version is always printed.
 */
export function versionString(): string {
  try {
    const opts = {
      cwd: checkoutRoot(),
      encoding: 'utf8' as const,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
    };
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], opts).trim();
    const date = execFileSync('git', ['log', '-1', '--format=%cs'], opts).trim();
    return `${VERSION_BASE} (${commit} · ${date})`;
  } catch {
    return VERSION_BASE;
  }
}

/**
 * Ask another build what it is: `node <entry> --version`. Returns its stamp, or
 * null when the file cannot answer (missing, not JS, no runtime, timeout) — a
 * probe failure must never become a verdict about someone's install.
 */
export function probeEntryVersion(entry: string): string | null {
  try {
    const out = execFileSync(process.execPath, [entry, '--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^\d+\.\d+\.\d+/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** Newest mtime (ms) under `dir`, or null when it is missing/unreadable. */
export function newestMtimeMs(dir: string, limit = 5000): number | null {
  let newest: number | null = null;
  let seen = 0;
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen++ > limit) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          const { mtimeMs } = fs.statSync(full);
          if (newest === null || mtimeMs > newest) newest = mtimeMs;
        } catch {
          // unreadable file: not evidence either way
        }
      }
    }
  };
  walk(dir);
  return newest;
}
