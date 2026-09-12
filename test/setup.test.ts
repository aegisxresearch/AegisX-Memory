import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSetupWizard } from '../src/cli/setup.js';
import { parse as parseYaml } from 'yaml';

let workspace: string;
const prevEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-wizard-'));
  for (const key of ['HERMES_HOME', 'CLAUDE_CONFIG']) {
    prevEnv[key] = process.env[key];
    process.env[key] = path.join(workspace, key);
  }
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('setup wizard — non-interactive (piped) path', () => {
  it('applies recommended defaults (hermes + rules) without hanging', async () => {
    await runSetupWizard();
    const config = path.join(workspace, 'HERMES_HOME', 'config.yaml');
    const soul = path.join(workspace, 'HERMES_HOME', 'SOUL.md');
    expect(fs.existsSync(config)).toBe(true);
    expect(fs.existsSync(soul)).toBe(true);
    const parsed = parseYaml(fs.readFileSync(config, 'utf8')) as {
      mcp_servers?: Record<string, { command: string }>;
    };
    expect(parsed.mcp_servers?.['aegisx-memory']).toBeDefined();
    expect(fs.readFileSync(soul, 'utf8')).toContain('aegisx-memory:auto-rules BEGIN');
  });

  it('is idempotent — second run reports unchanged and never duplicates', async () => {
    await runSetupWizard();
    const first = fs.readFileSync(path.join(workspace, 'HERMES_HOME', 'SOUL.md'), 'utf8');
    await runSetupWizard();
    expect(fs.readFileSync(path.join(workspace, 'HERMES_HOME', 'SOUL.md'), 'utf8')).toBe(first);
  });
});

describe('setup wizard — project rules (AGENTS.md)', () => {
  it('plants the memory contract in the project directory the CLI passes', async () => {
    const project = path.join(workspace, 'proj');
    fs.mkdirSync(project, { recursive: true });
    await runSetupWizard(undefined, { projectDir: project });
    const rules = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
    expect(rules).toContain('aegisx-memory:auto-rules BEGIN');
    expect(rules).toContain('recall');
  });

  it('negative: never scatters rules into the home directory', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await runSetupWizard(undefined, { projectDir: os.homedir() });
    } finally {
      spy.mockRestore();
    }
    expect(writes.join('')).not.toContain('project:');
  });

  it('negative: a programmatic caller that passes no directory writes no project file', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runSetupWizard();
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(path.join(workspace, 'AGENTS.md'))).toBe(false);
  });
});
