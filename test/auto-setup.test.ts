import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  describeSweep,
  installForAgent,
  installProjectRules,
  installRulesForAgent,
  memoryRulesBlock,
  sweepOrphanedBackups,
} from '../src/cli/auto-setup.js';
import { defaultServerConfig } from '../src/cli/mcp-config.js';
import { AegisxError } from '../src/core/types.js';

let workspace: string;
const prevEnv: Record<string, string | undefined> = {};

const cfg = defaultServerConfig();

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-setup-'));
  for (const key of ['HERMES_HOME', 'CLAUDE_CONFIG']) {
    prevEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function hermesFile(): string {
  return path.join(workspace, 'home', '.hermes', 'config.yaml');
}
function claudeFile(): string {
  return path.join(workspace, 'home', '.claude', 'claude_desktop_config.json');
}
function cursorFile(): string {
  return path.join(workspace, 'home', '.cursor', 'mcp.json');
}
function geminiFile(): string {
  return path.join(workspace, 'home', '.gemini', 'settings.json');
}
function windsurfFile(): string {
  return path.join(workspace, 'home', '.codeium', 'windsurf', 'mcp_config.json');
}
function codexFile(): string {
  return path.join(workspace, 'home', '.codex', 'config.toml');
}
function vscodeFile(): string {
  return path.join(workspace, 'repo', '.vscode', 'mcp.json');
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('auto-setup — hermes (YAML)', () => {
  it('happy: creates config.yaml when missing, with command/args/env', () => {
    const file = hermesFile();
    const result = installForAgent('hermes', { configPath: file, config: cfg });
    expect(result.action).toBe('created');
    const parsed = parseYaml(fs.readFileSync(file, 'utf8')) as {
      mcp_servers: { 'aegisx-memory': { command: string; args: string[]; env?: Record<string, string> } };
    };
    const entry = parsed.mcp_servers['aegisx-memory'];
    expect(entry.command).toBe('node');
    expect(entry.args[1]).toBe('mcp');
  });

  it('happy: merges into an existing config and preserves other entries', () => {
    const file = hermesFile();
    write(file, 'mcp_servers:\n  other-server:\n    command: "uvx"\n    args: ["time"]\nmodel: x\n');
    const result = installForAgent('hermes', { configPath: file, config: cfg });
    expect(result.action).toBe('updated');
    const parsed = parseYaml(fs.readFileSync(file, 'utf8')) as {
      model?: string;
      mcp_servers?: Record<string, { command: string }>;
    };
    expect(parsed.model).toBe('x');
    const servers = parsed.mcp_servers ?? {};
    expect(servers['other-server']?.command).toBe('uvx');
    expect(servers['aegisx-memory']).toBeDefined();
    expect(result.backupPath).toBe(`${file}.aegisx-bak`);
    expect(fs.readFileSync(result.backupPath as string, 'utf8')).toContain('other-server');
  });

  it('idempotent: running twice leaves the file byte-identical and reports unchanged', () => {
    const file = hermesFile();
    installForAgent('hermes', { configPath: file, config: cfg });
    const first = fs.readFileSync(file, 'utf8');
    const second = installForAgent('hermes', { configPath: file, config: cfg });
    expect(second.action).toBe('unchanged');
    expect(second.backupPath).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
  });

  it('negative: refuses to touch a config that does not parse', () => {
    const file = hermesFile();
    write(file, 'mcp_servers: [broken\n  ::: no');
    expect(() => installForAgent('hermes', { configPath: file, config: cfg })).toThrow(AegisxError);
    expect(fs.readFileSync(file, 'utf8')).toBe('mcp_servers: [broken\n  ::: no');
  });

  it('happy: converts the empty-key default (`mcp_servers:`) to a mapping', () => {
    const file = hermesFile();
    write(file, 'model: x\nmcp_servers:\n');
    const result = installForAgent('hermes', { configPath: file, config: cfg });
    expect(result.action).toBe('updated');
    const parsed = parseYaml(fs.readFileSync(file, 'utf8')) as {
      model?: string;
      mcp_servers?: Record<string, { command: string }>;
    };
    expect(parsed.model).toBe('x');
    expect(parsed.mcp_servers?.['aegisx-memory']?.command).toBe('node');
  });

  it('happy: converts an empty-list default (`mcp_servers: []`) to a mapping', () => {
    const file = hermesFile();
    write(file, 'mcp_servers: []\n');
    const result = installForAgent('hermes', { configPath: file, config: cfg });
    expect(result.action).toBe('updated');
    const parsed = parseYaml(fs.readFileSync(file, 'utf8')) as {
      mcp_servers?: Record<string, { command: string }>;
    };
    expect(parsed.mcp_servers?.['aegisx-memory']).toBeDefined();
  });

  it('negative: mcp_servers that is not a mapping is refused, not overwritten', () => {
    const file = hermesFile();
    write(file, 'mcp_servers: 42\n');
    expect(() => installForAgent('hermes', { configPath: file, config: cfg })).toThrow(AegisxError);
    expect(fs.readFileSync(file, 'utf8')).toBe('mcp_servers: 42\n');
  });

  it('negative: a non-empty list of servers is refused (data would be lost)', () => {
    const file = hermesFile();
    write(file, 'mcp_servers:\n  - command: "uvx"\n    args: ["time"]\n');
    expect(() => installForAgent('hermes', { configPath: file, config: cfg })).toThrow(AegisxError);
    expect(fs.readFileSync(file, 'utf8')).toContain('uvx');
  });
});

describe('auto-setup — claude/cursor (JSON)', () => {
  it('happy: creates the JSON config with mcpServers entry', () => {
    const file = claudeFile();
    const result = installForAgent('claude', { configPath: file, config: cfg });
    expect(result.action).toBe('created');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      mcpServers: { 'aegisx-memory': { command: string; args: string[] } };
    };
    expect(parsed.mcpServers['aegisx-memory']?.command).toBe('node');
  });

  it('happy: merges into an existing JSON config, preserving siblings', () => {
    const file = claudeFile();
    write(file, JSON.stringify({ other: true, mcpServers: { time: { command: 'uvx', args: ['time'] } } }));
    const result = installForAgent('claude', { configPath: file, config: cfg });
    expect(result.action).toBe('updated');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      other: boolean;
      mcpServers: Record<string, { command: string }>;
    };
    expect(parsed.other).toBe(true);
    expect(parsed.mcpServers['time']).toBeDefined();
    expect(parsed.mcpServers['aegisx-memory']).toBeDefined();
    expect(result.backupPath).not.toBeNull();
  });

  it('idempotent: second run is unchanged', () => {
    const file = cursorFile();
    installForAgent('cursor', { configPath: file, config: cfg });
    const result = installForAgent('cursor', { configPath: file, config: cfg });
    expect(result.action).toBe('unchanged');
  });

  it('negative: invalid JSON is refused and left untouched', () => {
    const file = claudeFile();
    write(file, '{ not json !!');
    expect(() => installForAgent('claude', { configPath: file, config: cfg })).toThrow(AegisxError);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json !!');
  });
});

describe('auto-setup — gemini/cursor/windsurf (plain mcpServers JSON)', () => {
  it('happy: gemini settings.json gets the mcpServers entry', () => {
    const result = installForAgent('gemini', { configPath: geminiFile(), config: cfg });
    expect(result.action).toBe('created');
    const parsed = JSON.parse(fs.readFileSync(geminiFile(), 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(parsed.mcpServers['aegisx-memory']?.command).toBe('node');
  });

  it('happy: windsurf mcp_config.json gets the mcpServers entry, idempotent', () => {
    const file = windsurfFile();
    expect(installForAgent('windsurf', { configPath: file, config: cfg }).action).toBe('created');
    const first = fs.readFileSync(file, 'utf8');
    expect(installForAgent('windsurf', { configPath: file, config: cfg }).action).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
  });

  it('negative: invalid gemini JSON is refused, file untouched', () => {
    const file = geminiFile();
    write(file, '{{ nope');
    expect(() => installForAgent('gemini', { configPath: file, config: cfg })).toThrow(AegisxError);
    expect(fs.readFileSync(file, 'utf8')).toBe('{{ nope');
  });
});

describe('auto-setup — codex (TOML, zero-dependency writer)', () => {
  it('happy: appends the [mcp_servers.aegisx-memory] table with command/args/env', () => {
    const file = codexFile();
    const result = installForAgent('codex', {
      configPath: file,
      config: { command: 'node', args: ['/x/index.js', 'mcp'], env: { AEGISX_HOME: '/home' } },
    });
    expect(result.action).toBe('created');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('[mcp_servers.aegisx-memory]');
    expect(text).toContain('command = "node"');
    expect(text).toContain('args = ["/x/index.js", "mcp"]');
    expect(text).toContain('[mcp_servers.aegisx-memory.env]');
    expect(text).toContain('AEGISX_HOME = "/home"');
  });

  it('happy: appends to an existing config and preserves every byte before the block', () => {
    const file = codexFile();
    const original = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "uvx"\n';
    write(file, original);
    const result = installForAgent('codex', { configPath: file, config: cfg });
    expect(result.action).toBe('updated');
    const text = fs.readFileSync(file, 'utf8');
    expect(text.startsWith(original)).toBe(true);
    expect(text).toContain('[mcp_servers.aegisx-memory]');
    expect(result.backupPath).toBe(`${file}.aegisx-bak`);
  });

  it('idempotent: second run is unchanged and never duplicates the table', () => {
    const file = codexFile();
    installForAgent('codex', { configPath: file, config: cfg });
    const first = fs.readFileSync(file, 'utf8');
    expect(installForAgent('codex', { configPath: file, config: cfg }).action).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
    expect(first.split('[mcp_servers.aegisx-memory]').length - 1).toBe(1);
  });

  it('happy: a file not ending in a newline does not glue the block to the last line', () => {
    const file = codexFile();
    write(file, 'model = "x"'); // no trailing newline
    installForAgent('codex', { configPath: file, config: cfg });
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('model = "x"\n\n# aegisx-memory');
  });

  it('negative: a corrupt existing file is still safe — the block is appended, never a rewrite', () => {
    const file = codexFile();
    const broken = 'model = [unclosed\n  garbage';
    write(file, broken);
    const result = installForAgent('codex', { configPath: file, config: cfg });
    expect(result.action).toBe('updated');
    expect(fs.readFileSync(file, 'utf8').startsWith(broken)).toBe(true);
  });
});

describe('auto-setup — vscode (.vscode/mcp.json, servers + type)', () => {
  it('happy: nests under `servers` with type stdio, not mcpServers', () => {
    const file = vscodeFile();
    const result = installForAgent('vscode', { configPath: file, config: cfg });
    expect(result.action).toBe('created');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      servers?: Record<string, { type?: string; command: string }>;
      mcpServers?: unknown;
    };
    expect(parsed.servers?.['aegisx-memory']?.type).toBe('stdio');
    expect(parsed.servers?.['aegisx-memory']?.command).toBe('node');
    expect(parsed.mcpServers).toBeUndefined();
  });

  it('happy: merges with existing servers and stays idempotent', () => {
    const file = vscodeFile();
    write(file, JSON.stringify({ servers: { other: { command: 'uvx' } } }));
    installForAgent('vscode', { configPath: file, config: cfg });
    const first = fs.readFileSync(file, 'utf8');
    expect(installForAgent('vscode', { configPath: file, config: cfg }).action).toBe('unchanged');
    const parsed = JSON.parse(first) as { servers: Record<string, unknown> };
    expect(Object.keys(parsed.servers).sort()).toEqual(['aegisx-memory', 'other']);
  });
});

describe('auto-setup — env override semantics (directory, not file)', () => {
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['GEMINI_CLI_HOME', 'CODEX_HOME']) {
      prevEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('GEMINI_CLI_HOME and CODEX_HOME join the file name — never swallowed whole', () => {
    const geminiHome = path.join(workspace, 'gemini-home');
    const codexHome = path.join(workspace, 'codex-home');
    process.env['GEMINI_CLI_HOME'] = geminiHome;
    process.env['CODEX_HOME'] = codexHome;
    installForAgent('gemini', { config: cfg });
    installForAgent('codex', { config: cfg });
    expect(fs.existsSync(path.join(geminiHome, 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(true);
  });
});

describe('auto-setup — behavior rules (auto memory)', () => {
  it('happy: creates Hermes SOUL.md with identity seed + rules block when missing', () => {
    const file = path.join(workspace, 'home', '.hermes', 'SOUL.md');
    const result = installRulesForAgent('hermes', { rulesPath: file });
    expect(result.action).toBe('created');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('# Identity');
    expect(content).toContain('aegisx-memory:auto-rules BEGIN');
    expect(content).toContain('recall');
    expect(content).toContain('save');
  });

  it('happy: appends the rules block to an existing SOUL.md without touching its content', () => {
    const file = path.join(workspace, 'home', '.hermes', 'SOUL.md');
    const original = '# My persona\n\nBe terse.\n';
    write(file, original);
    const result = installRulesForAgent('hermes', { rulesPath: file });
    expect(result.action).toBe('updated');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('# My persona');
    expect(content).toContain('Be terse.');
    expect(content).toContain('aegisx-memory:auto-rules BEGIN');
    expect(result.backupPath).toBe(`${file}.aegisx-bak`);
    expect(fs.readFileSync(result.backupPath as string, 'utf8')).toBe(original);
  });

  it('idempotent: second run is byte-identical and reports unchanged', () => {
    const file = path.join(workspace, 'rules.md');
    installRulesForAgent('hermes', { rulesPath: file });
    const first = fs.readFileSync(file, 'utf8');
    const second = installRulesForAgent('hermes', { rulesPath: file });
    expect(second.action).toBe('unchanged');
    expect(second.backupPath).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
  });

  it('update: refreshes the block in place on later runs (keeps marker count at 2)', () => {
    const file = path.join(workspace, 'rules.md');
    installRulesForAgent('hermes', { rulesPath: file });
    // simulate an older block with a stale rule
    const stale = fs.readFileSync(file, 'utf8').replace('Never store secrets', 'Secrets are fine (stale rule)');
    fs.writeFileSync(file, stale);
    const result = installRulesForAgent('hermes', { rulesPath: file });
    expect(result.action).toBe('updated');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('Never store secrets');
    expect(content).not.toContain('stale rule');
    expect(content.split('aegisx-memory:auto-rules BEGIN').length - 1).toBe(1);
  });

  it('rules reference tool purposes, not client-specific tool names', () => {
    const block = memoryRulesBlock();
    expect(block).not.toContain('mcp__');
    expect(block).toContain('recall');
    expect(block).toContain('remember');
  });

  it('the contract tells the agent how to read a clipped block, not just to recall', () => {
    const block = memoryRulesBlock();
    // The coverage line is only useful if the agent knows its vocabulary.
    expect(block).toContain('complete');
    expect(block).toContain('(more exist)');
    expect(block).toContain('budget dropped');
    expect(block).toContain('in handoff');
    // An empty store has an action, not just a diagnosis.
    expect(block).toContain('`index`');
    // Every kind of note has a home, and notes can be corrected.
    for (const kind of ['decisions', 'gotchas', 'conventions', 'lesson']) {
      expect(block).toContain(kind);
    }
    expect(block).toContain('knowledge --forget');
  });
});

describe('auto-setup — project rules (AGENTS.md)', () => {
  function projectFile(): string {
    return path.join(workspace, 'repo', 'AGENTS.md');
  }

  it('happy: creates AGENTS.md with a managed header and the contract', () => {
    const result = installProjectRules(path.join(workspace, 'repo'));
    expect(result.action).toBe('created');
    expect(result.backupPath).toBeNull();
    const content = fs.readFileSync(projectFile(), 'utf8');
    expect(content).toContain('# Project agent rules');
    expect(content).toContain('aegisx-memory:auto-rules BEGIN');
    expect(content).toContain('aegisx-memory:auto-rules END');
    expect(content).toContain('Do not record what the repo already states');
  });

  it('happy: appends to a repo that already has an AGENTS.md, preserving it and backing up', () => {
    const file = projectFile();
    const original = '# My repo rules\n\nRun tests with `make test`.\n';
    write(file, original);
    const result = installProjectRules(path.join(workspace, 'repo'));
    expect(result.action).toBe('updated');
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('Run tests with `make test`.');
    expect(content).toContain('aegisx-memory:auto-rules BEGIN');
    expect(result.backupPath).toBe(`${file}.aegisx-bak`);
    expect(fs.readFileSync(result.backupPath as string, 'utf8')).toBe(original);
  });

  it('idempotent: second run is byte-identical and never duplicates the block', () => {
    const dir = path.join(workspace, 'repo');
    installProjectRules(dir);
    const first = fs.readFileSync(projectFile(), 'utf8');
    const second = installProjectRules(dir);
    expect(second.action).toBe('unchanged');
    expect(second.backupPath).toBeNull();
    expect(fs.readFileSync(projectFile(), 'utf8')).toBe(first);
    expect(first.split('aegisx-memory:auto-rules BEGIN').length - 1).toBe(1);
  });

  it('update: refreshes a stale block in place and keeps the header', () => {
    const dir = path.join(workspace, 'repo');
    installProjectRules(dir);
    const stale = fs.readFileSync(projectFile(), 'utf8').replace('Never store secrets', 'Secrets are fine (stale rule)');
    fs.writeFileSync(projectFile(), stale);
    const result = installProjectRules(dir);
    expect(result.action).toBe('updated');
    const content = fs.readFileSync(projectFile(), 'utf8');
    expect(content).not.toContain('stale rule');
    expect(content).toContain('Never store secrets');
    expect(content.split('aegisx-memory:auto-rules BEGIN').length - 1).toBe(1);
  });

  it('negative: a directory named AGENTS.md is an error, not a silent write elsewhere', () => {
    fs.mkdirSync(projectFile(), { recursive: true });
    expect(() => installProjectRules(path.join(workspace, 'repo'))).toThrow();
  });
});

/**
 * The flag is user-facing, so it is exercised through the built bundle the way
 * a user types it; on a checkout with no build the suite skips (node cannot run
 * the TypeScript sources directly), exactly like the other CLI-level tests.
 */
const DIST_ENTRY = path.resolve('dist/cli/index.js');
const cliSuite = fs.existsSync(DIST_ENTRY) ? describe : describe.skip;

cliSuite('mcp-config --project-rules (built CLI)', () => {
  function runCli(args: string[], cwd: string): string {
    return execFileSync(process.execPath, [DIST_ENTRY, ...args], {
      cwd,
      encoding: 'utf8',
      // Never let a test reach the real home, even though this flag writes nothing globally.
      env: { ...process.env, HERMES_HOME: path.join(workspace, 'HERMES_HOME') },
    });
  }

  it('writes AGENTS.md into the named directory, then reports it as already present', () => {
    const dir = path.join(workspace, 'cli-repo');
    fs.mkdirSync(dir, { recursive: true });
    const first = runCli(['mcp-config', '--project-rules', dir], workspace);
    expect(first).toContain('✓ project: behavior rules written to');
    const file = path.join(dir, 'AGENTS.md');
    expect(fs.readFileSync(file, 'utf8')).toContain('aegisx-memory:auto-rules BEGIN');
    const before = fs.readFileSync(file, 'utf8');
    const second = runCli(['mcp-config', '--project-rules', dir], workspace);
    expect(second).toContain('already present');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('happy: defaults to the current directory when no directory is given', () => {
    const out = runCli(['mcp-config', '--project-rules'], workspace);
    expect(out).toContain('✓ project: behavior rules written to');
    expect(fs.existsSync(path.join(workspace, 'AGENTS.md'))).toBe(true);
  });

  it('negative: with no action flag it only prints the paste block and writes nothing', () => {
    const out = runCli(['mcp-config', '--agent', 'claude'], workspace);
    expect(out).toContain('mcpServers');
    expect(fs.existsSync(path.join(workspace, 'AGENTS.md'))).toBe(false);
  });
});

describe('orphaned backup sweep', () => {
  const home = (): string => path.join(workspace, 'home');

  function write(rel: string, content: string): string {
    const file = path.join(home(), rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }

  it('happy: a backup whose original is gone is debris — removed, and so is the phantom dir', () => {
    const backup = write(path.join('.codex', 'config.toml.aegisx-bak'), '[mcp_servers."aegisx-memory"]\ncommand = "node"\n');
    const sweep = sweepOrphanedBackups({ homeDir: home() });
    expect(sweep.removed).toContain(backup);
    expect(fs.existsSync(backup)).toBe(false);
    // The directory existed only to hold our debris; leaving it reads as
    // "this agent is installed here" in every later inspection.
    expect(fs.existsSync(path.join(home(), '.codex'))).toBe(false);
    expect(sweep.prunedDirs).toContain(path.join(home(), '.codex'));
  });

  it('nested: emptying ~/.codeium/windsurf also clears the ~/.codeium husk', () => {
    write(path.join('.codeium', 'windsurf', 'mcp_config.json.aegisx-bak'), '{"mcpServers":{"aegisx-memory":{}}}');
    const sweep = sweepOrphanedBackups({ homeDir: home() });
    expect(fs.existsSync(path.join(home(), '.codeium', 'windsurf'))).toBe(false);
    expect(fs.existsSync(path.join(home(), '.codeium'))).toBe(false);
    expect(sweep.prunedDirs).toHaveLength(2);
  });

  it('deeper: a rules backup under ~/.cursor/rules is swept and both levels pruned', () => {
    // Cursor keeps its rules at ~/.cursor/rules/<name>.mdc — one level below
    // the MCP config, so a scan that only looked at ~/.cursor would miss it.
    write(path.join('.cursor', 'rules', 'aegisx-memory.mdc.aegisx-bak'), '---\nalwaysApply: true\n---\naegisx-memory\n');
    const sweep = sweepOrphanedBackups({ homeDir: home() });
    expect(sweep.removed).toHaveLength(1);
    expect(fs.existsSync(path.join(home(), '.cursor', 'rules'))).toBe(false);
    expect(fs.existsSync(path.join(home(), '.cursor'))).toBe(false);
  });

  it('negative: a backup whose original still exists is a live safety net — never touched', () => {
    const config = write(path.join('.cursor', 'mcp.json'), '{"mcpServers":{"aegisx-memory":{}}}');
    const backup = write(path.join('.cursor', 'mcp.json.aegisx-bak'), '{"mcpServers":{}}');
    const sweep = sweepOrphanedBackups({ homeDir: home() });
    expect(sweep.removed).toHaveLength(0);
    expect(fs.existsSync(backup)).toBe(true);
    expect(fs.existsSync(config)).toBe(true);
  });

  it('negative: an orphan holding content that is not ours is kept and reported, never destroyed', () => {
    // Skipping this guard would make the sweep a data-loss tool: an orphan can
    // be the user's only copy of something aegisx cannot identify.
    const backup = write(path.join('.claude', 'CLAUDE.md.aegisx-bak'), '# My own house rules\n\nBe concise.\n');
    const sweep = sweepOrphanedBackups({ homeDir: home() });
    expect(fs.existsSync(backup)).toBe(true);
    expect(sweep.kept).toContain(backup);
    expect(sweep.removed).toHaveLength(0);
    expect(describeSweep(sweep)).toContain('not ours');
  });

  it('idempotent: a second sweep finds nothing, and missing directories never throw', () => {
    write(path.join('.gemini', 'settings.json.aegisx-bak'), '{"mcpServers":{"aegisx-memory":{}}}');
    const first = sweepOrphanedBackups({ homeDir: home() });
    const second = sweepOrphanedBackups({ homeDir: home() });
    expect(first.removed).toHaveLength(1);
    expect(second.removed).toHaveLength(0);
    expect(second.prunedDirs).toHaveLength(0);
    expect(describeSweep(second)).toBeNull();
  });

  it('scoped: an empty managed directory is never pruned, only one this sweep emptied', () => {
    // ~/.cursor exists but holds nothing of ours: nothing was swept there, so
    // the sweep has no business removing the user's directory.
    fs.mkdirSync(path.join(home(), '.cursor'), { recursive: true });
    const sweep = sweepOrphanedBackups({ homeDir: home() });
    expect(sweep.prunedDirs).toHaveLength(0);
    expect(fs.existsSync(path.join(home(), '.cursor'))).toBe(true);
  });
});
