# AegisX-Memory

**Persistent memory engine for AI coding agents — stop re-reading your codebase.**

[![CI](https://github.com/aegisxresearch/AegisX-Memory/actions/workflows/ci.yml/badge.svg)](https://github.com/aegisxresearch/AegisX-Memory/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

**English** (this document) | **Bahasa Indonesia** → [`README.id.md`](README.id.md)

Every new AI agent session re-explores your repo: architecture, decisions, gotchas, test commands — re-learned from scratch, every single time. AegisX-Memory fixes this with a **local-first, zero-cloud memory layer** that injects *only relevant* context at session start, under a hard token budget.

- 🧠 **Remembers** — facts, decisions, gotchas, session handoffs, code structure
- ⚡ **Fast** — ~1k files indexed in under 10 s; re-scans in under 200 ms
- 🔒 **Private** — everything lives in `~/.aegisx` on your machine; no network I/O anywhere
- 🤖 **Agent-native** — 5 MCP tools work with Hermes, Claude, Cursor, or any MCP client
- 📊 **Observable** — local web dashboard with an interactive knowledge graph

## ⚡ TL;DR — install, run `setup`, answer 2 questions. Done.

**Step 1 — install:**

```bash
curl -fsSL https://raw.githubusercontent.com/aegisxresearch/AegisX-Memory/main/install.sh | sh
```

**Step 2 — the guided wizard** (it asks which agent you use and whether memory should be automatic — that's it):

```bash
aegisxmemory setup
```

**Step 3 — restart your agent.** Done. Nothing else to run — ever.

See it in action (a real, unscripted run):

![The aegisxmemory setup wizard — answers 2 questions and connects your agent](docs/assets/setup.gif)

From now on the memory loop is automatic (the `--rules` flag makes the agent recall at session start and save at session end by itself). You just work and talk normally:

> *"buatkan fitur login"* → agent works → memory updates itself → next session it remembers everything.

If you ever want to poke at it manually: `aegisxmemory dashboard` opens a web view of what it remembers. **Everything below this line is optional reading** — how it works, what got installed, and reference material.

---

---

## 📖 Table of Contents

1. [Why does this exist?](#1-why-does-this-exist)
2. [How it works](#2-how-it-works)
3. [Installation](#3-installation)
4. [Five-minute quick start](#4-five-minute-quick-start)
5. [Connecting your AI agent](#5-connecting-your-ai-agent)
6. [Making memory automatic](#6-making-memory-automatic)
7. [The daily loop](#7-the-daily-loop)
8. [The web dashboard](#8-the-web-dashboard)
9. [CLI reference](#9-cli-reference)
10. [Facts: naming, limits, examples](#10-facts-naming-limits-examples)
11. [Session handoffs: the JSON contract](#11-session-handoffs-the-json-contract)
12. [Observability & live index](#12-observability--live-index)
13. [Diagnostics: doctor](#13-diagnostics-doctor)
14. [Environment variables](#14-environment-variables)
15. [Security & privacy](#15-security--privacy)
16. [Troubleshooting](#16-troubleshooting)
17. [Uninstalling](#17-uninstalling)
18. [Development](#18-development)
19. [Architecture](#19-architecture)
20. [Roadmap](#20-roadmap)
21. [License](#21-license)

---

## 1. Why does this exist?

If you use AI coding agents (Hermes, Claude Code, Cursor, …) you know the ritual: every session starts with the agent re-reading files, re-discovering that tests run with `npm test`, re-tripping over the same gotcha, re-asking what last session already decided.

That costs you **time** (minutes per session), **tokens** (a full codebase re-read is ~8,000+ tokens), and **correctness** (the agent forgets yesterday's decisions and repeats yesterday's mistakes).

AegisX-Memory is the fix: a memory layer the agent can *recall* in one call, *contribute to* during work, and *hand off to* at session end. Think of it as a notebook the agent keeps per project — except the notebook never goes stale, because it is keyed to file-content hashes, not timestamps.

## 2. How it works

Three stores under one SQLite database (`~/.aegisx/memory.sqlite`, WAL + FTS5):

| Store | What it remembers | Why it matters |
|---|---|---|
| **FactStore** | stable facts: stack, test commands, conventions (`project.<repo>.<key>`) | never re-ask "how do tests run here?" |
| **KnowledgeGraph** | symbols, module map, TODO/FIXME markers, decisions & gotchas | replaces generic codebase re-reads |
| **SessionStore** | compressed handoffs: goal, verified facts, decisions, next steps | a new session *resumes* instead of restarting |

**Hash invalidation, not timestamps.** Code knowledge is keyed to SHA-256 file-content hashes. The moment a file changes, its stale memories are gone. Zero stale answers, zero heuristics.

**Budgeted recall.** A recall composes, under a hard token budget (default 2,000): repo-anchored facts → FTS-ranked knowledge → symbols (ranked by query) → last handoff → structure brief. Overflow drops lowest-priority items first — never mid-fact.

## 3. Installation

**Requirements:** Linux/macOS (Windows via WSL), node ≥ 20, npm, git.

### Option A — one line (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/aegisxresearch/AegisX-Memory/main/install.sh | sh
```

What it does:

1. clones this repo to `~/.aegisx-app`
2. installs dependencies (`npm ci`) and builds the TypeScript bundle
3. symlinks the `aegisxmemory` CLI into `~/.local/bin` (adds to PATH if missing)
4. runs `aegisxmemory init` to create `~/.aegisx`

Re-running the same line **updates** an existing install (fetch + reset to origin/main, then rebuild).

### Option B — npm straight from GitHub

```bash
npm install -g github:aegisxresearch/AegisX-Memory
```

TypeScript is bundled in devDependencies, so no global `tsc` is needed. If this path ever fails on your setup, use Option A.

### Option C — clone manually

```bash
git clone https://github.com/aegisxresearch/AegisX-Memory.git
cd AegisX-Memory && npm install && npm run build && npm link
```

### Verify

```bash
aegisxmemory --help        # usage + command list
aegisxmemory init          # first run also works if you skipped it above
```

## 4. Five-minute quick start

> Already did the 2 TL;DR commands above and connected your agent? **You can skip this section** — the agent runs all of this itself. The steps below are for using AegisX from a plain terminal, without an agent.

```bash
# 0. one-time: create the memory home (~/.aegisx)
aegisxmemory init

# 1. go into your project and index it
cd ~/projects/myapp
aegisxmemory index .          # first scan: ~1k files < 10 s; re-scan < 200 ms

# 2. pin the facts every future session should know
aegisxmemory remember project.myapp.test-cmd "npm test"
aegisxmemory remember project.myapp.stack "TypeScript + SQLite"

# 3. print the warm context block an agent will see
aegisxmemory recall           # ≤ 2,000 tokens, markdown
aegisxmemory recall "login"   # query-focused recall

# 4. end a session with a handoff
echo '{"goal":"fix login bug","facts":["error at src/auth/login.ts:42"],"decisions":["bump bcrypt 5.1"],"nextSteps":["redeploy staging"]}' | aegisxmemory save --json -

# 5. next session: resume warm
aegisxmemory resume
```

That is the entire product: `index` once → `remember` facts anytime → `save` at session end → `resume` at the next one.

## 5. Connecting your AI agent

The CLI is great for you, but the real win is the agent calling the tools itself. AegisX-Memory ships an **MCP server** (Model Context Protocol — the standard agent tool wire format). Once registered, your agent gets five tools:

| Tool | Purpose |
|---|---|
| `aegisxmemory_recall` | budgeted warm context (facts, symbols, last handoff) |
| `aegisxmemory_remember` | store a stable fact |
| `aegisxmemory_save` | store the session handoff |
| `aegisxmemory_index` | incremental repo index |
| `aegisxmemory_graph` | compact node/edge map of the memory |

> **You never start the MCP server by hand.** The agent spawns it itself when it launches. "Activating" the server = restarting the agent after registering.

### 5.1 One command (recommended)

```bash
aegisxmemory setup                                  # guided wizard — asks, then does everything
aegisxmemory mcp-config --install --agent hermes --rules   # manual equivalent, one shot
aegisxmemory mcp-config --install --agent hermes    # Hermes only
aegisxmemory mcp-config --install                   # Hermes + Claude + Cursor at once
```

The `setup` wizard is the friendly front door: it asks *which agent* you use (Hermes / Claude / Cursor / all) and *whether memory should be automatic*, then chains exactly the commands below. Safe to re-run any time.

The installer:

- creates the agent config file if it does not exist,
- merges the `aegisx-memory` entry if it does (other entries untouched),
- backs up the original next to itself (`*.aegisx-bak`),
- refuses configs it cannot parse (never clobbers),
- converts harmless empty defaults (`mcp_servers:` / `mcp_servers: []`) into proper mappings,
- is idempotent — run it twice, nothing doubles.

Then **restart your agent** (MCP has no hot reload). Done.

### 5.2 Which file gets written?

| Agent | Config file |
|---|---|
| Hermes | `~/.hermes/config.yaml` |
| Claude | `~/.claude/claude_desktop_config.json` (or `CLAUDE_CONFIG` env) |
| Cursor | `~/.cursor/mcp.json` |

### 5.3 Paste-it-yourself (if you prefer)

```bash
aegisxmemory mcp-config                  # Hermes + Claude + Cursor blocks, one output
aegisxmemory mcp-config --agent claude   # strict JSON for claude_desktop_config.json / .mcp.json
aegisxmemory mcp-config --bin            # use `aegisxmemory` from PATH (after npm link)
```

Copy the printed block into your agent's config, restart the agent. Full Hermes walkthrough with screenshots-grade detail: [`docs/HERMES.md`](docs/HERMES.md).

### 5.4 Verify the registration

```bash
aegisxmemory doctor        # checks MCP registrations, gives fix hints
```

Or probe the server directly (should print the five tool names):

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | aegisxmemory mcp | grep -o '"name":"aegisxmemory_[a-z_]*"'
```

### 5.5 HTTP transport (remote / IDE agents)

For agents that cannot spawn stdio subprocesses (IDE extensions, containers, remote machines):

```bash
aegisxmemory serve --token my-secret     # http://127.0.0.1:3359/mcp
```

Same five tools over StreamableHTTP. Hardened by default:

- binds `127.0.0.1` only; non-localhost binds are refused unless a token is set,
- bearer tokens compared in constant time (SHA-256 + `timingSafeEqual` — no timing side channel),
- empty `--token` / `AEGISX_TOKEN` is treated as "no token" and can never bypass the bind guard,
- DNS-rebinding Host guard,
- request bodies capped at 1 MB (declared or chunked) and rejected with `413` before reaching the transport,
- handler errors can never crash the server process.

## 6. Making memory automatic

Registration gives the agent the *ability* to remember. The `--rules` flag gives it the *standing order*:

```bash
aegisxmemory mcp-config --install --agent hermes --rules
```

`--rules` writes a marker-wrapped behavior block into the agent's standing-instructions file:

| Agent | Rules file |
|---|---|
| Hermes | `~/.hermes/SOUL.md` (per the official Hermes prompt-assembly docs) |
| Claude | `~/.claude/CLAUDE.md` |
| Cursor | `~/.cursor/rules/aegisx-memory.mdc` |

The block instructs the agent to:

1. **recall at session start** — before anything else, call `aegisxmemory_recall` for the current repo;
2. **remember stable facts immediately** — test command, stack, ports, conventions;
3. **record decisions/gotchas** — via `save` handoffs, not chat-only;
4. **save the handoff at session end** — so the next session resumes warm;
5. **never try to store secrets** — the engine refuses them.

Safety properties: marker-wrapped (nothing outside the block is modified), backed up (`*.aegisx-bak`), idempotent, and a freshly created Hermes `SOUL.md` gets a small identity seed so the agent's persona is never wiped.

After installing rules, **restart the agent**. From then on you just work — the memory loop runs itself.

## 7. The daily loop

Everything repo-aware uses the **current working directory** — `cd` into the project first. Memory is namespaced per path: project A and project B never bleed into each other.

Here is the whole loop in one take — index once, then a single recall call brings back the code map, the pinned facts and the last handoff:

![The memory loop: index → remember → save handoff → one recall call](docs/assets/memory-loop.gif)

### 7.1 If your agent is connected (the normal case)

With `--rules` installed this happens **by itself** — you do not have to ask. These phrases are just what you *can* say if you want to nudge it:

| You say | Agent calls |
|---|---|
| *"recall the project memory"* (or nothing — rules make it automatic) | `aegisxmemory_recall` |
| *"remember that tests run with npm test"* | `aegisxmemory_remember` |
| *"save the session handoff"* (or nothing — rules make it automatic) | `aegisxmemory_save` |
| *"re-index after that refactor"* | `aegisxmemory_index` |

> The MCP server is spawned from the agent's working directory. When working across projects, tell the agent to pass the `repo` parameter explicitly.

### 7.2 Terminal-only (no agent)

```bash
cd ~/projects/myapp

aegisxmemory index .                  # once, then again after big changes
aegisxmemory resume                   # session start: warm context
aegisxmemory remember project.myapp.test-cmd "npm test"
aegisxmemory recall "auth"            # focused recall
echo '{"goal":"…","facts":[…],"decisions":[…],"nextSteps":[…]}' | aegisxmemory save --json -
aegisxmemory forget project.myapp.old-thing    # delete a fact
```

### 7.3 Cheat sheet

| When | Command / phrase |
|---|---|
| First time in a project | `aegisxmemory index .` |
| Start of every session | `aegisxmemory resume` / *"recall the project memory"* |
| Learned something stable | `aegisxmemory remember project.<name>.<key> <value>` |
| End of session | `aegisxmemory save --json -` / *"save the session handoff"* |
| Wondering what a fact used to say | `aegisxmemory history <key>` |
| Want it hands-off | `aegisxmemory watch .` in a side terminal |
| Something feels off | `aegisxmemory doctor` |
| Curious about usage | `aegisxmemory stats` or `aegisxmemory dashboard` |

## 8. The web dashboard

```bash
aegisxmemory dashboard            # opens http://127.0.0.1:3360 in your browser
aegisxmemory dashboard --no-open  # just print the URL (run it in a tmux pane, say)
aegisxmemory dashboard --port 4021
```

A read-only view of everything the engine remembers — refreshed every 10 s, rendered locally:

- **Bento totals** — estimated tokens saved (with a sparkline), repos, facts (including how many changed since they were first pinned), knowledge entries, handoffs, and a recall hit-rate ring
- **Knowledge graph** — interactive force-directed map (repos as hubs; facts, decisions/gotchas, and handoffs orbiting them); drag nodes to untangle; one animation loop that pauses while the tab is hidden, plus a **List view** toggle that renders the same nodes as a table for keyboard and screen-reader users
- **Recall history chart** — last 50 recalls as bars you can Tab through, each with a label and tooltip (teal = hit, amber = cold miss; height ≈ tokens returned)
- **Per-repo table** — files/symbols indexed, scans, recalls, hit rate; select a repository to see its facts and handoffs
- **Pinned facts** — filterable, a copy button per fact, and a **changed** badge plus the value it replaced (`was: 3000 (changed 2026-09-12)`) — the same signal recall gives the agent
- **Light / dark / auto** — one token layer (`--bg`, `--surface`, `--fg-muted`, …); the theme is resolved before first paint from your OS preference, and the topbar button cycles Auto → Light → Dark

The dashboard binds `127.0.0.1` only (hardcoded — there is no flag to expose it), serves its stylesheet and script from its own origin (`/app.css`, `/app.js`) with **no CDN and no external requests** (works fully offline), and renders all stored data via `textContent`, so a malicious fact value can never inject markup into the page. Every response also carries a strict `Content-Security-Policy` with a **fresh nonce per response** (`default-src 'none'`, same-origin assets only, plus that one nonce for the pre-paint theme bootstrap) together with `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` — so the guarantee that a stored fact value cannot execute is structural, not just a habit of the renderer. It also honours `prefers-reduced-motion`, exposes a live connection status, and marks every section as a labelled landmark for screen readers.

## 9. CLI reference

| Command | Purpose |
|---|---|
| `aegisxmemory init` | create the memory home + DB, print setup hints |
| `aegisxmemory index [path]` | full/incremental hash scan of a repo |
| `aegisxmemory recall [query] [--budget n]` | budgeted context block (markdown) |
| `aegisxmemory remember <key> <value>` | pin a stable fact |
| `aegisxmemory forget <key>` | delete a fact (and its superseded values) |
| `aegisxmemory history [key]` | what a pinned fact used to be (timeline of superseded values) |
| `aegisxmemory save --json <file\|->` | persist a session handoff (JSON file or stdin) |
| `aegisxmemory resume` | print last handoff + memory for this repo |
| `aegisxmemory stats [path] [--json]` | observability: files/symbols, scans, recalls, hit rate, tokens saved |
| `aegisxmemory watch [path] [--poll] [--debounce n]` | event-driven auto-index (chokidar, polling fallback) |
| `aegisxmemory doctor [path] [--fix] [--json]` | health check: DB, schema, index drift, MCP registrations |
| `aegisxmemory dashboard [--port n] [--no-open]` | local web dashboard (read-only, charts, 127.0.0.1 only) |
| `aegisxmemory mcp` | run the MCP stdio server |
| `aegisxmemory serve [--port n] [--host h] [--token t]` | MCP over HTTP (localhost-only, bearer auth) |
| `aegisxmemory mcp-config [--agent n] [--bin] [--install] [--rules]` | print / install MCP registration blocks; `--rules` adds auto-memory behavior |

**Machine mode:** every data command accepts `--json` — strict JSON on stdout, warnings/errors on stderr, exit code authoritative.

**Exit codes:** `0` success · `1` user error · `2` internal error.

### Command-by-command

<details>
<summary><code>index</code> — teach it your codebase</summary>

```bash
aegisxmemory index .            # index the current directory
aegisxmemory index ~/work/lib   # absolute path works too
aegisxmemory index . --watch    # keep running, re-index on change
```

Hash-based: only changed files are re-extracted. Skips `.gitignore`, dotfiles, `node_modules`/junk dirs, secret-bearing files (`.env*`, `*.pem`, `*.key`, credentials). Guards: symlink refusal, 64-depth cap, 512 KB/file cap, 50k-file cap with explicit abort.
</details>

<details>
<summary><code>recall</code> — get the warm context block</summary>

```bash
aegisxmemory recall                  # whole-repo block, ≤ 2,000 tokens
aegisxmemory recall "auth"           # query-focused ranking
aegisxmemory recall --budget 800     # tighter budget for small models
aegisxmemory recall --json | jq .    # machine mode
```
</details>

<details>
<summary><code>remember / forget / history</code> — pin, unpin and trace facts</summary>

```bash
aegisxmemory remember project.myapp.test-cmd "npm test"
aegisxmemory remember project.myapp.stack "TypeScript + SQLite"
aegisxmemory remember project.myapp.dev-port "3000"
aegisxmemory remember project.myapp.dev-port "5000"   # keeps 3000 as history

aegisxmemory history project.myapp.dev-port          # current value + what it was
# project.myapp.dev-port
#   current  5000   (since 2026-09-12)
#   was      3000   (until 2026-09-12)

aegisxmemory history                                  # every recent change, all keys
aegisxmemory forget project.myapp.dev-port            # removes the history too
```

Keys: lowercase letters, digits, dot, underscore, hyphen (max 128 chars). Values: over 2,000 chars are truncated (never rejected); secret-shaped values are refused. See [§10](#10-facts-naming-limits-examples).
</details>

<details>
<summary><code>save / resume</code> — the session handoff</summary>

```bash
echo '{"goal":"fix login bug","facts":["error at src/auth/login.ts:42"],"decisions":["bump bcrypt 5.1"],"nextSteps":["redeploy staging"]}' | aegisxmemory save --json -
aegisxmemory save --json handoff.json     # from a file
aegisxmemory resume                        # next session
```

Schema in [§11](#11-session-handoffs-the-json-contract).
</details>

<details>
<summary><code>watch</code> — keep the index fresh</summary>

```bash
aegisxmemory watch .                        # event-driven (chokidar)
aegisxmemory watch . --poll --interval 2000 # polling fallback (network/VM filesystems)
aegisxmemory watch . --json                 # JSONL per-scan events for log pipelines
```

Debounce defaults to 300 ms and coalesces bursts; the skip set is identical to `index`.
</details>

## 10. Facts: naming, limits, examples

Facts are the most durable kind of memory — things that stay true across sessions. The key convention mirrors config systems:

```
project.<project-name>.<key>
```

| Key | Example value |
|---|---|
| `project.myapp.test-cmd` | `npm test` |
| `project.myapp.stack` | `TypeScript + SQLite` |
| `project.myapp.dev-port` | `3000` |
| `project.myapp.entry` | `src/index.ts` |
| `project.myapp.convention` | `feature branches, squash merge` |

**Rules** (enforced, with clear errors):

- key: `/^[a-z0-9][a-z0-9._-]{0,127}$/` — lowercase letters, digits, dot, underscore, hyphen; max 128 chars
- value: over 2,000 chars are truncated, never rejected — a failed `remember` burns an agent turn; a shortened fact does not. Keep facts concise anyway (≤500 chars is the sweet spot)
- secrets are refused: token prefixes (`sk-`, `ghp_`, `AKIA…`, …), `user:pass@host` URLs, `password=…`-style assignments — one shared detector (`src/core/secrets.ts`) powers every write path
- **history:** re-pinning a key with a *different* value keeps the old one (newest 10 per key). Recall then shows it inline so nobody acts on a stale value:

  ```
  - [project.myapp.dev-port] 5000 — was: 3000 (changed 2026-09-12)
  ```

  Re-pinning the *same* value is not a change and is not recorded (agents repeat themselves every session). `aegisxmemory history [key]` prints the timeline, and `forget` purges it — a deleted fact leaves nothing behind.

## 11. Session handoffs: the JSON contract

The handoff is what makes the *next* session warm. Pipe it via stdin (`save --json -`) or pass a file:

```json
{
  "goal": "what this session was trying to achieve",
  "facts": ["verified facts: exact errors, paths, commands"],
  "decisions": ["decision taken — with a one-line reason"],
  "nextSteps": ["actionable steps for the next session"]
}
```

- `goal` — one sentence.
- `facts` — things verified during the session (a failing test's error line, the command that reproduced a bug). Not opinions.
- `decisions` — the "we chose X over Y because Z" entries.
- `nextSteps` — concrete, actionable items; the next session's to-do list.

`resume` prints the last handoff plus the repo's facts, knowledge, and symbols — everything an agent needs to continue without re-reading the codebase.

## 12. Observability & live index

```bash
aegisxmemory stats                 # human-readable rollup
  # scans:   total: 4  avg: 5ms  last: 2026-09-11T…
  # recalls: total: 7  hits: 6  hit rate: 85.7%
  # tokens saved (est.): 47800
aegisxmemory stats --json | jq '.scans.recent[0]'
aegisxmemory stats --json | jq '.tokensSavedEstimate'   # badge / CI metric
```

- **Telemetry is local + automatic**: every `index` and every `recall` (CLI or MCP) appends to `scan_runs` / `recall_runs`. Nothing is sent anywhere; `stats` aggregates what's already in your DB. Telemetry never breaks indexing/recall even if the tables are corrupted. Rows older than 30 days are pruned automatically on every scan (`purgeTelemetry` clears everything for a repo on demand).
- **Tokens-saved estimate**: `saved ≈ (8000 − avg_tokens) × hits` — a conservative baseline for a full codebase re-read.
- **Watch**: respects `.gitignore`, dotfiles, `node_modules`/junk dirs, and secret-bearing files (same skip set as `index`). Debounce defaults to 300 ms; `--poll` switches to interval polling without FS events.

## 13. Diagnostics: doctor

```bash
aegisxmemory doctor
```

One command answers: is the DB healthy (`PRAGMA integrity_check`), is the schema migrated, is the index in sync with the disk (read-only hash drift), and is AegisX registered in any MCP client config (Hermes `config.yaml`, Claude `claude_desktop_config.json` / `.mcp.json`, Cursor `mcp.json`). Every warning comes with a concrete `fix →` hint; exit code `1` if anything needs attention.

Safe auto-fixes with `--fix`: initializes a missing DB, migrates an empty one, re-indexes drift (all idempotent). It deliberately **never** touches MCP config files or a corrupted DB — those need human judgement.

For CI pipelines, `--json` emits a strict, versioned report on stdout (`schemaVersion: 1`) with `passed`, per-check `status`, and any applied fixes — exit code `1` when `passed` is `false`:

```bash
aegisxmemory doctor --json | jq -e '.passed'   # fail the job when checks fail
```

## 14. Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `AEGISX_HOME` | where the memory home lives (DB, telemetry) | `~/.aegisx` |
| `AEGISX_ALLOWED_REPOS` | allowlist for MCP clients — colon-separated repo paths, `~` expanded, fail closed when set | *(unset = all repos)* |
| `AEGISX_TOKEN` | bearer token for `aegisxmemory serve` | *(unset = no token)* |
| `AEGISX_REPO_URL` | override the repo the installer clones (forks, air-gapped mirrors) | GitHub `main` |
| `AEGISX_APP_DIR` | installer: where to clone the app | `~/.aegisx-app` |
| `AEGISX_BIN_DIR` | installer: where to symlink the CLI | `~/.local/bin` |

Allowlist example:

```bash
export AEGISX_ALLOWED_REPOS=~/projects/app:~/work/lib
aegisxmemory serve --token secret   # repos outside the list are refused, fail closed
```

`mcp-config` propagates the allowlist into generated server blocks automatically.

## 15. Security & privacy

AegisX-Memory is STRIDE-threat-modeled (see `RFC.md` §5) and hardened where the threat is real:

- **Local-only**: no network I/O anywhere; stdio MCP only (no sockets). The optional HTTP transport binds loopback and refuses otherwise without a token.
- **File permissions**: the memory home is created `0700` and the database `0600` (owner-only) — on shared hosts other accounts cannot read your indexed codebase. POSIX modes only; other filesystems fall back to restrictive-umask creation.
- **Repo allowlist**: `AEGISX_ALLOWED_REPOS` (see [§14](#14-environment-variables)) gates every repo-scoped operation — `index`, `recall`, `remember`, `save`, `stats`, watch start — fail closed; repo-less global recall drops other projects' knowledge.
- **Secret hygiene**: `.env*`, `*.pem`, `*.key`, credentials files are never indexed; secret-shaped values are refused by `remember` **and** `save`; secret-bearing lines are redacted from extraction. One shared detector powers every write path.
- **Injection-resistant**: recalled text is wrapped in an explicit *untrusted data* block; FTS queries are tokenized and quoted (no SQL/FTS injection; all statements prepared).
- **DoS guards**: symlink refusal, 64-depth cap, 512 KB/file cap, 50k-file cap with explicit abort; 1 MB HTTP body cap with 413.
- **Uninstall** = `rm -rf ~/.aegisx` — zero residue.

## 16. Troubleshooting

<details>
<summary><code>aegisxmemory: command not found</code></summary>

The symlink dir is not on PATH. Re-run the installer (it bootstraps PATH into `~/.profile`/`~/.zshrc`) or add `export PATH="$HOME/.local/bin:$PATH"` to your shell rc, then `source` it.
</details>

<details>
<summary>The agent's banner shows no <code>aegisxmemory_*</code> tools</summary>

1. `aegisxmemory doctor` — it validates the registration and prints a fix hint.
2. Did you restart the agent after `--install`? MCP has no hot reload.
3. Hermes needs `pip install mcp` — without it Hermes silently disables MCP.
4. Confirm the config file got the entry: `grep -A4 aegisx-memory ~/.hermes/config.yaml`.
</details>

<details>
<summary><code>recall</code> says "no memory for this repo yet"</summary>

Memory is namespaced per path. Run `aegisxmemory index .` (and `resume`/`recall`) from the same directory you saved from. `aegisxmemory stats` shows which repos have memory.
</details>

<details>
<summary><code>mcp-config --install</code> refuses with "not a YAML mapping"</summary>

Your `mcp_servers:` holds real data in a non-mapping shape (e.g. a non-empty list). The installer refuses rather than destroy it. Move entries under named keys (`servername: command: … args: […]`) — then re-run.
</details>

<details>
<summary><code>remember</code> rejects my value ("secret-shaped")</summary>

The value looks like a credential (token prefix, `user:pass@` URL, `password=…`). That refusal is by design — store the *location* of the secret ("in 1Password → dev vault") instead of the secret.
</details>

<details>
<summary>Index seems slow or skipped files</summary>

Skips are intentional: `.gitignore`d paths, dotfiles, `node_modules`/junk dirs, secret-bearing files, files > 512 KB. The 50k-file cap aborts with an explicit message — narrow the path you index.
</details>

<details>
<summary>DB corrupted / upgrade went weird</summary>

`aegisxmemory doctor` first; `doctor --fix` handles missing/empty DB and index drift. Worst case: `rm -rf ~/.aegisx && aegisxmemory init` — you lose memory, never your code.
</details>

## 17. Uninstalling

```bash
rm -rf ~/.aegisx        # memory + telemetry (all data)
rm -rf ~/.aegisx-app    # only if installed via install.sh
rm -f ~/.local/bin/aegisxmemory
```

Nothing else was ever written outside those directories (plus the agent config entry, which you can delete by hand).

## 18. Development

```bash
git clone https://github.com/aegisxresearch/AegisX-Memory.git
cd AegisX-Memory
npm install
npm run typecheck   # strict tsc, both src and test configs
npm test            # vitest: happy paths + negative edge cases + invalidation + perf smoke
npm run build       # emit dist/
```

CI (`.github/workflows/ci.yml`) runs typecheck, build, the full test suite, and a doctor gate on every push and PR. The dual quality gate: strict typing with zero placeholders, and every feature ships with a happy-path test plus negative edge-case tests.

Stack: TypeScript (strict, ESM) · better-sqlite3 (WAL + FTS5) · commander · chokidar · yaml · official MCP SDK.

The demo GIFs in this README are recorded from real CLI runs, never mocked — refresh one after changing CLI output with `bash docs/assets/regenerate.sh setup` or `bash docs/assets/regenerate.sh memory-loop` (needs a fresh `npm run build` and asciinema's `agg` on `PATH`).

The design doc — component boundaries, data flow, STRIDE matrix, and numbered amendments — lives in [`RFC.md`](RFC.md). The Hermes integration walkthrough is [`docs/HERMES.md`](docs/HERMES.md).

## 19. Architecture

```
CLI / MCP ──► Engine ──► FactStore ─┐
                          Knowledge ┼──► SQLite (WAL, FTS5) at ~/.aegisx/memory.sqlite
                          Sessions ─┘
                     Indexer ──► hash-diff walk → symbol extraction
```

- **CLI** (`src/cli/`) — commander-based; each command thin over the Engine.
- **MCP servers** (`src/mcp/`) — stdio (`server.ts`) and StreamableHTTP (`http-server.ts`) exposing the same Engine.
- **Engine** (`src/core/engine.ts`) — orchestration: recall budgeting, guards, telemetry, graph projection.
- **Store** (`src/core/store.ts`) — SQLite persistence: facts, knowledge (+FTS5), sessions, telemetry.
- **Indexer** (`src/indexer/`) — hash-diff repository walk; extracts symbols/TODOs with per-language extractors. Recognised declarations: JS/TS, Python, Ruby (`def`), Go (`func`, `type`), Rust (`fn`, `mod`, `struct`, `impl`, `trait`), Java, C#, Kotlin (`class`, `interface`, `enum`, `record`, `object`, `namespace`, `union`) and C/C++ return-type functions (`int main(`, `std::string name(`) — column-0 declarations only, so indented members stay out of the index.
- **Secrets** (`src/core/secrets.ts`) — the single secret detector used by every write path.

Recall composition, under a hard token budget: repo-anchored facts → FTS-ranked knowledge → symbols (ranked by query, deterministic top-list otherwise) → last handoff → structure brief. Overflow drops lowest-priority items first — never mid-fact.

## 20. Roadmap

- **v2** — local embedding model for semantic recall, audit log, per-agent config generators.
- **v3** — encrypted cross-device sync (CRDT), team-shared knowledge graphs.

## 21. License

MIT — see [`LICENSE`](LICENSE). Contributions welcome: open an issue or PR; the RFC amendments log is the source of truth for design changes.
