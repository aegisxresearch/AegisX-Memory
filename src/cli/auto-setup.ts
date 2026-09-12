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

export type SetupAgent = 'hermes' | 'claude' | 'cursor' | 'gemini' | 'codex' | 'windsurf' | 'vscode';
export const SETUP_AGENTS: readonly SetupAgent[] = ['hermes', 'claude', 'cursor', 'gemini', 'codex', 'windsurf', 'vscode'];

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
  /** Override the behavior-rules file location (used by tests). */
  rulesPath?: string;
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

/* ---------------------------------------------------------- agent detection */

/** One probe per agent: where its config lives and whether it exists.
 *  Env-var aware because every configPathFor honors the same overrides — a
 *  detection that ignored $HERMES_HOME would disagree with the writer that
 *  consumes it. `vscode` is repo-scoped by design (`.vscode/mcp.json`), so it
 *  only reports `true` when the caller anchors a project directory. */
export interface AgentProbe {
  agent: SetupAgent;
  configPath: string;
  installed: boolean;
}

/** Detect which agents have a config file on this machine. Pure and cheap:
 *  stat calls only, no parsing — existence is the signal, because an agent
 *  writes its config on first launch even before any MCP server is added. */
export function detectInstalledAgents(projectDir?: string): AgentProbe[] {
  return SETUP_AGENTS.map((agent) => {
    let configPath = configPathFor(agent);
    if (agent === 'vscode' && projectDir !== undefined) {
      configPath = path.join(projectDir, '.vscode', 'mcp.json');
    }
    let installed: boolean;
    try {
      installed = fs.statSync(configPath).isFile();
    } catch {
      installed = false;
    }
    return { agent, configPath, installed };
  });
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
    case 'gemini':
      // GEMINI_CLI_HOME points at the CLI's home directory, not the file.
      return expand(process.env['GEMINI_CLI_HOME'] !== undefined && process.env['GEMINI_CLI_HOME'] !== ''
        ? path.join(process.env['GEMINI_CLI_HOME'], 'settings.json')
        : path.join(os.homedir(), '.gemini', 'settings.json'));
    case 'codex':
      // CODEX_HOME likewise names the directory holding config.toml.
      return expand(process.env['CODEX_HOME'] !== undefined && process.env['CODEX_HOME'] !== ''
        ? path.join(process.env['CODEX_HOME'], 'config.toml')
        : path.join(os.homedir(), '.codex', 'config.toml'));
    case 'windsurf':
      return path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json');
    case 'vscode':
      return path.join(process.cwd(), '.vscode', 'mcp.json');
  }
}

/** Which installer writes this agent's config. Doctors and tests branch on it. */
export function agentInstaller(agent: SetupAgent): 'yaml' | 'json' | 'toml' | 'vscode-json' {
  switch (agent) {
    case 'hermes': return 'yaml';
    case 'codex': return 'toml';
    case 'vscode': return 'vscode-json';
    default: return 'json';
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

/** The plain `mcpServers` mapping used by Claude Desktop, Cursor and Windsurf.
 *  VS Code is deliberately separate: its file nests the servers under a
 *  top-level `servers` key and (per its schema) wants `type: "stdio"` on each
 *  entry — sharing this function would write a file the agent ignores. */
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

/* ----------------------------------------------------------- VS Code JSON */

/** VS Code (Copilot agent mode): `.vscode/mcp.json` nests servers under a
 *  top-level `servers` key, and its schema wants `type: "stdio"` on each
 *  entry — a plain `mcpServers` file is ignored by the Agent Host. */
function installVscode(file: string, cfg: McpServerConfig): SetupResult {
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

  const servers = (root['servers'] !== null && typeof root['servers'] === 'object' && !Array.isArray(root['servers'])
    ? root['servers']
    : {}) as Record<string, unknown>;
  const block: Record<string, unknown> = { type: 'stdio', command: cfg.command, args: [...cfg.args] };
  if (Object.keys(cfg.env).length > 0) {
    block['env'] = { ...cfg.env };
  }
  const before = JSON.stringify(servers);
  servers['aegisx-memory'] = block;
  if (JSON.stringify(servers) === before) {
    return { agent: 'vscode', configPath: file, action: 'unchanged', backupPath: null };
  }
  root['servers'] = servers;

  let backupPath: string | null = null;
  if (existing !== null) backupPath = backup(file, existing);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(root, null, 2)}\n`);
  return { agent: 'vscode', configPath: file, action: existing === null ? 'created' : 'updated', backupPath };
}

/* ------------------------------------------------------------- Codex TOML */

/** Escape a TOML basic-string payload (RFC 4180 subset Codex parses). */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Codex CLI reads `[mcp_servers.<name>]` tables from `~/.codex/config.toml`.
 * Written with zero dependencies: the block is appended as text, never by
 * re-serializing the file — every byte outside the appended block is preserved
 * exactly, which is the safest possible merge for a config this writer cannot
 * fully parse. Detecting an existing entry is a bounded text scan instead of a
 * TOML parse: it matches both `[mcp_servers.aegisx-memory]` and the dotted
 * form, and anything ambiguous is treated as present (never duplicated).
 */
function installCodex(file: string, cfg: McpServerConfig): SetupResult {
  const existing = readText(file);
  if (existing !== null && /^\s*\[mcp_servers\.(?:"?)aegisx-memory(?:"?)\]\s*$/m.test(existing)) {
    return { agent: 'codex', configPath: file, action: 'unchanged', backupPath: null };
  }
  const lines = [
    '',
    '# aegisx-memory: persistent project memory (added by `aegisxmemory setup`)',
    '[mcp_servers.aegisx-memory]',
    `command = ${tomlString(cfg.command)}`,
    `args = [${cfg.args.map(tomlString).join(', ')}]`,
  ];
  if (Object.keys(cfg.env).length > 0) {
    lines.push('', '[mcp_servers.aegisx-memory.env]');
    for (const [key, value] of Object.entries(cfg.env)) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }
  // A file ending without a newline would glue the first line to the last one.
  const content = `${existing ?? ''}${existing !== null && !existing.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`;
  let backupPath: string | null = null;
  if (existing !== null) backupPath = backup(file, existing);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return { agent: 'codex', configPath: file, action: existing === null ? 'created' : 'updated', backupPath };
}

/* ------------------------------------------------- behavior rules (auto memory) */

export interface RulesResult {
  agent: SetupAgent;
  path: string;
  /** created = file did not exist · updated = block (re)written · unchanged = already present */
  action: 'created' | 'updated' | 'unchanged';
  backupPath: string | null;
}

export const RULES_BEGIN = '<!-- aegisx-memory:auto-rules BEGIN -->';
export const RULES_END = '<!-- aegisx-memory:auto-rules END -->';

/**
 * The standing-behavior block — the contract that makes memory automatic
 * instead of opt-in, injected into every agent's own instructions file.
 *
 * Two deliberate design choices.
 *
 * 1. **Tool names are generic.** They differ per client (Hermes prefixes with
 *    `mcp__aegisx_memory__`, Claude with `mcp__aegisx-memory__`), so the rules
 *    name the tool by what it does. Wiring lives in `doctor`, not here.
 * 2. **It explains the coverage line.** Since v1.29 every recall block ends by
 *    stating what it left out. An agent that does not know what `(more exist)`
 *    or `budget dropped` mean will misread a clipped block as an empty store —
 *    which is precisely the bug this block exists to prevent.
 */
export function memoryRulesBlock(): string {
  return [
    RULES_BEGIN,
    '## AegisX-Memory — project memory (do this automatically)',
    '',
    'A local memory engine holds this project\u2019s facts, decisions, gotchas and handoffs.',
    'It is where the answers to \u201cwhat did we already work out?\u201d live. Nothing leaves this machine.',
    'Loading it costs a few hundred tokens; re-reading the code it replaces costs thousands.',
    '',
    '### Start of a session — before you read any file',
    '',
    '- Call the aegisx-memory `recall` tool for the current repo. It may appear under the client\u2019s own tool prefix \u2014 same tool.',
    '- If the block shows no indexed files for this repo, call `index` on it once, then recall again.',
    '- Read its closing coverage line. It states what the block left out:',
    '  - `complete` \u2014 nothing was withheld; do not fetch more.',
    '  - `(more exist)` or `budget dropped \u2026` \u2014 the block was clipped. Query for what you',
    '    need (`recall \"<the task at hand>\"`) instead of concluding the rest is empty.',
    '  - `N in handoff` \u2014 those notes are printed in the handoff section below, not lost.',
    '- Then read only the code the block does not already cover.',
    '',
    '### While working',
    '',
    '- A focused query beats a bare one: `recall \"token rotation\"`, not `recall`.',
    '- Learned a stable fact (test command, port, stack, build step)? Persist it now with',
    '  `remember`, keyed like `project.<name>.<key>`. Short values; re-pinning a key keeps the',
    '  old value, which recall reports as `was \u2026`.',
    '- Made or hit a **decision, gotcha, convention or lesson**? Put it in the matching list of',
    '  the next `save` handoff \u2014 each entry becomes searchable knowledge. A note that lives',
    '  only in this chat is lost to the next session.',
    '- One self-contained sentence per note, **with the reason**: \u201cuse sqlite, not postgres \u2014',
    '  zero-config\u201d. A vague note is worse than none: it spends recall budget and still cannot',
    '  be found.',
    '',
    '### Correcting memory',
    '',
    '- Memory is yours to fix, not permanent: `knowledge --forget <id>` deletes an entry, and',
    '  re-recording the same sentence replaces it in place.',
    '- Do not record what the repo already states \u2014 paths, line numbers, file contents. Store',
    '  conclusions, not sources.',
    '',
    '### End of a session (or after a meaningful change)',
    '',
    '- Call `save` with a JSON handoff: `goal`, `facts`, `decisions`, `gotchas`, `conventions`,',
    '  `nextSteps`. This is what makes the next session start warm. No categories apply? Save the',
    '  goal and next steps anyway.',
    '',
    '### Never',
    '',
    '- Never store secrets \u2014 API keys, passwords, tokens, credentialed URLs. The engine refuses',
    '  them; do not work around the refusal.',
    '- Never paste whole files into memory.',
    RULES_END,
  ].join('\n');
}

/**
 * Seed identity for a freshly created Hermes SOUL.md, so installing the memory
 * rules never leaves the agent without a persona — and so the working habits the
 * memory contract depends on (verify with real output, say what is unknown) are
 * stated next to it rather than assumed.
 */
const SOUL_SEED = [
  '# Identity',
  '',
  'You are Hermes, a direct, technically sharp AI assistant. Match reply length to the',
  'weight of the ask; be concrete and verify claims with real tool output.',
  '',
  '# Working style',
  '',
  '- One real run beats several guesses: execute, read the output, then explain.',
  '- Say what you did not verify. A stated unknown is worth more than a confident mistake.',
  '- When a change is done, state the evidence — command, result, and what it proves.',
  '',
].join('\n');

/** Default standing-rules file per agent (SOUL.md for Hermes per docs).
 *  Agents without a known instructions file return null: the repo-level
 *  AGENTS.md (installProjectRules) is their rules carrier instead. */
export function rulesPathFor(agent: SetupAgent): string | null {
  switch (agent) {
    case 'hermes': {
      const home = process.env['HERMES_HOME'];
      return home !== undefined && home !== '' ? path.join(home, 'SOUL.md') : path.join(os.homedir(), '.hermes', 'SOUL.md');
    }
    case 'claude': {
      // CLAUDE_CONFIG_DIR is a directory (Claude Code's config home) — the
      // rules file lives inside it, not at its path.
      const dir = process.env['CLAUDE_CONFIG_DIR'];
      return expand(dir !== undefined && dir !== '' ? path.join(dir, 'CLAUDE.md') : path.join(os.homedir(), '.claude', 'CLAUDE.md'));
    }
    case 'cursor':
      return path.join(os.homedir(), '.cursor', 'rules', 'aegisx-memory.mdc');
    case 'gemini':
      return expand(process.env['GEMINI_CLI_HOME'] !== undefined && process.env['GEMINI_CLI_HOME'] !== ''
        ? path.join(process.env['GEMINI_CLI_HOME'], 'GEMINI.md')
        : path.join(os.homedir(), '.gemini', 'GEMINI.md'));
    // Codex reads AGENTS.md natively; Windsurf/VS Code have no home-level
    // instructions file — their contract lives in the repo's AGENTS.md.
    case 'codex':
    case 'windsurf':
    case 'vscode':
      return null;
  }
}

function upsertRulesBlock(existing: string | null, block: string): string {
  if (existing === null) return `${block}\n`;
  const re = new RegExp(`${RULES_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${RULES_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  return re.test(existing) ? existing.replace(re, block) : `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
}

/**
 * Install the auto-memory behavior rules into an agent's standing-instructions
 * file (Hermes SOUL.md, Claude CLAUDE.md, Cursor rules, Gemini GEMINI.md).
 * Agents without a known file (codex/windsurf/vscode) are a no-op — their
 * contract travels via the repo's AGENTS.md. Idempotent, backed up, and never
 * touches content outside the marker-wrapped block.
 */
export function installRulesForAgent(agent: SetupAgent, options: RawOptions = {}): RulesResult {
  const file = options.rulesPath ?? rulesPathFor(agent);
  if (file === null) {
    return { agent, path: '(repo AGENTS.md via --project-rules)', action: 'unchanged', backupPath: null };
  }
  const existing = readText(file);
  let content: string;
  if (existing === null) {
    content = agent === 'hermes' ? `${SOUL_SEED}\n${memoryRulesBlock()}\n` : `${memoryRulesBlock()}\n`;
  } else {
    const updated = upsertRulesBlock(existing, memoryRulesBlock());
    if (updated === existing) {
      return { agent, path: file, action: 'unchanged', backupPath: null };
    }
    content = updated;
  }
  let backupPath: string | null = null;
  if (existing !== null) backupPath = backup(file, existing);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return { agent, path: file, action: existing === null ? 'created' : 'updated', backupPath };
}

/* ------------------------------------------- project-level rules (AGENTS.md) */

/**
 * The rules block written into a *repository* instead of one client's config.
 *
 * `AGENTS.md` is the closest thing to a universal convention: Codex, Cursor,
 * Copilot, Gemini CLI, Zed and others look for it at a project root, so a repo
 * that carries the contract works with agents this setup never learned to
 * configure. It is the fallback that keeps "memory is automatic" true for
 * clients there is no writer for — and it travels with the repo, so a
 * collaborator's agent inherits the habits without installing anything.
 */
export const PROJECT_RULES_FILE = 'AGENTS.md';

export interface ProjectRulesResult {
  path: string;
  action: 'created' | 'updated' | 'unchanged';
  backupPath: string | null;
}

function projectRulesHeader(): string {
  return [
    '# Project agent rules',
    '',
    '<!-- Managed by aegisx-memory: only the marked block below is rewritten on',
    '     install. Everything outside the markers is yours and is never touched. -->',
    '',
  ].join('\n');
}

/** Install the memory contract into `<repoDir>/AGENTS.md`. Idempotent, backed up. */
export function installProjectRules(repoDir: string): ProjectRulesResult {
  const file = path.join(path.resolve(repoDir), PROJECT_RULES_FILE);
  const existing = readText(file);
  if (existing === null || existing.trim() === '') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${projectRulesHeader()}${memoryRulesBlock()}\n`);
    return { path: file, action: 'created', backupPath: null };
  }
  const updated = upsertRulesBlock(existing, memoryRulesBlock());
  if (updated === existing) {
    return { path: file, action: 'unchanged', backupPath: null };
  }
  const backupPath = backup(file, existing);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, updated);
  return { path: file, action: 'updated', backupPath };
}

/** Human-readable summary line for a project-rules install. */
export function describeProjectRulesResult(r: ProjectRulesResult): string {
  switch (r.action) {
    case 'created':
      return `✓ project: behavior rules written to ${r.path}`;
    case 'updated':
      return `✓ project: behavior rules updated in ${r.path} (backup: ${r.backupPath})`;
    case 'unchanged':
      return `✓ project: behavior rules already present in ${r.path}`;
  }
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
  switch (agentInstaller(agent)) {
    case 'yaml':
      return installHermes(file, cfg);
    case 'toml':
      return installCodex(file, cfg);
    case 'vscode-json':
      return installVscode(file, cfg);
    default:
      return installJson(file, cfg, agent);
  }
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

/** Human-readable summary line for a behavior-rules install. */
export function describeRulesResult(r: RulesResult): string {
  switch (r.action) {
    case 'created':
      return `✓ ${r.agent}: behavior rules written to ${r.path}`;
    case 'updated':
      return `✓ ${r.agent}: behavior rules updated in ${r.path} (backup: ${r.backupPath})`;
    case 'unchanged':
      return `✓ ${r.agent}: behavior rules already present in ${r.path}`;
  }
}
