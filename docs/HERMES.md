# Connecting AegisX-Memory to Hermes Agent

Hermes has a native MCP client. Register AegisX once and its five tools are
available in every Hermes conversation, on every surface (CLI, TUI, desktop,
messaging bots). They land in Hermes' `mcp-aegisx-memory` toolset.

MCP is the *model-driven* half of the loop: the tools exist, and the standing
rules ask the model to call `recall`. The deterministic half is the
Hermes-native hooks in [step 3.1](#31-hermes-native-hooks-the-deterministic-half),
which inject memory at session start whether or not the model asks.

## 1. Prerequisites

```bash
python -c "import mcp"   # Hermes disables MCP support without the SDK
node --version           # >= 20 required by AegisX
```

If the import fails, install the SDK (`pip install mcp`, or let `hermes setup`
bootstrap it). A missing SDK is silent: configured servers simply never appear,
and the only trace is `mcp package not installed -- MCP tool support disabled`
in the debug log.

## 2. Build & (optional) expose the CLI globally

```bash
cd /path/to/AegisX-Memory
npm install && npm run build
npm link                 # optional: makes `aegisxmemory` available on PATH
```

## 3. Register the MCP server

One command writes the whole Hermes side for you — the MCP registration, the
standing auto-memory rules in `~/.hermes/SOUL.md`, and the two lifecycle hooks
(3.1). It creates `~/.hermes/config.yaml` if missing, backs up and merges if
present, and is idempotent:

```bash
aegisxmemory setup --yes --agent hermes     # MCP + SOUL.md rules + hooks
```

`aegisxmemory auto` does the same, and then also wires every other agent it
detects and starts the MCP HTTP server + dashboard as daemons.

Then **restart Hermes** — it spawns the MCP server itself on startup; there is
nothing to start by hand.

The same by hand, if you prefer to see each piece separately:

```bash
aegisxmemory mcp-config --install --agent hermes --rules   # registration + SOUL.md keep
```

Prefer to paste it yourself? Print the block:

```bash
aegisxmemory mcp-config --agent hermes          # or --bin after npm link
```

Manually, it looks like:

```yaml
mcp_servers:
  aegisx-memory:
    command: "node"
    args: ["/absolute/path/to/AegisX-Memory/dist/cli/index.js", "mcp"]
    connect_timeout: 30
    timeout: 60
```

Or, after `npm link`:

```yaml
mcp_servers:
  aegisx-memory:
    command: "aegisxmemory"
    args: ["mcp"]
```

If you use a custom memory home, pass it explicitly:

```yaml
mcp_servers:
  aegisx-memory:
    command: "aegisxmemory"
    args: ["mcp"]
    env:
      AEGISX_HOME: "/home/you/.aegisx"
```

### 3.1 Hermes-native hooks (the deterministic half)

Hermes runs approved shell hooks from `~/.hermes/agent-hooks/`. `setup`/`auto`
install two of them, and neither depends on the model reading `SOUL.md`:

| Hook event | Script | What it does |
|---|---|---|
| `pre_llm_call` | `aegisx-recall.sh` | injects the budgeted recall block (`{"context": "…"}`) into the first turn of a session |
| `pre_verify` | `aegisx-save-nudge.sh` | after the agent edits code, nudges it to save the handoff (`{"action":"continue","message":"…"}`) |

The scripts call `aegisxmemory hook session-start --json --client hermes` (and
`hook session-end`). `--client hermes` is what makes the payload correct — the
Claude Code shape (`hookSpecificOutput.additionalContext`) is read by Claude
Code and **silently ignored** by Hermes, which only reads `context`.

Check them:

```bash
hermes hooks list
hermes hooks doctor        # allowlisted, script unchanged, JSON valid, timings
hermes hooks test pre_llm_call
```

Hooks are recorded in the allowlist when a session first uses them. If `doctor`
reports *script modified since approval* after an upgrade, run
`hermes hooks revoke` and start one more session: AegisX only rewrites a hook
script when its bytes actually change, so re-running `setup`/`auto` stays clean.

Notes (from the Hermes native-MCP reference):
- Hermes forwards only a filtered env to stdio servers — `PATH`, `HOME`, `USER`,
  `LANG`, `LC_ALL`, `TERM`, `SHELL`, `TMPDIR`, `XDG_*`, plus the server block's
  own `env:`. `HOME` is enough for the default `~/.aegisx` location; use the
  `env:` block for anything else (e.g. `AEGISX_HOME`).
- Tool calls default to a **300 s** timeout — `mcp.tool_call` in config.yaml, or
  a per-server `timeout:` — and the initial connect defaults to 60 s
  (`connect_timeout`). AegisX calls are milliseconds.
- A running Hermes **does** pick up `mcp_servers` edits: it polls config.yaml and
  auto-reloads (`mcp.auto_reload_on_config_change: true`). With that opted out it
  notifies instead and you apply it with `/reload-mcp`, which rebuilds the tool
  surface and invalidates the prompt cache — which is why silent reloads are not
  always welcome.
- Hermes can register and probe the server itself:
  `hermes mcp add aegisx-memory --command node --args /absolute/path/to/AegisX-Memory/dist/cli/index.js mcp`,
  then `hermes mcp list`, `hermes mcp test aegisx-memory`, and
  `hermes mcp configure aegisx-memory` to choose which tools to expose.

## 4. Verify

Restart Hermes, then:

```bash
hermes -z "List your aegisx tools"        # one-shot: prints the answer and exits
hermes chat -q "List your aegisx tools"  # interactive; type /quit to leave
```

You should see the five tools registered under the `mcp-aegisx-memory` toolset.
Hermes' wire names are `mcp__<server>__<tool>` (double underscores, `-`
sanitized to `_`), so `aegisx-memory` + `aegisxmemory_recall` becomes:

| Hermes wire name | Purpose |
|---|---|
| `mcp__aegisx_memory__aegisxmemory_recall` | budgeted warm context (facts, symbols, last handoff) |
| `mcp__aegisx_memory__aegisxmemory_remember` | store a stable fact |
| `mcp__aegisx_memory__aegisxmemory_save` | store the session handoff |
| `mcp__aegisx_memory__aegisxmemory_index` | incremental repo index |
| `mcp__aegisx_memory__aegisxmemory_graph` | compact node/edge map of the memory (repos, facts, knowledge, handoffs) |

`hermes mcp list` and `hermes mcp test aegisx-memory` are the quickest
shell-level checks. In Hermes' tool-search catalog the `mcp__` prefix is
stripped and the name is word-split, so a query like `aegisxmemory recall`
reaches the tool by its bare name.

Sanity-check outside Hermes (protocol-level test, no Hermes needed):

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/cli/index.js mcp | grep -o '"name":"aegisxmemory_[a-z_]*"'
```

Expected: `aegisxmemory_recall`, `aegisxmemory_remember`, `aegisxmemory_save`, `aegisxmemory_index`, `aegisxmemory_graph`.

## 5. Daily workflow with Hermes

- Session start: with the hooks installed (3.1) the recall block is already in
  context — no phrase needed. Asking *"recall the project memory"* still works,
  and is how you pull a fresh block mid-session.
- During work: *"remember that tests run with pnpm test"* → `aegisxmemory_remember`.
- Session end: the `pre_verify` hook nudges the handoff; say *"save the session
  handoff"* to have the model write it with `aegisxmemory_save`.
- Keep the index fresh: run `aegisxmemory watch /path/to/repo` in a separate
  terminal (add `--poll` on network/VM filesystems), or let Hermes call
  `aegisxmemory_index` after bulk edits. `watch --json` emits JSONL per-scan events.

Because Hermes spawns the MCP server from its own working directory, prefer
passing an explicit `repo` parameter when you work across multiple projects
(AegisX namespaces memory per repo path, so projects never cross-contaminate).

## CLI-only fallback (no MCP)

If MCP is unavailable, any agent with a terminal tool can drive AegisX via the
commands written into the repo's `AGENTS.md` — the block `aegisxmemory setup`
keeps between `<!-- aegisx-memory:auto-rules BEGIN -->` and `… END -->`
("AegisX-Memory — project memory (do this automatically)"). The CLI and the MCP
server share the same database, so both paths interoperate freely.
