import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startHttpServer, MAX_HTTP_BODY_BYTES, type ServeOptions } from '../src/mcp/http-server.js';

let workspace: string;
const closeFns: Array<() => Promise<void>> = [];

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
  for (const close of closeFns) {
    await close();
  }
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('aegisx serve — HTTP MCP transport', () => {
  it('end-to-end: initialize → tools/list → tools/call over real HTTP', async () => {
    process.env['AEGISX_HOME'] = path.join(workspace, 'e2e'); // fresh DB per scenario
    const { port } = await start({});

    const init = await post(port, INIT);
    expect(init.status).toBe(200);
    expect(init.text).toContain('"aegisx-memory"');

    const list = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.status).toBe(200);
    expect(list.text).toContain('aegisx_recall');
    expect(list.text).toContain('aegisx_index');

    const call = await post(port, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'aegisx_remember', arguments: { key: 'project.httptest.stack', value: 'http transport works' } },
    });
    expect(call.status).toBe(200);
    expect(call.text).toContain('saved project.httptest.stack');

    const recall = await post(port, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'aegisx_recall', arguments: {} },
    });
    expect(recall.status).toBe(200);
    expect(recall.text).toContain('AEGISX-MEMORY:BEGIN');
    expect(recall.text).toContain('http transport works');
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
});
