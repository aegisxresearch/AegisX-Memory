/**
 * HTTP MCP server (`aegisxmemory serve`): exposes the same five memory tools as
 * the stdio transport over StreamableHTTP, for remote/IDE agents. Security
 * posture (STRIDE):
 *  - binds 127.0.0.1 ONLY (never a public interface);
 *  - optional bearer token via AEGISX_TOKEN (401 without it);
 *  - stateless mode (each POST is independent, no session hijacking surface;
 *    one server+transport per request, as the SDK documents for stateless HTTP);
 *  - DNS-rebinding guard: Host header must be an IP or localhost.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_INSTRUCTIONS } from './tools.js';
import { Engine } from '../core/engine.js';
import { dbPath } from '../core/paths.js';
import { registerMemoryTools } from './tools.js';

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
/** HTML response with the same defensive posture as `respondJson`, plus the
 *  headers the rest of this project sets on every page it serves. */
function respondHtml(res: http.ServerResponse, status: number, html: string, nonce: string): void {
  try {
    if (!res.headersSent) {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy':
          `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
    }
    res.end(html);
  } catch {
    try {
      res.destroy();
    } catch {
      // socket already gone
    }
  }
}

/**
 * Is this a browser (or anything else) that wants a web page rather than MCP?
 *
 * The detection is deliberately narrow: an explicit `text/html` and no
 * `text/event-stream`. A real MCP client always asks for the stream, and a bare
 * wildcard header is left alone — so nothing that actually speaks MCP can be
 * captured by this branch. (Do not write that wildcard out here: the
 * characters that end a block comment live inside it.)
 */
export function wantsHtmlPage(accept: string | undefined): boolean {
  if (accept === undefined) {
    return false;
  }
  return accept.includes('text/html') && !accept.includes('text/event-stream');
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * The page a human sees when they open the MCP endpoint in a browser.
 *
 * A `GET /mcp` that cannot accept an event stream must be refused (`406`) —
 * that is the Streamable HTTP spec, and it is what keeps a stray tab from being
 * mistaken for an agent. But a bare JSON-RPC error reads like a crash, and "is
 * it broken?" is the single most common question this server invites. The
 * status stays `406` and the body becomes an explanation of what this address
 * is, why the server is fine, and where the thing they probably wanted lives.
 */
export function renderMcpLandingPage(opts: { host: string; port: number; token: boolean; nonce: string }): string {
  const address = escapeHtml(`${opts.host}:${opts.port}`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>AegisX-Memory — MCP endpoint</title>
<style nonce="${opts.nonce}">
:root { --fg:#18181b; --muted:#52525b; --bg:#fafafa; --card:#fff; --border:#e4e4e7; --accent:#4f46e5; --code:#f4f4f5; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#f4f4f5; --muted:#a1a1aa; --bg:#09090b; --card:#18181b; --border:#27272a; --accent:#a5b4fc; --code:#27272a; }
}
* { box-sizing: border-box; }
body { margin:0; padding:40px 20px; background:var(--bg); color:var(--fg);
  font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
main { max-width:46rem; margin:0 auto; background:var(--card); border:1px solid var(--border);
  border-radius:14px; padding:32px; }
h1 { font-size:1.6rem; line-height:1.25; margin:0 0 4px; }
h2 { font-size:1.05rem; margin:32px 0 8px; }
p { margin:12px 0; }
.badge { display:inline-block; font-size:.75rem; font-weight:600; letter-spacing:.04em;
  text-transform:uppercase; color:var(--accent); margin-bottom:12px; }
.lead { color:var(--muted); margin-top:0; }
code { background:var(--code); border-radius:6px; padding:2px 6px; font-size:.875em;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
pre { background:var(--code); border-radius:10px; padding:14px 16px; overflow-x:auto; }
pre code { background:none; padding:0; }
ul { padding-left:20px; }
li { margin:6px 0; }
footer { margin-top:32px; padding-top:16px; border-top:1px solid var(--border);
  color:var(--muted); font-size:.875rem; }
</style>
</head>
<body>
<main>
  <p class="badge">AegisX-Memory · MCP endpoint</p>
  <h1>This is an MCP endpoint, not a web page.</h1>
  <p class="lead">The address <code>${address}</code> speaks the Model Context Protocol — it is
  how your AI agent reads and writes local project memory.</p>

  <h2>Nothing is broken</h2>
  <p>The error that brought you here — <code>406 Not Acceptable: Client must accept
  text/event-stream</code> — is the server working as designed. Under the Streamable HTTP
  spec, a <code>GET</code> to an MCP endpoint asks for a server→client <em>event stream</em>.
  A browser cannot accept one, so the request is refused rather than silently treated as an
  agent connection.</p>

  <h2>What you probably wanted</h2>
  <p>If you came here looking for something to <em>look at</em>, that is the dashboard — a local,
  read-only view of what this machine remembers:</p>
  <pre><code>aegisxmemory dashboard</code></pre>
  <p>It prints its own address (by default <code>http://127.0.0.1:3360</code>) and opens in your browser.</p>

  <h2>If you are connecting an agent</h2>
  <ul>
    <li>Most agents should use the <strong>stdio</strong> transport instead, which the agent spawns by
      itself: run <code>aegisxmemory setup</code> (or
      <code>aegisxmemory mcp-config --install --agent hermes</code>) and restart the agent.</li>
    <li>This HTTP transport is for agents that cannot spawn a subprocess. Point them at
      <code>http://${address}/mcp</code>${opts.token ? ', with the bearer token you configured' : ''}.</li>
  </ul>
  <p>Verify it responds to MCP (this should print five tool names):</p>
  <pre><code>curl -s http://${address}/mcp \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[].name'</code></pre>

  <footer>
    Bound to <code>${address}</code> (localhost only) ·
    ${opts.token ? 'a bearer token is required for MCP requests' : 'no bearer token configured'} ·
    data stays in <code>~/.aegisx</code> on this machine.
  </footer>
</main>
</body>
</html>
`;
}

function handleTransportError(res: http.ServerResponse, err: unknown): void {
  if (res.writableEnded || res.headersSent) {
    res.destroy();
  } else {
    respondJson(res, 500, { error: errorMessage(err) });
  }
}

/**
 * A server instance bound to a caller-owned engine.
 *
 * The SDK gives a protocol object exactly one transport for its lifetime:
 * `connect()` throws on a second call and `close()` never clears the slot. A
 * single shared server therefore meant that one long-lived `GET` event stream
 * held that slot forever, and every later request — from any client — answered
 * `500 "Already connected to a transport"` until the process was restarted.
 * A server per request is what the SDK documents for stateless HTTP; the engine
 * (which owns the SQLite connection) stays shared and cheap.
 */
export function buildMcpServer(engine: Engine): McpServer {
  const server = new McpServer({ name: 'aegisx-memory', version: '1.0.0' }, { instructions: SERVER_INSTRUCTIONS });

  // One shared registration, so the HTTP transport exposes exactly the same
  // tools as stdio — including `aegisxmemory_graph`, which this server used to
  // be missing while the README promised it.
  registerMemoryTools(server, engine);

  return server;
}

/** Start the HTTP MCP server. Resolves once the listener is up. */
export function startHttpServer(options: ServeOptions): Promise<{ close(): Promise<void>; port: number }> {
  // Defense in depth: an empty-string token from a raw ServeOptions consumer
  // is no credential — treat it exactly like "no token configured".
  const token = options.token !== null && options.token.trim() === '' ? null : options.token;
  // One engine (one SQLite connection) for every request; one server each.
  const engine = new Engine(dbPath());

  const httpServer = http.createServer((req, res) => {
    const host = req.headers['host'] ?? '';
    if (!isLocalHostHeader(host)) {
      respondJson(res, 403, { error: 'forbidden host (DNS-rebinding guard)' });
      return;
    }
    // A person who opened this address in a browser gets an explanation instead
    // of a JSON-RPC error. Deliberately placed before the token check: the page
    // carries no stored data, only a description of this endpoint, and the
    // token-protected case is exactly when someone is most likely to be
    // confused about why their browser cannot talk to it. The page states
    // whether a token is required. Real MCP clients never reach this branch —
    // `wantsHtmlPage` ignores anything that asks for the event stream.
    if (wantsHtmlPage(req.headers['accept'])) {
      const bound = httpServer.address();
      const port = typeof bound === 'object' && bound !== null ? bound.port : options.port;
      // One nonce per response, and the same one in the header and the <style>.
      const nonce = crypto.randomBytes(16).toString('base64');
      respondHtml(
        res,
        406,
        renderMcpLandingPage({ host: options.host, port, token: token !== null, nonce }),
        nonce,
      );
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
          const server = buildMcpServer(engine);
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          // Subscribed before `connect` so a throwing connect is still cleaned
          // up; `server.close()` also closes the transport it owns.
          res.on('close', () => {
            void server.close().catch(() => undefined);
          });
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
          }
        })();
      });
      return;
    }

    // GET / DELETE: no body to cap; the transport owns the (empty) stream.
    // A held-open GET stream is exactly the case that must not block the next
    // request, which is why the server is created here and not shared.
    const server = buildMcpServer(engine);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void server.close().catch(() => undefined);
    });
    void (async () => {
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        handleTransportError(res, err);
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
