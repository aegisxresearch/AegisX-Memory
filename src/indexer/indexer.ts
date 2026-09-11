/**
 * Indexer: hash-based incremental code index — the anti-reread core.
 * Walks the repo honoring .gitignore + default skips, hashes files, and
 * extracts cheap language-agnostic signals. Memories are keyed to content
 * hashes, so stale knowledge invalidates itself automatically.
 */
import DatabaseConstructor from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ignoreFactory from 'ignore';
import type { Ignore } from 'ignore';
import { AegisxError, type ScanStats, type SymbolRecord, type SymbolKind } from '../core/types.js';
import { buildFtsQuery } from '../core/fts.js';
import { lineContainsSecret } from '../core/secrets.js';
import { secureDbFile } from '../core/db-perms.js';

export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_TOTAL_FILES = 50_000;
export const MAX_DEPTH = 64;

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.turbo', '.cache',
  'coverage', '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.aegisx-cache',
]);

/** Regex for language-agnostic top-level declarations. */
const SYMBOL_LINE =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|def|struct|impl|trait|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;

const MARKER_LINE = /^\s*\/\/\/?\s*(TODO|FIXME|HACK|NOTE)\b:?\s*(.*)$/;
const IMPORT_LINE = /^\s*(?:import\s+.*?from\s+|const\s+.*?=\s*require\(|#include\s*[<"])(['"]?)([^'";>]+)\1/;

/** camelCase/PascalCase → searchable subword projection: "loginUser" → "login user loginuser". */
export function subwordProjection(identifier: string): string {
  const parts = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter((p) => p.length > 0);
  return [...new Set([...parts, identifier.toLowerCase()])].join(' ');
}

export class Indexer {
  private readonly db: DatabaseType;
  private readonly stmtCache = new Map<string, Statement>();

  constructor(dbFile: string) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
    this.db = new DatabaseConstructor(dbFile);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    // Owner-only file mode (best effort, same rationale as Store).
    secureDbFile(dbFile);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT NOT NULL,
        repo TEXT NOT NULL,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (repo, path)
      );
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY,
        repo TEXT NOT NULL,
        file_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT,
        name_search TEXT NOT NULL DEFAULT '',
        line INTEGER NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_repo_file ON symbols(repo, file_path);
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    `);
    // Legacy DBs may lack the projection column — add it before triggers exist.
    const cols = this.db.pragma('table_info(symbols)') as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'name_search')) {
      this.db.exec(`ALTER TABLE symbols ADD COLUMN name_search TEXT NOT NULL DEFAULT ''`);
    }
    // Rebuild the FTS table if it predates the projected column.
    const ftsCols = this.db.pragma('table_info(symbols_fts)') as Array<{ name: string }>;
    if (ftsCols.length > 0 && !ftsCols.some((c) => c.name === 'name_search')) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS symbols_ai;
        DROP TRIGGER IF EXISTS symbols_ad;
        DROP TRIGGER IF EXISTS symbols_au;
        DROP TABLE symbols_fts;
      `);
    }
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
        name_search, detail, content='symbols', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
        INSERT INTO symbols_fts(rowid, name_search, detail)
          VALUES (new.id, new.name_search, new.detail);
      END;
      CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
        INSERT INTO symbols_fts(symbols_fts, rowid, name_search, detail)
          VALUES ('delete', old.id, old.name_search, old.detail);
      END;
      CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
        INSERT INTO symbols_fts(symbols_fts, rowid, name_search, detail)
          VALUES ('delete', old.id, old.name_search, old.detail);
        INSERT INTO symbols_fts(rowid, name_search, detail)
          VALUES (new.id, new.name_search, new.detail);
      END;
    `);
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

  /**
   * Incremental scan: hash every admissible file, re-extract only changed ones,
   * tombstone deleted ones. Deterministic — same repo state, same result.
   */
  scan(repoAbsPath: string, repo: string, onWarn?: (msg: string) => void): ScanStats {
    const started = Date.now();
    const root = path.resolve(repoAbsPath);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new AegisxError('user', `repo path does not exist or is not a directory: ${root}`);
    }

    const previous = this.loadPreviousHashes(repo);
    const collected = this.collectFileHashes(root, onWarn);
    const nextHashes = collected.hashes;
    const changed: string[] = [];
    for (const [rel, hash] of nextHashes) {
      if (previous.get(rel) !== hash) {
        changed.push(rel);
      }
    }

    const extract = this.db.transaction((paths: string[]) => {
      const delSyms = this.prepared('DELETE FROM symbols WHERE repo = ? AND file_path = ?');
      const insSym = this.prepared(
        'INSERT INTO symbols (repo, file_path, kind, name, name_search, line, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      const upsertFile = this.prepared(
        `INSERT INTO files (path, repo, hash, size, mtime_ms, deleted) VALUES (?, ?, ?, ?, ?, 0)
         ON CONFLICT(repo, path) DO UPDATE SET hash = excluded.hash,
           size = excluded.size, mtime_ms = excluded.mtime_ms, deleted = 0`,
      );
      for (const rel of paths) {
        delSyms.run(repo, rel);
        const content = fs.readFileSync(path.join(root, rel), 'utf8');
        for (const sym of extractSymbols(rel, content)) {
          const projected = sym.name === null ? '' : subwordProjection(sym.name);
          insSym.run(repo, rel, sym.kind, sym.name, projected, sym.line, sym.detail ?? null);
        }
        const stat = fs.statSync(path.join(root, rel));
        upsertFile.run(rel, repo, nextHashes.get(rel) ?? '', stat.size, Math.round(stat.mtimeMs));
      }
    });

    const deletedCount = [...previous.keys()].filter((k) => !nextHashes.has(k)).length;
    const commit = this.db.transaction(() => {
      // tombstone files that vanished
      for (const [rel] of previous) {
        if (!nextHashes.has(rel)) {
          this.prepared('UPDATE files SET deleted = 1 WHERE repo = ? AND path = ?').run(repo, rel);
          this.prepared('DELETE FROM symbols WHERE repo = ? AND file_path = ?').run(repo, rel);
        }
      }
      extract(changed);
    });
    commit();

    const filesTotal = nextHashes.size;
    const symbolsTotal = (
      this.prepared('SELECT COUNT(*) AS n FROM symbols WHERE repo = ?').get(repo) as { n: number }
    ).n;

    return {
      repo,
      filesTotal,
      filesChanged: changed.length,
      filesDeleted: deletedCount,
      filesSkipped: collected.skipped,
      symbolsTotal,
      durationMs: Date.now() - started,
    };
  }

  /** Read-only tree walk: hash every admissible file without touching the DB. */
  private collectFileHashes(
    root: string,
    onWarn?: (msg: string) => void,
  ): { hashes: Map<string, string>; skipped: number } {
    const warn = onWarn ?? (() => undefined);
    const ig = this.loadIgnoreRules(root);
    const hashes = new Map<string, string>();
    let skipped = 0;

    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_DEPTH) {
        warn(`depth cap ${MAX_DEPTH} reached at ${dir}`);
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        warn(`unreadable directory skipped: ${dir}`);
        return;
      }
      for (const entry of entries) {
        const relPosix = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
        if (entry.isDirectory()) {
          if (DEFAULT_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.') || ig.ignores(relPosix + '/')) {
            continue;
          }
          walk(path.join(dir, entry.name), depth + 1);
          continue;
        }
        if (!entry.isFile()) {
          skipped += 1; // symlinks and special files are refused (DoS guard)
          continue;
        }
        if (ig.ignores(relPosix)) {
          continue;
        }
        if (isSecretBearingFile(relPosix)) {
          skipped += 1;
          continue;
        }
        if (hashes.size >= MAX_TOTAL_FILES) {
          throw new AegisxError(
            'internal',
            `repo exceeds ${MAX_TOTAL_FILES} files; aborting scan (adjust ignore rules or split repo)`,
          );
        }
        const abs = path.join(dir, entry.name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          skipped += 1;
          continue;
        }
        if (stat.size > MAX_FILE_BYTES) {
          warn(`file too large, skipped (${stat.size} bytes): ${relPosix}`);
          skipped += 1;
          continue;
        }
        let buf: Buffer;
        try {
          buf = fs.readFileSync(abs);
        } catch {
          skipped += 1;
          continue;
        }
        hashes.set(relPosix, crypto.createHash('sha256').update(buf).digest('hex'));
      }
    };

    walk(root, 0);
    return { hashes, skipped };
  }

  /** Read-only drift analysis: disk hashes vs the indexed ledger (doctor). */
  driftCheck(
    repoAbsPath: string,
    repo: string,
  ): {
    indexedFiles: number;
    onDiskFiles: number;
    missingFromDisk: string[];
    notIndexed: string[];
    hashChanged: string[];
  } {
    const root = path.resolve(repoAbsPath);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new AegisxError('user', `repo path does not exist or is not a directory: ${root}`);
    }
    const previous = this.loadPreviousHashes(repo);
    const { hashes } = this.collectFileHashes(root);
    const missingFromDisk: string[] = [];
    const hashChanged: string[] = [];
    for (const [rel, hash] of previous) {
      const current = hashes.get(rel);
      if (current === undefined) {
        missingFromDisk.push(rel);
      } else if (current !== hash) {
        hashChanged.push(rel);
      }
    }
    const notIndexed: string[] = [...hashes.keys()].filter((rel) => !previous.has(rel));
    return { indexedFiles: previous.size, onDiskFiles: hashes.size, missingFromDisk, notIndexed, hashChanged };
  }

  private loadIgnoreRules(root: string): Ignore {
    const ig = ignoreFactory();
    const gitignore = path.join(root, '.gitignore');
    if (fs.existsSync(gitignore)) {
      ig.add(fs.readFileSync(gitignore, 'utf8'));
    }
    return ig;
  }

  private loadPreviousHashes(repo: string): Map<string, string> {
    const rows = this.prepared('SELECT path, hash FROM files WHERE repo = ? AND deleted = 0').all(repo) as Array<{
      path: string;
      hash: string;
    }>;
    return new Map(rows.map((r) => [r.path, r.hash]));
  }

  /** Deterministic structure brief: module map + top symbols. */
  buildBrief(repo: string): string {
    const dirs = this.prepared(
      `SELECT file_path, COUNT(*) AS n FROM symbols WHERE repo = ? GROUP BY file_path`,
    ).all(repo) as Array<{ file_path: string; n: number }>;
    if (dirs.length === 0) {
      return 'No indexed symbols for this repo yet. Run `aegisx index` first.';
    }
    const byDir = new Map<string, number>();
    for (const row of dirs) {
      const dir = row.file_path.includes('/') ? row.file_path.slice(0, row.file_path.lastIndexOf('/')) : '.';
      byDir.set(dir, (byDir.get(dir) ?? 0) + row.n);
    }
    const topDirs = [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const topSymbols = (
      this.prepared(
        `SELECT file_path, kind, name, line FROM symbols
         WHERE repo = ? AND name IS NOT NULL AND kind IN ('function','class','export')
         ORDER BY file_path, line LIMIT 40`,
      ).all(repo) as Array<{ file_path: string; kind: string; name: string; line: number }>
    ).map((r) => `- \`${r.file_path}:${r.line}\` ${r.kind} ${r.name}`);
    const lines = [
      '## Code structure brief (from AegisX index)',
      ...topDirs.map(([d, n]) => `- ${d}/ — ${n} symbols`),
      '',
      '### Key symbols',
      ...topSymbols,
    ];
    return lines.join('\n');
  }

  searchSymbols(query: string, repo: string, limit = 12): SymbolRecord[] {
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery === null) {
      return [];
    }
    const rows = this.prepared(
      `SELECT s.file_path, s.kind, s.name, s.line, s.detail
       FROM symbols_fts fts JOIN symbols s ON s.id = fts.rowid
       WHERE symbols_fts MATCH ? AND s.repo = ? ORDER BY rank LIMIT ?`,
    ).all(ftsQuery, repo, limit) as Array<{
      file_path: string; kind: string; name: string | null; line: number; detail: string | null;
    }>;
    return rows.map((row) => ({
      filePath: row.file_path,
      kind: row.kind as SymbolKind,
      name: row.name,
      line: row.line,
      detail: row.detail ?? undefined,
    }));
  }

  /** Deterministic top symbols for repo-scoped (query-less) recall. */
  topSymbols(repo: string, limit = 15): SymbolRecord[] {
    const rows = this.prepared(
      `SELECT file_path, kind, name, line, detail FROM symbols
       WHERE repo = ? AND name IS NOT NULL AND kind IN ('function','class','export','marker')
       ORDER BY file_path, line LIMIT ?`,
    ).all(repo, limit) as Array<{
      file_path: string; kind: string; name: string | null; line: number; detail: string | null;
    }>;
    return rows.map((row) => ({
      filePath: row.file_path,
      kind: row.kind as SymbolKind,
      name: row.name,
      line: row.line,
      detail: row.detail ?? undefined,
    }));
  }

  countFiles(repo: string, includeDeleted = false): number {
    const row = (
      includeDeleted
        ? (this.prepared('SELECT COUNT(*) AS n FROM files WHERE repo = ?').get(repo) as { n: number })
        : (this.prepared('SELECT COUNT(*) AS n FROM files WHERE repo = ? AND deleted = 0').get(repo) as { n: number })
    );
    return row.n;
  }

  countSymbols(repo: string): number {
    const row = this.prepared('SELECT COUNT(*) AS n FROM symbols WHERE repo = ?').get(repo) as { n: number };
    return row.n;
  }

  lastScanAt(repo: string): string | undefined {
    const row = this.prepared('SELECT MAX(mtime_ms) AS m FROM files WHERE repo = ?').get(repo) as {
      m: number | null;
    };
    return row.m === null ? undefined : new Date(row.m).toISOString();
  }
}

/** Files whose content must never be indexed (secret hygiene, STRIDE: I).
 *  All dotfiles are excluded — config and credential files by definition. */
export function isSecretBearingFile(relPath: string): boolean {
  const base = relPath.split('/').pop() ?? relPath;
  if (base.startsWith('.')) return true;
  if (base.endsWith('.pem') || base.endsWith('.key') || base.endsWith('.p12')) return true;
  if (base === 'credentials.json' || base === 'service-account.json') return true;
  return false;
}

/** Extract symbols/markers/imports from one file's content (pure function). */
export function extractSymbols(filePath: string, content: string): SymbolRecord[] {
  const out: SymbolRecord[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (lineContainsSecret(line)) {
      continue; // redact: never store secret-bearing lines (shared pattern, secrets.ts)
    }
    const sym = SYMBOL_LINE.exec(line);
    if (sym !== null) {
      out.push({ filePath, kind: sym[1] as SymbolKind, name: sym[2] ?? null, line: i + 1 });
      continue;
    }
    const marker = MARKER_LINE.exec(line);
    if (marker !== null) {
      out.push({ filePath, kind: 'marker', name: marker[1] ?? null, line: i + 1, detail: marker[2]?.slice(0, 300) });
      continue;
    }
    const imp = IMPORT_LINE.exec(line);
    if (imp !== null) {
      out.push({ filePath, kind: 'import', name: imp[2] ?? null, line: i + 1 });
    }
  }
  return out;
}
