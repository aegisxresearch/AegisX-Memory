import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  toJsonReport,
  type Check,
} from '../src/cli/doctor.js';
import { Engine } from '../src/core/engine.js';

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
    const report = runDoctor(dbFile, repoDir, { fix: true });
    const mcpFixTouched = report.fixes?.applied.some((f) => f.toLowerCase().includes('mcp')) ?? false;
    expect(mcpFixTouched).toBe(false);
    expect(statusOf(report.checks, 'mcp registration')?.status).toBe('warn');
  });

  it('fix output is rendered with applied/skipped sections', () => {
    fs.writeFileSync(dbFile, 'not a sqlite database');
    const report = runDoctor(dbFile, repoDir, { fix: true });
    const text = renderDoctorReport(report, '/fake/home');
    expect(text).toContain('Fixes skipped');
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
