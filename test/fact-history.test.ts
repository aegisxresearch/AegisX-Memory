import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/core/engine.js';
import { FACT_HISTORY_MAX } from '../src/core/store.js';

let workspace: string;
let repoDir: string;
let engine: Engine;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-history-'));
  repoDir = path.join(workspace, 'repo');
  fs.mkdirSync(repoDir);
  engine = new Engine(path.join(workspace, 'memory.sqlite'));
});

afterEach(() => {
  engine.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('fact history — happy paths', () => {
  it('re-pinning a key records the old value, and recall reports it inline', () => {
    engine.remember('project.app.dev-port', '3000', repoDir);
    const updated = engine.remember('project.app.dev-port', '5000', repoDir);

    expect(updated.previousValue).toBe('3000');
    expect(engine.history('project.app.dev-port').map((entry) => entry.value)).toEqual(['3000']);

    const result = engine.recall(null, repoDir);
    const fact = result.facts.find((f) => f.key === 'project.app.dev-port');
    expect(fact?.value).toBe('5000');
    expect(fact?.previousValue).toBe('3000');

    // The agent must see that the change was deliberate, not a stale value.
    expect(engine.renderMarkdown(result)).toContain(
      '- [project.app.dev-port] 5000 — was: 3000 (changed ',
    );
  });

  it('listFacts carries the superseded value so the dashboard can flag a change', () => {
    engine.remember('project.app.dev-port', '3000', repoDir);
    engine.remember('project.app.dev-port', '5000', repoDir);
    engine.remember('project.app.stack', 'node', repoDir);

    const facts = engine.dashboardData().facts;
    const changed = facts.find((f) => f.key === 'project.app.dev-port');
    const fresh = facts.find((f) => f.key === 'project.app.stack');
    expect(changed?.value).toBe('5000');
    expect(changed?.previousValue).toBe('3000');
    // A key pinned once has nothing to report — the panel must not invent a change.
    expect(fresh?.previousValue).toBeUndefined();
  });

  it('keeps a bounded timeline, newest superseded value first', () => {
    for (let i = 0; i < FACT_HISTORY_MAX + 5; i++) {
      engine.remember('project.app.port', `p${i}`, repoDir);
    }

    const history = engine.history('project.app.port');
    expect(history).toHaveLength(FACT_HISTORY_MAX);
    // Current value is p14, so the newest superseded one is p13.
    expect(history[0]?.value).toBe(`p${FACT_HISTORY_MAX + 3}`);
    expect(history[0]?.key).toBe('project.app.port');
  });
});

describe('fact history — negative edge cases', () => {
  it('re-pinning the identical value is not a change', () => {
    engine.remember('project.app.test-cmd', 'npm test', repoDir);
    const again = engine.remember('project.app.test-cmd', 'npm test', repoDir);

    expect(again.previousValue).toBeUndefined();
    expect(engine.history('project.app.test-cmd')).toEqual([]);
    expect(engine.recentHistory()).toEqual([]);
    expect(engine.renderMarkdown(engine.recall(null, repoDir))).not.toContain('was:');
  });

  it('forget purges superseded values too', () => {
    engine.remember('project.app.port', 'old', repoDir);
    engine.remember('project.app.port', 'new', repoDir);
    expect(engine.history('project.app.port')).toHaveLength(1);

    expect(engine.forget('project.app.port')).toBe(true);
    expect(engine.fact('project.app.port')).toBeUndefined();
    expect(engine.history('project.app.port')).toEqual([]);
    expect(engine.recentHistory()).toEqual([]);
  });

  it('an unknown key has no history and nothing to forget', () => {
    expect(engine.fact('project.app.never-set')).toBeUndefined();
    expect(engine.history('project.app.never-set')).toEqual([]);
    expect(engine.forget('project.app.never-set')).toBe(false);
  });

  it('rejects an invalid key before touching history', () => {
    expect(() => engine.history('BAD KEY!')).toThrow();
    expect(() => engine.history('')).toThrow();
  });
});
