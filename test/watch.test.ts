import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/core/engine.js';
import { startWatch } from '../src/cli/watch.js';

let workspace: string;
let repoDir: string;
let dbFile: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-watch-'));
  repoDir = path.join(workspace, 'repo');
  fs.mkdirSync(repoDir);
  dbFile = path.join(workspace, 'memory.sqlite');
  // prime the DB
  const e = new Engine(dbFile);
  e.close();
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor timed out');
}

describe('watch — event-driven', () => {
  it('initial scan indexes existing files', async () => {
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export function hello() {}\n');
    const handle = await startWatch({
      repoPath: repoDir,
      dbFile,
      debounceMs: 50,
      skipInitialScan: false,
    });
    try {
      await waitFor(() => handle.scans >= 1, 3000);
      const e = new Engine(dbFile);
      try {
        const stats = e.statsFor(repoDir);
        expect(stats.files).toBe(1);
        expect(stats.scans.total).toBeGreaterThanOrEqual(1);
      } finally {
        e.close();
      }
    } finally {
      await handle.close();
    }
  });

  it('file change triggers debounced re-index (coalesced)', async () => {
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export function hello() {}\n');
    const scans: number[] = [];
    const handle = await startWatch({
      repoPath: repoDir,
      dbFile,
      debounceMs: 120,
      skipInitialScan: true,
      onScan: () => scans.push(Date.now()),
    });
    try {
      // No initial scan when skipped
      expect(handle.scans).toBe(0);
      // Multiple rapid writes should coalesce into one scan
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(repoDir, 'a.ts'), `export function hello${i}() {}\n`);
      }
      await waitFor(() => handle.scans >= 1, 4000);
      // Give debounce window time to settle; should not spawn a second burst
      await new Promise((r) => setTimeout(r, 300));
      expect(handle.scans).toBe(1);
      expect(scans.length).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it('respects .gitignore and skips dotfiles / junk dirs', async () => {
    fs.writeFileSync(path.join(repoDir, '.gitignore'), 'ignored.ts\n');
    fs.writeFileSync(path.join(repoDir, 'ignored.ts'), 'export function ignored() {}\n');
    fs.writeFileSync(path.join(repoDir, '.env'), 'SECRET=1\n');
    fs.mkdirSync(path.join(repoDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'node_modules', 'pkg', 'x.ts'), 'export function junk() {}\n');

    const handle = await startWatch({
      repoPath: repoDir,
      dbFile,
      debounceMs: 50,
      skipInitialScan: false,
    });
    try {
      await waitFor(() => handle.scans >= 1, 3000);
      const e = new Engine(dbFile);
      try {
        expect(e.statsFor(repoDir).files).toBe(0);
      } finally {
        e.close();
      }
      // Editing an ignored file should not trigger a rescan
      const before = handle.scans;
      fs.writeFileSync(path.join(repoDir, 'ignored.ts'), 'export function ignored2() {}\n');
      await new Promise((r) => setTimeout(r, 400));
      expect(handle.scans).toBe(before);
    } finally {
      await handle.close();
    }
  });

  it('close() stops watching (no further scans after close)', async () => {
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export function hello() {}\n');
    const handle = await startWatch({
      repoPath: repoDir,
      dbFile,
      debounceMs: 50,
      skipInitialScan: false,
    });
    await waitFor(() => handle.scans >= 1, 3000);
    const scansBeforeClose = handle.scans;
    await handle.close();
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export function changed() {}\n');
    await new Promise((r) => setTimeout(r, 500));
    expect(handle.scans).toBe(scansBeforeClose);
  });

  it('negative: invalid repo path throws user error', async () => {
    await expect(
      startWatch({ repoPath: path.join(workspace, 'nope'), dbFile, debounceMs: 50 }),
    ).rejects.toThrow(/does not exist|not a directory/i);
  });
});

describe('watch — polling fallback', () => {
  it('polling mode also re-indexes on change', async () => {
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export function hello() {}\n');
    const handle = await startWatch({
      repoPath: repoDir,
      dbFile,
      debounceMs: 50,
      usePolling: true,
      pollIntervalMs: 300,
      skipInitialScan: false,
    });
    try {
      await waitFor(() => handle.scans >= 1, 3000);
      const before = handle.scans;
      fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export function changed() {}\n');
      await waitFor(() => handle.scans > before, 4000);
      expect(handle.scans).toBeGreaterThan(before);
    } finally {
      await handle.close();
    }
  });
});
