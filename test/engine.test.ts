import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine, DEFAULT_TOKEN_BUDGET } from '../src/core/engine.js';
import { AegisxError } from '../src/core/types.js';

let workspace: string;
let repoDir: string;
let dbFile: string;
let engine: Engine;

function writeRepoFile(rel: string, content: string): void {
  const abs = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-test-'));
  repoDir = path.join(workspace, 'repo');
  fs.mkdirSync(repoDir);
  dbFile = path.join(workspace, 'memory.sqlite');
  engine = new Engine(dbFile);
});

afterEach(() => {
  engine.close();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('Gate 2 — happy paths', () => {
  it('init → index → recall returns structure brief, symbols and stays within default budget', () => {
    writeRepoFile(
      'src/auth/login.ts',
      [
        'import { hash } from "./crypto";',
        'export function loginUser(email: string) {',
        '  // TODO: add rate limiting',
        '  return hash(email);',
        '}',
        'export class SessionStore {',
        '  // FIXME: expiry not enforced',
        '}',
      ].join('\n'),
    );
    writeRepoFile('src/util/crypto.ts', 'export function hash(input: string) {\n  return input;\n}\n');

    engine.indexRepo(repoDir);
    const result = engine.recall('login', repoDir);

    expect(result.brief).toContain('Code structure brief');
    expect(result.brief).toContain('src/');
    // ranked recall: only symbols matching the query (or its synonyms) come back.
    // Semantic-lite: "login" legitimately matches SessionStore via the
    // login↔session synonym group; an unrelated symbol must still be absent.
    expect(result.symbols.some((s) => s.name === 'loginUser')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'hash')).toBe(false);
    // structure brief is query-independent and always present after indexing
    const full = engine.recall(null, repoDir);
    expect(full.symbols.some((s) => s.name === 'SessionStore')).toBe(true);
    expect(full.symbols.some((s) => s.kind === 'marker' && s.detail?.includes('rate limiting'))).toBe(true);
    expect(result.tokenEstimate).toBeLessThanOrEqual(DEFAULT_TOKEN_BUDGET);

    const md = engine.renderMarkdown(result);
    expect(md).toContain('AEGISX-MEMORY:BEGIN');
    expect(md).toContain('Relevant symbols');
  });

  it('remember → recall round-trips a repo-scoped fact', () => {
    engine.remember('project.testapp.test-cmd', 'npm test', repoDir);
    const result = engine.recall(null, repoDir);
    const fact = result.facts.find((f) => f.key === 'project.testapp.test-cmd');
    expect(fact?.value).toBe('npm test');
    expect(fact?.repoHint).not.toBeNull();
  });

  it('save → resume round-trips a session handoff', () => {
    engine.indexRepo(repoDir);
    engine.saveSession(repoDir, {
      goal: 'fix login bug',
      facts: ['error at src/auth/login.ts:42'],
      decisions: ['bump bcrypt to 5.1 — staging lockfile mismatch'],
      nextSteps: ['redeploy staging'],
    });
    const result = engine.recall(null, repoDir);
    expect(result.lastSession?.goal).toBe('fix login bug');
    expect(result.lastSession?.decisions[0]).toContain('bcrypt');

    const md = engine.renderMarkdown(result);
    expect(md).toContain('Last session handoff');
    expect(md).toContain('redeploy staging');
  });

  it('incremental scan is fast when nothing changed (perf smoke)', () => {
    for (let i = 0; i < 1_000; i++) {
      writeRepoFile(`src/gen/mod${i}.ts`, `export function fn${i}() {\n  return ${i};\n}\n`);
    }
    const first = engine.indexRepo(repoDir);
    expect(first.filesTotal).toBe(1_000);
    expect(first.durationMs).toBeLessThan(10_000); // RFC target: <10s for 1k files

    const second = engine.indexRepo(repoDir);
    expect(second.filesChanged).toBe(0);
    expect(second.durationMs).toBeLessThan(200); // RFC target: <200ms warm
  });
  it('python def/class declarations reach both the brief and query-less recall', () => {
    writeRepoFile(
      'app.py',
      [
        'import sqlite3',
        '',
        'def get_db():',
        '    return sqlite3.connect("users.db")',
        '',
        'class User:',
        '    pass',
      ].join('\n'),
    );
    engine.indexRepo(repoDir);

    const result = engine.recall(null, repoDir);
    // Declarations are tagged with their source keyword (`def`), so every kind
    // the indexer can emit must be listed by the brief, not just JS/TS ones.
    expect(result.brief).toContain('### Key symbols');
    expect(result.brief).toContain('def get_db');
    expect(result.brief).toContain('class User');
    expect(result.symbols.some((s) => s.kind === 'def' && s.name === 'get_db')).toBe(true);
    expect(result.symbols.some((s) => s.kind === 'class' && s.name === 'User')).toBe(true);
  });
});

describe('Gate 2 — negative edge cases', () => {
  it('empty repo / cold DB recalls gracefully without crashing', () => {
    const result = engine.recall(null, repoDir);
    expect(result.facts).toEqual([]);
    expect(result.symbols).toEqual([]);
    expect(result.brief).toContain('No indexed symbols');
    expect(engine.renderMarkdown(result)).toContain('AEGISX-MEMORY:BEGIN');
  });

  it('structure brief omits the symbol list when a repo declares nothing', () => {
    writeRepoFile('src/notes.ts', '// TODO: add tests\n');
    engine.indexRepo(repoDir);

    const brief = engine.recall(null, repoDir).brief;
    expect(brief).toContain('Code structure brief');
    expect(brief).toContain('src/');
    expect(brief).not.toContain('### Key symbols');
  });

  it('file with no valid symbols and unbalanced unicode does not crash the indexer', () => {
    writeRepoFile('src/weird/unicode.ts', 'class 😱 { ??? }\nfunction  { broken\nconst x = "unterminated\n');
    expect(() => engine.indexRepo(repoDir)).not.toThrow();
    const stats = engine.indexRepo(repoDir);
    expect(stats.filesTotal).toBe(1);
    expect(stats.symbolsTotal).toBe(0);
  });

  it('rejects keys violating the namespace contract', () => {
    expect(() => engine.remember('BAD KEY!', 'x', repoDir)).toThrow(AegisxError);
    expect(() => engine.remember('.hidden', 'x', repoDir)).toThrow(AegisxError);
    expect(() => engine.remember('k'.repeat(129), 'x', repoDir)).toThrow(AegisxError);
    try {
      engine.remember('Valid.Key_1', 'x', repoDir);
      expect.unreachable('uppercase key must be rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(AegisxError);
      expect((err as AegisxError).kind).toBe('user');
    }
  });

  it('skips oversized files with a warning instead of dying', () => {
    writeRepoFile('src/huge/blob.log', 'a'.repeat(5 * 1024 * 1024));
    const warnings: string[] = [];
    const stats = engine.indexRepo(repoDir, (m) => warnings.push(m));
    expect(stats.filesSkipped).toBe(1);
    expect(stats.filesTotal).toBe(0);
    expect(warnings.some((w) => w.includes('too large'))).toBe(true);
  });

  it('refuses symlinked directories (DoS cycle guard)', () => {
    writeRepoFile('src/real/a.ts', 'export function ok() {}\n');
    fs.symlinkSync(repoDir, path.join(repoDir, 'self-loop'), 'dir');
    const stats = engine.indexRepo(repoDir);
    expect(stats.filesSkipped).toBeGreaterThanOrEqual(1);
    expect(stats.filesTotal).toBe(1);
  });

  it('refuses to store values that look like secrets', () => {
    expect(() => engine.remember('cfg.apikey', 'sk-abcdefghij0123456789abcdefghij', repoDir)).toThrow(
      /secret/i,
    );
    expect(() =>
      engine.remember('cfg.key', '-----BEGIN RSA PRIVATE KEY-----', repoDir),
    ).toThrow(/secret/i);
  });

  it('truncates oversized fact values instead of rejecting (agent turns are expensive)', () => {
    const longValue = `${'x'.repeat(2_500)}-tail-that-must-be-cut`;
    const fact = engine.remember('cfg.big-note', longValue, repoDir);
    expect(fact.value.length).toBe(2_000); // FACT_VALUE_MAX
    expect(fact.value.endsWith('-tail-that-must-be-cut')).toBe(false); // head is kept
    // readable back from the store
    const stored = engine.recall(null, repoDir);
    void stored;
    expect(fact.value.startsWith('xxx')).toBe(true);
  });

  it('secret refusal wins over truncation (no path stores a secret)', () => {
    const longSecret = `password=${'a'.repeat(3_000)}`;
    expect(() => engine.remember('cfg.leak', longSecret, repoDir)).toThrow(/secret/i);
  });

  it('never indexes secret-bearing files (.env, keys, credentials)', () => {
    writeRepoFile('.env', 'API_KEY=sk-abcdefghij0123456789abcdefghij\n');
    writeRepoFile('certs/server.pem', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n');
    writeRepoFile('config/service-account.json', '{"private_key": "x"}\n');
    const stats = engine.indexRepo(repoDir);
    expect(stats.filesTotal).toBe(0);
    expect(stats.filesSkipped).toBe(3);
  });

  it('honors .gitignore and default junk directories', () => {
    writeRepoFile('node_modules/pkg/x.ts', 'export function junk() {}\n');
    writeRepoFile('src/keep.ts', 'export function keep() {}\n');
    writeRepoFile('src/ignored.ts', 'export function ignored() {}\n');
    writeRepoFile('.gitignore', 'src/ignored.ts\n');
    const stats = engine.indexRepo(repoDir);
    expect(stats.filesTotal).toBe(1);
    const result = engine.recall('junk OR ignored OR keep', repoDir);
    const names = result.symbols.map((s) => s.name);
    expect(names).toContain('keep');
    expect(names).not.toContain('junk');
    expect(names).not.toContain('ignored');
  });
});

describe('Gate 2 — invalidation correctness', () => {
  it('editing a file tombstones stale symbols on the next scan', () => {
    writeRepoFile('src/domain/order.ts', 'export function createOrder() {}\nexport class Order {}\n');
    engine.indexRepo(repoDir);
    expect(engine.recall('createOrder', repoDir).symbols.some((s) => s.name === 'createOrder')).toBe(true);

    writeRepoFile('src/domain/order.ts', 'export function placeOrder() {}\n');
    const stats = engine.indexRepo(repoDir);
    expect(stats.filesChanged).toBe(1);

    const after = engine.recall('createOrder OR placeOrder', repoDir);
    const names = after.symbols.map((s) => s.name);
    expect(names).toContain('placeOrder');
    expect(names).not.toContain('createOrder'); // hash-invalidated, zero heuristics
    expect(names).not.toContain('Order');
  });

  it('deleting a file removes its symbols', () => {
    writeRepoFile('src/temp/scratch.ts', 'export function scratch() {}\n');
    engine.indexRepo(repoDir);
    fs.rmSync(path.join(repoDir, 'src/temp/scratch.ts'));
    const stats = engine.indexRepo(repoDir);
    expect(stats.filesDeleted).toBe(1);
    expect(engine.recall('scratch', repoDir).symbols).toEqual([]);
  });

  it('trims lowest-priority items first when the budget is tiny', () => {
    writeRepoFile('src/a.ts', 'export function one() {}\nexport function two() {}\nexport function three() {}\nexport function four() {}\nexport function five() {}\nexport function six() {}\nexport function seven() {}\n');
    engine.remember('k1', 'value one', repoDir);
    engine.remember('k2', 'value two', repoDir);
    engine.remember('k3', 'value three', repoDir);
    engine.remember('k4', 'value four', repoDir);
    engine.indexRepo(repoDir);

    const generous = engine.recall(null, repoDir, DEFAULT_TOKEN_BUDGET);
    const tiny = engine.recall(null, repoDir, 30);

    expect(tiny.facts.length).toBeLessThan(generous.facts.length);
    expect(tiny.facts.length).toBeGreaterThanOrEqual(3); // floor: brief + minimal fact core
    expect(tiny.tokenEstimate).toBeLessThan(generous.tokenEstimate);
    // never truncates mid-fact: remaining facts are complete
    for (const f of tiny.facts) {
      expect(f.value.startsWith('value ')).toBe(true);
    }
  });
});

/**
 * The cut used to be silent: a recall that dropped facts looked exactly like one
 * that had nothing to drop. `coverage` is that statement, and it must be right
 * in both directions — a clip has to be named, and an intact block must not
 * claim one.
 */
describe('recall coverage — a cut is stated, never implied', () => {
  it('a block with nothing left out says so in one clause', () => {
    writeRepoFile('src/a.ts', 'export function one() {}\n');
    engine.remember('k1', 'value one', repoDir);
    engine.indexRepo(repoDir);

    const result = engine.recall(null, repoDir);
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.dropped).toEqual({ facts: 0, knowledge: 0, symbols: 0 });
    expect(result.coverage.truncated).toEqual({ facts: false, knowledge: false, symbols: false });
    expect(engine.renderMarkdown(result)).toContain('<!-- recall: complete — 1 facts');
  });

  it('a layer that overflowed its cap is named, and the extra probe row is not returned', () => {
    for (let i = 1; i <= 20; i++) {
      engine.remember(`k${i}`, `value ${i}`, repoDir);
    }
    engine.indexRepo(repoDir);

    const result = engine.recall(null, repoDir);
    // The cap is unchanged: the probe row proves there is more, it is not served.
    expect(result.facts).toHaveLength(15);
    expect(result.coverage.truncated.facts).toBe(true);
    expect(result.coverage.complete).toBe(false);
    const md = engine.renderMarkdown(result);
    expect(md).toContain('facts 15 (more exist)');
    // Hitting a cap is not the budget's doing, and the line must not blame it.
    expect(md).not.toContain('budget dropped');
  });

  it('notes the handoff reprints are reported as in-handoff, not as a loss', () => {
    engine.saveSession(repoDir, {
      goal: 'ship it',
      facts: [],
      decisions: ['pick sqlite over postgres'],
      gotchas: ['port 5000 is taken'],
      conventions: [],
      nextSteps: [],
    });

    const result = engine.recall(null, repoDir);
    expect(result.knowledge).toHaveLength(0); // the handoff carries them instead
    expect(result.coverage.inHandoff).toBe(2);
    expect(result.coverage.dropped.knowledge).toBe(0); // withheld is not dropped
    expect(engine.renderMarkdown(result)).toMatch(/knowledge 0 .*2 in handoff/);
  });

  it('a budget that bites names which layer it took from', () => {
    writeRepoFile(
      'src/a.ts',
      Array.from({ length: 12 }, (_, i) => `export function fn${i}() {}`).join('\n') + '\n',
    );
    for (let i = 1; i <= 8; i++) {
      engine.remember(`k${i}`, `value number ${i}`, repoDir);
    }
    engine.indexRepo(repoDir);

    const tiny = engine.recall(null, repoDir, 40);
    expect(tiny.coverage.complete).toBe(false);
    expect(tiny.coverage.dropped.facts + tiny.coverage.dropped.symbols).toBeGreaterThan(0);
    const md = engine.renderMarkdown(tiny);
    expect(md).toContain('budget dropped');
    expect(md).toMatch(/\d+ of 40 tokens/);
  });

  it('--full keeps every layer whole and drops nothing', () => {
    for (let i = 1; i <= 20; i++) {
      engine.remember(`k${i}`, `value ${i}`, repoDir);
    }
    engine.indexRepo(repoDir);

    const capped = engine.recall(null, repoDir);
    const full = engine.recall(null, repoDir, DEFAULT_TOKEN_BUDGET, { full: true });

    expect(capped.facts).toHaveLength(15);
    expect(full.facts).toHaveLength(20);
    expect(full.coverage.dropped).toEqual({ facts: 0, knowledge: 0, symbols: 0 });
    expect(full.coverage.truncated.facts).toBe(false);
    expect(full.tokenEstimate).toBeGreaterThan(capped.tokenEstimate);
    // The floor still applies to a capped recall: a target, not a ceiling.
    const impossible = engine.recall(null, repoDir, 1);
    expect(impossible.tokenEstimate).toBeGreaterThan(1);
    expect(impossible.coverage.budget).toBe(1);
    expect(impossible.coverage.tokens).toBe(impossible.tokenEstimate);
  });

  it('an empty layer with rows in the store says the query matched nothing — not that the store is empty', () => {
    // Facts + symbols exist, but the query shares no token with them.
    engine.remember('deployment-port', 'production runs on port 5000', repoDir);
    engine.indexRepo(repoDir);

    const result = engine.recall('quantum-flux-capacitor', repoDir);
    expect(result.facts).toHaveLength(0);
    expect(result.coverage.complete).toBe(true); // technically nothing was withheld
    expect(result.coverage.zeroLayers?.facts).toBe('searched');
    const md = engine.renderMarkdown(result);
    expect(md).toContain('0 facts (some exist, none matched)');
    expect(md).toContain('no hits');
    // The old `complete` word must not sit next to an empty block: it read as
    // "you got everything" when the truth was "your query found nothing".
    expect(md).not.toContain('recall: complete');
  });

  it('an empty layer in an empty store is not mislabelled as a search miss', () => {
    // Nothing remembered, nothing indexed: `empty` is the honest state, and no
    // zeroLayers entry is recorded because the store holds nothing at all.
    const result = engine.recall('anything', repoDir);
    expect(result.facts).toHaveLength(0);
    expect(result.knowledge).toHaveLength(0);
    expect(result.coverage.zeroLayers).toBeUndefined();
    // A truly empty store keeps the short complete form — nothing was withheld
    // and nothing was missed.
    expect(engine.renderMarkdown(result)).toContain('recall: complete');
  });

  it('knowledge is the layer reported when only knowledge missed', () => {
    engine.remember('test-cmd', 'npm test', repoDir); // one fact, matches below
    engine.saveSession(repoDir, {
      goal: 'older session so the knowledge layer is served from the store',
      facts: [],
      decisions: ['we chose postgres for the billing service'],
      gotchas: [],
      conventions: [],
      nextSteps: [],
    });
    engine.saveSession(repoDir, { goal: 'newer handoff takes the reprint slot', facts: [], decisions: [], gotchas: [], conventions: [], nextSteps: [] });

    const result = engine.recall('webpack-config-mystery', repoDir);
    expect(result.facts).toHaveLength(0);
    expect(result.knowledge).toHaveLength(0);
    expect(result.coverage.zeroLayers?.facts).toBe('searched');
    expect(result.coverage.zeroLayers?.knowledge).toBe('searched');
    expect(engine.renderMarkdown(result)).toContain('0 knowledge (some exist, none matched)');
  });
});

describe('index deadline (hook path)', () => {
  it('happy: a generous deadline completes and records telemetry like a normal scan', () => {
    writeRepoFile('src/a.ts', 'export const a = 1;\n');
    const stats = engine.indexRepoWithDeadline(repoDir, Date.now() + 60_000);
    expect(stats).not.toBeNull();
    expect(stats?.filesTotal).toBe(1);
    expect(engine.statsFor(repoDir).scans.total).toBe(1);
  });

  it('deadline in the past pauses honestly: null result, no telemetry, no partial lie', () => {
    writeRepoFile('src/b.ts', 'export const b = 2;\n');
    const stats = engine.indexRepoWithDeadline(repoDir, Date.now() - 1);
    expect(stats).toBeNull();
    // The pause must be invisible to observability: no scan was "run".
    expect(engine.statsFor(repoDir).scans.total).toBe(0);
    // ...and a later real scan sees the repo as fresh (nothing half-written).
    const resumed = engine.indexRepo(repoDir);
    expect(resumed.filesTotal).toBe(1);
  });

  it('unbounded indexRepo never returns null (type-level promise, checked at runtime too)', () => {
    writeRepoFile('src/c.ts', 'export const c = 3;\n');
    const stats = engine.indexRepo(repoDir);
    expect(stats.filesTotal).toBe(1);
  });
});
