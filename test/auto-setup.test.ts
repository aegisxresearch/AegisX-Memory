import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { installForAgent } from '../src/cli/auto-setup.js';
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

  it('negative: mcp_servers that is not a mapping is refused, not overwritten', () => {
    const file = hermesFile();
    write(file, 'mcp_servers: 42\n');
    expect(() => installForAgent('hermes', { configPath: file, config: cfg })).toThrow(AegisxError);
    expect(fs.readFileSync(file, 'utf8')).toBe('mcp_servers: 42\n');
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
