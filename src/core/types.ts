/** Core contracts shared across engine, CLI, indexer and MCP layers. */

/**
 * Kinds the indexer emits. Each declaration kind mirrors the source keyword it
 * matched (`def` for Python, `fn` for Rust, `func` for Go, `public class` →
 * `class`, …), plus the two synthetic kinds derived from markers and imports.
 * Keep in sync with SYMBOL_LINE / TYPED_FUNCTION_LINE in src/indexer/indexer.ts.
 */
export type SymbolKind =
  | 'function'
  | 'class'
  | 'def'
  | 'struct'
  | 'impl'
  | 'trait'
  | 'type'
  | 'interface'
  | 'enum'
  | 'union'
  | 'module'
  | 'mod'
  | 'record'
  | 'object'
  | 'namespace'
  | 'func'
  | 'fn'
  | 'fun'
  | 'marker'
  | 'import';
export type KnowledgeKind = 'decision' | 'gotcha' | 'convention' | 'lesson';

export interface MemoryFact {
  key: string;
  value: string;
  repoHint: string | null;
  updatedAt: string;
  /** Value this key held before it was last re-pinned (absent on first set). */
  previousValue?: string;
}

/** One superseded value of a fact key — the timeline `recall` and `history` show. */
export interface FactHistoryEntry {
  key: string;
  value: string;
  repoHint: string | null;
  /** When this value stopped being the current one. */
  replacedAt: string;
}

export interface SymbolRecord {
  filePath: string;
  kind: SymbolKind;
  name: string | null;
  line: number;
  detail?: string;
}

export interface KnowledgeRecord {
  /** Primary key in the knowledge table. Stable across an upsert (the row is
   *  updated in place, not re-inserted), and the handle `aegisxmemory
   *  knowledge --forget <id>` deletes by. Present on store reads. */
  id?: number;
  kind: KnowledgeKind;
  title: string;
  body: string;
  anchors: string[];
  updatedAt?: string;
  /** Owning repo (normalized path) — set by the store on read; used for
   *  cross-project filtering when recall runs without a repo context. */
  repo?: string;
  /** Set by `saveKnowledge` when an existing entry with the same
   *  (repo, kind, title) was overwritten — so a caller can say "updated"
   *  instead of "added", the same way fast facts report a replaced value. */
  updated?: boolean;
}

/** What a `saveSession` call wrote to the knowledge store, so a caller can
 *  tell the agent whether it taught the memory anything new. */
export interface SessionSaveSummary {
  /** New knowledge entries created (decisions + gotchas + conventions). */
  notesRecorded: number;
  /** Notes whose sentence was already stored (upserted onto, not forked). */
  notesAlreadyKnown: number;
}

export interface SessionHandoff {
  goal: string;
  facts: string[];
  decisions: string[];
  gotchas: string[];
  conventions: string[];
  nextSteps: string[];
  createdAt?: string;
}

/** A handoff as a *caller* may supply it. `gotchas` and `conventions` arrived
 *  after the original four fields, so they stay optional here and default to
 *  empty: an agent (or a script) that only knows the old shape keeps working. */
export interface SessionHandoffInput {
  goal: string;
  facts: string[];
  decisions: string[];
  gotchas?: string[];
  conventions?: string[];
  nextSteps: string[];
}

/** The lists a handoff contributes to the knowledge store, after the optional
 *  caller-facing fields have been normalized. */
export interface HandoffNotes {
  decisions: string[];
  gotchas: string[];
  conventions: string[];
}

/** A stored handoff row with its lists intact — `export` reads the notes
 *  themselves, where `recentSessions` only needs their lengths. */
export interface SessionRecord {
  repo: string;
  goal: string;
  facts: string[];
  decisions: string[];
  gotchas: string[];
  conventions: string[];
  nextSteps: string[];
  createdAt: string;
}

/**
 * Everything one repository remembers, as the dashboard's memory browser reads
 * it: its knowledge with bodies intact, its pinned facts and its handoffs — no
 * graph, no token budget.
 *
 * `counts` are the repository's true totals while the arrays are capped, so the
 * reader can say "showing 200 of 1,204" instead of implying it showed all of it.
 */
export interface RepoMemory {
  repo: string;
  facts: MemoryFact[];
  knowledge: KnowledgeRecord[];
  sessions: SessionRecord[];
  counts: { facts: number; knowledge: number; sessions: number };
}

/** One repository's telemetry rollup, as both the dashboard and `export` read it. */
export interface RepoSummary {
  repo: string;
  files: number;
  symbols: number;
  scans: number;
  recalls: number;
  hitRate: number | null;
  tokensSavedEstimate: number | null;
}

/** Whole-memory dump for `aegisxmemory export` — backup, portability, review.
 *  The lists are the owner's view of the store (all repos, no budget), not the
 *  ranked window recall composes for an agent. */
export interface MemoryExport {
  generatedAt: string;
  /** Per-store cap applied to the lists below. A list that reaches this length
   *  is truncated, which is why the number travels with the dump. */
  rowLimit: number;
  totals: { repos: number; facts: number; knowledge: number; sessions: number };
  repos: RepoSummary[];
  facts: MemoryFact[];
  knowledge: KnowledgeRecord[];
  sessions: SessionRecord[];
}

export interface ScanStats {
  repo: string;
  filesTotal: number;
  filesChanged: number;
  filesDeleted: number;
  filesSkipped: number;
  symbolsTotal: number;
  durationMs: number;
}

export interface ObservabilityStats {
  repo: string;
  files: number;
  symbols: number;
  facts: number;
  knowledge: number;
  sessions: number;
  lastScanAt?: string;
  scans: {
    total: number;
    avgDurationMs: number | null;
    lastAt: string | null;
    lastFilesTotal: number | null;
    lastSymbolsTotal: number | null;
    recent: Array<{
      filesTotal: number;
      filesChanged: number;
      filesDeleted: number;
      filesSkipped: number;
      symbolsTotal: number;
      durationMs: number;
      createdAt: string;
    }>;
  };
  recalls: {
    total: number;
    hits: number;
    hitRate: number | null;
    avgTokens: number | null;
    tokensSavedEstimate: number | null;
    recent: Array<{
      tokenEstimate: number;
      factsHit: number;
      symbolsHit: number;
      knowledgeHit: number;
      hit: boolean;
      createdAt: string;
    }>;
  };
  // Convenience rollup for humans/CI badges
  tokensSavedEstimate: number | null;
  hitRate: number | null;
}

export interface RecallResult {
  brief: string;
  facts: MemoryFact[];
  symbols: SymbolRecord[];
  knowledge: KnowledgeRecord[];
  lastSession?: SessionHandoff;
  tokenEstimate: number;
}

/** Error categories mapped to CLI exit codes. */
export type ErrorKind = 'user' | 'internal';

export class AegisxError extends Error {
  readonly kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = 'AegisxError';
    this.kind = kind;
  }
}
