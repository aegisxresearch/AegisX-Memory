/**
 * MCP stdio server: exposes AegisX-Memory as tools for any MCP-capable
 * AI agent (Claude Desktop/Code, Cursor, …). Transport: stdio JSON-RPC only —
 * no sockets, no network (STRIDE: S/E mitigated by parent-spawn trust).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Engine, DEFAULT_TOKEN_BUDGET } from '../core/engine.js';
import { dbPath } from '../core/paths.js';

interface TextContent {
  type: 'text';
  text: string;
}

function textResult(text: string, isError = false): { content: TextContent[]; isError?: boolean } {
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Indented text rendering of the graph projection for terminal/agent use:
 * repos as hubs, then each connected item with its relation label.
 */
function renderGraph(g: ReturnType<Engine['graphData']>, maxNodes: number): string {
  const edgesBySource = new Map<string, Array<{ target: string; label: string }>>();
  for (const e of g.edges) {
    const list = edgesBySource.get(e.source) ?? [];
    list.push({ target: e.target, label: e.label });
    edgesBySource.set(e.source, list);
  }
  const repos = g.nodes.filter((n) => n.kind === 'repo').slice(0, Math.max(4, Math.floor(maxNodes / 6)));
  const others = g.nodes.filter((n) => n.kind !== 'repo');
  const lines: string[] = [`memory graph — ${g.nodes.length} nodes / ${g.edges.length} relations`];
  for (const repo of repos) {
    lines.push('', `${repo.label}/`, '');
    let shown = 0;
    for (const n of others) {
      if (shown >= Math.ceil(maxNodes / Math.max(1, repos.length)) - 1) break;
      const rel = (edgesBySource.get(n.id) ?? []).find((e) => e.target === repo.id);
      if (!rel) continue;
      lines.push(`  [${n.kind}] ${n.label}${n.sub ? ' — ' + n.sub : ''} (${rel.label} ${repo.label})`);
      shown++;
    }
    if (shown === 0) lines.push('  (no linked items yet)');
  }
  if (others.length > 0 && repos.length === 0) {
    for (const n of others.slice(0, maxNodes)) {
      lines.push(`  [${n.kind}] ${n.label}${n.sub ? ' — ' + n.sub : ''}`);
    }
  }
  return lines.join('\n');
}

export async function startMcpServer(): Promise<void> {
  const engine = new Engine(dbPath());
  const server = new McpServer({ name: 'aegisx-memory', version: '1.0.0' });

  server.tool(
    'aegisxmemory_recall',
    'Get budgeted project memory: facts, decisions/gotchas, relevant symbols, and the last session handoff. Facts include previousValue when a key was re-pinned. Use at session start instead of re-reading the codebase.',
    {
      query: z.string().optional().describe('optional search query; omit for repo-scoped recall'),
      repo: z.string().optional().describe('repo root path; defaults to the server cwd'),
      budget: z.number().int().positive().optional().describe('max tokens to return (default 2000)'),
    },
    async ({ query, repo, budget }) => {
      try {
        const result = engine.recall(query ?? null, repo ?? process.cwd(), budget ?? DEFAULT_TOKEN_BUDGET);
        return textResult(engine.renderMarkdown(result));
      } catch (err) {
        return textResult(`error: ${errorMessage(err)}`, true);
      }
    },
  );

  server.tool(
    'aegisxmemory_remember',
    'Save a stable fact under a dot-namespaced key, e.g. key "project.myapp.test-cmd" value "npm test". Re-pinning a key with a new value keeps the old one, which recall reports inline. Refuses secrets.',
    {
      key: z.string().describe('dot-namespaced key: lowercase letters, digits, dot, underscore, hyphen'),
      value: z.string().describe('the fact — kept concise preferred; values over 2000 chars are truncated, never rejected'),
    },
    async ({ key, value }) => {
      try {
        const fact = engine.remember(key, value, process.cwd());
        const previous = fact.previousValue;
        // Tell the agent the value changed — a silently overwritten fact is how
        // a session ends up acting on a stale assumption.
        const note = previous === undefined
          ? ''
          : ` — replaced previous value: ${previous.length > 120 ? `${previous.slice(0, 120)}…` : previous}`;
        return textResult(`saved ${key}${note}`);
      } catch (err) {
        return textResult(`error: ${errorMessage(err)}`, true);
      }
    },
  );

  server.tool(
    'aegisxmemory_graph',
    'Get a compact node/edge map of stored memory: repos, facts, knowledge (decisions/gotchas), and session handoffs with their relations. Use to orient before a deep task or to visualize relationships at a glance.',
    {
      maxNodes: z.number().int().positive().max(200).optional().describe('cap on nodes returned (default 60)'),
    },
    async ({ maxNodes }) => {
      try {
        return textResult(renderGraph(engine.graphData(), maxNodes ?? 60));
      } catch (err) {
        return textResult(`error: ${errorMessage(err)}`, true);
      }
    },
  );

  server.tool(
    'aegisxmemory_save',
    'Persist a session handoff: goal, verified facts, decisions with reasons, and actionable next steps. Call at session end.',
    {
      goal: z.string().describe('what this session was trying to achieve'),
      facts: z.array(z.string()).describe('verified facts (exact errors, paths, commands)'),
      decisions: z.array(z.string()).describe('decisions taken, with one-line reasons'),
      nextSteps: z.array(z.string()).describe('actionable steps for the next session'),
    },
    async (handoff) => {
      try {
        engine.saveSession(process.cwd(), handoff);
        return textResult('session handoff saved');
      } catch (err) {
        return textResult(`error: ${errorMessage(err)}`, true);
      }
    },
  );

  server.tool(
    'aegisxmemory_index',
    'Incrementally index a repo (hash-based: only changed files re-extracted). Secrets and junk dirs are skipped automatically.',
    {
      path: z.string().optional().describe('repo root; defaults to the server cwd'),
      watch: z.boolean().optional().describe('ignored over MCP; use `aegisxmemory index --watch` in a terminal'),
    },
    async ({ path: repoPath }) => {
      try {
        const stats = engine.indexRepo(repoPath ?? process.cwd(), () => undefined);
        return textResult(JSON.stringify(stats));
      } catch (err) {
        return textResult(`error: ${errorMessage(err)}`, true);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Engine connections live for the server's lifetime; the parent process
  // closing stdin ends the transport and the process exits naturally.
}
