/**
 * Local web dashboard: a read-only view of everything AegisX-Memory remembers.
 *
 *  - binds 127.0.0.1 only (refuses otherwise, mirroring `serve`);
 *  - one JSON endpoint (/api/data) composed by Engine.dashboardData(), plus
 *    /api/graph for the node projection;
 *  - page structure (`/`), stylesheet (`/app.css`) and script (`/app.js`) are
 *    all served from this origin: no CDN, no external requests, no build step,
 *    so the dashboard keeps working fully offline;
 *  - every stored value reaches the DOM through textContent/createElement, so a
 *    fact value can never inject markup into the page.
 *
 * Presentation lives in a semantic token layer (--bg/--surface/--fg/…) so the
 * light and dark palettes differ only in that one block; the theme is resolved
 * in the head script (auto → system, or an explicit Light/Dark override) to
 * avoid a flash of the wrong theme.
 */
import http from 'node:http';
import crypto from 'node:crypto';
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
<meta name="color-scheme" content="light dark">
<title>AegisX-Memory — Dashboard</title>
<link rel="icon" href="data:,">
<script nonce="__NONCE__">try{var m=localStorage.getItem('aegisx-theme')||'auto';var d=m==='dark'||(m==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.setAttribute('data-theme',d?'dark':'light');}catch(e){document.documentElement.setAttribute('data-theme','dark');}</script>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="topbar">
  <div class="brand">
    <span class="brand-dot" aria-hidden="true"></span>
    <h1>AegisX-Memory <span class="muted">dashboard</span></h1>
  </div>
  <div class="topbar-actions">
    <span id="status" class="status" role="status" aria-live="polite" data-state="stale">connecting…</span>
    <button id="theme" class="btn btn--ghost" type="button">Auto</button>
  </div>
</header>
<main id="main">
  <p class="lede">Everything the local memory engine knows. Read-only · refreshes every 10s · nothing leaves this machine.</p>

  <section class="bento" id="cards" aria-label="Memory totals"></section>

  <section class="block" aria-labelledby="h-recall">
    <div class="block-head">
      <h2 id="h-recall">Recall history</h2>
      <p class="hint">hit vs miss</p>
    </div>
    <div class="panel" id="chart"></div>
  </section>

  <section class="block" aria-labelledby="h-graph">
    <div class="block-head">
      <h2 id="h-graph">Knowledge graph</h2>
      <div class="block-actions">
        <button id="graph-view" class="btn btn--ghost" type="button" aria-pressed="false">List view</button>
      </div>
    </div>
    <div class="panel" id="graph"></div>
  </section>

  <section class="block" aria-labelledby="h-repos">
    <div class="block-head">
      <h2 id="h-repos">Per-repo memory</h2>
      <p class="hint">select a repository for detail</p>
    </div>
    <div id="repos"></div>
  </section>

  <section class="block" aria-labelledby="h-facts">
    <div class="block-head">
      <h2 id="h-facts">Pinned facts</h2>
      <label class="search">
        <span class="sr-only">Filter pinned facts</span>
        <input id="fact-filter" type="search" placeholder="Filter key or value…" autocomplete="off" spellcheck="false">
      </label>
    </div>
    <div id="facts"></div>
  </section>

  <section class="block" aria-labelledby="h-sessions">
    <div class="block-head">
      <h2 id="h-sessions">Recent session handoffs</h2>
    </div>
    <div id="sessions"></div>
  </section>

  <footer>AegisX-Memory · local-first memory for AI coding agents · data lives in ~/.aegisx</footer>
</main>
<div id="tip" class="tip" role="tooltip" hidden></div>
<script src="/app.js" defer></script>
</body>
</html>`;

const APP_CSS = `/* AegisX-Memory dashboard — semantic tokens, then components. No CDN, no imports. */
*, *::before, *::after { box-sizing: border-box; }
:root {
  color-scheme: light;
  --bg: #f4f5f8;
  --mesh-a: rgba(99, 102, 241, .10);
  --mesh-b: rgba(13, 148, 136, .08);
  --surface: #ffffff;
  --surface-2: #f7f8fb;
  --surface-hover: #eff1f7;
  --fg: #111726;
  --fg-muted: #5b6478;
  --fg-faint: #78829a;
  --border: #e4e7f0;
  --border-strong: #cfd5e3;
  --accent: #4f46e5;
  --accent-soft: #ecebfe;
  --accent-fg: #ffffff;
  --ok: #0d8f5a;
  --ok-soft: #e4f6ee;
  --warn: #9a5b06;
  --warn-soft: #fdf2e0;
  --info: #4338ca;
  --info-soft: #e9e8fd;
  --radius-sm: 8px;
  --radius: 12px;
  --radius-lg: 16px;
  --shadow-sm: 0 1px 2px rgba(17, 23, 38, .06);
  --shadow: 0 12px 32px -20px rgba(17, 23, 38, .45);
  --ring: 0 0 0 3px rgba(79, 70, 229, .35);
  --dur: 180ms;
  --ease: cubic-bezier(.2, .8, .2, 1);
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #090d15;
  --mesh-a: rgba(129, 140, 248, .16);
  --mesh-b: rgba(45, 212, 191, .10);
  --surface: #121826;
  --surface-2: #0e1421;
  --surface-hover: #1a2233;
  --fg: #e8edf7;
  --fg-muted: #a3aec4;
  --fg-faint: #8590a6;
  --border: #222b3d;
  --border-strong: #35415c;
  --accent: #8f8ff7;
  --accent-soft: #1d2040;
  --accent-fg: #090d15;
  --ok: #34d399;
  --ok-soft: #0b2a20;
  --warn: #fbbf24;
  --warn-soft: #2c2007;
  --info: #a5b4fc;
  --info-soft: #1c2244;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, .5);
  --shadow: 0 20px 44px -26px rgba(0, 0, 0, .85);
  --ring: 0 0 0 3px rgba(143, 143, 247, .4);
}
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 0 20px 72px;
  min-height: 100vh;
  color: var(--fg);
  background: var(--bg);
  background-image:
    radial-gradient(58% 42% at 10% -6%, var(--mesh-a), transparent 62%),
    radial-gradient(48% 38% at 100% 0%, var(--mesh-b), transparent 58%);
  background-attachment: fixed;
  font: 15px/1.55 var(--font);
}
h1, h2, h3, p { margin: 0; }
:focus-visible { outline: none; box-shadow: var(--ring); border-radius: var(--radius-sm); }
main, .topbar, footer { max-width: 1080px; margin: 0 auto; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.skip {
  position: absolute; left: 12px; top: -40px; z-index: 50;
  padding: 8px 12px; border-radius: var(--radius-sm);
  background: var(--surface); color: var(--fg); border: 1px solid var(--border-strong);
  text-decoration: none; font-size: 13px;
}
.skip:focus { top: 12px; }

/* ---------------------------------------------------------------- topbar */
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 26px 0 18px; }
.brand { display: flex; align-items: center; gap: 10px; }
.brand-dot {
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--ok); box-shadow: 0 0 0 4px var(--ok-soft);
}
h1 { font-size: clamp(17px, 1.5vw + 13px, 21px); font-weight: 650; letter-spacing: .2px; }
.muted { color: var(--fg-muted); font-weight: 400; }
.topbar-actions { display: flex; align-items: center; gap: 10px; }
.status {
  font-size: 12px; padding: 4px 10px; border-radius: 999px;
  border: 1px solid var(--border); color: var(--fg-muted); background: var(--surface);
  font-variant-numeric: tabular-nums;
}
.status[data-state="live"] { color: var(--ok); background: var(--ok-soft); border-color: transparent; }
.status[data-state="stale"] { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
.status[data-state="offline"] { color: var(--warn); background: var(--warn-soft); border-color: transparent; }

/* ------------------------------------------------------------- controls */
.btn {
  font: inherit; font-size: 13px; color: var(--fg); cursor: pointer;
  padding: 6px 12px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface);
  transition: background-color var(--dur) var(--ease), border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.btn:hover { background: var(--surface-hover); border-color: var(--border-strong); transform: translateY(-1px); }
.btn:active { transform: scale(.98); }
.btn[aria-pressed="true"] { background: var(--accent-soft); border-color: transparent; color: var(--info); }
.link {
  font: inherit; font-size: 13px; font-family: var(--mono);
  color: var(--info); background: none; border: 0; padding: 2px 0; cursor: pointer;
  text-align: left; border-radius: 4px;
}
.link:hover { text-decoration: underline; }
.search input {
  font: inherit; font-size: 13px; color: var(--fg);
  padding: 6px 12px; min-width: 220px;
  border-radius: 999px; border: 1px solid var(--border); background: var(--surface);
}
.search input::placeholder { color: var(--fg-faint); }
.lede { color: var(--fg-muted); font-size: 13.5px; margin-bottom: 22px; }

/* ----------------------------------------------------------------- bento */
main > * { animation: rise 280ms var(--ease) both; }
@keyframes rise { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
.bento { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
.card {
  position: relative; overflow: hidden;
  padding: 16px 18px; border-radius: var(--radius-lg);
  background: var(--surface); border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur) var(--ease), border-color var(--dur) var(--ease), background-color var(--dur) var(--ease);
}
.card::before {
  content: ""; position: absolute; inset: 0 0 auto 0; height: 1px;
  background: linear-gradient(90deg, transparent, var(--mesh-a), transparent);
}
.card:hover { transform: translateY(-2px); border-color: var(--border-strong); }
.card--hero { grid-column: span 2; }
.card__k { font-size: 11.5px; letter-spacing: .9px; text-transform: uppercase; color: var(--fg-muted); }
.card__v {
  font-size: clamp(24px, 3.4vw + 12px, 34px); font-weight: 680; line-height: 1.15;
  margin-top: 6px; font-variant-numeric: tabular-nums;
}
.card__s { font-size: 12px; color: var(--fg-faint); margin-top: 4px; }
.card__spark { margin-top: 10px; }
.card__spark svg { display: block; width: 100%; height: 34px; }
.donut { display: flex; align-items: center; gap: 12px; margin-top: 6px; }
.donut svg { flex: none; }
.donut__v { font-size: 22px; font-weight: 680; font-variant-numeric: tabular-nums; }

/* ---------------------------------------------------------------- blocks */
.block { margin-top: 30px; }
.block-head { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; margin-bottom: 12px; flex-wrap: wrap; }
h2 { font-size: 12px; letter-spacing: 1.3px; text-transform: uppercase; color: var(--fg-muted); }
.hint { font-size: 12px; color: var(--fg-faint); }
.panel { padding: 14px 16px; border-radius: var(--radius-lg); background: var(--surface); border: 1px solid var(--border); }

/* ------------------------------------------------------------- charts */
.chart svg { display: block; }
.chart .bar { transition: opacity var(--dur) var(--ease); }
.chart .bar:hover, .chart .bar:focus-visible { opacity: .78; }
.chart__axis { display: flex; justify-content: space-between; font-size: 11px; color: var(--fg-faint); margin-top: 2px; }
.tip {
  position: fixed; z-index: 40; max-width: 300px; padding: 8px 10px;
  font-size: 12px; color: var(--fg); background: var(--surface);
  border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
  box-shadow: var(--shadow); pointer-events: none;
}
.tip[hidden] { display: none; }

/* ---------------------------------------------------------------- graph */
.graph svg { display: block; touch-action: none; }
.graph .node { cursor: grab; }
.graph .legend { font-size: 12px; color: var(--fg-muted); margin-top: 6px; }
.graph .legend b { font-weight: 600; margin-right: 10px; }

/* ---------------------------------------------------------------- table */
.table { width: 100%; border-collapse: separate; border-spacing: 0; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; }
.table th {
  text-align: left; font-size: 11px; letter-spacing: .8px; text-transform: uppercase;
  color: var(--fg-muted); background: var(--surface-2);
  padding: 10px 14px; border-bottom: 1px solid var(--border);
}
.table td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.table tbody tr:last-child td { border-bottom: 0; }
.table tbody tr { transition: background-color var(--dur) var(--ease); }
.table tbody tr:hover { background: var(--surface-hover); }
.num { font-variant-numeric: tabular-nums; }
.mono { font-family: var(--mono); font-size: 12.5px; }
.bar { display: block; height: 6px; margin-top: 6px; border-radius: 999px; background: var(--surface-hover); overflow: hidden; }
.bar > .fill { display: block; height: 100%; width: var(--pct, 0%); background: linear-gradient(90deg, var(--ok), var(--info)); }

/* ----------------------------------------------------------------- list */
.list { list-style: none; margin: 0; padding: 0; }
.list li {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px;
  padding: 9px 0; border-bottom: 1px solid var(--border);
}
.list li:last-child { border-bottom: 0; }
.key { font-family: var(--mono); font-size: 12.5px; color: var(--info); }
.val { color: var(--fg); }
.was { color: var(--fg-faint); font-size: 12.5px; }
.repo { font-family: var(--mono); font-size: 12px; color: var(--accent); }
.pill { font-size: 11px; padding: 1px 9px; border-radius: 999px; }
.pill--ok { background: var(--ok-soft); color: var(--ok); }
.pill--warn { background: var(--warn-soft); color: var(--warn); }
.pill--info { background: var(--info-soft); color: var(--info); }
.copy { font-size: 11px; padding: 2px 8px; margin-left: auto; }
.empty, .skeleton {
  padding: 18px 16px; border-radius: var(--radius-lg);
  background: var(--surface); border: 1px dashed var(--border-strong);
  color: var(--fg-muted); font-size: 13px;
}
.skeleton { border-style: solid; }
.detail { margin-top: 14px; padding: 16px; border-radius: var(--radius-lg); background: var(--surface); border: 1px solid var(--border-strong); }
.detail h3 { font-size: 13px; font-family: var(--mono); color: var(--accent); margin-bottom: 10px; }
.detail__grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); margin-bottom: 14px; }
.detail__stat { background: var(--surface-2); border-radius: var(--radius); padding: 10px 12px; }
.detail__k { font-size: 11px; text-transform: uppercase; letter-spacing: .7px; color: var(--fg-muted); }
.detail__v { font-size: 18px; font-weight: 650; font-variant-numeric: tabular-nums; }
footer { margin-top: 40px; color: var(--fg-faint); font-size: 12px; }

@media (max-width: 720px) {
  .card--hero { grid-column: span 1; }
  .search input { min-width: 0; width: 100%; }
  .block-head { align-items: flex-start; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .001ms !important;
  }
}`;

const APP_JS = `'use strict';
/* AegisX-Memory dashboard client: no framework, no external requests. */
(function () {
  var NS = 'http://www.w3.org/2000/svg';
  var REFRESH_MS = 10000;

  // ------------------------------------------------------------- helpers
  function byId(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function svg(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    if (attrs) { for (var k in attrs) { n.setAttribute(k, attrs[k]); } }
    return n;
  }
  function clear(node) { while (node && node.firstChild) { node.removeChild(node.firstChild); } }
  function panel(children) {
    var p = el('div', 'panel');
    for (var i = 0; i < children.length; i++) { p.appendChild(children[i]); }
    return p;
  }
  function reducedMotion() {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function clock(ts) { var d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 3) { return 'just now'; }
    if (s < 60) { return s + 's ago'; }
    return Math.round(s / 60) + 'm ago';
  }
  /* Rebuild a section only when its data actually changed — this is what keeps
     the page from flickering (and from stealing focus) on every poll. */
  function section(node, key, build) {
    if (!node || node.__sig === key) { return; }
    node.__sig = key;
    clear(node);
    build(node);
  }

  // --------------------------------------------------------------- theme
  var THEME_KEY = 'aegisx-theme';
  var MODES = ['auto', 'light', 'dark'];
  function storedMode() {
    try { var v = localStorage.getItem(THEME_KEY); return MODES.indexOf(v) >= 0 ? v : 'auto'; }
    catch (e) { return 'auto'; }
  }
  function systemDark() {
    try { return matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
  }
  function applyTheme() {
    var mode = storedMode();
    var resolved = mode === 'auto' ? (systemDark() ? 'dark' : 'light') : mode;
    document.documentElement.setAttribute('data-theme', resolved);
    var btn = byId('theme');
    if (btn) {
      var label = mode === 'auto' ? 'Auto' : (mode === 'light' ? 'Light' : 'Dark');
      if (btn.__label !== label) { btn.__label = label; btn.textContent = label; }
      btn.setAttribute('aria-label', 'Theme: ' + label + '. Activate to switch.');
    }
  }
  function cycleTheme() {
    var next = MODES[(MODES.indexOf(storedMode()) + 1) % MODES.length];
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* private mode */ }
    applyTheme();
  }

  // -------------------------------------------------------------- status
  var net = { live: false, lastGood: 0, attempted: false };
  function updateStatus() {
    var node = byId('status');
    if (!node) { return; }
    var state, text;
    if (!net.attempted) { state = 'stale'; text = 'connecting…'; }
    else if (net.live) { state = 'live'; text = 'live · updated ' + ago(net.lastGood); }
    else if (net.lastGood) { state = 'offline'; text = 'offline · last data ' + clock(net.lastGood); }
    else { state = 'offline'; text = 'offline — cannot reach the server'; }
    if (node.__text !== text) { node.__text = text; node.textContent = text; }
    if (node.getAttribute('data-state') !== state) { node.setAttribute('data-state', state); }
  }

  // ---------------------------------------------------------------- tip
  function showTip(x, y, text) {
    var tip = byId('tip');
    if (!tip) { return; }
    tip.textContent = text;
    tip.hidden = false;
    var w = tip.offsetWidth || 200;
    var left = Math.min(Math.max(8, x + 12), window.innerWidth - w - 8);
    tip.style.left = left + 'px';
    tip.style.top = Math.max(8, y - 12) + 'px';
  }
  function hideTip() { var tip = byId('tip'); if (tip) { tip.hidden = true; } }

  // --------------------------------------------------------------- state
  var STATE = { facts: [], sessions: [], repos: [], recalls: [], filter: '' };

  // ---------------------------------------------------------------- cards
  function statCard(label, value, sub) {
    var c = el('article', 'card');
    c.appendChild(el('p', 'card__k', label));
    c.appendChild(el('p', 'card__v', value));
    if (sub) { c.appendChild(el('p', 'card__s', sub)); }
    return c;
  }
  function sparkline(values, label) {
    if (!values.length) { return null; }
    var W = 260, H = 34, max = Math.max.apply(null, values.concat([1]));
    var node = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': label });
    var step = values.length > 1 ? W / (values.length - 1) : 0;
    var d = '';
    for (var i = 0; i < values.length; i++) {
      var x = i * step;
      var y = H - 3 - (values[i] / max) * (H - 8);
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    }
    node.appendChild(svg('path', { d: d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    var wrap = el('div', 'card__spark');
    wrap.appendChild(node);
    return wrap;
  }
  function heroCard(saved, recalls) {
    var c = el('article', 'card card--hero');
    c.appendChild(el('p', 'card__k', 'Tokens saved (est.)'));
    c.appendChild(el('p', 'card__v', saved.toLocaleString()));
    c.appendChild(el('p', 'card__s', 'vs full re-reads'));
    var spark = sparkline(recalls.map(function (r) { return r.tokenEstimate || 0; }).slice(-40), 'Tokens returned by the last recalls');
    if (spark) { c.appendChild(spark); }
    return c;
  }
  function rateCard(rate, hits, total) {
    var c = el('article', 'card');
    c.appendChild(el('p', 'card__k', 'Recall hit rate'));
    var row = el('div', 'donut');
    var R = 22, C = 2 * Math.PI * R, pct = rate === null ? 0 : rate;
    var ring = svg('svg', { width: '56', height: '56', viewBox: '0 0 56 56', role: 'img', 'aria-label': rate === null ? 'No recalls yet' : 'Hit rate ' + rate + ' percent' });
    ring.appendChild(svg('circle', { cx: '28', cy: '28', r: R, fill: 'none', stroke: 'var(--surface-hover)', 'stroke-width': '6' }));
    ring.appendChild(svg('circle', {
      cx: '28', cy: '28', r: R, fill: 'none', stroke: 'var(--ok)', 'stroke-width': '6',
      'stroke-linecap': 'round', 'stroke-dasharray': (C * pct / 100).toFixed(1) + ' ' + C.toFixed(1),
      transform: 'rotate(-90 28 28)'
    }));
    row.appendChild(ring);
    row.appendChild(el('span', 'donut__v', rate === null ? '—' : rate + '%'));
    c.appendChild(row);
    c.appendChild(el('p', 'card__s', total ? hits + ' hits of ' + total + ' recalls' : 'no recalls recorded yet'));
    return c;
  }
  function renderCards(d) {
    var saved = (d.repos || []).reduce(function (a, r) { return a + (r.tokensSavedEstimate || 0); }, 0);
    var changed = (d.facts || []).filter(function (f) { return f.previousValue !== undefined; }).length;
    var recalls = d.recalls || [];
    var hits = recalls.filter(function (r) { return r.hit; }).length;
    var rate = recalls.length ? Math.round((hits / recalls.length) * 100) : null;
    var key = [d.totals.facts, d.totals.knowledge, d.totals.sessions, changed, saved, (d.repos || []).length, rate, recalls.length, hits].join('|');
    section(byId('cards'), key, function (host) {
      host.appendChild(heroCard(saved, recalls));
      host.appendChild(statCard('Repos', (d.repos || []).length, 'with memory or telemetry'));
      host.appendChild(statCard('Facts', d.totals.facts, changed ? changed + ' of ' + d.totals.facts + ' changed since first pinned' : 'pinned stable facts'));
      host.appendChild(statCard('Knowledge', d.totals.knowledge, 'decisions · gotchas · conventions'));
      host.appendChild(statCard('Sessions', d.totals.sessions, 'handoffs stored'));
      host.appendChild(rateCard(rate, hits, recalls.length));
    });
  }

  // ---------------------------------------------------------------- chart
  function renderChart(recalls) {
    var host = byId('chart');
    host.classList.add('chart');
    var key = recalls.map(function (r) { return (r.createdAt || '') + (r.hit ? '1' : '0') + (r.tokenEstimate || 0); }).join(',');
    section(host, key, function (host) {
      if (!recalls.length) {
        host.appendChild(el('p', 'empty', 'No recalls yet — ask your agent to recall the project memory.'));
        return;
      }
      var hits = recalls.filter(function (r) { return r.hit; }).length;
      var W = 960, H = 130, n = recalls.length, max = Math.max.apply(null, recalls.map(function (r) { return r.tokenEstimate || 0; }).concat([1]));
      var node = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, role: 'group',
        'aria-label': 'Recall history: ' + n + ' recalls, ' + hits + ' hits, ' + (n - hits) + ' misses'
      });
      var bw = Math.max(3, Math.floor(W / n) - 3);
      for (var i = 0; i < n; i++) {
        var r = recalls[i];
        var tokens = r.tokenEstimate || 0;
        var h = 16 + (tokens / max) * (H - 34);
        var rect = svg('rect', {
          x: (6 + (i * (W - 12)) / n).toFixed(1), y: (H - h - 6).toFixed(1),
          width: bw, height: h.toFixed(1), rx: '3',
          fill: r.hit ? 'var(--ok)' : 'var(--warn)',
          class: 'bar', tabindex: '0', role: 'img'
        });
        var label = (r.repo || 'unknown repo') + ' · ' + (r.hit ? 'hit' : 'miss') + ' · ~' + tokens + ' tokens' + (r.query ? ' · ' + r.query : '') + ' · ' + clock(Date.parse(r.createdAt || Date.now()));
        rect.setAttribute('aria-label', label);
        rect._t = label;
        node.appendChild(rect);
        rect.addEventListener('pointerenter', function (ev) { showTip(ev.clientX, ev.clientY, ev.target._t); });
        rect.addEventListener('pointermove', function (ev) { showTip(ev.clientX, ev.clientY, ev.target._t); });
        rect.addEventListener('pointerleave', hideTip);
        rect.addEventListener('focus', function (ev) {
          var b = ev.target.getBoundingClientRect();
          showTip(b.left + b.width / 2, b.top, ev.target._t);
        });
        rect.addEventListener('blur', hideTip);
      }
      host.appendChild(node);
      var axis = el('div', 'chart__axis');
      axis.appendChild(el('span', null, 'oldest'));
      axis.appendChild(el('span', null, 'height = tokens returned · teal = hit · amber = cold miss · ~' + max + ' peak'));
      axis.appendChild(el('span', null, 'newest'));
      host.appendChild(axis);
    });
  }

  // ---------------------------------------------------------------- graph
  var G = {
    data: { nodes: [], edges: [] }, svg: null, layer: null,
    items: {}, lines: [], pos: {}, raf: 0, drag: null, list: false, settled: false
  };
  var COLORS = { repo: 'var(--accent)', fact: 'var(--ok)', knowledge: 'var(--warn)', session: 'var(--info)' };
  var VIEW_W = 960, VIEW_H = 520;

  function hash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return h >>> 0;
  }
  function radiusOf(kind) { return kind === 'repo' ? 14 : (kind === 'session' ? 7 : 9); }
  function seed(id, kind) {
    var h = hash(id);
    var a = (h % 3600) / 3600 * 2 * Math.PI;
    var r = kind === 'repo' ? 40 : 90 + (h % 120);
    return { x: VIEW_W / 2 + Math.cos(a) * r * 1.3, y: VIEW_H / 2 + Math.sin(a) * r, vx: 0, vy: 0, fixed: false };
  }
  function shortLabel(s) { return s.length > 26 ? s.slice(0, 25) + '…' : s; }

  function mountGraph() {
    var host = byId('graph');
    if (!host || G.svg) { return; }
    clear(host); // drop the loading placeholder before the canvas takes over
    host.classList.add('graph');
    var node = svg('svg', { viewBox: '0 0 ' + VIEW_W + ' ' + VIEW_H, width: '100%', height: VIEW_H, role: 'group', 'aria-label': 'Memory graph: repositories with their facts, knowledge and handoffs' });
    G.layer = node;
    G.svg = node;
    host.appendChild(node);
    var legend = el('p', 'legend', '');
    legend.appendChild(el('b', null, '● repo'));
    legend.appendChild(el('b', null, '● fact'));
    legend.appendChild(el('b', null, '● knowledge'));
    legend.appendChild(el('b', null, '● session'));
    legend.appendChild(el('span', 'hint', 'drag nodes to untangle · use List view for the same data as a table'));
    host.appendChild(legend);

    node.addEventListener('pointerdown', function (ev) {
      var id = ev.target && ev.target.__id;
      if (!id || !G.pos[id]) { return; }
      var box = node.getBoundingClientRect();
      var scale = VIEW_W / box.width;
      G.drag = { id: id, sx: ev.clientX, sy: ev.clientY, ox: G.pos[id].x, oy: G.pos[id].y, scale: scale };
      G.pos[id].fixed = true;
      if (node.setPointerCapture) { try { node.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } }
    });
    node.addEventListener('pointermove', function (ev) {
      if (!G.drag) { return; }
      var p = G.pos[G.drag.id];
      if (!p) { return; }
      p.x = Math.max(24, Math.min(VIEW_W - 24, G.drag.ox + (ev.clientX - G.drag.sx) * G.drag.scale));
      p.y = Math.max(20, Math.min(VIEW_H - 20, G.drag.oy + (ev.clientY - G.drag.sy) * G.drag.scale));
      draw();
    });
    function endDrag(ev) {
      if (G.drag && G.pos[G.drag.id]) { G.pos[G.drag.id].fixed = false; }
      G.drag = null;
      if (node.releasePointerCapture) { try { node.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ } }
    }
    node.addEventListener('pointerup', endDrag);
    node.addEventListener('pointercancel', endDrag);
  }

  function updateGraph(data) {
    G.data = data;
    if (G.list) { renderGraphList(data); return; }
    mountGraph();
    if (!G.svg) { return; }
    var seen = {};
    var i, j;
    for (i = 0; i < data.nodes.length; i++) {
      var n = data.nodes[i];
      seen[n.id] = true;
      var title = n.sub ? n.label + ' — ' + n.sub : n.label;
      if (!G.items[n.id]) {
        G.pos[n.id] = seed(n.id, n.kind);
        var circle = svg('circle', { r: radiusOf(n.kind), fill: COLORS[n.kind] || 'var(--fg-muted)', stroke: 'var(--surface)', 'stroke-width': '2', class: 'node' });
        circle.__id = n.id;
        var t = svg('title');
        t.textContent = title.slice(0, 300);
        circle.appendChild(t);
        var label = svg('text', { 'font-size': '10', fill: 'var(--fg-muted)', 'text-anchor': 'middle' });
        label.textContent = shortLabel(n.label);
        label.style.pointerEvents = 'none';
        G.svg.appendChild(circle);
        G.svg.appendChild(label);
        G.items[n.id] = { circle: circle, label: label };
      } else {
        var existing = G.items[n.id].circle.firstChild;
        if (existing) { existing.textContent = title.slice(0, 300); }
        G.items[n.id].label.textContent = shortLabel(n.label);
      }
    }
    for (var id in G.items) {
      if (!seen[id]) {
        if (G.items[id].circle.parentNode) { G.items[id].circle.parentNode.removeChild(G.items[id].circle); }
        if (G.items[id].label.parentNode) { G.items[id].label.parentNode.removeChild(G.items[id].label); }
        delete G.items[id];
        delete G.pos[id];
      }
    }
    for (j = 0; j < G.lines.length; j++) {
      if (G.lines[j].parentNode) { G.lines[j].parentNode.removeChild(G.lines[j]); }
    }
    G.lines = [];
    for (i = 0; i < data.edges.length; i++) {
      var line = svg('line', { stroke: 'var(--border-strong)', 'stroke-width': '1' });
      G.svg.insertBefore(line, G.svg.firstChild);
      G.lines.push(line);
    }
    G.settled = false;
    if (reducedMotion()) { settle(160); draw(); } else { startLoop(); }
  }

  function simulate() {
    var nodes = G.data.nodes, P = G.pos, i, j;
    for (i = 0; i < nodes.length; i++) {
      for (j = i + 1; j < nodes.length; j++) {
        var a = P[nodes[i].id], b = P[nodes[j].id];
        if (!a || !b) { continue; }
        var dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = .5; dy = .5; d2 = .5; }
        if (d2 < 16000) {
          var f = 900 / d2, dl = Math.sqrt(d2);
          a.vx += dx / dl * f; a.vy += dy / dl * f;
          b.vx -= dx / dl * f; b.vy -= dy / dl * f;
        }
      }
    }
    for (i = 0; i < G.data.edges.length; i++) {
      var a2 = P[G.data.edges[i].source], b2 = P[G.data.edges[i].target];
      if (!a2 || !b2) { continue; }
      var dx2 = b2.x - a2.x, dy2 = b2.y - a2.y, d = Math.max(1, Math.sqrt(dx2 * dx2 + dy2 * dy2));
      var f2 = (d - 120) * .00004;
      a2.vx += dx2 / d * f2 * d; a2.vy += dy2 / d * f2 * d;
      b2.vx -= dx2 / d * f2 * d; b2.vy -= dy2 / d * f2 * d;
    }
    for (i = 0; i < nodes.length; i++) {
      var p = P[nodes[i].id];
      if (!p) { continue; }
      if (p.fixed) { p.vx = 0; p.vy = 0; continue; }
      p.vx += (VIEW_W / 2 - p.x) * .002; p.vy += (VIEW_H / 2 - p.y) * .002;
      p.vx *= .85; p.vy *= .85;
      p.x = Math.max(26, Math.min(VIEW_W - 26, p.x + p.vx));
      p.y = Math.max(20, Math.min(VIEW_H - 20, p.y + p.vy));
    }
  }
  function draw() {
    var i;
    for (i = 0; i < G.lines.length; i++) {
      var e = G.data.edges[i];
      if (!e) { continue; }
      var a = G.pos[e.source], b = G.pos[e.target];
      if (!a || !b) { continue; }
      G.lines[i].setAttribute('x1', a.x); G.lines[i].setAttribute('y1', a.y);
      G.lines[i].setAttribute('x2', b.x); G.lines[i].setAttribute('y2', b.y);
    }
    for (var id in G.items) {
      var p = G.pos[id];
      if (!p) { continue; }
      G.items[id].circle.setAttribute('cx', p.x);
      G.items[id].circle.setAttribute('cy', p.y);
      G.items[id].label.setAttribute('x', p.x);
      G.items[id].label.setAttribute('y', p.y + 22);
    }
  }
  function settle(steps) {
    for (var i = 0; i < steps; i++) { simulate(); }
  }
  /* Exactly one animation loop exists. The previous implementation created a
     fresh handle inside render(), so the old loop was never cancelled. */
  function startLoop() {
    if (G.raf || reducedMotion()) { return; }
    var step = function () {
      simulate(); draw(); G.settled = true;
      G.raf = requestAnimationFrame(step);
    };
    G.raf = requestAnimationFrame(step);
  }
  function stopLoop() {
    if (G.raf) { cancelAnimationFrame(G.raf); G.raf = 0; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopLoop(); }
    else if (!G.list && G.svg) { startLoop(); }
  });

  function renderGraphList(data) {
    var host = byId('graph');
    if (!host) { return; }
    clear(host);
    var table = el('table', 'table');
    table.appendChild(el('caption', 'sr-only', 'Knowledge graph nodes'));
    var thead = el('thead'), tr = el('tr');
    var heads = ['Node', 'Kind', 'Repository'];
    for (var i = 0; i < heads.length; i++) {
      var th = el('th', null, heads[i]);
      th.setAttribute('scope', 'col');
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
    var tbody = el('tbody');
    for (i = 0; i < data.nodes.length; i++) {
      var n = data.nodes[i], row = el('tr');
      row.appendChild(el('td', null, n.label));
      row.appendChild(el('td', null, n.kind));
      row.appendChild(el('td', 'mono', n.sub || '—'));
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    host.appendChild(table);
    host.appendChild(el('p', 'hint', data.nodes.length + ' nodes · ' + data.edges.length + ' links'));
  }
  function setGraphList(on) {
    G.list = on;
    var btn = byId('graph-view');
    if (btn) { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); btn.textContent = on ? 'Graph view' : 'List view'; }
    if (on) {
      stopLoop();
      G.svg = null; G.layer = null; G.items = {}; G.lines = [];
      renderGraphList(G.data);
    } else {
      var host = byId('graph');
      clear(host);
      G.svg = null;
      updateGraph(G.data);
    }
  }

  // ---------------------------------------------------------------- repos
  function renderRepos(repos) {
    var host = byId('repos');
    section(host, JSON.stringify(repos), function (host) {
      if (!repos.length) {
        host.appendChild(el('p', 'empty', 'Nothing indexed yet — run “aegisxmemory index .” inside a project.'));
        return;
      }
      var table = el('table', 'table');
      table.appendChild(el('caption', 'sr-only', 'Memory per repository'));
      var thead = el('thead'), head = el('tr');
      var heads = ['Repository', 'Files', 'Symbols', 'Scans', 'Recalls', 'Hit rate'];
      for (var i = 0; i < heads.length; i++) {
        var th = el('th', null, heads[i]);
        th.setAttribute('scope', 'col');
        head.appendChild(th);
      }
      thead.appendChild(head);
      table.appendChild(thead);
      var tbody = el('tbody');
      repos.forEach(function (r) {
        var row = el('tr');
        var nameCell = el('td');
        var btn = el('button', 'link', r.repo);
        btn.type = 'button';
        btn.setAttribute('aria-expanded', 'false');
        btn.addEventListener('click', function () { toggleRepo(r.repo, btn); });
        nameCell.appendChild(btn);
        row.appendChild(nameCell);
        var nums = [r.files, r.symbols, r.scans, r.recalls];
        for (var j = 0; j < nums.length; j++) { row.appendChild(el('td', 'num', nums[j])); }
        var rate = el('td', 'num');
        rate.appendChild(el('span', null, r.hitRate === null ? '—' : r.hitRate + '%'));
        if (r.hitRate !== null) {
          var bar = el('span', 'bar'), fill = el('span', 'fill');
          fill.style.setProperty('--pct', (r.hitRate || 0) + '%');
          bar.appendChild(fill);
          rate.appendChild(bar);
        }
        row.appendChild(rate);
        tbody.appendChild(row);
      });
      table.appendChild(tbody);
      host.appendChild(table);
      host.appendChild(el('div', 'detail', ''));
    });
  }
  function detailStat(label, value) {
    var box = el('div', 'detail__stat');
    box.appendChild(el('p', 'detail__k', label));
    box.appendChild(el('p', 'detail__v', value));
    return box;
  }
  function toggleRepo(repo, btn) {
    var host = byId('repos');
    if (!host) { return; }
    var box = host.querySelector('.detail');
    if (!box) { return; }
    var open = btn.getAttribute('aria-expanded') === 'true';
    var expanded = host.querySelectorAll('button.link[aria-expanded="true"]');
    for (var i = 0; i < expanded.length; i++) { expanded[i].setAttribute('aria-expanded', 'false'); }
    clear(box);
    if (open) { return; }
    btn.setAttribute('aria-expanded', 'true');
    var stats = null;
    for (i = 0; i < STATE.repos.length; i++) { if (STATE.repos[i].repo === repo) { stats = STATE.repos[i]; } }
    var head = el('h3', null, repo);
    box.appendChild(head);
    if (stats) {
      var grid = el('div', 'detail__grid');
      grid.appendChild(detailStat('Files', stats.files));
      grid.appendChild(detailStat('Symbols', stats.symbols));
      grid.appendChild(detailStat('Scans', stats.scans));
      grid.appendChild(detailStat('Recalls', stats.recalls));
      grid.appendChild(detailStat('Hit rate', stats.hitRate === null ? '—' : stats.hitRate + '%'));
      box.appendChild(grid);
    }
    var facts = STATE.facts.filter(function (f) { return f.repoHint === repo; });
    box.appendChild(el('p', 'card__k', 'Pinned facts (' + facts.length + ')'));
    if (!facts.length) {
      box.appendChild(el('p', 'hint', 'No facts pinned to this repository.'));
    } else {
      box.appendChild(factList(facts));
    }
    var sessions = STATE.sessions.filter(function (s) { return s.repo === repo; });
    box.appendChild(el('p', 'card__k', 'Handoffs (' + sessions.length + ')'));
    if (!sessions.length) {
      box.appendChild(el('p', 'hint', 'No handoffs stored for this repository.'));
    } else {
      box.appendChild(sessionList(sessions));
    }
  }

  // ---------------------------------------------------------------- facts
  function copyButton(text) {
    var btn = el('button', 'btn copy', 'copy');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      function done() {
        btn.textContent = 'copied';
        setTimeout(function () { btn.textContent = 'copy'; }, 1200);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else { fallback(); }
      function fallback() {
        var area = el('textarea');
        area.value = text;
        area.setAttribute('readonly', 'readonly');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        document.body.appendChild(area);
        area.select();
        try { document.execCommand('copy'); done(); } catch (e) { btn.textContent = 'press Ctrl+C'; }
        document.body.removeChild(area);
      }
    });
    return btn;
  }
  function factList(facts) {
    var list = el('ul', 'list');
    for (var i = 0; i < facts.length; i++) {
      var f = facts[i], li = el('li');
      li.appendChild(el('span', 'key', f.key));
      li.appendChild(el('span', 'val', f.value));
      if (f.previousValue !== undefined) {
        li.appendChild(el('span', 'pill pill--info', 'changed'));
        li.appendChild(el('span', 'was', 'was: ' + f.previousValue + ' (changed ' + String(f.updatedAt || '').slice(0, 10) + ')'));
      }
      if (f.repoHint) { li.appendChild(el('span', 'repo', f.repoHint)); }
      li.appendChild(copyButton(f.key + ' ' + f.value));
      list.appendChild(li);
    }
    return list;
  }
  function renderFacts() {
    var host = byId('facts');
    var filter = STATE.filter.trim().toLowerCase();
    var rows = STATE.facts.filter(function (f) {
      if (!filter) { return true; }
      return (f.key + ' ' + f.value + ' ' + (f.repoHint || '')).toLowerCase().indexOf(filter) >= 0;
    });
    section(host, JSON.stringify(rows) + '|' + filter, function (host) {
      if (!STATE.facts.length) {
        host.appendChild(el('p', 'empty', 'No pinned facts yet — “aegisxmemory remember project.<name>.<key> <value>”.'));
        return;
      }
      if (!rows.length) {
        host.appendChild(el('p', 'empty', 'No fact matches “' + STATE.filter + '”.'));
        return;
      }
      var changed = rows.filter(function (f) { return f.previousValue !== undefined; }).length;
      var wrapper = el('div', '');
      if (changed) {
        wrapper.appendChild(el('p', 'hint', changed + ' of ' + rows.length + ' facts changed since they were first pinned — “was” shows the value the last re-pin replaced.'));
      }
      wrapper.appendChild(factList(rows));
      var p = panel([wrapper]);
      host.appendChild(p);
    });
  }

  // ------------------------------------------------------------- sessions
  function sessionList(sessions) {
    var list = el('ul', 'list');
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i], li = el('li');
      li.appendChild(el('span', 'repo', s.repo));
      li.appendChild(el('span', 'val', s.goal));
      li.appendChild(el('span', 'hint', s.facts + ' facts · ' + s.decisions + ' decisions · ' + s.gotchas + ' gotchas · ' + s.conventions + ' conventions · ' + s.nextSteps + ' next · ' + String(s.createdAt || '').slice(0, 16).replace('T', ' ')));
      list.appendChild(li);
    }
    return list;
  }
  function renderSessions(sessions) {
    section(byId('sessions'), JSON.stringify(sessions), function (host) {
      if (!sessions.length) {
        host.appendChild(el('p', 'empty', 'No handoffs yet — end agent sessions with “save the session handoff”.'));
        return;
      }
      host.appendChild(panel([sessionList(sessions)]));
    });
  }

  // --------------------------------------------------------------- render
  function render(data) {
    STATE.facts = data.facts || [];
    STATE.sessions = data.sessions || [];
    STATE.repos = data.repos || [];
    STATE.recalls = data.recalls || [];
    renderCards(data);
    renderChart(STATE.recalls);
    renderRepos(STATE.repos);
    renderFacts();
    renderSessions(STATE.sessions);
  }
  function renderSkeletons() {
    var cards = byId('cards');
    if (cards && !cards.childElementCount) {
      for (var i = 0; i < 5; i++) { cards.appendChild(el('p', 'skeleton', ' ')); }
    }
    ['chart', 'graph', 'facts', 'sessions'].forEach(function (id) {
      var node = byId(id);
      if (node && !node.childElementCount) { node.appendChild(el('p', 'skeleton', 'Loading…')); }
    });
  }

  // ---------------------------------------------------------------- poll
  function graphUnavailable() {
    if (G.svg || G.list) { return; } // never clobber something already rendered
    var host = byId('graph');
    if (host) {
      clear(host);
      host.appendChild(el('p', 'empty', 'Graph unavailable — the server did not return the graph projection.'));
    }
  }
  function loadGraph() {
    fetch('/api/graph', { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (g) {
      if (g) { updateGraph(g); } else { graphUnavailable(); }
    }).catch(graphUnavailable);
  }
  function tick() {
    net.attempted = true;
    fetch('/api/data', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) { throw new Error('HTTP ' + r.status); }
      return r.json();
    }).then(function (data) {
      net.live = true;
      net.lastGood = Date.now();
      render(data);
      loadGraph();
    }).catch(function () {
      net.live = false;
    }).then(updateStatus);
  }

  // ----------------------------------------------------------------- init
  function init() {
    applyTheme();
    var themeBtn = byId('theme');
    if (themeBtn) { themeBtn.addEventListener('click', cycleTheme); }
    try {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
        if (storedMode() === 'auto') { applyTheme(); }
      });
    } catch (e) { /* older engines: theme still applies on next load */ }

    var filter = byId('fact-filter');
    if (filter) {
      filter.addEventListener('input', function () { STATE.filter = filter.value; renderFacts(); });
    }
    var graphBtn = byId('graph-view');
    if (graphBtn) { graphBtn.addEventListener('click', function () { setGraphList(!G.list); }); }

    renderSkeletons();
    updateStatus();
    tick();
    setInterval(tick, REFRESH_MS);
    setInterval(updateStatus, 1000);
  }
  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
  else { init(); }
})();`;

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
      // A fresh nonce per response. The only inline script is the pre-paint theme
      // bootstrap, and `script-src` admits /app.js by origin — nothing else can
      // execute, including anything smuggled into a stored fact value.
      const nonce = crypto.randomBytes(16).toString('base64');
      const headers: Record<string, string> = {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': [
          "default-src 'none'",
          `script-src 'self' 'nonce-${nonce}'`,
          "style-src 'self'",
          "img-src 'self' data:",
          "connect-src 'self'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join('; '),
      };
      // Same-origin assets only: the dashboard never reaches out to a CDN, so it
      // keeps working with no network at all.
      const assets: Record<string, { body: string; type: string }> = {
        '/app.css': { body: APP_CSS, type: 'text/css; charset=utf-8' },
        '/app.js': { body: APP_JS, type: 'text/javascript; charset=utf-8' },
      };
      const asset = assets[url];
      if (asset !== undefined) {
        res.writeHead(200, { ...headers, 'content-type': asset.type });
        res.end(asset.body);
        return;
      }
      if (url === '/' || url.startsWith('/index')) {
        res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGE_HTML.replace('__NONCE__', nonce));
        return;
      }
      if (url === '/api/data') {
        res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(engine.dashboardData()));
        return;
      }
      if (url === '/api/graph') {
        res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(engine.graphData()));
        return;
      }
      res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' });
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
