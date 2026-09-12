/**
 * MCP config generator: prints ready-to-paste registration blocks so any
 * MCP-capable agent (Hermes, Claude, Cursor, …) can wire up AegisX-Memory
 * in one copy-paste. Pure functions — no I/O except resolving our own path.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AegisxError } from '../core/types.js';

export type McpAgent = 'hermes' | 'claude' | 'cursor' | 'gemini' | 'codex' | 'windsurf' | 'vscode';
export const MCP_AGENTS: readonly McpAgent[] = ['hermes', 'claude', 'cursor', 'gemini', 'codex', 'windsurf', 'vscode'];

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Absolute path to the MCP entrypoint (this package's own dist CLI). */
export function selfServerEntry(): string {
  // This module lives at <root>/dist/cli/mcp-config.js next to index.js.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
}

/** Default registration: `node <absolute entry> mcp` — always correct. */
export function defaultServerConfig(): McpServerConfig {
  const env: Record<string, string> = {};
  const home = process.env['AEGISX_HOME'];
  if (home !== undefined && home.trim() !== '') {
    env['AEGISX_HOME'] = home;
  }
  // Propagate the repo allowlist (RFC §5, STRIDE:S) into spawned MCP servers
  // so agents inherit the exact authorization policy of this shell.
  const allowed = process.env['AEGISX_ALLOWED_REPOS'];
  if (allowed !== undefined && allowed.trim() !== '') {
    env['AEGISX_ALLOWED_REPOS'] = allowed;
  }
  return { command: 'node', args: [selfServerEntry(), 'mcp'], env };
}

/** Registration for npm-linked installs where `aegisxmemory` is on PATH. */
export function binServerConfig(): McpServerConfig {
  return { ...defaultServerConfig(), command: 'aegisxmemory', args: ['mcp'] };
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Hermes: stdio block to merge into ~/.hermes/config.yaml `mcp_servers`. */
export function renderHermesYaml(cfg: McpServerConfig): string {
  const lines = [
    'mcp_servers:',
    '  aegisx-memory:',
    `    command: ${yamlQuote(cfg.command)}`,
    `    args: [${cfg.args.map(yamlQuote).join(', ')}]`,
    '    connect_timeout: 30',
    '    timeout: 60',
  ];
  if (Object.keys(cfg.env).length > 0) {
    lines.push('    env:');
    for (const [key, value] of Object.entries(cfg.env)) {
      lines.push(`      ${key}: ${yamlQuote(value)}`);
    }
  }
  return [
    '# Hermes — paste into ~/.hermes/config.yaml.',
    '# If an `mcp_servers:` key already exists, merge only the `aegisx-memory:` entry.',
    ...lines,
  ].join('\n');
}

interface StdioJsonBlock {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function stdioJsonBlock(cfg: McpServerConfig): { mcpServers: Record<string, StdioJsonBlock> } {
  const block: StdioJsonBlock = { command: cfg.command, args: cfg.args };
  if (Object.keys(cfg.env).length > 0) {
    block.env = { ...cfg.env };
  }
  return { mcpServers: { 'aegisx-memory': block } };
}

/** Claude Desktop / Claude Code: pure JSON for claude_desktop_config.json / .mcp.json.
 *  Deliberately comment-free — these target files are strict JSON. */
export function renderClaudeJson(cfg: McpServerConfig): string {
  return JSON.stringify(stdioJsonBlock(cfg), null, 2);
}

/** Cursor: pure JSON for ~/.cursor/mcp.json (strict JSON, no comments). */
export function renderCursorJson(cfg: McpServerConfig): string {
  return JSON.stringify(stdioJsonBlock(cfg), null, 2);
}

/** Gemini CLI: `mcpServers` in ~/.gemini/settings.json (same shape as Claude). */
export function renderGeminiJson(cfg: McpServerConfig): string {
  return JSON.stringify(stdioJsonBlock(cfg), null, 2);
}

/** Windsurf: `mcpServers` in ~/.codeium/windsurf/mcp_config.json (same shape as Claude). */
export function renderWindsurfJson(cfg: McpServerConfig): string {
  return JSON.stringify(stdioJsonBlock(cfg), null, 2);
}

/** VS Code / Copilot: `.vscode/mcp.json` nests under `servers` with `type: "stdio"`. */
export function renderVscodeJson(cfg: McpServerConfig): string {
  const block: Record<string, unknown> = { type: 'stdio', command: cfg.command, args: [...cfg.args] };
  if (Object.keys(cfg.env).length > 0) {
    block['env'] = { ...cfg.env };
  }
  return JSON.stringify({ servers: { 'aegisx-memory': block } }, null, 2);
}

/** Codex: [mcp_servers.aegisx-memory] table in ~/.codex/config.toml. */
export function renderCodexToml(cfg: McpServerConfig): string {
  const q = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines = [
    '[mcp_servers.aegisx-memory]',
    `command = ${q(cfg.command)}`,
    `args = [${cfg.args.map(q).join(', ')}]`,
  ];
  if (Object.keys(cfg.env).length > 0) {
    lines.push('', '[mcp_servers.aegisx-memory.env]');
    for (const [key, value] of Object.entries(cfg.env)) {
      lines.push(`${key} = ${q(value)}`);
    }
  }
  return lines.join('\n');
}

/** Where each agent's block goes — shown as guidance. */
export function configTarget(agent: McpAgent): string {
  switch (agent) {
    case 'hermes':
      return '~/.hermes/config.yaml → merge the aegisx-memory: entry under mcp_servers:';
    case 'claude':
      return 'claude_desktop_config.json (Desktop) or .mcp.json (Claude Code) → merge the aegisx-memory entry under mcpServers';
    case 'cursor':
      return '~/.cursor/mcp.json (Settings → MCP) → merge the aegisx-memory entry under mcpServers';
    case 'gemini':
      return '~/.gemini/settings.json → merge the aegisx-memory entry under mcpServers';
    case 'codex':
      return '~/.codex/config.toml → append the [mcp_servers.aegisx-memory] table';
    case 'windsurf':
      return '~/.codeium/windsurf/mcp_config.json → merge the aegisx-memory entry under mcpServers';
    case 'vscode':
      return '.vscode/mcp.json in the workspace → merge the aegisx-memory entry under servers';
  }
}

/** Render one agent's block or all three, with copy-paste-ready headers. */
export function renderConfig(agent: string, cfg: McpServerConfig): string {
  const single = new Map<McpAgent, () => string>([
    ['hermes', () => renderHermesYaml(cfg)],
    ['claude', () => renderClaudeJson(cfg)],
    ['cursor', () => renderCursorJson(cfg)],
    ['gemini', () => renderGeminiJson(cfg)],
    ['codex', () => renderCodexToml(cfg)],
    ['windsurf', () => renderWindsurfJson(cfg)],
    ['vscode', () => renderVscodeJson(cfg)],
  ]);
  if (agent !== 'all') {
    const render = single.get(agent as McpAgent);
    if (render === undefined) {
      throw new AegisxError('user', `unknown agent "${agent}"; expected one of: ${MCP_AGENTS.join(', ')}, all`);
    }
    return render();
  }
  // Human-readable overview: banners make section boundaries obvious; the
  // JSON sections below are still pure JSON between their banner lines.
  const banner = (title: string): string => `# ─── ${title} ───`;
  return [
    banner('Hermes'),
    renderHermesYaml(cfg),
    '',
    banner('Claude'),
    renderClaudeJson(cfg),
    '',
    banner('Cursor'),
    renderCursorJson(cfg),
    '',
    banner('Gemini CLI'),
    renderGeminiJson(cfg),
    '',
    banner('Codex CLI'),
    renderCodexToml(cfg),
    '',
    banner('Windsurf'),
    renderWindsurfJson(cfg),
    '',
    banner('VS Code / Copilot'),
    renderVscodeJson(cfg),
  ].join('\n');
}

/** Parse & validate the agent argument (shared by CLI). */
export function parseAgentArg(value: string | undefined): string {
  const agent = value ?? 'all';
  if (agent !== 'all' && !MCP_AGENTS.includes(agent as McpAgent)) {
    throw new AegisxError('user', `unknown agent "${agent}"; expected one of: ${MCP_AGENTS.join(', ')}, all`);
  }
  return agent;
}
