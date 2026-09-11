import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/core/engine.js';
import { AegisxError } from '../src/core/types.js';
import { containsSecret, lineContainsSecret } from '../src/core/secrets.js';
import { extractSymbols } from '../src/indexer/indexer.js';
import { bearerTokenMatches, startHttpServer } from '../src/mcp/http-server.js';

let workspace: string;
let repoDir: string;
let dbFile: string;
let engine: Engine;



beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-secret-'));
  repoDir = path.join(workspace, 'repo');
  fs.mkdirSync(repoDir);
  dbFile = path.join(workspace, 'memory.sqlite');
  engine = new Engine(dbFile);
});

afterEach(() => {
  engine.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('secrets — detector patterns (secrets.ts)', () => {
  it('happy: recognizes every high-confidence token shape', () => {
    expect(containsSecret('key=sk-abcdefghij0123456789abcdefghij')).toBe(true);
    expect(containsSecret('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(true);
    expect(containsSecret('github_pat_abcdefghij0123456789')).toBe(true);
    expect(containsSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true); // 4 + 16
    expect(containsSecret('xoxb-123456789012-abcdef')).toBe(true);
    expect(containsSecret('AIzaSyA1234567890abcdefghijklmnopqrstuv')).toBe(true);
    expect(containsSecret('npm_abcdefghijklmnopqrstuvwxyz0123456789abcd')).toBe(true);
    expect(containsSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig')).toBe(true);
    expect(containsSecret('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(containsSecret('postgres://root:hunter2@db.internal/app')).toBe(true);
  });

  it('happy: credential-named assignments are flagged even without a token prefix', () => {
    expect(lineContainsSecret('password=hunter2')).toBe(true);
    expect(lineContainsSecret('API_KEY: abc123')).toBe(true);
    expect(lineContainsSecret('authorization: Bearer xyz')).toBe(true);
    expect(lineContainsSecret('private_key = "-----BEGIN…"')).toBe(true);
  });

  it('negative: ordinary code and prose produce no false positives', () => {
    expect(containsSecret('export function loginUser(email: string) {}')).toBe(false);
    expect(containsSecret('npm install && npm run build')).toBe(false);
    expect(containsSecret('const subtotal = 42; // TODO: add tax')).toBe(false);
    expect(containsSecret('visit https://example.com/docs for help')).toBe(false);
    expect(containsSecret('the token bucket refills every second')).toBe(false);
    expect(containsSecret('How to use JWT auth safely')).toBe(false); // prose, not assignment
    expect(containsSecret('')).toBe(false);
    expect(lineContainsSecret('let tokenCount = 0;')).toBe(false);
    expect(lineContainsSecret('/* maxAuthAttempts = 3 */')).toBe(false);
  });
});

describe('secrets — Engine.remember (unified patterns)', () => {
  it('happy: clean facts still round-trip', () => {
    const fact = engine.remember('project.app.stack', 'typescript + sqlite', repoDir);
    expect(fact.value).toBe('typescript + sqlite');
  });

  it('negative: github fine-grained PAT is refused (previously missed by the engine)', () => {
    expect(() => engine.remember('cfg.gh', 'github_pat_abcdefghij0123456789', repoDir)).toThrow(
      /secret/i,
    );
  });

  it('negative: URL-embedded credentials are refused', () => {
    expect(() => engine.remember('cfg.db', 'postgres://root:hunter2@db.internal/app', repoDir)).toThrow(
      /secret/i,
    );
  });

  it('negative: Slack / Google / npm tokens are refused', () => {
    expect(() => engine.remember('cfg.slack', 'xoxb-123456789012-abcdef', repoDir)).toThrow(/secret/i);
    expect(() => engine.remember('cfg.g', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', repoDir)).toThrow(/secret/i);
    expect(() =>
      engine.remember('cfg.npm', 'npm_abcdefghijklmnopqrstuvwxyz0123456789abcd', repoDir),
    ).toThrow(/secret/i);
  });

  it('negative: credential-named assignments are refused without a token prefix (assignment path)', () => {
    expect(() => engine.remember('cfg.db', 'password=hunter2', repoDir)).toThrow(/secret/i);
    expect(() => engine.remember('cfg.k', 'api_key: abc123', repoDir)).toThrow(/secret/i);
    expect(() => engine.saveSession(repoDir, { goal: 'g', facts: [], decisions: [], nextSteps: ['set API_KEY=abc123 in prod'] })).toThrow(/secret/i);
  });
});

describe('secrets — Engine.saveSession (handoff path, the I1 gap)', () => {
  const cleanHandoff = { goal: 'fix login bug', facts: ['error at src/auth/login.ts:42'], decisions: [], nextSteps: [] };

  it('happy: clean handoff round-trips', () => {
    expect(() => engine.saveSession(repoDir, cleanHandoff)).not.toThrow();
    expect(engine.recall(null, repoDir).lastSession?.goal).toBe('fix login bug');
  });

  it('negative: secret-shaped fact in a handoff is refused', () => {
    expect(() =>
      engine.saveSession(repoDir, {
        ...cleanHandoff,
        facts: ['deployed with key sk-abcdefghij0123456789abcdefghij'],
      }),
    ).toThrow(/secret/i);
    // nothing was persisted
    expect(engine.recall(null, repoDir).lastSession).toBeUndefined();
  });

  it('negative: secrets in decisions, next steps, or the goal are refused', () => {
    expect(() =>
      engine.saveSession(repoDir, { ...cleanHandoff, decisions: ['rotate ghp_abcdefghijklmnopqrstuvwxyz0123456789'] }),
    ).toThrow(/decisions/);
    expect(() =>
      engine.saveSession(repoDir, { ...cleanHandoff, nextSteps: ['set password=hunter2 in prod'] }),
    ).toThrow(/nextSteps/);
    expect(() =>
      engine.saveSession(repoDir, { ...cleanHandoff, goal: 'use AKIAIOSFODNN7EXAMPLE' }),
    ).toThrow(/goal/);
  });

  it('negative: error message names the offending list (actionable diagnosis)', () => {
    try {
      engine.saveSession(repoDir, { ...cleanHandoff, facts: ['xoxb-123456789012-abcdef'] });
      expect.unreachable('must refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(AegisxError);
      expect((err as AegisxError).message).toContain('session facts item');
    }
  });
});

describe('secrets — indexer redaction (new classes)', () => {
  it('negative: lines with JWT / Slack / credential assignments are redacted from extraction', () => {
    const content = [
      'export function alpha() {}',
      'const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig"; // carry',
      'export function beta() {}',
      'const slack = "xoxb-123456789012-abcdef";',
      '// TODO: password=hunter2 rotation overdue',
      'export function gamma() {}',
    ].join('\n');
    const syms = extractSymbols('src/creds.ts', content);
    const names = syms.map((s) => s.name);
    expect(names).toContain('alpha');
    expect(names).toContain('beta');
    expect(names).toContain('gamma');
    // the secret-bearing lines produced no markers/imports
    expect(syms.filter((s) => s.kind === 'marker')).toEqual([]);
    expect(syms.filter((s) => s.kind === 'import')).toEqual([]);
  });

  it('happy: clean TODO markers and imports survive extraction', () => {
    const content = [
      '// TODO: add rate limiting to login',
      'import { hash } from "./crypto";',
      'export function alpha() {}',
    ].join('\n');
    const syms = extractSymbols('src/clean.ts', content);
    expect(syms.some((s) => s.kind === 'marker' && s.detail?.includes('rate limiting'))).toBe(true);
    expect(syms.some((s) => s.kind === 'import')).toBe(true);
  });
});

describe('secrets — DB file permissions (I4)', () => {
  it('happy: memory DB is created owner-only (0600), home dir 0700', () => {
    const dbFile = path.join(workspace, 'perm-check', 'memory.sqlite');
    const e = new Engine(dbFile);
    try {
      if (process.platform === 'win32') {
        return; // POSIX mode bits do not apply
      }
      const mode = fs.statSync(dbFile).mode & 0o777;
      expect(mode).toBe(0o600);
      const dirMode = fs.statSync(path.dirname(dbFile)).mode & 0o777;
      expect(dirMode).toBe(0o700);
    } finally {
      e.close();
    }
  });

  it('happy: reopening an existing DB never widens a locked-down file', () => {
    const dbFile = path.join(workspace, 'perm-keep', 'memory.sqlite');
    const first = new Engine(dbFile);
    first.close();
    fs.chmodSync(dbFile, 0o600);
    const second = new Engine(dbFile);
    try {
      if (process.platform === 'win32') {
        return;
      }
      expect(fs.statSync(dbFile).mode & 0o777).toBe(0o600);
    } finally {
      second.close();
    }
  });
});

describe('secrets — HTTP bearer token comparison', () => {
  it('happy: exact Bearer header matches', () => {
    expect(bearerTokenMatches('Bearer secret-token-123', 'secret-token-123')).toBe(true);
  });

  it('negative: wrong token, wrong scheme, prefix and length variants all fail', () => {
    expect(bearerTokenMatches('Bearer wrong', 'secret-token-123')).toBe(false);
    expect(bearerTokenMatches('secret-token-123', 'secret-token-123')).toBe(false); // scheme required
    expect(bearerTokenMatches('Bearer secret-token-12', 'secret-token-123')).toBe(false); // prefix
    expect(bearerTokenMatches('Bearer secret-token-1234', 'secret-token-123')).toBe(false); // extension
    expect(bearerTokenMatches('', 'secret-token-123')).toBe(false);
    expect(bearerTokenMatches('bearer secret-token-123', 'secret-token-123')).toBe(false); // case
  });

  it('negative: empty-string token is normalized to "no token" at the server boundary', async () => {
    // With token '' → null, requests without auth succeed (treated as no-auth);
    // the CLI additionally refuses non-localhost binds when no token is set.
    const handle = await startHttpServer({ port: 0, host: '127.0.0.1', token: '' });
    try {
      const status = await probeStatus(handle.port, {});
      expect(status).not.toBe(401);
    } finally {
      await handle.close();
    }
  });

  it('negative: array-shaped Authorization header cannot bypass the check', async () => {
    const handle = await startHttpServer({ port: 0, host: '127.0.0.1', token: 't' });
    try {
      const status = await probeStatus(handle.port, { authorization: 'Bearer t, Bearer t' });
      expect(status).toBe(401);
    } finally {
      await handle.close();
    }
  });
});

/** Minimal JSON-RPC initialize probe returning the HTTP status. */
function probeStatus(port: number, headers: Record<string, string>): Promise<number> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'probe', version: '0.0.0' },
    },
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
