import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { AegisxError } from '../src/core/types.js';
import { normalizeRepoPath, parseAllowedRepos } from '../src/core/paths.js';
import { startWatch } from '../src/cli/watch.js';

let workspace: string;
let repoA: string;
let repoB: string;
let dbFile: string;
let previousEnv: string | undefined;

function writeRepoFile(repoDir: string, rel: string, content: string): void {
  const abs = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-allow-'));
  repoA = path.join(workspace, 'repo-a');
  repoB = path.join(workspace, 'repo-b');
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
  dbFile = path.join(workspace, 'memory.sqlite');
  previousEnv = process.env['AEGISX_ALLOWED_REPOS'];
  delete process.env['AEGISX_ALLOWED_REPOS'];
});

afterEach(() => {
  if (previousEnv === undefined) {
    delete process.env['AEGISX_ALLOWED_REPOS'];
  } else {
    process.env['AEGISX_ALLOWED_REPOS'] = previousEnv;
  }
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('allowlist — parser (paths.ts)', () => {
  it('happy: parses colon-separated entries into normalized repo paths', () => {
    const set = parseAllowedRepos(`${repoA}:${repoB}`);
    expect(set).not.toBeNull();
    expect(set).toEqual(new Set([normalizeRepoPath(repoA), normalizeRepoPath(repoB)]));
  });

  it('happy: undefined or blank variable means unrestricted (null)', () => {
    expect(parseAllowedRepos(undefined)).toBeNull();
    expect(parseAllowedRepos('')).toBeNull();
    expect(parseAllowedRepos('   ')).toBeNull();
  });

  it('negative: set but unusable variable yields an EMPTY allowlist (fail closed)', () => {
    const set = parseAllowedRepos(':');
    expect(set).not.toBeNull();
    expect(set!.size).toBe(0);
    // An entry that resolves to the home directory itself is refused, never allowed.
    const withHome = parseAllowedRepos('~');
    expect(withHome).not.toBeNull();
    expect(withHome!.size).toBe(0);
  });

  it('happy: ~ entries expand to the home-anchored normalized form', () => {
    const set = parseAllowedRepos('~/projects/app');
    expect(set).not.toBeNull();
    const only = [...set!][0] as string;
    expect(only.startsWith('~/')).toBe(true);
    expect(only.endsWith('/projects/app')).toBe(true);
  });
});

describe('allowlist — engine enforcement', () => {
  it('happy: unrestricted engine keeps working when the variable is unset', () => {
    writeRepoFile(repoA, 'src/a.ts', 'export function alpha() {}\n');
    const engine = new Engine(dbFile);
    try {
      expect(() => engine.indexRepo(repoA)).not.toThrow();
      const result = engine.recall('alpha', repoA);
      expect(result.symbols.some((s) => s.name === 'alpha')).toBe(true);
    } finally {
      engine.close();
    }
  });

  it('happy: allowlisted repo allows index, recall, remember, save, stats', () => {
    process.env['AEGISX_ALLOWED_REPOS'] = `${repoA}:${repoB}`;
    writeRepoFile(repoA, 'src/a.ts', 'export function alpha() {}\n');
    const engine = new Engine(dbFile);
    try {
      expect(() => engine.indexRepo(repoA)).not.toThrow();
      expect(() => engine.remember('project.a.key', 'value', repoA)).not.toThrow();
      expect(() =>
        engine.saveSession(repoA, { goal: 'g', facts: ['f'], decisions: ['d'], nextSteps: ['n'] }),
      ).not.toThrow();
      expect(engine.recall(null, repoA).facts.some((f) => f.key === 'project.a.key')).toBe(true);
      expect(engine.statsFor(repoA).files).toBe(1);
    } finally {
      engine.close();
    }
  });

  it('negative: non-allowlisted repo is denied on every repo-taking operation', () => {
    process.env['AEGISX_ALLOWED_REPOS'] = repoA;
    const engine = new Engine(dbFile);
    try {
      for (const attempt of [
        () => engine.indexRepo(repoB),
        () => engine.recall(null, repoB),
        () => engine.remember('project.b.key', 'value', repoB),
        () => engine.saveSession(repoB, { goal: 'g', facts: [], decisions: [], nextSteps: [] }),
        () => engine.statsFor(repoB),
        () => engine.purgeTelemetry(repoB),
      ]) {
        expect(attempt).toThrow(AegisxError);
        expect(attempt).toThrow(/not in AEGISX_ALLOWED_REPOS/);
      }
    } finally {
      engine.close();
    }
  });

  it('negative: denial message names the offending repo and the allowed set', () => {
    process.env['AEGISX_ALLOWED_REPOS'] = repoA;
    const engine = new Engine(dbFile);
    try {
      expect(() => engine.indexRepo(repoB)).toThrow(/not in AEGISX_ALLOWED_REPOS/);
      expect(() => engine.indexRepo(repoB)).toThrow(new RegExp(`allowed: ${normalizeRepoPath(repoA).replace(/[\\/]/g, '.')}`));
    } finally {
      engine.close();
    }
  });

  it('negative: fail closed — an allowlist of zero repos denies even the home-adjacent repo', () => {
    process.env['AEGISX_ALLOWED_REPOS'] = ':';
    const engine = new Engine(dbFile);
    try {
      expect(() => engine.recall(null, repoA)).toThrow(AegisxError);
      expect(() => engine.recall(null, repoA)).toThrow(/allowed: $/);
    } finally {
      engine.close();
    }
  });

  it('negative: remember with null repo hint is the global namespace — not gated', () => {
    process.env['AEGISX_ALLOWED_REPOS'] = repoA;
    const engine = new Engine(dbFile);
    try {
      expect(() => engine.remember('global.key', 'value', null)).not.toThrow();
      expect(engine.remember('global.key', 'value2', null).repoHint).toBeNull();
    } finally {
      engine.close();
    }
  });
});

describe('allowlist — cross-project leak prevention on global recall', () => {
  /** Knowledge writes live on the Store; tests seed through it directly. */
  function seedKnowledge(repo: string, kind: 'gotcha' | 'decision' | 'lesson', title: string, body: string): void {
    const store = new Store(dbFile);
    try {
      store.saveKnowledge(repo, kind, title, body, []);
    } finally {
      store.close();
    }
  }

  it('negative: repo-less FTS recall drops knowledge from non-allowed repos', () => {
    // Seed knowledge in both repos while unrestricted.
    seedKnowledge(normalizeRepoPath(repoA), 'gotcha', 'alpha gotcha', 'repo a body');
    seedKnowledge(normalizeRepoPath(repoB), 'gotcha', 'beta gotcha', 'repo b body');
    process.env['AEGISX_ALLOWED_REPOS'] = repoA;
    const engine = new Engine(dbFile);
    try {
      // Global (repo-less) recall: must not surface repo B's knowledge.
      const global = engine.recall('gotcha', null);
      expect(global.knowledge.some((k) => k.repo === normalizeRepoPath(repoB))).toBe(false);
      expect(global.knowledge.some((k) => k.repo === normalizeRepoPath(repoA))).toBe(true);

      // Repo-scoped recall for the allowed repo is unaffected.
      const scoped = engine.recall('gotcha', repoA);
      expect(scoped.knowledge.some((k) => k.title === 'alpha gotcha')).toBe(true);
    } finally {
      engine.close();
    }
  });

  it('happy: global recall keeps knowledge from allowed repos only', () => {
    seedKnowledge(normalizeRepoPath(repoA), 'decision', 'alpha decision', 'keep me');
    seedKnowledge(normalizeRepoPath(repoB), 'decision', 'beta decision', 'drop me');
    process.env['AEGISX_ALLOWED_REPOS'] = `${repoA}:${repoB}`;
    const engine = new Engine(dbFile);
    try {
      const global = engine.recall('decision', null);
      const titles = global.knowledge.map((k) => k.title);
      expect(titles).toContain('alpha decision');
      expect(titles).toContain('beta decision');
    } finally {
      engine.close();
    }
  });

  it('happy: global recall keeps other repos’ knowledge when unrestricted', () => {
    seedKnowledge(normalizeRepoPath(repoA), 'lesson', 'alpha lesson', 'body');
    seedKnowledge(normalizeRepoPath(repoB), 'lesson', 'beta lesson', 'body');
    const engine = new Engine(dbFile);
    try {
      const global = engine.recall('lesson', null);
      const titles = global.knowledge.map((k) => k.title);
      expect(titles).toContain('alpha lesson');
      expect(titles).toContain('beta lesson');
    } finally {
      engine.close();
    }
  });
});

describe('allowlist — watch mode', () => {
  it('happy: watch starts on an allowlisted repo', async () => {
    process.env['AEGISX_ALLOWED_REPOS'] = repoA;
    writeRepoFile(repoA, 'src/a.ts', 'export function alpha() {}\n');
    const handle = await startWatch({ repoPath: repoA, dbFile, debounceMs: 50, skipInitialScan: true });
    try {
      expect(handle.scans).toBe(0); // nothing thrown during startup
    } finally {
      await handle.close();
    }
  });

  it('negative: watch refuses a non-allowlisted repo before spawning a watcher', async () => {
    process.env['AEGISX_ALLOWED_REPOS'] = repoA;
    await expect(
      startWatch({ repoPath: repoB, dbFile, debounceMs: 50, skipInitialScan: true }),
    ).rejects.toThrow(/not in AEGISX_ALLOWED_REPOS/);
  });
});
