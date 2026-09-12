import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { AegisxError, type KnowledgeKind } from '../src/core/types.js';

let workspace: string;
let repo: string;
let dbFile: string;
let store: Store;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-knowledge-'));
  repo = path.join(workspace, 'repo');
  fs.mkdirSync(repo);
  dbFile = path.join(workspace, 'memory.sqlite');
  delete process.env['AEGISX_ALLOWED_REPOS'];
  store = new Store(dbFile);
});

afterEach(() => {
  store.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('knowledge — upsert identity (repo, kind, title)', () => {
  it('re-recording the same identity overwrites in place instead of duplicating', () => {
    const first = store.saveKnowledge(repo, 'decision', 'pick sqlite', 'zero-config local storage', []);
    expect(first.updated).toBeUndefined();

    const second = store.saveKnowledge(repo, 'decision', 'pick sqlite', 'WAL + FTS5, no server to run', [
      'docs/ADR-1.md',
    ]);
    expect(second.updated).toBe(true);

    const rows = store.knowledgeForRepo(repo);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe('WAL + FTS5, no server to run');
    expect(rows[0]?.anchors).toEqual(['docs/ADR-1.md']);
    expect(store.countKnowledge()).toBe(1);
  });

  it('a different kind or title is a different entry', () => {
    store.saveKnowledge(repo, 'decision', 'pick sqlite', 'a', []);
    store.saveKnowledge(repo, 'decision', 'pick redis', 'b', []);
    store.saveKnowledge(repo, 'gotcha', 'pick sqlite', 'c', []);

    expect(store.countKnowledge()).toBe(3);
    expect(store.knowledgeForRepo(repo).map((k) => `${k.kind}:${k.title}`).sort()).toEqual([
      'decision:pick redis',
      'decision:pick sqlite',
      'gotcha:pick sqlite',
    ]);
  });

  it('the same title in two repos stays two entries (repo is part of the identity)', () => {
    const other = path.join(workspace, 'other');
    store.saveKnowledge(repo, 'convention', 'run tests', 'npm test', []);
    store.saveKnowledge(other, 'convention', 'run tests', 'pytest -q', []);

    expect(store.countKnowledge()).toBe(2);
    expect(store.knowledgeForRepo(repo)[0]?.body).toBe('npm test');
    expect(store.knowledgeForRepo(other)[0]?.body).toBe('pytest -q');
  });

  it('search finds the updated body, not the replaced one (FTS stays in sync on upsert)', () => {
    store.saveKnowledge(repo, 'decision', 'pick sqlite', 'zero config local storage', []);
    store.saveKnowledge(repo, 'decision', 'pick sqlite', 'WAL mode with cluster search', []);

    expect(store.searchKnowledge('cluster', repo).map((k) => k.body)).toEqual([
      'WAL mode with cluster search',
    ]);
    expect(store.searchKnowledge('storage', repo)).toEqual([]);
  });

  it('recall returns the surviving entry exactly once', () => {
    const shared = path.join(workspace, 'shared.sqlite');
    const writer = new Store(shared);
    writer.saveKnowledge(repo, 'gotcha', 'sqlite locking', 'first note', []);
    writer.saveKnowledge(repo, 'gotcha', 'sqlite locking', 'second note', []);
    writer.close();

    // Both versions share the title, so a duplicate would surface as two hits here.
    const reader = new Engine(shared);
    try {
      const result = reader.recall('sqlite locking', repo);
      expect(result.knowledge).toHaveLength(1);
      expect(result.knowledge[0]?.body).toBe('second note');
    } finally {
      reader.close();
    }
  });
});

describe('knowledge — upsert edge cases', () => {
  it('re-recording identical content is a no-op, so recency never churns', async () => {
    const first = store.saveKnowledge(repo, 'lesson', 'no AST in v1', 'regex is enough', ['src/indexer']);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = store.saveKnowledge(repo, 'lesson', 'no AST in v1', 'regex is enough', ['src/indexer']);

    expect(again.updated).toBeUndefined();
    expect(again.updatedAt).toBe(first.updatedAt);
    expect(store.countKnowledge()).toBe(1);
  });

  it('changing only the anchors still overwrites the entry', () => {
    store.saveKnowledge(repo, 'gotcha', 'port clash', 'dev server on 5000', []);
    const bumped = store.saveKnowledge(repo, 'gotcha', 'port clash', 'dev server on 5000', ['src/app.py']);

    expect(bumped.updated).toBe(true);
    expect(store.knowledgeForRepo(repo)[0]?.anchors).toEqual(['src/app.py']);
  });

  it('rejects an empty title, an empty body and an unknown kind without writing', () => {
    expect(() => store.saveKnowledge(repo, 'decision', '   ', 'body', [])).toThrow(AegisxError);
    expect(() => store.saveKnowledge(repo, 'decision', 'title', '  ', [])).toThrow(AegisxError);
    expect(() => store.saveKnowledge(repo, 'rumour' as KnowledgeKind, 'title', 'body', [])).toThrow(AegisxError);
    expect(() => store.saveKnowledge(repo, 'decision', 'x'.repeat(201), 'body', [])).toThrow(AegisxError);
    expect(store.countKnowledge()).toBe(0);
  });

  it('migration: duplicates from a pre-upsert database collapse to the newest', () => {
    const legacy = path.join(workspace, 'legacy.sqlite');
    const raw = new DatabaseConstructor(legacy);
    raw.exec(`
      CREATE TABLE knowledge (
        id INTEGER PRIMARY KEY,
        repo TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        anchors TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
    `);
    const insert = raw.prepare(
      'INSERT INTO knowledge (repo, kind, title, body, anchors, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run(repo, 'decision', 'pick sqlite', 'old body', '[]', '2026-01-01T00:00:00.000Z');
    insert.run(repo, 'decision', 'pick sqlite', 'newer body', '[]', '2026-02-01T00:00:00.000Z');
    // a genuinely different identity must survive the collapse
    insert.run(repo, 'gotcha', 'port clash', 'dev server on 5000', '[]', '2026-01-15T00:00:00.000Z');
    raw.close();

    const migrated = new Store(legacy);
    try {
      const rows = migrated.knowledgeForRepo(repo);
      expect(rows).toHaveLength(2);
      const decision = rows.find((k) => k.kind === 'decision');
      expect(decision?.body).toBe('newer body');

      // and the unique index now keeps it that way
      migrated.saveKnowledge(repo, 'decision', 'pick sqlite', 'newest of all', []);
      expect(migrated.countKnowledge()).toBe(2);
      expect(migrated.knowledgeForRepo(repo).find((k) => k.kind === 'decision')?.body).toBe('newest of all');
    } finally {
      migrated.close();
    }
  });
});
