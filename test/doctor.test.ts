import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkHomePermissions, fixHomePermissions } from '../src/cli/doctor.js';
import DatabaseConstructor from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkDatabase,
  checkIndexFreshness,
  detectMcpRegistrations,
  DOCTOR_JSON_SCHEMA_VERSION,
  entryLooksLikeAegisx,
  hermesEntry,
  renderDoctorJson,
  renderDoctorReport,
  runDoctor,
  setEngineConstructor,
  staleEntryNote,
  toJsonReport,
  type Check,
} from '../src/cli/doctor.js';
import { Engine } from '../src/core/engine.js';
import { versionString } from '../src/cli/version.js';

setEngineConstructor(Engine);

let workspace: string;
let repoDir: string;
let dbFile: string;
let homeDir: string;
let cwd: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-doctor-'));
  repoDir = path.join(workspace, 'repo');
  fs.mkdirSync(repoDir);
  dbFile = path.join(workspace, 'memory.sqlite');
  homeDir = path.join(workspace, 'home');
  fs.mkdirSync(homeDir);
  cwd = process.cwd();
});

afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(workspace, { recursive: true, force: true });
});

function statusOf(checks: Check[], name: string): Check | undefined {
  return checks.find((c) => c.name === name);
}

describe('doctor — database checks', () => {
  it('pass: healthy initialized DB reports integrity ok and full schema', () => {
    const engine = new Engine(dbFile);
    engine.close();
    const checks = checkDatabase(dbFile);
    expect(statusOf(checks, 'db integrity')?.status).toBe('pass');
    expect(statusOf(checks, 'schema')?.status).toBe('pass');
  });

  it('warn: missing DB file suggests init', () => {
    const checks = checkDatabase(path.join(workspace, 'nope.sqlite'));
    const db = statusOf(checks, 'database');
    expect(db?.status).toBe('warn');
    expect(db?.fix).toContain('aegisxmemory init');
  });

  it('reports the one-time knowledge backfill, and stays quiet before it has run', () => {
    // Before any open there is no record, so doctor says nothing about it rather
    // than printing a row of zeros.
    const legacy = path.join(workspace, 'legacy.sqlite');
    const raw = new DatabaseConstructor(legacy);
    raw.exec(`
      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY,
        repo TEXT NOT NULL,
        goal TEXT NOT NULL,
        facts TEXT NOT NULL,
        decisions TEXT NOT NULL,
        next_steps TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    raw
      .prepare('INSERT INTO sessions (repo, goal, facts, decisions, next_steps, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(repoDir, 'g', '[]', JSON.stringify(['pick sqlite over postgres']), '[]', '2026-01-01T00:00:00.000Z');
    raw.close();

    const opened = new Engine(legacy);
    opened.close();
    const backfill = statusOf(checkDatabase(legacy), 'knowledge backfill');
    expect(backfill?.status).toBe('pass');
    expect(backfill?.detail).toContain('1 entries from 1 old handoffs');
  });

  it('fail: corrupt DB is caught at open/integrity time, not silently passed', () => {
    // A file with random bytes may parse as an empty SQLite DB (header check
    // is loose); the contract is: doctor must never report it as healthy.
    fs.writeFileSync(dbFile, 'this is not a sqlite database at all');
    const checks = checkDatabase(dbFile);
    const statuses = checks.map((c) => c.status);
    expect(statuses).not.toContain('pass');
    expect(statuses.every((s) => s === 'fail' || s === 'warn')).toBe(true);
  });
});

describe('doctor — index freshness', () => {
  it('pass: index in sync right after indexing', () => {
    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export function a() {}\n');
    const engine = new Engine(dbFile);
    try {
      engine.indexRepo(repoDir);
    } finally {
      engine.close();
    }
    const check = checkIndexFreshness(dbFile, repoDir);
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('in sync');
  });

  it('warn: editing a file after indexing produces drift with a fix hint', () => {
    const file = path.join(repoDir, 'a.ts');
    fs.writeFileSync(file, 'export function a() {}\n');
    const engine = new Engine(dbFile);
    try {
      engine.indexRepo(repoDir);
    } finally {
      engine.close();
    }
    fs.writeFileSync(file, 'export function b() {}\n');
    const check = checkIndexFreshness(dbFile, repoDir);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('changed');
    expect(check.fix).toBe('run `aegisxmemory index .`');
  });

  it('warn: new file on disk counts as drift', () => {
    const engine = new Engine(dbFile);
    try {
      engine.indexRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, 'new.ts'), 'export function fresh() {}\n');
    } finally {
      engine.close();
    }
    const check = checkIndexFreshness(dbFile, repoDir);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('new');
  });

  it('warn: empty repo with empty ledger suggests first index', () => {
    const check = checkIndexFreshness(dbFile, repoDir);
    expect(check.status).toBe('warn');
    expect(check.fix).toContain('aegisxmemory index');
  });
});

describe('doctor — MCP detection', () => {
  it('happy path: detects entries in Hermes, Claude and Cursor configs', () => {
    // A real (existing) entry file so entryExists can be true.
    const entryFile = path.join(workspace, 'dist', 'cli', 'index.js');
    fs.mkdirSync(path.dirname(entryFile), { recursive: true });
    fs.writeFileSync(entryFile, '#!/usr/bin/env node\n');

    const hermesHome = path.join(homeDir, '.hermes');
    const claudeHome = path.join(homeDir, '.claude');
    const cursorHome = path.join(homeDir, '.cursor');
    for (const dir of [hermesHome, claudeHome, cursorHome]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(hermesHome, 'config.yaml'),
      ['model: x', 'mcp_servers:', '  aegisx-memory:', '    command: "node"', `    args: ["${entryFile}", "mcp"]`, '    timeout: 60', ''].join('\n'),
    );
    const entry = JSON.stringify({
      mcpServers: { 'aegisx-memory': { command: 'node', args: [entryFile, 'mcp'] } },
    });
    fs.writeFileSync(path.join(claudeHome, 'claude_desktop_config.json'), entry);
    fs.writeFileSync(path.join(cursorHome, 'mcp.json'), entry);

    const regs = detectMcpRegistrations(homeDir, repoDir);
    const agents = regs.map((r) => r.agent).sort();
    expect(agents).toEqual(['claude', 'cursor', 'hermes']);
    for (const reg of regs) {
      expect(reg.matchesAegisx).toBe(true);
      expect(reg.entryExists).toBe(true);
    }
  });

  it('negative: configs without aegisx-memory yield no registrations', () => {
    const hermesHome = path.join(homeDir, '.hermes');
    fs.mkdirSync(hermesHome, { recursive: true });
    fs.writeFileSync(
      path.join(hermesHome, 'config.yaml'),
      'mcp_servers:\n  other-server:\n    command: "uvx"\n    args: ["mcp-server-time"]\n',
    );
    const regs = detectMcpRegistrations(homeDir, repoDir);
    expect(regs).toEqual([]);
  });

  it('negative: malformed JSON config is ignored without crashing', () => {
    const claudeHome = path.join(homeDir, '.claude');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(path.join(claudeHome, 'claude_desktop_config.json'), '{ not json !!');
    const regs = detectMcpRegistrations(homeDir, repoDir);
    expect(regs).toEqual([]);
  });

  it('missing entry file is flagged (node command with nonexistent path)', () => {
    const claudeHome = path.join(homeDir, '.claude');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(
      path.join(claudeHome, 'claude_desktop_config.json'),
      JSON.stringify({ mcpServers: { 'aegisx-memory': { command: 'node', args: ['/definitely/not/here/index.js', 'mcp'] } } }),
    );
    const regs = detectMcpRegistrations(homeDir, repoDir);
    expect(regs).toHaveLength(1);
    expect(regs[0]?.matchesAegisx).toBe(true);
    expect(regs[0]?.entryExists).toBe(false);
  });

  it('entryLooksLikeAegisx recognizes path variants', () => {
    expect(entryLooksLikeAegisx('/home/x/AegisX-Memory/dist/cli/index.js')).toBe(true);
    expect(entryLooksLikeAegisx('/home/x/aegisx-memory/cli.js')).toBe(true);
    expect(entryLooksLikeAegisx('/home/x/other-tool/index.js')).toBe(false);
  });

  it('hermesEntry parses command/args and stops at next top-level key', () => {
    const parsed = hermesEntry([
      'mcp_servers:',
      '  aegisx-memory:',
      '    command: "aegisxmemory"',
      '    args: ["mcp"]',
      '    timeout: 60',
      'other_key: 1',
    ]);
    expect(parsed).toEqual({ command: 'aegisxmemory', args: ['mcp'] });
  });
});

describe('doctor — fix pass (--fix)', () => {
  it('happy: initializes a missing DB, then re-indexes once files exist', () => {
    const first = runDoctor(dbFile, repoDir, { fix: true });
    expect(first.fixes?.applied.some((f) => f.includes('initialized memory database'))).toBe(true);
    expect(statusOf(first.checks, 'db integrity')?.status).toBe('pass');

    fs.writeFileSync(path.join(repoDir, 'a.ts'), 'export function a() {}\n');
    const second = runDoctor(dbFile, repoDir, { fix: true });
    expect(second.fixes?.applied.some((f) => f.includes('re-indexed'))).toBe(true);
    expect(statusOf(second.checks, 'index freshness')?.status).toBe('pass');
  });

  it('happy: heals index drift (edited file) so freshness passes after fix', () => {
    const file = path.join(repoDir, 'a.ts');
    fs.writeFileSync(file, 'export function a() {}\n');
    const engine = new Engine(dbFile);
    try {
      engine.indexRepo(repoDir);
    } finally {
      engine.close();
    }
    fs.writeFileSync(file, 'export function changed() {}\n');

    const report = runDoctor(dbFile, repoDir, { fix: true });
    expect(report.fixes?.applied.some((f) => f.includes('1 changed'))).toBe(true);
    expect(statusOf(report.checks, 'index freshness')?.status).toBe('pass');
  });

  it('happy: migrates an existing but empty DB file', () => {
    fs.writeFileSync(dbFile, '');
    const report = runDoctor(dbFile, repoDir, { fix: true });
    expect(report.fixes?.applied.some((f) => f.includes('migrated empty database'))).toBe(true);
    expect(statusOf(report.checks, 'schema')?.status).toBe('pass');
  });

  it('negative: never auto-fixes a corrupted DB (data-loss guard)', () => {
    fs.writeFileSync(dbFile, 'not a sqlite database');
    const report = runDoctor(dbFile, repoDir, { fix: true });
    expect(report.fixes?.applied).toEqual([]);
    expect(report.fixes?.skipped.some((s) => s.includes('data loss'))).toBe(true);
  });

  it('negative: MCP registration warnings are never auto-fixed', () => {
    // Hermetic: without this, a real registration on the machine removes the
    // check this test exists to pin.
    const realHomedir = os.homedir;
    os.homedir = () => homeDir;
    try {
      const report = runDoctor(dbFile, repoDir, { fix: true });
      const mcpFixTouched = report.fixes?.applied.some((f) => f.toLowerCase().includes('mcp')) ?? false;
      expect(mcpFixTouched).toBe(false);
      expect(statusOf(report.checks, 'mcp registration')?.status).toBe('warn');
    } finally {
      os.homedir = realHomedir;
    }
  });

  it('fix output is rendered with applied/skipped sections', () => {
    fs.writeFileSync(dbFile, 'not a sqlite database');
    const report = runDoctor(dbFile, repoDir, { fix: true });
    const text = renderDoctorReport(report, '/fake/home');
    expect(text).toContain('Fixes skipped');
  });

  it('fix: a loose memory home is tightened to 700 (metadata exposure, not data)', () => {
    const looseHome = path.join(workspace, 'loose-home');
    fs.mkdirSync(looseHome, { recursive: true, mode: 0o755 });
    fs.chmodSync(looseHome, 0o755);
    const db = path.join(looseHome, 'memory.sqlite');
    runDoctor(db, null, { fix: true });
    expect((fs.statSync(looseHome).mode & 0o777).toString(8)).toBe('700');
  });
});

describe('doctor — memory home permissions', () => {
  it('pass: an owner-only home (700) says so', () => {
    fs.chmodSync(homeDir, 0o700);
    const check = checkHomePermissions(homeDir);
    expect(check.status).toBe('pass');
  });

  it('warn: the pre-0700 default (775) is named with its mode and a chmod fix', () => {
    fs.chmodSync(homeDir, 0o775);
    const check = checkHomePermissions(homeDir);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('775');
    expect(check.fix).toContain('chmod 700');
  });

  it('warn: a missing home suggests init instead of crashing', () => {
    const check = checkHomePermissions(path.join(workspace, 'nope'));
    expect(check.status).toBe('warn');
    expect(check.fix).toContain('init');
  });

  it('fixHomePermissions returns true on success and the mode really changes', () => {
    fs.chmodSync(homeDir, 0o775);
    expect(fixHomePermissions(homeDir)).toBe(true);
    expect((fs.statSync(homeDir).mode & 0o777).toString(8)).toBe('700');
  });

  it('negative: fixHomePermissions on a missing path is false, never a throw', () => {
    expect(fixHomePermissions(path.join(workspace, 'nope'))).toBe(false);
  });
});

describe('doctor — registration coverage', () => {
  function writeHermesRegistration(): void {
    const hermesHome = path.join(workspace, 'hermes-home');
    fs.mkdirSync(hermesHome, { recursive: true });
    process.env['HERMES_HOME'] = hermesHome;
    fs.writeFileSync(
      path.join(hermesHome, 'config.yaml'),
      'mcp_servers:\n  aegisx-memory:\n    command: "node"\n    args: ["/x/dist/cli/index.js", "mcp"]\n',
    );
  }

  it('warn: an installed CLI with no registration anywhere is already covered by the existing warn', () => {
    delete process.env['HERMES_HOME'];
    delete process.env['CLAUDE_CONFIG'];
    // Hermetic: the machine's real home may carry registrations from a live
    // install — point homedir at the empty workspace home instead.
    const realHomedir = os.homedir;
    os.homedir = () => homeDir;
    try {
      const report = runDoctor(dbFile, null);
      const names = report.checks.map((c) => c.name);
      expect(names).toContain('mcp registration');
      expect(names).not.toContain('mcp registration coverage'); // nothing registered → single warn
    } finally {
      os.homedir = realHomedir;
    }
  });

  it('warn: names only the present-but-unregistered agents, never the absent ones', () => {
    writeHermesRegistration();
    delete process.env['CLAUDE_CONFIG'];
    const realHomedir = os.homedir;
    const realPath = process.env['PATH'];
    os.homedir = () => homeDir; // hermetic — never read the machine's real home
    process.env['PATH'] = path.join(workspace, 'empty-bin'); // no agent CLIs here
    try {
      // Present on this machine: Claude and Cursor have a config file each.
      fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(homeDir, '.claude', 'claude_desktop_config.json'), '{}');
      fs.mkdirSync(path.join(homeDir, '.cursor'), { recursive: true });
      fs.writeFileSync(path.join(homeDir, '.cursor', 'mcp.json'), '{}');

      const report = runDoctor(dbFile, repoDir);
      const coverage = report.checks.find((c) => c.name === 'mcp registration coverage');
      expect(coverage).toBeDefined();
      expect(coverage?.status).toBe('warn');
      expect(coverage?.detail).toContain('claude');
      expect(coverage?.detail).toContain('cursor');
      // Absent agents are not the user's problem to fix — suggesting them is noise.
      expect(coverage?.detail).not.toContain('gemini');
      expect(coverage?.detail).not.toContain('codex');
      expect(coverage?.detail).not.toContain('vscode');
      expect(coverage?.detail).not.toContain('hermes'); // registered
    } finally {
      os.homedir = realHomedir;
      process.env['PATH'] = realPath;
    }
  });

  it('negative: a machine with only Hermes is never nagged about agents it does not have', () => {
    writeHermesRegistration();
    delete process.env['CLAUDE_CONFIG'];
    const realHomedir = os.homedir;
    const realPath = process.env['PATH'];
    os.homedir = () => homeDir; // empty: no other agent has ever been installed
    process.env['PATH'] = path.join(workspace, 'empty-bin');
    try {
      const report = runDoctor(dbFile, repoDir);
      const coverage = report.checks.find((c) => c.name === 'mcp registration coverage');
      // Not a warn — and not silence either: the pass line names what the
      // probe found and, crucially, what it looked for and did not find.
      expect(coverage?.status).toBe('pass');
      expect(coverage?.detail).toContain('detected on this machine: hermes');
      expect(coverage?.detail).toContain('not installed: claude, cursor, gemini, codex, windsurf, vscode');
      expect(report.checks.find((c) => c.name.startsWith('mcp: '))).toBeDefined();
    } finally {
      os.homedir = realHomedir;
      process.env['PATH'] = realPath;
    }
  });

  it('warn: an agent whose CLI is on PATH but not configured for MCP is still named', () => {
    writeHermesRegistration();
    delete process.env['CLAUDE_CONFIG'];
    const realHomedir = os.homedir;
    const realPath = process.env['PATH'];
    os.homedir = () => homeDir;
    const binDir = path.join(workspace, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'gemini'), '#!/bin/sh\n', { mode: 0o755 });
    process.env['PATH'] = binDir;
    try {
      const report = runDoctor(dbFile, repoDir);
      const coverage = report.checks.find((c) => c.name === 'mcp registration coverage');
      expect(coverage?.detail).toContain('gemini');
      expect(coverage?.detail).not.toContain('cursor'); // no CLI, no config
    } finally {
      os.homedir = realHomedir;
      process.env['PATH'] = realPath;
    }
  });

  it('negative: no coverage warn when every known agent is registered', () => {
    writeHermesRegistration();
    const claudeConfig = path.join(workspace, 'claude.json');
    process.env['CLAUDE_CONFIG'] = claudeConfig;
    fs.writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { 'aegisx-memory': { command: 'node', args: ['/x/dist/cli/index.js', 'mcp'] } } }));
    const entry = { command: 'node', args: ['/x/dist/cli/index.js', 'mcp'] };
    // Cursor, Gemini, Windsurf and Codex derive their config paths from the
    // homedir; doctor reads os.homedir() at call time, so mock it.
    fs.mkdirSync(path.join(workspace, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { 'aegisx-memory': entry } }));
    fs.mkdirSync(path.join(workspace, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.gemini', 'settings.json'), JSON.stringify({ mcpServers: { 'aegisx-memory': entry } }));
    fs.mkdirSync(path.join(workspace, '.codeium', 'windsurf'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.codeium', 'windsurf', 'mcp_config.json'), JSON.stringify({ mcpServers: { 'aegisx-memory': entry } }));
    fs.mkdirSync(path.join(workspace, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.codex', 'config.toml'), '[mcp_servers."aegisx-memory"]\ncommand = "node"\nargs = ["/x/dist/cli/index.js", "mcp"]\n');
    // VS Code nests under `servers` in <repo>/.vscode/mcp.json; with the repo
    // threading fix, the repo passed to runDoctor decides where to look.
    const scratchRepo = path.join(workspace, 'scratch-repo');
    fs.mkdirSync(path.join(scratchRepo, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(scratchRepo, '.vscode', 'mcp.json'), JSON.stringify({ servers: { 'aegisx-memory': { type: 'stdio', ...entry } } }));
    const realHomedir = os.homedir;
    os.homedir = () => workspace;
    try {
      const report = runDoctor(dbFile, scratchRepo);
      // Every agent is registered, so nothing to fix — the check still reports
      // itself, explaining why there is no warning.
      const coverage = report.checks.find((c) => c.name === 'mcp registration coverage');
      expect(coverage?.status).toBe('pass');
      expect(coverage?.detail).toContain('all registered');
      expect(coverage?.detail).not.toContain('not installed'); // all seven are here
      expect(report.checks.filter((c) => c.name.startsWith('mcp: '))).toHaveLength(7);
    } finally {
      os.homedir = realHomedir;
    }
  });
});

describe('doctor — aggregation & rendering', () => {
  it('runDoctor aggregates checks and computes passed correctly', () => {
    const report = runDoctor(dbFile, repoDir); // nothing initialized/indexed → warns
    expect(report.passed).toBe(false);
    expect(report.checks.length).toBeGreaterThanOrEqual(3);
    const names = report.checks.map((c) => c.name).join(',');
    expect(names).toContain('mcp registration');
  });

  it('renderer prints icons, fixes and the summary line', () => {
    const report = runDoctor(dbFile, repoDir);
    const text = renderDoctorReport(report, '/fake/home');
    expect(text).toContain('AegisX-Memory doctor');
    expect(text).toContain('fix →');
    expect(text).toContain('Issues found');
  });

  it('engine seam stays wired across the suite (invariant the CLI relies on)', () => {
    // runDoctor is the same module-level import used above; after every
    // other test ran, the seam must still resolve to the real Engine.
    expect(() => runDoctor(dbFile, repoDir)).not.toThrow();
  });
});

describe('doctor --json (machine-readable, CI)', () => {
  it('contract: strict JSON with versioned schema and required fields', () => {
    const report = runDoctor(dbFile, repoDir);
    const text = renderDoctorJson(report, '/fake/home', repoDir);
    expect(() => JSON.parse(text)).not.toThrow(); // strict JSON, no comment lines
    const parsed = JSON.parse(text) as {
      schemaVersion: number;
      home: string;
      generatedAt: string;
      repo: string | null;
      passed: boolean;
      checks: Array<{ name: string; status: string; detail: string; fix?: string }>;
      mcpServers: unknown[];
    };
    expect(parsed.schemaVersion).toBe(DOCTOR_JSON_SCHEMA_VERSION);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.home).toBe('/fake/home');
    expect(Number.isNaN(Date.parse(parsed.generatedAt))).toBe(false); // ISO-8601
    expect(parsed.repo).not.toBeNull();
    expect(typeof parsed.passed).toBe('boolean');
    expect(parsed.checks.length).toBeGreaterThanOrEqual(3);
    for (const check of parsed.checks) {
      expect(['pass', 'warn', 'fail']).toContain(check.status);
    }
  });

  it('repo null in --no-repo mode, fixes array present when --fix ran', () => {
    const report = runDoctor(dbFile, repoDir, { fix: true });
    const json = toJsonReport(report, '/fake/home', null);
    expect(json.repo).toBeNull();
    expect(json.fixes).toBeDefined();
    expect(Array.isArray(json.fixes?.applied)).toBe(true);
    expect(Array.isArray(json.fixes?.skipped)).toBe(true);
  });

  it('no fixes key when --fix was not requested', () => {
    const json = toJsonReport(runDoctor(dbFile, repoDir), '/fake/home', null);
    expect(json.fixes).toBeUndefined();
    expect(Object.keys(json)).not.toContain('fixes');
  });

  it('passed reflects check results for CI gating', () => {
    const fresh = runDoctor(dbFile, repoDir);
    expect(toJsonReport(fresh, '/h', null).passed).toBe(false); // nothing fixed yet
    const fixed = runDoctor(dbFile, repoDir, { fix: true });
    const fixedJson = toJsonReport(fixed, '/h', null);
    expect(fixedJson.passed).toBe(fixedJson.checks.every((c) => c.status === 'pass'));
  });
});

describe('doctor — the registered entry must be the build you are running', () => {
  const profile = { probe: () => '9.9.9 (deadbee · 2020-01-01)', mine: () => '1.30.0 (abc1234 · 2026-09-13)' };

  it('warn: an entry pointing at a different build is named with both stamps', () => {
    const report = runDoctor(dbFile, repoDir, {
      probeVersion: profile.probe,
    });
    // No registration in this workspace → the check reports the "nothing found"
    // warn; the note itself is what this test pins.
    const note = staleEntryNote('/tmp/AegisX-Memory-old/dist/cli/index.js', profile.probe, profile.mine);
    expect(note).toContain('different build');
    expect(note).toContain('9.9.9 (deadbee · 2020-01-01)');
    expect(note).toContain('this CLI: 1.30.0 (abc1234 · 2026-09-13)');
    expect(report.checks.length).toBeGreaterThan(0);
  });

  it('negative: a probe that cannot answer never becomes a verdict', () => {
    const note = staleEntryNote('/tmp/AegisX-Memory-old/dist/cli/index.js', () => null, profile.mine);
    expect(note).toBeNull();
  });

  it('warn: same stamp but a bundle older than the sources is caught by mtime', () => {
    const root = path.join(workspace, 'checkout');
    const srcDir = path.join(root, 'src', 'cli');
    const entry = path.join(root, 'dist', 'cli', 'index.js');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '// built long ago\n');
    fs.writeFileSync(path.join(srcDir, 'version.ts'), '// edited since\n');
    const old = new Date(Date.now() - 600_000);
    fs.utimesSync(entry, old, old);

    const note = staleEntryNote(entry, () => '1.30.0 (abc1234 · 2026-09-13)', profile.mine, root);
    expect(note).toContain('older than the sources');
    expect(note).toContain('npm run build');
  });

  it('pass: a freshly built bundle (entry newer than sources) warns about nothing', () => {
    const root = path.join(workspace, 'fresh');
    const srcDir = path.join(root, 'src');
    const entry = path.join(root, 'dist', 'cli', 'index.js');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), '// source\n');
    fs.writeFileSync(entry, '// fresh build\n');
    const old = new Date(Date.now() - 600_000);
    fs.utimesSync(path.join(srcDir, 'index.ts'), old, old);

    expect(staleEntryNote(entry, () => profile.mine(), profile.mine, root)).toBeNull();
  });

  it('pass: the entry that is this very module is never probed', () => {
    // The build printing the report cannot be a different build.
    const selfEntry = path.resolve('src/cli/doctor.ts');
    const explodingProbe = (): string | null => {
      throw new Error('the probe must not run for the running build');
    };
    expect(staleEntryNote(selfEntry, explodingProbe, profile.mine)).toBeNull();
  });

  it('the stamp doctor compares against is the running build\u2019s', () => {
    // Guards the seam: doctor must diff against `versionString()`, not a literal.
    expect(versionString()).toMatch(/^1\.\d+\.\d+/);
  });
});
