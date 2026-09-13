import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { hookAutosave, parseAgentEventPayload, runHook } from '../src/cli/hooks.js';
import { hermesHookScripts } from '../src/cli/hermes-hooks.js';

let workspace: string;
let repoDir: string;
let prevEnv: Record<string, string | undefined>;

/** A GitHub-token-shaped fixture, assembled from parts so that this committed
 *  line is not itself a match for the pre-push secret scan — the guard should
 *  keep being loud about anything that looks like a live credential. */
const TOKEN_SHAPE = ['ghp', 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8'].join('_');

/** A `post_llm_call` payload in the shape Hermes actually sends it. */
function postLlmPayload(opts: { sessionId: string; user: string; assistant: string; historyExtra?: unknown[] }): string {
  return JSON.stringify({
    hook_event_name: 'post_llm_call',
    session_id: opts.sessionId,
    cwd: repoDir,
    profile: 'default',
    extra: {
      turn_id: 'turn-1',
      user_message: opts.user,
      assistant_response: opts.assistant,
      conversation_history: [
        { role: 'user', content: opts.user },
        { role: 'assistant', content: opts.assistant },
        ...(opts.historyExtra ?? []),
      ],
      model: 'test-model',
      platform: 'cli',
    },
  });
}

function dbFile(): string {
  return path.join(process.env['AEGISX_HOME'] ?? '', 'memory.sqlite');
}

function handoffs(): { id: number; goal: string; decisions: string }[] {
  const db = new Database(dbFile(), { readonly: true });
  try {
    return db.prepare('SELECT id, goal, decisions FROM sessions ORDER BY id').all() as { id: number; goal: string; decisions: string }[];
  } finally {
    db.close();
  }
}

function countKnowledge(): number {
  const db = new Database(dbFile(), { readonly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM knowledge').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-autosave-'));
  repoDir = path.join(workspace, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  prevEnv = { AEGISX_HOME: process.env['AEGISX_HOME'], AEGISX_AUTOSAVE: process.env['AEGISX_AUTOSAVE'] };
  process.env['AEGISX_HOME'] = path.join(workspace, 'aegisx-home');
  fs.mkdirSync(process.env['AEGISX_HOME'], { recursive: true });
});

afterEach(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('parseAgentEventPayload', () => {
  it('reads the fields the save path needs out of a Hermes post_llm_call body', () => {
    const parsed = parseAgentEventPayload(postLlmPayload({ sessionId: 'sess-7', user: 'Fix the parser', assistant: 'Gotcha: it breaks on empty input.' }));
    expect(parsed.sessionId).toBe('sess-7');
    expect(parsed.repo).toBe(repoDir);
    expect(parsed.userMessage).toBe('Fix the parser');
    expect(parsed.assistantResponse).toContain('breaks on empty input');
    expect(parsed.messages).toHaveLength(2);
  });

  it('treats an absent or malformed body as an empty transcript, not an error', () => {
    for (const raw of [null, '', '   ', 'not json', '[1,2,3]']) {
      const parsed = parseAgentEventPayload(raw);
      expect(parsed.messages).toEqual([]);
      expect(parsed.sessionId).toBe('');
    }
  });
});

describe('hook autosave — the deterministic save', () => {
  it('writes one handoff per session and rewrites that row as the session learns', () => {
    // A real session's `conversation_history` accumulates, so the checkpoint
    // sees the whole session and each rewrite keeps what earlier turns said.
    const turns = [
      {
        user: 'Add a retry budget to the worker',
        assistant: 'Decided to cap retries at three instead of retrying forever.',
      },
    ];
    const payload = (): string => {
      const latest = turns[turns.length - 1] ?? { user: '', assistant: '' };
      return JSON.stringify({
        hook_event_name: 'post_llm_call',
        session_id: 'sess-a',
        cwd: repoDir,
        extra: {
          user_message: latest.user,
          assistant_response: latest.assistant,
          conversation_history: turns.flatMap((turn) => [
            { role: 'user', content: turn.user },
            { role: 'assistant', content: turn.assistant },
          ]),
        },
      });
    };

    const first = hookAutosave({ payload: payload() });
    expect(first.saved).toBe(true);
    expect(first.detail).toContain('inserted');
    expect(handoffs()).toHaveLength(1);

    // Turn 2 said nothing new: no write, and the row count is what proves it.
    const again = hookAutosave({ payload: payload() });
    expect(again.saved).toBe(false);
    expect(again.detail).toContain('unchanged');
    expect(handoffs()).toHaveLength(1);

    // Turn 3 learned something: the same row is updated, not forked — and the
    // decision from turn 1 survives, because a checkpoint folds in the session.
    turns.push({ user: 'What is left to do here?', assistant: 'TODO: the dead-letter queue is next.' });
    const more = hookAutosave({ payload: payload() });
    expect(more.saved).toBe(true);
    expect(more.detail).toContain('updated');
    const rows = handoffs();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decisions).toContain('cap retries at three');
  });

  it('keeps a separate handoff per session', () => {
    hookAutosave({ payload: postLlmPayload({ sessionId: 'sess-1', user: 'Fix the parser', assistant: 'Gotcha: it breaks on empty input.' }) });
    hookAutosave({ payload: postLlmPayload({ sessionId: 'sess-2', user: 'Fix the lexer', assistant: 'Gotcha: the token regex was greedy.' }) });
    expect(handoffs()).toHaveLength(2);
  });

  it('writes nothing for a turn with nothing to remember', () => {
    const result = hookAutosave({ payload: postLlmPayload({ sessionId: 's', user: 'hi', assistant: 'Hello!' }) });
    expect(result.saved).toBe(false);
    expect(result.detail).toContain('nothing');
    expect(fs.existsSync(dbFile()) ? handoffs() : []).toHaveLength(0);
  });

  it('records the notes as knowledge, so recall has something to serve', () => {
    hookAutosave({
      payload: postLlmPayload({
        sessionId: 'sess-k',
        user: 'Rework the scheduler',
        assistant: 'Convention: always run the smoke test before pushing the scheduler change.',
      }),
    });
    expect(countKnowledge()).toBe(1);
    // Re-saving the same turn must not fork the note.
    hookAutosave({
      payload: postLlmPayload({
        sessionId: 'sess-k',
        user: 'Rework the scheduler',
        assistant: 'Convention: always run the smoke test before pushing the scheduler change.',
      }),
    });
    expect(countKnowledge()).toBe(1);
  });

  it('screens auto-ingested text for credentials exactly like a manual save', () => {
    // The automatic path takes whatever the transcript contains, so the refusal
    // contract has to hold here as hard as it does for `aegisxmemory save`.
    const payload = postLlmPayload({
      sessionId: 'sess-secret',
      user: 'Wire the deploy token',
      assistant: `Convention: the rollout key ${TOKEN_SHAPE} always lives in the vault, never in the repo.`,
    });
    expect(() => hookAutosave({ payload })).toThrow(/secret/i);
    // …and the hook still degrades to exit 0 rather than failing the turn.
    const outcome = runHook('autosave', { json: true, client: 'hermes', payload });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toBe('');
    expect(fs.existsSync(dbFile()) ? handoffs() : []).toHaveLength(0);
  });

  it('honours AEGISX_AUTOSAVE=0 — installed but silent', () => {
    process.env['AEGISX_AUTOSAVE'] = '0';
    const result = hookAutosave({
      payload: postLlmPayload({ sessionId: 's', user: 'Fix the parser', assistant: 'Gotcha: it breaks on empty input.' }),
    });
    expect(result.saved).toBe(false);
    expect(result.detail).toContain('disabled');
  });

  it('never writes to stdout: post_llm_call is an observer, not an injection point', () => {
    const outcome = runHook('autosave', {
      json: true,
      client: 'hermes',
      payload: postLlmPayload({ sessionId: 'sess-o', user: 'Fix the parser', assistant: 'Gotcha: it breaks on empty input.' }),
    });
    expect(outcome.stdout).toBe('');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toContain('saved');
    expect(handoffs()).toHaveLength(1);
  });
});

describe('the generated autosave script', () => {
  it('runs end-to-end under sh: writes the handoff, prints nothing', () => {
    const spec = hermesHookScripts(`node ${JSON.stringify(path.resolve('dist/cli/index.js'))}`).find((s) => s.event === 'post_llm_call');
    if (spec === undefined) throw new Error('expected the autosave script');
    const script = path.join(workspace, 'autosave-probe.sh');
    fs.writeFileSync(script, spec.body);
    fs.chmodSync(script, 0o755);

    const out = execFileSync('sh', [script], {
      input: postLlmPayload({
        sessionId: 'sess-script',
        user: 'Add a retry budget to the worker',
        assistant: 'Decided to cap retries at three instead of retrying forever.',
      }),
      encoding: 'utf8',
      env: { ...process.env },
    });
    expect(out).toBe('');
    const rows = handoffs();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.goal).toBe('Add a retry budget to the worker');
  });

  it('is registered on the observer event, not on the injection event', () => {
    const spec = hermesHookScripts('aegisxmemory-fake').find((s) => s.event === 'post_llm_call');
    expect(spec?.file).toBe('aegisx-autosave.sh');
    expect(spec?.body).toContain('hook autosave --json --client hermes');
    expect(spec?.body).not.toContain('is_first_turn');
  });
});
