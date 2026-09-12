import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/core/engine.js';
import { normalizeRepoPath } from '../src/core/paths.js';
import { KNOWLEDGE_BACKFILL_META, KNOWLEDGE_TITLE_MAX, Store } from '../src/core/store.js';
import { AegisxError, type KnowledgeKind } from '../src/core/types.js';

/**
 * An obviously fake, token-shaped string, assembled from parts so that no
 * literal in this tree matches a credential pattern on its own: scanners (the
 * pre-push guard, GitHub's own) key on the pattern alone, which is exactly what
 * `containsSecret` is here to exercise.
 */
const FAKE_GITHUB_PAT = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';

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
  // A test that sets the allowlist must not leak it into the next one.
  delete process.env['AEGISX_ALLOWED_REPOS'];
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

describe('knowledge — the save path records handoff notes', () => {
  const handoff = (goal: string, decisions: string[]) => ({ goal, facts: [], decisions, nextSteps: [] });

  it('records each decision as a decision entry owned by that repo', () => {
    const engine = new Engine(dbFile);
    try {
      const summary = engine.saveSession(repo, handoff('harden auth', [
        'use scrypt for new password hashes',
        'keep the session in a signed cookie, not the database',
      ]));

      expect(summary).toEqual({ notesRecorded: 2, notesAlreadyKnown: 0 });
      const rows = store.knowledgeForRepo(normalizeRepoPath(repo));
      expect(rows.map((k) => k.kind)).toEqual(['decision', 'decision']);
      expect(rows.map((k) => k.title).sort()).toEqual([
        'keep the session in a signed cookie, not the database',
        'use scrypt for new password hashes',
      ]);
      // the sentence is its own body: it is one self-contained decision
      expect(rows.every((k) => k.body === k.title)).toBe(true);
    } finally {
      engine.close();
    }
  });

  it('re-recording a decision in a later handoff refreshes it instead of forking', () => {
    const engine = new Engine(dbFile);
    try {
      engine.saveSession(repo, handoff('first pass', ['pick sqlite over postgres']));
      const second = engine.saveSession(repo, handoff('second pass', ['pick sqlite over postgres']));

      // nothing new was learned, but the store still holds exactly one copy
      expect(second).toEqual({ notesRecorded: 0, notesAlreadyKnown: 1 });
      expect(store.countKnowledge()).toBe(1);
    } finally {
      engine.close();
    }
  });

  it('an identical re-save reports nothing new and cannot churn recency', () => {
    const engine = new Engine(dbFile);
    try {
      const same = handoff('keep it', ['leave the dev server on port 5000']);
      const first = engine.saveSession(repo, same);
      const again = engine.saveSession(repo, same);

      expect(first).toEqual({ notesRecorded: 1, notesAlreadyKnown: 0 });
      expect(again).toEqual({ notesRecorded: 0, notesAlreadyKnown: 1 });
      expect(store.countKnowledge()).toBe(1);
    } finally {
      engine.close();
    }
  });

  it('the same sentence twice inside one handoff records one entry', () => {
    const engine = new Engine(dbFile);
    try {
      const summary = engine.saveSession(repo, handoff('de-dupe', ['pin node 22', 'pin node 22']));
      expect(summary).toEqual({ notesRecorded: 1, notesAlreadyKnown: 1 });
      expect(store.countKnowledge()).toBe(1);
    } finally {
      engine.close();
    }
  });

  it('a handoff with no decisions writes nothing', () => {
    const engine = new Engine(dbFile);
    try {
      const summary = engine.saveSession(repo, handoff('just looking around', []));
      expect(summary).toEqual({ notesRecorded: 0, notesAlreadyKnown: 0 });
      expect(store.countKnowledge()).toBe(0);
    } finally {
      engine.close();
    }
  });

  it('the same decision in two repos stays two entries', () => {
    const other = path.join(workspace, 'other');
    const engine = new Engine(dbFile);
    try {
      engine.saveSession(repo, handoff('a', ['keep the WAL pragma on']));
      engine.saveSession(other, handoff('b', ['keep the WAL pragma on']));
      expect(store.countKnowledge()).toBe(2);
    } finally {
      engine.close();
    }
  });

  it('a decision longer than a title records anyway: title truncated, body whole', () => {
    const long = `${'refactor the billing pipeline '.repeat(12)}ENDMARKERQZX`;
    expect(long.length).toBeGreaterThan(KNOWLEDGE_TITLE_MAX);

    const engine = new Engine(dbFile);
    try {
      engine.saveSession(repo, handoff('long one', [long]));
      const row = store.knowledgeForRepo(normalizeRepoPath(repo))[0];
      expect(row?.title.length).toBeLessThanOrEqual(KNOWLEDGE_TITLE_MAX);
      expect(row?.title.endsWith('\u2026')).toBe(true);
      expect(row?.body).toBe(long);
      // the truncated-away tail stays searchable through the body
      engine.saveSession(repo, handoff('moved on', ['unrelated follow-up']));
      expect(engine.recall('ENDMARKERQZX', repo).knowledge).toHaveLength(1);
    } finally {
      engine.close();
    }
  });

  it('a handoff refused for secret hygiene writes neither handoff nor knowledge', () => {
    const engine = new Engine(dbFile);
    try {
      expect(() =>
        engine.saveSession(repo, handoff('leak', [`rotate ${FAKE_GITHUB_PAT}`])),
      ).toThrow(AegisxError);
      expect(store.countKnowledge()).toBe(0);
      expect(store.countSessions()).toBe(0);
    } finally {
      engine.close();
    }
  });

  it('prints a note once when the last handoff already carries it', () => {
    const sentence = 'pin the CI runner to ubuntu-22.04 until the ARM image lands';
    const engine = new Engine(dbFile);
    try {
      engine.saveSession(repo, handoff('ci', [sentence]));
      const markdown = engine.renderMarkdown(engine.recall('ci runner', repo));

      // the handoff is the newer copy of the same sentence, so it is the one kept
      expect(markdown).toContain(`Decisions:\n- ${sentence}`);
      expect(markdown).not.toContain('## Decisions, gotchas & conventions');
      expect(countOccurrences(markdown, sentence)).toBe(1);
      expect(engine.recall('ci runner', repo).knowledge.map((k) => k.title)).not.toContain(sentence);
    } finally {
      engine.close();
    }
  });

  it('shows a note from the knowledge store once a later handoff supersedes it', () => {
    const sentence = 'pin the CI runner to ubuntu-22.04 until the ARM image lands';
    const engine = new Engine(dbFile);
    try {
      engine.saveSession(repo, handoff('ci', [sentence]));
      engine.saveSession(repo, handoff('moved on', ['unrelated follow-up']));

      const markdown = engine.renderMarkdown(engine.recall('ci runner', repo));
      expect(markdown).toContain('## Decisions, gotchas & conventions');
      expect(markdown).toContain(`- (decision) ${sentence}`);
      // the title/body form would print the same sentence twice within the line
      expect(markdown).not.toContain('- (decision) **');
      expect(countOccurrences(markdown, sentence)).toBe(1);
    } finally {
      engine.close();
    }
  });

  it('dedupes a note whose title had to be truncated', () => {
    const long = `${'refactor the billing pipeline '.repeat(12)}ENDMARKERQZX`;
    expect(long.length).toBeGreaterThan(KNOWLEDGE_TITLE_MAX);
    const engine = new Engine(dbFile);
    try {
      engine.saveSession(repo, handoff('long one', [long]));

      // The store titles the entry with the sentence *clipped* to the title
      // limit, while the handoff reprints it whole. Keying the dedupe on the raw
      // sentence instead of the derived title would miss this pair and print the
      // decision twice — once as `**stem…** — sentence`, once in the handoff.
      const markdown = engine.renderMarkdown(engine.recall(null, repo));
      expect(markdown).toContain(`Decisions:\n- ${long}`);
      expect(markdown).not.toContain('## Decisions, gotchas & conventions');
      expect(countOccurrences(markdown, long)).toBe(1);
    } finally {
      engine.close();
    }
  });
});

/** How many times `needle` appears in `text`. A sentence printed twice is the
 *  bug the recall dedupe guards, and `toContain` cannot see the difference. */
function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** A database holding handoffs written before knowledge had a producer: the
 *  sessions table only, and no `meta` marker to say the backfill already ran. */
function writeLegacyHandoffs(
  file: string,
  rows: Array<{ repo: string; decisions: string; gotchas?: string; conventions?: string }>,
  options: { noteColumns?: boolean; marker?: string } = {},
): void {
  const raw = new DatabaseConstructor(file);
  const noteColumns = options.noteColumns === true;
  raw.exec(`
    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY,
      repo TEXT NOT NULL,
      goal TEXT NOT NULL,
      facts TEXT NOT NULL,
      decisions TEXT NOT NULL,
      ${noteColumns ? "gotchas TEXT NOT NULL DEFAULT '[]', conventions TEXT NOT NULL DEFAULT '[]'," : ''}
      next_steps TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const insert = raw.prepare(
    noteColumns
      ? 'INSERT INTO sessions (repo, goal, facts, decisions, gotchas, conventions, next_steps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      : 'INSERT INTO sessions (repo, goal, facts, decisions, next_steps, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  rows.forEach((row, index) => {
    const goal = `session ${index}`;
    const createdAt = `2026-01-0${index + 1}T00:00:00.000Z`;
    if (noteColumns) {
      insert.run(row.repo, goal, '[]', row.decisions, row.gotchas ?? '[]', row.conventions ?? '[]', '[]', createdAt);
    } else {
      insert.run(row.repo, goal, '[]', row.decisions, '[]', createdAt);
    }
  });
  if (options.marker !== undefined) {
    raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('knowledge-backfill', options.marker);
  }
  raw.close();
}

describe('knowledge — one-time backfill of handoffs written before knowledge had a producer', () => {
  it('folds their decisions into knowledge, collapsing repeats across handoffs', () => {
    const legacy = path.join(workspace, 'legacy-handoffs.sqlite');
    writeLegacyHandoffs(legacy, [
      { repo, decisions: JSON.stringify(['pick sqlite over postgres']) },
      { repo, decisions: JSON.stringify(['pick sqlite over postgres', 'keep WAL on']) },
    ]);

    const migrated = new Store(legacy);
    try {
      expect(migrated.knowledgeForRepo(repo).map((k) => k.title).sort()).toEqual([
        'keep WAL on',
        'pick sqlite over postgres',
      ]);
      expect(migrated.knowledgeForRepo(repo).every((k) => k.kind === 'decision')).toBe(true);
      expect(JSON.parse(migrated.getMeta(KNOWLEDGE_BACKFILL_META) ?? '{}')).toMatchObject({
        sessions: 2,
        recorded: 2,
        alreadyKnown: 1,
        skippedSecrets: 0,
      });
    } finally {
      migrated.close();
    }

    // the marker makes it once-only: reopening must not duplicate or re-scan
    const reopened = new Store(legacy);
    try {
      expect(reopened.countKnowledge()).toBe(2);
      expect(reopened.countSessions()).toBe(2);
    } finally {
      reopened.close();
    }
  });

  it('does not resurrect a credential from a handoff written before the secret scan', () => {
    const legacy = path.join(workspace, 'legacy-secret.sqlite');
    writeLegacyHandoffs(legacy, [
      { repo, decisions: JSON.stringify([`rotate ${FAKE_GITHUB_PAT}`, 'keep WAL on']) },
    ]);

    const migrated = new Store(legacy);
    try {
      expect(migrated.knowledgeForRepo(repo).map((k) => k.title)).toEqual(['keep WAL on']);
      expect(JSON.parse(migrated.getMeta(KNOWLEDGE_BACKFILL_META) ?? '{}')).toMatchObject({
        recorded: 1,
        skippedSecrets: 1,
      });
    } finally {
      migrated.close();
    }
  });

  it('opens anyway when a legacy row holds a mangled decisions column', () => {
    const legacy = path.join(workspace, 'legacy-mangled.sqlite');
    writeLegacyHandoffs(legacy, [{ repo, decisions: 'not json at all' }]);

    const migrated = new Store(legacy);
    try {
      expect(migrated.countKnowledge()).toBe(0);
      expect(JSON.parse(migrated.getMeta(KNOWLEDGE_BACKFILL_META) ?? '{}')).toMatchObject({ sessions: 1, recorded: 0 });
    } finally {
      migrated.close();
    }
  });

  it('keeps each repo\'s decisions under that repo', () => {
    const other = path.join(workspace, 'other-backfill');
    const legacy = path.join(workspace, 'legacy-two-repos.sqlite');
    writeLegacyHandoffs(legacy, [
      { repo, decisions: JSON.stringify(['alpha decision']) },
      { repo: other, decisions: JSON.stringify(['beta decision']) },
    ]);

    const migrated = new Store(legacy);
    try {
      expect(migrated.knowledgeForRepo(repo).map((k) => k.title)).toEqual(['alpha decision']);
      expect(migrated.knowledgeForRepo(other).map((k) => k.title)).toEqual(['beta decision']);
    } finally {
      migrated.close();
    }
  });

  it('adds the newer handoff columns to a database that predates them', () => {
    const legacy = path.join(workspace, 'legacy-columns.sqlite');
    writeLegacyHandoffs(legacy, [{ repo, decisions: JSON.stringify(['pick sqlite over postgres']) }]);

    const migrated = new Store(legacy);
    try {
      // both reads would throw "no such column" without the ALTER
      expect(migrated.lastSession(repo)?.gotchas).toEqual([]);
      expect(migrated.recentSessions()[0]?.conventions).toBe(0);
      expect(migrated.knowledgeForRepo(repo).map((k) => k.title)).toEqual(['pick sqlite over postgres']);
    } finally {
      migrated.close();
    }
  });

  it('re-scans when the marker came from an older backfill version', () => {
    const legacy = path.join(workspace, 'legacy-old-marker.sqlite');
    writeLegacyHandoffs(
      legacy,
      [
        {
          repo,
          decisions: JSON.stringify(['pick sqlite over postgres']),
          gotchas: JSON.stringify(['WAL needs a busy timeout']),
          conventions: JSON.stringify(['four spaces in TS']),
        },
      ],
      {
        noteColumns: true,
        // what the previous backfill wrote: decisions only, and no `version`
        marker: JSON.stringify({ sessions: 1, recorded: 1, alreadyKnown: 0, skippedSecrets: 0, at: '2026-09-12T00:00:00.000Z' }),
      },
    );
    const seed = new DatabaseConstructor(legacy);
    seed.exec(`CREATE TABLE knowledge (
      id INTEGER PRIMARY KEY, repo TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, anchors TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
    )`);
    seed
      .prepare('INSERT INTO knowledge (repo, kind, title, body, anchors, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(repo, 'decision', 'pick sqlite over postgres', 'pick sqlite over postgres', '[]', '2026-09-12T00:00:00.000Z');
    seed.close();

    const migrated = new Store(legacy);
    try {
      expect(migrated.knowledgeForRepo(repo).map((k) => k.kind).sort()).toEqual([
        'convention',
        'decision',
        'gotcha',
      ]);
      // the decision was already there; only the two newer lists are new
      expect(JSON.parse(migrated.getMeta(KNOWLEDGE_BACKFILL_META) ?? '{}')).toMatchObject({
        version: 2,
        recorded: 2,
        alreadyKnown: 1,
      });
    } finally {
      migrated.close();
    }
  });
});

describe('knowledge — gotchas and conventions are their own kinds', () => {
  const notes = (goal: string, extra: { gotchas?: string[]; conventions?: string[] }) => ({
    goal,
    facts: [],
    decisions: [],
    nextSteps: [],
    ...extra,
  });

  it('records each note list under its own kind', () => {
    const engine = new Engine(dbFile);
    try {
      const summary = engine.saveSession(repo, {
        goal: 'harden auth',
        facts: [],
        decisions: ['use scrypt for new password hashes'],
        gotchas: ['sqlite locking bites without a busy timeout', 'scrypt is slow on the CI runner'],
        conventions: ['two-space indent in Python, four in TypeScript'],
        nextSteps: [],
      });
      expect(summary).toEqual({ notesRecorded: 4, notesAlreadyKnown: 0 });
      expect(store.knowledgeForRepo(normalizeRepoPath(repo)).map((k) => k.kind).sort()).toEqual([
        'convention',
        'decision',
        'gotcha',
        'gotcha',
      ]);
    } finally {
      engine.close();
    }
  });

  it('round-trips them through the handoff so resume shows them', () => {
    const engine = new Engine(dbFile);
    try {
      engine.saveSession(repo, notes('g', { gotchas: ['watch the port clash'], conventions: ['run the linter'] }));
      const session = engine.recall(null, repo).lastSession;
      expect(session?.gotchas).toEqual(['watch the port clash']);
      expect(session?.conventions).toEqual(['run the linter']);

      const markdown = engine.renderMarkdown(engine.recall(null, repo));
      expect(markdown).toContain('Gotchas:\n- watch the port clash');
      expect(markdown).toContain('Conventions:\n- run the linter');
      // this handoff reprints them itself, so the notes block is skipped and each
      // sentence is printed once instead of twice
      expect(markdown).not.toContain('## Decisions, gotchas & conventions');
      expect(countOccurrences(markdown, 'watch the port clash')).toBe(1);
      expect(countOccurrences(markdown, 'run the linter')).toBe(1);
    } finally {
      engine.close();
    }
  });

  it('still accepts a handoff that only knows the original four fields', () => {
    const engine = new Engine(dbFile);
    try {
      const summary = engine.saveSession(repo, { goal: 'g', facts: ['f'], decisions: ['d'], nextSteps: ['n'] });
      expect(summary).toEqual({ notesRecorded: 1, notesAlreadyKnown: 0 });
      const session = engine.recall(null, repo).lastSession;
      expect(session?.gotchas).toEqual([]);
      expect(session?.conventions).toEqual([]);
    } finally {
      engine.close();
    }
  });

  it('refuses a secret in a gotcha exactly like one in a decision', () => {
    const engine = new Engine(dbFile);
    try {
      expect(() =>
        engine.saveSession(repo, notes('leak', { gotchas: ['the key is sk-abcdefghij0123456789abcdefghij'] })),
      ).toThrow(AegisxError);
      expect(store.countKnowledge()).toBe(0);
      expect(store.countSessions()).toBe(0);
    } finally {
      engine.close();
    }
  });
});

describe('recall — a query-less recall is repo-anchored, not path-seeded', () => {
  it('returns this repo\'s own facts and decisions', () => {
    const engine = new Engine(dbFile);
    try {
      engine.remember('project.demo.test-cmd', 'python3 -m pytest -q', repo);
      engine.saveSession(repo, {
        goal: 'harden auth',
        facts: [],
        decisions: ['keep WAL on for concurrent readers'],
        nextSteps: [],
      });
      // a later handoff takes the "last session" slot, so the decision is served
      // from the knowledge store instead of being reprinted by the handoff
      engine.saveSession(repo, { goal: 'next session', facts: [], decisions: [], nextSteps: [] });

      const result = engine.recall(null, repo);
      expect(result.facts.map((f) => f.key)).toContain('project.demo.test-cmd');
      expect(result.knowledge.map((k) => k.body)).toEqual(['keep WAL on for concurrent readers']);
    } finally {
      engine.close();
    }
  });

  it('does not report another repo\'s facts that name this repo\'s path', () => {
    const repoA = path.join(workspace, 'alpha');
    const repoB = path.join(workspace, 'beta');
    const engine = new Engine(dbFile);
    try {
      // Fact search is *not* repo-scoped in SQL, so seeding FTS with alpha's
      // path (what a query-less recall used to do) matched beta's fact whenever
      // that fact named the same path — a cross-project answer to a
      // repo-scoped question.
      engine.remember('project.beta.compare', `diff against ${repoA} before merging`, repoB);
      engine.saveSession(repoB, {
        goal: 'beta work',
        facts: [],
        decisions: [`reuse the auth module from ${repoA}`],
        nextSteps: [],
      });
      // sanity: both rows exist, so the assertions below mean something
      expect(store.countFacts()).toBe(1);
      expect(store.countKnowledge()).toBe(1);

      const result = engine.recall(null, repoA);
      // facts are the leak this guards; knowledge was already repo-scoped in SQL
      expect(result.facts).toEqual([]);
      expect(result.knowledge).toEqual([]);
      expect(result.lastSession).toBeUndefined();
    } finally {
      engine.close();
    }
  });

  it('still ranks this repo\'s knowledge when the recall carries a query', () => {
    const engine = new Engine(dbFile);
    try {
      engine.saveSession(repo, {
        goal: 'harden auth',
        facts: [],
        decisions: ['keep WAL on for concurrent readers'],
        nextSteps: [],
      });
      engine.saveSession(repo, { goal: 'next session', facts: [], decisions: [], nextSteps: [] });

      expect(engine.recall('WAL concurrent', repo).knowledge).toHaveLength(1);
    } finally {
      engine.close();
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

describe('knowledge — browsing, filtering and deletion', () => {
  const repoNorm = (): string => normalizeRepoPath(repo);

  const otherRepo = (): string => {
    const dir = path.join(workspace, 'other');
    fs.mkdirSync(dir, { recursive: true });
    return normalizeRepoPath(dir);
  };

  it('lists across repos newest-first and carries the id the CLI deletes by', () => {
    const other = otherRepo();
    store.saveKnowledge(repoNorm(), 'decision', 'pick sqlite', 'first body', []);
    store.saveKnowledge(other, 'gotcha', 'port clash', 'second body', []);

    const rows = store.knowledgeList({});
    expect(rows.map((r) => r.title)).toEqual(['port clash', 'pick sqlite']);
    expect(rows.every((r) => typeof r.id === 'number')).toBe(true);

    // the id travels on every read path, which is what --forget keys on
    expect(store.knowledgeForRepo(repoNorm()).every((r) => typeof r.id === 'number')).toBe(true);
    expect(store.searchKnowledge('first body', null).every((r) => typeof r.id === 'number')).toBe(true);
    expect(store.listKnowledge().every((r) => typeof r.id === 'number')).toBe(true);
  });

  it('filters by kind and by repo, and combines the two', () => {
    const other = otherRepo();
    store.saveKnowledge(repoNorm(), 'decision', 'pick sqlite', 'a', []);
    store.saveKnowledge(repoNorm(), 'gotcha', 'port clash', 'b', []);
    store.saveKnowledge(other, 'decision', 'pick postgres', 'c', []);

    expect(store.knowledgeList({ kind: 'decision' }).map((r) => r.title).sort()).toEqual(['pick postgres', 'pick sqlite']);
    expect(store.knowledgeList({ repo: repoNorm() }).map((r) => r.title).sort()).toEqual(['pick sqlite', 'port clash']);
    expect(store.knowledgeList({ repo: repoNorm(), kind: 'gotcha' }).map((r) => r.title)).toEqual(['port clash']);
    expect(store.knowledgeList({ limit: 1 })).toHaveLength(1);
  });

  it('matches a query in the title or the body, and answers nothing for unsearchable input', () => {
    store.saveKnowledge(repoNorm(), 'decision', 'pick sqlite', 'zero-config local storage', []);
    store.saveKnowledge(repoNorm(), 'convention', 'two-space indent', 'sqlite has nothing to do with it', []);

    expect(store.knowledgeList({ query: 'sqlite' })).toHaveLength(2);
    expect(store.knowledgeList({ query: 'zero-config' }).map((r) => r.title)).toEqual(['pick sqlite']);
    // punctuation-only input must not degrade into "list everything"
    expect(store.knowledgeList({ query: '!!!' })).toEqual([]);
  });

  it('deletes one entry by id, and the FTS index stops matching it at once', () => {
    store.saveKnowledge(repoNorm(), 'decision', 'pick sqlite', 'zero-config', []);
    store.saveKnowledge(repoNorm(), 'gotcha', 'port clash', 'dev server on 5000', []);
    const target = store.knowledgeList({ query: 'sqlite' })[0];
    expect(target?.id).toBeDefined();

    expect(store.forgetKnowledge(target!.id!)).toBe(true);
    expect(store.countKnowledge()).toBe(1);
    expect(store.searchKnowledge('sqlite', null)).toEqual([]);
    expect(store.knowledgeList({}).map((r) => r.title)).toEqual(['port clash']);
    // deleting the same id twice is a no-op, not an error
    expect(store.forgetKnowledge(target!.id!)).toBe(false);
  });

  it('reports the owning repo of an id, and nothing for an unknown one', () => {
    const saved = store.saveKnowledge(repoNorm(), 'decision', 'pick sqlite', 'a', []);
    expect(saved.id).toBeTypeOf('number');
    expect(store.knowledgeRepoOf(saved.id!)).toBe(repoNorm());
    expect(store.knowledgeRepoOf(999_999)).toBeUndefined();
  });
});

describe('knowledge — the engine browse surface', () => {
  const note = (goal: string, decisions: string[], gotchas: string[] = [], conventions: string[] = []) =>
    ({ goal, facts: [], decisions, gotchas, conventions, nextSteps: [] });

  it('lists every repo, then one repo, then one kind', () => {
    const other = path.join(workspace, 'other');
    fs.mkdirSync(other, { recursive: true });
    const engine = new Engine(dbFile);
    try {
      engine.saveSession(repo, note('a', ['pick sqlite']));
      engine.saveSession(other, note('b', ['pick postgres'], ['port clash']));

      expect(engine.listKnowledge().map((k) => k.title).sort()).toEqual(['pick postgres', 'pick sqlite', 'port clash']);
      expect(engine.listKnowledge({ repoAbsPath: repo }).map((k) => k.title)).toEqual(['pick sqlite']);
      expect(engine.listKnowledge({ kind: 'gotcha' }).map((k) => k.title)).toEqual(['port clash']);
      expect(engine.listKnowledge({ repoAbsPath: repo, kind: 'gotcha' })).toEqual([]);
    } finally {
      engine.close();
    }
  });

  it('rejects an empty query, and answers nothing for one that cannot match', () => {
    const engine = new Engine(dbFile);
    try {
      // whitespace yields no FTS clause at all — a user error, like recall
      expect(() => engine.listKnowledge({ query: '   ' })).toThrow(AegisxError);
      // punctuation builds a clause that matches nothing: empty, not an error
      expect(engine.listKnowledge({ query: '!!!' })).toEqual([]);
      expect(engine.listKnowledge({ query: 'sqlite' })).toEqual([]);
    } finally {
      engine.close();
    }
  });

  it('keeps the allowlist door shut for reading and for deleting', () => {
    const hidden = path.join(workspace, 'hidden');
    fs.mkdirSync(hidden, { recursive: true });
    const hiddenEntry = store.saveKnowledge(normalizeRepoPath(hidden), 'decision', 'hidden note', 'body', []);
    const visibleEntry = store.saveKnowledge(normalizeRepoPath(repo), 'decision', 'visible note', 'body', []);

    process.env['AEGISX_ALLOWED_REPOS'] = normalizeRepoPath(repo);
    const engine = new Engine(dbFile);
    try {
      expect(engine.listKnowledge().map((k) => k.title)).toEqual(['visible note']);
      expect(() => engine.forgetKnowledge(hiddenEntry.id!)).toThrow(AegisxError);
      expect(store.countKnowledge()).toBe(2); // the hidden row survived the refusal
      expect(engine.forgetKnowledge(visibleEntry.id!)).toBe(true);
      expect(engine.forgetKnowledge(999_999)).toBe(false);
    } finally {
      engine.close();
    }
  });
});

describe('export — whole-memory dump', () => {
  const handoff = (goal: string, facts: string[], decisions: string[], gotchas: string[], conventions: string[], nextSteps: string[]) =>
    ({ goal, facts, decisions, gotchas, conventions, nextSteps });

  it('includes repos, facts, knowledge and full handoffs, with counts that match the lists', () => {
    const engine = new Engine(dbFile);
    try {
      engine.remember('project.demo.stack', 'flask', repo);
      engine.saveSession(repo, handoff(
        'ship the demo', ['one fact'], ['pick sqlite'], ['port clash'], ['two-space indent'], ['write tests'],
      ));

      const dump = engine.exportMemory();
      expect(dump.totals).toEqual({ repos: 1, facts: 1, knowledge: 3, sessions: 1 });
      expect(dump.facts.map((f) => f.key)).toEqual(['project.demo.stack']);
      expect(dump.knowledge.map((k) => k.title).sort()).toEqual(['pick sqlite', 'port clash', 'two-space indent']);
      expect(dump.repos[0]?.repo).toBe(normalizeRepoPath(repo));
      // the handoff travels with its lists, not just its counts
      expect(dump.sessions[0]?.goal).toBe('ship the demo');
      expect(dump.sessions[0]?.decisions).toEqual(['pick sqlite']);
      expect(dump.sessions[0]?.nextSteps).toEqual(['write tests']);
      expect(dump.rowLimit).toBeGreaterThan(0);
      expect(Date.parse(dump.generatedAt)).not.toBeNaN();
    } finally {
      engine.close();
    }
  });

  it('never exports a repo the allowlist hides', () => {
    const hidden = path.join(workspace, 'hidden');
    fs.mkdirSync(hidden, { recursive: true });
    store.saveKnowledge(normalizeRepoPath(hidden), 'decision', 'hidden note', 'body', []);
    store.saveSession(normalizeRepoPath(repo), handoff('visible work', [], [], [], [], []));

    process.env['AEGISX_ALLOWED_REPOS'] = normalizeRepoPath(repo);
    const engine = new Engine(dbFile);
    try {
      const dump = engine.exportMemory();
      expect(dump.repos.map((r) => r.repo)).toEqual([normalizeRepoPath(repo)]);
      expect(dump.knowledge).toEqual([]);
      expect(dump.sessions.map((s) => s.goal)).toEqual(['visible work']);
      expect(dump.totals).toEqual({ repos: 1, facts: 0, knowledge: 0, sessions: 1 });
    } finally {
      engine.close();
    }
  });

  it('scopes to one repo on request, leaving global facts out of a scoped dump', () => {
    const other = path.join(workspace, 'other');
    fs.mkdirSync(other, { recursive: true });
    const engine = new Engine(dbFile);
    try {
      engine.remember('project.global.up', 'x', null); // no repo hint: belongs to no repo
      engine.remember('project.here.stack', 'flask', repo);
      engine.remember('project.there.stack', 'django', other);

      const scoped = engine.exportMemory(repo);
      expect(scoped.facts.map((f) => f.key)).toEqual(['project.here.stack']);
      expect(scoped.repos.map((r) => r.repo)).toEqual([normalizeRepoPath(repo)]);

      const full = engine.exportMemory();
      expect(full.facts.map((f) => f.key).sort()).toEqual([
        'project.global.up',
        'project.here.stack',
        'project.there.stack',
      ]);
    } finally {
      engine.close();
    }
  });
});

describe('knowledge — one repo’s whole page (the dashboard memory browser)', () => {
  it('returns that repo’s knowledge, facts and handoffs, with true totals beside capped lists', () => {
    const other = path.join(workspace, 'other');
    fs.mkdirSync(other);
    const engine = new Engine(dbFile);
    try {
      engine.remember('project.here.stack', 'node', repo);
      engine.remember('project.there.stack', 'go', other);
      engine.remember('project.global.up', 'no repo hint', null);
      for (let i = 0; i < 5; i++) { store.saveKnowledge(repo, 'gotcha', `trap ${String(i)}`, `body ${String(i)}`, []); }
      store.saveKnowledge(other, 'gotcha', 'other trap', 'other body', []);
      engine.saveSession(repo, { goal: 'here', facts: [], decisions: [], nextSteps: [] });
      engine.saveSession(other, { goal: 'there', facts: [], decisions: [], nextSteps: [] });

      const page = engine.repoMemory(repo);
      expect(page.repo).toBe(normalizeRepoPath(repo));
      expect(page.counts).toEqual({ facts: 1, knowledge: 5, sessions: 1 });
      expect(page.knowledge).toHaveLength(5);
      expect(page.knowledge.every((k) => typeof k.id === 'number' && k.repo === normalizeRepoPath(repo))).toBe(true);
      // repo-scoped: another repo's rows, and the repo-less global fact, stay out
      expect(page.facts.map((f) => f.key)).toEqual(['project.here.stack']);
      expect(page.sessions.map((s) => s.goal)).toEqual(['here']);

      // A cap cuts the rows, never the totals — the page must be able to say so.
      const capped = engine.repoMemory(repo, 2);
      expect(capped.knowledge).toHaveLength(2);
      expect(capped.counts.knowledge).toBe(5);
      // newest first, so the cap keeps the most recent entries
      expect(capped.knowledge.map((k) => k.id)).toEqual(page.knowledge.slice(0, 2).map((k) => k.id));
    } finally {
      engine.close();
    }
  });

  it('countKnowledge follows exactly the filters of the listing it caps', () => {
    const other = path.join(workspace, 'other-counts');
    fs.mkdirSync(other);
    const engine = new Engine(dbFile);
    try {
      store.saveKnowledge(repo, 'decision', 'd1', 'body', []);
      store.saveKnowledge(repo, 'decision', 'd2', 'body', []);
      store.saveKnowledge(repo, 'gotcha', 'g1', 'body', []);
      store.saveKnowledge(other, 'gotcha', 'g2', 'body', []);

      expect(engine.countKnowledge()).toBe(4);
      expect(engine.countKnowledge({ kind: 'decision' })).toBe(2);
      expect(engine.countKnowledge({ repoAbsPath: repo })).toBe(3);
      expect(engine.countKnowledge({ repoAbsPath: repo, kind: 'gotcha' })).toBe(1);
      expect(engine.countKnowledge({ query: 'g1' })).toBe(1);

      // The total is the listing's size, not the table's: that is the whole
      // point of showing it beside a capped list.
      for (const filters of [{}, { repoAbsPath: repo }, { kind: 'decision' as const }]) {
        const listed = engine.listKnowledge({ ...filters, limit: 1_000 });
        expect(engine.countKnowledge(filters)).toBe(listed.length);
      }
      const capped = engine.listKnowledge({ repoAbsPath: repo, limit: 2 });
      expect(capped).toHaveLength(2);
      expect(engine.countKnowledge({ repoAbsPath: repo })).toBe(3);

      // An empty query stays a user error, the same contract as the listing.
      expect(() => engine.countKnowledge({ query: '   ' })).toThrow(/no searchable terms/);
    } finally {
      engine.close();
    }
  });

  it('repoMemorySummaries reports repoMemory’s numbers, and hides what the policy hides', () => {
    const other = path.join(workspace, 'other-summary');
    fs.mkdirSync(other);
    const engine = new Engine(dbFile);
    try {
      store.saveKnowledge(repo, 'decision', 'here one', 'body', []);
      store.saveKnowledge(repo, 'decision', 'here two', 'body', []);
      store.saveKnowledge(other, 'decision', 'there', 'body', []);

      const summaries = engine.repoMemorySummaries();
      // largest first
      expect(summaries.map((entry) => entry.repo)).toEqual([normalizeRepoPath(repo), normalizeRepoPath(other)]);
      // one source of truth: the summary cannot drift from the page's numbers
      for (const entry of summaries) {
        expect(entry.counts).toEqual(engine.repoMemory(entry.repo).counts);
      }
      expect(summaries[0]!.counts.knowledge).toBe(2);
    } finally {
      engine.close();
    }

    process.env['AEGISX_ALLOWED_REPOS'] = repo;
    const gated = new Engine(dbFile);
    try {
      const visible = gated.repoMemorySummaries();
      expect(visible.map((entry) => entry.repo)).toEqual([normalizeRepoPath(repo)]);
      expect(visible[0]!.counts.knowledge).toBe(2);
    } finally {
      gated.close();
    }
  });

  it('refuses a repo the allowlist hides instead of answering with an empty page', () => {
    store.saveKnowledge(repo, 'decision', 'visible decision', 'visible body', []);
    const hidden = path.join(workspace, 'hidden');
    fs.mkdirSync(hidden);
    store.saveKnowledge(hidden, 'decision', 'hidden decision', 'hidden body', []);

    process.env['AEGISX_ALLOWED_REPOS'] = repo;
    const engine = new Engine(dbFile);
    try {
      expect(engine.repoMemory(repo).counts.knowledge).toBe(1);
      expect(() => engine.repoMemory(hidden)).toThrow(/not in AEGISX_ALLOWED_REPOS/);
    } finally {
      engine.close();
    }
  });
});
