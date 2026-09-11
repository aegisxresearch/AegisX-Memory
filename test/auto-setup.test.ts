import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { installForAgent, installRulesForAgent, memoryRulesBlock } from '../src/cli/auto-setup.js';
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
});
