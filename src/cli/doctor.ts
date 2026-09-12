/**
 * Doctor: one-command health check.
 *  1. DB integrity (SQLite PRAGMA integrity_check)
 *  2. Schema state (fresh file vs migrated tables)
 *  3. Index freshness (read-only drift between ledger and disk)
 *  4. MCP registration detection (Hermes / Claude / Cursor config files)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeRepoPath } from '../core/paths.js';
import { AegisxError } from '../core/types.js';
import { SETUP_AGENTS } from './auto-setup.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Actionable fix shown for warn/fail. */
  fix?: string;
}

export interface McpRegistration {
  agent: string;
  configPath: string;
  command: string;
  args: string[];
  entryExists: boolean;
  matchesAegisx: boolean;
}

export interface DoctorReport {
  checks: Check[];
  mcpServers: McpRegistration[];
  passed: boolean;
  /** Present only when doctor ran with fix enabled. */
  fixes?: DoctorFixes;
}

export interface DoctorFixes {
  applied: string[];
  /** Issues deliberately not auto-fixed, with the reason. */
  skipped: string[];
}

interface DriftResult {
  indexedFiles: number;
  onDiskFiles: number;
  missingFromDisk: string[];
  notIndexed: string[];
  hashChanged: string[];
}

interface IndexStats {
  filesTotal: number;
  filesChanged: number;
  filesSkipped: number;
}

interface DoctorEngine {
  dbIntegrityCheck(): string;
  dbTableNames(): string[];
  /** Record of the one-time knowledge backfill, when it has run. */
  knowledgeBackfillReport(): string | undefined;
  driftCheck(repo: string): DriftResult;
  indexRepo(repoAbsPath: string, onWarn?: (msg: string) => void): IndexStats;
  close(): void;
}

/* --------------------------------------------------- engine wiring seam */

let engineCtor: (new (dbFile: string) => DoctorEngine) | null = null;

/** Wire the real Engine (called by the CLI); tests may inject a fake. */
export function setEngineConstructor(ctor: new (dbFile: string) => DoctorEngine): void {
  engineCtor = ctor;
}

function requireEngine(): new (dbFile: string) => DoctorEngine {
  if (engineCtor !== null) {
    return engineCtor;
  }
  throw new AegisxError('internal', 'engine constructor not wired; call setEngineConstructor first');
}

function withEngine<T>(dbFile: string, fn: (engine: DoctorEngine) => T): T {
  const EngineCtor = requireEngine();
  const engine = new EngineCtor(dbFile);
  try {
    return fn(engine);
  } finally {
    engine.close();
  }
}

/* ------------------------------------------------------------- DB checks */

/** The `meta` record left by the one-time knowledge backfill (see Store). */
interface BackfillRecord {
  sessions: number;
  recorded: number;
  alreadyKnown: number;
  skippedSecrets: number;
  at: string;
}

function parseBackfillRecord(raw: string | undefined): BackfillRecord | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BackfillRecord>;
    return {
      sessions: parsed.sessions ?? 0,
      recorded: parsed.recorded ?? 0,
      alreadyKnown: parsed.alreadyKnown ?? 0,
      skippedSecrets: parsed.skippedSecrets ?? 0,
      at: typeof parsed.at === 'string' ? parsed.at : '',
    };
  } catch {
    return undefined;
  }
}

export function checkDatabase(dbFile: string): Check[] {
  if (!fs.existsSync(dbFile)) {
    return [
      {
        name: 'database',
        status: 'warn',
        detail: `not initialized (${dbFile} not found)`,
        fix: 'run `aegisxmemory init`',
      },
    ];
  }
  let integrity = 'unknown';
  let tables: string[] = [];
  let backfill: BackfillRecord | undefined;
  try {
    const result = withEngine(dbFile, (engine) => ({
      integrity: engine.dbIntegrityCheck(),
      tables: engine.dbTableNames(),
      backfill: engine.knowledgeBackfillReport(),
    }));
    integrity = result.integrity;
    tables = result.tables;
    backfill = parseBackfillRecord(result.backfill);
  } catch (err) {
    return [
      {
        name: 'database',
        status: 'fail',
        detail: `cannot open: ${err instanceof Error ? err.message : String(err)}`,
        fix: 'check file permissions, or remove the file and run `aegisxmemory init`',
      },
    ];
  }
  const sizeBytes = fs.statSync(dbFile).size;

  const checks: Check[] = [];
  checks.push(
    integrity === 'ok'
      ? { name: 'db integrity', status: 'pass', detail: `PRAGMA integrity_check ok (${formatBytes(sizeBytes)})` }
      : {
          name: 'db integrity',
          status: 'fail',
          detail: `integrity_check returned "${integrity}"`,
          fix: 'restore ~/.aegisx from backup or re-init the database',
        },
  );

  const coreTables = ['facts', 'fact_history', 'knowledge', 'sessions', 'files', 'symbols', 'meta'];
  const missing = coreTables.filter((t) => !tables.includes(t));
  checks.push(
    tables.length === 0          ? { name: 'schema', status: 'warn', detail: 'database is empty (no tables)', fix: 'run `aegisxmemory init`' }
      : missing.length === 0
        ? { name: 'schema', status: 'pass', detail: `${tables.length} core tables present` }
        : {
            name: 'schema',
            status: 'fail',
            detail: `missing tables: ${missing.join(', ')}`,
            fix: 'run `aegisxmemory init` to re-migrate',
          },
  );
  // The one-time backfill of pre-v1.13 handoff decisions writes its own record;
  // surfacing it keeps a migration that ran on open from being invisible.
  if (backfill !== undefined) {
    const parts = [`${backfill.recorded} entries from ${backfill.sessions} old handoffs`];
    if (backfill.alreadyKnown > 0) {
      parts.push(`${backfill.alreadyKnown} already known`);
    }
    if (backfill.skippedSecrets > 0) {
      parts.push(`${backfill.skippedSecrets} skipped as secrets`);
    }
    checks.push({
      name: 'knowledge backfill',
      status: 'pass',
      detail: `${parts.join(', ')} (${backfill.at.slice(0, 10)})`,
    });
  }
  return checks;
}

/* ------------------------------------------------------- index freshness */

export function checkIndexFreshness(dbFile: string, repoAbsPath: string): Check {
  let drift: DriftResult;
  try {
    drift = withEngine(dbFile, (engine) => engine.driftCheck(repoAbsPath));
  } catch (err) {
    return {
      name: 'index freshness',
      status: 'warn',
      detail: `cannot analyze: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'verify the repo path exists',
    };
  }

  if (drift.indexedFiles === 0 && drift.onDiskFiles === 0) {
    return { name: 'index freshness', status: 'warn', detail: 'nothing indexed for this repo', fix: 'run `aegisxmemory index .`' };
  }
  if (drift.missingFromDisk.length === 0 && drift.notIndexed.length === 0 && drift.hashChanged.length === 0) {
    return { name: 'index freshness', status: 'pass', detail: `${drift.indexedFiles} files in sync` };
  }
  const parts: string[] = [];
  if (drift.hashChanged.length > 0) parts.push(`${drift.hashChanged.length} changed`);
  if (drift.notIndexed.length > 0) parts.push(`${drift.notIndexed.length} new`);
  if (drift.missingFromDisk.length > 0) parts.push(`${drift.missingFromDisk.length} deleted`);
  return {
    name: 'index freshness',
    status: 'warn',
    detail: `index drift: ${parts.join(', ')}`,
    fix: 'run `aegisxmemory index .`',
  };
}

/* -------------------------------------------------------- MCP detection */

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Args that look like they point at this package's MCP entry. */
export function entryLooksLikeAegisx(entryPath: string): boolean {
  const normalized = expandHome(entryPath);
  return normalized.includes('AegisX-Memory') || normalized.includes('aegisx-memory') || normalized.endsWith('aegisx') || normalized.endsWith('aegisxmemory');
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readLines(file: string): string[] | null {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return null;
  }
}

/** Best-effort stdio entry extraction from a Hermes YAML block. */
export function hermesEntry(lines: string[]): { command: string; args: string[] } | null {
  const start = lines.findIndex((l) => /aegisx-memory:\s*$/.test(l));
  if (start === -1) return null;
  let command = '';
  const args: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\S/.test(line)) break; // next top-level key → end of block
    const cmd = /^\s*command:\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(line);
    if (cmd !== null) {
      const value = cmd[1] ?? cmd[2] ?? cmd[3] ?? '';
      if (value !== '') command = value;
    }
    const arg = /args:\s*\[(.*)\]/.exec(line);
    if (arg !== null && arg[1] !== undefined) {
      for (const raw of arg[1].split(',')) {
        const clean = raw.trim().replace(/^["']|["']$/g, '');
        if (clean !== '') args.push(clean);
      }
    }
  }
  if (command === '') return null;
  return { command, args };
}

function jsonEntry(configPath: string): { command: string; args: string[] } | null {
  const json = readJsonFile(configPath);
  if (json === null) return null;
  const servers = json['mcpServers'];
  if (servers === null || typeof servers !== 'object') return null;
  const entry = (servers as Record<string, { command?: unknown; args?: unknown }>)['aegisx-memory'];
  if (entry === undefined || typeof entry.command !== 'string') return null;
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
  return { command: entry.command, args };
}

function registration(agent: string, configPath: string, entry: { command: string; args: string[] }): McpRegistration {
  const firstArg = entry.args[0] ?? '';
  const entryExists =
    entry.command === 'node' && entry.args.length > 0 ? fs.existsSync(expandHome(firstArg)) : true;
  // An entry named aegisx-memory run via node/npx (or the aegisx binary) is
  // ours in practice; only exotic commands raise the mismatch warning.
  const matchesAegisx =
    entry.command === 'aegisxmemory' ||
    entry.command.endsWith('/aegisxmemory') ||
    entry.command === 'aegisx' || // legacy binary name (pre-1.0 installs)
    entry.command.endsWith('/aegisx') ||
    entry.command === 'node' ||
    entry.command === 'npx' ||
    entry.args.some(entryLooksLikeAegisx);
  return { agent, configPath, command: entry.command, args: entry.args, entryExists, matchesAegisx };
}

/** Detect AegisX entries in every known MCP config location. */
export function detectMcpRegistrations(homeDir: string = os.homedir(), cwd: string = process.cwd()): McpRegistration[] {
  const out: McpRegistration[] = [];

  const hermesConfig =
    process.env['HERMES_HOME'] !== undefined && process.env['HERMES_HOME'] !== ''
      ? path.join(process.env['HERMES_HOME'], 'config.yaml')
      : path.join(homeDir, '.hermes', 'config.yaml');
  const hermesLines = readLines(hermesConfig);
  if (hermesLines !== null) {
    const entry = hermesEntry(hermesLines);
    if (entry !== null) {
      out.push(registration('hermes', hermesConfig, entry));
    }
  }

  const jsonLocations: Array<{ agent: string; file: string }> = [
    {
      agent: 'claude',
      file: expandHome(process.env['CLAUDE_CONFIG'] ?? path.join(homeDir, '.claude', 'claude_desktop_config.json')),
    },
    { agent: 'claude', file: path.resolve(cwd, '.mcp.json') }, // Claude Code project-level
    { agent: 'cursor', file: expandHome(path.join(homeDir, '.cursor', 'mcp.json')) },
  ];
  for (const loc of jsonLocations) {
    const entry = jsonEntry(loc.file);
    if (entry !== null) {
      out.push(registration(loc.agent, loc.file, entry));
    }
  }
  return out;
}

function checkMcpRegistrations(): Check[] {
  const regs = detectMcpRegistrations();
  if (regs.length === 0) {
    return [
      {
        name: 'mcp registration',
        status: 'warn',
        detail: 'no AegisX MCP registration found (Hermes/Claude/Cursor)',
        fix: 'run `aegisxmemory mcp-config` and paste the block into your agent config',
      },
    ];
  }
  const checks: Check[] = regs.map((reg): Check =>
    reg.entryExists && reg.matchesAegisx
      ? { name: `mcp: ${reg.agent}`, status: 'pass', detail: `${reg.command} ${reg.args.join(' ')} (${reg.configPath})` }
      : reg.entryExists
        ? {
            name: `mcp: ${reg.agent}`,
            status: 'warn',
            detail: `registered but entry does not look like AegisX: ${reg.command} ${reg.args.join(' ')}`,
            fix: 're-print with `aegisxmemory mcp-config --agent ' + reg.agent + '`',
          }
        : {
            name: `mcp: ${reg.agent}`,
            status: 'fail',
            detail: `registered but entry file missing: ${reg.command} ${reg.args.join(' ')}`,
            fix: 'rebuild with `npm run build` or fix the path via `aegisxmemory mcp-config`',
          },
  );
  // "Installed" but never wired: the CLI works, the agent cannot call it. Only
  // the agent's *config file* is proof of registration — the binary existing
  // proves nothing about the client, and users report "it does not respond"
  // for exactly this state.
  const unregistered = SETUP_AGENTS.filter(
    (agent) => !regs.some((reg) => reg.agent === agent),
  );
  if (unregistered.length > 0) {
    checks.push({
      name: 'mcp registration coverage',
      status: 'warn',
      detail: `installed but not registered in: ${unregistered.join(', ')}`,
      fix: 'run `aegisxmemory setup` (or `mcp-config --install --agent ' + unregistered[0] + '`) to register',
    });
  }
  return checks;
}

/* ------------------------------------------------------------ memory home */

/** The memory home holds every project's facts; group/world bits leak the
 *  project list and file sizes to other accounts on shared hosts. Stores
 *  created before 0700 became the mkdir default can still be loose — doctor
 *  measures and reports, and `--fix` tightens without touching content. */
export function checkHomePermissions(homeDir: string): Check {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(homeDir);
  } catch {
    return { name: 'memory home', status: 'warn', detail: `${homeDir} does not exist`, fix: 'run `aegisxmemory init`' };
  }
  if (!stat.isDirectory()) {
    return { name: 'memory home', status: 'fail', detail: `${homeDir} is not a directory` };
  }
  const mode = stat.mode & 0o777;
  const groupWorld = (mode & 0o077).toString(8);
  if (groupWorld === '0') {
    return { name: 'memory home', status: 'pass', detail: `${homeDir} is owner-only (${mode.toString(8)})` };
  }
  return {
    name: 'memory home',
    status: 'warn',
    detail: `${homeDir} is readable beyond the owner (mode ${mode.toString(8)})`,
    fix: 'run `aegisxmemory doctor --fix` (chmod 700), or `chmod 700 ' + homeDir + '` manually',
  };
}

/** Tighten a loose memory home to owner-only. Best effort like every chmod:
 *  some filesystems refuse it, and that is fine — creation-mode is the guard. */
export function fixHomePermissions(homeDir: string): boolean {
  try {
    fs.chmodSync(homeDir, 0o700);
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- fix pass */

/**
 * Auto-fix only SAFE issues:
 *  - missing/empty DB → init (creates the home + schema; never destroys data)
 *  - index drift → incremental re-index (content-hash based, idempotent)
 * Everything else (corrupted DB, MCP configs, wrong entry paths) is reported,
 * never touched — those need human judgement or write access to foreign files.
 */
export function applyFixes(
  dbFile: string,
  repoAbsPath: string | null,
  onWarn?: (msg: string) => void,
): DoctorFixes {
  const applied: string[] = [];
  const skipped: string[] = [];
  const dbMissing = !fs.existsSync(dbFile);
  // Detect the empty-file state BEFORE any open: the Store constructor
  // auto-migrates on open, which would otherwise heal silently unreported.
  const dbEmptyFile = !dbMissing && fs.statSync(dbFile).size === 0;
  let tables: string[] = [];
  let integrity = 'unknown';
  try {
    const result = withEngine(dbFile, (engine) => ({
      integrity: engine.dbIntegrityCheck(),
      tables: engine.dbTableNames(),
    }));
    integrity = result.integrity;
    tables = result.tables;
  } catch {
    // open failure handled below via integrity !== 'ok'
  }

  if (dbMissing) {
    withEngine(dbFile, () => undefined); // constructor creates home + schema
    applied.push('initialized memory database (`aegisxmemory init`)');
  } else if (integrity !== 'ok') {
    skipped.push('database integrity is failing — auto-fix would risk data loss; restore from backup manually');
  } else if (dbEmptyFile || tables.length === 0) {
    // Opening again is harmless: migration is CREATE IF NOT EXISTS (idempotent).
    withEngine(dbFile, () => undefined);
    applied.push('migrated empty database schema (`aegisxmemory init`)');
  }

  if (repoAbsPath !== null) {
    try {
      const drift = withEngine(dbFile, (engine) => engine.driftCheck(repoAbsPath));
      const hasDrift =
        drift.hashChanged.length > 0 || drift.notIndexed.length > 0 || drift.missingFromDisk.length > 0;
      const firstIndex = drift.indexedFiles === 0 && drift.onDiskFiles > 0;
      if (hasDrift || firstIndex) {
        const stats = withEngine(dbFile, (engine) => engine.indexRepo(repoAbsPath, onWarn));
        applied.push(`re-indexed ${stats.filesTotal} files (${stats.filesChanged} changed, ${stats.filesSkipped} skipped)`);
      }
    } catch (err) {
      skipped.push(`index fix skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // A loose memory home is metadata exposure, not data loss — chmod 700 is
  // content-preserving, so it qualifies as a safe auto-fix.
  const homeDir = path.dirname(dbFile);
  try {
    if (fs.existsSync(homeDir) && (fs.statSync(homeDir).mode & 0o077) !== 0) {
      if (fixHomePermissions(homeDir)) {
        applied.push(`tightened memory home permissions to 700 (${homeDir})`);
      } else {
        skipped.push(`could not chmod the memory home (${homeDir}) — filesystem may not support it`);
      }
    }
  } catch {
    // stat failure is reported by the check itself; never block the fix pass
  }

  return { applied, skipped };
}

/* -------------------------------------------------------------- top-level */

export interface DoctorOptions {
  fix?: boolean;
  onWarn?: (msg: string) => void;
}

export function runDoctor(dbFile: string, repoAbsPath: string | null, options: DoctorOptions = {}): DoctorReport {
  const fixes: DoctorFixes | undefined = options.fix === true
    ? applyFixes(dbFile, repoAbsPath, options.onWarn)
    : undefined;

  const checks: Check[] = [...checkDatabase(dbFile)];

  if (repoAbsPath !== null) {
    checks.push(checkIndexFreshness(dbFile, repoAbsPath));
  }

  checks.push(...checkMcpRegistrations());
  checks.push(checkHomePermissions(path.dirname(dbFile)));

  return {
    checks,
    mcpServers: detectMcpRegistrations(),
    passed: checks.every((c) => c.status === 'pass'),
    ...(fixes === undefined ? {} : { fixes }),
  };
}

/* -------------------------------------------------------------- rendering */

/** Versioned machine-readable schema for `doctor --json` (CI consumers). */
export const DOCTOR_JSON_SCHEMA_VERSION = 1;

export interface DoctorJsonReport {
  schemaVersion: number;
  home: string;
  /** ISO-8601 UTC timestamp of when the report was produced. */
  generatedAt: string;
  repo: string | null;
  passed: boolean;
  checks: Array<{ name: string; status: CheckStatus; detail: string; fix?: string }>;
  fixes?: { applied: string[]; skipped: string[] };
  mcpServers: Array<{
    agent: string;
    configPath: string;
    command: string;
    args: string[];
    entryExists: boolean;
    matchesAegisx: boolean;
  }>;
}

/** Convert a report into the versioned JSON structure (pure). */
export function toJsonReport(report: DoctorReport, home: string, repoAbsPath: string | null): DoctorJsonReport {
  const json: DoctorJsonReport = {
    schemaVersion: DOCTOR_JSON_SCHEMA_VERSION,
    home,
    generatedAt: new Date().toISOString(),
    repo: repoAbsPath === null ? null : reportRepo(repoAbsPath),
    passed: report.passed,
    checks: report.checks.map((check) =>
      check.fix === undefined
        ? { name: check.name, status: check.status, detail: check.detail }
        : { name: check.name, status: check.status, detail: check.detail, fix: check.fix },
    ),
    mcpServers: report.mcpServers.map((reg) => ({
      agent: reg.agent,
      configPath: reg.configPath,
      command: reg.command,
      args: [...reg.args],
      entryExists: reg.entryExists,
      matchesAegisx: reg.matchesAegisx,
    })),
  };
  if (report.fixes !== undefined) {
    json.fixes = { applied: [...report.fixes.applied], skipped: [...report.fixes.skipped] };
  }
  return json;
}

/** Render the machine-readable report: strict JSON, single line-free pretty block. */
export function renderDoctorJson(report: DoctorReport, home: string, repoAbsPath: string | null): string {
  return JSON.stringify(toJsonReport(report, home, repoAbsPath), null, 2);
}

export function renderDoctorReport(report: DoctorReport, home: string): string {
  const icon: Record<CheckStatus, string> = { pass: '✔', warn: '!', fail: '✘' };
  const lines: string[] = [`AegisX-Memory doctor — home: ${home}`, ''];
  for (const check of report.checks) {
    lines.push(` ${icon[check.status]} ${check.name}: ${check.detail}`);
    if (check.fix !== undefined) {
      lines.push(`    fix → ${check.fix}`);
    }
  }
  if (report.fixes !== undefined) {
    const { applied, skipped } = report.fixes;
    if (applied.length > 0) {
      lines.push('', 'Fixes applied:');
      for (const fix of applied) {
        lines.push(` ✔ ${fix}`);
      }
    }
    if (skipped.length > 0) {
      lines.push('', 'Fixes skipped (need human judgement):');
      for (const fix of skipped) {
        lines.push(` ! ${fix}`);
      }
    }
  }
  lines.push('');
  lines.push(report.passed ? 'All checks passed.' : 'Issues found — see fix hints above.');
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Repo arg for doctor: normalized for reporting; raw path used for FS checks. */
export function reportRepo(repoAbsPath: string): string {
  return normalizeRepoPath(repoAbsPath);
}
