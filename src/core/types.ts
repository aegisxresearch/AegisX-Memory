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
  kind: KnowledgeKind;
  title: string;
  body: string;
  anchors: string[];
  updatedAt?: string;
  /** Owning repo (normalized path) — set by the store on read; used for
   *  cross-project filtering when recall runs without a repo context. */
  repo?: string;
}

export interface SessionHandoff {
  goal: string;
  facts: string[];
  decisions: string[];
  nextSteps: string[];
  createdAt?: string;
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
