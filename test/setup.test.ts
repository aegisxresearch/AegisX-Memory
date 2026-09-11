import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
