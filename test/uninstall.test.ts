import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { installClaudeHooks } from '../src/cli/hooks.js';
import { installHermesHooks } from '../src/cli/hermes-hooks.js';
import { installForAgent, installProjectRules, installRulesForAgent } from '../src/cli/auto-setup.js';
import {
  runUninstall,
  uninstallClaudeHooks,
  uninstallHermesHooks,
  uninstallMcpForAgent,
  uninstallProjectRules,
  uninstallRulesForAgent,
} from '../src/cli/uninstall.js';

let workspace: string;
let repoDir: string;
const prevEnv: Record<string, string | undefined> = {};

const cfg = { command: 'node', args: ['/x/dist/cli/index.js', 'mcp'], env: {} as Record<string, string> };

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-uninstall-'));
  repoDir = path.join(workspace, 'repo');
  fs.mkdirSync(repoDir);
  for (const key of ['HERMES_HOME', 'CLAUDE_CONFIG', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME', 'CODEX_HOME']) {
    prevEnv[key] = process.env[key];
    process.env[key] = path.join(workspace, key);
  }
  process.env['AEGISX_HOME'] = path.join(workspace, 'home');
});

afterEach(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('uninstall — MCP registrations per format', () => {
  it('hermes: entry removed, YAML stays parseable, siblings intact; second run is absent', () => {
    const file = path.join(workspace, 'HERMES_HOME', 'config.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'mcp_servers:\n  other:\n    command: "python"\n');
    installForAgent('hermes', { config: cfg, configPath: file });
    const r1 = uninstallMcpForAgent('hermes', { configPath: file });
    expect(r1.action).toBe('removed');
    const parsed = parseYaml(fs.readFileSync(file, 'utf8')) as { mcp_servers: Record<string, unknown> };
    expect(parsed.mcp_servers['other']).toBeDefined();
    expect(parsed.mcp_servers['aegisx-memory']).toBeUndefined();
    expect(fs.readFileSync(r1.backup as string, 'utf8')).toContain('aegisx-memory');
    const r2 = uninstallMcpForAgent('hermes', { configPath: file });
    expect(r2.action).toBe('absent');
  });

  it('hermes: installer-created config is deleted, not left as a `{}` husk', () => {
    const file = path.join(workspace, 'HERMES_HOME', 'solo.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    installForAgent('hermes', { config: cfg, configPath: file });
    const r = uninstallMcpForAgent('hermes', { configPath: file });
    expect(r.action).toBe('file-deleted');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('json agents (claude/cursor/gemini/windsurf): entry removed, siblings preserved', () => {
    for (const agent of ['claude', 'cursor', 'gemini', 'windsurf'] as const) {
      const file = path.join(workspace, `${agent}-cfg.json`);
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'uvx' } } }));
      installForAgent(agent, { config: cfg, configPath: file });
      const r = uninstallMcpForAgent(agent, { configPath: file });
      expect(r.action).toBe('removed');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, unknown> };
      expect(parsed.mcpServers['other']).toBeDefined();
      expect(parsed.mcpServers['aegisx-memory']).toBeUndefined();
    }
  });

  it('vscode: removes from the servers container, keeps the file with other servers', () => {
    const file = path.join(repoDir, '.vscode', 'mcp.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ servers: { other: { type: 'stdio', command: 'x' } } }));
    installForAgent('vscode', { config: cfg, configPath: file });
    const r = uninstallMcpForAgent('vscode', { configPath: file });
    expect(r.action).toBe('removed');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { servers: Record<string, unknown> };
    expect(parsed.servers['other']).toBeDefined();
    expect(parsed.servers['aegisx-memory']).toBeUndefined();
  });

  it('codex: the appended TOML block is cut and the prefix bytes are untouched', () => {
    const file = path.join(workspace, 'CODEX_HOME', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# my hand-tuned codex config\nmodel = "o4"\n');
    installForAgent('codex', { config: cfg, configPath: file });
    const withBlock = fs.readFileSync(file, 'utf8');
    expect(withBlock).toContain('[mcp_servers.aegisx-memory]');
    const r = uninstallMcpForAgent('codex', { configPath: file });
    expect(r.action).toBe('removed');
    const after = fs.readFileSync(file, 'utf8');
    expect(after).not.toContain('aegisx-memory');
    expect(after).toContain('# my hand-tuned codex config');
    expect(after).toContain('model = "o4"');
  });

  it('negative: an invalid JSON config is refused, file untouched', () => {
    const file = path.join(workspace, 'broken.json');
    fs.writeFileSync(file, 'not json');
    const r = uninstallMcpForAgent('claude', { configPath: file });
    expect(r.action).toBe('error');
    expect(fs.readFileSync(file, 'utf8')).toBe('not json');
  });

  it('created-file symmetry: a config the installer created is deleted outright', () => {
    const file = path.join(workspace, 'CODEX_HOME', 'config.toml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    installForAgent('codex', { config: cfg, configPath: file }); // created
    const r = uninstallMcpForAgent('codex', { configPath: file });
    expect(r.action).toBe('file-deleted');
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('uninstall — behavior rules', () => {
  it('hermes: block cut, user content stays; installer-created file is deleted', () => {
    const file = path.join(workspace, 'HERMES_HOME', 'SOUL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    installRulesForAgent('hermes'); // creates seed + block
    const r1 = uninstallRulesForAgent('hermes');
    expect(r1.action).toBe('file-deleted');
    expect(fs.existsSync(file)).toBe(false);
    // user content precedes the block → block cut, content kept
    fs.writeFileSync(file, '# My persona\n\nBe terse.\n');
    installRulesForAgent('hermes');
    const r2 = uninstallRulesForAgent('hermes');
    expect(r2.action).toBe('removed');
    const kept = fs.readFileSync(file, 'utf8');
    expect(kept).toContain('Be terse.');
    expect(kept).not.toContain('aegisx-memory:auto-rules');
  });

  it('claude rules: same contract on CLAUDE.md', () => {
    installRulesForAgent('claude');
    const file = path.join(workspace, 'CLAUDE_CONFIG_DIR', 'CLAUDE.md');
    const r = uninstallRulesForAgent('claude');
    expect(r.action).toBe('file-deleted');
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('uninstall — Claude hooks', () => {
  it('round-trip: installed pair removed, user hooks and other keys preserved', () => {
    const file = path.join(workspace, 'user-settings.json');
    fs.writeFileSync(file, JSON.stringify({ model: 'sonnet', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo keep' }] }] } }));
    installClaudeHooks(file);
    const r = uninstallClaudeHooks(file);
    expect(r.action).toBe('removed');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { model?: string; hooks?: Record<string, unknown[]> };
    expect(parsed.model).toBe('sonnet');
    expect(parsed.hooks?.PreToolUse).toHaveLength(1);
    expect(parsed.hooks?.SessionStart).toBeUndefined();
    expect(parsed.hooks?.PostToolUse).toBeUndefined();
  });

  it('idempotent: second removal is absent and leaves no misleading backup', () => {
    const file = path.join(workspace, 'settings2.json');
    installClaudeHooks(file);
    uninstallClaudeHooks(file); // installer-created file → deleted outright
    expect(fs.existsSync(file)).toBe(false);
    const r2 = uninstallClaudeHooks(file);
    expect(r2.action).toBe('absent');
    expect(r2.backup).toBeNull();
  });
});

describe('uninstall — project AGENTS.md', () => {
  it('round-trip: installer-created file is deleted; user repo keeps its own text', () => {
    installProjectRules(repoDir);
    const r1 = uninstallProjectRules(repoDir);
    expect(r1.action).toBe('file-deleted');
    expect(fs.existsSync(path.join(repoDir, 'AGENTS.md'))).toBe(false);
    fs.writeFileSync(path.join(repoDir, 'AGENTS.md'), '# My repo notes\n\nBuild with make.\n');
    installProjectRules(repoDir);
    const r2 = uninstallProjectRules(repoDir);
    expect(r2.action).toBe('removed');
    const kept = fs.readFileSync(path.join(repoDir, 'AGENTS.md'), 'utf8');
    expect(kept).toContain('Build with make.');
    expect(kept).not.toContain('aegisx-memory:auto-rules');
    expect(kept).not.toContain('Managed by aegisx-memory');
  });
});

describe('uninstall — runUninstall facade + CLI', () => {
  it('facade: one result per artifact, and memory data is explicitly out of scope', () => {
    installForAgent('hermes', { config: cfg });
    installRulesForAgent('hermes');
    const results = runUninstall({ agents: ['hermes'], hooks: false, project: false, projectDir: repoDir });
    expect(results.filter((r) => r.what === 'mcp')).toHaveLength(1);
    expect(results.filter((r) => r.what === 'rules')).toHaveLength(1);
  });

  it('CLI round-trip on the built bundle: every config file ends with no aegisx entry', () => {
    const bin = path.join(__dirname, '..', 'dist', 'cli', 'index.js');
    const run = (args: string[]): string =>
      execFileSync('node', [bin, ...args], { cwd: repoDir, env: { ...process.env }, encoding: 'utf8' });
    run(['setup', '--yes', '--agent', 'hermes,codex']);
    const hermes = path.join(workspace, 'HERMES_HOME', 'config.yaml');
    const codex = path.join(workspace, 'CODEX_HOME', 'config.toml');
    expect(fs.readFileSync(hermes, 'utf8')).toContain('aegisx-memory');
    expect(fs.readFileSync(codex, 'utf8')).toContain('aegisx-memory');
    const out = run(['uninstall', '--agent', 'hermes,codex']);
    expect(out).toContain('Memory data');
    // Both files held only what the installer wrote — the honest uninstall
    // deletes them instead of leaving a `{}` husk (hermes) or a lone block (codex).
    expect(fs.existsSync(hermes)).toBe(false);
    expect(fs.existsSync(codex)).toBe(false);
    expect(fs.existsSync(`${hermes}.aegisx-bak`)).toBe(true);
    expect(fs.existsSync(`${codex}.aegisx-bak`)).toBe(true);
    expect((parseYaml(fs.readFileSync(`${hermes}.aegisx-bak`, 'utf8')) as { mcp_servers: Record<string, unknown> }).mcp_servers['aegisx-memory']).toBeDefined();
  });

  it('CLI --yes is non-interactive even when stdin is a pipe, and unknown agents are user errors', () => {
    const bin = path.join(__dirname, '..', 'dist', 'cli', 'index.js');
    // Cursor keys off os.homedir(), which honors $HOME on POSIX — spawn with
    // HOME pointed at the workspace so the real home is never touched.
    const hermetic = (args: string[]): { out: string; err: string; status: number } => {
      try {
        return { out: execFileSync('node', [bin, ...args], { cwd: repoDir, env: { ...process.env, HOME: workspace }, encoding: 'utf8', input: '' }), err: '', status: 0 };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { out: e.stdout ?? '', err: e.stderr ?? '', status: e.status ?? 1 };
      }
    };
    const ok = hermetic(['setup', '--yes', '--agent', 'cursor']);
    expect(ok.status).toBe(0);
    const cursorFile = path.join(workspace, '.cursor', 'mcp.json');
    expect(fs.readFileSync(cursorFile, 'utf8')).toContain('aegisx-memory');
    const bad = hermetic(['setup', '--yes', '--agent', 'chatgpt']);
    expect(bad.status).toBe(1);
    expect(bad.err).toContain('unknown agent');
  });

  it('mirrors the installer: plain uninstall strips the repo AGENTS.md block and project Claude hooks', () => {
    // Setup mirror: codex/windsurf/vscode carry their rules in the repo file,
    // and the project hook pair is installed when claude is among the targets.
    installForAgent('codex', { config: cfg });
    installForAgent('claude', { config: cfg });
    installProjectRules(repoDir);
    installClaudeHooks(path.join(repoDir, '.claude', 'settings.json'));
    const results = runUninstall({ agents: ['codex', 'claude'], hooks: false, project: false, projectDir: repoDir });
    expect(results.some((r) => r.what === 'project' && r.action === 'file-deleted')).toBe(true);
    expect(results.some((r) => r.what === 'hooks' && r.action === 'file-deleted')).toBe(true);
    expect(fs.existsSync(path.join(repoDir, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, '.claude', 'settings.json'))).toBe(false);
  });

  it('mirrors the installer only when a rules-carrier agent or claude is targeted', () => {
    installProjectRules(repoDir);
    const results = runUninstall({ agents: ['hermes'], hooks: false, project: false, projectDir: repoDir });
    expect(results.some((r) => r.what === 'project')).toBe(false);
    expect(fs.existsSync(path.join(repoDir, 'AGENTS.md'))).toBe(true);
  });
});

describe('uninstall — Hermes hooks leave no husk', () => {
  function installPair(name: string): { configFile: string; hooksDir: string } {
    const configFile = path.join(workspace, name, 'config.yaml');
    const hooksDir = path.join(workspace, name, 'agent-hooks');
    const result = installHermesHooks(configFile, { hooksDir, bin: 'aegisxmemory-fake' });
    expect(result.action).not.toBe('error');
    expect(fs.existsSync(path.join(hooksDir, 'aegisx-recall.sh'))).toBe(true);
    return { configFile, hooksDir };
  }

  it('happy: the scripts and the folder we emptied are both gone', () => {
    const { configFile, hooksDir } = installPair('plain');
    fs.writeFileSync(configFile, 'model:\n  provider: tokenrouter\n' + fs.readFileSync(configFile, 'utf8'));
    const result = uninstallHermesHooks(configFile);
    expect(result.action).toBe('removed');
    expect(fs.existsSync(path.join(hooksDir, 'aegisx-recall.sh'))).toBe(false);
    expect(fs.existsSync(path.join(hooksDir, 'aegisx-save-nudge.sh'))).toBe(false);
    expect(fs.existsSync(hooksDir)).toBe(false);
    expect(fs.readFileSync(configFile, 'utf8')).toContain('tokenrouter'); // user config intact
  });

  it('regression: a config we delete outright still takes its scripts with it', () => {
    // The file-deleted branch used to return before the script loop, so an
    // installer-created config vanished while its hook scripts stayed behind.
    const { configFile, hooksDir } = installPair('ours-alone');
    const result = uninstallHermesHooks(configFile);
    expect(result.action).toBe('file-deleted');
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(hooksDir)).toBe(false);
  });

  it('negative: a folder holding the user\u2019s own hooks is left alone', () => {
    const { configFile, hooksDir } = installPair('shared');
    const mine = path.join(hooksDir, 'my-own-hook.sh');
    fs.writeFileSync(mine, '#!/bin/sh\n');
    const result = uninstallHermesHooks(configFile);
    expect(result.action).toBe('file-deleted');
    expect(fs.existsSync(path.join(hooksDir, 'aegisx-recall.sh'))).toBe(false);
    expect(fs.existsSync(mine)).toBe(true);
    expect(fs.existsSync(hooksDir)).toBe(true);
  });
});
