/**
 * `aegisxmemory uninstall` — the exact reverse of install, file by file.
 *
 * Symmetry is the contract: every writer in auto-setup.ts / hooks.ts has a
 * remover here that touches only what its installer wrote.
 *
 * What removal means, per artifact:
 *   MCP registration   the `aegisx-memory` entry leaves the agent's config;
 *                      sibling servers are preserved byte-for-byte where the
 *                      format allows, and a file the installer *created*
 *                      (nothing else in it) is deleted outright.
 *   behavior rules     only the marker-wrapped block is cut; SOUL.md's
 *                      identity seed and any user text stay. A rules file the
 *                      installer created (seed + block only) is deleted.
 *   Claude hooks       only entries carrying the aegisx markers are removed;
 *                      groups left empty by the removal are dropped too.
 *   project AGENTS.md  only the marked block (and the managed header when we
 *                      wrote the whole file) is removed; user content stays.
 *
 * What removal NEVER means: memory data. ~/.aegisx holds your facts, knowledge
 * and handoffs — that is the user's archive, and uninstall is about wiring,
 * not history. The final summary says so explicitly.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDocument, isMap, isScalar, isSeq, stringify, type YAMLMap } from 'yaml';
import { AegisxError } from '../core/types.js';
import {
  PROJECT_RULES_FILE,
  RULES_BEGIN,
  RULES_END,
  agentInstaller,
  configPathFor,
  rulesPathFor,
  type SetupAgent,
} from './auto-setup.js';
import { HERMES_HOOK_EVENTS, HERMES_HOOK_SCRIPTS } from './hermes-hooks.js';
import {
  HOOK_POST_EDIT_MARKER,
  HOOK_SESSION_START_MARKER,
  claudeSettingsPath,
} from './hooks.js';

const SERVER_KEY = 'aegisx-memory';

export type UninstallAction = 'removed' | 'file-deleted' | 'absent' | 'error';

export interface UninstallResult {
  what: string;
  path: string;
  action: UninstallAction;
  backup: string | null;
  detail: string;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function backupFile(file: string, current: string): string {
  const backupPath = `${file}.aegisx-bak`;
  fs.writeFileSync(backupPath, current);
  return backupPath;
}

/** A rules file the installer created carries nothing but (optionally) the
 *  Hermes seed and the block — safe to delete rather than leave a husk. */
function isInstallerCreatedRules(content: string): boolean {
  const withoutBlock = content
    .replace(new RegExp(`${RULES_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${RULES_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '')
    .trim();
  // The seed's first line is the only other thing install writes.
  return withoutBlock === '' || withoutBlock === '# Identity' || withoutBlock.startsWith('# Identity\n');
}

/* ------------------------------------------------------------ MCP entries */

function removeJsonEntry(file: string, container: 'mcpServers' | 'servers'): UninstallResult {
  const existing = readText(file);
  if (existing === null) return { what: 'mcp', path: file, action: 'absent', backup: null, detail: 'config file does not exist' };
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(existing) as Record<string, unknown>;
  } catch (err) {
    return { what: 'mcp', path: file, action: 'error', backup: null, detail: `not valid JSON (${err instanceof Error ? err.message : String(err)}) — nothing removed` };
  }
  const servers = root[container];
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers) || !(SERVER_KEY in (servers as Record<string, unknown>))) {
    return { what: 'mcp', path: file, action: 'absent', backup: null, detail: 'no aegisx-memory entry' };
  }
  const map = servers as Record<string, unknown>;
  const backup = backupFile(file, existing);
  delete map[SERVER_KEY];
  if (Object.keys(map).length === 0) delete root[container];
  if (Object.keys(root).length === 0) {
    // The installer created this file; its removal is the honest uninstall.
    fs.rmSync(file);
    return { what: 'mcp', path: file, action: 'file-deleted', backup, detail: 'entry removed — file held nothing else, deleted' };
  }
  fs.writeFileSync(file, `${JSON.stringify(root, null, 2)}\n`);
  return { what: 'mcp', path: file, action: 'removed', backup, detail: 'entry removed, sibling entries preserved' };
}

function removeHermesEntry(file: string): UninstallResult {
  const existing = readText(file);
  if (existing === null) return { what: 'mcp', path: file, action: 'absent', backup: null, detail: 'config file does not exist' };
  let doc;
  try {
    doc = parseDocument(existing);
  } catch (err) {
    return { what: 'mcp', path: file, action: 'error', backup: null, detail: `not valid YAML (${err instanceof Error ? err.message : String(err)}) — nothing removed` };
  }
  const servers = doc.get('mcp_servers', true);
  if (!isMap(servers) || !servers.has(SERVER_KEY)) {
    return { what: 'mcp', path: file, action: 'absent', backup: null, detail: 'no aegisx-memory entry' };
  }
  const backup = backupFile(file, existing);
  (servers as YAMLLike).delete(SERVER_KEY);
  if (servers.items.length === 0) doc.delete('mcp_servers');
  const after = stringify(doc);
  // The yaml package renders an emptied document as `{}` — a husk the
  // installer created. Comments and any other top-level keys survive.
  if (after.trim() === '' || after.trim() === '{}') {
    fs.rmSync(file);
    return { what: 'mcp', path: file, action: 'file-deleted', backup, detail: 'entry removed — config held nothing else, deleted' };
  }
  fs.writeFileSync(file, after);
  return { what: 'mcp', path: file, action: 'removed', backup, detail: 'entry removed, sibling entries preserved' };
}

/** Minimal structural type for the YAML map node we mutate. */
interface YAMLLike {
  delete(key: string): boolean;
  items: unknown[];
}

function removeCodexEntry(file: string): UninstallResult {
  const existing = readText(file);
  if (existing === null) return { what: 'mcp', path: file, action: 'absent', backup: null, detail: 'config file does not exist' };
  const tableRe = /\n?\n# aegisx-memory: persistent project memory[^\n]*\n\[mcp_servers\.(?:\"?)aegisx-memory(?:\"?)\]\s*\n(?:(?!\[)[^\n]*\n)*/;
  const envRe = /\n\[mcp_servers\.(?:\"?)aegisx-memory(?:\"?)\.env\]\s*\n(?:(?!\[)[^\n]*\n?)*/;
  if (!/\[mcp_servers\.(?:\"?)aegisx-memory(?:\"?)\]/.test(existing)) {
    return { what: 'mcp', path: file, action: 'absent', backup: null, detail: 'no aegisx-memory entry' };
  }
  const backup = backupFile(file, existing);
  let after = existing.replace(tableRe, '\n').replace(envRe, '\n');
  if (!/\[mcp_servers\.(?:\"?)aegisx-memory(?:\"?)\]/.test(after)) {
    // The block carried the entry and a trailing blank line — tidy the join.
    after = after.replace(/\n{3,}/g, '\n\n');
  }
  if (after.trim() === '') {
    fs.rmSync(file);
    return { what: 'mcp', path: file, action: 'file-deleted', backup, detail: 'entry removed — config held nothing else, deleted' };
  }
  fs.writeFileSync(file, after);
  return { what: 'mcp', path: file, action: 'removed', backup, detail: 'entry removed, config text otherwise preserved byte-for-byte' };
}

/** Remove the MCP registration for one agent. Mirrors installForAgent. */
export function uninstallMcpForAgent(agent: SetupAgent, options: { configPath?: string } = {}): UninstallResult {
  const file = options.configPath ?? configPathFor(agent);
  switch (agentInstaller(agent)) {
    case 'yaml':
      return removeHermesEntry(file);
    case 'toml':
      return removeCodexEntry(file);
    case 'vscode-json':
      return removeJsonEntry(file, 'servers');
    default:
      return removeJsonEntry(file, 'mcpServers');
  }
}

/* ---------------------------------------------------------- behavior rules */

/** Remove the marker-wrapped rules block. Mirrors installRulesForAgent. */
export function uninstallRulesForAgent(agent: SetupAgent, options: { rulesPath?: string } = {}): UninstallResult {
  const file = options.rulesPath ?? rulesPathFor(agent);
  if (file === null) {
    return { what: 'rules', path: '(repo AGENTS.md via --project)', action: 'absent', backup: null, detail: 'this agent carries its rules in the repo AGENTS.md' };
  }
  const existing = readText(file);
  if (existing === null) return { what: 'rules', path: file, action: 'absent', backup: null, detail: 'rules file does not exist' };
  const re = new RegExp(`\\n?${RULES_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${RULES_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);
  if (!re.test(existing)) {
    return { what: 'rules', path: file, action: 'absent', backup: null, detail: 'no aegisx-memory rules block' };
  }
  const backup = backupFile(file, existing);
  const after = existing.replace(re, '\n').replace(/\n{3,}/g, '\n\n');
  if (isInstallerCreatedRules(after)) {
    fs.rmSync(file);
    return { what: 'rules', path: file, action: 'file-deleted', backup, detail: 'block removed — file was installer-created, deleted' };
  }
  fs.writeFileSync(file, after.trimEnd() + '\n');
  return { what: 'rules', path: file, action: 'removed', backup, detail: 'block removed, user content preserved' };
}

/* ------------------------------------------------------------ Claude hooks */

interface ClaudeHookGroup {
  matcher?: string;
  hooks: Array<{ type?: string; command?: string }>;
}

interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookGroup[]>;
  [key: string]: unknown;
}

/** Remove the aegisx hook entries from Claude Code settings.json. Mirrors
 *  installClaudeHooks: only marker-carrying commands are touched, emptied
 *  groups and empty hook maps are pruned, and a file the installer created is
 *  deleted. */
export function uninstallClaudeHooks(settingsFile: string): UninstallResult {
  const existing = readText(settingsFile);
  if (existing === null) return { what: 'hooks', path: settingsFile, action: 'absent', backup: null, detail: 'settings file does not exist' };
  let parsed: ClaudeSettings;
  try {
    parsed = JSON.parse(existing) as ClaudeSettings;
  } catch (err) {
    return { what: 'hooks', path: settingsFile, action: 'error', backup: null, detail: `not valid JSON (${err instanceof Error ? err.message : String(err)}) — nothing removed` };
  }
  const hooks = parsed.hooks;
  if (hooks === undefined || typeof hooks !== 'object') {
    return { what: 'hooks', path: settingsFile, action: 'absent', backup: null, detail: 'no hooks configured' };
  }
  const markerHit = (c: string | undefined): boolean => typeof c === 'string' && (c.includes(HOOK_SESSION_START_MARKER) || c.includes(HOOK_POST_EDIT_MARKER));
  let touched = false;
  const backup = backupFile(settingsFile, existing);
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const keptGroups: ClaudeHookGroup[] = [];
    for (const group of groups) {
      const kept = (group.hooks ?? []).filter((h) => !markerHit(h.command));
      if (kept.length !== (group.hooks ?? []).length) touched = true;
      if (kept.length > 0) keptGroups.push({ ...group, hooks: kept });
    }
    if (keptGroups.length === 0) delete hooks[event];
    else hooks[event] = keptGroups;
  }
  if (!touched) {
    fs.rmSync(backup); // nothing changed — do not leave a misleading backup
    return { what: 'hooks', path: settingsFile, action: 'absent', backup: null, detail: 'no aegisx hooks present' };
  }
  if (Object.keys(hooks).length === 0) delete parsed.hooks;
  if (Object.keys(parsed).length === 0) {
    fs.rmSync(settingsFile);
    return { what: 'hooks', path: settingsFile, action: 'file-deleted', backup, detail: 'hooks removed — settings held nothing else, deleted' };
  }
  fs.writeFileSync(settingsFile, `${JSON.stringify(parsed, null, 2)}\n`);
  return { what: 'hooks', path: settingsFile, action: 'removed', backup, detail: 'hooks removed, other settings preserved' };
}

/* ------------------------------------------------------- project AGENTS.md */

/** Remove the managed block from <repoDir>/AGENTS.md. Mirrors
 *  installProjectRules: user content outside the markers stays; a file the
 *  installer created is deleted whole. */
export function uninstallProjectRules(repoDir: string): UninstallResult {
  const file = path.join(path.resolve(repoDir), PROJECT_RULES_FILE);
  const existing = readText(file);
  if (existing === null) return { what: 'project', path: file, action: 'absent', backup: null, detail: 'no AGENTS.md in this repo' };
  const re = new RegExp(`\\n?${RULES_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${RULES_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);
  if (!re.test(existing)) {
    return { what: 'project', path: file, action: 'absent', backup: null, detail: 'no aegisx-memory rules block' };
  }
  const backup = backupFile(file, existing);
  const after = existing.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
  // Strip the managed header whenever it survives — it is ours, not the
  // user's, and a header promising "the marked block below" with no block
  // below would be a lie.
  const headerRe = /# Project agent rules\s*\n\s*<!-- Managed by aegisx-memory:[\s\S]*?-->\s*/;
  const body = headerRe.test(after) ? after.replace(headerRe, '').trim() : after;
  if (body === '') {
    fs.rmSync(file);
    return { what: 'project', path: file, action: 'file-deleted', backup, detail: 'block removed — file was installer-created, deleted' };
  }
  fs.writeFileSync(file, `${body}\n`);
  return { what: 'project', path: file, action: 'removed', backup, detail: 'block removed, your AGENTS.md content preserved' };
}

/* ----------------------------------------------------------------- facade */

export interface UninstallScope {
  /** Agents whose MCP entry (+ their rules file, when one exists) is unwired. */
  agents: SetupAgent[];
  /** Also remove the Claude Code hook pair. */
  hooks: boolean;
  /** Also strip the managed block from <repoDir>/AGENTS.md. */
  project: boolean;
  /** Repo root for --project (default: process cwd). */
  projectDir?: string;
  /** Claude Code settings path override (user scope by default). */
  claudeSettings?: string;
}

/** Run an uninstall. Returns one result per touched artifact — the CLI prints
 *  them; tests assert them. Never touches ~/.aegisx. */
export function runUninstall(scope: UninstallScope): UninstallResult[] {
  const out: UninstallResult[] = [];
  for (const agent of scope.agents) {
    out.push(uninstallMcpForAgent(agent));
    out.push(uninstallRulesForAgent(agent));
  }
  if (scope.hooks) {
    out.push(uninstallClaudeHooks(scope.claudeSettings ?? claudeSettingsPath(false)));
  }
  // Mirror of the Hermes hook installer: setup --agent hermes merges the
  // pre_llm_call/pre_verify pair into config.yaml, so unwiring hermes removes
  // it again — scripts included, config backup kept.
  if (scope.agents.includes('hermes')) {
    out.push(uninstallHermesHooks(configPathFor('hermes')));
  }
  // Mirror the installer, file for file: setup writes the repo AGENTS.md block
  // unconditionally (inside a repo) and auto-installs project-scope Claude
  // hooks when claude is among the targets — so an ordinary uninstall removes
  // both without forcing the user to remember `--project`. An explicit
  // --project still works, and an explicit home dir stays refused.
  const dir = scope.projectDir ?? process.cwd();
  const inRepo = path.resolve(dir) !== path.resolve(os.homedir());
  const mirror = uninstallMirrorTargets(scope.agents);
  if (scope.project || (inRepo && mirror.project)) {
    if (scope.project) assertNotHome(dir);
    out.push(uninstallProjectRules(dir));
  }
  if (scope.hooks || (inRepo && mirror.hooks)) {
    out.push(uninstallClaudeHooks(claudeSettingsPath(true, dir)));
  }
  return out;
}

/** Remove the Hermes hook pair the installer wrote: entries out of config.yaml
 *  (backup kept), the hook scripts deleted, and the agent-hooks dir removed
 *  only when we were the ones who emptied it (a dir still holding the user's
 *  own hooks stays). Idempotent: no block → absent. */
export function uninstallHermesHooks(configFile: string): UninstallResult {
  const what = 'hermes-hooks';
  if (!fs.existsSync(configFile)) return { what, path: configFile, action: 'absent', backup: null, detail: 'config file does not exist' };
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    return { what, path: configFile, action: 'error', backup: null, detail: `not valid YAML (${err instanceof Error ? err.message : String(err)}) — nothing removed` };
  }
  const hooks = doc.get('hooks', true) as unknown;
  if (!isMap(hooks)) return { what, path: configFile, action: 'absent', backup: null, detail: 'no hooks block' };

  let touched = false;
  const scriptFiles: string[] = [];
  // Iterate the installer's own event→script table: a hardcoded copy here left
  // the autosave script orphaned in agent-hooks the moment a third hook landed.
  for (const event of HERMES_HOOK_EVENTS) {
    const fileName = HERMES_HOOK_SCRIPTS[event];
    const list = hooks.get(event, true);
    if (!isSeq(list)) continue;
    const kept = list.items.filter((item: unknown) => {
      const cmd = isMap(item) && isScalar((item as YAMLMap).get('command', true)) ? String((item as YAMLMap).get('command', true)) : null;
      const ours = cmd !== null && cmd.includes(fileName);
      if (ours && cmd !== null) scriptFiles.push(cmd);
      return !ours;
    });
    if (kept.length !== list.items.length) {
      touched = true;
      if (kept.length === 0) hooks.delete(event);
      else list.items = kept;
    }
  }
  if (!touched) return { what, path: configFile, action: 'absent', backup: null, detail: 'no aegisx hook entries' };

  // One uninstall run can touch one file through several removers (mcp, then
  // hooks). The backup must capture the file as it was BEFORE the run, so only
  // the first remover writes it — a second write would clobber the snapshot
  // with a half-dismantled state.
  const firstBackup = (file: string): string => {
    const p = `${file}.aegisx-bak`;
    if (fs.existsSync(p)) return p;
    return backupFile(file, fs.readFileSync(file, 'utf8'));
  };
  const backup = firstBackup(configFile);

  // If the hooks map is now empty and this file was ours alone, drop the key.
  if (hooks.items.length === 0) doc.delete('hooks');

  // `hooks_auto_accept` is written by the installer alongside the hook pair.
  // If nothing else remains (no model block, no mcp_servers, no user keys),
  // the file was ours alone and the honest removal deletes it — same contract
  // as the MCP/rules removers, instead of leaving a one-key husk.
  const remaining = doc.toJS() as unknown;
  const remainingKeys = remaining !== null && typeof remaining === 'object' && !Array.isArray(remaining) ? Object.keys(remaining as Record<string, unknown>) : [];
  const oursAlone = remainingKeys.every((key) => key === 'hooks_auto_accept');

  // Scripts first, whichever way the config file ends up: the file-deleted
  // path used to return before this loop, so a config we deleted outright left
  // its hook scripts orphaned in agent-hooks.
  const removeScripts = (): void => {
    for (const script of scriptFiles) {
      try {
        fs.rmSync(script, { force: true });
      } catch {
        // best effort — the config entry is gone either way
      }
    }
    // Then the folder, if we emptied it: Hermes keeps user hooks in the same
    // directory, so an occupied dir stays and a bare empty one goes.
    for (const dir of new Set(scriptFiles.map((script) => path.dirname(script)))) {
      try {
        if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        // missing, occupied, or not removable — nothing to do
      }
    }
  };

  if (oursAlone && remainingKeys.length <= 1) {
    const kept = firstBackup(configFile);
    fs.rmSync(configFile, { force: true });
    removeScripts();
    return { what, path: configFile, action: 'file-deleted', backup: kept, detail: 'hook entries removed — config held nothing else, deleted' };
  }
  doc.delete('hooks_auto_accept');

  fs.writeFileSync(configFile, String(doc));
  removeScripts();
  return { what, path: configFile, action: 'removed', backup, detail: 'hook entries removed from config.yaml, scripts deleted' };
}

/** Which installer extras a plain uninstall mirrors for these agents: the
 *  repo AGENTS.md block (agents that carry their rules there) and the
 *  project-scope Claude hook pair (installed when claude is targeted). The
 *  CLI's --dry-run prints from the same predicate, so the preview can never
 *  drift from what a real run removes. */
export function uninstallMirrorTargets(agents: SetupAgent[]): { project: boolean; hooks: boolean } {
  return {
    project: agents.some((agent) => rulesPathFor(agent) === null),
    hooks: agents.includes('claude'),
  };
}

export function describeUninstall(r: UninstallResult): string {
  const icon = r.action === 'error' ? '✗' : r.action === 'absent' ? '·' : '✓';
  return `${icon} ${r.what}: ${r.action} — ${r.path}${r.backup === null ? '' : ` (backup: ${r.backup})`}\n  ${r.detail}`;
}

/** Guard the CLI against a nonsense invocation: a project flag without a repo
 *  (home dir) would scatter nothing, but saying so beats silence. */
export function assertNotHome(dir: string): void {
  if (path.resolve(dir) === path.resolve(os.homedir())) {
    throw new AegisxError('user', 'refusing to run uninstall with the home directory as the project — pass the repo you wired');
  }
}
