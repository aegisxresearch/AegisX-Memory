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

export async function startMcpServer(): Promise<void> {
  const engine = new Engine(dbPath());
  const server = new McpServer({ name: 'aegisx-memory', version: '1.0.0' });

  server.tool(
    'aegisx_recall',
    'Get budgeted project memory: facts, decisions/gotchas, relevant symbols, and the last session handoff. Use at session start instead of re-reading the codebase.',
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
    'aegisx_remember',
    'Save a stable fact under a dot-namespaced key, e.g. key "project.myapp.test-cmd" value "npm test". Refuses secrets.',
    {
      key: z.string().describe('dot-namespaced key: lowercase letters, digits, dot, underscore, hyphen'),
      value: z.string().describe('the fact (max 500 chars)'),
    },
    async ({ key, value }) => {
      try {
        engine.remember(key, value, process.cwd());
        return textResult(`saved ${key}`);
      } catch (err) {
        return textResult(`error: ${errorMessage(err)}`, true);
      }
    },
  );

  server.tool(
    'aegisx_save',
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
    'aegisx_index',
    'Incrementally index a repo (hash-based: only changed files re-extracted). Secrets and junk dirs are skipped automatically.',
    {
      path: z.string().optional().describe('repo root; defaults to the server cwd'),
      watch: z.boolean().optional().describe('ignored over MCP; use `aegisx index --watch` in a terminal'),
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
