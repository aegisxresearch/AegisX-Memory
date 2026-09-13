import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HOOK_INDEX_DEADLINE_MS,
  HOOK_POST_EDIT_MARKER,
  HOOK_SESSION_START_MARKER,
  claudeSettingsPath,
  hookSessionEnd,
  hookSessionStart,
  installClaudeHooks,
  parseHookClient,
  parseHookEvent,
  positiveIntArg,
  repoFromStdinJson,
  runHook,
} from '../src/cli/hooks.js';
import { Engine } from '../src/core/engine.js';
import { AegisxError } from '../src/core/types.js';

let workspace: string;
let repoDir: string;
let prevHome: string | undefined;

function writeRepoFile(rel: string, content: string): void {
  const abs = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-hook-'));
  repoDir = path.join(workspace, 'repo');
  fs.mkdirSync(repoDir);
  writeRepoFile('src/auth.ts', 'export function login(u: string): string { return u; }\n');
  // Isolate the memory home: every engine open in this suite lands here.
  prevHome = process.env['AEGISX_HOME'];
  process.env['AEGISX_HOME'] = path.join(workspace, 'home');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env['AEGISX_HOME'];
  else process.env['AEGISX_HOME'] = prevHome;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('hook — argument parsing', () => {
  it('happy: the three lifecycle events parse, anything else is a user error', () => {
    expect(parseHookEvent('session-start')).toBe('session-start');
    expect(parseHookEvent('session-end')).toBe('session-end');
    expect(parseHookEvent('post-edit')).toBe('post-edit');
    expect(() => parseHookEvent('startup')).toThrow(AegisxError);
  });

  it('negative: a non-positive --deadline is a user error, not a silent default', () => {
    expect(() => positiveIntArg('deadline')('-5')).toThrow(AegisxError);
    expect(() => positiveIntArg('deadline')('0')).toThrow(AegisxError);
    expect(() => positiveIntArg('deadline')('2.5')).toThrow(AegisxError);
    expect(positiveIntArg('deadline')('400')).toBe(400);
  });
});

describe('hook session-start', () => {
  it('happy: never-indexed repo gets auto-indexed and the block carries the structure brief', () => {
    const r = hookSessionStart({ repo: repoDir });
    expect(r.indexed).toBe(true);
    expect(r.indexNote).toContain('auto-indexed 1 files');
    expect(r.context).toContain('AEGISX-MEMORY:BEGIN');
    expect(r.context).toContain('function login');
    expect(r.context).toContain('recall: complete');
  });

  it('happy: second run pays zero indexing cost (incremental by hash)', () => {
    hookSessionStart({ repo: repoDir });
    const second = hookSessionStart({ repo: repoDir });
    expect(second.indexed).toBe(false);
    expect(second.indexNote).toBeNull();
    expect(second.context).toContain('function login');
  });

  it('json: Claude Code SessionStart shape — hookSpecificOutput.additionalContext carries the memory', () => {
    const outcome = runHook('session-start', { json: true, repo: repoDir });
    expect(outcome.exitCode).toBe(0);
    const parsed = JSON.parse(outcome.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('AEGISX-MEMORY:BEGIN');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('function login');
  });

  it('json: an empty repo still injects a truthful answer, never an empty context', () => {
    // No files, no facts: the hook indexes (0 files) and says exactly that.
    const emptyRepo = path.join(workspace, 'empty');
    fs.mkdirSync(emptyRepo);
    const outcome = runHook('session-start', { json: true, repo: emptyRepo });
    const parsed = JSON.parse(outcome.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(parsed.hookSpecificOutput.additionalContext).toContain('auto-indexed 0 files');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('No indexed symbols');
  });

  it('hermes dialect: emits the bare {context} Hermes reads — hookSpecificOutput injects nothing there', () => {
    const outcome = runHook('session-start', { json: true, client: 'hermes', repo: repoDir });
    expect(outcome.exitCode).toBe(0);
    const parsed = JSON.parse(outcome.stdout) as Record<string, unknown>;
    expect(typeof parsed['context']).toBe('string');
    expect(parsed['context'] as string).toContain('function login');
    // Claude's key is meaningless to Hermes' `_parse_context`; its presence
    // would mean the wrong dialect shipped and memory silently stopped loading.
    expect(parsed['hookSpecificOutput']).toBeUndefined();
  });

  it('hermes dialect: an empty repo still answers truthfully instead of injecting a blank', () => {
    const emptyRepo = path.join(workspace, 'empty-hermes');
    fs.mkdirSync(emptyRepo);
    const outcome = runHook('session-start', { json: true, client: 'hermes', repo: emptyRepo });
    const parsed = JSON.parse(outcome.stdout) as { context: string };
    expect(parsed.context).toContain('auto-indexed 0 files');
  });

  it('negative: an unknown --client is a user error, never a silent fallback', () => {
    expect(() => parseHookClient('emacs')).toThrow(AegisxError);
    expect(parseHookClient('claude')).toBe('claude');
    expect(parseHookClient('hermes')).toBe('hermes');
  });

  it('happy: a generous deadline indexes normally (the cap only binds when spent)', () => {
    expect(hookSessionStart({ repo: repoDir, deadlineMs: 60_000 }).indexed).toBe(true);
  });

  it('negative: a repo outside the allowlist is reported, never indexed', () => {
    process.env['AEGISX_ALLOWED_REPOS'] = path.join(workspace, 'other');
    try {
      const outcome = runHook('session-start', { json: false, repo: repoDir });
      expect(outcome.exitCode).toBe(0); // hooks degrade, never fail the session
      expect(outcome.stderr).toContain('skipped');
      // The guard — not a quiet bypass — is what stopped the work.
      expect(outcome.stderr).toContain('not in AEGISX_ALLOWED_REPOS');
      expect(outcome.stdout).toBe('');
    } finally {
      delete process.env['AEGISX_ALLOWED_REPOS'];
    }
  });
});

describe('hook session-end', () => {
  it('happy: no prior handoff → reminder asks for the first save; stdout empty', () => {
    const r = hookSessionEnd({ repo: repoDir });
    expect(r.hasHandoffEver).toBe(false);
    expect(r.reminder).toContain('aegisxmemory_save');
    const outcome = runHook('session-end', { json: false, repo: repoDir });
    expect(outcome.stdout).toBe('');
    expect(outcome.stderr).toContain('Session ending');
  });

  it('json: Stop-hook contract — decision block with the reminder as reason', () => {
    const outcome = runHook('session-end', { json: true, repo: repoDir });
    const parsed = JSON.parse(outcome.stdout) as { decision: string; reason: string };
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain('aegisxmemory_save');
  });

  it('hermes dialect: pre_verify reads action/message, so the nudge uses that shape', () => {
    const outcome = runHook('session-end', { json: true, client: 'hermes', repo: repoDir });
    const parsed = JSON.parse(outcome.stdout) as { action: string; message: string };
    expect(parsed.action).toBe('continue');
    expect(parsed.message).toContain('aegisxmemory_save');
  });

  it('happy: after a saved handoff the reminder knows the repo has history', () => {
    const engine = new Engine(path.join(process.env['AEGISX_HOME'] as string, 'memory.sqlite'));
    try {
      engine.saveSession(repoDir, {
        goal: 'prove the end hook sees history',
        facts: ['hook test ran'],
        decisions: [],
        nextSteps: [],
      });
    } finally {
      engine.close();
    }
    const r = hookSessionEnd({ repo: repoDir });
    expect(r.hasHandoffEver).toBe(true);
    expect(r.reminder).toContain('facts, decisions, gotchas');
  });
});

describe('hook post-edit', () => {
  it('happy: an edit shows up as changed files on the next hook run', () => {
    hookSessionStart({ repo: repoDir });
    writeRepoFile('src/auth.ts', 'export function login(u: string): string { return u; }\nexport function logout(): void {}\n');
    const r = runHook('post-edit', { json: false, repo: repoDir });
    expect(r.stdout).toContain('1 changed');
    expect(r.stdout).toContain('2 symbols');
  });

  it('json: machine summary with ok + repo + summary fields', () => {
    const outcome = runHook('post-edit', { json: true, repo: repoDir });
    const parsed = JSON.parse(outcome.stdout) as { ok: boolean; repo: string; indexed: boolean; summary: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.repo).toBe(fs.realpathSync.native(repoDir));
    expect(typeof parsed.summary).toBe('string');
  });

  it('negative: a missing repo degrades to exit 0 + stderr note, never a crash', () => {
    const outcome = runHook('post-edit', { json: false, repo: path.join(workspace, 'nope') });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toContain('skipped');
    expect(outcome.stdout).toBe('');
  });
});

describe('hook — Claude Code installer', () => {
  it('happy: creates project-scope settings.json with both hooks and the marker comments', () => {
    const file = path.join(repoDir, '.claude', 'settings.json');
    const r = installClaudeHooks(file);
    expect(r.action).toBe('created');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    expect(parsed.hooks['SessionStart']?.[0]?.matcher).toBe('startup|resume');
    expect(parsed.hooks['SessionStart']?.[0]?.hooks[0]?.command).toContain(HOOK_SESSION_START_MARKER);
    expect(parsed.hooks['SessionStart']?.[0]?.hooks[0]?.command).toContain('hook session-start --json');
    expect(parsed.hooks['PostToolUse']?.[0]?.matcher).toBe('Write|Edit');
    expect(parsed.hooks['PostToolUse']?.[0]?.hooks[0]?.command).toContain(HOOK_POST_EDIT_MARKER);
  });

  it('happy: merges into an existing settings file, preserving user hooks, with a backup', () => {
    const file = path.join(repoDir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }] } }),
    );
    const r = installClaudeHooks(file);
    expect(r.action).toBe('merged');
    expect(r.backup).toBe(`${file}.aegisx-bak`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    };
    expect(parsed.hooks['PreToolUse']?.[0]?.hooks[0]?.command).toBe('echo user-hook');
    expect(parsed.hooks['SessionStart']).toHaveLength(1);
    expect(fs.readFileSync(r.backup as string, 'utf8')).toContain('user-hook');
  });

  it('idempotent: second run is unchanged and never duplicates a group', () => {
    const file = path.join(repoDir, '.claude', 'settings.json');
    installClaudeHooks(file);
    const first = fs.readFileSync(file, 'utf8');
    const r = installClaudeHooks(file);
    expect(r.action).toBe('unchanged');
    expect(fs.readFileSync(file, 'utf8')).toBe(first);
    const parsed = JSON.parse(first) as { hooks: Record<string, unknown[]> };
    expect(parsed.hooks['SessionStart']).toHaveLength(1);
    expect(parsed.hooks['PostToolUse']).toHaveLength(1);
  });

  it('update: a stale installed command is refreshed in place, user hooks untouched', () => {
    const file = path.join(repoDir, '.claude', 'settings.json');
    installClaudeHooks(file);
    // Simulate an older install by mutating the marker-carrying command.
    const stale = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    stale.hooks['SessionStart']![0]!.hooks[0]!.command = 'aegisxmemory hook session-start --json --deadline 1000 # aegisx-memory:session-start';
    fs.writeFileSync(file, JSON.stringify(stale));
    const r = installClaudeHooks(file);
    expect(r.action).toBe('merged');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(parsed.hooks['SessionStart']![0]!.hooks[0]!.command).toContain(`--deadline ${HOOK_INDEX_DEADLINE_MS}`);
    expect(parsed.hooks['PreToolUse']).toBeUndefined();
  });

  it('negative: an invalid settings file is refused byte-for-byte, with no backup litter', () => {
    const file = path.join(repoDir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json');
    const r = installClaudeHooks(file);
    expect(r.action).toBe('error');
    expect(r.backup).toBeNull();
    expect(fs.readFileSync(file, 'utf8')).toBe('not json');
    expect(fs.existsSync(`${file}.aegisx-bak`)).toBe(false);
  });

  it('negative: a JSON array (not an object) is refused too', () => {
    const file = path.join(repoDir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[]');
    expect(installClaudeHooks(file).action).toBe('error');
  });

  it('path resolution: project scope sits under the repo, user scope under CLAUDE_CONFIG_DIR', () => {
    expect(claudeSettingsPath(true, repoDir)).toBe(path.join(repoDir, '.claude', 'settings.json'));
    process.env['CLAUDE_CONFIG_DIR'] = path.join(workspace, 'claude-home');
    try {
      expect(claudeSettingsPath(false)).toBe(path.join(workspace, 'claude-home', 'settings.json'));
    } finally {
      delete process.env['CLAUDE_CONFIG_DIR'];
    }
  });
});

describe('hook — stdin contract', () => {
  it('cwd is taken from Claude Code stdin JSON, best effort', () => {
    expect(repoFromStdinJson('{"cwd":"/tmp/x"}')).toBe('/tmp/x');
    expect(repoFromStdinJson('{"cwd":""}')).toBeUndefined();
    expect(repoFromStdinJson('not json')).toBeUndefined();
    expect(repoFromStdinJson(null)).toBeUndefined();
  });
});

describe('hook — CLI scope routing (regression)', () => {
  it('negative: --install --project must route to the repo settings, never the user file', async () => {
    // Caught live: `!opts.project` inverted scopes and wrote the user file.
    const { execFileSync } = await import('node:child_process');
    const bin = path.join(__dirname, '..', 'dist', 'cli', 'index.js');
    const repo = path.join(workspace, 'scope-repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    const userDir = path.join(workspace, 'user-claude');
    fs.mkdirSync(userDir);
    const run = (args: string[]): string =>
      execFileSync('node', [bin, ...args], {
        cwd: repo,
        env: { ...process.env, AEGISX_HOME: path.join(workspace, 'home'), CLAUDE_CONFIG_DIR: userDir },
        encoding: 'utf8',
      });
    run(['hook', 'session-start', '--install', '--project', '--repo', repo]);
    expect(fs.existsSync(path.join(repo, '.claude', 'settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(userDir, 'settings.json'))).toBe(false);
    run(['hook', 'session-start', '--install', '--repo', repo]);
    expect(fs.existsSync(path.join(userDir, 'settings.json'))).toBe(true);
  });
});
