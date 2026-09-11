# RFC: AegisX-Memory — Persistent Memory Engine for AI Coding Agents

Status: DRAFT v1 (Phase 1 — Architecture & Threat Modeling)
Owner: user · Author: @architect (Freebuff Tri-Phase)

---

## 1. Problem Statement

Every AI coding session repeats the same expensive cycle:

1. **Cold start** — the agent re-reads the entire codebase (or large parts of it) to rebuild context it had five minutes ago.
2. **Session restart** — a new session throws away everything: architecture understanding, decisions, gotchas, test commands, user preferences.
3. **Wasted tokens & latency** — re-exploration costs thousands of tokens and minutes per session, multiplied across every session.
4. **Fragmented partial solutions** — MEMORY.md files, CLAUDE.md/AGENTS.md notes, and ad-hoc skills each solve one slice; none provide fast, structured, *relevance-ranked* recall across sessions.

**Goal**: a local-first, zero-cloud memory layer that makes any AI agent's second session (and every later one) start warm — injecting only *relevant* facts and code knowledge, never the whole repo.

### Success criteria (measurable)

| Metric | Target |
|---|---|
| Recall latency (warm session start) | < 50 ms |
| Context injected at session start | ≤ 2,000 tokens (budgeted) |
| First full index of ~1,000-file repo | < 10 s |
| Incremental scan (unchanged repo) | < 200 ms |
| Stale-answer risk | 0 — memories invalidated by content hash, not timestamps |

### Non-goals (v1)

- Cloud sync / multi-device (local-first; sync is a v3 concern).
- Embedding models / vector DBs (FTS5 + heuristics first; vectors are pluggable v2).
- Automatic code summarization via LLM (deterministic extraction only in v1).

---

## 2. Proposed Architecture

### 2.1 Core idea: three memory stores, one engine

```
┌─────────────────────────────────────────────────────────────┐
│                    AegisX-Memory Engine                     │
│                                                             │
│  ┌────────────┐   ┌───────────────┐   ┌─────────────────┐  │
│  │  FactStore │   │  Knowledge    │   │  SessionStore   │  │
│  │ (KV + FTS5)│   │  Graph        │   │ (handoff blobs) │  │
│  │ stable     │   │ (symbols,     │   │ compressed      │  │
│  │ preferences│   │  modules,     │   │ session         │  │
│  │ facts      │   │  decisions)   │   │ summaries       │  │
│  └─────┬──────┘   └──────┬────────┘   └───────┬─────────┘  │
│        └────────────┬────┴────────────────────┘            │
│                     ▼                                       │
│            ┌──────────────────┐   ┌───────────────────┐    │
│            │ SQLite (WAL)     │   │ Indexer           │    │
│            │ ~/.aegisx/       │   │ (hash-diff scan,  │    │
│            │  memory.sqlite   │   │  watch mode)      │    │
│            └──────────────────┘   └───────────────────┘    │
└─────────────────────────────────────────────────────────────┘
        ▲                            ▲
        │ CLI                        │ MCP (stdio JSON-RPC)
   human / scripts              AI agents (Claude, Cursor, etc.)
```

**Why three stores?** Separation by *mutability and purpose*:

- **FactStore** — stable facts that rarely change: user preferences, project stack, build/test commands, conventions. Keyed, dot-namespaced (`project.<repo>.test-cmd`). Recalled by FTS + workspace relevance, *never* by recency alone.
- **KnowledgeGraph** — structured code knowledge: symbols, module boundaries, decisions (ADRs), gotchas. Built deterministically from the indexer + explicit `save` calls. This is what replaces "read the codebase again".
- **SessionStore** — compressed session summaries for handoff ("what we did, what we learned, what's next"). Written at session end (`save`), injected on `resume`.

### 2.2 Indexing strategy — the anti-reread core

Deterministic, hash-based, incremental:

1. Walk the project tree, honoring `.gitignore` (via ignore-walk rules) and default skips (`node_modules`, `dist`, `build`, `.git`, lockfiles).
2. Hash each file (SHA-256 of content). Compare against the DB.
3. Only changed/new files are re-scanned; deleted files are tombstoned.
4. For each code file, extract cheap, language-agnostic signals (no full AST in v1):
   - top-level `export`/`def`/`class`/`function` declarations (line-anchored),
   - import/require edges → module dependency graph,
   - `// TODO|FIXME|HACK|NOTE` markers,
   - comment banners (`/* == Section == */`).
5. Store symbol records keyed by **content hash**, so a memory is only valid while the file is unchanged — auto-invalidation with zero heuristics.

Watch mode (`--watch`) re-scans on FS events so memory is never more than one edit stale.

### 2.3 Recall strategy — budgeted relevance, not recency

`recall(query?)` composes, under a hard token budget (default 2,000):

1. **Workspace match** — facts keyed to this repo path (always injected).
2. **FTS5 ranked hits** — query terms (or cwd-derived defaults) against FactStore + KnowledgeGraph.
3. **Structure brief** — top-level module map + key symbols (cheap, deterministic — replaces generic codebase re-read).
4. **Recent session handoff** — the last saved summary for this repo.

Each row carries a *source* (`fact | symbol | decision | gotcha | session`) and *confidence*; overflow drops lowest-ranked first, never silently truncates mid-fact.

### 2.4 Components & tech stack

| Component | Choice | Rationale |
|---|---|---|
| Language | TypeScript (Node ≥ 20, strict, ESM) | MCP SDK is TS-first; matches CLI tooling ecosystem |
| Storage | SQLite via `better-sqlite3`, WAL mode | Embedded, fast, FTS5 built-in, zero cloud |
| Ignore rules | `ignore` (npm) + explicit default skips | Correct .gitignore semantics without shelling out |
| CLI | `commander` | Thin, standard |
| MCP | `@modelcontextprotocol/sdk` | Official stdio server SDK |
| Tests | `vitest` | Fast, TS-native |

Monorepo layout (single package in v1):

```
aegisx-memory/
├── src/
│   ├── core/            # engine, stores, budget, ranking
│   ├── indexer/         # walker, hasher, extractor
│   ├── cli/             # command definitions
│   └── mcp/             # MCP stdio server
├── test/                # unit + integration
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 3. Data Schemas (SQLite DDL)

```sql
-- Facts: stable KV with full-text index
CREATE TABLE facts (
  id         INTEGER PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,          -- 'project.aegisx.test-cmd'
  value      TEXT NOT NULL,                 -- ≤ 500 chars, enforced in code
  repo_hint  TEXT,                          -- normalized repo path or NULL (global)
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE VIRTUAL TABLE facts_fts USING fts5(value, key, content='facts', content_rowid='id');

-- Files: index state (the invalidation ledger)
CREATE TABLE files (
  path       TEXT NOT NULL,                 -- repo-relative, POSIX separators
  repo       TEXT NOT NULL,                 -- normalized repo root
  hash       TEXT NOT NULL,                 -- sha256 of content
  size       INTEGER NOT NULL,
  mtime_ms   INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,    -- tombstone
  PRIMARY KEY (repo, path)
);

-- Symbols: extracted code knowledge
CREATE TABLE symbols (
  id         INTEGER PRIMARY KEY,
  repo       TEXT NOT NULL,
  file_path  TEXT NOT NULL REFERENCES files(repo, path) ON DELETE CASCADE,
  kind       TEXT NOT NULL,                 -- 'function'|'class'|'export'|'marker'|'import'
  name       TEXT,                          -- identifier or target module
  line       INTEGER NOT NULL,
  detail     TEXT                           -- extra context (e.g. TODO text)
);
CREATE INDEX idx_symbols_repo_file ON symbols(repo, file_path);
CREATE INDEX idx_symbols_name ON symbols(name);
CREATE VIRTUAL TABLE symbols_fts USING fts5(name, detail, content='symbols', content_rowid='id');

-- Decisions & gotchas: explicit, human-curated knowledge
CREATE TABLE knowledge (
  id         INTEGER PRIMARY KEY,
  repo       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('decision','gotcha','convention','lesson')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  anchors    TEXT,                          -- JSON array of file paths this applies to
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE VIRTUAL TABLE knowledge_fts USING fts5(title, body, content='knowledge', content_rowid='id');

-- Session handoffs
CREATE TABLE sessions (
  id          INTEGER PRIMARY KEY,
  repo        TEXT NOT NULL,
  goal        TEXT NOT NULL,
  facts       TEXT NOT NULL,                -- JSON: verified facts
  decisions   TEXT NOT NULL,                -- JSON: decisions + reasons
  next_steps  TEXT NOT NULL,                -- JSON: actionable list
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sessions_repo ON sessions(repo, created_at DESC);

-- Config / meta
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

**TypeScript contracts** (single source of truth in `src/core/types.ts`):

```ts
interface MemoryFact { key: string; value: string; repoHint: string | null; updatedAt: string }
interface SymbolRecord { filePath: string; kind: 'function'|'class'|'export'|'marker'|'import';
                         name: string | null; line: number; detail?: string }
interface KnowledgeRecord { kind: 'decision'|'gotcha'|'convention'|'lesson';
                            title: string; body: string; anchors: string[] }
interface SessionHandoff { goal: string; facts: string[]; decisions: string[]; nextSteps: string[] }
interface RecallResult { brief: string; facts: MemoryFact[]; symbols: SymbolRecord[];
                         knowledge: KnowledgeRecord[]; lastSession?: SessionHandoff;
                         tokenEstimate: number }
```

---

## 4. API Surface

### 4.1 CLI

```
aegisx init                      # create ~/.aegisx/, open DB, print setup hints
aegisx index [--watch] [path]    # full/incremental scan of a repo
aegisx recall [query]            # print budgeted context block (markdown, paste-ready)
aegisx remember <key> <value>    # save a fact  (repo_hint = cwd)
aegisx forget <key>              # delete a fact
aegisx save --goal "..."         # write session handoff (interactive JSON prompts)
aegisx resume [repo]             # print last handoff for repo
aegisx stats [repo]              # file counts, symbol counts, last scan time
```

All commands exit 0 on success, 1 on user error, 2 on internal error. Errors printed as single-line `error: <message>` (stderr).

### 4.2 MCP tools (stdio server, `aegisx mcp`)

| Tool | Input | Output |
|---|---|---|
| `aegisx_recall` | `{ query?: string, repo?: string }` | `RecallResult` as markdown |
| `aegisx_remember` | `{ key, value }` | confirmation |
| `aegisx_save` | `{ goal, facts[], decisions[], nextSteps[] }` | confirmation |
| `aegisx_index` | `{ path?, watch?: boolean }` | scan stats |

`repo` defaults to the MCP client's cwd-derived workspace root; keys are auto-namespaced by normalized repo path, preventing cross-project contamination.

---

## 5. Security & Privacy (STRIDE Matrix)

**Trust boundaries**: (T1) filesystem ↔ engine · (T2) AI agent ↔ MCP server · (T3) repo content ↔ indexer. Local-first: no network calls anywhere in v1.

| Threat | Vector | Impact | Mitigation |
|---|---|---|---|
| **S**poofing | rogue MCP client connects to server | memory poisoning | MCP stdio is parent-spawned only (no sockets); optional `AEGISX_ALLOWED_REPOS` allowlist |
| **T**ampering | attacker-edited code comment contains prompt-injection payloads ("ignore previous instructions…") | injected into agent context via recall | memories carry provenance (`source: code-comment`); recall output wrapped in unambiguous data block; docs advise treating recalled text as untrusted data |
| **R**epudiation | agent saves wrong facts, no trace | corrupt memory persists | facts and knowledge rows carry `updated_at`; `stats` shows counts; v2: append-only audit log |
| **I**nformation disclosure | secrets (`.env`, keys) indexed into symbols/FTS | secret leakage into prompts | indexer hard-skips dotfiles, `.env*`, `*.pem`, `*.key`, lockfiles; secret regex scan (sk-, ghp_, AKIA…) marks matches `redacted` and never stores them |
| **D**enial of service | huge repo / symlink loops blow up scan | engine unusable | depth cap (64), symlink refusal, per-file size cap (512 KB), total-file cap (50k) with explicit abort message |
| **E**levation of privilege | SQL injection via user-supplied key/query | arbitrary SQL | prepared statements everywhere (`better-sqlite3` defaults); keys validated `^[a-z0-9._-]{1,128}$` |

**Privacy invariants**

1. Local-only: no telemetry, no network I/O in v1 (verified in Gate 2 by network-module import ban).
2. Secrets never stored (regex scan at index + save time; test-enforced).
3. Uninstall = `rm -rf ~/.aegisx` — no residue.

---

## 6. Verification Plan (Dual-Gate)

**Gate 1 — Static**: `tsc --noEmit` strict · zero lint errors · no `any` · no TODO placeholders · secret-scan of our own repo.

**Gate 2 — Behavioral** (minimum per invariant):

- *Happy path*: `init → index fixture repo → recall` returns symbols + facts + brief within budget; `remember → recall` round-trip; `save → resume` round-trip.
- *Negative edge cases*:
  1. Empty repo / no DB → graceful message, exit 1, no crash.
  2. File with 0 symbols + unbalanced unicode → indexer survives, warns.
  3. Key violating namespace regex → rejected with clear error.
  4. 5 MB single file → skipped with warning (size cap).
  5. Symlink cycle → walk terminates, cycle logged.
  6. Secret-containing value in `remember` → refused.
- *Invalidation*: edit file → incremental scan → stale symbols tombstoned; recall no longer returns them.

**Perf smoke**: 1,000 synthetic files indexed < 10 s; unchanged re-scan < 200 ms.

---

## 7. Roadmap

- **v1 (this RFC)** — CLI + MCP, FactStore/KnowledgeGraph/SessionStore, hash-invalidated indexer, FTS5 recall. *(local-first, ~1 package)*
- **v2** — optional local embedding model for semantic recall, watch-mode daemon, audit log, per-agent adapters (Claude/Cursor config generators).
- **v3** — encrypted cross-device sync (CRDT merge), team-shared knowledge graphs.

---

*RFC ends. Phase 2 (strict implementation) follows the schemas and API above; deviations require an RFC amendment.*

**Amendment (v1.1):** `AEGISX_ALLOWED_REPOS` (§5, Spoofing mitigation) is now implemented in `src/core/paths.ts` + `Engine` — colon-separated normalized repo paths, fail closed when set but empty, enforced on `indexRepo`/`remember`/`saveSession`/`driftCheck`/`statsFor`/`purgeTelemetry`/`recall`/watch-mode start, with cross-project knowledge filtering for repo-less global recall. `mcp-config` propagates the variable into generated server blocks.

**Amendment (v1.2):** Secret hygiene (§5, Information disclosure) is unified: `src/core/secrets.ts` is the single detector (token prefixes + credential-named assignments + URL-embedded credentials), applied per-line by the Indexer and whole-string by `Engine.remember` and `Engine.saveSession` — closing the handoff-path gap. The HTTP bearer check (`serve`) is constant-time via SHA-256 digest + `timingSafeEqual`, and empty-token credentials are normalized to "no token" so they cannot bypass the non-localhost bind guard.

**Amendment (v1.3):** HTTP DoS hardening (§5, Denial of service): `aegisx serve` caps request bodies at 1 MB (`MAX_HTTP_BODY_BYTES`, 413) — declared `Content-Length` is rejected before reading; chunked bodies are counted in flight and the socket destroyed past the cap. POST bodies are buffered by the server and passed to the MCP transport pre-parsed (SDK `parsedBody` seam) so the cap is authoritative; malformed JSON gets a 400, and transport errors are funneled through a safe response path that never writes after end (no unhandled rejections, no process crash).

**Amendment (v1.4):** Information disclosure (I): the memory home is created `0700` and the DB file chmod'd `0600` best effort on every open (`src/core/db-perms.ts`, shared by Store and Indexer). Denial of service (D): telemetry tables get a 30-day retention cap (`TELEMETRY_RETENTION_MS`) pruned opportunistically on every index and explicitly via `Engine.purgeStaleTelemetry()`. Verified end-to-end: an MCP stdio integration test (`test/mcp-stdio.test.ts`) spawns the real CLI server over `StdioClientTransport` and asserts a denied repo returns a clean `isError` tool result while the server stays alive.
