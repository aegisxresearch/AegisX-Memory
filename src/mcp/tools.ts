/**
 * The memory tools, registered once for every MCP transport.
 *
 * Both the stdio server (`aegisxmemory mcp`) and the HTTP server
 * (`aegisxmemory serve`) expose the same five tools. Keeping the registrations
 * in one place is what makes that a fact rather than a hope: each server used
 * to declare its own list, and the HTTP transport had silently drifted to four
 * tools — `aegisxmemory_graph` was missing — while the README promised five.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Engine, DEFAULT_TOKEN_BUDGET, describeSessionSave } from '../core/engine.js';

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

/**
 * Server-level instructions (MCP `initialize` → `instructions` field).
 *
 * This is the one channel that does not depend on the agent *choosing* to read
 * a rules file: conforming clients inject it into the model's context when the
 * server connects. It is deliberately short and imperative — it states the
 * standing behavior (recall first, save last) rather than describing features,
 * because an agent that must infer the behavior is an agent that skips it when
 * a question looks small.
 */
export const SERVER_INSTRUCTIONS = [
  'AegisX-Memory: persistent project memory. Standing behavior, not opt-in:',
  '1. At the start of ANY working session (yes, even for a small question), call aegisxmemory_recall for this repo first and use its block instead of re-reading covered code.',
  '2. Read the closing coverage comment: "complete" means nothing was withheld; "(more exist)" or "budget dropped" means it was clipped — query again for what you need; "N in handoff" means those notes appear in the handoff section.',
  '3. If the block says no indexed files, call aegisxmemory_index once, then recall again.',
  '4. When you learn a stable fact, call aegisxmemory_remember (key: project.<name>.<key>).',
  '5. At the end of every session (or after a meaningful change), call aegisxmemory_save with goal/facts/decisions/gotchas/conventions/nextSteps — that is what makes the next session start warm.',
  'Never store secrets; the engine refuses them.',
].join('\n');

/** Attach the five memory tools to a server. Callers own `engine` (and its
 *  lifetime); connections stay open for the server's life. */
export function registerMemoryTools(server: McpServer, engine: Engine): void {
  server.tool(
    'aegisxmemory_recall',
    'MANDATORY at session start, before reading any file — including small questions. Returns budgeted project memory: facts, decisions/gotchas, relevant symbols, last handoff. Read the closing coverage comment: "complete" = nothing withheld; "(more exist)"/"budget dropped" = clipped, query again; "N in handoff" = printed below.',
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
    'MANDATORY at session end (or after a meaningful change) — this is what makes the next session start warm. Persists goal, verified facts, decisions with reasons, gotchas, conventions, next steps; each decision/gotcha/convention also becomes searchable knowledge (upserted by sentence). Skip it and the next session starts cold.',
    {
      goal: z.string().describe('what this session was trying to achieve'),
      facts: z.array(z.string()).describe('verified facts (exact errors, paths, commands)'),
      decisions: z.array(z.string()).describe('decisions taken, with one-line reasons'),
      gotchas: z.array(z.string()).optional().describe('traps that cost time — what the next session should avoid'),
      conventions: z.array(z.string()).optional().describe('project rules the next session must follow'),
      nextSteps: z.array(z.string()).describe('actionable steps for the next session'),
    },
    async (handoff) => {
      try {
        const summary = engine.saveSession(process.cwd(), handoff);
        return textResult(`session handoff saved${describeSessionSave(summary)}`);
      } catch (err) {
        return textResult(`error: ${errorMessage(err)}`, true);
      }
    },
  );

  server.tool(
    'aegisxmemory_index',
    'Call once for a repo the recall block reports as not yet indexed (then recall again). Incremental and hash-based: only changed files re-extracted; secrets and junk dirs skipped automatically.',
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
}
