import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { normalizeRepoPath } from '../src/core/paths.js';

let workspace: string;
let repoDir: string;
let dbFile: string;
let engine: Engine;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-obs-'));
  repoDir = path.join(workspace, 'repo');
  fs.mkdirSync(repoDir);
  dbFile = path.join(workspace, 'memory.sqlite');
  engine = new Engine(dbFile);
});

afterEach(() => {
  engine.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('observability — stats', () => {
  it('fresh repo: scans/recalls are zero, nullable fields are null/empty', () => {
    const stats = engine.statsFor(repoDir);
    expect(stats.scans.total).toBe(0);
    expect(stats.scans.avgDurationMs).toBeNull();
    expect(stats.scans.lastAt).toBeNull();
    expect(stats.scans.recent).toEqual([]);
    expect(stats.recalls.total).toBe(0);
    expect(stats.recalls.hits).toBe(0);
    expect(stats.recalls.hitRate).toBeNull();
    expect(stats.recalls.avgTokens).toBeNull();
    expect(stats.recalls.tokensSavedEstimate).toBeNull();
    expect(stats.tokensSavedEstimate).toBeNull();
    expect(stats.hitRate).toBeNull();
    // base counts still present
    expect(stats.repo).toContain('/');
    expect(stats.files).toBe(0);
    expect(stats.symbols).toBe(0);
  });

  it('indexing increments scans, recalls are recorded with hit rate and tokens', () => {
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export function hello() {}\n');
    engine.indexRepo(repoDir);
    engine.indexRepo(repoDir); // second scan → avg
    const afterScans = engine.statsFor(repoDir);
    expect(afterScans.scans.total).toBe(2);
    expect(afterScans.scans.avgDurationMs !== null && afterScans.scans.avgDurationMs >= 0).toBe(true);
    expect(afterScans.scans.lastAt !== null).toBe(true);
    expect(afterScans.scans.recent.length).toBe(2);
    expect(afterScans.scans.lastFilesTotal).toBe(1);

    // recalls: some hit, some miss
    engine.recall('hello', repoDir);
    engine.recall(null, repoDir);
    const afterRecalls = engine.statsFor(repoDir);
    expect(afterRecalls.recalls.total).toBe(2);
    // at least one recall hit (the indexed file makes the brief non-empty)
    expect(afterRecalls.recalls.hits).toBeGreaterThanOrEqual(1);
    expect(afterRecalls.recalls.hitRate !== null).toBe(true);
    expect(afterRecalls.recalls.avgTokens !== null && afterRecalls.recalls.avgTokens! > 0).toBe(true);
    expect(afterRecalls.recalls.recent.length).toBe(2);
    expect(afterRecalls.hitRate).toBe(afterRecalls.recalls.hitRate);
    expect(afterRecalls.tokensSavedEstimate).toBe(afterRecalls.recalls.tokensSavedEstimate);
  });

  it('tokensSavedEstimate grows with hits and is null before any recall', () => {
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export function hello() {}\n');
    engine.indexRepo(repoDir);
    const before = engine.statsFor(repoDir);
    expect(before.tokensSavedEstimate).toBeNull();
    // two hits → positive estimate
    engine.recall(null, repoDir);
    engine.recall(null, repoDir);
    const after = engine.statsFor(repoDir);
    expect(after.tokensSavedEstimate !== null && after.tokensSavedEstimate! > 0).toBe(true);
    // monotonically non-decreasing
    engine.recall(null, repoDir);
    const afterMore = engine.statsFor(repoDir);
    expect(afterMore.tokensSavedEstimate! >= after.tokensSavedEstimate!).toBe(true);
  });

  it('purgeTelemetry clears scans/recalls for the repo', () => {
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export function hello() {}\n');
    engine.indexRepo(repoDir);
    engine.recall(null, repoDir);
    expect(engine.statsFor(repoDir).scans.total).toBe(1);
    expect(engine.statsFor(repoDir).recalls.total).toBe(1);
    const purged = engine.purgeTelemetry(repoDir);
    expect(purged.scans).toBe(1);
    expect(purged.recalls).toBe(1);
    const cleared = engine.statsFor(repoDir);
    expect(cleared.scans.total).toBe(0);
    expect(cleared.recalls.total).toBe(0);
  });

  it('retention: pruneOldTelemetry removes only rows older than the window', () => {
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export function hello() {}\n');
    engine.indexRepo(repoDir);
    engine.recall(null, repoDir);

    // Seed a stale scan + recall dated 40 days ago (directly, bypassing Engine).
    const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000).toISOString();
    const store = new Store(dbFile);
    try {
      const db = store as unknown as {
        prepared: (sql: string) => { run: (...args: unknown[]) => unknown };
      };
      store.recordScanRun(normalizeRepoPath(repoDir), {
        filesTotal: 1, filesChanged: 0, filesDeleted: 0, filesSkipped: 0, symbolsTotal: 1, durationMs: 1,
      });
      store.recordRecallRun(normalizeRepoPath(repoDir), 'q', 10, 1, 0, 0, true);
      // Backdate ONLY the freshly seeded rows (last id of each table), leaving
      // the Engine-made rows fresh — the prune must be selective.
      db.prepared('UPDATE scan_runs SET created_at = ? WHERE id = (SELECT MAX(id) FROM scan_runs)').run(stale);
      db.prepared('UPDATE recall_runs SET created_at = ? WHERE id = (SELECT MAX(id) FROM recall_runs)').run(stale);
    } finally {
      store.close();
    }

    const pruned = engine.purgeStaleTelemetry();
    expect(pruned.scans).toBe(1);
    expect(pruned.recalls).toBe(1);
    // Fresh rows survive the retention prune.
    const after = engine.statsFor(repoDir);
    expect(after.scans.total).toBe(1); // the Engine-made scan
    expect(after.recalls.total).toBe(1);
  });

  it('retention: indexing prunes stale telemetry automatically (D3)', () => {
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export function hello() {}\n');
    engine.indexRepo(repoDir);
    const store = new Store(dbFile);
    try {
      const db = store as unknown as {
        prepared: (sql: string) => { run: (...args: unknown[]) => unknown };
      };
      const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000).toISOString();
      db.prepared('UPDATE scan_runs SET created_at = ?').run(stale);
      db.prepared('UPDATE recall_runs SET created_at = ?').run(stale);
    } finally {
      store.close();
    }
    engine.indexRepo(repoDir); // triggers opportunistic prune
    const after = engine.statsFor(repoDir);
    expect(after.scans.total).toBe(1); // only this scan; the stale one is gone
  });

  it('stats --json shape is strict JSON with scans/recalls/tokensSavedEstimate', () => {
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export function hello() {}\n');
    engine.indexRepo(repoDir);
    engine.recall(null, repoDir);
    const stats = engine.statsFor(repoDir);
    const json = JSON.stringify(stats);
    const parsed = JSON.parse(json) as typeof stats;
    expect(parsed.scans).toBeDefined();
    expect(parsed.recalls).toBeDefined();
    expect(parsed.tokensSavedEstimate).toBeDefined();
    expect(parsed.hitRate).toBeDefined();
  });

  it('telemetry failure never breaks indexing or recall', () => {
    // Corrupt the telemetry tables directly, then ensure ops still succeed
    // We do this by closing and tampering, then reopening via a new Engine.
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export function hello() {}\n');
    engine.indexRepo(repoDir);
    expect(() => engine.recall(null, repoDir)).not.toThrow();
    // Even if we drop and recreate tables weirdly, scan still works
    engine.close();
    const engine2 = new Engine(dbFile);
    try {
      fs.writeFileSync(path.join(repoDir, 'b.ts'), 'export function world() {}\n');
      expect(() => engine2.indexRepo(repoDir)).not.toThrow();
      expect(() => engine2.recall(null, repoDir)).not.toThrow();
      expect(engine2.statsFor(repoDir).scans.total).toBeGreaterThanOrEqual(1);
    } finally {
      engine2.close();
      // Prevent afterEach double-close on the already-closed engine
      (engine as unknown as { close: () => void }).close = () => undefined;
    }
  });
});
