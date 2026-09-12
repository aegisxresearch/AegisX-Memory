/**
 * MCP stdio server: exposes AegisX-Memory as tools for any MCP-capable
 * AI agent (Claude Desktop/Code, Cursor, …). Transport: stdio JSON-RPC only —
 * no sockets, no network (STRIDE: S/E mitigated by parent-spawn trust).
 *
 * The tool definitions live in ./tools.ts, shared with the HTTP transport so
 * both expose exactly the same five tools.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Engine } from '../core/engine.js';
import { dbPath } from '../core/paths.js';
import { registerMemoryTools } from './tools.js';

export async function startMcpServer(): Promise<void> {
  const engine = new Engine(dbPath());
  const server = new McpServer({ name: 'aegisx-memory', version: '1.0.0' });
  registerMemoryTools(server, engine);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Engine connections live for the server's lifetime; the parent process
  // closing stdin ends the transport and the process exits naturally.
}
