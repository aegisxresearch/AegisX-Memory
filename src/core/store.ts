/**
 * Store: SQLite persistence for FactStore / Knowledge / Sessions / Meta.
 * Files and symbols live in the Indexer's own tables (same DB, separate module).
 */
import DatabaseConstructor from 'better-sqlite3';
import type { Database as DatabaseType, Statement, RunResult } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {
  AegisxError,
  type FactHistoryEntry,
  type KnowledgeKind,
  type KnowledgeRecord,
  type MemoryFact,
  type SessionHandoff,
  type SessionSaveSummary,
} from './types.js';
import { buildFtsQuery } from './fts.js';
import { secureDbFile } from './db-perms.js';
import { containsSecret } from './secrets.js';

/** Fact values above this length are truncated, never rejected — a failed
 *  remember() burns an agent turn; a slightly-shortened value does not.
 *  Kept well above typical hand-authored facts, far below bloat. */
export const FACT_VALUE_MAX = 2_000;
export const FACT_VALUE_WARN = 500;
export const KNOWLEDGE_TITLE_MAX = 200;
export const KNOWLEDGE_BODY_MAX = 4_000;
export const HANDOFF_STRING_MAX = 1_000;
export const HANDOFF_ARRAY_MAX = 20;
/** Superseded values kept per fact key — enough to see a trend, bounded forever. */
export const FACT_HISTORY_MAX = 10;
/** Telemetry retention window (ISO timestamps compare lexicographically). */
export const TELEMETRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** `meta` key recording the one-time backfill of pre-v1.13 handoff decisions. */
export const KNOWLEDGE_BACKFILL_META = 'knowledge-backfill';

/**
 * Derive a knowledge title from a free-form sentence (a handoff decision line),
 * guaranteed to satisfy `KNOWLEDGE_TITLE_MAX`.
 *
 * A decision is one self-contained sentence with no separate heading, so the
 * sentence *is* the title — truncated only when it is longer than a title can
 * be. Truncation is deterministic, so the same long sentence keeps the same
 * identity across sessions and still upserts onto itself instead of forking.
 */
export function knowledgeTitle(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= KNOWLEDGE_TITLE_MAX
    ? trimmed
    : `${trimmed.slice(0, KNOWLEDGE_TITLE_MAX - 1).trimEnd()}\u2026`;
}

/** Row shape shared by every fact read that decorates in the previous value. */
interface FactRow {
  key: string;
  value: string;
  repo_hint: string | null;
  updated_at: string;
  previous_value?: string | null;
}

/** Row shape of the fact_history table. */
interface HistoryRow {
  key: string;
  value: string;
  repo_hint: string | null;
  replaced_at: string;
}

/** Most recent superseded value for a key — the only history recall needs. */
const PREVIOUS_VALUE_SQL = `(SELECT h.value FROM fact_history h
   WHERE h.key = f.key ORDER BY h.replaced_at DESC, h.id DESC LIMIT 1)`;

export class Store {
  private readonly db: DatabaseType;
  private readonly stmtCache = new Map<string, Statement>();

  constructor(dbFile: string) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
    this.db = new DatabaseConstructor(dbFile);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    // Owner-only file mode (best effort — e.g. chmod may be unsupported on
    // some filesystems; SQLite created the file with restrictive umask anyway).
    secureDbFile(dbFile);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        repo_hint TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        value, key, content='facts', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, value, key) VALUES (new.id, new.value, new.key);
      END;
      CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, value, key)
          VALUES ('delete', old.id, old.value, old.key);
      END;
      CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, value, key)
          VALUES ('delete', old.id, old.value, old.key);
        INSERT INTO facts_fts(rowid, value, key) VALUES (new.id, new.value, new.key);
      END;

      CREATE TABLE IF NOT EXISTS knowledge (
        id INTEGER PRIMARY KEY,
        repo TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('decision','gotcha','convention','lesson')),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        anchors TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        title, body, content='knowledge', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
        INSERT INTO knowledge_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body)
          VALUES ('delete', old.id, old.title, old.body);
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body)
          VALUES ('delete', old.id, old.title, old.body);
        INSERT INTO knowledge_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
      END;

      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY,
        repo TEXT NOT NULL,
        goal TEXT NOT NULL,
        facts TEXT NOT NULL,
        decisions TEXT NOT NULL,
        next_steps TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo, created_at DESC);

      CREATE TABLE IF NOT EXISTS fact_history (
        id INTEGER PRIMARY KEY,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        repo_hint TEXT,
        replaced_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fact_history_key ON fact_history(key, replaced_at DESC);

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scan_runs (
        id INTEGER PRIMARY KEY,
        repo TEXT NOT NULL,
        files_total INTEGER NOT NULL,
        files_changed INTEGER NOT NULL,
        files_deleted INTEGER NOT NULL,
        files_skipped INTEGER NOT NULL,
        symbols_total INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scan_runs_repo ON scan_runs(repo, created_at DESC);

      CREATE TABLE IF NOT EXISTS recall_runs (
        id INTEGER PRIMARY KEY,
        repo TEXT NOT NULL,
        query TEXT,
        token_estimate INTEGER NOT NULL,
        facts_hit INTEGER NOT NULL,
        symbols_hit INTEGER NOT NULL,
        knowledge_hit INTEGER NOT NULL,
        hit INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recall_runs_repo ON recall_runs(repo, created_at DESC);
    `);
    // Knowledge is identified by (repo, kind, title). Databases written before
    // that rule can hold duplicates, so collapse them (keep the newest — id order
    // tracks write order) before the unique index starts enforcing it.
    //
    // Order matters twice over: the dedupe is skipped when there is nothing to
    // collapse (the common case), and when it does run the FTS index is rebuilt
    // first. `knowledge_fts` is an external-content table, so a legacy DB may
    // hold rows the index never saw; deleting one of those makes FTS5 report a
    // malformed image rather than deleting cleanly.
    const duplicateGroups = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT repo, kind, title FROM knowledge GROUP BY repo, kind, title HAVING COUNT(*) > 1
         )`,
      )
      .get() as { n: number };
    if (duplicateGroups.n > 0) {
      this.db.exec(`INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild');`);
      this.db.exec(`
        DELETE FROM knowledge WHERE id NOT IN (
          SELECT MAX(id) FROM knowledge GROUP BY repo, kind, title
        );
      `);
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_identity ON knowledge(repo, kind, title);`);
    this.backfillKnowledgeFromHandoffs();
  }

  /**
   * One-time: fold the decisions of handoffs written *before* knowledge had a
   * producer (RFC v1.13) into the knowledge store.
   *
   * Those sessions are the only record of the decisions taken back then, so
   * without this a repo's "Decisions & gotchas" block and its graph would show
   * only what happened after the upgrade. Notes go through the same upsert as a
   * live save, so one sentence repeated across handoffs collapses into a single
   * entry and re-running the scan changes nothing; a `meta` marker keeps the
   * scan to once per database.
   */
  private backfillKnowledgeFromHandoffs(): void {
    if (this.getMeta(KNOWLEDGE_BACKFILL_META) !== undefined) {
      return;
    }
    const rows = this.prepared('SELECT repo, decisions FROM sessions ORDER BY id').all() as Array<{
      repo: string;
      decisions: string;
    }>;
    let recorded = 0;
    let alreadyKnown = 0;
    let skippedSecrets = 0;
    for (const row of rows) {
      const notes: string[] = [];
      for (const note of parseStringArray(row.decisions)) {
        // Rows written before the storage-time secret scan existed (RFC v1.2)
        // can still hold a credential; copying one into a new table would
        // re-publish exactly what that scan was added to keep out.
        if (containsSecret(note)) {
          skippedSecrets += 1;
          continue;
        }
        notes.push(note);
      }
      const summary = this.recordHandoffNotes(row.repo, notes);
      recorded += summary.decisionsRecorded;
      alreadyKnown += summary.decisionsAlreadyKnown;
    }
    this.setMeta(
      KNOWLEDGE_BACKFILL_META,
      JSON.stringify({ sessions: rows.length, recorded, alreadyKnown, skippedSecrets, at: new Date().toISOString() }),
    );
  }

  private prepared(sql: string): Statement {
    const cached = this.stmtCache.get(sql);
    if (cached !== undefined) {
      return cached;
    }
    const stmt = this.db.prepare(sql);
    this.stmtCache.set(sql, stmt);
    return stmt;
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- facts

  validateKey(key: string): string {
    if (!KEY_PATTERN.test(key)) {
      throw new AegisxError(
        'user',
        `invalid key "${key}": must match ${KEY_PATTERN.source} (lowercase letters, digits, dot, underscore, hyphen)`,
      );
    }
    return key;
  }

  validateValue(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new AegisxError('user', 'fact value must not be empty');
    }
    if (trimmed.length > FACT_VALUE_MAX) {
      // Truncate instead of rejecting: the agent already spent a turn on the
      // call, and a shortened fact is still useful. The kept part is the head;
      // the cut is logged on stderr (recall/JSON paths keep it silent).
      const cut = trimmed.length - FACT_VALUE_MAX;
      process.stderr.write(`aegisxmemory: fact value truncated (${cut} chars over ${FACT_VALUE_MAX} limit)\n`);
      return trimmed.slice(0, FACT_VALUE_MAX);
    }
    return trimmed;
  }

  private toFact(row: FactRow): MemoryFact {
    const fact: MemoryFact = {
      key: row.key,
      value: row.value,
      repoHint: row.repo_hint,
      updatedAt: row.updated_at,
    };
    if (row.previous_value !== null && row.previous_value !== undefined) {
      fact.previousValue = row.previous_value;
    }
    return fact;
  }

  rememberFact(key: string, value: string, repoHint: string | null): MemoryFact {
    this.validateKey(key);
    const clean = this.validateValue(value);
    const now = new Date().toISOString();
    const existing = this.prepared('SELECT value FROM facts WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    // Only a real value change becomes history: agents re-pin the same fact every
    // session, and that repetition must not fill the timeline with noise.
    const superseded = existing !== undefined && existing.value !== clean ? existing.value : null;
    if (superseded !== null) {
      this.prepared(
        'INSERT INTO fact_history (key, value, repo_hint, replaced_at) VALUES (?, ?, ?, ?)',
      ).run(key, superseded, repoHint, now);
      this.trimFactHistory(key);
    }
    this.prepared(
      `INSERT INTO facts (key, value, repo_hint, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         repo_hint = excluded.repo_hint, updated_at = excluded.updated_at`,
    ).run(key, clean, repoHint, now);
    const fact: MemoryFact = { key, value: clean, repoHint, updatedAt: now };
    if (superseded !== null) {
      fact.previousValue = superseded;
    }
    return fact;
  }

  /** Keep only the newest FACT_HISTORY_MAX superseded values for a key. */
  private trimFactHistory(key: string): void {
    this.prepared(
      `DELETE FROM fact_history WHERE key = ? AND id NOT IN (
         SELECT id FROM fact_history WHERE key = ?
         ORDER BY replaced_at DESC, id DESC LIMIT ?
       )`,
    ).run(key, key, FACT_HISTORY_MAX);
  }

  /** Superseded values of one key, newest first. */
  factHistory(key: string, limit = FACT_HISTORY_MAX): FactHistoryEntry[] {
    this.validateKey(key);
    return this.mapHistory(
      this.prepared(
        `SELECT key, value, repo_hint, replaced_at FROM fact_history
         WHERE key = ? ORDER BY replaced_at DESC, id DESC LIMIT ?`,
      ).all(key, limit) as HistoryRow[],
    );
  }

  /** Superseded values across every key, newest first (a bare `history`). */
  recentFactHistory(limit = 20): FactHistoryEntry[] {
    return this.mapHistory(
      this.prepared(
        `SELECT key, value, repo_hint, replaced_at FROM fact_history
         ORDER BY replaced_at DESC, id DESC LIMIT ?`,
      ).all(limit) as HistoryRow[],
    );
  }

  private mapHistory(rows: HistoryRow[]): FactHistoryEntry[] {
    return rows.map((row) => ({
      key: row.key,
      value: row.value,
      repoHint: row.repo_hint,
      replacedAt: row.replaced_at,
    }));
  }

  forgetFact(key: string): boolean {
    this.validateKey(key);
    const res: RunResult = this.prepared('DELETE FROM facts WHERE key = ?').run(key);
    // Forget means forget: superseded values of a removed key go with it, so a
    // deleted credential-shaped fact cannot survive in the history table.
    const history: RunResult = this.prepared('DELETE FROM fact_history WHERE key = ?').run(key);
    return res.changes > 0 || history.changes > 0;
  }

  getFact(key: string): MemoryFact | undefined {
    const row = this.prepared(
      `SELECT f.key, f.value, f.repo_hint, f.updated_at, ${PREVIOUS_VALUE_SQL} AS previous_value
       FROM facts f WHERE f.key = ?`,
    ).get(key) as FactRow | undefined;
    return row === undefined ? undefined : this.toFact(row);
  }

  factsForRepo(repo: string, limit = 20): MemoryFact[] {
    const rows = this.prepared(
      `SELECT f.key, f.value, f.repo_hint, f.updated_at, ${PREVIOUS_VALUE_SQL} AS previous_value
       FROM facts f WHERE f.repo_hint = ? ORDER BY f.updated_at DESC LIMIT ?`,
    ).all(repo, limit) as FactRow[];
    return rows.map((row) => this.toFact(row));
  }

  searchFacts(query: string, limit = 10): MemoryFact[] {
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery === null) {
      return [];
    }
    const rows = this.prepared(
      `SELECT f.key, f.value, f.repo_hint, f.updated_at, ${PREVIOUS_VALUE_SQL} AS previous_value
       FROM facts_fts fts JOIN facts f ON f.id = fts.rowid
       WHERE facts_fts MATCH ? ORDER BY rank LIMIT ?`,
    ).all(ftsQuery, limit) as FactRow[];
    return rows.map((row) => this.toFact(row));
  }

  countFacts(): number {
    const row = this.prepared('SELECT COUNT(*) AS n FROM facts').get() as { n: number };
    return row.n;
  }

  // ------------------------------------------------------------ knowledge

  validateKnowledge(kind: KnowledgeKind, title: string, body: string): void {
    if (title.trim().length === 0) {
      throw new AegisxError('user', 'knowledge title must not be empty');
    }
    if (title.length > KNOWLEDGE_TITLE_MAX) {
      throw new AegisxError('user', `knowledge title too long (${title.length} > ${KNOWLEDGE_TITLE_MAX})`);
    }
    if (body.trim().length === 0) {
      throw new AegisxError('user', 'knowledge body must not be empty');
    }
    if (body.length > KNOWLEDGE_BODY_MAX) {
      throw new AegisxError('user', `knowledge body too long (${body.length} > ${KNOWLEDGE_BODY_MAX})`);
    }
    const allowed: readonly KnowledgeKind[] = ['decision', 'gotcha', 'convention', 'lesson'];
    if (!allowed.includes(kind)) {
      throw new AegisxError('user', `invalid knowledge kind "${kind}"`);
    }
  }

  /**
   * Upsert one knowledge entry, identified by (repo, kind, title).
   *
   * The previous INSERT-only version meant an agent re-recording the same
   * decision every session produced a duplicate row — which then ate recall
   * budget and littered the graph. Now a re-record overwrites in place, and a
   * byte-identical re-record is a no-op (no write, no `updated_at` churn), for
   * the same reason re-pinning an unchanged fact records no history.
   */
  saveKnowledge(
    repo: string,
    kind: KnowledgeKind,
    title: string,
    body: string,
    anchors: string[],
  ): KnowledgeRecord {
    this.validateKnowledge(kind, title, body);
    const encoded = JSON.stringify(anchors);
    const existing = this.prepared(
      'SELECT body, anchors, updated_at FROM knowledge WHERE repo = ? AND kind = ? AND title = ?',
    ).get(repo, kind, title) as { body: string; anchors: string; updated_at: string } | undefined;
    if (existing !== undefined && existing.body === body && existing.anchors === encoded) {
      return { kind, title, body, anchors, updatedAt: existing.updated_at };
    }
    const now = new Date().toISOString();
    this.prepared(
      `INSERT INTO knowledge (repo, kind, title, body, anchors, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(repo, kind, title) DO UPDATE SET
         body = excluded.body, anchors = excluded.anchors, updated_at = excluded.updated_at`,
    ).run(repo, kind, title, body, encoded, now);
    const record: KnowledgeRecord = { kind, title, body, anchors, updatedAt: now };
    if (existing !== undefined) {
      record.updated = true;
    }
    return record;
  }

  /**
   * Record handoff notes (the handoff's `decisions`) as knowledge, upserted by
   * their sentence. The single implementation behind a live `save` and the
   * one-time backfill of handoffs written before knowledge had a producer.
   */
  recordHandoffNotes(repo: string, notes: readonly string[]): SessionSaveSummary {
    const before = this.countKnowledge();
    for (const note of notes) {
      this.saveKnowledge(repo, 'decision', knowledgeTitle(note), note, []);
    }
    const recorded = this.countKnowledge() - before;
    return { decisionsRecorded: recorded, decisionsAlreadyKnown: notes.length - recorded };
  }

  knowledgeForRepo(repo: string, limit = 20): KnowledgeRecord[] {
    const rows = this.prepared(
      `SELECT kind, title, body, anchors, updated_at FROM knowledge WHERE repo = ? ORDER BY updated_at DESC LIMIT ?`,
    ).all(repo, limit) as Array<{ kind: string; title: string; body: string; anchors: string; updated_at: string }>;
    return rows.map((row) => ({
      kind: row.kind as KnowledgeKind,
      title: row.title,
      body: row.body,
      anchors: JSON.parse(row.anchors) as string[],
      updatedAt: row.updated_at,
      repo,
    }));
  }

  searchKnowledge(query: string, repo: string | null, limit = 10): KnowledgeRecord[] {
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery === null) {
      return [];
    }
    const base = `SELECT k.repo, k.kind, k.title, k.body, k.anchors, k.updated_at
       FROM knowledge_fts fts JOIN knowledge k ON k.id = fts.rowid
       WHERE knowledge_fts MATCH ?`;
    const rows = (
      repo === null
        ? (this.prepared(`${base} ORDER BY rank LIMIT ?`).all(ftsQuery, limit) as Array<{
            repo: string; kind: string; title: string; body: string; anchors: string; updated_at: string;
          }>)
        : (this.prepared(`${base} AND k.repo = ? ORDER BY rank LIMIT ?`).all(ftsQuery, repo, limit) as Array<{
            repo: string; kind: string; title: string; body: string; anchors: string; updated_at: string;
          }>)
    ).map((row) => ({
      kind: row.kind as KnowledgeKind,
      title: row.title,
      body: row.body,
      anchors: JSON.parse(row.anchors) as string[],
      updatedAt: row.updated_at,
      repo: row.repo,
    }));
    return rows;
  }

  countKnowledge(): number {
    const row = this.prepared('SELECT COUNT(*) AS n FROM knowledge').get() as { n: number };
    return row.n;
  }

  // ------------------------------------------------------------- sessions

  saveSession(repo: string, handoff: SessionHandoff): void {
    assertHandoff(handoff);
    this.prepared(
      `INSERT INTO sessions (repo, goal, facts, decisions, next_steps, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      repo,
      handoff.goal,
      JSON.stringify(handoff.facts),
      JSON.stringify(handoff.decisions),
      JSON.stringify(handoff.nextSteps),
      new Date().toISOString(),
    );
  }

  lastSession(repo: string): SessionHandoff | undefined {
    const row = this.prepared(
      `SELECT goal, facts, decisions, next_steps, created_at FROM sessions
       WHERE repo = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(repo) as {
      goal: string; facts: string; decisions: string; next_steps: string; created_at: string;
    } | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      goal: row.goal,
      facts: JSON.parse(row.facts) as string[],
      decisions: JSON.parse(row.decisions) as string[],
      nextSteps: JSON.parse(row.next_steps) as string[],
      createdAt: row.created_at,
    };
  }

  countSessions(): number {
    const row = this.prepared('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    return row.n;
  }

  // ----------------------------------------------------------------- meta

  setMeta(key: string, value: string): void {
    this.prepared(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.prepared('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  // ---------------------------------------------------------------- doctor

  /** Run SQLite's PRAGMA integrity_check — 'ok' means the file is healthy. */
  integrityCheck(): string {
    const row = this.prepared('PRAGMA integrity_check').get() as unknown as Record<string, unknown> | undefined;
    if (row === undefined) return 'unknown';
    const value = row['integrity_check'] ?? row['result'];
    return typeof value === 'string' ? value : 'unknown';
  }

  // ---------------------------------------------------------- telemetry

  recordScanRun(repo: string, stats: {
    filesTotal: number;
    filesChanged: number;
    filesDeleted: number;
    filesSkipped: number;
    symbolsTotal: number;
    durationMs: number;
  }): void {
    this.prepared(
      `INSERT INTO scan_runs
        (repo, files_total, files_changed, files_deleted, files_skipped, symbols_total, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      repo,
      stats.filesTotal,
      stats.filesChanged,
      stats.filesDeleted,
      stats.filesSkipped,
      stats.symbolsTotal,
      stats.durationMs,
      new Date().toISOString(),
    );
  }

  recordRecallRun(
    repo: string,
    query: string | null,
    tokenEstimate: number,
    factsHit: number,
    symbolsHit: number,
    knowledgeHit: number,
    hit: boolean,
  ): void {
    this.prepared(
      `INSERT INTO recall_runs
        (repo, query, token_estimate, facts_hit, symbols_hit, knowledge_hit, hit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      repo,
      query,
      tokenEstimate,
      factsHit,
      symbolsHit,
      knowledgeHit,
      hit ? 1 : 0,
      new Date().toISOString(),
    );
  }

  scanRunsForRepo(repo: string, limit = 30): Array<{
    filesTotal: number; filesChanged: number; filesDeleted: number;
    filesSkipped: number; symbolsTotal: number; durationMs: number; createdAt: string;
  }> {
    const rows = this.prepared(
      `SELECT files_total, files_changed, files_deleted, files_skipped, symbols_total, duration_ms, created_at
       FROM scan_runs WHERE repo = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(repo, limit) as Array<{
      files_total: number; files_changed: number; files_deleted: number;
      files_skipped: number; symbols_total: number; duration_ms: number; created_at: string;
    }>;
    return rows.map((r) => ({
      filesTotal: r.files_total, filesChanged: r.files_changed, filesDeleted: r.files_deleted,
      filesSkipped: r.files_skipped, symbolsTotal: r.symbols_total, durationMs: r.duration_ms, createdAt: r.created_at,
    }));
  }

  recallRunsForRepo(repo: string, limit = 100): Array<{
    tokenEstimate: number; factsHit: number; symbolsHit: number;
    knowledgeHit: number; hit: boolean; createdAt: string;
  }> {
    const rows = this.prepared(
      `SELECT token_estimate, facts_hit, symbols_hit, knowledge_hit, hit, created_at
       FROM recall_runs WHERE repo = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(repo, limit) as Array<{
      token_estimate: number; facts_hit: number; symbols_hit: number;
      knowledge_hit: number; hit: number; created_at: string;
    }>;
    return rows.map((r) => ({
      tokenEstimate: r.token_estimate, factsHit: r.facts_hit, symbolsHit: r.symbols_hit,
      knowledgeHit: r.knowledge_hit, hit: r.hit === 1, createdAt: r.created_at,
    }));
  }

  scanAggregate(repo: string): {
    totalScans: number; avgDurationMs: number | null; lastScanAt: string | null;
    lastFilesTotal: number | null; lastSymbolsTotal: number | null;
  } {
    const row = this.prepared(
      `SELECT COUNT(*) AS n, AVG(duration_ms) AS avg_ms FROM scan_runs WHERE repo = ?`,
    ).get(repo) as { n: number; avg_ms: number | null };
    const last = this.prepared(
      `SELECT files_total, symbols_total, created_at FROM scan_runs WHERE repo = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(repo) as { files_total: number; symbols_total: number; created_at: string } | undefined;
    return {
      totalScans: row.n,
      avgDurationMs: row.avg_ms === null ? null : Math.round(row.avg_ms),
      lastScanAt: last?.created_at ?? null,
      lastFilesTotal: last?.files_total ?? null,
      lastSymbolsTotal: last?.symbols_total ?? null,
    };
  }

  recallAggregate(repo: string): {
    totalRecalls: number; hits: number; hitRate: number | null;
    avgTokens: number | null; tokensSavedEstimate: number | null;
  } {
    const row = this.prepared(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN hit = 1 THEN 1 ELSE 0 END), 0) AS hits,
              AVG(token_estimate) AS avg_tokens
       FROM recall_runs WHERE repo = ?`,
    ).get(repo) as { n: number; hits: number; avg_tokens: number | null };
    // Conservative estimate: each warm recall would otherwise cost a full
    // re-read (~8k tokens for a non-trivial repo). Saved = (8000 - actual).
    // Floor at 0 so cold misses don't count as "saving".
    const SAVED_BASELINE = 8000;
    const hitRows = row.hits;
    const avgSavedPerHit = row.avg_tokens === null ? null : Math.max(0, SAVED_BASELINE - Math.round(row.avg_tokens));
    const tokensSavedEstimate = avgSavedPerHit === null ? null : avgSavedPerHit * hitRows;
    return {
      totalRecalls: row.n,
      hits: hitRows,
      hitRate: row.n === 0 ? null : Math.round((hitRows / row.n) * 1000) / 10, // one decimal
      avgTokens: row.avg_tokens === null ? null : Math.round(row.avg_tokens),
      tokensSavedEstimate,
    };
  }

  purgeTelemetry(repo: string): { scans: number; recalls: number } {
    const a = this.prepared('DELETE FROM scan_runs WHERE repo = ?').run(repo);
    const b = this.prepared('DELETE FROM recall_runs WHERE repo = ?').run(repo);
    return { scans: a.changes, recalls: b.changes };
  }

  /** Retention cap (RFC §5, STRIDE:D): telemetry older than 30 days is
   *  pruned across ALL repos — called on every index so the tables cannot
   *  grow unbounded under watch mode. Returns removed rows per table. */
  pruneOldTelemetry(maxAgeMs = TELEMETRY_RETENTION_MS): { scans: number; recalls: number } {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const a = this.prepared('DELETE FROM scan_runs WHERE created_at < ?').run(cutoff);
    const b = this.prepared('DELETE FROM recall_runs WHERE created_at < ?').run(cutoff);
    return { scans: a.changes, recalls: b.changes };
  }

  // ------------------------------------------------------------ dashboard

  /** Distinct repos that hold any memory or telemetry (dashboard overview). */
  listRepos(): string[] {
    const rows = this.prepared(
      `SELECT repo FROM (
         SELECT DISTINCT repo FROM knowledge
         UNION SELECT DISTINCT repo FROM sessions
         UNION SELECT DISTINCT repo FROM scan_runs
         UNION SELECT DISTINCT repo FROM recall_runs
       ) ORDER BY repo`,
    ).all() as Array<{ repo: string }>;
    return rows.map((row) => row.repo);
  }

  /** All facts, newest first (dashboard table; owner-facing, not repo-scoped).
   *  Carries the superseded value too, so the dashboard can flag re-pinned keys
   *  the same way recall does. */
  listFacts(limit = 100): MemoryFact[] {
    const rows = this.prepared(
      `SELECT f.key, f.value, f.repo_hint, f.updated_at, ${PREVIOUS_VALUE_SQL} AS previous_value
       FROM facts f ORDER BY f.updated_at DESC, f.key ASC LIMIT ?`,
    ).all(limit) as FactRow[];
    return rows.map((row) => this.toFact(row));
  }

  /** All knowledge records across repos, newest first (dashboard graph; owner-facing). */
  listKnowledge(limit = 50): KnowledgeRecord[] {
    const rows = this.prepared(
      `SELECT repo, kind, title, body, anchors, updated_at FROM knowledge ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(limit) as Array<{ repo: string; kind: string; title: string; body: string; anchors: string; updated_at: string }>;
    return rows.map((row) => ({
      kind: row.kind as KnowledgeKind,
      title: row.title,
      body: row.body,
      anchors: JSON.parse(row.anchors) as string[],
      updatedAt: row.updated_at,
      repo: row.repo,
    }));
  }

  /** Recent handoffs across repos with item counts (no full bodies needed). */
  recentSessions(limit = 20): Array<{ repo: string; goal: string; facts: number; decisions: number; nextSteps: number; createdAt: string }> {
    const rows = this.prepared(
      `SELECT repo, goal, facts, decisions, next_steps, created_at FROM sessions
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(limit) as Array<{ repo: string; goal: string; facts: string; decisions: string; next_steps: string; created_at: string }>;
    return rows.map((row) => ({
      repo: row.repo,
      goal: row.goal,
      facts: (JSON.parse(row.facts) as string[]).length,
      decisions: (JSON.parse(row.decisions) as string[]).length,
      nextSteps: (JSON.parse(row.next_steps) as string[]).length,
      createdAt: row.created_at,
    }));
  }

  /** Recent recall runs across repos, chronological order for trend charts. */
  recentRecalls(limit = 50): Array<{ repo: string; query: string | null; tokenEstimate: number; hit: boolean; createdAt: string }> {
    const rows = this.prepared(
      `SELECT repo, query, token_estimate, hit, created_at FROM recall_runs
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(limit) as Array<{ repo: string; query: string | null; token_estimate: number; hit: number; created_at: string }>;
    return rows
      .map((row) => ({
        repo: row.repo,
        query: row.query,
        tokenEstimate: row.token_estimate,
        hit: row.hit === 1,
        createdAt: row.created_at,
      }))
      .reverse();
  }

  /** Distinguish an empty DB (no tables yet — fresh file) from a migrated one. */
  schemaTableNames(): string[] {
    const rows = this.prepared(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name NOT LIKE '%_data' AND name NOT LIKE '%_idx' AND name NOT LIKE '%_config' ORDER BY name`,
    ).all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }
}

/** Back-compat alias: free-text → safe FTS5 query. */
export const ftsEscape = buildFtsQuery;

/** Parse a JSON string list out of a `sessions` column. Legacy rows can hold
 *  anything, and one mangled value must not abort a migration. */
function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function assertHandoff(handoff: SessionHandoff): void {
  if (handoff.goal.trim().length === 0) {
    throw new AegisxError('user', 'session goal must not be empty');
  }
  if (handoff.goal.length > HANDOFF_STRING_MAX) {
    throw new AegisxError('user', `session goal too long (${handoff.goal.length} > ${HANDOFF_STRING_MAX})`);
  }
  for (const listName of ['facts', 'decisions', 'nextSteps'] as const) {
    const list = handoff[listName];
    if (!Array.isArray(list)) {
      throw new AegisxError('user', `session ${listName} must be an array`);
    }
    if (list.length > HANDOFF_ARRAY_MAX) {
      throw new AegisxError('user', `session ${listName} has too many items (${list.length} > ${HANDOFF_ARRAY_MAX})`);
    }
    for (const item of list) {
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw new AegisxError('user', `session ${listName} items must be non-empty strings`);
      }
      if (item.length > HANDOFF_STRING_MAX) {
        throw new AegisxError('user', `session ${listName} item too long (${item.length} > ${HANDOFF_STRING_MAX})`);
      }
    }
  }
}
