import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  startHttpServer,
  MAX_HTTP_BODY_BYTES,
  renderMcpLandingPage,
  wantsHtmlPage,
  type ServeOptions,
} from '../src/mcp/http-server.js';

let workspace: string;
const closeFns: Array<() => void | Promise<void>> = [];

async function start(opts: Partial<ServeOptions>): Promise<{ port: number }> {
  const h = await startHttpServer({ port: 0, host: '127.0.0.1', token: null, ...opts });
  closeFns.push(() => h.close());
  return { port: h.port };
}

function post(port: number, body: unknown, headers: Record<string, string> = {}, hostHeader = '127.0.0.1:0'): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': data.length,
          host: hostHeader.replace(':0', ':' + String(port)),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

/**
 * A `GET /mcp` with an explicit Accept header (or none at all).
 *
 * A GET that a real MCP client sends opens a held-open server→client event
 * stream, so the response never "ends". Resolve after a short quiet window
 * instead of waiting for an event that will not come, and release the socket.
 */
function get(
  port: number,
  accept: string | undefined,
  settleMs = 300,
): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'GET',
        agent: false,
        headers: {
          ...(accept === undefined ? {} : { accept }),
          host: `127.0.0.1:${String(port)}`,
        },
      },
      (res) => {
        let text = '';
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          req.destroy();
          resolve({ status: res.statusCode ?? 0, text, headers: res.headers });
        };
        const timer = setTimeout(finish, settleMs);
        res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
        res.on('end', finish);
      },
    );
    // An error after we already resolved (e.g. the socket we destroyed) is
    // ignored by the promise; this listener only exists to stop it crashing.
    req.on('error', (err: Error) => reject(err));
    req.end();
  });
}

/**
 * Open a `GET /mcp` event stream and leave it open, the way an idle MCP client
 * does. Resolves once the response headers arrive — the body never ends — and
 * hands back a teardown so the suite can release the socket.
 */
function openStream(
  port: number,
  accept: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'GET',
        agent: false,
        headers: { accept, host: `127.0.0.1:${String(port)}` },
      },
      (res) => {
        res.on('data', () => undefined); // drain, then hold
        resolve({ status: res.statusCode ?? 0, headers: res.headers, close: () => req.destroy() });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vitest-probe', version: '0.0.0' },
  },
};

/**
 * Raw body sender for DoS tests: streams `totalBytes` in `chunkBytes` chunks,
 * either with a declared Content-Length (declaration = true) or chunked without
 * one (declaration = false). Resolves with the response status, or with the
 * client-side socket error when the server tears the connection down mid-send.
 */
function rawPost(
  port: number,
  totalBytes: number,
  chunkBytes: number,
  declaration: boolean,
): Promise<{ kind: 'response'; status: number } | { kind: 'error'; error: string }> {
  return new Promise((resolve, reject) => {
    // One-off agent: an oversized request gets its socket destroyed by the
    // server; Node's keep-alive agent pool would otherwise hand that dead
    // socket to a later request on the same connection ("socket hang up").
    const agent = new http.Agent({ keepAlive: false });
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        agent,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(declaration ? { 'content-length': totalBytes } : { 'transfer-encoding': 'chunked' }),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          agent.destroy();
          resolve({ kind: 'response', status: res.statusCode ?? 0 });
        });
      },
    );
    req.on('error', (err: Error) => {
      agent.destroy();
      resolve({ kind: 'error', error: err.message });
    });
    const chunk = Buffer.alloc(chunkBytes, 0x78); // 'x' padding
    let sent = 0;
    const pump = (): void => {
      while (sent < totalBytes) {
        const size = Math.min(chunkBytes, totalBytes - sent);
        sent += size;
        if (!req.write(size === chunkBytes ? chunk : chunk.subarray(0, size))) {
          req.once('drain', pump);
          return;
        }
      }
      req.end();
    };
    req.on('socket', () => setImmediate(pump));
    // Safety net: never hang the suite on a pathological socket.
    setTimeout(() => reject(new Error('rawPost timed out')), 15_000).unref();
  });
}

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-http-'));
  process.env['AEGISX_HOME'] = workspace;
});

afterAll(async () => {
  delete process.env['AEGISX_HOME'];
  // LIFO: client sockets are registered after the servers that own them, and
  // `server.close()` waits for open connections — so release the clients first.
  for (const close of [...closeFns].reverse()) {
    await close();
  }
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('aegisxmemory serve — HTTP MCP transport', () => {
  it('end-to-end: initialize → tools/list → tools/call over real HTTP', async () => {
    process.env['AEGISX_HOME'] = path.join(workspace, 'e2e'); // fresh DB per scenario
    const { port } = await start({});

    const init = await post(port, INIT);
    expect(init.status).toBe(200);
    expect(init.text).toContain('"aegisx-memory"');

    const list = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.status).toBe(200);
    expect(list.text).toContain('aegisxmemory_recall');
    expect(list.text).toContain('aegisxmemory_index');

    const call = await post(port, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'aegisxmemory_remember', arguments: { key: 'project.httptest.stack', value: 'http transport works' } },
    });
    expect(call.status).toBe(200);
    expect(call.text).toContain('saved project.httptest.stack');

    const recall = await post(port, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'aegisxmemory_recall', arguments: {} },
    });
    expect(recall.status).toBe(200);
    expect(recall.text).toContain('AEGISX-MEMORY:BEGIN');
    expect(recall.text).toContain('http transport works');
  });

  it('parity: exposes the same five tools as the stdio transport, graph included', async () => {
    process.env['AEGISX_HOME'] = path.join(workspace, 'parity');
    const { port } = await start({});

    const list = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.status).toBe(200);
    // The same set test/mcp-stdio.test.ts asserts over stdio — the two
    // transports share one registration (src/mcp/tools.ts), and this locks it:
    // the HTTP server used to be missing aegisxmemory_graph while the README
    // promised five tools.
    const names = [...new Set([...list.text.matchAll(/"name":"(aegisxmemory_[a-z_]+)"/g)].map((m) => m[1]))].sort();
    expect(names).toEqual([
      'aegisxmemory_graph',
      'aegisxmemory_index',
      'aegisxmemory_recall',
      'aegisxmemory_remember',
      'aegisxmemory_save',
    ]);

    // and the graph tool answers here, not only over stdio
    const graph = await post(port, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'aegisxmemory_graph', arguments: {} },
    });
    expect(graph.status).toBe(200);
    expect(graph.text).toContain('memory graph');
  });

  it('auth: 401 without token, 200 with bearer token', async () => {
    process.env['AEGISX_HOME'] = path.join(workspace, 'auth');
    const { port } = await start({ token: 'secret-token-123' });

    const noAuth = await post(port, INIT);
    expect(noAuth.status).toBe(401);

    const badAuth = await post(port, INIT, { authorization: 'Bearer wrong' });
    expect(badAuth.status).toBe(401);

    const good = await post(port, INIT, { authorization: 'Bearer secret-token-123' });
    expect(good.status).toBe(200);
    expect(good.text).toContain('"aegisx-memory"');
  });

  it('security: non-local Host header rejected (DNS-rebinding guard)', async () => {
    process.env['AEGISX_HOME'] = path.join(workspace, 'guard');
    const { port } = await start({});
    const evil = await post(port, INIT, {}, 'evil.example.com');
    expect(evil.status).toBe(403);
  });

  it('dos: oversized declared Content-Length is rejected with 413 before reading', async () => {
    process.env['AEGISX_HOME'] = path.join(workspace, 'dos-declared');
    const { port } = await start({});
    // Declare a 5 MB body but send only the first chunk — the server must
    // refuse up front without ever reading the whole payload.
    const outcome = await rawPost(port, MAX_HTTP_BODY_BYTES + 1, 64 * 1024, false);
    expect(outcome).toEqual({ kind: 'response', status: 413 });
  });

  it('dos: oversized chunked stream (no Content-Length) is cut off mid-flight', async () => {
    process.env['AEGISX_HOME'] = path.join(workspace, 'dos-chunked');
    const { port } = await start({});
    // Stream 2 MB in 64 KB chunks with no declared length (Transfer-Encoding:
    // chunked) — the streaming guard must tear the socket down past the cap.
    const outcome = await rawPost(port, 2 * 1024 * 1024, 64 * 1024, true);
    // Either an explicit 413 response raced the teardown, or the socket was
    // destroyed mid-stream (client-side error). Both prove the guard fired.
    if (outcome.kind === 'response') {
      expect(outcome.status).toBe(413);
    } else {
      expect(outcome.error).toMatch(/socket|aborted|ECONNRESET|closed/i);
    }
  });

  it('dos: server stays healthy after oversized requests (regression for the crash path)', async () => {
    process.env['AEGISX_HOME'] = path.join(workspace, 'dos-recovery');
    const { port } = await start({});
    await rawPost(port, MAX_HTTP_BODY_BYTES + 1, 64 * 1024, false); // 413
    // D2 regression: before the safe error path, a handler exception after the
    // response ended could escape as an unhandled rejection and kill the server.
    const stillUp = await post(port, INIT);
    expect(stillUp.status).toBe(200);
    expect(stillUp.text).toContain('"aegisx-memory"');
  });

  it('dos: a normal request below the cap is unaffected', async () => {
    process.env['AEGISX_HOME'] = path.join(workspace, 'dos-normal');
    const { port } = await start({});
    const ok = await post(port, INIT);
    expect(ok.status).toBe(200);
  });

  it('browser: GET /mcp with text/html gets an explanation page, not raw JSON', async () => {
    process.env['AEGISX_HOME'] = path.join(workspace, 'landing');
    const { port } = await start({});

    // The exact Accept a browser sends when you paste the address in the bar.
    const page = await get(port, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    expect(page.status).toBe(406); // status is unchanged — only the body is friendly
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.text).toContain('<!doctype html>');
    expect(page.text).toContain('MCP endpoint, not a web page');
    expect(page.text).toContain('aegisxmemory dashboard');
    expect(page.text.trimStart().startsWith('<!doctype html>')).toBe(true);
    // Not the raw JSON-RPC error body (which ends with `"id":null`).
    expect(page.text).not.toContain('"id":null');

    // The CSP header and the <style> tag must carry the SAME nonce, or the
    // inline stylesheet is silently blocked and the page renders unstyled.
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    const fromHeader = /style-src 'nonce-([^']+)'/.exec(csp)?.[1];
    const fromStyle = /<style nonce="([^"]+)"/.exec(page.text)?.[1];
    expect(fromHeader).toBeDefined();
    expect(fromStyle).toBe(fromHeader);
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
  });

  it('agent: a client that accepts the event stream is never given HTML', async () => {
    process.env['AEGISX_HOME'] = path.join(workspace, 'landing-agent');
    const { port } = await start({});

    // A real MCP client still reaches the transport and gets the event stream
    // — not the page. (This response is deliberately held open.)
    const asMcp = await get(port, 'application/json, text/event-stream');
    expect(asMcp.headers['content-type']).toContain('text/event-stream');
    expect(asMcp.text).not.toContain('<!doctype html>');

    // A wildcard client, and a client with no Accept at all, are left alone too.
    const wildcard = await get(port, '*/*');
    expect(wildcard.status).toBe(406);
    expect(wildcard.headers['content-type']).toContain('application/json');
    expect(wildcard.text).toContain('text/event-stream');

    // No Accept header at all is a spec violation; the transport answers 406
    // itself. The HTML branch must never capture it.
    const none = await get(port, undefined);
    expect(none.status).toBe(406);
    expect(none.headers['content-type']).toContain('application/json');
    expect(none.text).not.toContain('<!doctype html>');
  });

  it('browser: the explanation is shown even when a bearer token is required', async () => {
    process.env['AEGISX_HOME'] = path.join(workspace, 'landing-token');
    const { port } = await start({ token: 'secret-token-123' });

    const page = await get(port, 'text/html');
    expect(page.status).toBe(406);
    expect(page.text).toContain('a bearer token is required for MCP requests');

    // The page explains the token; it does not hand out access.
    const denied = await post(port, INIT);
    expect(denied.status).toBe(401);
    expect(denied.text).toContain('unauthorized');
  });

  it('concurrency: an idle held-open stream does not wedge later requests', async () => {
    process.env['AEGISX_HOME'] = path.join(workspace, 'stream-held');
    const { port } = await start({});

    // An MCP client may open the server→client stream and keep it open while it
    // works. The SDK gives a protocol object exactly one transport for its
    // lifetime and `close()` never frees the slot, so a single shared server
    // lost that slot for good: the next request — from any client — answered
    // `500 Already connected to a transport` until the process restarted.
    const held = await openStream(port, 'application/json, text/event-stream');
    closeFns.push(held.close);
    expect(held.status).toBe(200);
    expect(held.headers['content-type']).toContain('text/event-stream');

    const after = await post(port, INIT);
    expect(after.status).toBe(200);
    expect(after.text).toContain('"aegisx-memory"');

    // Still open, and a second client is still fine.
    const list = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.status).toBe(200);
    expect(list.text).toContain('aegisxmemory_recall');
  });
});

describe('MCP landing page — detection and escaping', () => {
  it('captures browsers only, never anything that speaks MCP', () => {
    expect(wantsHtmlPage('text/html')).toBe(true);
    expect(wantsHtmlPage('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe(true);
    expect(wantsHtmlPage('application/json, text/event-stream')).toBe(false);
    expect(wantsHtmlPage('text/event-stream')).toBe(false);
    expect(wantsHtmlPage('*/*')).toBe(false);
    expect(wantsHtmlPage(undefined)).toBe(false);
    // A client willing to accept both is an MCP client — the stream wins.
    expect(wantsHtmlPage('text/html, text/event-stream')).toBe(false);
  });

  it('escapes the address it prints instead of injecting it', () => {
    const html = renderMcpLandingPage({
      host: '127.0.0.1"><script>x</script>',
      port: 3360,
      token: false,
      nonce: 'test-nonce',
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
    expect(html).toContain('<style nonce="test-nonce">');
  });
});
