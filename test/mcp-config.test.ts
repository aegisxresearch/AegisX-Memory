import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  binServerConfig,
  defaultServerConfig,
  parseAgentArg,
  renderClaudeJson,
  renderConfig,
  renderCursorJson,
  renderHermesYaml,
  selfServerEntry,
} from '../src/cli/mcp-config.js';
import { AegisxError } from '../src/core/types.js';

interface ServerBlock {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function parseJsonBlock(text: string): ServerBlock {
  const parsed = JSON.parse(text) as { mcpServers?: Record<string, ServerBlock> };
  const block = parsed.mcpServers?.['aegisx-memory'];
  if (block === undefined) {
    throw new Error('aegisx-memory block missing from JSON output');
  }
  return block;
}

describe('mcp-config generator', () => {
  it('happy path: entry is index.js beside the generator module, wired with the mcp subcommand', () => {
    const entry = selfServerEntry();
    // Structural contract: index.js in the generator module's own directory —
    // src/cli under vitest, dist/cli at real runtime. Both must hold.
    expect(path.basename(entry)).toBe('index.js');
    expect(entry.includes('/src/cli/') || entry.includes('/dist/cli/')).toBe(true);
    expect(defaultServerConfig().args).toEqual([entry, 'mcp']);
    expect(defaultServerConfig().command).toBe('node');
  });

  it('renders valid Hermes YAML with the server block and timeouts', () => {
    const yaml = renderHermesYaml(defaultServerConfig());
    expect(yaml).toContain('mcp_servers:');
    expect(yaml).toContain('aegisx-memory:');
    expect(yaml).toContain('connect_timeout: 30');
    expect(yaml).toContain('timeout: 60');
  });

  it('renders Claude and Cursor blocks as strict JSON (no comment lines)', () => {
    for (const text of [renderClaudeJson(defaultServerConfig()), renderCursorJson(defaultServerConfig())]) {
      expect(text.split('\n').some((l) => l.trimStart().startsWith('#'))).toBe(false);
      const block = parseJsonBlock(text); // the real contract: must parse as JSON
      expect(block.command).toBe('node');
      expect(block.args[1]).toBe('mcp');
    }
  });

  it('propagates AEGISX_HOME into env when set', () => {
    const prev = process.env['AEGISX_HOME'];
    process.env['AEGISX_HOME'] = '/custom/memory-home';
    try {
      const cfg = defaultServerConfig();
      expect(cfg.env['AEGISX_HOME']).toBe('/custom/memory-home');
      expect(renderHermesYaml(cfg)).toContain('AEGISX_HOME:');
      expect(parseJsonBlock(renderClaudeJson(cfg)).env?.['AEGISX_HOME']).toBe('/custom/memory-home');
    } finally {
      if (prev === undefined) {
        delete process.env['AEGISX_HOME'];
      } else {
        process.env['AEGISX_HOME'] = prev;
      }
    }
  });

  it('propagates AEGISX_ALLOWED_REPOS into env when set (allowlist inherits to MCP servers)', () => {
    const prev = process.env['AEGISX_ALLOWED_REPOS'];
    process.env['AEGISX_ALLOWED_REPOS'] = '/repo/one:/repo/two';
    try {
      const cfg = defaultServerConfig();
      expect(cfg.env['AEGISX_ALLOWED_REPOS']).toBe('/repo/one:/repo/two');
      expect(parseJsonBlock(renderClaudeJson(cfg)).env?.['AEGISX_ALLOWED_REPOS']).toBe('/repo/one:/repo/two');
      expect(renderHermesYaml(cfg)).toContain('AEGISX_ALLOWED_REPOS:');
    } finally {
      if (prev === undefined) {
        delete process.env['AEGISX_ALLOWED_REPOS'];
      } else {
        process.env['AEGISX_ALLOWED_REPOS'] = prev;
      }
    }
  });

  it('omits AEGISX_ALLOWED_REPOS from env when unset', () => {
    const prev = process.env['AEGISX_ALLOWED_REPOS'];
    delete process.env['AEGISX_ALLOWED_REPOS'];
    try {
      expect(defaultServerConfig().env['AEGISX_ALLOWED_REPOS']).toBeUndefined();
    } finally {
      if (prev !== undefined) {
        process.env['AEGISX_ALLOWED_REPOS'] = prev;
      }
    }
  });

  it('--bin mode switches to the PATH binary', () => {
    const cfg = binServerConfig();
    expect(cfg.command).toBe('aegisxmemory');
    expect(cfg.args).toEqual(['mcp']);
    expect(renderHermesYaml(cfg)).toContain('command: "aegisxmemory"');
  });

  it('rejects unknown agents and defaults to all', () => {
    expect(parseAgentArg(undefined)).toBe('all');
    expect(parseAgentArg('hermes')).toBe('hermes');
    expect(() => parseAgentArg('chatgpt')).toThrow(AegisxError);
    expect(() => parseAgentArg('chatgpt')).toThrow(/hermes, claude, cursor, gemini, codex, windsurf, vscode, all/);
    expect(() => renderConfig('chatgpt', defaultServerConfig())).toThrow(AegisxError);
  });

  it('all-mode includes sections for every agent', () => {
    const all = renderConfig('all', defaultServerConfig());
    expect(all).toContain('─── Hermes ───');
    expect(all).toContain('─── Claude ───');
    expect(all).toContain('─── Cursor ───');
    expect(all).toContain('mcp_servers:'); // hermes section present
    expect(all).toContain('"mcpServers"'); // json sections present
  });
});
