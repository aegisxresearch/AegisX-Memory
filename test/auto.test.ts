import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectInstalledAgents } from '../src/cli/auto-setup.js';
import { hermesHookScripts, hermesHooksInstalled, installHermesHooks } from '../src/cli/hermes-hooks.js';
import { autoStatePath, autoStatus, isAutoAlive, readAutoState, reservePort, runAuto, type AutoState } from '../src/cli/auto.js';
import { execFileSync } from 'node:child_process';

let workspace: string;
let prevEnv: Record<string, string | undefined>;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-auto-'));
  prevEnv = {
    HERMES_HOME: process.env['HERMES_HOME'],
    CODEX_HOME: process.env['CODEX_HOME'],
    AEGISX_HOME: process.env['AEGISX_HOME'],
    AEGISX_APP_DIR: process.env['AEGISX_APP_DIR'],
  };
  process.env['AEGISX_HOME'] = path.join(workspace, 'aegisx-home');
  fs.mkdirSync(process.env['AEGISX_HOME'], { recursive: true });
});

afterEach(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('detectInstalledAgents', () => {
  it('reports an agent installed only when its config file exists', () => {
    const hermesDir = path.join(workspace, '.hermes');
    fs.mkdirSync(hermesDir, { recursive: true });
    fs.writeFileSync(path.join(hermesDir, 'config.yaml'), 'model: {}\n');
    process.env['HERMES_HOME'] = hermesDir;

    const probes = detectInstalledAgents();
    const hermes = probes.find((p) => p.agent === 'hermes');
    const codex = probes.find((p) => p.agent === 'codex');
    expect(hermes?.installed).toBe(true);
    expect(hermes?.configPath).toBe(path.join(hermesDir, 'config.yaml'));
    expect(codex?.installed).toBe(false);
  });

  it('anchors the vscode probe to the given project directory, not cwd', () => {
    const project = path.join(workspace, 'proj');
    fs.mkdirSync(path.join(project, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(project, '.vscode', 'mcp.json'), '{}');
    const probes = detectInstalledAgents(project);
    expect(probes.find((p) => p.agent === 'vscode')?.installed).toBe(true);
    // No project dir: vscode is repo-scoped and only true if cwd has one.
    const cwdProbes = detectInstalledAgents();
    expect(cwdProbes.find((p) => p.agent === 'vscode')?.configPath).toBe(path.join(process.cwd(), '.vscode', 'mcp.json'));
  });
});

describe('hermes hooks installer', () => {
  it('writes scripts and merges the hooks block into config.yaml', () => {
    const cfg = path.join(workspace, 'config.yaml');
    fs.writeFileSync(cfg, 'model:\n  provider: tokenrouter\n');
    const result = installHermesHooks(cfg, { hooksDir: path.join(workspace, 'agent-hooks'), bin: 'aegisxmemory-fake' });
    expect(result.action).toBe('merged');
    expect(result.backup).toBe(`${cfg}.aegisx-bak`);
    expect(hermesHooksInstalled(cfg)).toBe(true);
    const written = fs.readFileSync(cfg, 'utf8');
    expect(written).toContain('pre_llm_call:');
    expect(written).toContain('pre_verify:');
    expect(written).toContain('aegisx-recall.sh');
    expect(written).toContain('model:'); // unrelated keys preserved
    // Scripts are executable and identify themselves by name + header.
    const script = path.join(workspace, 'agent-hooks', 'aegisx-recall.sh');
    expect(fs.statSync(script).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(script, 'utf8')).toContain('aegisx-memory:pre-llm-call');
  });

  it('is idempotent on a second run (unchanged, same scripts)', () => {
    const cfg = path.join(workspace, 'config.yaml');
    const result1 = installHermesHooks(cfg, { hooksDir: path.join(workspace, 'ah'), bin: 'aegisxmemory-fake' });
    const result2 = installHermesHooks(cfg, { hooksDir: path.join(workspace, 'ah'), bin: 'aegisxmemory-fake' });
    expect(result1.action).toBe('created');
    expect(result2.action).toBe('unchanged');
  });

  it('refuses a non-mapping hooks block instead of clobbering it', () => {
    const cfg = path.join(workspace, 'config.yaml');
    fs.writeFileSync(cfg, 'hooks: just-a-string\n');
    const result = installHermesHooks(cfg, { hooksDir: path.join(workspace, 'ah2') });
    expect(result.action).toBe('error');
    expect(fs.readFileSync(cfg, 'utf8')).toBe('hooks: just-a-string\n');
  });

  it('produces scripts whose exec line carries the real command (no BIN indirection)', () => {
    const [recall, nudge] = hermesHookScripts('aegisxmemory-fake');
    if (recall === undefined || nudge === undefined) throw new Error('expected the recall + save-nudge scripts');
    expect(recall.body).toMatch(/^exec aegisxmemory-fake hook session-start --json --client hermes$/m);
    expect(nudge.body).toMatch(/^exec aegisxmemory-fake hook session-end --json --client hermes$/m);
    expect(recall.body).toContain('cd "${CWD:-$PWD}"');
  });

  it('an idempotent re-install never touches the script mtime (no false drift warning)', () => {
    // Hermes stores script_mtime_at_approval and compares it to the live mtime
    // as an ISO string; rewriting identical bytes would make `hermes hooks
    // doctor` cry "script modified since approval" after a no-op run.
    const dir = path.join(workspace, 'ah-mtime');
    const cfg = path.join(workspace, 'cfg-mtime.yaml');
    installHermesHooks(cfg, { hooksDir: dir, bin: 'aegisxmemory-fake' });
    const script = path.join(dir, 'aegisx-recall.sh');
    // Pin an old mtime, then compare the two reads: `mtimeMs` is a float
    // derived from nanosecond storage, so asserting against a fresh Date would
    // be a precision coin-flip. Identity across the call is the property.
    const pinned = new Date(Date.now() - 60_000);
    fs.utimesSync(script, pinned, pinned);
    const before = fs.statSync(script).mtimeMs;

    const second = installHermesHooks(cfg, { hooksDir: dir, bin: 'aegisxmemory-fake' });
    expect(fs.statSync(script).mtimeMs).toBe(before);
    expect(second.detail).toContain('nothing written');
  });

  it('a changed body is rewritten and reported (the upgrade path)', () => {
    const dir = path.join(workspace, 'ah-upgrade');
    const cfg = path.join(workspace, 'cfg-upgrade.yaml');
    installHermesHooks(cfg, { hooksDir: dir, bin: 'aegisxmemory-old' });
    const script = path.join(dir, 'aegisx-recall.sh');
    expect(fs.readFileSync(script, 'utf8')).toContain('aegisxmemory-old');

    const upgraded = installHermesHooks(cfg, { hooksDir: dir, bin: 'aegisxmemory-new' });
    expect(fs.readFileSync(script, 'utf8')).toContain('aegisxmemory-new');
    expect(upgraded.detail).toContain('scripts refreshed');
  });

  it('scripts speak the Hermes dialect, not Claude\u2019s (the silent no-injection bug)', () => {
    // Hermes' `_parse_context` reads a top-level `context` key and never looks
    // at `hookSpecificOutput`, so a Claude-shaped payload injects nothing while
    // still exiting 0 — memory dies silently. The flag must ride on every exec.
    for (const script of hermesHookScripts('aegisxmemory-fake')) {
      expect(script.body).toContain('--client hermes');
    }
  });

  it('scripts run end-to-end against the built bundle (recall emits SessionStart JSON)', () => {
    // Exercise the actual generated text with sh to catch quoting drift: the
    // regression this guards is the BIN= temp-env trap that made exit 127.
    const [recall] = hermesHookScripts(`node ${JSON.stringify(process.execPath.includes('node') ? path.resolve('dist/cli/index.js') : 'dist/cli/index.js')}`);
    if (recall === undefined) throw new Error('expected the recall script');
    const script = path.join(workspace, 'recall-probe.sh');
    fs.writeFileSync(script, recall.body);
    fs.chmodSync(script, 0o755);
    // The DB is empty here; the hook must still exit 0 and print valid JSON.
    const out = execFileSync('sh', [script], { input: JSON.stringify({ cwd: workspace }), encoding: 'utf8', env: { ...process.env } });
    const parsed = JSON.parse(out) as { context: string };
    expect(typeof parsed.context).toBe('string');
  });
});

describe('auto lifecycle', () => {
  it('reservePort returns a bindable port and skips taken ones', async () => {
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const taken = (server.address() as { port: number }).port;
    const free = await reservePort(taken);
    expect(free).not.toBe(taken);
    server.close();
  });

  it('runAuto starts both daemons, reports URLs, and --down stops them', async () => {
    const projectDir = path.join(workspace, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const report = await runAuto({
      mcpPort: await reservePort(3400),
      dashPort: await reservePort(3500),
      setup: false, // hermetic: no agent config writes in tests
      projectDir,
      homeDir: path.join(workspace, 'home'), // the sweep stays in the workspace
    });
    expect(report.mcpHttp).not.toBeNull();
    expect(report.dashboard).not.toBeNull();
    const state: AutoState | null = readAutoState();
    expect(state).not.toBeNull();
    expect(isAutoAlive(state)).toBe(true);
    expect(autoStatus().running).toBe(true);

    // Health: both ports answer over TCP.
    const net = await import('node:net');
    const probe = (port: number) => new Promise<boolean>((resolve) => {
      const s = net.createConnection({ port, host: '127.0.0.1' });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    expect(await probe(report.mcpHttp!.port)).toBe(true);
    expect(await probe(report.dashboard!.port)).toBe(true);

    // Down: kills the daemons and clears the state file.
    const { autoDown } = await import('../src/cli/auto.js');
    const d = autoDown();
    expect(d.stopped).toBe(true);
    expect(fs.existsSync(autoStatePath())).toBe(false);
    // Give the kernel a beat to release the sockets, then confirm closed.
    await new Promise((r) => setTimeout(r, 300));
    expect(await probe(report.mcpHttp!.port)).toBe(false);
    expect(await probe(report.dashboard!.port)).toBe(false);
    expect(isAutoAlive(state)).toBe(false);
  }, 30_000);

  it('runAuto restart is idempotent: a second run replaces the first daemons', async () => {
    await runAuto({ mcpPort: await reservePort(3600), dashPort: await reservePort(3700), setup: false, homeDir: path.join(workspace, 'home') });
    const report2 = await runAuto({ mcpPort: await reservePort(3600), dashPort: await reservePort(3700), setup: false, homeDir: path.join(workspace, 'home') });
    expect(report2.notes.some((n) => n.includes('stopped 1 daemon(s)') || n.includes('stopped 2 daemon(s)'))).toBe(true);
    expect(report2.mcpHttp).not.toBeNull();
    const { autoDown } = await import('../src/cli/auto.js');
    autoDown();
  }, 30_000);
});
