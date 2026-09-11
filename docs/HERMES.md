# Connecting AegisX-Memory to Hermes Agent

Hermes has a native MCP client. Register AegisX once and its four tools are
available in every Hermes conversation, on every surface (CLI, TUI, desktop,
messaging bots).

## 1. Prerequisites

```bash
pip install mcp          # Hermes silently disables MCP without this
node --version           # >= 20 required by AegisX
```

## 2. Build & (optional) expose the CLI globally

```bash
cd /path/to/AegisX-Memory
npm install && npm run build
npm link                 # optional: makes `aegisxmemory` available on PATH
```

## 3. Register the MCP server

The fastest way — let AegisX print the exact block for you:

```bash
aegisxmemory mcp-config --agent hermes          # or --bin after npm link
```

Then merge the printed `mcp_servers:` output into `~/.hermes/config.yaml`.
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

Notes (from the Hermes native-MCP reference):
- Hermes forwards only a filtered env (`PATH`, `HOME`, `USER`, …) to stdio
  servers — `HOME` is enough for the default `~/.aegisx` location.
- Tool calls have a 120 s default timeout; AegisX calls are milliseconds.
- Adding/removing MCP servers requires restarting Hermes (no hot reload).

## 4. Verify

Restart Hermes, then:

```
hermes chat -q "List your aegisx tools"
```

You should see the four tools registered with the prefix
`mcp_aegisx_memory_*`:

| Hermes tool name | Purpose |
|---|---|
| `mcp_aegisx_memory_aegisxmemory_recall` | budgeted warm context (facts, symbols, last handoff) |
| `mcp_aegisx_memory_aegisxmemory_remember` | store a stable fact |
| `mcp_aegisx_memory_aegisxmemory_save` | store the session handoff |
| `mcp_aegisx_memory_aegisxmemory_index` | incremental repo index |

Sanity-check outside Hermes (protocol-level test, no Hermes needed):

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/cli/index.js mcp | grep -o '"name":"aegisxmemory_[a-z_]*"'
```

Expected: `aegisxmemory_recall`, `aegisxmemory_remember`, `aegisxmemory_save`, `aegisxmemory_index`.

## 5. Daily workflow with Hermes

- Session start: *"recall the project memory"* → Hermes calls `aegisxmemory_recall`
  and gets structure, decisions, and the last handoff without re-reading files.
- During work: *"remember that tests run with pnpm test"* → `aegisxmemory_remember`.
- Session end: *"save the session handoff"* → `aegisxmemory_save`.
- Keep the index fresh: run `aegisxmemory watch /path/to/repo` in a separate
  terminal (add `--poll` on network/VM filesystems), or let Hermes call
  `aegisxmemory_index` after bulk edits. `watch --json` emits JSONL per-scan events.

Because Hermes spawns the MCP server from its own working directory, prefer
passing an explicit `repo` parameter when you work across multiple projects
(AegisX namespaces memory per repo path, so projects never cross-contaminate).

## CLI-only fallback (no MCP)

If MCP is unavailable, any agent with a terminal tool can drive AegisX via the
commands in the repo's `AGENTS.md` ("AegisX-Memory Protocol" section). The CLI
and the MCP server share the same database, so both paths interoperate freely.
