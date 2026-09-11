import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startDashboard } from '../src/cli/dashboard.js';
import { Engine } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { AegisxError } from '../src/core/types.js';

let workspace: string;
let engine: Engine;
let stopper: { url: string; stop(): Promise<void> } | null = null;
let prevHome: string | undefined;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-dash-'));
  prevHome = process.env['AEGISX_HOME'];
  process.env['AEGISX_HOME'] = workspace;
  delete process.env['AEGISX_ALLOWED_REPOS'];
  engine = new Engine(path.join(workspace, 'memory.sqlite'));
});

afterEach(async () => {
  if (stopper !== null) {
    await stopper.stop();
    stopper = null;
  }
  engine.close();
  if (prevHome === undefined) delete process.env['AEGISX_HOME'];
  else process.env['AEGISX_HOME'] = prevHome;
  fs.rmSync(workspace, { recursive: true, force: true });
});

function get(url: string, pathname: string): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    http.get(new URL(pathname, url), (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body, type: String(res.headers['content-type'] ?? '') }),
      );
    }).on('error', reject);
  });
}

describe('dashboard — local web view', () => {
  it('happy: serves the page and JSON data reflecting seeded memory', async () => {
    engine.remember('project.demo.stack', 'node + typescript', null);
    engine.saveSession('/tmp/does-not-need-to-exist', {
      goal: 'bootstrap demo',
      facts: ['one fact'],
      decisions: [],
      nextSteps: ['write code'],
    });

    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const page = await get(stopper.url, '/');
    expect(page.status).toBe(200);
    expect(page.type).toContain('text/html');
    expect(page.body).toContain('AegisX-Memory');

    const data = await get(stopper.url, '/api/data');
    expect(data.type).toContain('application/json');
    const parsed = JSON.parse(data.body) as {
      repos: Array<{ repo: string; recalls: number }>;
      facts: Array<{ key: string; value: string }>;
      sessions: Array<{ goal: string; nextSteps: number }>;
      totals: { facts: number };
    };
    expect(parsed.totals.facts).toBe(1);
    expect(parsed.facts[0]?.value).toBe('node + typescript');
    expect(parsed.sessions[0]?.goal).toBe('bootstrap demo');
    expect(parsed.sessions[0]?.nextSteps).toBe(1);
    // The session repo is the normalized tmp path → visible in repos with 0 recalls.
    expect(parsed.repos.length).toBeGreaterThanOrEqual(1);
  });

  it('negative: unknown paths 404', async () => {
    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const res = await get(stopper.url, '/etc/passwd');
    expect(res.status).toBe(404);
  });

  it('security: refuses non-localhost binds (memory has no auth)', () => {
    expect(() => startDashboard({ port: 0, host: '0.0.0.0', open: false }, engine)).toThrow(AegisxError);
  });

  it('security: stored markup cannot inject into the page (static template + textContent rendering)', async () => {
    engine.remember('project.demo.note', '<script>alert(1)</script>', null);
    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const page = await get(stopper.url, '/');
    // The served HTML is a static template — user data arrives only via /api/data
    // and is inserted with textContent, so the raw payload is never in the page.
    expect(page.body).not.toContain('<script>alert(1)</script>');
    const data = await get(stopper.url, '/api/data');
    expect(data.body).toContain('<script>alert(1)</script>'); // JSON transports it verbatim
  });

  it('graph: /api/graph returns nodes and edges for facts, knowledge, sessions, repos', async () => {
    const repo = path.join(workspace, 'proj');
    fs.mkdirSync(repo, { recursive: true });
    engine.remember('project.demo.stack', 'node', repo);
    const store = new Store(path.join(workspace, 'memory.sqlite'));
    store.saveKnowledge(repo, 'decision', 'pick sqlite', 'zero-config local storage', []);
    store.close();
    engine.saveSession(repo, { goal: 'bootstrap', facts: ['x'], decisions: [], nextSteps: [] });

    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const res = await get(stopper.url, '/api/graph');
    expect(res.type).toContain('application/json');
    const g = JSON.parse(res.body) as {
      nodes: Array<{ id: string; kind: string; label: string }>;
      edges: Array<{ source: string; target: string; label: string }>;
    };
    const kinds = new Set(g.nodes.map((n) => n.kind));
    expect(kinds).toEqual(new Set(['repo', 'fact', 'knowledge', 'session']));
    const repoNode = g.nodes.find((n) => n.kind === 'repo');
    expect(repoNode).toBeDefined();
    // every non-repo node links to exactly its repo hub
    const linked = g.edges.filter((e) => e.target === repoNode?.id);
    expect(linked.length).toBe(3);
    expect(new Set(linked.map((e) => e.label))).toEqual(new Set(['belongs to', 'learned in', 'summarizes']));
    // page includes the graph section shell
    const page = await get(stopper.url, '/');
    expect(page.body).toContain('Knowledge graph');
  });
});
