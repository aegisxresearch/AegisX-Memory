import path from 'node:path';
import os from 'node:os';
import { AegisxError } from './types.js';

/**
 * AegisX home directory. Overridable for tests via AEGISX_HOME.
 * Default: ~/.aegisx
 */
export function aegisxHome(): string {
  const override = process.env['AEGISX_HOME'];
  if (override !== undefined && override.trim() !== '') {
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.aegisx');
}

export function dbPath(): string {
  return path.join(aegisxHome(), 'memory.sqlite');
}

/**
 * Parse AEGISX_ALLOWED_REPOS into a set of normalized repo paths (RFC §5,
 * STRIDE:S mitigation against cross-project access from a compromised client).
 * Entries are split on ":" (PATH-style separator), '~' expanded via
 * normalizeRepoPath; blank entries are ignored. An undefined/blank variable
 * yields null = unrestricted (default). Returns an EMPTY SET when the variable
 * is set but contains no usable entries → allowlist of zero repos (fail closed).
 */
export function parseAllowedRepos(raw: string | undefined): Set<string> | null {
  if (raw === undefined || raw.trim() === '') return null;
  const allowed = new Set<string>();
  for (const entry of raw.split(':')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    try {
      allowed.add(normalizeRepoPath(trimmed));
    } catch {
      // e.g. entry resolves to the home directory itself — never allow it.
    }
  }
  return allowed;
}

/**
 * If an allowlist is configured, assert the repo may be accessed.
 * Throws AegisxError('user') listing the allowed repos on denial.
 */
export function assertRepoAllowed(
  repo: string,
  allowed: Set<string> | null,
): void {
  if (allowed === null || allowed.has(repo)) return;
  throw new AegisxError(
    'user',
    `repo "${repo}" is not in AEGISX_ALLOWED_REPOS; allowed: ${[...allowed].join(', ')}`,
  );
}

/** Normalize a repo path for use as namespace key component. Idempotent: a
 *  previously-normalized path (leading `~`) normalizes to itself. */
export function normalizeRepoPath(repoAbsPath: string): string {
  const home = os.homedir();
  let p = repoAbsPath.startsWith('~')
    ? path.join(home, repoAbsPath.slice(1))
    : path.resolve(repoAbsPath);
  if (p === home) {
    throw new Error('Refusing to use home directory itself as a repo path');
  }
  if (p.startsWith(home + path.sep)) {
    p = '~' + p.slice(home.length);
  }
  return p.split(path.sep).join('/');
}
