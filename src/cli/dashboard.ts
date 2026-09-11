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
async function tick() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    render(await res.json());
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
