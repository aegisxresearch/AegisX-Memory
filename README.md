# AegisX-Memory

**Persistent memory engine for AI coding agents — stop re-reading your codebase.**

Every new agent session re-explores the repo: architecture, decisions, gotchas, test commands — re-learned from scratch, every time. AegisX-Memory fixes this with a local-first, zero-cloud memory layer that injects *only relevant* context at session start, under a hard token budget.

## How it kills the re-read

| Store | What it remembers | Why it matters |
|---|---|---|
| **FactStore** | stable facts: stack, test commands, conventions (`project.<repo>.<key>`) | never re-ask "how do tests run here?" |
| **KnowledgeGraph** | symbols, module map, TODO/FIXME markers, decisions & gotchas | replaces generic codebase re-reads |
| **SessionStore** | compressed handoffs: goal, verified facts, decisions, next steps | a new session resumes instead of restarting |

Everything is **hash-invalidated**: code knowledge is keyed to file content hashes (SHA-256), so the moment a file changes, its stale memories are gone. No timestamps, no heuristics — 0 stale answers.

## Quick start

```bash
npm install && npm run build
node dist/cli/index.js init        # creates ~/.aegisx (override with AEGISX_HOME)
node dist/cli/index.js index .     # first scan: ~1k files in <10s, re-scan <200ms
node dist/cli/index.js recall      # print budgeted context block (≤2,000 tokens)
```

### The session loop for any AI agent

```bash
aegisx resume                                  # 1. session start → warm context
# … work with your agent …
echo '{"goal":"…","facts":[…],"decisions":[…],"nextSteps":[…]}' | aegisx save --json -
                                               # 2. session end → persist the handoff
aegisx remember project.myapp.test-cmd "npm test"   # anytime: pin a stable fact
```

Or generate a ready-to-paste registration block for your MCP client:

```bash
aegisx mcp-config                  # Hermes + Claude + Cursor, one output
aegisx mcp-config --agent hermes   # YAML block for ~/.hermes/config.yaml
aegisx mcp-config --agent claude   # strict JSON for claude_desktop_config.json / .mcp.json
aegisx mcp-config --agent cursor   # strict JSON for ~/.cursor/mcp.json
aegisx mcp-config --bin            # use `aegisx` from PATH (after npm link)
```

### HTTP transport (remote / IDE agents)

```bash
aegisx serve --token my-secret     # http://127.0.0.1:3359/mcp (localhost-only)
```

Bearer tokens are compared in constant time (no timing side channel), and an
empty `--token` / `AEGISX_TOKEN` is treated as "no token" so it can never
bypass the non-localhost bind guard.

Same four MCP tools over StreamableHTTP for agents that cannot spawn stdio
subprocesses (IDE extensions, containers, remote machines). Hardened by
default: binds 127.0.0.1 only, DNS-rebinding Host guard, bearer-token auth
(`--token` or `AEGISX_TOKEN`), stateless sessions. Non-localhost binds are
refused unless a token is set. Request bodies are capped at 1 MB — declared
via `Content-Length` or streamed chunked — and rejected with `413` before
reaching the MCP transport; handler errors can never crash the server process.

MCP tools: `aegisx_recall`, `aegisx_remember`, `aegisx_save`, `aegisx_index`.
Hermes walkthrough: see `docs/HERMES.md`.

## CLI

| Command | Purpose |
|---|---|
| `aegisx init` | create memory home + DB |
| `aegisx index [path] [--watch]` | full/incremental hash scan |
| `aegisx recall [query] [--budget n]` | budgeted context block (markdown) |
| `aegisx remember <key> <value>` | pin a stable fact |
| `aegisx forget <key>` | delete a fact |
| `aegisx save --json -` | persist a session handoff (JSON on stdin/file) |
| `aegisx resume` | print last handoff + memory |
| `aegisx stats [path] [--json]` | observability: files/symbols + scans, recalls, hit rate, tokens saved |
| `aegisx watch [path] [--poll] [--debounce n]` | event-driven auto-index (chokidar + debounce, polling fallback) |
| `aegisx doctor [path]` | health check: DB integrity, schema, index drift, MCP registrations |
| `aegisx mcp` | run the MCP stdio server |
| `aegisx mcp-config [--agent n] [--bin]` | print MCP registration blocks (hermes/claude/cursor/all) |

Exit codes: `0` success · `1` user error · `2` internal error.

## Architecture (see RFC.md)

```
CLI / MCP ──► Engine ──► FactStore ─┐
                          Knowledge ┼──► SQLite (WAL, FTS5) at ~/.aegisx/memory.sqlite
                          Sessions ─┘
                     Indexer ──► hash-diff walk → symbol extraction
```

Recall composes, under a hard token budget: repo-anchored facts → FTS-ranked knowledge → symbols (ranked by query, deterministic top-list otherwise) → last handoff → structure brief. Overflow drops lowest-priority items first — never mid-fact.

## Observability & live index

```bash
aegisx stats                       # human-readable: files/symbols + scans & recalls
  # scans:  total: 4  avg: 5ms  last: 2026-09-11T…
  # recalls: total: 7  hits: 6  hit rate: 85.7%
  # tokens saved (est.): 47800  ·  hit rate: 85.7%
aegisx stats --json | jq '.scans.recent[0]'
aegisx stats --json | jq '.tokensSavedEstimate'   # badge / CI metric
aegisx watch .                     # event-driven (chokidar) — auto re-index on change
aegisx watch . --poll --interval 2000   # polling fallback for network/VM filesystems
aegisx watch . --json              # JSONL per-scan events for log pipelines
```

- **Telemetry is local + automatic**: every `index` and every `recall` (CLI or MCP) appends to `scan_runs` / `recall_runs`. Nothing is sent anywhere; `stats` just aggregates what's already in your DB. Telemetry never breaks indexing/recall even if the tables are corrupted. Rows older than 30 days are pruned automatically on every scan (retention cap; `purgeTelemetry` clears everything for a repo on demand).
- **Tokens-saved estimate**: `saved ≈ (8000 − avg_tokens) × hits` — conservative baseline for a full re-read. Use the JSON value for dashboards; the human line prints the same rollup.
- **Watch**: respects `.gitignore`, dotfiles, `node_modules`/junk dirs, and secret-bearing files (same skip set as `index`). Debounce defaults to 300 ms and coalesces bursts; `--poll` switches to interval polling without FS events.

## Diagnostics

```bash
aegisx doctor
```

One command answers: is the DB healthy (`PRAGMA integrity_check`), is the schema
migrated, is the index in sync with the disk (read-only hash drift), and is
AegisX registered in any MCP client config (Hermes `config.yaml`, Claude
`claude_desktop_config.json` / `.mcp.json`, Cursor `mcp.json`). Every warning
comes with a concrete `fix →` hint; exit code `1` if anything needs attention.

Safe auto-fixes with `--fix`: initializes a missing DB, migrates an empty one,
and re-indexes drift (all idempotent). It deliberately **never** touches MCP
config files or a corrupted DB — those need human judgement.

For CI pipelines, `--json` emits a strict, versioned report on stdout
(`schemaVersion: 1`) with `passed`, per-check `status`, and any applied fixes —
exit code `1` when `passed` is `false`:

```bash
aegisx doctor --json | jq -e '.passed'   # fail the job when checks fail
```

## Security & privacy (STRIDE-hardened)

- **Local-only**: no network I/O anywhere; stdio MCP only (no sockets).
- **File permissions**: the memory home is created `0700` and the database `0600` (owner-only) — on shared hosts other accounts cannot read your indexed codebase. POSIX modes only; other filesystems fall back to restrictive-umask creation.
- **Repo allowlist**: set `AEGISX_ALLOWED_REPOS=/path/a:/path/b` to restrict which repos MCP clients may index/recall/stats (colon-separated, `~` expanded, fail closed); repo-less global recall drops other projects' knowledge. `aegisx mcp-config` propagates it into generated server blocks.
- **Secret hygiene**: `.env*`, `*.pem`, `*.key`, credentials files are never indexed; secret-shaped values (token prefixes, `user:pass@` URLs, credential-named assignments) are refused by `remember` **and `save`**; secret-bearing lines are redacted from extraction. One shared detector (`src/core/secrets.ts`) powers every write path.
- **Injection-resistant**: recalled text is wrapped in an explicit *untrusted data* block; FTS queries are tokenized and quoted (no SQL/FTS injection; all statements prepared).
- **DoS guards**: symlink refusal, 64-depth cap, 512 KB/file cap, 50k-file cap with explicit abort.
- **Uninstall** = `rm -rf ~/.aegisx` — zero residue.

## Development

Every data command accepts `--json` for machine-readable output (strict JSON
on stdout, warnings/errors on stderr, exit code authoritative) — including
`doctor --json` with a versioned schema for CI gating:

```bash
aegisx recall --json | jq '.tokenEstimate'
aegisx doctor --json | jq -e '.passed'
```

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs typecheck, build,
full tests, and a doctor gate on every push and PR.

```bash
npm run typecheck   # strict tsc, both src and test configs
npm test            # vitest: happy paths + negative edge cases + invalidation + perf smoke
npm run build       # emit dist/
```

Stack: TypeScript (strict, ESM) · better-sqlite3 (WAL + FTS5) · commander · chokidar · official MCP SDK.

## Roadmap

- **v2** — local embedding model for semantic recall, audit log, per-agent config generators.
- **v3** — encrypted cross-device sync (CRDT), team-shared knowledge graphs.
