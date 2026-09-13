/**
 * `aegisxmemory hook <event>` — the deterministic layer of the memory loop.
 *
 * The rules block (SOUL.md / AGENTS.md) and the MCP `instructions` field ask
 * the model to recall and save; hooks do not ask. They are invoked by the
 * agent itself at fixed lifecycle points, so memory loads and the handoff
 * reminder fire even when the model ignores every instruction file.
 *
 * Contract per event (stdout is the protocol — never a log destination):
 *   hook session-start  human: the budgeted recall block; on a repo that has
 *                       never been indexed, one capped indexing pass runs
 *                       first (deadline enforced between files — the scan is
 *                       synchronous by design, so there is no fake abort).
 *                       --json: Claude Code SessionStart output — the same
 *                       block inside hookSpecificOutput.additionalContext;
 *                       --client hermes emits Hermes' bare {"context": …}.
 *   hook session-end    human: one-line save reminder on stderr, stdout empty.
 *                       --json: Claude Code Stop output {decision:"block",
 *                       reason} so the agent itself is told to save the
 *                       handoff. --json only: a human does not need nagging.
 *   hook post-edit      incremental index of one repo; JSON summary. A failure
 *                       degrades to a stderr note and exit 0 — a hook must
 *                       never turn a quiet repo into an agent-visible error.
 *
 * Every event is best-effort about the memory home: a missing database is a
 * note, not a crash, because a hook that throws on first run teaches users to
 * delete hooks.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AegisxError } from '../core/types.js';
import { Engine, DEFAULT_TOKEN_BUDGET } from '../core/engine.js';
import { selfServerEntry } from './mcp-config.js';

/** Budget for hook session-start auto-index. Set below the dashboard's
 *  MAX_INDEX_MS so a hook never takes longer than the slowest UI path. */
export const HOOK_INDEX_DEADLINE_MS = 10_000;
/** Budget for hook post-edit. Edits touch few files, so the incremental scan
 *  is fast; the budget only binds on a cold first run. */
export const POST_EDIT_DEADLINE_MS = 15_000;
/** Floor for the cooperative deadline: below this, timing jitter decides
 *  results, so a tiny budget would be nondeterminism, not a feature. */
export const MIN_HOOK_DEADLINE_MS = 250;

export type HookEvent = 'session-start' | 'session-end' | 'post-edit';

/** Which agent's hook protocol to emit. The two dialects differ in ways that
 *  fail *silently* when crossed — Hermes' `_parse_context` reads a top-level
 *  `{"context": …}` and never looks at Claude's `hookSpecificOutput`, so a
 *  mismatched payload injects nothing and logs nothing. */
export type HookClient = 'claude' | 'hermes';

export function parseHookEvent(value: string): HookEvent {
  if (value === 'session-start' || value === 'session-end' || value === 'post-edit') return value;
  throw new AegisxError('user', `unknown hook event "${value}"; expected one of: session-start, session-end, post-edit`);
}

export function parseHookClient(value: string): HookClient {
  if (value === 'claude' || value === 'hermes') return value;
  throw new AegisxError('user', `unknown hook client "${value}"; expected one of: claude, hermes`);
}

export function positiveIntArg(name: string): (value: string) => number {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new AegisxError('user', `--${name} must be a positive integer, got "${value}"`);
    return n;
  };
}

/** Resolve the repo a hook refers to. Hooks run with the agent's cwd inside
 *  the project; a `repo` argument lets tests and callers anchor explicitly. */
export function resolveHookRepo(explicit: string | undefined): string {
  return fs.realpathSync.native(path.resolve(explicit ?? process.cwd()));
}

function memoryDbFile(): string {
  const home = process.env['AEGISX_HOME'] ?? path.join(os.homedir(), '.aegisx');
  return path.join(home, 'memory.sqlite');
}

/* --------------------------------------------------------- session-start */

export interface SessionStartResult {
  repo: string;
  indexed: boolean;
  indexNote: string | null;
  context: string;
}

/**
 * session-start: index once if the repo was never scanned, then produce the
 * recall block. The deadline is cooperative: Indexer.scan loops over files,
 * so we ask it to stop between files once the budget is spent — an honest
 * cap with a follow-up hint, not an abort that silently loses work.
 */
export function hookSessionStart(opts: { repo?: string; budget?: number; deadlineMs?: number } = {}): SessionStartResult {
  const repo = resolveHookRepo(opts.repo);
  const deadlineMs = Math.max(MIN_HOOK_DEADLINE_MS, opts.deadlineMs ?? HOOK_INDEX_DEADLINE_MS);
  const engine = openEngine();
  try {
    let indexed = false;
    let indexNote: string | null = null;
    // Auto-index (roadmap 2.3): only when this repo has never been scanned.
    // Every later session pays zero indexing cost, and the engine's allowlist
    // guard still applies — a denied repo is reported, never indexed.
    if (engine.statsFor(repo).scans.total === 0) {
      const stats = engine.indexRepoWithDeadline(repo, Date.now() + deadlineMs);
      if (stats !== null) {
        indexed = true;
        indexNote = `auto-indexed ${stats.filesTotal} files (${stats.symbolsTotal} symbols) in ${stats.durationMs}ms`;
      } else {
        indexNote = `first index paused after its ${Math.round(deadlineMs / 1000)}s budget — run \`aegisxmemory index .\` to finish it`;
      }
    }
    const result = engine.recall(null, repo, opts.budget ?? DEFAULT_TOKEN_BUDGET);
    return { repo, indexed, indexNote, context: engine.renderMarkdown(result) };
  } finally {
    engine.close();
  }
}

/* ------------------------------------------------------------ session-end */

export interface SessionEndResult {
  repo: string;
  hasHandoffEver: boolean;
  reminder: string;
}

/** session-end: the save reminder. Parsing and storage stay with
 *  `aegisxmemory save`; the hook only makes sure the model is told. */
export function hookSessionEnd(opts: { repo?: string } = {}): SessionEndResult {
  let repo: string;
  try {
    repo = resolveHookRepo(opts.repo);
  } catch {
    repo = os.tmpdir();
  }
  let hasHandoffEver = false;
  try {
    const engine = openEngine();
    try {
      hasHandoffEver = engine.repoMemory(repo).counts.sessions > 0;
    } finally {
      engine.close();
    }
  } catch {
    // no memory home yet — the reminder is still worth printing
  }
  const reminder = hasHandoffEver
    ? 'Session ending. Call aegisxmemory_save (or run `aegisxmemory save --json -`) with this session\'s goal, facts, decisions, gotchas, conventions and nextSteps before stopping.'
    : 'Session ending. If anything was worked out this session (goal, decisions, gotchas), call aegisxmemory_save so the next session starts knowing it.';
  return { repo, hasHandoffEver, reminder };
}

/* -------------------------------------------------------------- post-edit */

export interface PostEditResult {
  repo: string;
  indexed: boolean;
  summary: string;
}

/** post-edit: one incremental scan under the cooperative deadline. Cheap by
 *  construction (hash-based; only changed files re-extract); the deadline
 *  only binds on a cold first run. */
export function hookPostEdit(opts: { repo?: string; deadlineMs?: number } = {}): PostEditResult {
  const repo = resolveHookRepo(opts.repo);
  const deadlineMs = Math.max(MIN_HOOK_DEADLINE_MS, opts.deadlineMs ?? POST_EDIT_DEADLINE_MS);
  const engine = openEngine();
  try {
    const stats = engine.indexRepoWithDeadline(repo, Date.now() + deadlineMs);
    if (stats === null) {
      return { repo, indexed: false, summary: `incremental index paused after its ${Math.round(deadlineMs / 1000)}s budget; run \`aegisxmemory index .\` to finish` };
    }
    return { repo, indexed: true, summary: `${stats.filesChanged} changed, ${stats.filesDeleted} deleted — ${stats.symbolsTotal} symbols in ${stats.durationMs}ms` };
  } finally {
    engine.close();
  }
}

function openEngine(): Engine {
  return new Engine(memoryDbFile());
}

/* ------------------------------------------------------- hook installation */

/** The substring a hook command carries so a later run recognizes its own
 *  work. Lives in the command itself, so idempotence survives re-formatting
 *  of the settings file by other tools. */
export const HOOK_SESSION_START_MARKER = 'aegisx-memory:session-start';
export const HOOK_POST_EDIT_MARKER = 'aegisx-memory:post-edit';

interface ClaudeHookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

interface ClaudeHookGroup {
  matcher?: string;
  hooks: ClaudeHookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookGroup[]>;
  [key: string]: unknown;
}

/** Claude Code's hook config: user scope `~/.claude/settings.json` (or
 *  $CLAUDE_CONFIG_DIR), project scope `<repo>/.claude/settings.json`. */
export function claudeSettingsPath(project: boolean, repoDir?: string): string {
  if (!project) {
    const env = process.env['CLAUDE_CONFIG_DIR'];
    return path.join(env !== undefined && env !== '' ? env : path.join(os.homedir(), '.claude'), 'settings.json');
  }
  return path.join(repoDir ?? process.cwd(), '.claude', 'settings.json');
}

/** Build the two hook command lines. The binary is referenced by name when
 *  this process is the installed CLI (`aegisxmemory` on PATH), and via the
 *  absolute node entry otherwise, mirroring defaultServerConfig's resolve. */
export function hookCommandLines(bin: boolean): { sessionStart: string; postEdit: string } {
  const argv0 = process.argv[1] ?? '';
  const invokedAsBin = bin || path.basename(argv0) === 'aegisxmemory.js' || path.basename(argv0) === 'aegisxmemory';
  const base = invokedAsBin ? 'aegisxmemory' : `node ${JSON.stringify(selfServerEntry())}`;
  return {
    sessionStart: `${base} hook session-start --json --deadline ${HOOK_INDEX_DEADLINE_MS} # ${HOOK_SESSION_START_MARKER}`,
    postEdit: `${base} hook post-edit --deadline ${POST_EDIT_DEADLINE_MS} # ${HOOK_POST_EDIT_MARKER}`,
  };
}

export interface HookInstallResult {
  action: 'created' | 'merged' | 'unchanged' | 'error';
  path: string;
  backup: string | null;
  detail: string;
}

/** Merge both hook entries into a Claude Code settings.json, backing the file
 *  up before any write. Idempotent by marker detection inside the command
 *  string; user-authored hooks are never touched. */
export function installClaudeHooks(settingsFile: string, bin = false): HookInstallResult {
  const { sessionStart, postEdit } = hookCommandLines(bin);
  let parsed: ClaudeSettings = {};
  const existed = fs.existsSync(settingsFile);
  if (existed) {
    const raw = fs.readFileSync(settingsFile, 'utf8');
    try {
      const value: unknown = JSON.parse(raw);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { action: 'error', path: settingsFile, backup: null, detail: `"${settingsFile}" does not contain a JSON object — nothing was written` };
      }
      parsed = value as ClaudeSettings;
    } catch (err) {
      return {
        action: 'error',
        path: settingsFile,
        backup: null,
        detail: `"${settingsFile}" is not valid JSON (${err instanceof Error ? err.message : String(err)}) — fix or remove the file; nothing was written`,
      };
    }
  }
  const hooks: Record<string, ClaudeHookGroup[]> = parsed.hooks ?? {};
  const ssList = hooks['SessionStart'] ?? [];
  const ptuList = hooks['PostToolUse'] ?? [];

  const ssEntry: ClaudeHookEntry = { type: 'command', command: sessionStart };
  const peEntry: ClaudeHookEntry = { type: 'command', command: postEdit };

  const ssGroup = ssList.find((g) => Array.isArray(g.hooks) && g.hooks.some((h) => typeof h.command === 'string' && h.command.includes(HOOK_SESSION_START_MARKER)));
  const peGroup = ptuList.find((g) => g.matcher === 'Write|Edit' && Array.isArray(g.hooks) && g.hooks.some((h) => typeof h.command === 'string' && h.command.includes(HOOK_POST_EDIT_MARKER)));

  if (ssGroup !== undefined && peGroup !== undefined) {
    const ssBefore = JSON.stringify(ssGroup.hooks);
    const peBefore = JSON.stringify(peGroup.hooks);
    ssGroup.hooks = ssGroup.hooks.filter((h) => !(typeof h.command === 'string' && h.command.includes(HOOK_SESSION_START_MARKER))).concat(ssEntry);
    peGroup.hooks = peGroup.hooks.filter((h) => !(typeof h.command === 'string' && h.command.includes(HOOK_POST_EDIT_MARKER))).concat(peEntry);
    if (JSON.stringify(ssGroup.hooks) === ssBefore && JSON.stringify(peGroup.hooks) === peBefore) {
      return { action: 'unchanged', path: settingsFile, backup: null, detail: 'hooks already installed — nothing written' };
    }
  }

  let backup: string | null = null;
  if (existed) {
    backup = `${settingsFile}.aegisx-bak`;
    fs.copyFileSync(settingsFile, backup);
  }
  if (ssGroup === undefined) {
    ssList.push({ matcher: 'startup|resume', hooks: [ssEntry] });
    hooks['SessionStart'] = ssList;
  }
  if (peGroup === undefined) {
    ptuList.push({ matcher: 'Write|Edit', hooks: [peEntry] });
    hooks['PostToolUse'] = ptuList;
  }
  parsed.hooks = hooks;
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, `${JSON.stringify(parsed, null, 2)}\n`);
  return {
    action: existed ? 'merged' : 'created',
    path: settingsFile,
    backup,
    detail: backup === null ? 'hook file created' : `previous file kept at ${backup}`,
  };
}

export function describeHookInstall(result: HookInstallResult): string {
  const icon = result.action === 'error' ? '✗' : '✓';
  return `${icon} hooks (${result.action}): ${result.path}${result.backup === null ? '' : ` (backup: ${result.backup})`}\n  ${result.detail}`;
}

/* ------------------------------------------------------------- run/render */

export interface HookRunOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const EMPTY_CONTEXT_HINT =
  'AegisX-Memory: no memory stored for this repository yet. It will fill as facts are remembered and sessions are saved.';

/** Render one hook event for one mode. Pure (no process I/O) so the protocol
 *  is testable without spawning the CLI. `client` picks the wire dialect. */
export function renderHook(event: HookEvent, r: SessionStartResult | SessionEndResult | PostEditResult, json: boolean, client: HookClient = 'claude'): HookRunOutcome {
  if (event === 'session-start') {
    const r0 = r as SessionStartResult;
    const parts = [r0.indexNote, r0.context].filter((s): s is string => s !== null && s !== '');
    if (json) {
      const ctx = parts.length === 0 ? EMPTY_CONTEXT_HINT : `AegisX-Memory (project memory, local):\n${parts.join('\n')}`;
      // Hermes reads a bare top-level `context` key; Claude Code reads
      // `hookSpecificOutput`. Emitting the wrong one is a silent no-op.
      if (client === 'hermes') {
        return { exitCode: 0, stdout: `${JSON.stringify({ context: ctx })}\n`, stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }, null, 2)}\n`,
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: parts.length === 0 ? '(no memory stored for this repository yet)\n' : `${parts.join('\n')}\n`, stderr: '' };
  }
  if (event === 'session-end') {
    const r1 = r as SessionEndResult;
    if (json) {
      // Stop-hook contract: the agent is told to act on the reminder instead
      // of merely displaying it. Claude Code blocks on decision/reason;
      // Hermes' `_parse_pre_verify` reads action/message (it also accepts the
      // Claude pair, but its native shape is the explicit one).
      const payload = client === 'hermes'
        ? { action: 'continue', message: r1.reminder }
        : { decision: 'block', reason: r1.reminder };
      return { exitCode: 0, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: `${r1.reminder}\n` };
  }
  const r2 = r as PostEditResult;
  if (json) return { exitCode: 0, stdout: `${JSON.stringify({ ok: true, ...r2 }, null, 2)}\n`, stderr: '' };
  return { exitCode: 0, stdout: `${r2.summary}\n`, stderr: '' };
}

/** Facade used by the CLI action: computes the result and renders it, mapping
 *  every failure to exit 0 + a stderr note — hooks degrade, never error out. */
export function runHook(event: HookEvent, opts: { json: boolean; repo?: string; budget?: number; deadlineMs?: number; client?: HookClient }): HookRunOutcome {
  const client = opts.client ?? 'claude';
  try {
    if (event === 'session-start') return renderHook(event, hookSessionStart(opts), opts.json, client);
    if (event === 'session-end') return renderHook(event, hookSessionEnd(opts), opts.json, client);
    return renderHook(event, hookPostEdit(opts), opts.json, client);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { exitCode: 0, stdout: '', stderr: `aegisx-memory: ${event} skipped (${msg})\n` };
  }
}

/** Claude Code sends the event JSON on stdin; we only need `cwd` from it, and
 *  only best-effort — an empty or malformed body means "use process cwd". */
export function repoFromStdinJson(raw: string | null): string | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const cwd = parsed['cwd'];
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
  } catch {
    return undefined;
  }
}
