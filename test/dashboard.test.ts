import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { MAX_DASHBOARD_BODY_BYTES, startDashboard } from '../src/cli/dashboard.js';
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
  pageScrollY = 0;
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

interface Reply {
  status: number;
  body: string;
  type: string;
  headers: Record<string, string | string[] | undefined>;
}

function get(url: string, pathname: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    http.get(new URL(pathname, url), (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body,
          type: String(res.headers['content-type'] ?? ''),
          headers: res.headers,
        }),
      );
    }).on('error', reject);
  });
}

/**
 * A POST with a JSON body — the only shape the dashboard's write endpoint
 * accepts. Everything (headers, body) is passed through so a test can send the
 * bytes it means to, including the ones the guards exist to refuse.
 */
function postJson(
  url: string,
  pathname: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const target = new URL(pathname, url);
    const req = http.request(
      {
        method: 'POST',
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: text,
            type: String(res.headers['content-type'] ?? ''),
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * A minimal DOM shim: just the API surface the served `/app.js` touches
 * (element creation, attributes, classes, events, focus). It is not a browser —
 * no layout, no CSS — but the graph geometry is computed in JavaScript, so its
 * output is inspectable here instead of only claimable.
 */
let focusTarget: ShimEl | null = null;
/** Page scroll offset: bars report viewport coords, so their rects shift with it. */
let pageScrollY = 0;

class ShimEl {
  readonly tag: string;
  readonly attrs: Record<string, string> = {};
  readonly children: ShimEl[] = [];
  readonly classes = new Set<string>();
  readonly style: Record<string, unknown> = {
    setProperty(this: Record<string, unknown>, key: string, value: unknown) { this[key] = value; },
  };
  parentNode: ShimEl | null = null;
  private ownText = '';
  hidden = false;
  disabled = false;
  value = '';
  offsetWidth = 120;
  scrollLeft = 0;
  readonly clientWidth = 960; // stand-in viewport: the chart fits its 960-unit view box
  private readonly listeners: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(tag: string) { this.tag = tag; }
  /** Like the DOM: reading aggregates descendants, writing replaces them. */
  get textContent(): string {
    if (this.children.length === 0) { return this.ownText; }
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    this.ownText = String(value);
    for (const child of this.children) { child.parentNode = null; }
    this.children.length = 0;
  }
  get className(): string { return [...this.classes].join(' '); }
  set className(value: string) { this.setAttribute('class', value); }
  /** `classList` and `className` are one attribute in a browser; keep both views in step. */
  get classList(): { add(...names: string[]): void; remove(...names: string[]): void; contains(name: string): boolean } {
    const self = this;
    return {
      add: (...names: string[]) => { for (const name of names) { self.classes.add(name); } self.syncClass(); },
      remove: (...names: string[]) => { for (const name of names) { self.classes.delete(name); } self.syncClass(); },
      contains: (name: string) => self.classes.has(name),
    };
  }
  private syncClass(): void {
    const joined = this.className;
    if (joined === '') { delete this.attrs['class']; } else { this.attrs['class'] = joined; }
  }
  get firstChild(): ShimEl | null { return this.children[0] ?? null; }
  get childElementCount(): number { return this.children.length; }
  setAttribute(key: string, value: unknown): void {
    const text = String(value);
    this.attrs[key] = text;
    if (key === 'class') {
      this.classes.clear();
      for (const part of text.split(/\s+/)) { if (part) { this.classes.add(part); } }
    }
  }
  getAttribute(key: string): string | null { return this.attrs[key] ?? null; }
  removeAttribute(key: string): void { delete this.attrs[key]; }
  appendChild(child: ShimEl): ShimEl { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child: ShimEl): ShimEl {
    const i = this.children.indexOf(child);
    if (i >= 0) { this.children.splice(i, 1); }
    child.parentNode = null;
    return child;
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  __dispatch(type: string, ev: unknown = {}): void { for (const fn of this.listeners[type] ?? []) { fn(ev); } }
  focus(): void { focusTarget = this; this.__dispatch('focus', { target: this }); }
  /**
   * Intrinsic content width of a scroll box: the explicit pixel width of the SVG
   * it holds, or its own client width when that SVG is fluid (width: 100%), which
   * is what makes "is there anything to scroll?" answerable here.
   */
  get scrollWidth(): number {
    const svg = this.children.find((child) => child.tag === 'svg');
    const raw = svg?.attrs['width'] ?? '';
    return raw.endsWith('px') ? Math.round(Number.parseFloat(raw)) : this.clientWidth;
  }
  /** How far the nearest scroll box has been scrolled; a bar's viewport x depends on it. */
  private scrollOffset(): number {
    let node: ShimEl | null = this.parentNode;
    while (node !== null) {
      if (node.classes.has('chart__scroll')) { return node.scrollLeft; }
      node = node.parentNode;
    }
    return 0;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number } {
    // Chart bars carry real geometry so the keep-in-view math can be asserted;
    // everything else keeps the original stand-in box.
    if (this.classes.has('bar')) {
      const x = Number(this.attrs['x']);
      const w = Number(this.attrs['width']);
      const h = Number(this.attrs['height']);
      if (Number.isFinite(x) && Number.isFinite(w) && Number.isFinite(h)) {
        const left = x - this.scrollOffset();
        const top = Number(this.attrs['y']) - pageScrollY;
        return { left, top, width: w, height: h, right: left + w, bottom: top + h };
      }
    }
    if (this.classes.has('chart__scroll')) {
      return { left: 0, top: 0, width: this.clientWidth, height: 152, right: this.clientWidth, bottom: 152 };
    }
    return { left: 0, top: 0, width: 960, height: 520, right: 960, bottom: 520 };
  }
  querySelector(): null { return null; }
  querySelectorAll(): [] { return []; }
}

function createDom(): { document: ShimEl; byId(id: string): ShimEl; nodes(): ShimEl[] } {
  const registry = new Map<string, ShimEl>();
  const doc = new ShimEl('#document') as ShimEl & {
    createElement(tag: string): ShimEl;
    createElementNS(ns: string, tag: string): ShimEl;
    getElementById(id: string): ShimEl;
    readyState: string;
    hidden: boolean;
    documentElement: ShimEl;
    body: ShimEl;
  };
  doc.readyState = 'complete';
  doc.hidden = false;
  doc.documentElement = new ShimEl('html');
  doc.body = new ShimEl('body');
  doc.appendChild(doc.documentElement);
  doc.appendChild(doc.body);
  doc.createElement = (tag: string) => new ShimEl(tag);
  doc.createElementNS = (_ns: string, tag: string) => new ShimEl(tag);
  // In a browser, `getElementById` returns a node that is already parsed into the
  // served HTML — so it must be reachable from the document tree here too.
  doc.getElementById = (id: string) => {
    let node = registry.get(id);
    if (!node) { node = new ShimEl('div'); registry.set(id, node); doc.body.appendChild(node); }
    return node;
  };
  Object.defineProperty(doc, 'activeElement', { get: () => focusTarget });
  const walk = (root: ShimEl, out: ShimEl[]): ShimEl[] => {
    for (const child of root.children) { out.push(child); walk(child, out); }
    return out;
  };
  return {
    document: doc,
    byId: (id: string) => doc.getElementById(id),
    nodes: () => walk(doc, []).filter((n) => n.tag === 'circle' && n.classes.has('node')),
  };
}

/** Every descendant of a shim node, in document order. */
function all(root: ShimEl, out: ShimEl[] = []): ShimEl[] {
  for (const child of root.children) { out.push(child); all(child, out); }
  return out;
}

/**
 * Run the served `/app.js` against a fresh DOM shim, with the real `/api` payloads
 * captured from the running server, and pump the layout loop to a stop. Shared by
 * the tests that assert on generated UI (the graph detail panel, the recall chart).
 */
/** Let queued promises (`fetch` → `json` → render) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 0)); }
}

async function runApp(
  url: string,
  navigatorShim: Record<string, unknown>,
  // A fresh script reads its stored preferences through this; the default keeps
  // every earlier test on a blank slate, and a Map-backed store exercises reload.
  storageShim: { getItem(key: string): string | null; setItem(key: string, value: string): void } = { getItem: () => null, setItem: () => undefined },
  // `innerHeight` + `scrollBy` make the vertical keep-in-view path observable.
  windowShim: Record<string, unknown> = { innerWidth: 1200 },
  // Per-URL `/api/memory` replies, so a repo page can be driven — and refused —
  // without a DB behind it. Anything not listed falls through to `/api/data`.
  memoryResponses: Record<string, { ok: boolean; body: unknown }> = {},
): Promise<{
  dom: ReturnType<typeof createDom>;
  graphProjection: { nodes: Array<{ id: string; kind: string; label: string; sub: string | null; repo: string | null }> };
  dataPayload: { recalls: Array<{ tokenEstimate: number }>; [key: string]: unknown };
  /** Every URL the client fetched, in order — which repos it actually asked for. */
  requested: string[];
  drive(limit: number): void;
  frames: number;
  /** Fire every scheduled timer once — how the readout's debounce is advanced. */
  runTimers(): void;
}> {
  const js = (await get(url, '/app.js')).body;
  const graphProjection = JSON.parse((await get(url, '/api/graph')).body) as {
    nodes: Array<{ id: string; kind: string; label: string; sub: string | null; repo: string | null }>;
  };
  const dataPayload = JSON.parse((await get(url, '/api/data')).body) as {
    recalls: Array<{ tokenEstimate: number }>;
    [key: string]: unknown;
  };
  const dom = createDom();
  const requested: string[] = [];
  let frames = 0;
  const rafQueue: Array<(t: number) => void> = [];
  const clock = { now: 0 };
  // Timers are queued, not fired: the app's debounce and its copy reset must be
  // stepped deliberately instead of racing the assertions.
  const timers = new Map<number, () => void>();
  let timerSeq = 0;
  const setTimeoutShim = (fn: () => void): number => { const id = ++timerSeq; timers.set(id, fn); return id; };
  const runTimers = (): void => {
    const batch = [...timers.values()];
    timers.clear();
    for (const fn of batch) { fn(); }
  };
  // eslint-disable-next-line no-new-func
  const run = new Function(
    'document', 'window', 'matchMedia', 'localStorage', 'fetch', 'requestAnimationFrame',
    'cancelAnimationFrame', 'setInterval', 'setTimeout', 'performance', 'navigator', 'Intl', js,
  );
  run(
    dom.document,
    windowShim,
    () => ({ matches: false, addEventListener: () => undefined }),
    storageShim,
    (u: string, init?: { method?: string; body?: string }) => {
      requested.push(u);
      const hit = memoryResponses[u];
      if (hit !== undefined) { return Promise.resolve({ ok: hit.ok, json: () => Promise.resolve(hit.body) }); }
      // The delete flow runs against the real endpoint, guards and all — a stub
      // that answered `ok: true` would prove the button exists and nothing else.
      if (u === '/api/knowledge/delete') {
        return postJson(url, u, init?.body ?? '{}').then((reply) => ({
          ok: reply.status === 200,
          json: () => Promise.resolve(JSON.parse(reply.body) as unknown),
        }));
      }
      // The repo page is served by the real endpoint unless a test overrides it,
      // so the client is exercised against actual rows rather than a stub shape.
      if (u.startsWith('/api/memory')) {
        return get(url, u).then((reply) => ({
          ok: reply.status === 200,
          json: () => Promise.resolve(JSON.parse(reply.body) as unknown),
        }));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(u === '/api/graph' ? graphProjection : dataPayload) });
    },
    (cb: (t: number) => void) => { rafQueue.push(cb); return rafQueue.length; },
    () => undefined,
    () => 0,
    setTimeoutShim,
    () => { clock.now += 16; return clock.now; },
    navigatorShim,
    Intl,
  );
  const drive = (limit: number): void => {
    for (let i = 0; i < limit && rafQueue.length > 0; i++) {
      frames += 1;
      const batch = rafQueue.splice(0, rafQueue.length);
      for (const cb of batch) cb(clock.now);
    }
  };
  for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 0)); drive(60); }
  return { dom, graphProjection, dataPayload, requested, drive, frames, runTimers };
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
      nodes: Array<{ id: string; kind: string; label: string; sub: string | null; repo: string | null }>;
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
    // every node names its repository directly (the detail panel reads it), and a
    // repo node's path is the same string its `sub` already carried
    expect(g.nodes.every((n) => typeof n.repo === 'string' || n.repo === null)).toBe(true);
    for (const n of g.nodes) { expect(n.repo).toBe(repoNode?.repo); }
    expect(repoNode?.repo).toBe(repoNode?.sub);
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
    expect(page.body).toContain('id="chart-readout"');
    // the chart is one Tab stop whose arrow keys move between bars; the graph has a table view
    expect(js.body).toContain("setAttribute('tabindex'");
    expect(js.body).toContain('function chartKey');
    expect(js.body).toContain("'step through bars'");
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
    expect(fetches).toEqual([
      "fetch('/api/data'",
      "fetch('/api/graph'",
      // The one write stays on this origin too; nothing is sent to a third party.
      "fetch('/api/knowledge/delete'",
      "fetch('/api/memory?repo='",
    ]);
  });

  it('security: every response carries a fresh CSP nonce and never allows inline', async () => {
    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const first = await get(stopper.url, '/');
    const second = await get(stopper.url, '/');

    const csp = String(first.headers['content-security-policy'] ?? '');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');

    const nonceOf = (reply: Reply): string | undefined =>
      /nonce-([A-Za-z0-9+/=]+)/.exec(String(reply.headers['content-security-policy'] ?? ''))?.[1];
    const nonce1 = nonceOf(first);
    const nonce2 = nonceOf(second);
    expect(nonce1).toBeTruthy();
    // A nonce that never changes is decoration, not a boundary.
    expect(nonce2).not.toBe(nonce1);
    expect(first.body).toContain('nonce="' + nonce1 + '"'); // authorises the theme bootstrap
    expect(first.body).not.toContain('__NONCE__'); // the placeholder is always substituted

    for (const reply of [first, await get(stopper.url, '/app.css'), await get(stopper.url, '/app.js'), await get(stopper.url, '/api/data')]) {
      expect(reply.headers['x-content-type-options']).toBe('nosniff');
      expect(reply.headers['referrer-policy']).toBe('no-referrer');
      expect(String(reply.headers['content-security-policy'] ?? '')).toContain("default-src 'none'");
    }
  });

  it('graph: the client lays the projection out, filters it, and never reshuffles it', async () => {
    // The layout lives in the served script, and there is no browser here — so the
    // script is executed against a tiny DOM shim with the real /api payloads. That
    // is what makes the "stable across polls" and "no overlaps" claims testable.
    const repo = path.join(workspace, 'proj');
    fs.mkdirSync(repo, { recursive: true });
    engine.remember('project.demo.stack', 'node', repo);
    const store = new Store(path.join(workspace, 'memory.sqlite'));
    store.saveKnowledge(repo, 'decision', 'pick sqlite', 'zero-config local storage', []);
    store.saveKnowledge(repo, 'gotcha', 'WAL needs a timeout', 'locks otherwise', []);
    store.close();
    engine.saveSession(repo, { goal: 'bootstrap', facts: ['x'], decisions: ['keep it local'], nextSteps: [] });

    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const js = (await get(stopper.url, '/app.js')).body;
    const graphProjection = JSON.parse((await get(stopper.url, '/api/graph')).body) as unknown;
    const dataPayload = JSON.parse((await get(stopper.url, '/api/data')).body) as unknown;

    const dom = createDom();
    let frames = 0;
    const rafQueue: Array<(t: number) => void> = [];
    const clock = { now: 0 };
    // eslint-disable-next-line no-new-func
    const run = new Function(
      'document', 'window', 'matchMedia', 'localStorage', 'fetch', 'requestAnimationFrame',
      'cancelAnimationFrame', 'setInterval', 'setTimeout', 'performance', 'navigator', 'Intl', js,
    );
    run(
      dom.document,
      { innerWidth: 1200 },
      () => ({ matches: false, addEventListener: () => undefined }),
      { getItem: () => null, setItem: () => undefined },
      (url: string) => Promise.resolve({ ok: true, json: () => Promise.resolve(url === '/api/graph' ? graphProjection : dataPayload) }),
      (cb: (t: number) => void) => { rafQueue.push(cb); return rafQueue.length; },
      () => undefined,
      () => 0,
      () => 0,
      () => { clock.now += 16; return clock.now; },
      {},
      Intl,
    );
    const drive = (limit: number): void => {
      for (let i = 0; i < limit && rafQueue.length > 0; i++) {
        frames += 1;
        const batch = rafQueue.splice(0, rafQueue.length);
        for (const cb of batch) cb(clock.now);
      }
    };
    // let the fetch chain resolve, then run the layout loop to a stop
    for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 0)); drive(60); }

    const projection = graphProjection as { nodes: Array<{ kind: string }> };
    const circles = dom.nodes();
    expect(circles.length).toBe(projection.nodes.length);
    expect(frames).toBeLessThan(400); // the loop stops when the layout settles
    const at = (n: number): { x: number; y: number } => ({ x: Number(circles[n]?.attrs['cx']), y: Number(circles[n]?.attrs['cy']) });
    const coords = circles.map((_, i) => at(i));
    for (const p of coords) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(960);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(520);
    }
    for (let i = 0; i < coords.length; i++) {
      for (let j = i + 1; j < coords.length; j++) {
        const d = Math.hypot(coords[i]!.x - coords[j]!.x, coords[i]!.y - coords[j]!.y);
        expect(d).toBeGreaterThan(18); // nodes are separated, not stacked on each other
      }
    }

    // a second identical poll must leave every node exactly where the user left it
    const before = dom.nodes().map((c) => [c.attrs['cx'], c.attrs['cy']].join(','));
    dom.document.__dispatch('visibilitychange'); // (no-op) keep the shim exercised
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 4; i++) { await new Promise((r) => setTimeout(r, 0)); drive(40); }
    const after = dom.nodes().map((c) => [c.attrs['cx'], c.attrs['cy']].join(','));
    expect(after).toEqual(before);

    // keyboard: arrow keys move the roving tab stop to another node
    const panel = dom.byId('graph');
    const firstTab = dom.nodes().findIndex((c) => c.attrs['tabindex'] === '0');
    panel.__dispatch('keydown', { key: 'ArrowRight', preventDefault: () => undefined });
    const secondTab = dom.nodes().findIndex((c) => c.attrs['tabindex'] === '0');
    expect(firstTab).toBeGreaterThanOrEqual(0);
    expect(secondTab).toBeGreaterThanOrEqual(0);
    expect(secondTab).not.toBe(firstTab);
    expect(dom.byId('graph-live').textContent).toContain('Selected');

    // the kind filter hides a whole group and says so in the badge
    const chips = dom.byId('graph-kinds').children;
    expect(chips.length).toBe(4);
    const knowledgeChip = chips.find((c) => c.textContent.includes('knowledge'));
    expect(knowledgeChip).toBeDefined();
    knowledgeChip?.__dispatch('click');
    // Derived from the payload, not hard-coded: the count is whatever that kind holds.
    const knowledgeCount = projection.nodes.filter((n) => n.kind === 'knowledge').length;
    expect(knowledgeCount).toBeGreaterThan(0);
    expect(dom.byId('graph-count').textContent).toContain(knowledgeCount + ' filtered out');
    const hidden = dom.nodes().filter((c) => (c.parentNode?.classes.has('is-off') ?? false)).length;
    expect(hidden).toBe(knowledgeCount);

    // list view is the same data as a table
    dom.byId('graph-view').__dispatch('click');
    const table = dom.byId('graph').children.find((c) => c.tag === 'div')?.children.find((c) => c.tag === 'table');
    expect(table?.children.some((c) => c.tag === 'tbody')).toBe(true);
    const rows = table?.children.find((c) => c.tag === 'tbody')?.children.length ?? 0;
    expect(rows).toBe(projection.nodes.length - knowledgeCount);
  });

  it('graph: the loading placeholder is cleared before the canvas takes over', async () => {
    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const js = await get(stopper.url, '/app.js');
    // Regression lock: the skeleton paragraph used to stay in the DOM above the
    // graph forever, and a failed graph fetch left it there as a stuck "Loading…".
    expect(js.body).toMatch(/function mountGraph\(\)[\s\S]{0,200}?clear\(host\)/);
    expect(js.body).toContain('Graph unavailable');
  });

  it('graph detail: a selected node shows its kind, repo and full text with a copy button', async () => {
    const repo = path.join(workspace, 'det');
    fs.mkdirSync(repo, { recursive: true });
    engine.remember('project.det.stack', 'flask', repo);
    const store = new Store(path.join(workspace, 'memory.sqlite'));
    store.saveKnowledge(repo, 'decision', 'pick sqlite', 'zero-config local storage', []);
    store.close();

    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const written: string[] = [];
    const { dom, graphProjection } = await runApp(stopper.url, {
      clipboard: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } },
    });

    const target = graphProjection.nodes.find((n) => n.kind === 'knowledge');
    expect(target).toBeDefined();
    const circle = dom.nodes().find((c) => c.attrs['aria-label'] === target!.kind + ': ' + target!.label);
    expect(circle).toBeDefined();
    circle!.__dispatch('click');

    const detail = dom.byId('graph-detail');
    expect(detail.hidden).toBe(false);
    // kind, repo and the untruncated body all reach the panel
    expect(detail.textContent).toContain('knowledge');
    const repoHint = target!.repo ?? '';
    expect(repoHint.length).toBeGreaterThan(0);
    expect(detail.textContent).toContain(repoHint);
    expect(detail.textContent).toContain('pick sqlite');
    expect(detail.textContent).toContain('zero-config local storage');

    // …and the copy button hands the full node text to the clipboard
    const copy = all(detail).find((e) => e.tag === 'button' && e.classes.has('copy'));
    expect(copy).toBeDefined();
    copy!.__dispatch('click');
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toEqual([target!.label + '\n' + (target!.sub ?? '')]);
    expect(copy!.textContent).toBe('copied');
  });

  it('chart: per-bar labels, a legend and arrow-key navigation between bars', async () => {
    const repo = path.join(workspace, 'chart');
    fs.mkdirSync(repo, { recursive: true });
    engine.remember('project.chart.stack', 'node', repo);
    engine.recall('first query', repo);
    engine.recall('second query', repo);
    engine.recall(null, repo);

    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const written: string[] = [];
    const { dom, dataPayload, runTimers } = await runApp(stopper.url, {
      clipboard: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } },
    });
    const recalls = dataPayload.recalls;
    expect(recalls.length).toBeGreaterThanOrEqual(3);

    const chart = dom.byId('chart');
    const els = all(chart);
    const bars = els.filter((e) => e.classes.has('bar'));
    const labels = els.filter((e) => e.classes.has('blabel'));
    expect(bars.length).toBe(recalls.length);
    // every bar got its own visible value, in the same order as the payload
    expect(labels.length).toBe(bars.length);
    const compact = (n: number): string => (n >= 1000000 ? Math.round(n / 100000) / 10 + 'M' : n >= 100000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? Math.round(n / 100) / 10 + 'k' : String(n));
    expect(labels.map((l) => l.textContent)).toEqual(recalls.map((r) => compact(r.tokenEstimate)));

    // the legend names both outcomes and the keyboard gesture
    expect(chart.textContent).toContain('warm hits');
    expect(chart.textContent).toContain('cold misses');
    expect(chart.textContent).toContain('step through bars');

    // the inline readout starts as a hint, and its copy button is inert until a bar is current
    expect(dom.byId('chart-readout').textContent).toContain('Tab to a bar');
    expect(dom.byId('chart-copy').disabled).toBe(true);

    // hover previews the same line, debounced so sweeping across bars cannot strobe it:
    // two bars are entered and one left before the timer runs, and only the last wins
    bars[0]!.__dispatch('pointerenter', { clientX: 10, clientY: 10, target: bars[0] });
    bars[0]!.__dispatch('pointerleave', {});
    bars[2]!.__dispatch('pointerenter', { clientX: 10, clientY: 10, target: bars[2] });
    expect(dom.byId('chart-readout').textContent).toContain('Tab to a bar'); // nothing committed yet
    runTimers();
    expect(dom.byId('chart-readout').textContent).toBe(bars[2]!.attrs['aria-label']);
    bars[2]!.__dispatch('pointerleave', {});
    runTimers();
    expect(dom.byId('chart-readout').textContent).toContain('Tab to a bar'); // reverts with no bar focused

    // roving tabindex: exactly one bar is the Tab stop, and the arrows move it
    const tabbed = (): number[] => bars.map((b, i) => (b.attrs['tabindex'] === '0' ? i : -1)).filter((i) => i >= 0);
    expect(tabbed()).toEqual([0]);
    chart.__dispatch('keydown', { key: 'ArrowRight', preventDefault: () => undefined });
    expect(tabbed()).toEqual([1]);
    expect(bars[1]!.classes.has('is-on')).toBe(true);
    expect(dom.byId('tip').hidden).toBe(false);
    expect(dom.byId('tip').textContent).toBe(bars[1]!.attrs['aria-label']);
    // …and the same full text is mirrored inline, so a long query reads without hover
    expect(dom.byId('chart-readout').textContent).toBe(bars[1]!.attrs['aria-label']);
    expect(dom.byId('chart-readout').textContent).toContain('second query');

    // the readout can be copied, and the payload is whichever bar is current — not the
    // one that happened to be current when the button was wired
    const copy = dom.byId('chart-copy');
    expect(copy.disabled).toBe(false);
    copy.__dispatch('click');
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toEqual([bars[1]!.attrs['aria-label']]);
    expect(copy.textContent).toBe('copied');
    chart.__dispatch('keydown', { key: 'ArrowRight', preventDefault: () => undefined });
    copy.__dispatch('click');
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toEqual([bars[1]!.attrs['aria-label'], bars[2]!.attrs['aria-label']]);

    chart.__dispatch('keydown', { key: 'End', preventDefault: () => undefined });
    expect(tabbed()).toEqual([bars.length - 1]);
    chart.__dispatch('keydown', { key: 'Home', preventDefault: () => undefined });
    expect(tabbed()).toEqual([0]);
    chart.__dispatch('keydown', { key: 'ArrowLeft', preventDefault: () => undefined });
    expect(tabbed()).toEqual([0]); // clamped at the first bar
  });

  it('chart: caps to the most recent recalls and the zoom toggle widens the bars', async () => {
    const repo = path.join(workspace, 'zoom');
    fs.mkdirSync(repo, { recursive: true });
    engine.remember('project.zoom.stack', 'node', repo);
    for (let i = 0; i < 35; i++) { engine.recall('query ' + i, repo); }

    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const { dom, dataPayload } = await runApp(stopper.url, {});
    const total = dataPayload.recalls.length;
    expect(total).toBeGreaterThan(30);

    const chart = dom.byId('chart');
    const view = (): { bars: ShimEl[]; labels: ShimEl[]; svg: ShimEl | undefined } => {
      const els = all(chart);
      return {
        bars: els.filter((e) => e.classes.has('bar')),
        labels: els.filter((e) => e.classes.has('blabel')),
        svg: els.find((e) => e.tag === 'svg'),
      };
    };

    // the cap is stated, not silent, and it is the tail (most recent) that is drawn
    let v = view();
    expect(v.bars.length).toBe(30);
    expect(v.labels.length).toBe(30);
    expect(chart.textContent).toContain('last 30 of ' + total);
    expect(dom.byId('recall-count').textContent).toContain('last 30 of ' + total);

    // fit mode: the chart fills the view and every label is horizontal
    expect(v.svg?.attrs['width']).toBe('100%');
    expect(v.labels.every((l) => l.attrs['transform'] === undefined)).toBe(true);

    // zoom: an explicit pixel canvas, wider than the fit view, same 30 bars,
    // larger labels — this is what keeps them legible instead of rotated
    dom.byId('chart-zoom').__dispatch('click');
    v = view();
    expect(v.bars.length).toBe(30);
    expect(v.labels.length).toBe(30);
    const width = v.svg?.attrs['width'] ?? '';
    expect(width.endsWith('px')).toBe(true);
    expect(Number.parseFloat(width)).toBeGreaterThan(960);
    expect(v.labels.every((l) => l.attrs['transform'] === undefined)).toBe(true);
    expect(v.labels[0]?.attrs['font-size']).toBe('11');
    expect(dom.byId('chart-zoom').attrs['aria-pressed']).toBe('true');
    expect(dom.byId('chart-zoom').textContent).toBe('Fit');
    expect(chart.textContent).toContain('scroll sideways');

    // the focused bar is kept in view: stepping to the far end scrolls it into the panel
    const scroller = (): ShimEl => all(chart).find((e) => e.classes.has('chart__scroll'))!;
    expect(scroller().scrollLeft).toBe(0);
    chart.__dispatch('keydown', { key: 'End', preventDefault: () => undefined });
    expect(scroller().scrollLeft).toBeGreaterThan(0);
    const lastBar = v.bars[v.bars.length - 1]!;
    expect(lastBar.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
    expect(lastBar.getBoundingClientRect().right).toBeLessThanOrEqual(scroller().clientWidth);
    // …and going back to the first bar scrolls home again
    chart.__dispatch('keydown', { key: 'Home', preventDefault: () => undefined });
    expect(scroller().scrollLeft).toBe(0);

    // back to fit: nothing overflows, so a step must not move the view at all
    dom.byId('chart-zoom').__dispatch('click');
    v = view();
    expect(v.svg?.attrs['width']).toBe('100%');
    chart.__dispatch('keydown', { key: 'End', preventDefault: () => undefined });
    expect(scroller().scrollLeft).toBe(0);
    expect(dom.byId('chart-zoom').attrs['aria-pressed']).toBe('false');
    expect(dom.byId('chart-zoom').textContent).toBe('Zoom');
  });

  it('chart: a short viewport keeps the focused bar wholly visible', async () => {
    const repo = path.join(workspace, 'tall');
    fs.mkdirSync(repo, { recursive: true });
    engine.remember('project.tall.stack', 'node', repo);
    engine.recall('short query', repo);

    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    // Shorter than the 152-unit chart, taller than the tallest bar it can draw.
    const vh = 130;
    const windowShim = {
      innerWidth: 1200,
      get innerHeight(): number { return vh; },
      scrollBy: (_x: number, dy: number): void => { pageScrollY += dy; },
    };
    const { dom } = await runApp(stopper.url, {}, undefined, windowShim);

    const chart = dom.byId('chart');
    const bars = all(chart).filter((e) => e.classes.has('bar'));
    expect(bars.length).toBeGreaterThan(0);
    const bar = bars[bars.length - 1]!;
    expect(bar.getBoundingClientRect().bottom).toBeGreaterThan(vh); // starts below the fold
    expect(pageScrollY).toBe(0);

    // focusing it scrolls the page just enough to reveal the whole bar
    chart.__dispatch('keydown', { key: 'End', preventDefault: () => undefined });
    const shown = bar.getBoundingClientRect();
    expect(pageScrollY).toBeGreaterThan(0);
    expect(shown.top).toBeGreaterThanOrEqual(0);
    expect(shown.bottom).toBeLessThanOrEqual(vh);

    // and a page already scrolled far past the chart is scrolled back up to it
    pageScrollY = 400;
    chart.__dispatch('keydown', { key: 'Home', preventDefault: () => undefined });
    const back = bars[0]!.getBoundingClientRect();
    expect(pageScrollY).toBeLessThan(400);
    expect(back.top).toBeGreaterThanOrEqual(0);
    expect(back.bottom).toBeLessThanOrEqual(vh);
  });

  it('chart: the reader picks the cap and both chart preferences survive a reload', async () => {
    const repo = path.join(workspace, 'cap');
    fs.mkdirSync(repo, { recursive: true });
    engine.remember('project.cap.stack', 'node', repo);
    for (let i = 0; i < 35; i++) { engine.recall('query ' + i, repo); }

    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => { store.set(k, v); },
    };

    const first = await runApp(stopper.url, {}, storage);
    const total = first.dataPayload.recalls.length;
    expect(total).toBeGreaterThan(30);
    const chart = first.dom.byId('chart');
    const barsOf = (root: ShimEl): number => all(root).filter((e) => e.classes.has('bar')).length;

    // the select agrees with the default, and nothing is stored until it is changed
    expect(first.dom.byId('chart-cap').value).toBe('30');
    expect(barsOf(chart)).toBe(30);
    expect(store.size).toBe(0);

    // narrowing to 10 redraws to the chosen window — the reader's pick, not a constant
    first.dom.byId('chart-cap').value = '10';
    first.dom.byId('chart-cap').__dispatch('change');
    expect(barsOf(chart)).toBe(10);
    expect(chart.textContent).toContain('showing the last 10 of ' + total);
    expect(first.dom.byId('recall-count').textContent).toBe('last 10 of ' + total + ' events');
    expect(store.get('aegisx-chart-cap')).toBe('10');

    // zooming stores its own key too, and does not disturb the cap
    first.dom.byId('chart-zoom').__dispatch('click');
    expect(store.get('aegisx-chart-wide')).toBe('1');
    expect(barsOf(chart)).toBe(10);

    // a fresh script with the same storage starts where the reader left off
    const second = await runApp(stopper.url, {}, storage);
    expect(second.dom.byId('chart-cap').value).toBe('10');
    expect(second.dom.byId('chart-zoom').attrs['aria-pressed']).toBe('true');
    const chart2 = second.dom.byId('chart');
    const svg2 = all(chart2).find((e) => e.tag === 'svg');
    expect(String(svg2?.attrs['width']).endsWith('px')).toBe(true);
    expect(barsOf(chart2)).toBe(10);

    // "All" lifts the cap to everything the endpoint returned
    second.dom.byId('chart-cap').value = '0';
    second.dom.byId('chart-cap').__dispatch('change');
    expect(barsOf(chart2)).toBe(total);
    expect(second.dom.byId('recall-count').textContent).toBe(total + ' events');
    expect(store.get('aegisx-chart-cap')).toBe('0');

    // an unknown stored value falls back to the default rather than drawing nothing
    const junk = new Map<string, string>([['aegisx-chart-cap', 'banana']]);
    const third = await runApp(stopper.url, {}, { getItem: (k) => junk.get(k) ?? null, setItem: () => undefined });
    expect(third.dom.byId('chart-cap').value).toBe('30');
    expect(barsOf(third.dom.byId('chart'))).toBe(30);
  });

  it('memory: /api/memory returns one repo’s knowledge, facts and handoffs with true totals', async () => {
    const repo = path.join(workspace, 'mem-api');
    const other = path.join(workspace, 'mem-other');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    engine.remember('project.mem-api.stack', 'node', repo);
    engine.remember('project.mem-other.stack', 'go', other);
    engine.saveSession(repo, {
      goal: 'seed the memory browser',
      facts: ['one fact'],
      decisions: ['use sqlite over postgres because zero config'],
      gotchas: ['recall truncates long titles'],
      conventions: ['two-space indent'],
      nextSteps: ['read it back'],
    });
    engine.saveSession(other, {
      goal: 'unrelated work',
      facts: [],
      decisions: ['a decision from the other repo'],
      nextSteps: [],
    });

    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const url = stopper.url;

    const res = await get(url, '/api/memory?repo=' + encodeURIComponent(repo));
    expect(res.status).toBe(200);
    expect(res.type).toContain('application/json');
    const parsed = JSON.parse(res.body) as {
      repo: string;
      facts: Array<{ key: string }>;
      knowledge: Array<{ id?: number; kind: string; title: string; body: string }>;
      sessions: Array<{ goal: string; decisions: string[] }>;
      counts: { facts: number; knowledge: number; sessions: number };
    };
    expect(parsed.repo).toBe(repo);
    expect(parsed.counts).toEqual({ facts: 1, knowledge: 3, sessions: 1 });
    // The knowledge store's read side: every entry, with the id the delete
    // command takes and the bodies that recall's ten-item window cuts off.
    expect(parsed.knowledge.map((k) => k.kind).sort()).toEqual(['convention', 'decision', 'gotcha']);
    expect(parsed.knowledge.every((k) => typeof k.id === 'number' && k.id > 0)).toBe(true);
    expect(parsed.knowledge.find((k) => k.kind === 'convention')!.title).toBe('two-space indent');
    expect(parsed.knowledge.find((k) => k.kind === 'convention')!.body).toBe('two-space indent');
    // one repo's page never shows another repo's rows
    expect(parsed.facts.map((f) => f.key)).toEqual(['project.mem-api.stack']);
    expect(parsed.sessions.map((s) => s.goal)).toEqual(['seed the memory browser']);
    expect(res.body).not.toContain('unrelated');
    expect(res.body).not.toContain('project.mem-other');

    // a page needs a repo; asking for none is a caller error, not an empty one
    expect((await get(url, '/api/memory')).status).toBe(400);
    expect((await get(url, '/api/memory?repo=')).status).toBe(400);
  });

  it('memory: a policy-hidden repo is refused, not answered with an empty page', async () => {
    const allowed = path.join(workspace, 'allowed');
    const hidden = path.join(workspace, 'hidden');
    fs.mkdirSync(allowed, { recursive: true });
    fs.mkdirSync(hidden, { recursive: true });
    const store = new Store(path.join(workspace, 'memory.sqlite'));
    store.saveKnowledge(allowed, 'decision', 'allowed decision', 'allowed body', []);
    store.saveKnowledge(hidden, 'decision', 'hidden decision', 'hidden body', []);
    store.close();

    // The policy is read when an engine is constructed, so this scenario needs
    // its own — the module-level one is replaced, and afterEach still owns
    // closing whatever `engine` points at when the test ends.
    process.env['AEGISX_ALLOWED_REPOS'] = allowed;
    engine.close();
    engine = new Engine(path.join(workspace, 'memory.sqlite'));
    const dash = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    stopper = dash;

    const denied = await get(dash.url, '/api/memory?repo=' + encodeURIComponent(hidden));
    expect(denied.status).toBe(403);
    expect((JSON.parse(denied.body) as { error: string }).error).toMatch(/not in AEGISX_ALLOWED_REPOS/);
    expect(denied.body).not.toContain('hidden decision');

    const ok = await get(dash.url, '/api/memory?repo=' + encodeURIComponent(allowed));
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('allowed decision');
  });

  it('memory: reads a repo’s knowledge as text, and the graph is not part of that view', async () => {
    const repo = path.join(workspace, 'browse');
    fs.mkdirSync(repo, { recursive: true });
    const store = new Store(path.join(workspace, 'memory.sqlite'));
    store.saveKnowledge(repo, 'decision', 'pick sqlite over postgres', 'zero-config local storage', []);
    store.saveKnowledge(repo, 'gotcha', 'recall truncates long titles', 'the dedupe check compares a prefix', []);
    store.close();
    engine.remember('project.browse.stack', 'node + ts', repo);
    engine.saveSession(repo, {
      goal: 'browse this memory',
      facts: ['one fact'],
      decisions: ['ship it'],
      nextSteps: ['read it back'],
    });

    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const written: string[] = [];
    const prefs = new Map<string, string>();
    const { dom, requested } = await runApp(
      stopper.url,
      { clipboard: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } } },
      { getItem: (k) => prefs.get(k) ?? null, setItem: (k, v) => { prefs.set(k, v); } },
    );
    const memoryUrl = '/api/memory?repo=' + encodeURIComponent(repo);

    // Overview first: the knowledge page costs a fetch, so it is not loaded until asked for.
    expect(dom.byId('view-overview').hidden).toBe(false);
    expect(dom.byId('view-memory').hidden).toBe(true);
    expect(dom.byId('nav-overview').attrs['aria-pressed']).toBe('true');
    expect(requested).not.toContain(memoryUrl);

    dom.byId('nav-memory').__dispatch('click');
    await settle();

    expect(dom.byId('view-memory').hidden).toBe(false);
    expect(dom.byId('view-overview').hidden).toBe(true);
    expect(dom.byId('nav-memory').attrs['aria-pressed']).toBe('true');
    expect(dom.byId('nav-overview').attrs['aria-pressed']).toBe('false');
    expect(prefs.get('aegisx-view')).toBe('memory');
    expect(requested).toContain(memoryUrl);

    const host = dom.byId('mem-knowledge');
    const text = host.textContent;
    // The full sentences — title *and* body — are readable here, which is the
    // whole point: the graph only ever showed a 50-node projection of them.
    expect(text).toContain('pick sqlite over postgres');
    expect(text).toContain('zero-config local storage');
    expect(text).toContain('recall truncates long titles');
    expect(text).toContain('the dedupe check compares a prefix');
    expect(text).toContain('decision');
    expect(text).toContain('gotcha');
    // Two saved notes plus the session's own decision, which `save` also records.
    const cards = all(host).filter((n) => n.classes.has('mem-card'));
    expect(cards.length).toBe(3);
    expect(text).toContain('ship it');
    expect(dom.byId('mem-count').textContent).toBe('3 entries');
    expect(dom.byId('mem-note').textContent).toContain('3 entries stored for this repo');

    // Nothing in this view is the graph — reading memory here cannot depend on it.
    expect(all(dom.byId('view-memory')).some((n) => n.attrs['id'] === 'graph')).toBe(false);

    // The same repo's pinned facts and handoffs come along, full lists intact.
    expect(dom.byId('mem-facts').textContent).toContain('project.browse.stack');
    expect(dom.byId('mem-facts').textContent).toContain('node + ts');
    expect(dom.byId('mem-sessions').textContent).toContain('browse this memory');
    expect(dom.byId('mem-sessions').textContent).toContain('ship it');

    // Copy hands over the whole entry, not a label — and the cards follow the
    // newest-first order the endpoint returned.
    const live = JSON.parse((await get(stopper.url, memoryUrl)).body) as {
      knowledge: Array<{ kind: string; title: string; body: string }>;
    };
    const newest = live.knowledge[0]!;
    expect(cards[0]!.textContent).toContain(newest.title);
    const copy = all(cards[0]!).find((e) => e.tag === 'button' && e.classes.has('copy'));
    expect(copy).toBeDefined();
    copy!.__dispatch('click');
    await settle();
    expect(written).toEqual([newest.kind + ': ' + newest.title + '\n\n' + newest.body]);
    expect(copy!.textContent).toBe('copied');

    // The stored view is honoured by a fresh script.
    const again = await runApp(stopper.url, {}, { getItem: (k) => prefs.get(k) ?? null, setItem: (k, v) => { prefs.set(k, v); } });
    expect(again.dom.byId('view-memory').hidden).toBe(false);
    expect(again.requested).toContain(memoryUrl);
  });

  it('memory: filters, the repo picker and the truncation note stay honest', async () => {
    const alpha = path.join(workspace, 'alpha');
    const beta = path.join(workspace, 'beta');
    const refused = path.join(workspace, 'refused');
    for (const dir of [alpha, beta, refused]) { fs.mkdirSync(dir, { recursive: true }); }
    const store = new Store(path.join(workspace, 'memory.sqlite'));
    store.saveKnowledge(alpha, 'decision', 'alpha decision', 'alpha rationale', []);
    store.saveKnowledge(alpha, 'gotcha', 'alpha trap', 'the trap body', []);
    store.saveKnowledge(beta, 'convention', 'beta convention', 'beta rule', []);
    store.saveKnowledge(refused, 'lesson', 'refused lesson', 'cannot be read', []);
    store.close();

    const dash = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    stopper = dash;
    const liveFor = async (repo: string): Promise<Record<string, unknown>> =>
      JSON.parse((await get(dash.url, '/api/memory?repo=' + encodeURIComponent(repo))).body) as Record<string, unknown>;

    // Real payloads, except one repo whose stored total is inflated to 9 so the
    // "showing the newest 2 of 9" line has something true to say.
    const alphaPayload = await liveFor(alpha);
    const responses = {
      // Keys are the URLs the client actually builds — paths are percent-encoded.
      ['/api/memory?repo=' + encodeURIComponent(alpha)]: {
        ok: true,
        body: { ...alphaPayload, counts: { ...(alphaPayload['counts'] as object), knowledge: 9 } },
      },
      ['/api/memory?repo=' + encodeURIComponent(beta)]: { ok: true, body: await liveFor(beta) },
      ['/api/memory?repo=' + encodeURIComponent(refused)]: {
        ok: false,
        body: { error: 'repo "' + refused + '" is not in AEGISX_ALLOWED_REPOS' },
      },
    };

    const { dom, requested } = await runApp(
      stopper.url,
      {},
      { getItem: () => null, setItem: () => undefined },
      { innerWidth: 1200 },
      responses,
    );
    const memoryUrl = (repo: string): string => '/api/memory?repo=' + encodeURIComponent(repo);

    dom.byId('nav-memory').__dispatch('click');
    await settle();
    expect(requested).toContain(memoryUrl(alpha));

    // The picker offers every repo, and the page opens on the first one.
    const picker = dom.byId('mem-repo');
    expect(all(picker).filter((n) => n.tag === 'option').map((o) => o.textContent)).toEqual([alpha, beta, refused]);
    expect(picker.value).toBe(alpha);

    // …and says how much of the store it did not load instead of implying it showed all of it.
    expect(dom.byId('mem-note').textContent).toContain('showing the newest 2 of 9 entries stored for this repo');
    expect(dom.byId('mem-count').textContent).toBe('9 entries');

    // A kind chip is a filter, and its count is the loaded one.
    const kinds = all(dom.byId('mem-kinds')).filter((n) => n.classes.has('chip'));
    expect(kinds.map((k) => k.textContent)).toEqual(['decision 1', 'gotcha 1', 'convention', 'lesson']);
    const gotchaChip = kinds.find((k) => k.textContent === 'gotcha 1')!;
    gotchaChip.__dispatch('click');
    expect(gotchaChip.attrs['aria-pressed']).toBe('false');
    expect(dom.byId('mem-knowledge').textContent).not.toContain('alpha trap');
    expect(dom.byId('mem-knowledge').textContent).toContain('alpha decision');
    expect(dom.byId('mem-note').textContent).toContain('1 shown after filters');
    gotchaChip.__dispatch('click');
    expect(dom.byId('mem-knowledge').textContent).toContain('alpha trap');

    // The search box narrows over title, body and id.
    const search = dom.byId('mem-search');
    search.value = 'the trap body';
    search.__dispatch('input');
    expect(dom.byId('mem-knowledge').textContent).toContain('alpha trap');
    expect(dom.byId('mem-knowledge').textContent).not.toContain('alpha decision');
    expect(dom.byId('mem-note').textContent).toContain('1 shown after filters');
    search.value = 'nothing matches this';
    search.__dispatch('input');
    expect(dom.byId('mem-knowledge').textContent).toContain('No entry matches the current filters');
    search.value = '';
    search.__dispatch('input');

    // Switching repos refetches — one repo's page never shows another's memory.
    picker.value = beta;
    picker.__dispatch('change');
    await settle();
    expect(requested).toContain(memoryUrl(beta));
    expect(dom.byId('mem-knowledge').textContent).toContain('beta convention');
    expect(dom.byId('mem-knowledge').textContent).not.toContain('alpha decision');
    expect(picker.value).toBe(beta);
    expect(dom.byId('mem-note').textContent).toContain('1 entry stored for this repo');

    // A refused repo is shown as the refusal it is, never as an empty repo.
    picker.value = refused;
    picker.__dispatch('change');
    await settle();
    expect(requested).toContain(memoryUrl(refused));
    expect(dom.byId('mem-note').textContent).toContain('is not in AEGISX_ALLOWED_REPOS');
    expect(dom.byId('mem-knowledge').textContent).toContain('is not in AEGISX_ALLOWED_REPOS');
    expect(dom.byId('mem-knowledge').textContent).not.toContain('refused lesson');
  });

  it('memory: deletion is a guarded POST that trusts nothing but the dashboard itself', async () => {
    const repo = path.join(workspace, 'del');
    const hidden = path.join(workspace, 'del-hidden');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(hidden, { recursive: true });
    const store = new Store(path.join(workspace, 'memory.sqlite'));
    store.saveKnowledge(repo, 'decision', 'keep me', 'body one', []);
    const doomed = store.saveKnowledge(repo, 'gotcha', 'remove me', 'body two', []);
    const hiddenRow = store.saveKnowledge(hidden, 'decision', 'hidden entry', 'hidden body', []);
    store.close();

    // The allowlist is read when an engine is constructed, so this scenario owns
    // its own — as in the read-side test above.
    process.env['AEGISX_ALLOWED_REPOS'] = repo;
    engine.close();
    engine = new Engine(path.join(workspace, 'memory.sqlite'));
    const dash = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    stopper = dash;
    const url = dash.url;
    const del = '/api/knowledge/delete';
    const body = (id: number): string => JSON.stringify({ id });
    const titles = (repoPath: string): string[] =>
      engine.repoMemory(repoPath, 50).knowledge.map((k) => k.title);

    // The method is the first guard: an <img> or a link (the shapes a hostile
    // page can aim at a localhost server without a preflight) can only GET.
    const got = await get(url, del);
    expect(got.status).toBe(405);
    expect(got.headers['allow']).toBe('POST');

    // A form-shaped body cannot even reach the parser, and a cross-origin fetch
    // with a JSON body would need a preflight this server never grants.
    const form = await postJson(url, del, 'id=1', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(form.status).toBe(415);
    expect(form.body).toContain('application/json');
    const otherPort = await postJson(url, del, body(doomed.id!), { origin: 'http://127.0.0.1:9' });
    expect(otherPort.status).toBe(403);
    expect(otherPort.body).toContain('cross-origin');
    const crossSite = await postJson(url, del, body(doomed.id!), { 'sec-fetch-site': 'cross-site' });
    expect(crossSite.status).toBe(403);

    // A page that points its own domain at 127.0.0.1 must not reach this either.
    const rebind = await postJson(url, del, body(doomed.id!), { host: 'aegisx.attacker.test' });
    expect(rebind.status).toBe(403);
    expect(rebind.body).toContain('DNS-rebinding');

    // None of those refusals was a deletion.
    expect(titles(repo)).toContain('remove me');

    // The body must name a positive integer id — never coerced, never guessed.
    for (const bad of ['{}', '{"id":"3"}', '{"id":0}', '{"id":-1}', '{"id":1.5}', '{"id":null}']) {
      const res = await postJson(url, del, bad);
      expect(res.status).toBe(400);
      expect(res.body).toContain('positive integer');
    }
    // Unparseable JSON is also a 400, and it says why without echoing anything.
    const garbage = await postJson(url, del, 'not json');
    expect(garbage.status).toBe(400);
    expect(garbage.body).toContain('not valid JSON');
    expect(garbage.body).not.toContain('remove me');
    const oversized = await postJson(
      url,
      del,
      JSON.stringify({ id: doomed.id, pad: 'x'.repeat(MAX_DASHBOARD_BODY_BYTES) }),
    );
    expect(oversized.status).toBe(413);
    expect(oversized.body).toContain('too large');

    // An unknown id is a 404, not a quiet success.
    const unknown = await postJson(url, del, body(999_999));
    expect(unknown.status).toBe(404);
    expect(unknown.body).toContain('no knowledge entry');

    // A repo the policy hides is refused on the write side exactly as on the
    // read side, and its row is untouched.
    const denied = await postJson(url, del, body(hiddenRow.id!));
    expect(denied.status).toBe(403);
    expect(denied.body).toContain('not in AEGISX_ALLOWED_REPOS');
    const check = new Store(path.join(workspace, 'memory.sqlite'));
    expect(check.listKnowledge(50).map((k) => k.title)).toContain('hidden entry');
    check.close();

    // The caller that looks like this very page succeeds, and the row is gone.
    const ok = await postJson(url, del, body(doomed.id!), { origin: url, 'sec-fetch-site': 'same-origin' });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true, id: doomed.id, deleted: true });
    expect(titles(repo)).not.toContain('remove me');
    expect(titles(repo)).toContain('keep me');
    // Deleting it twice is honest about the second finding nothing.
    expect((await postJson(url, del, body(doomed.id!))).status).toBe(404);
  });

  it('memory: the page deletes an entry through that endpoint, asking first', async () => {
    const repo = path.join(workspace, 'del-ui');
    fs.mkdirSync(repo, { recursive: true });
    const store = new Store(path.join(workspace, 'memory.sqlite'));
    store.saveKnowledge(repo, 'decision', 'keep this one', 'still here', []);
    store.saveKnowledge(repo, 'gotcha', 'delete this one', 'goes away', []);
    store.close();

    stopper = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, engine);
    const { dom, requested } = await runApp(stopper.url, {}, { getItem: () => null, setItem: () => undefined });
    dom.byId('nav-memory').__dispatch('click');
    await settle();
    expect(dom.byId('mem-knowledge').textContent).toContain('delete this one');

    const del = '/api/knowledge/delete';
    const removeBtn = (): ShimEl | undefined =>
      all(dom.byId('mem-knowledge')).find((e) => e.tag === 'button' && e.classes.has('btn--quiet-danger'));
    const confirmBtn = (): ShimEl | undefined =>
      all(dom.byId('mem-knowledge')).find((e) => e.tag === 'button' && e.classes.has('btn--danger'));
    const confirmBox = (): ShimEl | undefined =>
      all(dom.byId('mem-knowledge')).find((n) => n.classes.has('mem-card__confirm'));

    // One click only asks. Nothing is sent on the first click — that is the
    // whole point of a two-step delete.
    removeBtn()!.__dispatch('click');
    expect(requested).not.toContain(del);
    expect(confirmBox()).toBeDefined();
    expect(confirmBox()!.textContent).toContain('Delete #');
    expect(confirmBox()!.textContent).toContain('permanent');

    // Cancel is a real way out: the question goes, the request never does.
    const cancel = all(confirmBox()!).find((e) => e.tag === 'button' && e.textContent === 'cancel')!;
    cancel.__dispatch('click');
    expect(confirmBox()).toBeUndefined();
    expect(requested).not.toContain(del);

    // Ask again, then confirm for real.
    removeBtn()!.__dispatch('click');
    confirmBtn()!.__dispatch('click');
    await settle();
    expect(requested).toContain(del);

    // Server, list and totals all agree, and the page says what it did.
    const live = JSON.parse((await get(stopper.url, '/api/memory?repo=' + encodeURIComponent(repo))).body) as {
      knowledge: Array<{ title: string }>;
      counts: { knowledge: number };
    };
    expect(live.knowledge.map((k) => k.title)).toEqual(['keep this one']);
    expect(live.counts.knowledge).toBe(1);
    expect(dom.byId('mem-knowledge').textContent).not.toContain('goes away');
    expect(dom.byId('mem-knowledge').textContent).toContain('keep this one');
    expect(confirmBox()).toBeUndefined();
    expect(dom.byId('mem-note').textContent).toContain('deleted #');
    expect(dom.byId('mem-note').textContent).toContain('1 entry stored for this repo');
    expect(dom.byId('mem-count').textContent).toBe('1 entries');
  });
});
