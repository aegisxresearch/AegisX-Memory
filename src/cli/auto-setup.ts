/**
 * Auto-setup: writes the AegisX-Memory MCP registration directly into known
 * agent config files (Hermes, Claude, Cursor) so users never hand-edit YAML.
 *
 * Safety rules (RFC §5 spirit — configs belong to the user):
 *  - every existing file is backed up next to itself before the first write
 *  - a file that does not parse is refused, never overwritten
 *  - other entries/comments are preserved (YAML Document API / JSON re-parse)
 *  - running twice changes nothing (idempotent) — reports `unchanged`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument, stringify as stringifyYaml, type YAMLMap } from 'yaml';
import type { McpServerConfig } from './mcp-config.js';
import { AegisxError } from '../core/types.js';

export type SetupAgent = 'hermes' | 'claude' | 'cursor';
export const SETUP_AGENTS: readonly SetupAgent[] = ['hermes', 'claude', 'cursor'];

export interface SetupResult {
  agent: SetupAgent;
  configPath: string;
  /** created = file did not exist · updated = merged into existing · unchanged = already correct */
  action: 'created' | 'updated' | 'unchanged';
  backupPath: string | null;
}

interface RawOptions {
  /** Override the config file location (used by tests). */
  configPath?: string;
  /** Registration to write; defaults to the `node <entry> mcp` block. */
  config?: McpServerConfig;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Back up `file` beside itself once per install run; returns the backup path. */
function backup(file: string, current: string): string {
  const backupPath = `${file}.aegisx-bak`;
  fs.writeFileSync(backupPath, current);
  return backupPath;
}

function expand(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Default config file location per agent — mirrors doctor.ts detection. */
export function configPathFor(agent: SetupAgent): string {
  switch (agent) {
    case 'hermes': {
      const home = process.env['HERMES_HOME'];
      return home !== undefined && home !== '' ? path.join(home, 'config.yaml') : path.join(os.homedir(), '.hermes', 'config.yaml');
    }
    case 'claude':
      return expand(process.env['CLAUDE_CONFIG'] ?? path.join(os.homedir(), '.claude', 'claude_desktop_config.json'));
    case 'cursor':
      return path.join(os.homedir(), '.cursor', 'mcp.json');
  }
}

/* ------------------------------------------------------------- Hermes YAML */

function installHermes(file: string, cfg: McpServerConfig): SetupResult {
  const existing = readText(file);
  if (existing !== null) {
    // Refuse (never clobber) a config we cannot parse.
    try {
      const probe = parseYaml(existing);
      if (probe !== null && probe !== undefined && typeof probe !== 'object') {
        throw new Error('not a mapping');
      }
    } catch (err) {
      throw new AegisxError(
        'user',
        `${file} is not valid YAML; fix it manually (a backup-free edit) before auto-setup: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const doc = existing === null || existing.trim() === '' ? parseDocument('') : parseDocument(existing);
  // NOTE: doc.set(key, {}) stores a plain JS object — doc.get(key, true) then
  // returns that Object, not a YAMLMap. Always create a real node so the
  // isMap guard below and nested serverMap.set behave as YAML nodes.
  if (!doc.has('mcp_servers')) {
    doc.set('mcp_servers', doc.createNode({}));
  } else {
    // keepNode=true → the AST node, not the plain-JS value, so node-type
    // checks below are reliable.
    const node = doc.get('mcp_servers', true);
    // Tolerate the two harmless empty shapes — an unset key (`mcp_servers:`)
    // and the empty list some setups ship as a default (`mcp_servers: []`):
    // neither holds data, so both convert cleanly to the mapping Hermes wants.
    const emptyKey = node === undefined || node === null || (isScalar(node) && node.value === null);
    const emptyList = isSeq(node) && node.items.length === 0;
    if (emptyKey || emptyList) {
      doc.set('mcp_servers', doc.createNode({}));
    }
  }
  const servers = doc.get('mcp_servers', true);
  if (!isMap(servers)) {
    const found = isSeq(servers)
      ? `a list with ${servers.items.length} item(s)`
      : isScalar(servers)
        ? 'a plain value'
        : 'an unknown node';
    throw new AegisxError(
      'user',
      `${file}: "mcp_servers" is ${found}, not a mapping — move those entries under named keys (server-name → command/args) or merge the aegisx-memory entry manually`,
    );
  }
  const serverMap = servers as YAMLMap;

  const entry: Record<string, unknown> = { command: cfg.command, args: [...cfg.args], connect_timeout: 30, timeout: 60 };
  if (Object.keys(cfg.env).length > 0) {
    entry['env'] = { ...cfg.env };
  }
  const before = stringifyYaml(doc);
  serverMap.set('aegisx-memory', entry);
  const after = stringifyYaml(doc);
  if (after === before) {
    return { agent: 'hermes', configPath: file, action: 'unchanged', backupPath: null };
  }

  let backupPath: string | null = null;
  if (existing !== null) backupPath = backup(file, existing);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, after);
  return { agent: 'hermes', configPath: file, action: existing === null ? 'created' : 'updated', backupPath };
}

/* ------------------------------------------------------- Claude/Cursor JSON */

function installJson(file: string, cfg: McpServerConfig, agent: SetupAgent): SetupResult {
  const existing = readText(file);
  let root: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
      root = parsed as Record<string, unknown>;
    } catch (err) {
      throw new AegisxError(
        'user',
        `${file} is not valid JSON; fix it manually before auto-setup: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const servers = (root['mcpServers'] !== null && typeof root['mcpServers'] === 'object' && !Array.isArray(root['mcpServers'])
    ? root['mcpServers']
    : {}) as Record<string, unknown>;
  const block: Record<string, unknown> = { command: cfg.command, args: [...cfg.args] };
  if (Object.keys(cfg.env).length > 0) {
    block['env'] = { ...cfg.env };
  }
  const before = JSON.stringify(servers);
  servers['aegisx-memory'] = block;
  if (JSON.stringify(servers) === before) {
    return { agent, configPath: file, action: 'unchanged', backupPath: null };
  }
  root['mcpServers'] = servers;

  let backupPath: string | null = null;
  if (existing !== null) backupPath = backup(file, existing);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(root, null, 2)}\n`);
  return { agent, configPath: file, action: existing === null ? 'created' : 'updated', backupPath };
}

/* ---------------------------------------------------------------- public API */

/**
 * Install (or silently update) the aegisx-memory MCP registration for one
 * agent. Never interactive, never destructive: refuses unparseable configs,
 * backs up before first write, and is a no-op when already correct.
 */
export function installForAgent(agent: SetupAgent, options: RawOptions = {}): SetupResult {
  const cfg = options.config ?? { command: 'node', args: [], env: {} };
  const file = options.configPath ?? configPathFor(agent);
  return agent === 'hermes' ? installHermes(file, cfg) : installJson(file, cfg, agent);
}

/** Human-readable summary line per agent, for the CLI. */
export function describeResult(r: SetupResult): string {
  switch (r.action) {
    case 'created':
      return `✓ ${r.agent}: created ${r.configPath}`;
    case 'updated':
      return `✓ ${r.agent}: registered in ${r.configPath} (backup: ${r.backupPath})`;
    case 'unchanged':
      return `✓ ${r.agent}: already registered in ${r.configPath}`;
  }
}
