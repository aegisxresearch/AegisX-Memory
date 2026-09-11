/**
 * Watch: event-driven incremental indexing that keeps the memory fresh.
 *
 * Two modes:
 *  - native (chokidar FS events) — precise, near-instant, low overhead
 *  - polling (--poll) — reliable on network/VM filesystems where events drop
 *
 * Both modes reuse the Engine's hash-based incremental scan, so a no-op
 * tick is cheap (warm <200ms) and nothing stale is ever served.
 */
import fs from 'node:fs';
import path from 'node:path';
import ignoreFactory from 'ignore';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { Engine } from '../core/engine.js';
import type { ScanStats } from '../core/types.js';
import { isSecretBearingFile, MAX_DEPTH } from '../indexer/indexer.js';
import { AegisxError } from '../core/types.js';

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', '.cache',
  'coverage', '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.aegisx-cache',
]);

export interface WatchOptions {
  repoPath: string;
  dbFile: string;
  debounceMs?: number;
  usePolling?: boolean;
  pollIntervalMs?: number;
  onScan?: (stats: ScanStats) => void;
  onWarn?: (msg: string) => void;
  onError?: (err: Error) => void;
  /** Test seam: disable the initial scan that normally primes the index. */
  skipInitialScan?: boolean;
}

export interface WatchHandle {
  /** Stop watching, close the watcher and the Engine's DB handles. */
  close(): Promise<void>;
  /** How many scans have been executed (initial + incremental). */
  scans: number;
}

function loadIgnoreRules(root: string): ReturnType<typeof ignoreFactory> {
  const ig = ignoreFactory();
  const gi = path.join(root, '.gitignore');
  if (fs.existsSync(gi)) {
    try {
      ig.add(fs.readFileSync(gi, 'utf8'));
    } catch {
      // unreadable .gitignore is non-fatal
    }
  }
  return ig;
}

function buildIgnoredPredicate(root: string): (candidate: string) => boolean {
  const ig = loadIgnoreRules(root);
  return (candidate: string): boolean => {
    const abs = path.resolve(candidate);
    const rootAbs = path.resolve(root);
    // chokidar also probes the root itself — never ignore that
    if (abs === rootAbs) return false;
    const rel = path.relative(rootAbs, abs).split(path.sep).join('/');
    if (rel === '') return false;
    const base = path.basename(abs);
    if (DEFAULT_SKIP_DIRS.has(base)) return true;
    if (base.startsWith('.')) return true;
    // ignore globs from .gitignore (both file and directory forms)
    if (ig.ignores(rel) || ig.ignores(rel + '/')) return true;
    if (isSecretBearingFile(rel)) return true;
    return false;
  };
}

function validateRepoDir(repoPath: string): string {
  const root = path.resolve(repoPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new AegisxError('user', `repo path does not exist or is not a directory: ${root}`);
  }
  return root;
}

/**
 * Start watching `repoPath`. The handle's `close()` must be called to free
 * the watcher and DB handles. The watcher owns its own Engine instance —
 * callers must not share that Engine elsewhere.
 */
export async function startWatch(options: WatchOptions): Promise<WatchHandle> {
  const repoPath = validateRepoDir(options.repoPath);
  // Authorization first (RFC §5, STRIDE:S): fail fast with a clear user error
  // instead of spawning a watcher that errors on every scan.
  const engine = new Engine(options.dbFile);
  engine.assertRepoAllowed(options.repoPath);
  const debounceMs = options.debounceMs ?? 300;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const usePolling = options.usePolling ?? false;
  const onScan = options.onScan ?? (() => undefined);
  const onWarn = options.onWarn ?? (() => undefined);
  const onError = options.onError ?? (() => undefined);

  if (debounceMs <= 0 || debounceMs > 10_000) {
    throw new AegisxError('user', '--debounce must be between 1 and 10000 ms');
  }
  if (pollIntervalMs < 200 || pollIntervalMs > 60_000) {
    throw new AegisxError('user', '--interval must be between 200 and 60000 ms');
  }

  let closed = false;
  let scans = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let scanning = false;
  let pendingRescan = false;

  const doScan = (): void => {
    if (closed) return;
    if (scanning) {
      pendingRescan = true;
      return;
    }
    scanning = true;
    try {
      const stats = engine.indexRepo(repoPath, onWarn);
      scans += 1;
      onScan(stats);
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      scanning = false;
      if (pendingRescan) {
        pendingRescan = false;
        schedule(0);
      }
    }
  };

  const schedule = (delay: number): void => {
    if (closed) return;
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doScan, delay);
  };

  let chokidarHandle: FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // Initial scan: if nothing indexed yet, doScan primes the ledger so the
  // first recall after `watch` already has data. Skipped only in tests.
  if (options.skipInitialScan !== true) {
    doScan();
  }

  if (usePolling) {
    pollTimer = setInterval(() => {
      // Polling mode still debounces to coalesce rapid external changes.
      schedule(debounceMs);
    }, pollIntervalMs);
    // Don't prevent Node from exiting if this is the only handle left.
    if (pollTimer !== null && typeof (pollTimer as unknown as { unref?: () => void }).unref === 'function') {
      (pollTimer as unknown as { unref: () => void }).unref!();
    }
  } else {
    const ignored = buildIgnoredPredicate(repoPath);
    chokidarHandle = chokidarWatch(repoPath, {
      ignored: (candidate: string, stats) => {
        // chokidar passes the raw path; our predicate expects absolute
        void stats;
        return ignored(candidate);
      },
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      followSymlinks: false,
      depth: MAX_DEPTH,
      // Do not watch unreadable dirs eagerly — error handler covers it.
      ignorePermissionErrors: true,
    });

    const onFsEvent = (): void => schedule(debounceMs);
    chokidarHandle.on('add', onFsEvent);
    chokidarHandle.on('change', onFsEvent);
    chokidarHandle.on('unlink', onFsEvent);
    chokidarHandle.on('addDir', onFsEvent);
    chokidarHandle.on('unlinkDir', onFsEvent);
    chokidarHandle.on('error', (err: unknown) => {
      onError(err instanceof Error ? err : new Error(String(err)));
    });

    // Wait for chokidar to finish its initial scan so we don't race
    // with file creation that happens immediately after startWatch.
    await new Promise<void>((resolve, reject) => {
      if (chokidarHandle === null) {
        resolve();
        return;
      }
      chokidarHandle.once('ready', () => resolve());
      chokidarHandle.once('error', (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
      // Safety timeout: if FS is pathological, still resolve after 5s.
      setTimeout(() => resolve(), 5_000);
    });
  }

  const handle: WatchHandle = {
    get scans() {
      return scans;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (chokidarHandle !== null) {
        await chokidarHandle.close();
        chokidarHandle = null;
      }
      engine.close();
    },
  };

  return handle;
}
