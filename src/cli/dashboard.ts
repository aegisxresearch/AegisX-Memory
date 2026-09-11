/**
 * Local web dashboard: a read-only view of everything AegisX-Memory remembers.
 *
 *  - binds 127.0.0.1 only (refuses otherwise, mirroring `serve`);
 *  - one JSON endpoint (/api/data) composed by Engine.dashboardData();
 *  - a self-contained HTML page (inline CSS/JS, no CDN, works offline) that
 *    renders with textContent only — stored data can never inject markup.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Engine } from '../core/engine.js';
import { AegisxError } from '../core/types.js';

export interface DashboardOptions {
  port: number;
  host: string;
  open: boolean;
}

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AegisX-Memory — Dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0b0f17; color: #dbe4f0; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 32px 24px 64px; }
  .wrap { max-width: 1060px; margin: 0 auto; }
  h1 { font-size: 22px; letter-spacing: .3px; display: flex; align-items: center; gap: 10px; }
  h1 .dot { width: 10px; height: 10px; border-radius: 50%; background: #34d399; box-shadow: 0 0 8px #34d39988; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 1.4px; color: #7d8ba1; margin: 34px 0 12px; }
  .sub { color: #66738a; font-size: 13px; margin-top: 6px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-top: 22px; }
  .card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 16px 18px; }
  .card .k { font-size: 12px; color: #7d8ba1; text-transform: uppercase; letter-spacing: 1px; }
  .card .v { font-size: 26px; font-weight: 650; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .card .s { font-size: 12px; color: #8fa3bf; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; background: #111827; border: 1px solid #1f2937; border-radius: 12px; overflow: hidden; }
  th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .8px; color: #7d8ba1; padding: 10px 14px; border-bottom: 1px solid #1f2937; background: #0e1522; }
  td { padding: 10px 14px; border-bottom: 1px solid #17223a; font-variant-numeric: tabular-nums; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .pill { display: inline-block; padding: 1px 9px; border-radius: 99px; font-size: 12px; }
  .pill.ok { background: #052e22; color: #34d399; }
  .pill.miss { background: #2b1207; color: #fbbf24; }
  .bar { height: 8px; border-radius: 99px; background: #1f2937; overflow: hidden; margin-top: 6px; }
  .bar > i { display: block; height: 100%; background: linear-gradient(90deg,#34d399,#22d3ee); }
  ul { list-style: none; }
  li { padding: 9px 0; border-bottom: 1px solid #17223a; display: flex; gap: 10px; align-items: baseline; }
  li:last-child { border-bottom: none; }
  .key { color: #93c5fd; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; white-space: nowrap; }
  .repo { color: #a78bfa; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .muted { color: #8fa3bf; }
  .empty { color: #66738a; padding: 18px 0; font-style: italic; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  svg { display: block; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  @media (max-width: 800px) { .grid2 { grid-template-columns: 1fr; } }
  .panel { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 14px 16px; }
  .panel h3 { font-size: 12px; color: #7d8ba1; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
  footer { margin-top: 40px; color: #4b566b; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1><span class="dot"></span> AegisX-Memory <span class="muted" style="font-weight:400">· dashboard</span></h1>
  <div class="sub">Everything the local memory engine knows. Read-only · refreshes every 10s · nothing leaves this machine.</div>

  <div class="cards" id="cards"></div>

  <h2>Recall history — hit vs miss</h2>
  <div class="panel" id="chart"></div>

  <h2>Knowledge graph</h2>
  <div class="panel" id="graph"></div>

  <h2>Per-repo memory</h2>
  <div id="repos"></div>

  <h2>Pinned facts</h2>
  <div id="facts"></div>

  <h2>Recent session handoffs</h2>
  <div id="sessions"></div>

  <footer>AegisX-Memory · local-first memory for AI coding agents · data lives in ~/.aegisx</footer>
</div>
<script>
'use strict';
const esc = (s) => String(s ?? '');
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = esc(text);
  return n;
}
function sparkline(values) {
  const W = 960, H = 70, P = 4;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', H);
  if (!values.length) return svg;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? (W - 2 * P) / (values.length - 1) : 0;
  const pts = values.map((v, i) => [P + i * step, H - P - (v / max) * (H - 2 * P)]);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' '));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#22d3ee');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}
function render(d) {
  const saved = (d.repos || []).reduce((a, r) => a + (r.tokensSavedEstimate || 0), 0);
  const cards = [
    ['Repos', (d.repos || []).length, 'with memory or telemetry'],
    ['Facts', d.totals.facts, 'pinned stable facts'],
    ['Knowledge', d.totals.knowledge, 'decisions · gotchas · lessons'],
    ['Sessions', d.totals.sessions, 'handoffs stored'],
    ['Tokens saved (est.)', saved.toLocaleString(), 'vs full re-reads'],
  ];
  const c = document.getElementById('cards'); c.replaceChildren();
  for (const [k, v, s] of cards) {
    const card = el('div', 'card');
    card.appendChild(el('div', 'k', k));
    card.appendChild(el('div', 'v', v));
    card.appendChild(el('div', 's', s));
    c.appendChild(card);
  }

  // chart: last 50 recalls, one thin bar each; teal = hit, amber = miss
  const chart = document.getElementById('chart'); chart.replaceChildren();
  const recalls = d.recalls || [];
  if (!recalls.length) {
    chart.appendChild(el('div', 'empty', 'No recalls yet — ask your agent to “recall the project memory”.'));
  } else {
    const W = 960, H = 90;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', H);
    const n = recalls.length;
    const bw = Math.max(3, Math.floor(W / n) - 3);
    recalls.forEach((r, i) => {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      const x = 6 + (i * (W - 12)) / n;
      const h = 20 + ((r.tokenEstimate || 0) / 2000) * (H - 30);
      rect.setAttribute('x', x); rect.setAttribute('y', H - h);
      rect.setAttribute('width', bw); rect.setAttribute('height', h);
      rect.setAttribute('rx', 2);
      rect.setAttribute('fill', r.hit ? '#34d399' : '#fbbf24');
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      t.textContent = (r.repo || '') + ' · ' + (r.hit ? 'hit' : 'miss') + ' · ~' + r.tokenEstimate + ' tokens' + (r.query ? ' · q: ' + r.query : '');
      rect.appendChild(t);
      svg.appendChild(rect);
    });
    chart.appendChild(svg);
    chart.appendChild(el('div', 'sub', 'Hover bars for details · height ≈ tokens returned · teal = hit, amber = cold miss'));
  }

  // knowledge graph: repos as hubs, facts/knowledge/sessions orbiting them
  const gp = document.getElementById('graph'); gp.replaceChildren();
  const g = d.graph || { nodes: [], edges: [] };
  if (!g.nodes.length) {
    gp.appendChild(el('div', 'empty', 'Graph is empty — index a project or save a fact to grow the map.'));
  } else {
    const W = 960, H = 480;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', '100%');
    svg.style.touchAction = 'none';
    // deterministic radial seed by id hash → stable layout across refreshes
    const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h >>> 0; };
    const pos = new Map();
    for (const n of g.nodes) {
      const h = hash(n.id);
      const a = (h % 3600) / 3600 * 2 * Math.PI;
      const r = n.kind === 'repo' ? 40 : 90 + (h % 120);
      pos.set(n.id, { x: W / 2 + Math.cos(a) * r * (W / H) * 0.6, y: H / 2 + Math.sin(a) * r, vx: 0, vy: 0, fixed: false });
    }
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const color = { repo: '#a78bfa', fact: '#34d399', knowledge: '#fbbf24', session: '#22d3ee' };
    const lines = [];
    for (const e of g.edges) {
      const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      ln.setAttribute('stroke', '#243149'); ln.setAttribute('stroke-width', '1');
      svg.appendChild(ln); lines.push([e, ln]);
    }
    const circles = [];
    const texts = [];
    for (const n of g.nodes) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      const r = n.kind === 'repo' ? 14 : n.kind === 'session' ? 7 : 9;
      c.setAttribute('r', r); c.setAttribute('fill', color[n.kind] || '#8fa3bf');
      c.setAttribute('stroke', '#0b0f17'); c.setAttribute('stroke-width', '2');
      c.style.cursor = 'grab';
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      t.textContent = (n.sub ? n.label + ' — ' + n.sub : n.label).slice(0, 300);
      c.appendChild(t);
      const tx = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      tx.textContent = n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label;
      tx.setAttribute('font-size', '10');
      tx.setAttribute('fill', n.kind === 'repo' ? '#a78bfa' : '#7d8ba1');
      tx.setAttribute('text-anchor', 'middle');
      tx.style.pointerEvents = 'none';
      svg.appendChild(c); svg.appendChild(tx);
      circles.push([n, c]); texts.push([n, tx]);
    }
    const legend = el('div', 'sub', '');
    legend.appendChild(document.createTextNode('● '));
    for (const [kind, col] of Object.entries(color)) {
      const b = document.createElement('span'); b.style.color = col; b.textContent = kind + '  ';
      legend.appendChild(b);
    }
    legend.appendChild(document.createTextNode('· drag nodes to untangle'));
    gp.appendChild(svg); gp.appendChild(legend);
    // physics: repulsion + spring edges + centering, few ticks per frame
    let raf = 0;
    const step = () => {
      const nodes = g.nodes, P = pos;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = P.get(nodes[i].id), b = P.get(nodes[j].id);
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = 0.5; dy = 0.5; d2 = 0.5; }
          if (d2 < 16000) { const f = 900 / d2, dl = Math.sqrt(d2); a.vx += dx / dl * f; a.vy += dy / dl * f; b.vx -= dx / dl * f; b.vy -= dy / dl * f; }
        }
      }
      for (const [e] of lines) {
        const a = P.get(e.source), b = P.get(e.target);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.max(1, Math.hypot(dx, dy));
        const f = (d - 120) * 0.004;
        a.vx += dx / d * f * d * 0.01; a.vy += dy / d * f * d * 0.01;
        b.vx -= dx / d * f * d * 0.01; b.vy -= dy / d * f * d * 0.01;
      }
      for (const n of nodes) {
        const p = P.get(n.id);
        if (p.fixed) { p.vx = p.vy = 0; continue; }
        p.vx += (W / 2 - p.x) * 0.002; p.vy += (H / 2 - p.y) * 0.002;
        p.vx *= 0.85; p.vy *= 0.85;
        p.x = Math.max(30, Math.min(W - 30, p.x + p.vx));
        p.y = Math.max(24, Math.min(H - 24, p.y + p.vy));
      }
      for (const [e, ln] of lines) {
        const a = P.get(e.source), b = P.get(e.target);
        if (a && b) { ln.setAttribute('x1', a.x); ln.setAttribute('y1', a.y); ln.setAttribute('x2', b.x); ln.setAttribute('y2', b.y); }
      }
      for (const [n, c] of circles) { const p = P.get(n.id); c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); }
      for (const [n, t] of texts) { const p = P.get(n.id); t.setAttribute('x', p.x); t.setAttribute('y', p.y + 22); }
      raf = requestAnimationFrame(step);
    };
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(step);
    // drag to rearrange
    let drag = null;
    svg.addEventListener('pointerdown', (ev) => {
      const target = ev.target;
      if (!(target instanceof SVGCircleElement)) return;
      for (const [n, c] of circles) {
        if (c === target) {
          const pt = svg.getBoundingClientRect();
          drag = { node: n, sx: ev.clientX, sy: ev.clientY, ox: pos.get(n.id).x, oy: pos.get(n.id).y, scale: W / pt.width };
          pos.get(n.id).fixed = true;
          svg.setPointerCapture(ev.pointerId);
          break;
        }
      }
    });
    svg.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      const p = pos.get(drag.node.id);
      p.x = Math.max(30, Math.min(W - 30, drag.ox + (ev.clientX - drag.sx) * drag.scale));
      p.y = Math.max(24, Math.min(H - 24, drag.oy + (ev.clientY - drag.sy) * drag.scale));
    });
    const endDrag = (ev) => { if (drag) { pos.get(drag.node.id).fixed = false; drag = null; try { svg.releasePointerCapture(ev.pointerId); } catch { /* already released */ } } };
    svg.addEventListener('pointerup', endDrag);
    svg.addEventListener('pointercancel', endDrag);
  }

  // repos table
  const rp = document.getElementById('repos'); rp.replaceChildren();
  if (!(d.repos || []).length) {
    const p = el('table'); const row = p.insertRow(); const cell = row.insertCell();
    cell.appendChild(el('div', 'empty', 'Nothing indexed yet — run “aegisxmemory index .” inside a project.'));
    rp.appendChild(p);
  } else {
    const t = el('table');
    const head = t.insertRow();
    for (const h of ['Repo', 'Files', 'Symbols', 'Scans', 'Recalls', 'Hit rate']) head.appendChild(el('th', null, h));
    for (const r of d.repos) {
      const row = t.insertRow();
      row.insertCell().appendChild(el('span', 'mono', r.repo));
      row.insertCell().textContent = r.files;
      row.insertCell().textContent = r.symbols;
      row.insertCell().textContent = r.scans;
      row.insertCell().textContent = r.recalls;
      const hc = row.insertCell();
      hc.textContent = r.hitRate === null ? '—' : r.hitRate + '%';
      const bar = el('div', 'bar'); const fill = el('i');
      fill.style.width = (r.hitRate || 0) + '%';
      bar.appendChild(fill); hc.appendChild(bar);
    }
    rp.appendChild(t);
  }

  // facts list
  const fl = document.getElementById('facts'); fl.replaceChildren();
  if (!(d.facts || []).length) {
    const p = el('div', 'panel'); p.appendChild(el('div', 'empty', 'No pinned facts yet — “aegisxmemory remember project.<name>.<key> <value>”.'));
    fl.appendChild(p);
  } else {
    const p = el('div', 'panel'); const ul = el('ul');
    for (const f of d.facts) {
      const li = el('li');
      li.appendChild(el('span', 'key', f.key));
      li.appendChild(el('span', null, f.value));
      li.appendChild(el('span', 'muted', f.repoHint ? '· ' + f.repoHint : ''));
      ul.appendChild(li);
    }
    p.appendChild(ul); fl.appendChild(p);
  }

  // sessions list
  const sl = document.getElementById('sessions'); sl.replaceChildren();
  if (!(d.sessions || []).length) {
    const p = el('div', 'panel'); p.appendChild(el('div', 'empty', 'No handoffs yet — end agent sessions with “save the session handoff”.'));
    sl.appendChild(p);
  } else {
    const p = el('div', 'panel'); const ul = el('ul');
    for (const s of d.sessions) {
      const li = el('li');
      li.appendChild(el('span', 'repo', s.repo));
      li.appendChild(el('span', null, s.goal));
      li.appendChild(el('span', 'muted', s.facts + ' facts · ' + s.decisions + ' decisions · ' + s.nextSteps + ' next · ' + s.createdAt.slice(0, 16).replace('T', ' ')));
      ul.appendChild(li);
    }
    p.appendChild(ul); sl.appendChild(p);
  }
}
let graphCache = { nodes: [], edges: [] };
async function tick() {
  try {
    const [dataRes, graphRes] = await Promise.all([fetch('/api/data'), fetch('/api/graph')]);
    if (!dataRes.ok) throw new Error('HTTP ' + dataRes.status);
    if (graphRes.ok) graphCache = await graphRes.json();
    const data = await dataRes.json();
    data.graph = graphCache;
    render(data);
  } catch (err) { /* transient — keep last good render */ }
}
tick();
setInterval(tick, 10000);
</script>
</body>
</html>`;

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    // best effort — the URL is printed anyway
  }
}

/** Start the dashboard server; resolves once listening. Returns a stopper. */
export function startDashboard(options: DashboardOptions, engine: Engine): Promise<{ url: string; stop(): Promise<void> }> {
  if (options.host !== '127.0.0.1' && options.host !== 'localhost') {
    throw new AegisxError('user', `refusing to bind the dashboard to ${options.host} — it exposes your memory without auth; keep it on 127.0.0.1`);
  }
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/' || url.startsWith('/index')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(PAGE_HTML);
        return;
      }
      if (url === '/api/data') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(engine.dashboardData()));
        return;
      }
      if (url === '/api/graph') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(engine.graphData()));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });
    server.on('error', (err) => reject(err));
    server.listen(options.port, options.host, () => {
      // Port 0 → the OS assigns a free port; report the real one.
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : options.port;
      const url = `http://${options.host}:${port}`;
      if (options.open) openBrowser(url);
      resolve({
        url,
        stop: () =>
          new Promise<void>((done) => {
            engine.close();
            server.close(() => done());
          }),
      });
    });
  });
}
