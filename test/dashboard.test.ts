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

  it('facts panel: a re-pinned key arrives with the value it replaced', async () => {
    engine.remember('project.demo.dev-port', '3000', null);
    engine.remember('project.demo.dev-port', '5000', null);
    engine.remember('project.demo.stack', 'node', null);

    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const data = await get(stopper.url, '/api/data');
    const parsed = JSON.parse(data.body) as {
      facts: Array<{ key: string; value: string; updatedAt: string; previousValue?: string }>;
    };
    const changed = parsed.facts.find((f) => f.key === 'project.demo.dev-port');
    expect(changed?.value).toBe('5000');
    expect(changed?.previousValue).toBe('3000');
    const fresh = parsed.facts.find((f) => f.key === 'project.demo.stack');
    expect(fresh?.previousValue).toBeUndefined();

    // The panel renders that data client-side: the page shell carries the section,
    // the script carries the changed-state markup, and neither embeds a stored value.
    const page = await get(stopper.url, '/');
    expect(page.body).toContain('Pinned facts');
    expect(page.body).not.toContain('3000');
    const js = await get(stopper.url, '/app.js');
    expect(js.body).toContain('changed since they were first pinned');
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

  it('assets: the stylesheet and script are served from this origin with correct types', async () => {
    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const css = await get(stopper.url, '/app.css');
    expect(css.status).toBe(200);
    expect(css.type).toContain('text/css');
    expect(css.body.length).toBeGreaterThan(1000);

    const js = await get(stopper.url, '/app.js');
    expect(js.status).toBe(200);
    expect(js.type).toContain('text/javascript');
    expect(js.body.length).toBeGreaterThan(1000);
  });

  it('theme: one token layer drives light, dark and auto, resolved before first paint', async () => {
    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const page = await get(stopper.url, '/');
    const css = await get(stopper.url, '/app.css');
    const js = await get(stopper.url, '/app.js');

    // the head script resolves the palette so the page never flashes the wrong one
    expect(page.body).toContain('data-theme');
    expect(page.body).toContain('id="theme"');
    // semantic tokens, with the dark palette as the only override block
    expect(css.body).toContain(':root[data-theme="dark"]');
    expect(css.body).toContain('--bg:');
    expect(css.body).toContain('--surface:');
    expect(css.body).toContain('--fg-muted:');
    expect(css.body).toContain('prefers-reduced-motion');
    // the script follows the system preference and cycles auto → light → dark
    expect(js.body).toContain("'auto', 'light', 'dark'");
    expect(js.body).toContain('prefers-color-scheme: dark');
  });

  it('a11y: landmarks, a live status region, keyboard-reachable bars and a graph fallback', async () => {
    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const page = await get(stopper.url, '/');
    const js = await get(stopper.url, '/app.js');

    expect(page.body).toContain('<main id="main"');
    expect(page.body).toContain('<header');
    expect(page.body).toContain('class="skip"');
    expect(page.body).toContain('aria-live="polite"');
    expect(page.body).toContain('aria-labelledby');
    expect(page.body).toContain('role="tooltip"');
    // chart bars are focusable and named; the graph has a table view for keyboards
    expect(js.body).toContain("tabindex: '0'");
    expect(js.body).toContain('aria-label');
    expect(js.body).toContain("'List view'");
  });

  it('perf: the graph keeps exactly one animation loop and stops it while the tab is hidden', async () => {
    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const js = await get(stopper.url, '/app.js');

    // Regression lock: the loop handle used to be re-declared inside render(), so
    // the old loop was never cancelled and a new one was added every refresh.
    expect(js.body).toContain('if (G.raf || reducedMotion())');
    expect(js.body).toContain('cancelAnimationFrame');
    expect(js.body).toContain("document.addEventListener('visibilitychange'");
  });

  it('offline posture: every asset is self-hosted and fetches stay same-origin', async () => {
    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const page = await get(stopper.url, '/');
    const css = await get(stopper.url, '/app.css');
    const js = await get(stopper.url, '/app.js');

    for (const asset of [page.body, css.body, js.body]) {
      const urls = asset.match(/https?:\/\/[^"'\s)]+/g) ?? [];
      // the SVG XML namespace is an identifier, not a network request
      expect(urls.filter((u) => u !== 'http://www.w3.org/2000/svg')).toEqual([]);
    }
    expect(page.body).toContain('href="/app.css"');
    expect(page.body).toContain('src="/app.js"');
    // no inline event handlers — behaviour lives entirely in /app.js
    expect(page.body).not.toMatch(/\son(click|load|error|change|input|submit|focus|blur|mouse\w+)=/i);

    const fetches = (js.body.match(/fetch\('[^']+'/g) ?? []).sort();
    expect(fetches).toEqual(["fetch('/api/data'", "fetch('/api/graph'"]);
  });
});
