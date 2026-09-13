/**
 * `aegisxmemory auto` — everything after `install.sh`, in one command.
 *
 * The installer already put the binary on PATH and initialized the memory
 * home; this command finishes onboarding without asking anything when it can
 * help it:
 *
 *   1. wires every agent whose config file exists on this machine (auto-
 *      detection — the user never picks from a menu), installing the MCP
 *      registration, the behavior rules, and the deterministic hooks
 *      (Claude SessionStart/PostToolUse pair, Hermes pre_llm_call/pre_verify
 *      shell hooks) — hooks are what make memory automatic instead of
 *      model-dependent;
 *   2. starts the two long-running surfaces as background daemons so the
 *      user does not have to learn `serve` and `dashboard` exist:
 *        - the MCP HTTP server (localhost-only, bearer-token protected)
 *        - the web dashboard (localhost-only, read-only)
 *   3. health-checks both ports, writes a state file under the memory home,
 *      and prints exactly which URLs are live.
 *
 * Everything it does is idempotent and reversible: `aegisxmemory auto --down`
 * stops the daemons it started; agent wiring is marker-based, so re-running
 * reports `unchanged`; memory data is never touched. `auto --status` prints
 * the live state without changing anything.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aegisxHome } from '../core/paths.js';
import { AegisxError } from '../core/types.js';
import { detectInstalledAgents, type SetupAgent } from './auto-setup.js';
import { defaultServerConfig, selfServerEntry } from './mcp-config.js';
import { claudeSettingsPath, installClaudeHooks, HOOK_SESSION_START_MARKER, HOOK_POST_EDIT_MARKER } from './hooks.js';
import { installHermesHooks } from './hermes-hooks.js';

/** State file: <home>/auto-state.json — the single source of truth for
 *  `status` and `--down`, so a fresh shell can manage what an old one began. */
export function autoStatePath(home?: string): string {
  return path.join(home ?? aegisxHome(), 'auto-state.json');
}

export interface AutoState {
  pid: number;
  startedAt: string;
  cwd: string;
  mcpHttp: { port: number; pid: number } | null;
  dashboard: { port: number; pid: number } | null;
  agents: SetupAgent[];
}

export function readAutoState(home?: string): AutoState | null {
  try {
    const raw = fs.readFileSync(autoStatePath(home), 'utf8');
    const parsed = JSON.parse(raw) as AutoState;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeAutoState(state: AutoState, home?: string): void {
  fs.mkdirSync(home ?? aegisxHome(), { recursive: true });
  fs.writeFileSync(autoStatePath(home), `${JSON.stringify(state, null, 2)}\n`);
}

function removeAutoState(home?: string): void {
  try {
    fs.unlinkSync(autoStatePath(home));
  } catch {
    // already gone — stopping is allowed to be idempotent
  }
}

/** True when at least one daemon pid recorded in the state is still alive AND
 *  is (still) an aegisxmemory process. The orchestrator's own pid is checked
 *  for provenance only — `auto` exits on purpose, so daemon pids are what
 *  liveness means. Pids are recycled by the OS, so the name check is what
 *  keeps `down` from ever signaling an unrelated process. */
export function isAutoAlive(state: AutoState | null, _home?: string): boolean {
  if (state === null) return false;
  const pids: number[] = [];
  if (state.mcpHttp !== null) pids.push(state.mcpHttp.pid);
  if (state.dashboard !== null) pids.push(state.dashboard.pid);
  return pids.length > 0 && pids.some((pid) => daemonPidAlive(pid));
}

function daemonPidAlive(pid: number): boolean {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').toLowerCase();
    return cmdline.includes('aegisxmemory') || cmdline.includes('cli/index.js');
  } catch (err) {
    // No /proc (macOS/BSD): fall back to a zero-signal liveness probe — less
    // strict about pid reuse, but better than declaring live daemons dead.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    return false; // EACCES for our own spawned child would be surprising; treat as dead
  }
}

/* ------------------------------------------------------------------ ports */

/** Resolve a free localhost port: the requested one if the kernel gives it,
 *  otherwise walk up. Binding port 0 then reading the real number is the
 *  only race-free probe; anything else is a TOCTOU in disguise. */
export async function reservePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 50; port++) {
    const taken = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(true));
      probe.once('listening', () => probe.close(() => resolve(false)));
      probe.listen(port, '127.0.0.1');
    });
    if (!taken) return port;
  }
  throw new AegisxError('internal', `no free port in range ${preferred}–${preferred + 49}`);
}

/* --------------------------------------------------------------- spawning */

function cliEntry(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  // Compiled: dist/cli/auto.js → the CLI is the sibling index.js.
  // Source (vitest/tsx): src/cli/auto.ts has no runnable sibling, so fall
  // back to the built bundle — auto always runs the installed build.
  for (const candidate of [path.join(dir, 'index.js'), path.resolve(dir, '../../dist/cli/index.js')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new AegisxError('internal', 'cannot locate the aegisxmemory CLI entry — run `npm run build` first');
}

function spawnDetached(args: string[], outFile: string, env: NodeJS.ProcessEnv): ChildProcess {
  const out = fs.openSync(outFile, 'a');
  const child = spawn(process.execPath, [cliEntry(), ...args], {
    stdio: ['ignore', out, out],
    detached: true,
    env,
  });
  fs.closeSync(out);
  child.unref();
  return child;
}

/** Wait until a localhost port accepts a TCP connection, or fail after the
 *  deadline. A real connect is the health check — no sleep loops, no blind
 *  retries that mask a crashed daemon. */
async function waitUntilListening(port: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    });
    if (open) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

/** Kill a process tree by pid (the daemon's own group), only when the cmdline
 *  still names an aegisxmemory entrypoint — pid reuse must never be signaled.
 *  The match is case-insensitive because the checkout path is `AegisX-Memory`. */
function killDaemon(pid: number): boolean {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').toLowerCase();
    if (!cmdline.includes('aegisxmemory') && !cmdline.includes('cli/index.js')) return false;
  } catch {
    return false; // already dead, or a platform without /proc: nothing to do
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------- auto */

export interface AutoOptions {
  mcpPort: number;
  dashPort: number;
  /** Skip agent wiring (`auto --no-setup`) for environments that manage
   *  configs themselves (dotfiles repos, CI images). */
  setup: boolean;
  projectDir?: string;
  /** Env for the spawned daemons (tests pass a sandboxed AEGISX_HOME). */
  env?: NodeJS.ProcessEnv;
  /** Home the leftover-backup sweep runs under (tests pass a sandbox). */
  homeDir?: string;
  /** Injectable seams (tests): pretend agents are installed without touching
   *  real home directories. */
  detected?: SetupAgent[];
}

export interface AutoReport {
  agents: SetupAgent[];
  mcpHttp: { port: number; url: string } | null;
  dashboard: { port: number; url: string } | null;
  notes: string[];
}

/** The full automatic onboarding. See the module doc for the contract. */
export async function runAuto(opts: AutoOptions): Promise<AutoReport> {
  const notes: string[] = [];

  // Same sweep as `setup`: a backup left behind by an uninstall can never be
  // restored, and it keeps a directory alive that reads as an installed agent.
  const { sweepOrphanedBackups, describeSweep } = await import('./auto-setup.js');
  const sweepLine = describeSweep(sweepOrphanedBackups({ projectDir: opts.projectDir, homeDir: opts.homeDir }));
  if (sweepLine !== null) notes.push(sweepLine);

  /* 1 — wire the agents that exist on this machine. */
  const probes = opts.detected !== undefined
    ? detectInstalledAgents(opts.projectDir).map((p) => ({ ...p, installed: opts.detected?.includes(p.agent) ?? false }))
    : detectInstalledAgents(opts.projectDir);
  const agents = probes.filter((p) => p.installed).map((p) => p.agent);
  if (opts.setup && agents.length > 0) {
    const { installForAgent, installRulesForAgent, installProjectRules, describeResult, describeRulesResult, describeProjectRulesResult } = await import('./auto-setup.js');
    const cfg = defaultServerConfig();
    for (const agent of agents) {
      process.stdout.write(describeResult(installForAgent(agent, { config: cfg })) + '\n');
      process.stdout.write(describeRulesResult(installRulesForAgent(agent, {})) + '\n');
      if (agent === 'hermes') {
        const { describeHookInstall } = await import('./hooks.js');
        const { configPathFor } = await import('./auto-setup.js');
        process.stdout.write(describeHookInstall(installHermesHooks(configPathFor('hermes'))) + '\n');
      }
    }
    // Repo-scoped artifacts: the AGENTS.md fallback + Claude project hooks —
    // only inside a real project, never scattered into $HOME.
    const inHome = opts.projectDir !== undefined && path.resolve(opts.projectDir) === path.resolve(os.homedir());
    if (opts.projectDir !== undefined && !inHome) {
      process.stdout.write(describeProjectRulesResult(installProjectRules(opts.projectDir)) + '\n');
      if (agents.includes('claude')) {
        const { describeHookInstall } = await import('./hooks.js');
        process.stdout.write(describeHookInstall(installClaudeHooks(claudeSettingsPath(true, opts.projectDir))) + '\n');
      }
    }
  } else if (!opts.setup) {
    notes.push('agent wiring skipped (--no-setup)');
  } else {
    notes.push('no agent config detected — none wired; run `aegisxmemory setup` to pick manually');
  }

  /* 2 — stop any previous auto daemons (idempotent restarts). */
  const prev = readAutoState();
  let stopped = 0;
  if (prev !== null) {
    if (prev.mcpHttp !== null && killDaemon(prev.mcpHttp.pid)) stopped++;
    if (prev.dashboard !== null && killDaemon(prev.dashboard.pid)) stopped++;
    removeAutoState();
  }
  if (stopped > 0) notes.push(`stopped ${stopped} daemon(s) from a previous auto run`);

  /* 3 — start the MCP HTTP server, then the dashboard, as detached daemons. */
  const home = aegisxHome();
  const logDir = path.join(home, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const env = { ...process.env, ...(opts.env ?? {}) };

  const mcpPort = await reservePort(opts.mcpPort);
  const mcpArgs = ['serve', '--port', String(mcpPort), '--host', '127.0.0.1'];
  // Localhost-only still gets a token when the environment provides one:
  // other local users must not read the memory over HTTP.
  const token = env['AEGISX_TOKEN'];
  if (token !== undefined && token.trim() !== '') mcpArgs.push('--token', token);
  const mcpChild = spawnDetached(mcpArgs, path.join(logDir, 'serve.log'), env);
  const mcpUp = await waitUntilListening(mcpPort, 15_000);

  const dashPort = await reservePort(opts.dashPort);
  const dashChild = spawnDetached(['dashboard', '--port', String(dashPort), '--no-open'], path.join(logDir, 'dashboard.log'), env);
  const dashUp = await waitUntilListening(dashPort, 15_000);

  const state: AutoState = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    mcpHttp: mcpUp ? { port: mcpPort, pid: mcpChild.pid ?? 0 } : null,
    dashboard: dashUp ? { port: dashPort, pid: dashChild.pid ?? 0 } : null,
    agents,
  };
  writeAutoState(state);

  if (!mcpUp) notes.push(`MCP HTTP server did not open port ${mcpPort} within 15s — see ${path.join(logDir, 'serve.log')}`);
  if (!dashUp) notes.push(`dashboard did not open port ${dashPort} within 15s — see ${path.join(logDir, 'dashboard.log')}`);

  return {
    agents,
    mcpHttp: mcpUp ? { port: mcpPort, url: `http://127.0.0.1:${mcpPort}/mcp` } : null,
    dashboard: dashUp ? { port: dashPort, url: `http://127.0.0.1:${dashPort}` } : null,
    notes,
  };
}

/** `auto --status`: read the state, verify liveness, report. Read-only. */
export function autoStatus(): { running: boolean; state: AutoState | null; detail: string } {
  const state = readAutoState();
  if (state === null) {
    return { running: false, state: null, detail: 'not running — start with: aegisxmemory auto' };
  }
  if (!isAutoAlive(state)) {
    return { running: false, state, detail: `stale state from ${state.startedAt} (pid ${state.pid} is gone) — restart with: aegisxmemory auto` };
  }
  const parts: string[] = [`running since ${state.startedAt} (pid ${state.pid})`];
  if (state.mcpHttp !== null) parts.push(`MCP HTTP: http://127.0.0.1:${state.mcpHttp.port}/mcp`);
  else parts.push('MCP HTTP: down');
  if (state.dashboard !== null) parts.push(`dashboard: http://127.0.0.1:${state.dashboard.port}`);
  else parts.push('dashboard: down');
  if (state.agents.length > 0) parts.push(`agents wired: ${state.agents.join(', ')}`);
  return { running: true, state, detail: parts.join(' · ') };
}

/** `auto --down`: stop the daemons recorded in the state file. */
export function autoDown(): { stopped: boolean; detail: string } {
  const state = readAutoState();
  if (state === null) {
    return { stopped: false, detail: 'not running (no state file) — nothing to stop' };
  }
  let any = false;
  if (state.mcpHttp !== null && killDaemon(state.mcpHttp.pid)) any = true;
  if (state.dashboard !== null && killDaemon(state.dashboard.pid)) any = true;
  // The parent `auto` process itself exited long ago (it is a short-lived
  // orchestrator); the daemons were detached with their own group ids.
  removeAutoState();
  return { stopped: any, detail: any ? 'daemons stopped; agent wiring kept (undo with `aegisxmemory uninstall --agent all`)' : 'daemons were already gone; state cleared' };
}

/** Re-export so the CLI banner can point at the markers without importing
 *  hooks.js twice in different call sites. */
export { HOOK_SESSION_START_MARKER, HOOK_POST_EDIT_MARKER };

/** The entry path the daemons run (`node <entry> serve|dashboard`), exported
 *  for tests to assert against. */
export function autoDaemonEntry(): string {
  return selfServerEntry();
}
