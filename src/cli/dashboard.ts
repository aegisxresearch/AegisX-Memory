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
 *
 * The knowledge graph is layered on top of the token layer: repositories sit on
 * a ring, their dependents fan outward, and a bounded relaxation settles the
 * result — deterministic, and seeded only for nodes that do not have a position
 * yet, so the 10 s refresh never reshuffles what the user is looking at.
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
      <h2 id="h-recall">Recall history <span class="count" id="recall-count"></span></h2>
      <div class="block-actions">
        <label class="chart-cap" for="chart-cap">Show
          <select id="chart-cap">
            <option value="10">10</option>
            <option value="30" selected>30</option>
            <option value="50">50</option>
            <option value="0">All</option>
          </select>
        </label>
        <p class="hint">hit vs miss</p>
        <button id="chart-zoom" class="btn btn--ghost" type="button" aria-pressed="false">Zoom</button>
      </div>
    </div>
    <div class="panel" id="chart" role="group" aria-label="Recall history chart"></div>
    <div class="chart__readout-row">
      <p class="chart__readout" id="chart-readout" aria-live="polite"></p>
      <button id="chart-copy" class="btn copy" type="button" disabled>copy</button>
    </div>
  </section>

  <section class="block" aria-labelledby="h-graph">
    <div class="block-head">
      <h2 id="h-graph">Knowledge graph <span class="count" id="graph-count"></span></h2>
      <div class="block-actions">
        <div class="seg" id="graph-kinds" role="group" aria-label="Filter the graph by node kind"></div>
        <div class="seg" role="group" aria-label="Zoom">
          <button id="graph-out" class="btn btn--icon" type="button" aria-label="Zoom out">&#8722;</button>
          <button id="graph-fit" class="btn btn--icon" type="button" aria-label="Fit the graph to the view">&#8596;</button>
          <button id="graph-in" class="btn btn--icon" type="button" aria-label="Zoom in">+</button>
        </div>
        <button id="graph-view" class="btn btn--ghost" type="button" aria-pressed="false">List view</button>
      </div>
    </div>
    <div class="panel panel--graph" id="graph" role="group" tabindex="0" aria-label="Knowledge graph. Use arrow keys to move between nodes, Enter for detail, plus and minus to zoom."></div>
    <div class="detail" id="graph-detail" hidden></div>
    <p class="hint graph-hint">Drag a node to place it · drag the background to pan · scroll or +/− to zoom · click a node for its detail · List view is the same data as a table.</p>
    <p class="sr-only" id="graph-live" aria-live="polite"></p>
  </section>

  <section class="block" aria-labelledby="h-repos">
    <div class="block-head">
      <h2 id="h-repos">Per-repo memory <span class="count" id="repos-count"></span></h2>
      <p class="hint">select a repository for detail</p>
    </div>
    <div id="repos"></div>
  </section>

  <section class="block" aria-labelledby="h-facts">
    <div class="block-head">
      <h2 id="h-facts">Pinned facts <span class="count" id="facts-count"></span></h2>
      <label class="search">
        <span class="sr-only">Filter pinned facts</span>
        <input id="fact-filter" type="search" placeholder="Filter key or value…" autocomplete="off" spellcheck="false">
      </label>
    </div>
    <div id="facts"></div>
  </section>

  <section class="block" aria-labelledby="h-sessions">
    <div class="block-head">
      <h2 id="h-sessions">Recent session handoffs <span class="count" id="sessions-count"></span></h2>
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
  /* ---- surfaces ---- */
  --bg: #f2f4f9;
  --surface: #ffffff;
  --surface-2: #f7f8fc;
  --surface-3: #eef1f7;
  --surface-hover: #eaeef7;
  --glass: rgba(255, 255, 255, .74);
  --hairline: rgba(15, 21, 35, .08);
  --mesh-a: rgba(99, 102, 241, .16);
  --mesh-b: rgba(13, 148, 136, .12);
  /* ---- ink ---- */
  --fg: #0f1523;
  --fg-muted: #59627a;
  --fg-faint: #7d8699;
  --border: #e2e6f0;
  --border-strong: #cbd2e2;
  /* ---- brand + semantics ---- */
  --accent: #4f46e5;
  --accent-2: #0d9488;
  --accent-soft: #ecebfe;
  --accent-fg: #ffffff;
  --ok: #0d8f5a;
  --ok-soft: #e0f5eb;
  --warn: #97610b;
  --warn-soft: #fdf1dd;
  --info: #4338ca;
  --info-soft: #e9e8fd;
  /* ---- graph kinds ---- */
  --kind-repo: #4f46e5;
  --kind-fact: #0d9488;
  --kind-knowledge: #d97706;
  --kind-session: #0284c7;
  /* ---- shape ---- */
  --radius-sm: 9px;
  --radius: 13px;
  --radius-lg: 18px;
  --radius-xl: 24px;
  --shadow-sm: 0 1px 2px rgba(15, 21, 35, .05), 0 1px 3px rgba(15, 21, 35, .05);
  --shadow: 0 18px 40px -26px rgba(15, 21, 35, .4);
  --shadow-lg: 0 34px 64px -32px rgba(15, 21, 35, .45);
  --ring: 0 0 0 3px rgba(79, 70, 229, .34);
  --grad: linear-gradient(120deg, var(--accent), var(--accent-2));
  /* ---- motion: 3 curves, 4 durations, nothing freestyled ---- */
  --dur-1: 110ms;
  --dur-2: 180ms;
  --dur-3: 280ms;
  --dur-4: 460ms;
  --ease-out: cubic-bezier(.16, 1, .3, 1);
  --ease-in: cubic-bezier(.7, 0, .84, 0);
  --ease-in-out: cubic-bezier(.65, 0, .35, 1);
  --dur: var(--dur-2);
  --ease: var(--ease-out);
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #080b12;
  --surface: #101725;
  --surface-2: #0c1220;
  --surface-3: #161e30;
  --surface-hover: #1a2334;
  --glass: rgba(12, 18, 32, .72);
  --hairline: rgba(255, 255, 255, .07);
  --mesh-a: rgba(129, 140, 248, .18);
  --mesh-b: rgba(45, 212, 191, .12);
  --fg: #e9eef9;
  --fg-muted: #a6b1c7;
  --fg-faint: #8892a7;
  --border: #202a3d;
  --border-strong: #33405b;
  --accent: #9a9cfa;
  --accent-2: #4fd1c5;
  --accent-soft: #1d2040;
  --accent-fg: #080b12;
  --ok: #34d399;
  --ok-soft: #0b2a20;
  --warn: #fbbf24;
  --warn-soft: #2c2007;
  --info: #a5b4fc;
  --info-soft: #1c2244;
  --kind-repo: #a5b4fc;
  --kind-fact: #5eead4;
  --kind-knowledge: #fcd34d;
  --kind-session: #7dd3fc;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, .55);
  --shadow: 0 22px 48px -28px rgba(0, 0, 0, .9);
  --shadow-lg: 0 38px 72px -34px rgba(0, 0, 0, .95);
  --ring: 0 0 0 3px rgba(154, 156, 250, .42);
}
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body {
  margin: 0;
  padding: 0 20px 72px;
  min-height: 100vh;
  color: var(--fg);
  background: var(--bg);
  background-image:
    radial-gradient(58% 42% at 8% -8%, var(--mesh-a), transparent 62%),
    radial-gradient(46% 38% at 100% 0%, var(--mesh-b), transparent 58%);
  background-attachment: fixed;
  font: 15px/1.55 var(--font);
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, p { margin: 0; }
:focus-visible { outline: none; box-shadow: var(--ring); border-radius: var(--radius-sm); }
main, .topbar, footer { max-width: 1120px; margin: 0 auto; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.skip {
  position: absolute; left: 12px; top: -48px; z-index: 50;
  padding: 9px 13px; border-radius: var(--radius-sm);
  background: var(--surface); color: var(--fg); border: 1px solid var(--border-strong);
  text-decoration: none; font-size: 13px; box-shadow: var(--shadow-sm);
}
.skip:focus { top: 12px; }

/* ---------------------------------------------------------------- topbar */
.topbar {
  position: sticky; top: 0; z-index: 30;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 14px 0; margin-bottom: 4px;
  background: var(--glass);
  backdrop-filter: blur(14px) saturate(160%);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
  border-bottom: 1px solid var(--hairline);
}
.brand { display: flex; align-items: center; gap: 11px; }
.brand-dot {
  width: 11px; height: 11px; border-radius: 50%;
  background: var(--grad); box-shadow: 0 0 0 4px var(--accent-soft);
}
h1 { font-size: clamp(16px, 1.4vw + 12px, 20px); font-weight: 650; letter-spacing: .1px; }
.muted { color: var(--fg-muted); font-weight: 400; }
.topbar-actions { display: flex; align-items: center; gap: 10px; }
.status {
  font-size: 12px; padding: 5px 11px; border-radius: 999px;
  border: 1px solid var(--border); color: var(--fg-muted); background: var(--surface);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.status[data-state="live"] { color: var(--ok); background: var(--ok-soft); border-color: transparent; }
.status[data-state="stale"] { color: var(--warn); background: var(--warn-soft); border-color: transparent; }
.status[data-state="offline"] { color: var(--warn); background: var(--warn-soft); border-color: transparent; }

/* ------------------------------------------------------------- controls */
.btn {
  font: inherit; font-size: 13px; color: var(--fg); cursor: pointer;
  padding: 7px 13px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--surface);
  transition: background-color var(--dur-2) var(--ease-out), border-color var(--dur-2) var(--ease-out), transform var(--dur-1) var(--ease-out), box-shadow var(--dur-2) var(--ease-out);
}
.btn:hover { background: var(--surface-hover); border-color: var(--border-strong); transform: translateY(-1.5px); box-shadow: var(--shadow-sm); }
.btn:active { transform: translateY(0) scale(.985); }
.btn[aria-pressed="true"] { background: var(--accent-soft); border-color: transparent; color: var(--info); }
.btn--icon { width: 32px; padding: 5px 0; text-align: center; line-height: 1; font-size: 15px; }
.seg { display: inline-flex; align-items: center; gap: 4px; padding: 3px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); }
.seg .btn { border-color: transparent; background: transparent; box-shadow: none; }
.seg .btn:hover { background: var(--surface-hover); transform: none; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  font: inherit; font-size: 12px; color: var(--fg-muted);
  padding: 4px 10px; border: 0; border-radius: 999px; background: transparent;
  transition: background-color var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out), opacity var(--dur-2) var(--ease-out);
}
.chip:hover { background: var(--surface-hover); color: var(--fg); }
.chip[aria-pressed="false"] { opacity: .45; }
.chip--static { cursor: default; background: var(--surface-2); border: 1px solid var(--border); }
.chip__dot { width: 9px; height: 9px; border-radius: 50%; flex: none; box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 12%, transparent); }
.link {
  font: inherit; font-size: 13px; font-family: var(--mono);
  color: var(--info); background: none; border: 0; padding: 2px 0; cursor: pointer;
  text-align: left; border-radius: 4px;
}
.link:hover { text-decoration: underline; }
.search input {
  font: inherit; font-size: 13px; color: var(--fg);
  padding: 7px 13px; min-width: 230px;
  border-radius: 999px; border: 1px solid var(--border); background: var(--surface);
  transition: border-color var(--dur-2) var(--ease-out), box-shadow var(--dur-2) var(--ease-out);
}
.search input::placeholder { color: var(--fg-faint); }
.search input:focus { outline: none; border-color: var(--accent); box-shadow: var(--ring); }
.lede { color: var(--fg-muted); font-size: 13.5px; margin: 14px 0 22px; max-width: 62ch; }
.count {
  font-size: 11px; font-weight: 500; letter-spacing: .4px; text-transform: none;
  color: var(--fg-faint); margin-left: 6px; font-variant-numeric: tabular-nums;
}
.block-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* ----------------------------------------------------------------- bento */
main > * { animation: rise var(--dur-3) var(--ease-out) both; }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.bento { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(196px, 1fr)); }
.card {
  position: relative; overflow: hidden;
  padding: 17px 19px; border-radius: var(--radius-xl);
  background: var(--surface); border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur-2) var(--ease-out), border-color var(--dur-2) var(--ease-out), box-shadow var(--dur-2) var(--ease-out);
}
.card::before {
  content: ""; position: absolute; inset: 0 0 auto 0; height: 2px;
  background: var(--grad); opacity: .5;
}
.card:hover { transform: translateY(-2px); border-color: var(--border-strong); box-shadow: var(--shadow); }
.card--hero { grid-column: span 2; }
.card--hero::before { opacity: .95; height: 3px; }
.card__k { font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: var(--fg-muted); }
.card__v {
  font-size: clamp(24px, 3.2vw + 12px, 36px); font-weight: 690; line-height: 1.1;
  margin-top: 7px; font-variant-numeric: tabular-nums; letter-spacing: -.6px;
}
.card--hero .card__v { background: var(--grad); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
.card__s { font-size: 12px; color: var(--fg-faint); margin-top: 5px; }
.card__spark { margin-top: 12px; }
.card__spark svg { display: block; width: 100%; height: 40px; }
.donut { display: flex; align-items: center; gap: 13px; margin-top: 7px; }
.donut svg { flex: none; }
.donut__v { font-size: 23px; font-weight: 690; font-variant-numeric: tabular-nums; letter-spacing: -.4px; }

/* ---------------------------------------------------------------- blocks */
.block { margin-top: 34px; }
.block-head { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; margin-bottom: 12px; flex-wrap: wrap; }
h2 { font-size: 11.5px; letter-spacing: 1.4px; text-transform: uppercase; color: var(--fg-muted); font-weight: 650; }
.hint { font-size: 12px; color: var(--fg-faint); }
.panel {
  padding: 16px 18px; border-radius: var(--radius-xl);
  background: var(--surface); border: 1px solid var(--border); box-shadow: var(--shadow-sm);
}
.panel--graph { padding: 8px; position: relative; overflow: hidden; }
.panel--graph:focus-visible { box-shadow: var(--ring); }
.graph-hint { margin-top: 10px; }

/* ------------------------------------------------------------- charts */
.chart svg { display: block; }
.chart.is-hot .bar:not(.is-on) { opacity: .35; }
.chart .bar { transition: opacity var(--dur-2) var(--ease-out); cursor: default; }
.chart__axis { display: flex; justify-content: space-between; gap: 12px; font-size: 11px; color: var(--fg-faint); margin-top: 4px; }
.chart__legend { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; font-size: 12px; color: var(--fg-muted); margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--hairline); }
.chart__legend span { display: inline-flex; align-items: center; gap: 7px; }
.chart__scroll { overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; }
.chart .blabel { pointer-events: none; font-family: var(--mono); font-variant-numeric: tabular-nums; paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
.chart .blabel.is-on { fill: var(--fg); font-weight: 700; }
.chart__keyhint { margin-left: auto; color: var(--fg-faint); }
.chart-cap { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-muted); }
.chart-cap select {
  font: inherit; font-size: 12px; color: var(--fg); cursor: pointer;
  padding: 5px 9px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface);
  transition: border-color var(--dur-2) var(--ease-out), box-shadow var(--dur-2) var(--ease-out);
}
.chart-cap select:focus { outline: none; border-color: var(--accent); box-shadow: var(--ring); }
.chart__readout-row { display: flex; align-items: flex-start; gap: 10px; margin-top: 8px; }
.chart__readout {
  flex: 1; padding: 9px 12px; font-family: var(--mono); font-size: 12px; line-height: 1.5;
  color: var(--fg-muted); background: var(--surface-2); border: 1px solid var(--hairline);
  border-radius: var(--radius); word-break: break-word;
}
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn:disabled:hover { transform: none; }
kbd { font-family: var(--mono); font-size: 11px; line-height: 1; padding: 3px 5px; border-radius: 5px; border: 1px solid var(--border-strong); background: var(--surface-2); color: var(--fg-muted); }
.swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.tip {
  position: fixed; z-index: 40; max-width: 320px; padding: 9px 11px;
  font-size: 12px; line-height: 1.45; color: var(--fg); background: var(--surface);
  border: 1px solid var(--border-strong); border-radius: var(--radius);
  box-shadow: var(--shadow-lg); pointer-events: none;
}
.tip[hidden] { display: none; }

/* ---------------------------------------------------------------- graph */
.graph { position: relative; }
.graph svg { display: block; width: 100%; touch-action: none; }
.graph svg.is-panning { cursor: grabbing; }
.graph .hit { cursor: grab; }
.graph .node {
  cursor: grab;
  transition: opacity var(--dur-2) var(--ease-out);
}
.graph .node:active { cursor: grabbing; }
.graph .node:focus-visible { outline: none; stroke: var(--fg); stroke-width: 3; }
.graph .nlabel {
  font-size: 10.5px; fill: var(--fg-muted); pointer-events: none;
  paint-order: stroke; stroke: var(--surface); stroke-width: 3.5px; stroke-linejoin: round;
}
.graph .nlabel.is-repo { font-size: 12px; font-weight: 650; fill: var(--fg); }
.graph .nlabel.is-on { fill: var(--fg); font-weight: 600; }
.graph .edge { transition: opacity var(--dur-2) var(--ease-out), stroke var(--dur-3) var(--ease-out); }
.graph .edge.is-on { stroke: var(--accent); stroke-width: 2; opacity: .95; }
.graph svg.is-dim .node { opacity: .22; }
.graph svg.is-dim .node.is-on { opacity: 1; }
.graph svg.is-dim .edge { opacity: .07; }
.graph svg.is-dim .edge.is-on { opacity: .95; }
.graph .pinned { stroke-dasharray: 3 3; }
.graph .ngroup { transition: opacity var(--dur-2) var(--ease-out); }
.graph .is-off { display: none; }

/* ---------------------------------------------------------------- table */
.scroll { overflow-x: auto; border-radius: var(--radius-xl); }
.table { width: 100%; border-collapse: separate; border-spacing: 0; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-xl); overflow: hidden; box-shadow: var(--shadow-sm); }
.table caption { text-align: left; }
.table th {
  position: sticky; top: 0; z-index: 1;
  text-align: left; font-size: 10.5px; letter-spacing: .9px; text-transform: uppercase; font-weight: 600;
  color: var(--fg-muted); background: var(--surface-2);
  padding: 11px 15px; border-bottom: 1px solid var(--border);
}
.table td { padding: 11px 15px; border-bottom: 1px solid var(--hairline); vertical-align: middle; }
.table tbody tr:last-child td { border-bottom: 0; }
.table tbody tr { transition: background-color var(--dur-2) var(--ease-out); }
.table tbody tr:hover { background: var(--surface-hover); }
.table th.num, .table td.num { text-align: right; }
.num { font-variant-numeric: tabular-nums; }
.mono { font-family: var(--mono); font-size: 12.5px; }
.bar { display: block; height: 6px; margin-top: 6px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
.bar > .fill { display: block; height: 100%; width: var(--pct, 0%); background: var(--grad); border-radius: 999px; transition: width var(--dur-4) var(--ease-out); }

/* ----------------------------------------------------------------- list */
.list { list-style: none; margin: 0; padding: 0; }
.list li {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px;
  padding: 10px 0; border-bottom: 1px solid var(--hairline);
}
.list li:last-child { border-bottom: 0; }
.key { font-family: var(--mono); font-size: 12.5px; color: var(--info); }
.val { color: var(--fg); }
.was { color: var(--fg-faint); font-size: 12.5px; }
.repo { font-family: var(--mono); font-size: 12px; color: var(--accent); }
.pill { font-size: 11px; padding: 2px 10px; border-radius: 999px; }
.pill--ok { background: var(--ok-soft); color: var(--ok); }
.pill--warn { background: var(--warn-soft); color: var(--warn); }
.pill--info { background: var(--info-soft); color: var(--info); }
.copy { font-size: 11px; padding: 2px 9px; margin-left: auto; }
.copy[data-state="copied"] { color: var(--ok); border-color: var(--ok); background: var(--ok-soft); }
.empty {
  display: flex; align-items: center; gap: 10px;
  padding: 20px 18px; border-radius: var(--radius-lg);
  background: var(--surface); border: 1px dashed var(--border-strong);
  color: var(--fg-muted); font-size: 13px;
}
.empty::before { content: "○"; color: var(--fg-faint); font-size: 15px; }
.skeleton {
  position: relative; overflow: hidden; height: 62px; border-radius: var(--radius-lg);
  background: var(--surface); border: 1px solid var(--border);
}
.skeleton::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent, var(--surface-hover), transparent);
  animation: sweep 1.4s linear infinite;
}
@keyframes sweep { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
.detail { margin-top: 14px; padding: 18px; border-radius: var(--radius-xl); background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow-sm); }
.detail[hidden] { display: none; }
.detail h3 { font-size: 13.5px; margin-bottom: 6px; }
.detail__head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.detail__grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); margin-bottom: 14px; }
.detail__stat { background: var(--surface-2); border-radius: var(--radius); padding: 11px 13px; border: 1px solid var(--hairline); }
.detail__k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .8px; color: var(--fg-muted); }
.detail__v { font-size: 19px; font-weight: 650; font-variant-numeric: tabular-nums; }
.detail__meta-grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); margin-bottom: 14px; }
.detail__meta { display: flex; align-items: baseline; gap: 8px; background: var(--surface-2); border: 1px solid var(--hairline); border-radius: var(--radius); padding: 9px 12px; }
.detail__mk { font-size: 10.5px; text-transform: uppercase; letter-spacing: .8px; color: var(--fg-muted); flex: none; }
.detail__mv { font-family: var(--mono); font-size: 12.5px; color: var(--fg); word-break: break-word; }
.detail__row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.detail__text { font-family: var(--mono); font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; background: var(--surface-2); border: 1px solid var(--hairline); border-radius: var(--radius); padding: 11px 13px; margin-bottom: 14px; color: var(--fg); }
footer { margin-top: 44px; color: var(--fg-faint); font-size: 12px; }

@media (max-width: 760px) {
  body { padding: 0 14px 56px; }
  .card--hero { grid-column: span 1; }
  .search input { min-width: 0; width: 100%; }
  .block-head { align-items: flex-start; }
  .block-actions { width: 100%; justify-content: space-between; }
  .graph { height: auto; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .001ms !important;
  }
  html { scroll-behavior: auto; }
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
  function setClass(node, name, on) {
    if (!node) { return; }
    if (on) { if (!node.classList.contains(name)) { node.classList.add(name); } }
    else if (node.classList.contains(name)) { node.classList.remove(name); }
  }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
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
  function thousands(n) {
    try { return new Intl.NumberFormat().format(n); } catch (e) { return String(n); }
  }
  /* A bar label has to survive a narrow slot, so a count never exceeds five
     characters: 999, 1.2k, 12.3k, 124k, 1.2M. */
  function compact(n) {
    if (n >= 1000000) { return Math.round(n / 100000) / 10 + 'M'; }
    if (n >= 100000) { return Math.round(n / 1000) + 'k'; }
    if (n >= 1000) { return Math.round(n / 100) / 10 + 'k'; }
    return String(n);
  }
  /* Rebuild a section only when its data actually changed — this is what keeps
     the page from flickering (and from stealing focus) on every poll. */
  function section(node, key, build) {
    if (!node || node.__sig === key) { return; }
    node.__sig = key;
    clear(node);
    build(node);
  }
  /* Number tick: the value eases to its new reading instead of jumping, so a
     refresh that changed something is visible without a toast. Reduced motion
     (and the first paint) render the final value straight away. */
  function setValue(node, value, from) {
    var text = thousands(value);
    if (from === undefined || reducedMotion()) { node.textContent = text; return; }
    if (node.__tick) { cancelAnimationFrame(node.__tick); node.__tick = 0; }
    var t0 = performance.now(), dur = 420;
    function frame(now) {
      var p = Math.min(1, (now - t0) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      node.textContent = thousands(Math.round(from + (value - from) * eased));
      node.__tick = p < 1 ? requestAnimationFrame(frame) : 0;
    }
    node.__tick = requestAnimationFrame(frame);
  }
  function statValue(node, value) {
    var from = node.__n;
    node.__n = value;
    setValue(node, value, from);
    return node;
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
  /* The floating tooltip only exists under a pointer, and a long query gets clipped
     by its own max-width. This mirrors the focused bar's full text into a line under
     the chart so it is readable from the keyboard, and announces it politely. */
  function setReadout(text) {
    var node = byId('chart-readout');
    if (!node || node.__text === text) { return; }
    node.__text = text;
    node.textContent = text;
    var btn = byId('chart-copy');
    if (btn) { btn.disabled = text === READOUT_HINT; }
  }
  /* Hover previews are debounced: sweeping the pointer across bars would otherwise
     strobe the line — leaving a bar reverts to the focused one, entering the next
     replaces it again. A sequence number makes each call supersede the one before,
     so nothing needs cancelling and a stale timer can never win. */
  var readoutSeq = 0;
  function previewReadout(text) {
    var token = ++readoutSeq;
    setTimeout(function () {
      if (token !== readoutSeq) { return; }
      setReadout(text);
    }, READOUT_HOVER_MS);
  }
  function commitReadout(text) {
    readoutSeq++;
    setReadout(text);
  }

  // --------------------------------------------------------------- state
  var STATE = { facts: [], sessions: [], repos: [], recalls: [], filter: '' };

  // ---------------------------------------------------------------- cards
  function card(label, value, sub) {
    var c = el('article', 'card');
    c.appendChild(el('p', 'card__k', label));
    var v = el('p', 'card__v', thousands(value));
    c.appendChild(v);
    if (sub) { c.appendChild(el('p', 'card__s', sub)); }
    return { node: c, value: v };
  }
  function sparkline(values, label) {
    if (!values.length) { return null; }
    var W = 300, H = 40, max = Math.max.apply(null, values.concat([1]));
    var node = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', role: 'img', 'aria-label': label });
    var defs = svg('defs');
    var grad = svg('linearGradient', { id: 'ax-spark', x1: '0', y1: '1', x2: '0', y2: '0' });
    grad.appendChild(svg('stop', { offset: '0', 'stop-color': 'var(--accent)', 'stop-opacity': '0' }));
    grad.appendChild(svg('stop', { offset: '1', 'stop-color': 'var(--accent)', 'stop-opacity': '.22' }));
    defs.appendChild(grad);
    node.appendChild(defs);
    var step = values.length > 1 ? W / (values.length - 1) : 0;
    var d = '';
    var last = { x: 0, y: H };
    for (var i = 0; i < values.length; i++) {
      var x = i * step;
      var y = H - 4 - (values[i] / max) * (H - 12);
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      last = { x: x, y: y };
    }
    node.appendChild(svg('path', { d: d + 'L' + W + ' ' + H + ' L0 ' + H + ' Z', fill: 'url(#ax-spark)', stroke: 'none' }));
    node.appendChild(svg('path', { d: d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': '2', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    node.appendChild(svg('circle', { cx: last.x.toFixed(1), cy: last.y.toFixed(1), r: '2.6', fill: 'var(--accent)' }));
    var wrap = el('div', 'card__spark');
    wrap.appendChild(node);
    return wrap;
  }
  function renderCards(d) {
    var saved = (d.repos || []).reduce(function (a, r) { return a + (r.tokensSavedEstimate || 0); }, 0);
    var changed = (d.facts || []).filter(function (f) { return f.previousValue !== undefined; }).length;
    var recalls = d.recalls || [];
    var hits = recalls.filter(function (r) { return r.hit; }).length;
    var rate = recalls.length ? Math.round((hits / recalls.length) * 100) : null;
    var key = [d.totals.facts, d.totals.knowledge, d.totals.sessions, changed, saved, (d.repos || []).length, rate, recalls.length, hits].join('|');
    section(byId('cards'), key, function (host) {
      var hero = card('Tokens saved (est.)', saved, 'vs full re-reads');
      hero.node.classList.add('card--hero');
      var spark = sparkline(recalls.map(function (r) { return r.tokenEstimate || 0; }).slice(-40), 'Tokens returned by the last recalls');
      if (spark) { hero.node.appendChild(spark); }
      host.appendChild(hero.node);
      host.appendChild(card('Repos', (d.repos || []).length, 'with memory or telemetry').node);
      host.appendChild(card('Facts', d.totals.facts, changed ? changed + ' of ' + d.totals.facts + ' changed since first pinned' : 'pinned stable facts').node);
      host.appendChild(card('Knowledge', d.totals.knowledge, 'decisions · gotchas · conventions').node);
      host.appendChild(card('Sessions', d.totals.sessions, 'handoffs stored').node);

      var ring = el('article', 'card');
      ring.appendChild(el('p', 'card__k', 'Recall hit rate'));
      var row = el('div', 'donut');
      var R = 23, C = 2 * Math.PI * R, pct = rate === null ? 0 : rate;
      var donut = svg('svg', { width: '60', height: '60', viewBox: '0 0 60 60', role: 'img', 'aria-label': rate === null ? 'No recalls yet' : 'Hit rate ' + rate + ' percent' });
      donut.appendChild(svg('circle', { cx: '30', cy: '30', r: R, fill: 'none', stroke: 'var(--surface-3)', 'stroke-width': '7' }));
      donut.appendChild(svg('circle', {
        cx: '30', cy: '30', r: R, fill: 'none', stroke: 'var(--ok)', 'stroke-width': '7',
        'stroke-linecap': 'round', 'stroke-dasharray': (C * pct / 100).toFixed(1) + ' ' + C.toFixed(1),
        transform: 'rotate(-90 30 30)'
      }));
      row.appendChild(donut);
      row.appendChild(el('span', 'donut__v', rate === null ? '—' : rate + '%'));
      ring.appendChild(row);
      ring.appendChild(el('p', 'card__s', recalls.length ? hits + ' hits of ' + recalls.length + ' recalls' : 'no recalls recorded yet'));
      host.appendChild(ring);
    });
  }

  // ---------------------------------------------------------------- chart
  /* How many bars the chart draws and how much room each one gets. The cap is what
     keeps a horizontal value label legible without rotating anything; the reader
     picks it (10 / 30 / 50 / all of the window the endpoint returned), and the zoom
     toggle is the way to spend more width on the bars that remain. Both choices are
     preferences, stored the way the theme is: one small localStorage key each, read
     with a fallback so a private-mode failure is silent. */
  var CHART_DEFAULT_CAP = 30;
  var CAP_CHOICES = [10, 30, 50, 0]; // 0 = every recall the endpoint returned
  var CAP_KEY = 'aegisx-chart-cap';
  var WIDE_KEY = 'aegisx-chart-wide';
  function capFromValue(value) {
    var n = parseInt(value, 10);
    return CAP_CHOICES.indexOf(n) >= 0 ? n : CHART_DEFAULT_CAP;
  }
  function storedCap() {
    try { return capFromValue(localStorage.getItem(CAP_KEY)); }
    catch (e) { return CHART_DEFAULT_CAP; }
  }
  function saveCap(n) {
    try { localStorage.setItem(CAP_KEY, String(n)); } catch (e) { /* private mode */ }
  }
  function storedWide() {
    try { return localStorage.getItem(WIDE_KEY) === '1'; } catch (e) { return false; }
  }
  function saveWide(on) {
    try { localStorage.setItem(WIDE_KEY, on ? '1' : '0'); } catch (e) { /* private mode */ }
  }
  var CHART_FIT_W = 960;
  var CHART_BAR_PX = 44;
  var READOUT_HINT = 'Tab to a bar, then use ← → to read its full detail here.';
  var READOUT_HOVER_MS = 120;
  function renderChart(recalls) {
    var host = byId('chart');
    if (!host) { return; }
    host.classList.add('chart');
    var total = recalls.length;
    var cap = CHART.cap > 0 ? CHART.cap : total;
    var shown = total > cap ? recalls.slice(-cap) : recalls;
    var key = (CHART.wide ? 'wide|' : 'fit|') + CHART.cap + '|' + total + '|' + shown.map(function (r) { return (r.createdAt || '') + (r.hit ? '1' : '0') + (r.tokenEstimate || 0); }).join(',');
    updateChartToggle(total);
    updateChartPick(total);
    section(host, key, function (host) {
      var badge = byId('recall-count');
      if (badge) {
        badge.textContent = !total ? '' : (shown.length < total ? 'last ' + shown.length + ' of ' + total + ' events' : total + ' events');
      }
      if (!shown.length) {
        CHART.bars = [];
        CHART.scroll = null;
        CHART.hoverText = null;
        commitReadout(READOUT_HINT);
        host.appendChild(el('p', 'empty', 'No recalls yet — ask your agent to recall the project memory.'));
        return;
      }
      var hits = shown.filter(function (r) { return r.hit; }).length;
      var n = shown.length;
      var H = 152, padTop = 26, padBottom = 16;
      var W = CHART.wide ? Math.max(CHART_FIT_W, n * CHART_BAR_PX) : CHART_FIT_W;
      var max = Math.max.apply(null, shown.map(function (r) { return r.tokenEstimate || 0; }).concat([1]));
      var node = svg('svg', {
        viewBox: '0 0 ' + W + ' ' + H,
        width: CHART.wide ? W + 'px' : '100%',
        height: H, role: 'group',
        'aria-label': 'Recall history: ' + n + ' recalls, ' + hits + ' hits, ' + (n - hits) + ' misses'
      });
      var defs = svg('defs');
      [['ax-hit', 'var(--ok)'], ['ax-miss', 'var(--warn)']].forEach(function (pair) {
        var lg = svg('linearGradient', { id: pair[0], x1: '0', y1: '1', x2: '0', y2: '0' });
        lg.appendChild(svg('stop', { offset: '0', 'stop-color': pair[1], 'stop-opacity': '.32' }));
        lg.appendChild(svg('stop', { offset: '1', 'stop-color': pair[1], 'stop-opacity': '1' }));
        defs.appendChild(lg);
      });
      node.appendChild(defs);
      for (var g = 0; g <= 3; g++) {
        var gy = padTop + (H - padTop - padBottom) * (g / 3);
        node.appendChild(svg('line', { x1: '0', y1: gy.toFixed(1), x2: W, y2: gy.toFixed(1), stroke: 'var(--border)', 'stroke-dasharray': '3 6', 'stroke-width': '1' }));
        var tick = svg('text', { x: W - 2, y: (gy - 4).toFixed(1), 'text-anchor': 'end', 'font-size': '10', fill: 'var(--fg-faint)' });
        tick.textContent = thousands(Math.round(max * (1 - g / 3)));
        node.appendChild(tick);
      }
      host.setAttribute('role', 'group');
      host.setAttribute('aria-label', 'Recall history: ' + n + ' recalls, ' + hits + ' hits, ' + (n - hits) + ' misses. Use the left and right arrow keys to step through the bars.');
      var bars = [];
      var bw = Math.max(4, Math.floor((W - 12) / n) - 3);
      var labelSize = CHART.wide ? '11' : '9.5';
      for (var i = 0; i < n; i++) {
        var r = shown[i];
        var tokens = r.tokenEstimate || 0;
        var h = 14 + (tokens / max) * (H - padTop - padBottom - 14);
        var bx = 6 + (i * (W - 12)) / n;
        var barTop = H - padBottom - h;
        var rect = svg('rect', {
          x: bx.toFixed(1), y: barTop.toFixed(1),
          width: bw, height: h.toFixed(1), rx: '4',
          fill: r.hit ? 'url(#ax-hit)' : 'url(#ax-miss)',
          class: 'bar', tabindex: '-1', role: 'img'
        });
        var label = (r.repo || 'unknown repo') + ' · ' + (r.hit ? 'hit' : 'miss') + ' · ~' + tokens + ' tokens' + (r.query ? ' · ' + r.query : '') + ' · ' + clock(Date.parse(r.createdAt || Date.now()));
        rect.setAttribute('aria-label', label);
        rect._t = label;
        node.appendChild(rect);
        bars.push(rect);
        var bl = svg('text', {
          class: 'blabel', 'font-size': labelSize, fill: 'var(--fg-faint)',
          x: (bx + bw / 2).toFixed(1), y: (barTop - 5).toFixed(1), 'text-anchor': 'middle'
        });
        bl.textContent = compact(tokens);
        node.appendChild(bl);
        rect._bl = bl;
        rect.addEventListener('pointerenter', function (ev) {
          hot(ev.target, bars);
          showTip(ev.clientX, ev.clientY, ev.target._t);
          CHART.hoverText = ev.target._t;
          previewReadout(ev.target._t);
        });
        rect.addEventListener('pointermove', function (ev) { showTip(ev.clientX, ev.clientY, ev.target._t); });
        rect.addEventListener('pointerleave', function () {
          cold(host, bars);
          hideTip();
          CHART.hoverText = null;
          previewReadout(CHART.readoutFocus);
        });
        rect.addEventListener('focus', function (ev) {
          hot(ev.target, bars);
          keepBarInView(ev.target);
          CHART.readoutFocus = ev.target._t;
          commitReadout(ev.target._t);
          var b = ev.target.getBoundingClientRect();
          showTip(b.left + b.width / 2, b.top, ev.target._t);
        });
        rect.addEventListener('blur', function () {
          cold(host, bars);
          hideTip();
          CHART.readoutFocus = READOUT_HINT;
          if (!CHART.hoverText) { commitReadout(READOUT_HINT); }
        });
      }
      var scroll = el('div', 'chart__scroll');
      scroll.appendChild(node);
      host.appendChild(scroll);
      CHART.bars = bars;
      CHART.scroll = scroll;
      chartRoving(CHART.active);

      var axis = el('div', 'chart__axis');
      axis.appendChild(el('span', null, 'oldest'));
      axis.appendChild(el('span', null, shown.length < total ? 'showing the last ' + shown.length + ' of ' + total + ' recalls' : 'bar height = tokens returned'));
      axis.appendChild(el('span', null, 'newest'));
      host.appendChild(axis);

      var legend = el('div', 'chart__legend');
      legend.appendChild(legendItem('var(--ok)', hits + ' warm hits'));
      legend.appendChild(legendItem('var(--warn)', (n - hits) + ' cold misses'));
      legend.appendChild(el('span', null, 'bar height = ~tokens returned'));
      legend.appendChild(el('span', null, 'peak ~' + thousands(max) + ' tokens'));
      if (CHART.wide) { legend.appendChild(el('span', null, 'scroll sideways for the whole chart')); }
      var keyHint = el('span', 'chart__keyhint');
      keyHint.appendChild(el('kbd', null, '←'));
      keyHint.appendChild(el('kbd', null, '→'));
      keyHint.appendChild(el('span', null, 'step through bars'));
      legend.appendChild(keyHint);
      host.appendChild(legend);
    });
  }
  var CHART = { bars: [], active: 0, wide: storedWide(), cap: storedCap(), scroll: null, hoverText: null, readoutFocus: READOUT_HINT };
  /* Bring the bar the reader is on back into view, on both axes. Horizontally only a
     zoomed canvas overflows, and the panel's own box scrolls for it; fit mode has
     nothing to scroll, which is what keeps a 10s poll from moving the view. Vertically
     the chart has no scroller of its own, so a short viewport is the page's job —
     guarded on the browser APIs so a harness without layout simply no-ops. */
  function keepBarInView(bar) {
    if (!bar || !bar.getBoundingClientRect) { return; }
    var br = bar.getBoundingClientRect();
    var box = CHART.scroll;
    if (box && box.scrollWidth > box.clientWidth) {
      var cr = box.getBoundingClientRect();
      if (cr.right !== undefined && br.right !== undefined) {
        var pad = 24;
        var next = box.scrollLeft || 0;
        if (br.left < cr.left) { next -= (cr.left - br.left) + pad; }
        else if (br.right > cr.right) { next += (br.right - cr.right) + pad; }
        box.scrollLeft = clamp(next, 0, box.scrollWidth - box.clientWidth);
      }
    }
    var vh = window.innerHeight || 0;
    if (vh <= 0 || typeof window.scrollBy !== 'function' || br.bottom === undefined) { return; }
    var vpad = 8;
    if (br.top < 0) { window.scrollBy(0, br.top - vpad); }
    else if (br.bottom > vh) { window.scrollBy(0, br.bottom - vh + vpad); }
  }
  function updateChartPick(total) {
    var sel = byId('chart-cap');
    if (!sel) { return; }
    var want = String(CHART.cap);
    if (sel.value !== want) { sel.value = want; }
    sel.disabled = total === 0;
  }
  function updateChartToggle(total) {
    var btn = byId('chart-zoom');
    if (!btn) { return; }
    var label = CHART.wide ? 'Fit' : 'Zoom';
    if (btn.__label !== label) { btn.__label = label; btn.textContent = label; }
    btn.setAttribute('aria-pressed', CHART.wide ? 'true' : 'false');
    btn.setAttribute('aria-label', CHART.wide
      ? 'Zoom on: bars are widened and scroll sideways. Activate to fit the chart to the view.'
      : 'Zoom off: the chart fits the view. Activate to widen the bars.');
    btn.disabled = total === 0;
  }
  function legendItem(color, text) {
    var row = el('span');
    var sw = el('span', 'swatch');
    sw.style.background = color;
    row.appendChild(sw);
    row.appendChild(el('span', null, text));
    return row;
  }
  /* Roving tabindex: the chart is a single Tab stop, and the arrow keys move the
     stop from bar to bar — the same pattern the graph uses, and the reason the
     bars are no longer each their own tab stop. */
  function chartRoving(i) {
    var bars = CHART.bars;
    if (!bars.length) { return; }
    i = clamp(i, 0, bars.length - 1);
    CHART.active = i;
    for (var j = 0; j < bars.length; j++) {
      var want = j === i ? '0' : '-1';
      if (bars[j].getAttribute('tabindex') !== want) { bars[j].setAttribute('tabindex', want); }
    }
  }
  function chartFocus(i) {
    if (!CHART.bars.length) { return; }
    chartRoving(i);
    var bar = CHART.bars[CHART.active];
    try { bar.focus(); } catch (e) { /* ignore */ }
    var b = bar.getBoundingClientRect();
    showTip(b.left + b.width / 2, b.top, bar._t);
  }
  function chartKey(ev) {
    var k = ev.key;
    if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'Home' && k !== 'End') { return; }
    if (ev.preventDefault) { ev.preventDefault(); }
    var last = CHART.bars.length - 1;
    var next;
    if (k === 'Home') { next = 0; }
    else if (k === 'End') { next = last; }
    else { next = CHART.active + ((k === 'ArrowLeft' || k === 'ArrowUp') ? -1 : 1); }
    chartFocus(clamp(next, 0, last));
  }
  function hot(target, bars) {
    var host = byId('chart');
    setClass(host, 'is-hot', true);
    for (var i = 0; i < bars.length; i++) {
      setClass(bars[i], 'is-on', bars[i] === target);
      setClass(bars[i]._bl, 'is-on', bars[i] === target);
    }
  }
  function cold(host, bars) {
    setClass(host, 'is-hot', false);
    for (var i = 0; i < bars.length; i++) { setClass(bars[i], 'is-on', false); setClass(bars[i]._bl, 'is-on', false); }
  }

  // ---------------------------------------------------------------- graph
  /* Deterministic cluster layout: repositories sit on a ring, their dependents
     fan outward, then a bounded relaxation settles the whole thing. A position
     is seeded once per node id, so the 10 s refresh never reshuffles the view,
     and the loop stops as soon as the layout stops moving. */
  var VIEW_W = 960, VIEW_H = 520;
  var KINDS = ['repo', 'fact', 'knowledge', 'session'];
  var KIND_LABEL = { repo: 'repos', fact: 'facts', knowledge: 'knowledge', session: 'handoffs' };
  var KIND_COLOR = { repo: 'var(--kind-repo)', fact: 'var(--kind-fact)', knowledge: 'var(--kind-knowledge)', session: 'var(--kind-session)' };
  var G = {
    data: { nodes: [], edges: [] }, sig: '', list: false, off: {},
    svg: null, zoom: null, nodesLayer: null, edgesLayer: null, hitBox: null,
    items: {}, edgeEls: [], pos: {}, adj: {}, pin: {}, byId: {},
    sel: null, hover: null, labels: {},
    drag: null, pan: null, k: 1, tx: 0, ty: 0,
    raf: 0, energy: 1, settled: true
  };

  function hash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return h >>> 0;
  }
  function shortLabel(s) { return s.length > 30 ? s.slice(0, 29) + '…' : s; }
  function degree(id) { return G.adj[id] ? G.adj[id].length : 0; }
  function radiusOf(n) { var d = Math.min(6, degree(n.id)); return n.kind === 'repo' ? 15 + d * 1.3 : 7 + d * 0.9; }
  function visibleNodes() { return G.data.nodes.filter(function (n) { return !G.off[n.kind]; }); }
  function visibleEdges() {
    var on = {}, i;
    var nodes = visibleNodes();
    for (i = 0; i < nodes.length; i++) { on[nodes[i].id] = 1; }
    return G.data.edges.filter(function (e) { return on[e.source] && on[e.target]; });
  }
  function buildMaps() {
    var adj = {}, byId = {}, i, nodes = G.data.nodes;
    for (i = 0; i < nodes.length; i++) { adj[nodes[i].id] = []; byId[nodes[i].id] = nodes[i]; }
    var edges = visibleEdges();
    for (i = 0; i < edges.length; i++) {
      var e = edges[i];
      if (adj[e.source]) { adj[e.source].push({ id: e.target, label: e.label }); }
      if (adj[e.target]) { adj[e.target].push({ id: e.source, label: e.label }); }
    }
    G.adj = adj;
    G.byId = byId;
  }
  /* Labels are the noisiest thing on a graph this dense: only repos, the top of
     the degree ranking, and whatever is hovered or selected get one. */
  function computeLabels() {
    var ranked = visibleNodes().slice().sort(function (a, b) {
      var d = degree(b.id) - degree(a.id);
      return d !== 0 ? d : (a.id < b.id ? -1 : 1);
    });
    var keep = {};
    for (var i = 0; i < ranked.length; i++) {
      if (ranked[i].kind === 'repo' || i < 9) { keep[ranked[i].id] = 1; }
    }
    G.labels = keep;
  }

  function seatMissing() {
    var nodes = visibleNodes(), edges = visibleEdges(), i;
    var cx = VIEW_W / 2, cy = VIEW_H / 2;
    var repos = [], repoSet = {}, kids = {}, orphans = [];
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i].kind === 'repo') { repos.push(nodes[i]); repoSet[nodes[i].id] = 1; kids[nodes[i].id] = []; }
    }
    var Rr = repos.length <= 1 ? 0 : Math.min(VIEW_W, VIEW_H) * 0.33;
    for (i = 0; i < repos.length; i++) {
      var a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, repos.length);
      if (!G.pos[repos[i].id]) {
        G.pos[repos[i].id] = { x: cx + Math.cos(a) * Rr * 1.32, y: cy + Math.sin(a) * Rr * 0.95 };
      }
    }
    for (i = 0; i < edges.length; i++) {
      var s = edges[i].source, t = edges[i].target;
      if (repoSet[t]) { kids[t].push(s); }
      else if (repoSet[s]) { kids[s].push(t); }
      else { orphans.push(s); }
    }
    for (var hub in kids) {
      var list = kids[hub].slice().sort();
      var hp = G.pos[hub];
      if (!hp || !list.length) { continue; }
      var base = repos.length <= 1 ? -Math.PI / 2 : Math.atan2(hp.y - cy, hp.x - cx);
      var span = Math.min(2.8, 0.5 * list.length);
      for (i = 0; i < list.length; i++) {
        if (G.pos[list[i]]) { continue; }
        var t2 = list.length === 1 ? 0 : i / (list.length - 1) - 0.5;
        var ang = base + t2 * span;
        var d = 106 + (i % 3) * 26;
        G.pos[list[i]] = { x: hp.x + Math.cos(ang) * d, y: hp.y + Math.sin(ang) * d * 0.82 };
      }
    }
    var seen = {};
    var rest = [];
    for (i = 0; i < nodes.length; i++) { seen[nodes[i].id] = 1; }
    for (i = 0; i < orphans.length; i++) { if (!rest_has(rest, orphans[i])) { rest.push(orphans[i]); } }
    for (var id in seen) {
      if (!G.pos[id] && !rest_has(rest, id)) { rest.push(id); }
    }
    for (i = 0; i < rest.length; i++) {
      if (G.pos[rest[i]]) { continue; }
      var ga = i * 2.39996323;
      var rr = 130 + Math.sqrt(i + 1) * 74;
      G.pos[rest[i]] = { x: clamp(cx + Math.cos(ga) * rr, 50, VIEW_W - 50), y: clamp(cy + Math.sin(ga) * rr * 0.8, 44, VIEW_H - 44) };
    }
  }
  function rest_has(list, id) { for (var i = 0; i < list.length; i++) { if (list[i] === id) { return true; } } return false; }

  function relax(steps) {
    var nodes = visibleNodes(), edges = visibleEdges();
    var ids = [], i, j, it, move = 0;
    for (i = 0; i < nodes.length; i++) { if (G.pos[nodes[i].id]) { ids.push(nodes[i].id); } }
    for (it = 0; it < steps; it++) {
      var dx = {}, dy = {};
      for (i = 0; i < ids.length; i++) { dx[ids[i]] = 0; dy[ids[i]] = 0; }
      for (i = 0; i < ids.length; i++) {
        for (j = i + 1; j < ids.length; j++) {
          var a = G.pos[ids[i]], b = G.pos[ids[j]];
          var ddx = b.x - a.x, ddy = b.y - a.y;
          var d = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01;
          if (d < 188) {
            var f = ((188 - d) / 188) * 1.9;
            dx[ids[i]] -= (ddx / d) * f; dy[ids[i]] -= (ddy / d) * f;
            dx[ids[j]] += (ddx / d) * f; dy[ids[j]] += (ddy / d) * f;
          }
        }
      }
      for (i = 0; i < edges.length; i++) {
        var e = edges[i], pa = G.pos[e.source], pb = G.pos[e.target];
        if (!pa || !pb) { continue; }
        var ex = pb.x - pa.x, ey = pb.y - pa.y;
        var ed = Math.sqrt(ex * ex + ey * ey) || 0.01;
        var ef = (ed - 132) * 0.045;
        dx[e.source] += (ex / ed) * ef; dy[e.source] += (ey / ed) * ef;
        dx[e.target] -= (ex / ed) * ef; dy[e.target] -= (ey / ed) * ef;
      }
      move = 0;
      for (i = 0; i < ids.length; i++) {
        var p = G.pos[ids[i]];
        if (G.pin[ids[i]]) { continue; }
        var ox = clamp(dx[ids[i]], -9, 9), oy = clamp(dy[ids[i]], -9, 9);
        p.x = clamp(p.x + ox, 52, VIEW_W - 52);
        p.y = clamp(p.y + oy, 46, VIEW_H - 46);
        var m = Math.abs(ox) + Math.abs(oy);
        if (m > move) { move = m; }
      }
      if (move < 0.45) { break; }
    }
    G.energy = move;
  }

  function mountGraph() {
    var host = byId('graph');
    if (!host || G.svg) { return; }
    clear(host); // drop the loading placeholder before the graph takes over
    host.classList.add('graph');
    var node = svg('svg', {
      viewBox: '0 0 ' + VIEW_W + ' ' + VIEW_H, width: '100%', height: VIEW_H,
      role: 'group', 'aria-label': 'Memory graph: repositories with their facts, knowledge and handoffs'
    });
    G.svg = node;
    G.hitBox = svg('rect', { class: 'hit', x: '0', y: '0', width: VIEW_W, height: VIEW_H, fill: 'transparent' });
    G.zoom = svg('g', { class: 'zoom' });
    G.edgesLayer = svg('g', { class: 'edges' });
    G.nodesLayer = svg('g', { class: 'nodes' });
    G.zoom.appendChild(G.edgesLayer);
    G.zoom.appendChild(G.nodesLayer);
    node.appendChild(G.hitBox);
    node.appendChild(G.zoom);
    host.appendChild(node);

    node.addEventListener('pointerdown', function (ev) {
      var id = ev.target && ev.target.__gid;
      if (id && G.pos[id]) { startDrag(ev, id); return; }
      if (ev.target !== G.hitBox) { return; }
      var v = clientToView(ev);
      G.pan = { sx: v.x, sy: v.y, tx: G.tx, ty: G.ty };
      setClass(node, 'is-panning', true);
      if (node.setPointerCapture) { try { node.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } }
    });
    node.addEventListener('pointermove', function (ev) {
      if (G.drag) {
        var v2 = clientToView(ev);
        var p = G.pos[G.drag.id];
        if (p) {
          p.x = clamp((v2.x - G.tx) / G.k, 40, VIEW_W - 40);
          p.y = clamp((v2.y - G.ty) / G.k, 34, VIEW_H - 34);
          draw();
        }
        return;
      }
      if (G.pan) {
        var v3 = clientToView(ev);
        G.tx = G.pan.tx + (v3.x - G.pan.sx);
        G.ty = G.pan.ty + (v3.y - G.pan.sy);
        applyTransform();
      }
    });
    function endPointer(ev) {
      if (G.drag) { G.drag = null; ensureSettled(); }
      if (G.pan) { G.pan = null; setClass(node, 'is-panning', false); }
      if (node.releasePointerCapture) { try { node.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ } }
    }
    node.addEventListener('pointerup', endPointer);
    node.addEventListener('pointercancel', endPointer);
    node.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var v = clientToView(ev);
      zoomAt(v.x, v.y, ev.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });
    node.addEventListener('dblclick', function (ev) { ev.preventDefault(); fitView(); });
  }

  function createNode(n) {
    var g = svg('g', { class: 'ngroup' });
    var r = radiusOf(n);
    var circle = svg('circle', {
      r: r, class: 'node', tabindex: '-1', role: 'img',
      fill: KIND_COLOR[n.kind] || 'var(--fg-muted)',
      stroke: 'var(--surface)', 'stroke-width': '2',
      'aria-label': n.kind + ': ' + n.label
    });
    circle.__gid = n.id;
    var label = svg('text', { class: 'nlabel' + (n.kind === 'repo' ? ' is-repo' : '') });
    g.appendChild(circle);
    g.appendChild(label);
    G.nodesLayer.appendChild(g);
    circle.addEventListener('pointerenter', function () { G.hover = n.id; paintFocus(); });
    circle.addEventListener('pointerleave', function () { G.hover = null; paintFocus(); });
    circle.addEventListener('click', function () { select(n.id); });
    circle.addEventListener('focus', function () { select(n.id); });
    return { g: g, circle: circle, label: label, r: r, kind: n.kind, label0: n.label, sub: n.sub || '' };
  }
  function syncDom() {
    var i, id;
    var visible = visibleNodes(), on = {};
    for (i = 0; i < visible.length; i++) { on[visible[i].id] = 1; }
    for (i = 0; i < G.data.nodes.length; i++) {
      var n = G.data.nodes[i];
      var item = G.items[n.id];
      if (!item) {
        if (!on[n.id]) { continue; }
        item = createNode(n);
        G.items[n.id] = item;
      }
      setClass(item.g, 'is-off', !on[n.id]);
      var full = n.sub ? n.label + ' — ' + n.sub : n.label;
      if (item.full !== full) {
        item.full = full;
        item.sub = n.sub || '';
        item.label0 = n.label;
        item.circle.setAttribute('aria-label', n.kind + ': ' + n.label);
        item.label.textContent = shortLabel(n.label);
      }
      item.r = radiusOf(n);
      setClass(item.circle, 'pinned', !!G.pin[n.id]);
    }
    for (id in G.items) {
      if (!G.byId[id]) { removeNode(id); }
    }
    var edges = visibleEdges();
    for (i = 0; i < G.edgeEls.length; i++) {
      if (G.edgeEls[i].parentNode) { G.edgeEls[i].parentNode.removeChild(G.edgeEls[i]); }
    }
    G.edgeEls = [];
    for (i = 0; i < edges.length; i++) {
      var e = edges[i];
      var child = G.byId[e.target] || G.byId[e.source];
      var line = svg('line', {
        class: 'edge', stroke: KIND_COLOR[child ? child.kind : 'fact'] || 'var(--border-strong)',
        'stroke-width': '1.2', 'stroke-opacity': '.34'
      });
      line.__s = e.source;
      line.__t = e.target;
      G.edgesLayer.appendChild(line);
      G.edgeEls.push(line);
    }
  }
  function removeNode(id) {
    var item = G.items[id];
    if (!item) { return; }
    if (item.g.parentNode) { item.g.parentNode.removeChild(item.g); }
    delete G.items[id];
    delete G.pos[id];
    delete G.pin[id];
  }

  function setClassForEdge(line, on) { setClass(line, 'is-on', on); }
  function paintFocus() {
    var active = G.sel || G.hover;
    var on = {}, i;
    if (active && G.adj[active]) {
      on[active] = 1;
      for (i = 0; i < G.adj[active].length; i++) { on[G.adj[active][i].id] = 1; }
    }
    var id;
    for (id in G.items) {
      var item = G.items[id];
      setClass(item.circle, 'is-on', !!on[id]);
      var show = item.kind === 'repo' || !!on[id] || (!active && !!G.labels[id]);
      item.label.style.display = show ? '' : 'none';
      setClass(item.label, 'is-on', !!on[id] && id !== active);
    }
    for (i = 0; i < G.edgeEls.length; i++) {
      var line = G.edgeEls[i];
      setClassForEdge(line, !!active && (line.__s === active || line.__t === active));
    }
    setClass(G.svg, 'is-dim', !!active);
    updateTabindex();
  }
  function updateTabindex() {
    var first = null, id;
    for (id in G.items) { if (first === null || id < first) { first = id; } }
    var target = G.sel || first;
    for (id in G.items) {
      var want = id === target ? '0' : '-1';
      if (G.items[id].circle.getAttribute('tabindex') !== want) { G.items[id].circle.setAttribute('tabindex', want); }
    }
  }

  function describe(id) {
    var n = G.byId[id];
    var live = byId('graph-live');
    if (live) {
      live.textContent = n ? ('Selected ' + n.kind + ' ' + n.label + ', ' + degree(id) + ' links') : 'Selection cleared';
    }
    renderDetail(n || null);
  }
  /* The whole stored payload of a node, untruncated: a repo's path, a fact's
     key and value, a knowledge entry's title and body, a handoff's goal and
     note counts. This is also what the copy button hands to the clipboard. */
  function nodeText(n) {
    if (n.kind === 'repo') { return n.repo || n.sub || n.label; }
    if (!n.sub) { return n.label; }
    if (n.kind === 'fact') { return n.label + ' = ' + n.sub; }
    return n.label + '\\n' + n.sub;
  }
  function metaRow(label, value) {
    var row = el('div', 'detail__meta');
    row.appendChild(el('span', 'detail__mk', label));
    row.appendChild(el('span', 'detail__mv', value));
    return row;
  }
  function renderDetail(n) {
    var host = byId('graph-detail');
    if (!host) { return; }
    clear(host);
    if (!n) { host.hidden = true; return; }
    host.hidden = false;
    var head = el('div', 'detail__head');
    var chip = el('span', 'chip chip--static');
    var dot = el('span', 'chip__dot');
    dot.style.background = KIND_COLOR[n.kind] || 'var(--fg-muted)';
    chip.appendChild(dot);
    chip.appendChild(el('span', null, n.kind));
    head.appendChild(chip);
    head.appendChild(el('h3', null, n.label));
    var centre = el('button', 'btn btn--ghost', 'Centre on this node');
    centre.type = 'button';
    centre.addEventListener('click', function () { centreOn(n.id); });
    head.appendChild(centre);
    host.appendChild(head);

    var meta = el('div', 'detail__meta-grid');
    meta.appendChild(metaRow('Kind', n.kind));
    meta.appendChild(metaRow('Repo', n.repo || 'not pinned to a repo'));
    host.appendChild(meta);

    var text = nodeText(n);
    var row = el('div', 'detail__row');
    row.appendChild(el('p', 'card__k', 'Full text'));
    row.appendChild(copyButton(text));
    host.appendChild(row);
    host.appendChild(el('p', 'detail__text', text));

    var links = G.adj[n.id] || [];
    host.appendChild(el('p', 'card__k', 'Links (' + links.length + ')'));
    if (!links.length) {
      host.appendChild(el('p', 'hint', 'No stored relation points at this node.'));
      return;
    }
    var ul = el('ul', 'list');
    links.slice(0, 12).forEach(function (link) {
      var other = G.byId[link.id];
      var li = el('li');
      li.appendChild(el('span', 'repo', link.label));
      li.appendChild(el('span', 'val', other ? other.label : link.id));
      if (other) {
        var go = el('button', 'btn copy', 'show');
        go.type = 'button';
        go.addEventListener('click', function () { select(other.id); centreOn(other.id); });
        li.appendChild(go);
      }
      ul.appendChild(li);
    });
    host.appendChild(ul);
  }
  function select(id) {
    G.sel = id;
    paintFocus();
    describe(id);
    if (G.items[id] && document.activeElement !== G.items[id].circle) {
      try { G.items[id].circle.focus(); } catch (e) { /* ignore */ }
    }
  }
  function centreOn(id) {
    var p = G.pos[id];
    if (!p) { return; }
    G.k = clamp(G.k, 0.9, 2.6);
    G.tx = VIEW_W / 2 - p.x * G.k;
    G.ty = VIEW_H / 2 - p.y * G.k;
    applyTransform();
  }

  function applyTransform() {
    if (!G.zoom) { return; }
    G.zoom.setAttribute('transform', 'translate(' + G.tx.toFixed(2) + ' ' + G.ty.toFixed(2) + ') scale(' + G.k.toFixed(3) + ')');
  }
  function clientToView(ev) {
    var r = G.svg.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (VIEW_W / r.width), y: (ev.clientY - r.top) * (VIEW_H / r.height) };
  }
  function zoomAt(vx, vy, factor) {
    var k2 = clamp(G.k * factor, 0.55, 2.6);
    if (k2 === G.k) { return; }
    var wx = (vx - G.tx) / G.k, wy = (vy - G.ty) / G.k;
    G.k = k2;
    G.tx = vx - wx * k2;
    G.ty = vy - wy * k2;
    applyTransform();
  }
  function fitView() {
    var nodes = visibleNodes(), i, box = null;
    for (i = 0; i < nodes.length; i++) {
      var p = G.pos[nodes[i].id];
      if (!p) { continue; }
      if (!box) { box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }; continue; }
      box.x0 = Math.min(box.x0, p.x); box.y0 = Math.min(box.y0, p.y);
      box.x1 = Math.max(box.x1, p.x); box.y1 = Math.max(box.y1, p.y);
    }
    if (!box) { G.k = 1; G.tx = 0; G.ty = 0; applyTransform(); return; }
    var pad = 70;
    var w = Math.max(1, box.x1 - box.x0) + pad * 2;
    var h = Math.max(1, box.y1 - box.y0) + pad * 2;
    G.k = clamp(Math.min(VIEW_W / w, VIEW_H / h), 0.6, 1.6);
    G.tx = VIEW_W / 2 - ((box.x0 + box.x1) / 2) * G.k;
    G.ty = VIEW_H / 2 - ((box.y0 + box.y1) / 2) * G.k;
    applyTransform();
  }

  function draw() {
    var i, id, p;
    for (i = 0; i < G.edgeEls.length; i++) {
      var e = G.edgeEls[i];
      var a = G.pos[e.__s], b = G.pos[e.__t];
      if (!a || !b) { continue; }
      e.setAttribute('x1', a.x.toFixed(1)); e.setAttribute('y1', a.y.toFixed(1));
      e.setAttribute('x2', b.x.toFixed(1)); e.setAttribute('y2', b.y.toFixed(1));
    }
    for (id in G.items) {
      p = G.pos[id];
      if (!p) { continue; }
      var item = G.items[id];
      item.circle.setAttribute('cx', p.x.toFixed(1));
      item.circle.setAttribute('cy', p.y.toFixed(1));
      item.label.setAttribute('x', p.x.toFixed(1));
      item.label.setAttribute('y', (p.y + item.r + 13).toFixed(1));
    }
  }
  function startDrag(ev, id) {
    var v = clientToView(ev);
    var p = G.pos[id];
    if (!p) { return; }
    G.drag = { id: id, ox: p.x - (v.x - G.tx) / G.k, oy: p.y - (v.y - G.ty) / G.k };
    G.pin[id] = 1;
    setClass(G.items[id] ? G.items[id].circle : null, 'pinned', true);
    if (G.svg.setPointerCapture) { try { G.svg.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ } }
  }
  /* Exactly one animation loop exists, and it stops once the layout settles.
     The previous implementation created a fresh handle inside render(), so the
     old loop was never cancelled. */
  function startLoop() {
    if (G.raf || reducedMotion()) { return; }
    var step = function () {
      relax(14);
      draw();
      if (G.energy < 0.5) { G.raf = 0; G.settled = true; return; }
      G.raf = requestAnimationFrame(step);
    };
    G.settled = false;
    G.raf = requestAnimationFrame(step);
  }
  function stopLoop() {
    if (G.raf) { cancelAnimationFrame(G.raf); G.raf = 0; }
  }
  function ensureSettled() {
    if (reducedMotion()) { relax(260); draw(); G.settled = true; return; }
    startLoop();
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopLoop(); }
    else if (!G.list && G.svg && !G.settled) { startLoop(); }
  });

  function updateCount() {
    var badge = byId('graph-count');
    if (!badge) { return; }
    var shown = visibleNodes().length;
    var hidden = G.data.nodes.length - shown;
    badge.textContent = shown + ' nodes · ' + visibleEdges().length + ' links' + (hidden ? ' · ' + hidden + ' filtered out' : '');
  }
  function graphUnavailable() {
    if (G.svg || G.list) { return; } // never clobber something already rendered
    var host = byId('graph');
    if (host) {
      clear(host);
      host.appendChild(el('p', 'empty', 'Graph unavailable — the server did not return the graph projection.'));
    }
  }
  function graphEmpty() {
    var host = byId('graph');
    if (!host) { return; }
    clear(host);
    G.svg = null; G.zoom = null; G.nodesLayer = null; G.edgesLayer = null; G.hitBox = null;
    G.items = {}; G.edgeEls = []; G.pos = {}; G.sel = null; G.hover = null;
    renderDetail(null);
    host.appendChild(el('p', 'empty', 'Nothing to draw yet — index a repo, pin a fact or save a handoff and it appears here.'));
  }
  function refreshGraph(force) {
    if (G.list) { renderGraphList(); updateCount(); return; }
    if (!G.data.nodes.length) { graphEmpty(); updateCount(); return; }
    buildMaps();
    computeLabels();
    if (force) {
      for (var id in G.pos) { if (!G.pin[id]) { delete G.pos[id]; } }
    }
    syncDom();
    seatMissing();
    draw();
    ensureSettled();
    paintFocus();
    updateCount();
  }
  function updateGraph(data) {
    G.data = { nodes: data.nodes || [], edges: data.edges || [] };
    if (G.list) { renderGraphList(); updateCount(); return; }
    mountGraph();
    if (!G.svg) { return; }
    var sig = signature();
    if (sig === G.sig) { updateCount(); return; } // unchanged: leave the view exactly as it is
    G.sig = sig;
    refreshGraph(false);
  }
  function signature() {
    var parts = [], i;
    for (i = 0; i < G.data.nodes.length; i++) {
      var n = G.data.nodes[i];
      parts.push(n.id + '|' + n.kind + '|' + n.label + '|' + (n.sub || ''));
    }
    parts.push('--');
    for (i = 0; i < G.data.edges.length; i++) {
      var e = G.data.edges[i];
      parts.push(e.source + '>' + e.target + ':' + e.label);
    }
    parts.push('--' + KINDS.filter(function (k) { return G.off[k]; }).join(','));
    return parts.join(';');
  }

  function renderGraphList() {
    var host = byId('graph');
    if (!host) { return; }
    clear(host);
    var nodes = visibleNodes();
    var wrap = el('div', 'scroll');
    var table = el('table', 'table');
    table.appendChild(el('caption', 'sr-only', 'Knowledge graph nodes'));
    var thead = el('thead'), tr = el('tr');
    var heads = ['Node', 'Kind', 'Repository', 'Links'];
    for (var i = 0; i < heads.length; i++) {
      var th = el('th', null, heads[i]);
      th.setAttribute('scope', 'col');
      if (i === 3) { th.className = 'num'; }
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
    var tbody = el('tbody');
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i], row = el('tr');
      row.appendChild(el('td', null, n.label));
      row.appendChild(el('td', null, n.kind));
      row.appendChild(el('td', 'mono', n.sub || '—'));
      row.appendChild(el('td', 'num', degree(n.id)));
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    host.appendChild(wrap);
    host.appendChild(el('p', 'hint', nodes.length + ' nodes · ' + visibleEdges().length + ' links'));
  }
  function setGraphList(on) {
    G.list = on;
    var btn = byId('graph-view');
    if (btn) { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); btn.textContent = on ? 'Graph view' : 'List view'; }
    renderDetail(null);
    if (on) {
      stopLoop();
      G.svg = null; G.zoom = null; G.nodesLayer = null; G.edgesLayer = null; G.hitBox = null;
      G.items = {}; G.edgeEls = [];
      G.sel = null; G.hover = null;
      renderGraphList();
      updateCount();
    } else {
      G.sig = '';
      refreshGraph(false);
    }
  }
  function toggleKind(kind, btn) {
    G.off[kind] = !G.off[kind];
    btn.setAttribute('aria-pressed', G.off[kind] ? 'false' : 'true');
    G.sel = null;
    G.hover = null;
    G.sig = signature();
    renderDetail(null);
    refreshGraph(true);
  }
  function buildKindFilters() {
    var host = byId('graph-kinds');
    if (!host) { return; }
    clear(host);
    KINDS.forEach(function (kind) {
      var b = el('button', 'chip');
      b.type = 'button';
      b.setAttribute('aria-pressed', 'true');
      var dot = el('span', 'chip__dot');
      dot.style.background = KIND_COLOR[kind];
      b.appendChild(dot);
      b.appendChild(el('span', null, KIND_LABEL[kind]));
      b.addEventListener('click', function () { toggleKind(kind, b); });
      host.appendChild(b);
    });
  }
  function moveSelection(key) {
    var nodes = visibleNodes();
    if (!nodes.length) { return; }
    var cur = G.sel && G.pos[G.sel] ? G.pos[G.sel] : null;
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var id = nodes[i].id;
      if (id === G.sel) { continue; }
      var p = G.pos[id];
      if (!p) { continue; }
      var dx = p.x - (cur ? cur.x : VIEW_W / 2), dy = p.y - (cur ? cur.y : VIEW_H / 2);
      var primary = key === 'ArrowLeft' ? -dx : key === 'ArrowRight' ? dx : key === 'ArrowUp' ? -dy : dy;
      if (primary <= 6) { continue; }
      var secondary = (key === 'ArrowLeft' || key === 'ArrowRight') ? Math.abs(dy) : Math.abs(dx);
      var score = primary - secondary * 1.6;
      if (score > bestScore) { bestScore = score; best = id; }
    }
    if (!best) { best = nodes[0].id === G.sel && nodes.length > 1 ? nodes[1].id : nodes[0].id; }
    select(best);
    var p2 = G.pos[best];
    if (p2 && (p2.x < 60 || p2.x > VIEW_W - 60 || p2.y < 50 || p2.y > VIEW_H - 50)) { centreOn(best); }
  }
  function graphKey(ev) {
    var k = ev.key;
    if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'ArrowLeft' || k === 'ArrowRight') { ev.preventDefault(); moveSelection(k); return; }
    if (k === 'Enter') { ev.preventDefault(); if (G.sel) { describe(G.sel); } return; }
    if (k === 'Escape') { G.sel = null; renderDetail(null); paintFocus(); return; }
    if (k === '+' || k === '=') { ev.preventDefault(); zoomAt(VIEW_W / 2, VIEW_H / 2, 1.15); return; }
    if (k === '-') { ev.preventDefault(); zoomAt(VIEW_W / 2, VIEW_H / 2, 1 / 1.15); return; }
    if (k === '0') { ev.preventDefault(); fitView(); }
  }
  function resetView() { G.k = 1; G.tx = 0; G.ty = 0; applyTransform(); }

  // ---------------------------------------------------------------- repos
  function renderRepos(repos) {
    var host = byId('repos');
    var badge = byId('repos-count');
    if (badge) { badge.textContent = repos.length ? repos.length + ' repos' : ''; }
    section(host, JSON.stringify(repos), function (host) {
      if (!repos.length) {
        host.appendChild(el('p', 'empty', 'Nothing indexed yet — run “aegisxmemory index .” inside a project.'));
        return;
      }
      var wrap = el('div', 'scroll');
      var table = el('table', 'table');
      table.appendChild(el('caption', 'sr-only', 'Memory per repository'));
      var thead = el('thead'), head = el('tr');
      var heads = ['Repository', 'Files', 'Symbols', 'Scans', 'Recalls', 'Hit rate'];
      for (var i = 0; i < heads.length; i++) {
        var th = el('th', null, heads[i]);
        th.setAttribute('scope', 'col');
        if (i > 0) { th.className = 'num'; }
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
      wrap.appendChild(table);
      host.appendChild(wrap);
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
  /* Shared by every copy control, generated or not. The payload is resolved at click
     time, which is what lets the readout's button follow whichever bar is current. */
  function wireCopy(btn, payload) {
    btn.type = 'button';
    btn.addEventListener('click', function () {
      var text = typeof payload === 'function' ? payload() : payload;
      function done() {
        btn.textContent = 'copied';
        btn.setAttribute('data-state', 'copied');
        setTimeout(function () { btn.textContent = 'copy'; btn.removeAttribute('data-state'); }, 1600);
      }
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
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else { fallback(); }
    });
    return btn;
  }
  function copyButton(text) {
    return wireCopy(el('button', 'btn copy', 'copy'), text);
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
    var badge = byId('facts-count');
    var filter = STATE.filter.trim().toLowerCase();
    var rows = STATE.facts.filter(function (f) {
      if (!filter) { return true; }
      return (f.key + ' ' + f.value + ' ' + (f.repoHint || '')).toLowerCase().indexOf(filter) >= 0;
    });
    if (badge) { badge.textContent = STATE.facts.length ? rows.length + ' of ' + STATE.facts.length + ' pinned' : ''; }
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
      var p = el('div', 'panel');
      p.appendChild(wrapper);
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
    var badge = byId('sessions-count');
    if (badge) { badge.textContent = sessions.length ? sessions.length + ' handoffs' : ''; }
    section(byId('sessions'), JSON.stringify(sessions), function (host) {
      if (!sessions.length) {
        host.appendChild(el('p', 'empty', 'No handoffs yet — end agent sessions with “save the session handoff”.'));
        return;
      }
      var p = el('div', 'panel');
      p.appendChild(sessionList(sessions));
      host.appendChild(p);
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
      for (var i = 0; i < 6; i++) { cards.appendChild(el('p', 'skeleton', ' ')); }
    }
    ['chart', 'graph', 'facts', 'sessions'].forEach(function (id) {
      var node = byId(id);
      if (node && !node.childElementCount) { node.appendChild(el('p', 'skeleton', 'Loading…')); }
    });
  }

  // ---------------------------------------------------------------- poll
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
    var zoomIn = byId('graph-in');
    if (zoomIn) { zoomIn.addEventListener('click', function () { zoomAt(VIEW_W / 2, VIEW_H / 2, 1.18); }); }
    var zoomOut = byId('graph-out');
    if (zoomOut) { zoomOut.addEventListener('click', function () { zoomAt(VIEW_W / 2, VIEW_H / 2, 1 / 1.18); }); }
    var fit = byId('graph-fit');
    if (fit) { fit.addEventListener('click', fitView); }
    var panel = byId('graph');
    if (panel) {
      panel.addEventListener('keydown', graphKey);
      panel.addEventListener('dblclick', function (ev) {
        if (ev.target === panel) { resetView(); }
      });
    }
    var chart = byId('chart');
    if (chart) { chart.addEventListener('keydown', chartKey); }
    var zoomBtn = byId('chart-zoom');
    if (zoomBtn) {
      zoomBtn.addEventListener('click', function () {
        CHART.wide = !CHART.wide;
        saveWide(CHART.wide);
        renderChart(STATE.recalls);
        // Widening the canvas can push the bar the reader was on past the edge.
        keepBarInView(CHART.bars[CHART.active]);
      });
    }
    var capSel = byId('chart-cap');
    if (capSel) {
      capSel.value = String(CHART.cap);
      capSel.addEventListener('change', function () {
        CHART.cap = capFromValue(capSel.value);
        saveCap(CHART.cap);
        renderChart(STATE.recalls);
      });
    }
    var copyBtn = byId('chart-copy');
    if (copyBtn) {
      wireCopy(copyBtn, function () {
        var readout = byId('chart-readout');
        return readout ? readout.textContent : '';
      });
    }
    commitReadout(READOUT_HINT);
    buildKindFilters();

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
