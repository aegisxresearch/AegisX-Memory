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
- **KnowledgeGraph** — structured code knowledge: symbols, module boundaries, decisions (ADRs), gotchas, conventions. Built deterministically from the indexer + explicit `save` calls. This is what replaces "read the codebase again".
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
2. **FTS5 ranked hits** — query terms against FactStore + KnowledgeGraph, repo-scoped. With *no* query the recall is anchored instead: this repo's facts and this repo's knowledge, plus the deterministic top-symbol list. A repo path is never used as a search seed (v1.14).
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

-- Decisions, gotchas & conventions: explicit, human-curated knowledge
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
  gotchas     TEXT NOT NULL DEFAULT '[]',   -- JSON: traps worth avoiding (v1.16)
  conventions TEXT NOT NULL DEFAULT '[]',   -- JSON: project rules (v1.16)
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
interface SessionHandoff { goal: string; facts: string[]; decisions: string[];
                            gotchas: string[]; conventions: string[]; nextSteps: string[] }
// callers may omit gotchas/conventions: SessionHandoffInput keeps them optional
interface RecallResult { brief: string; facts: MemoryFact[]; symbols: SymbolRecord[];
                         knowledge: KnowledgeRecord[]; lastSession?: SessionHandoff;
                         tokenEstimate: number }
```

---

## 4. API Surface

### 4.1 CLI

```
aegisxmemory init                      # create ~/.aegisx/, open DB, print setup hints
aegisxmemory index [--watch] [path]    # full/incremental scan of a repo
aegisxmemory recall [query]            # print budgeted context block (markdown, paste-ready)
aegisxmemory remember <key> <value>    # save a fact  (repo_hint = cwd)
aegisxmemory forget <key>              # delete a fact
aegisxmemory save --goal "..."         # write session handoff (interactive JSON prompts)
aegisxmemory resume [repo]             # print last handoff for repo
aegisxmemory stats [repo]              # file counts, symbol counts, last scan time
```

All commands exit 0 on success, 1 on user error, 2 on internal error. Errors printed as single-line `error: <message>` (stderr).

### 4.2 MCP tools (stdio server, `aegisxmemory mcp`)

| Tool | Input | Output |
|---|---|---|
| `aegisxmemory_recall` | `{ query?: string, repo?: string }` | `RecallResult` as markdown |
| `aegisxmemory_remember` | `{ key, value }` | confirmation |
| `aegisxmemory_save` | `{ goal, facts[], decisions[], gotchas[]?, conventions[]?, nextSteps[] }` | confirmation + how many notes were new |
| `aegisxmemory_index` | `{ path?, watch?: boolean }` | scan stats |

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

**Naming note (v1.1):** the CLI binary and MCP tool names are `aegisxmemory`
(e.g. `aegisxmemory index`, tools `aegisxmemory_recall` …). Configs generated
before the rename used the short `aegisx` name; `doctor` still recognizes the
legacy name when inspecting agent configs.

**Amendment (v1.5):** `mcp-config --install [--agent hermes|claude|cursor|all]`
now writes the MCP registration directly into agent config files — creating,
backing up (`<file>.aegisx-bak`), and merging idempotently; unparseable configs
are refused rather than overwritten. The two harmless empty default shapes
(`mcp_servers:` unset key, `mcp_servers: []`) are converted to a mapping
in place; non-empty non-mapping shapes still require manual merging. Doctor's Hermes parser accepts both
quoted and unquoted scalar values, so auto-generated entries are detected.

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

**Amendment (v1.3):** HTTP DoS hardening (§5, Denial of service): `aegisxmemory serve` caps request bodies at 1 MB (`MAX_HTTP_BODY_BYTES`, 413) — declared `Content-Length` is rejected before reading; chunked bodies are counted in flight and the socket destroyed past the cap. POST bodies are buffered by the server and passed to the MCP transport pre-parsed (SDK `parsedBody` seam) so the cap is authoritative; malformed JSON gets a 400, and transport errors are funneled through a safe response path that never writes after end (no unhandled rejections, no process crash).

**Amendment (v1.4):** Information disclosure (I): the memory home is created `0700` and the DB file chmod'd `0600` best effort on every open (`src/core/db-perms.ts`, shared by Store and Indexer). Denial of service (D): telemetry tables get a 30-day retention cap (`TELEMETRY_RETENTION_MS`) pruned opportunistically on every index and explicitly via `Engine.purgeStaleTelemetry()`. Verified end-to-end: an MCP stdio integration test (`test/mcp-stdio.test.ts`) spawns the real CLI server over `StdioClientTransport` and asserts a denied repo returns a clean `isError` tool result while the server stays alive.

**Amendment (v1.6):** `aegisxmemory dashboard` (`src/cli/dashboard.ts`) — a read-only local web view of the memory: totals cards, a recall-history bar chart (hit vs miss), per-repo hit-rate table, pinned facts and recent handoffs, refreshed client-side every 10s from a single `GET /api/data` JSON endpoint composed by `Engine.dashboardData()`. Security posture: binds `127.0.0.1` only (hardcoded; `startDashboard` throws for any other host), no auth surface because it is loopback-only, serves self-contained inline CSS/JS (no CDN, works offline), and renders all stored data exclusively via `textContent`/`createElement` so stored fact values can never inject markup (XSS-safe by construction).

**Amendment (v1.7):** (a) `Engine.graphData()` + dashboard `GET /api/graph`: a node/edge projection of stored memory (repos as hubs; facts `belongs to`, knowledge `learned in`, handoffs `summarizes`) rendered client-side as an interactive force-directed SVG knowledge graph — same loopback-only, no-CDN, `textContent`-only posture as §v1.6; deterministic id-hash radial seeding keeps layouts stable across refreshes. (b) MCP stdio server exposes a fifth tool, `aegisxmemory_graph`, returning an indented text rendering of the same projection for agent consumption. (c) `mcp-config --install --rules` (`installRulesForAgent`, `src/cli/auto-setup.ts`) writes a marker-wrapped standing-behavior block (auto recall at session start, immediate remember of stable facts, save handoff at session end, secret refusal) into the agent's standing-instructions file — Hermes `~/.hermes/SOUL.md` (with an identity seed when the file is created fresh, per the official prompt-assembly docs), Claude `~/.claude/CLAUDE.md`, Cursor `~/.cursor/rules/aegisx-memory.mdc`; idempotent, backed up, and never modifying content outside the marker block, so rules make memory automatic without ever hand-editing identity.

**Amendment (v1.8):** Fact history. `remember` on an existing key whose **value actually changed** stores the superseded value in a new `fact_history` table (bounded to `FACT_HISTORY_MAX` = 10 per key, newest first; re-pinning the identical value records nothing, so agent repetition cannot flood the timeline; `forget` deletes a key's history with it so a removed credential-shaped fact cannot survive there). `MemoryFact.previousValue` is populated on reads, recall renders `- [key] value — was: old (changed YYYY-MM-DD)`, the MCP `remember` result says `replaced previous value: …`, and a new `aegisxmemory history [key]` command prints the timeline. The dashboard surfaces the same signal: `Store.listFacts` selects the newest superseded value, so the pinned-facts panel marks a re-pinned key with a `changed` badge and its replaced value — one notion of "changed" shared by the CLI, MCP, and the dashboard.

**Amendment (v1.10):** Dashboard UI/UX revamp — the security posture of §v1.6/v1.7 is unchanged in substance, but presentation is now layer-separated. (a) A semantic token layer (`--bg`, `--surface`, `--surface-hover`, `--fg`, `--fg-muted`, `--border`, `--accent`, `--ok`, `--warn`, radius/spacing/duration scales) is declared once in `:root`, with the dark palette as the single `:root[data-theme="dark"]` override; a head script resolves auto → system (`prefers-color-scheme`) or an explicit Light/Dark override in `localStorage` **before first paint**, so the page never flashes the wrong theme, and the topbar button cycles the three modes. (b) The document, `/app.css` and `/app.js` are now three assets served from this origin instead of one inlined page — still no CDN, no external requests, no build step, and stored data still reaches the DOM only through `textContent`/`createElement`. (c) Flicker was removed: sections are updated in place and rebuilt only when their data signature changes, so polling no longer discards scroll position, hover state, focus, or graph layout. (d) The graph's animation loop is a single module-scoped handle guarded against re-entry, stopped on `visibilitychange` while the tab is hidden, and skipped entirely (bounded settle instead) under `prefers-reduced-motion` — the previous code re-declared its handle inside `render()`, so `cancelAnimationFrame` never fired and a new loop accumulated on every 10 s refresh. (e) Accessibility went from zero to: skip link, `header`/`main` landmarks, labelled sections, `aria-live="polite"` connection status (live / offline with last-good time), focus-visible rings, keyboard-reachable chart bars with per-bar labels and an HTML tooltip, and a List-view table fallback for the graph. (f) `test/dashboard.test.ts` locks the new contract in: asset serving and content types, the token/theme selectors, the a11y hooks, the single-loop guard, and a same-origin-only assertion scanning every served asset for external URLs.

**Amendment (v1.9):** Symbol extraction (§4 step 4) is no longer JS/TS-shaped. `SYMBOL_LINE` (`src/indexer/indexer.ts`) now accepts the declaration modifiers that precede the keyword in most languages (`public class`, `pub unsafe fn`, `data class`, `typedef struct`, `sealed class`, `suspend fun`, `export default async function`), leading annotations, the C++/C# compound forms `enum class` / `record struct`, generic parameters (Kotlin `fun <T> map`, Go `func Map[T any]`) and Go receivers (`func (s *Server) Start`), and it recognises the declaration keywords of every language family in use: `function|class|def|struct|impl|trait|type|interface|enum|union|module|mod|record|object|namespace|func|fn|fun`. A second pattern, `TYPED_FUNCTION_LINE`, covers keyword-less C-family / Java-style signatures (`int main(int argc, char **argv)`, `std::string name(void)`, `static bool ready(void)`, `public async Task<Order> PlaceAsync(`) and emits `function`; it is restricted to a curated builtin-type list plus Capitalized/qualified names so control flow (`else if (`, `return f(`) and assignments (`Foo bar = make();`) are never mistaken for declarations. Both patterns remain anchored at column 0 — the indexer has no extension allowlist, so indentation-tolerant matching would also pick up prose inside docs and template strings; indented members are therefore explicitly out of scope, consistent with the original "top-level declarations" contract. `SymbolKind`/`DECLARATION_KINDS` were extended in lockstep (the drift that made Python briefs empty in §v1.8's aftermath), and `test/symbols.test.ts` locks in one test per language (Java, C#, Kotlin, Go, Rust, C, C++) plus negative cases and an end-to-end Go brief/recall check.

**Amendment (v1.11):** (a) A knowledge entry is now identified by `(repo, kind, title)` — the same way a fact is identified by its key. `Store.saveKnowledge` upserts (`ON CONFLICT(repo, kind, title) DO UPDATE`); a byte-identical re-record is a no-op so `updated_at` cannot churn from an agent repeating itself, and a re-record that changes body/anchors returns `KnowledgeRecord.updated = true`, mirroring `MemoryFact.previousValue`, so a caller can report "updated" rather than "added". A unique index (`idx_knowledge_identity`) enforces the rule, and databases written before it are migrated on open: duplicate groups collapse to the newest row (id order tracks write order) *before* the index is created. When a collapse is needed the FTS index is rebuilt first — `knowledge_fts` is an external-content table, so a legacy DB may hold rows the index never saw, and deleting one of those makes FTS5 report a malformed image instead of deleting cleanly. (b) Two query defects surfaced while testing that path. `buildFtsQuery` (`src/core/fts.ts`) joined expanded term groups with a bare space, but FTS5 rejects the juxtaposition of two parenthesised expressions — `("sqlite" OR "db") ("locking" OR "lock*")` is a syntax error — so every query whose terms *both* expanded (e.g. `recall "sqlite locking"`) failed with `fts5: syntax error near "("`; clauses are now joined by an explicit `AND`, a repeated operator is dropped, and each multi-term shape is asserted against a real in-memory FTS5 table. `Engine.recall` also escaped its query and then passed the *escaped* string to `Store.searchFacts`, `Store.searchKnowledge` and `Indexer.searchSymbols`, all of which escape free text themselves: the query was escaped twice, drowning `rank` in synonyms-of-synonyms and re-creating the same syntax error. Those calls now receive the original free text, and `ftsEscape` is only the "is there anything searchable here?" gate.

**Amendment (v1.12):** Dashboard response hardening (§5, Tampering/Elevation). Every response — the document, `/app.css`, `/app.js`, both JSON endpoints, and 404s — now carries a `Content-Security-Policy` built per response around a fresh 16-byte base64 nonce (`default-src 'none'; script-src 'self' 'nonce-…'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`) plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. The only inline script is the pre-paint theme bootstrap of §v1.10a, and it is authorised by that nonce, which changes on every response — a nonce that never changes is decoration, not a boundary. This preserves the §v1.10 "assets from this origin, no CDN" property while making the "a stored fact value cannot execute" claim structural rather than a consequence of `textContent` discipline. Also fixed: the graph panel's `Loading…` skeleton was never removed (it sat above the canvas forever, and a failed `/api/graph` fetch left it stuck as "Loading…"), so `mountGraph` clears the host before mounting and a failed fetch renders an explicit "Graph unavailable" line instead of stalling silently.

**Amendment (v1.13):** The knowledge store had no producer. Nothing under `src/` ever called `Store.saveKnowledge` — `saveSession` wrote only the `sessions` row — so the pillar §2.1 calls the KnowledgeGraph was always empty: recall's "Decisions & gotchas" block never rendered, `stats` and the dashboard reported `Knowledge 0`, and the graph never drew a knowledge node, even for repos with many recorded decisions. A handoff's `decisions` array is the only place a decision is ever captured, so `Engine.saveSession` now records each one as a `decision` entry, upserted by its sentence (§v1.11) and scoped to the repo, with no anchors. A decision is one self-contained sentence with no separate heading, so the sentence is both title and body; `knowledgeTitle()` truncates it to `KNOWLEDGE_TITLE_MAX` *deterministically*, so a long sentence keeps the same identity across sessions and still upserts onto itself, while the untruncated text stays in the body so no word becomes unfindable. `saveSession` returns a `SessionSaveSummary` — `decisionsRecorded` (new entries, by count delta) and `decisionsAlreadyKnown` (the remainder, which is what re-recording looks like) — printed by the CLI as `session handoff saved — 2 decisions recorded` / `— 2 already known`, added to its `--json` payload, and returned as tool text by both MCP save tools; `describeSessionSave` is the single formatter. Recall renders a knowledge line once: when the body *is* (or begins with) the title it prints the sentence alone rather than `**title** — body`, which would spend the recall budget on the same words twice. The injected rules block (§v1.7c) now says where a gotcha belongs — the handoff's `decisions` list. Left deliberately unchanged: repo-scoped recall *without* a query still ranks knowledge by the effective query (the repo path), so decisions surface through a focused query or the last-handoff section rather than as a repo-anchored block at session start; `knowledgeForRepo` exists for that shape but is unreachable from `recall` today. **[Superseded by v1.14.]**

**Amendment (v1.14):** A query-less recall is now anchored end to end. `recall(null, repo)` used the repo path as its effective FTS seed, which made the anchors decorative: the repo's own decisions were returned only if their text happened to contain path tokens — so the "Decisions & gotchas" block that §v1.13 populates stayed invisible at session start — and `Store.searchFacts`, the one search here with no repo predicate, returned another project's fact whenever that fact named this repo's path verbatim (a phrase match needs the whole path, but "diff against /path/to/alpha before merging" is exactly the kind of note a sibling checkout produces). `Engine.recall` now branches on `anchored = query === null && repo !== null`: facts come from `factsForRepo`, knowledge from `knowledgeForRepo`, symbols from `topSymbols`, and no FTS search runs at all. Supplying a query restores ranked behaviour, with knowledge searched through the already repo-scoped `searchKnowledge` (and allowlist-filtered when the recall has no repo). The FTS escape remains only as the "is there anything searchable here?" gate (§v1.11b). `test/knowledge.test.ts` locks both halves — the repo's own decision appears without a query, and a fact in another repo that names this repo's path does not — and both tests fail against the previous implementation.

**Amendment (v1.15):** Knowledge backfill. Sessions stored before v1.13 are the only record of the decisions taken in them, so an upgrade would still have shown only what happened *after* it. `Store` now folds each stored handoff's `decisions` into knowledge on the first open after the upgrade, through the same `recordHandoffNotes` the live save path uses: upserted by sentence (a line repeated across several handoffs becomes one entry, and the whole scan is idempotent), scoped to the handoff's repo, and with anything matching `containsSecret` skipped rather than re-published — rows written before the storage-time secret scan (§v1.2) can still hold a credential, and copying one into a new table would undo exactly what that scan was added to prevent. The scan runs once per database, recorded in the `meta` table under `knowledge-backfill` as `{sessions, recorded, alreadyKnown, skippedSecrets, at}`, which `doctor` surfaces as its own check (`knowledge backfill: 3 entries from 3 old handoffs, 1 already known`) so a migration that happens on open is not invisible; a mangled `decisions` column is skipped instead of aborting the open. `Engine.knowledgeBackfillReport()` is the read seam and `DoctorEngine` mirrors it. Tests cover the fold, the cross-handoff collapse, the once-only marker, the secret skip, the malformed column, and the doctor line. Not included: `gotchas` and `conventions` as their own handoff fields and knowledge kinds — the schema, CLI parser, MCP tool schemas and `sessions` columns would all have to grow, and the handoff has no such field today, so a gotcha is still recorded by putting it in `decisions` (where it lands as `kind: decision`). **[Implemented in v1.16.]**

**Amendment (v1.16):** Gotchas and conventions are first-class handoff notes. `SessionHandoff` gains `gotchas[]` and `conventions[]`, stored in two new `sessions` columns (`TEXT NOT NULL DEFAULT '[]'`, added by `ALTER TABLE... ADD COLUMN` on open when missing — the first column migration here, and the default keeps existing rows valid). Because breaking every agent that only knows the original four fields would be worse than any tidiness, the caller edge stays tolerant: `SessionHandoffInput` keeps both lists optional, the CLI parser accepts their absence, and both MCP `save` tool schemas mark them `.optional()` — `Engine.saveSession` normalizes once (`?? []`) before the secret scan, the stored row, and the knowledge notes, so a credential hiding in a gotcha is refused exactly like one in a decision. `recordHandoffNotes` is kind-aware (`decisions` → `decision`, `gotchas` → `gotcha`, `conventions` → `convention`), all still upserted by sentence through `knowledgeTitle`, and `SessionSaveSummary`/`describeSessionSave` now count `notesRecorded`/`notesAlreadyKnown` ("2 notes recorded, 1 already known") since they no longer describe decisions alone; the CLI's `--json` payload carries the same pair under `knowledge`. Recall's knowledge heading becomes `## Decisions, gotchas & conventions`, the last-handoff section prints `Gotchas:` and `Conventions:` blocks, the dashboard's handoff line and graph sub-label count them, and the injected rules block (§v1.7c) now names the matching list for each note kind. The backfill (§v1.15) learned the two lists and — more importantly — got a **version**: the `meta` marker records `version: 2`, and a scan is skipped only when the recorded version is at least the current one, so a marker written by the previous backfill (no `version` field) counts as 0 and an install that already ran it re-scans once, folding the gotchas and conventions the older scan could not see while decisions upsert onto themselves instead of duplicating. Tests cover the three kinds, the round-trip through `resume`, an old-shaped handoff, a secret in a gotcha, the column migration, and the version-bumped re-scan — plus two MCP stdio tests asserting the old four-field shape still saves over the wire and that gotchas/conventions survive the tool schema.

**Amendment (v1.17):** Recall no longer prints a note twice. A handoff note *is* a knowledge entry — the same sentence, and `knowledgeTitle` derives the same title in both places — so a composed recall that showed both the `## Decisions, gotchas & conventions` block and the `## Last session handoff` block printed every note written in the most recent session twice, spending the budget on the same words. `Engine.recall` now drops the knowledge entries whose title that handoff reprints, deriving the reprinted titles exactly the way the store does (`handoffNoteTitles`, so an over-long sentence clipped to `KNOWLEDGE_TITLE_MAX` still matches) and keeping the handoff's copy because it is the newer context. Deduping at composition rather than at render time keeps the budget estimate and the knowledge telemetry honest, and every consumer (`recall --json`, the CLI markdown, both MCP tools) sees the same composed result. Nothing becomes unfindable: a note is served from the handoff while that handoff is the latest one, and from the knowledge store as soon as a later handoff takes the slot — which is the whole point of recording it as knowledge in §v1.13. Tests assert the sentence appears exactly once in both situations (`toContain` cannot see a duplicate), and the two MCP stdio tests save a second handoff before asserting the knowledge block.

**Amendment (v1.18):** The dashboard graph is a deterministic projection, not a physics toy. The previous client created a fresh `requestAnimationFrame` handle inside every render, so the loop it meant to cancel kept running and every 10 s poll restarted the layout from scratch — nodes jumped, drags were lost, and the view flickered. `src/cli/dashboard.ts` now computes a **clustered layout** once per data signature (repos spaced on a ring, each hub's neighbours fanned out around it, orphans on an outer ring) and keeps it: `updateGraph` compares a signature of `(id|kind|label|sub)` plus edges and filter state, and an unchanged signature returns before touching the DOM. Rebuilds happen **in place** (`syncDom` reuses the existing `circle`/`text` per node id, `removeNode` retires the rest), so scroll, focus and node positions survive a poll. The layout stops as soon as `G.energy` settles, and `visibilitychange` stops the single loop while the tab is hidden. Interaction is zoom/pan/fit (buttons, wheel with `passive:false`, `+`/`-`/`0`), per-kind filter chips with an `N filtered out` badge, hover/select focus that dims non-neighbours, a detail panel with the selected node's links, and keyboard navigation on a roving tab stop (`ArrowUp/Down/Left/Right`, `Enter`, `Escape`) announced through `#graph-live`; `List view` renders the same nodes as a table. The page is restyled onto one token layer (80+ semantic custom properties for colour, spacing, radius, shadow and easing, light and dark) with no component-level colour literal, and the served HTML is landmarked (`header`/`main`, skip link, visible focus ring). Because `APP_JS` is a string the Node test process never renders, `test/dashboard.test.ts` executes it against a DOM shim with the **real** `/api/graph` payload and asserts what was previously only claimed: the node count matches the projection, every node lands inside the view box and no two nodes overlap, a second identical poll leaves every coordinate byte-identical, the kind filter hides exactly that kind, the table holds exactly the visible rows, and the loop settles in under 400 frames. The same tests found two genuine client-side defects (a stuck `Loading…` skeleton, and circles that must be reached from the document tree) and lock both.

**Amendment (v1.19):** Two dashboard read-outs gained their missing detail. (a) **The graph detail panel names what it is showing.** `Engine.graphData()` nodes now carry `repo: string | null` alongside `label`/`sub` (the repository a fact/knowledge/handoff belongs to, resolved at projection time rather than by walking `belongs to` / `learned in` / `summarizes` edges on the client), so the panel can report a node's **kind** and **repo** as metadata and render its **full stored text** — a fact's `key = value`, a knowledge entry's title and body, a repo's path, a handoff's goal and note counts — untruncated, in a monospace block, next to a **copy button** that hands that exact text to the clipboard (with a `copied` confirmation and a `document.execCommand` fallback). The node label is shown as before; the copy payload is `nodeText(n)`, one definition shared by the panel and the button. (b) **The recall chart labels every bar and is navigable from the keyboard.** Each bar gets a visible value label using a compact `1.2k` formatter — horizontal while the slot is at least 22 view-box units, rotated −90° once bars get narrow, so no bar is left unlabelled — and hover/focus emphasises the matching label. The legend now spells out the whole encoding (warm-hit count, cold-miss count, bar height ≈ tokens returned, peak) and names the keyboard gesture. The chart is a **single Tab stop**: `chartRoving` keeps a roving `tabindex` across the bars (instead of making every bar its own stop), and `chartKey` handles `ArrowLeft`/`ArrowRight`/`ArrowUp`/`ArrowDown` plus `Home`/`End`, clamped at both ends, moving focus and the tooltip together; the panel's `aria-label` states the gesture. `test/dashboard.test.ts` runs the served `/app.js` against the DOM shim for both: the detail test clicks a knowledge node and asserts kind, repo, untruncated body and the clipboard payload, and the chart test asserts one label per bar (values matched against the payload), the legend text, and that the roving tab stop moves and clamps under arrow keys. The shim's `focus()` now dispatches `{ target: this }`, matching the DOM, which is what the chart's focus handler reads. Live check on the built CLI: `/app.js` passes `node --check`, `/api/graph` reports `repo` on every node kind, and the response still carries the §v1.12 per-response CSP nonce. Not changed: the chart still draws every recall in `dashboardData().recalls` (no client-side cap) and labels are best-effort legibility at extreme densities — the tooltip and `aria-label` remain authoritative there. **[Both of those "not changed" clauses are superseded by v1.20, which caps the drawn window and replaces the rotated-label fallback with a zoom toggle.]**

**Amendment (v1.20):** The recall chart draws a bounded, recent window and can be widened on demand. (a) **Cap.** `renderChart` now draws only the most recent `CHART_MAX` = 30 recalls (`recalls.slice(-CHART_MAX)`). **[The fixed constant is superseded by v1.21, where the reader picks the window and both chart preferences are remembered.]** The tail is the recent end because `Store.recentRecalls` already returns ascending order — it reverses the `ORDER BY created_at DESC, id DESC` query — which the oldest→newest axis line assumes. Drawing every recall the endpoint returned (up to 50) was what made a horizontal value label stop fitting its slot, so the cap is the mechanism that keeps labels legible; the `rotate(-90)` label fallback of v1.19 is therefore **removed** rather than left as unreachable code, and the `dense` branch with it. The window is never narrowed silently: the section badge reads `last 30 of 143 events` and the axis line reads `showing the last 30 of 143 recalls` whenever `shown.length < total`, and the hit/miss counts, legend and `peak` tick are all computed over the drawn set so they always agree with the bars. (b) **Zoom toggle.** A `#chart-zoom` button in the block head (`aria-pressed`, label `Zoom` → `Fit`) switches between fit-to-width (`viewBox 0 0 960 152`, `width: 100%`, labels at 9.5 view-box units) and a wider canvas (`W = max(960, n × 44)`, `width: W px`, labels at 11) inside a horizontally scrollable `.chart__scroll`; while zoomed the legend says `scroll sideways for the whole chart`. At high density the answer is therefore more pixels, not squeezed text — which is what the rotation attempted and could not deliver. The section cache key includes the mode and the total, so toggling forces a rebuild while an unchanged poll still skips one; `updateChartToggle` runs on every render (before the `section` short-circuit) so the button's label, `aria-pressed` and disabled state track the data. Two supporting changes: `compact()` is bounded to five characters (`999`, `1.2k`, `12.3k`, `124k`, `1.2M`) so a label fits the narrowest slot the cap allows, and `.blabel` gains the graph label's `paint-order: stroke` halo so it stays readable where a gridline or tick sits under it. `test/dashboard.test.ts` seeds 35 recalls and asserts exactly 30 bars — raising `CHART_MAX` makes it fail with `expected 35 to be 30`, so the lock is real — plus the stated window in both the badge and the axis, and that the toggle produces an explicit pixel canvas wider than 960 with 11-unit labels, no `transform` on any label, `aria-pressed="true"` and label `Fit`, returning to fit on a second click. Full suite 224 tests; `/app.js` verified with `node --check` and the served page verified to carry the control.

**Amendment (v1.21):** The chart window is the reader's choice, and both chart preferences persist. (a) **Picker.** The fixed `CHART_MAX` of v1.20 is replaced by `CHART.cap`, chosen from a `Show` `<select>` in the block head (`10 / 30 / 50 / All`; the internal value `0` means every recall the endpoint returned — the server still bounds the payload at `recentRecalls(50)`, so `All` is "all of the returned window", which the badge and axis state rather than hide). `capFromValue` validates against `CAP_CHOICES` and falls back to `CHART_DEFAULT_CAP` = 30, so a hand-edited or stale stored value draws the default instead of an empty chart, and `updateChartPick` keeps the control in step with state and disables it when there is nothing to draw. The section cache key gained `CHART.cap`, so a change forces a rebuild while an unchanged poll still skips one. (b) **Persistence.** The cap and the zoom toggle are written to `aegisx-chart-cap` / `aegisx-chart-wide` and read back when the script evaluates (`storedCap` / `storedWide`), the same shape as the theme's `aegisx-theme`: every `localStorage` access is wrapped so a private-mode failure degrades to the default silently instead of breaking the chart. `saveCap` / `saveWide` run from the `change` / `click` handlers, so a stored value always reflects a real reader action. Scope note: the pre-paint theme bootstrap stays inline-and-nonced as in v1.10/v1.12; these two preferences are read by `/app.js` after load, so a chart preference applies one paint later than the theme does — the trade for not growing the inline bootstrap. `test/dashboard.test.ts` drives the real `<select>` through a Map-backed `localStorage` shim: the default is 30 and nothing is written until the reader acts, narrowing to 10 redraws ten bars and writes `aegisx-chart-cap=10`, zooming writes `aegisx-chart-wide=1` without disturbing the cap, a second script run against the same storage starts at ten bars, zoomed, with an explicit pixel canvas, `All` lifts the cap to the full payload, and a junk stored value falls back to 30. Making `CHART` ignore the stored values fails the test (`expected '30' to be '10'`), so the lock is real. Full suite 225 tests.

**Amendment (v1.22):** Zoom no longer strands the focused bar. Once the canvas is wider than its panel (§v1.20–v1.21), the bar the reader is on can sit past the edge — reachable by keyboard but invisible. `keepBarInView(bar)` now scrolls `.chart__scroll` by the minimum amount needed to bring the bar back, with a 24px pad so it is not flush against the border, clamped to `[0, scrollWidth − clientWidth]`. It is called from a bar's `focus` handler — which covers Tab, a click, and every arrow step, since `chartFocus` focuses the bar it moves to, and the tip is positioned *after* the scroll so it lands on the right bar — and once after the zoom toggle, because widening changes the geometry without firing a focus event. The guard is `scrollWidth > clientWidth`: fit mode has nothing to scroll, so it returns immediately, which is also what keeps a 10s poll from ever moving the reader's view. Two latents were fixed alongside: `renderChart`'s empty branch did not reset `CHART.bars` / `CHART.scroll`, so a chart that emptied kept a detached scroll box and a stale bar list for the keyboard handlers to act on; and `CHART` gained an explicit `scroll` reference rather than re-querying the DOM on every keypress. To make this testable rather than merely asserted, the test shim's geometry became real for the elements involved: a `.bar` reports its own `x` / `width` shifted by the scroll offset of its `chart__scroll` ancestor, a scroll box reports a stand-in `clientWidth` (960 — the fit view box) and a `scrollWidth` taken from an explicit pixel-width SVG, and `scrollLeft` is a writable number. `test/dashboard.test.ts` then asserts behaviour: at cap 30 zoomed, `End` scrolls (`scrollLeft > 0`) and leaves the last bar inside `[0, clientWidth]`, `Home` scrolls back to 0, and in fit mode `End` moves nothing. Removing the focus-handler call fails the test with `expected 0 to be greater than 0`. Full suite 225 tests.

**Amendment (v1.23):** Keeping the focused bar visible now covers both axes, and its detail is readable without a pointer. (a) **Vertical.** The chart owns no vertical scroller (`.chart__scroll` is `overflow-y: hidden`), so a short viewport is the page's job. The old early return — `if (!(box.scrollWidth > box.clientWidth)) return` — was hoisted out of the way: `keepBarInView` now tests the two axes independently, so the vertical path also runs in *fit* mode, which is the point, since viewport height has nothing to do with zoom. It scrolls up when `br.top < 0` and down when `br.bottom > vh`, with an 8px pad, and is guarded on `window.innerHeight > 0` plus `typeof window.scrollBy === 'function'` so a harness without layout no-ops instead of throwing. (b) **Inline readout.** The floating tooltip only exists under a pointer and is clipped by its own `max-width`, so the focused bar's full text is mirrored into `#chart-readout`, an `aria-live="polite"` paragraph placed as a **sibling** of `#chart` — inside it, `section()`'s rebuild would wipe the line on every cap or zoom change. Focus sets it to the bar's tooltip text, blur restores the discoverability hint (`Tab to a bar, then use ← → to read its full detail here.`), and an emptied chart resets it too. It is deliberately focus-only: hover already has the floating tooltip, and mirroring on hover would make the line flicker as the pointer crossed the bars. `setReadout` is idempotent (it compares the last text), so a repeated poll cannot re-announce the same string. To test the vertical path the shim gained the last piece of geometry it lacked: a `.bar` reports `top`/`bottom` from its own `y`/`height` minus a module-level page-scroll offset, `runApp` takes a window shim so `innerHeight`/`scrollBy` are real, and that offset resets per test. `test/dashboard.test.ts` asserts that a bar starting below the fold of a 130px viewport is scrolled into `[0, vh]` by focusing it (`pageScrollY > 0`), that a page already scrolled 400px past the chart is scrolled back up, and that the readout equals the focused bar's own `aria-label` (i.e. it carries the query). Negatives: forcing `vh = 0` fails with `expected 0 to be greater than 0`, and dropping `setReadout` from the focus handler leaves the hint text in place. Full suite 226 tests.

**Amendment (v1.24):** The inline readout became actionable and pointer-aware. (a) **Copy.** `#chart-copy` is wired through the shared `wireCopy(btn, payload)` helper — the same control every fact and node wants — but with a **function** payload resolved at *click* time (`readout.textContent`) rather than a snapshot, which is what makes the button follow whichever bar is current instead of the one that happened to be current when the button was created. It is `disabled` while the readout still shows the hint (nothing to copy), flips to `copied` for 1.6s on success, and keeps the `document.execCommand` fallback. (b) **Hover follows too, without flicker.** The readout previously mirrored focus only, because mirroring hover directly would make the line strobe as the pointer crossed bars. Now hover *previews* it through `previewReadout`, debounced by `READOUT_HOVER_MS` = 120ms, while focus still commits immediately through `commitReadout`. Both share one monotonically increasing `readoutSeq`: each call takes a token and a timer only writes if its token is still current, so no handle needs cancelling and a stale sweep can never win — a fast pass over three bars settles on the last. Focus overrides hover (blur restores the hint only when `CHART.hoverText` is null), and a re-render resets `hoverText` so a removed bar cannot leave the line stale. `setReadout` stays idempotent. `test/dashboard.test.ts` drives the served `/app.js`: the copy button starts disabled and inert, hovering two bars and leaving one before running the timers commits **only the last** entered bar's text (asserted equal to its `aria-label`), the readout carries the query, copying writes exactly the current bar's text to the clipboard shim twice in a row as the focus moves, and leaving reverts to the hint — so both the debounce and the click-time payload are locked. Full suite 226 tests; live check on the built CLI serves `id="chart-copy"` in the page, `previewReadout`/`READOUT_HOVER_MS` in `/app.js`, passes `node --check`, and still carries the §v1.12 per-response CSP nonce.
