/**
 * HTTP MCP server (`aegisxmemory serve`): exposes the same four memory tools over
 * StreamableHTTP for remote/IDE agents. Security posture (STRIDE):
 *  - binds 127.0.0.1 ONLY (never a public interface);
 *  - optional bearer token via AEGISX_TOKEN (401 without it);
 *  - stateless mode (each POST is independent, no session hijacking surface);
 *  - DNS-rebinding guard: Host header must be an IP or localhost.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Engine, DEFAULT_TOKEN_BUDGET } from '../core/engine.js';
import { dbPath } from '../core/paths.js';

export interface ServeOptions {
  port: number;
  host: string;
  token: string | null;
  /** Test seam: await until the server is accepting connections. */
  onReady?: (address: { port: number }) => void;
}

/**
 * Request-body cap (RFC §5, STRIDE:D). JSON-RPC tool payloads are tiny;
 * 1 MB is a generous ceiling that still bounds per-request memory, so a local
 * (or token-holding) client cannot exhaust the server with a huge body —
 * declared via Content-Length or streamed with chunked encoding.
 */
export const MAX_HTTP_BODY_BYTES = 1024 * 1024;

function isLocalHostHeader(host: string): boolean {
  const hostname = host.split(':')[0] ?? '';
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/**
 * Constant-time bearer-token comparison (RFC §5, STRIDE:S).
 * naive string comparison early-exits on the first differing byte, which leaks
 * a timing side channel on the HTTP transport; comparing fixed-length SHA-256
 * digests removes the length dependence and early exit entirely.
 */
export function bearerTokenMatches(header: string, expected: string): boolean {
  const expectedDigest = crypto.createHash('sha256').update(`Bearer ${expected}`, 'utf8').digest();
  const providedDigest = crypto.createHash('sha256').update(header, 'utf8').digest();
  return crypto.timingSafeEqual(expectedDigest, providedDigest);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Defensive JSON response: a socket dying mid-write (client disconnect,
 *  oversized-request teardown) must never throw into the request handler. */
function respondJson(res: http.ServerResponse, status: number, payload: object): void {
  try {
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify(payload));
  } catch {
    try {
      res.destroy();
    } catch {
      // nothing left to do — socket is gone
    }
  }
}

/**
 * Safe error path for transport failures (D2). A throwing `res.end` after the
 * response already ended would surface as an unhandled rejection and crash the
 * whole `serve` process — respond only when the socket still allows it, and
 * destroy it otherwise.
 */
function handleTransportError(res: http.ServerResponse, err: unknown): void {
  if (res.writableEnded || res.headersSent) {
    res.destroy();
  } else {
    respondJson(res, 500, { error: errorMessage(err) });
  }
}

export function buildMcpServer(): McpServer {
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
        return { content: [{ type: 'text' as const, text: engine.renderMarkdown(result) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `error: ${errorMessage(err)}` }], isError: true };
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
        // Report the replacement so a session cannot unknowingly act on a stale
        // assumption about what a key used to hold.
        const note = previous === undefined
          ? ''
          : ` — replaced previous value: ${previous.length > 120 ? `${previous.slice(0, 120)}…` : previous}`;
        return { content: [{ type: 'text' as const, text: `saved ${fact.key}${note}` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `error: ${errorMessage(err)}` }], isError: true };
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
        return { content: [{ type: 'text' as const, text: 'session handoff saved' }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `error: ${errorMessage(err)}` }], isError: true };
      }
    },
  );

  server.tool(
    'aegisxmemory_index',
    'Incrementally index a repo (hash-based: only changed files re-extracted). Secrets and junk dirs are skipped automatically.',
    {
      path: z.string().optional().describe('repo root; defaults to the server cwd'),
    },
    async ({ path: repoPath }) => {
      try {
        const stats = engine.indexRepo(repoPath ?? process.cwd(), () => undefined);
        return { content: [{ type: 'text' as const, text: JSON.stringify(stats) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `error: ${errorMessage(err)}` }], isError: true };
      }
    },
  );

  return server;
}

/** Start the HTTP MCP server. Resolves once the listener is up. */
export function startHttpServer(options: ServeOptions): Promise<{ close(): Promise<void>; port: number }> {
  // Defense in depth: an empty-string token from a raw ServeOptions consumer
  // is no credential — treat it exactly like "no token configured".
  const token = options.token !== null && options.token.trim() === '' ? null : options.token;
  const server = buildMcpServer();

  const httpServer = http.createServer((req, res) => {
    const host = req.headers['host'] ?? '';
    if (!isLocalHostHeader(host)) {
      respondJson(res, 403, { error: 'forbidden host (DNS-rebinding guard)' });
      return;
    }
    if (token !== null) {
      const header = req.headers['authorization'] ?? '';
      if (typeof header !== 'string' || !bearerTokenMatches(header, token)) {
        respondJson(res, 401, { error: 'unauthorized: missing or invalid bearer token' });
        return;
      }
    }
    if (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE') {
      respondJson(res, 405, { error: 'method not allowed' });
      return;
    }
    // Size gate 1 (DoS): reject a declared body over the cap before reading it.
    const declared = Number(req.headers['content-length'] ?? '0');
    if (req.method === 'POST' && Number.isFinite(declared) && declared > MAX_HTTP_BODY_BYTES) {
      respondJson(res, 413, { error: `request body too large (>${MAX_HTTP_BODY_BYTES} bytes)` });
      req.resume(); // drain whatever the client already sent, then let it close
      return;
    }

    // POST: buffer the body here (cap-enforced) and hand it to the transport
    // pre-parsed — the SDK's documented body-parser seam. Buffering ourselves
    // is what makes the cap enforceable for chunked bodies too; the transport
    // never reads the raw stream in this path.
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      let received = 0;
      let aborted = false;
      req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        if (received > MAX_HTTP_BODY_BYTES) {
          // Size gate 2 (DoS): chunked / undeclared bodies are counted as they
          // stream in; past the cap we refuse and tear the socket down.
          aborted = true;
          chunks.length = 0;
          respondJson(res, 413, { error: `request body too large (>${MAX_HTTP_BODY_BYTES} bytes)` });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => {
        if (!res.writableEnded) {
          res.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        void (async () => {
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          try {
            await server.connect(transport);
            let parsed: unknown;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
            } catch {
              respondJson(res, 400, { error: 'request body is not valid JSON' });
              return;
            }
            await transport.handleRequest(req, res, parsed);
          } catch (err) {
            handleTransportError(res, err);
          } finally {
            res.on('close', () => {
              void transport.close();
            });
          }
        })();
      });
      return;
    }

    // GET / DELETE: no body to cap; the transport owns the (empty) stream.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    void (async () => {
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        handleTransportError(res, err);
      } finally {
        res.on('close', () => {
          void transport.close();
        });
      }
    })();
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, options.host, () => {
      const address = httpServer.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port;
      options.onReady?.({ port });
      resolve({
        port,
        close: async () => {
          await Promise.all([new Promise<void>((r) => httpServer.close(() => r()))]);
        },
      });
    });
  });
}

/** CLI entry: run until interrupted. */
export async function runServe(options: ServeOptions): Promise<void> {
  const handle = await startHttpServer(options);
  process.stderr.write(
    `AegisX MCP HTTP server on http://${options.host}:${handle.port}/mcp` +
      (options.token !== null ? ' (bearer token required)' : ' (no auth — localhost only)') +
      '\n',
  );
  const shutdown = (): void => {
    void handle.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
