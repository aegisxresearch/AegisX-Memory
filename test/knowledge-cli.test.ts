/**
 * End-to-end CLI coverage for the two owner-facing read commands, `knowledge`
 * and `export` — options, text contract, JSON contract and exit codes.
 *
 * Runs the built bundle (dist/cli/index.js), the way a user does; when no build
 * exists (bare `npx vitest run` on a fresh checkout) the suite skips, exactly
 * like the MCP stdio test — node cannot execute the TypeScript sources directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startDashboard } from '../src/cli/dashboard.js';
import { Engine } from '../src/core/engine.js';
import { dbPath } from '../src/core/paths.js';

const DIST_ENTRY = path.resolve('dist/cli/index.js');
const suite = fs.existsSync(DIST_ENTRY) ? describe : describe.skip;

let workspace: string;
let repo: string;
let home: string;

interface Run {
  stdout: string;
  stderr: string;
  status: number;
}

function cli(args: string[], env: Record<string, string> = {}, cwd: string = repo): Run {
  const options = { cwd, encoding: 'utf8' as const, env: { ...process.env, AEGISX_HOME: home, ...env } };
  try {
    return { stdout: execFileSync(process.execPath, [DIST_ENTRY, ...args], options), stderr: '', status: 0 };
  } catch (err) {
    const failure = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? ''),
      status: failure.status ?? 1,
    };
  }
}

function saveHandoff(handoff: object, cwd: string = repo, env: Record<string, string> = {}): Run {
  const options = {
    cwd,
    encoding: 'utf8' as const,
    input: JSON.stringify(handoff),
    env: { ...process.env, AEGISX_HOME: home, ...env },
  };
  try {
    return { stdout: execFileSync(process.execPath, [DIST_ENTRY, 'save', '--json', '-'], options), stderr: '', status: 0 };
  } catch (err) {
    const failure = err as { status?: number | null; stdout?: string | Buffer; stderr?: string | Buffer };
    return { stdout: String(failure.stdout ?? ''), stderr: String(failure.stderr ?? ''), status: failure.status ?? 1 };
  }
}

interface KnowledgeJson {
  ok: boolean;
  knowledge: Array<{ id: number; kind: string; title: string; body: string; repo: string }>;
}

beforeAll(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisx-kcli-'));
  repo = path.join(workspace, 'demo');
  home = path.join(workspace, 'home');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(repo, 'app.py'), 'def main():\n    pass\n');

  expect(cli(['init']).status).toBe(0);
  expect(cli(['remember', 'project.demo.stack', 'flask']).status).toBe(0);
  const saved = saveHandoff({
    goal: 'ship the demo',
    facts: [],
    decisions: ['pick sqlite over postgres'],
    gotchas: ['port clash on 5000'],
    conventions: ['two-space indent'],
    nextSteps: ['write tests'],
  });
  expect(saved.status).toBe(0);
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

suite('knowledge — the CLI browse surface', () => {
  it('lists every entry with the id and kind it keys on', () => {
    const { stdout, status } = cli(['knowledge']);
    expect(status).toBe(0);
    expect(stdout).toContain('knowledge (3):');
    expect(stdout).toMatch(/#\d+\s+\[decision\] pick sqlite over postgres/);
    expect(stdout).toContain('[gotcha] port clash on 5000');
    expect(stdout).toContain('[convention] two-space indent');
  });

  it('filters by kind, by repo and by query', () => {
    const gotcha = cli(['knowledge', '--kind', 'gotcha']);
    expect(gotcha.status).toBe(0);
    expect(gotcha.stdout).toContain('port clash on 5000');
    expect(gotcha.stdout).not.toContain('pick sqlite');

    expect(cli(['knowledge', '--repo', '.']).stdout).toContain('pick sqlite');
    expect(cli(['knowledge', 'sqlite']).stdout).toContain('pick sqlite');
    expect(cli(['knowledge', 'sqlite']).stdout).not.toContain('two-space indent');
  });

  it('--json prints strict JSON that carries the ids', () => {
    const parsed = JSON.parse(cli(['knowledge', '--json']).stdout) as KnowledgeJson;
    expect(parsed.ok).toBe(true);
    expect(parsed.knowledge).toHaveLength(3);
    expect(parsed.knowledge.every((entry) => typeof entry.id === 'number')).toBe(true);
    expect(parsed.knowledge.every((entry) => entry.repo.length > 0)).toBe(true);
  });

  it('rejects an unknown kind, and says so when a filter matches nothing', () => {
    const bad = cli(['knowledge', '--kind', 'nonsense']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('--kind must be one of');

    const empty = cli(['knowledge', '--kind', 'lesson']);
    expect(empty.status).toBe(0);
    expect(empty.stdout).toBe('no knowledge entries match\n');
  });

  it('a capped listing names the true total instead of letting the cap read as the store size', () => {
    const capped = cli(['knowledge', '--limit', '1']);
    expect(capped.status).toBe(0);
    expect(capped.stdout).toContain('knowledge (1):');
    expect(capped.stdout).toContain('(showing the newest 1 of 3 — raise --limit or narrow the filters)');
    expect(cli(['knowledge', '--limit', '2']).stdout).toContain('showing the newest 2 of 3');

    // The total follows the filters, not the whole table…
    const scoped = cli(['knowledge', '--repo', '.', '--limit', '1']);
    expect(scoped.stdout).toContain('showing the newest 1 of 3');

    // …and a filter that already fits claims no cap at all.
    expect(cli(['knowledge', '--kind', 'decision', '--limit', '1']).stdout).not.toContain('showing');
    expect(cli(['knowledge', '--limit', '50']).stdout).not.toContain('showing');

    const parsed = JSON.parse(cli(['knowledge', '--limit', '1', '--json']).stdout) as {
      shown: number;
      total: number;
      knowledge: unknown[];
    };
    expect(parsed.shown).toBe(1);
    expect(parsed.total).toBe(3);
    expect(parsed.knowledge).toHaveLength(1);
  });

  it('--repos summarises every repository, and refuses filters it would have to ignore', () => {
    const text = cli(['knowledge', '--repos']);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('repos with memory (1):');
    expect(text.stdout).toContain('3 knowledge entries · 1 fact · 1 handoff');
    expect(text.stdout).toContain('1 repo · 3 knowledge entries · 1 fact · 1 handoff');

    const parsed = JSON.parse(cli(['knowledge', '--repos', '--json']).stdout) as {
      ok: boolean;
      repos: Array<{ repo: string; counts: { facts: number; knowledge: number; sessions: number } }>;
      totals: { facts: number; knowledge: number; sessions: number };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.repos).toHaveLength(1);
    expect(parsed.repos[0]!.repo).toBe(repo);
    expect(parsed.repos[0]!.counts).toEqual({ facts: 1, knowledge: 3, sessions: 1 });
    expect(parsed.totals).toEqual({ facts: 1, knowledge: 3, sessions: 1 });

    // Narrowing to a repo is meaningful; dropping entry filters silently is not.
    expect(JSON.parse(cli(['knowledge', '--repos', '--json', '--repo', '.']).stdout)).toMatchObject({
      repos: [{ repo }],
    });
    const elsewhere = path.join(workspace, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    const miss = cli(['knowledge', '--repos', '--repo', elsewhere]);
    expect(miss.status).toBe(0);
    expect(miss.stdout).toBe(`no memory stored for ${elsewhere}\n`);

    const withKind = cli(['knowledge', '--repos', '--kind', 'gotcha']);
    expect(withKind.status).toBe(1);
    expect(withKind.stderr).toContain('--repos summarises repositories');
    const withQuery = cli(['knowledge', 'sqlite', '--repos']);
    expect(withQuery.status).toBe(1);
    expect(withQuery.stderr).toContain('--repos summarises repositories');
    const withForget = cli(['knowledge', '--repos', '--forget', '1']);
    expect(withForget.status).toBe(1);
    expect(withForget.stderr).toContain('--repos and --forget cannot be combined');
  });

  it('agrees with the dashboard page: the same repo reports the same totals in both', async () => {
    // The point of `--repos` is that the terminal and the memory page cannot
    // disagree, so this compares the CLI's JSON against the live endpoint's.
    // The CLI runs with AEGISX_HOME in its child env; this in-process server
    // needs the same home, or it would open a different database entirely.
    const previousHome = process.env['AEGISX_HOME'];
    process.env['AEGISX_HOME'] = home;
    const dash = await startDashboard({ port: 0, host: '127.0.0.1', open: false }, new Engine(dbPath()));
    try {
      const repoCounts = await new Promise<{ facts: number; knowledge: number; sessions: number }>((resolve, reject) => {
        http
          .get(new URL('/api/memory?repo=' + encodeURIComponent(repo), dash.url), (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => resolve((JSON.parse(body) as { counts: never }).counts));
          })
          .on('error', reject);
      });

      const parsed = JSON.parse(cli(['knowledge', '--repos', '--json']).stdout) as {
        repos: Array<{ repo: string; counts: { facts: number; knowledge: number; sessions: number } }>;
        totals: { facts: number; knowledge: number; sessions: number };
      };
      expect(parsed.repos[0]!.counts).toEqual(repoCounts);

      // …and the CLI's own listing total agrees with the page's knowledge count.
      const listing = JSON.parse(cli(['knowledge', '--repo', '.', '--json']).stdout) as { total: number };
      expect(listing.total).toBe(repoCounts.knowledge);
      expect(parsed.totals.knowledge).toBe(repoCounts.knowledge);
    } finally {
      await dash.stop();
      if (previousHome === undefined) { delete process.env['AEGISX_HOME']; }
      else { process.env['AEGISX_HOME'] = previousHome; }
    }
  });
});

suite('export — the CLI dump', () => {
  it('defaults to markdown with every section and the real contents', () => {
    const { stdout, status } = cli(['export']);
    expect(status).toBe(0);
    expect(stdout).toContain('# AegisX-Memory export');
    expect(stdout).toContain('## Repositories');
    expect(stdout).toContain('## Facts (1)');
    expect(stdout).toContain('## Knowledge (3)');
    expect(stdout).toContain('## Handoffs (1)');
    expect(stdout).toContain('- `project.demo.stack` = `flask`');
    expect(stdout).toContain('### ship the demo');
    expect(stdout).toContain('- **Next steps:** write tests');
  });

  it('--format json prints the same dump as strict JSON', () => {
    const parsed = JSON.parse(cli(['export', '--format', 'json']).stdout) as {
      ok: boolean;
      home: string;
      totals: { facts: number; knowledge: number; sessions: number };
      sessions: Array<{ goal: string; nextSteps: string[] }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.home).toBe(home);
    expect(parsed.totals).toEqual({ repos: 1, facts: 1, knowledge: 3, sessions: 1 });
    expect(parsed.sessions[0]?.goal).toBe('ship the demo');
    expect(parsed.sessions[0]?.nextSteps).toEqual(['write tests']);
  });

  it('--json is shorthand for --format json, and an unknown format is a user error', () => {
    expect((JSON.parse(cli(['export', '--json']).stdout) as { ok: boolean }).ok).toBe(true);
    const bad = cli(['export', '--format', 'xml']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('--format must be md or json');
  });

  it('--repo scopes the dump to one repository', () => {
    const parsed = JSON.parse(cli(['export', '--format', 'json', '--repo', '.']).stdout) as {
      repos: Array<{ repo: string }>;
      facts: unknown[];
    };
    expect(parsed.repos).toHaveLength(1);
    expect(parsed.facts).toHaveLength(1);
  });
});

suite('knowledge — the allowlist gates what the CLI will show and delete', () => {
  it('hides another repo, and refuses to delete its entries', () => {
    const other = path.join(workspace, 'other');
    fs.mkdirSync(other, { recursive: true });
    expect(
      saveHandoff(
        { goal: 'other work', facts: [], decisions: ['other decision'], gotchas: [], conventions: [], nextSteps: [] },
        other,
      ).status,
    ).toBe(0);

    // Visible without a policy, so we can learn the id the refusal must protect
    const all = JSON.parse(cli(['knowledge', '--json']).stdout) as KnowledgeJson;
    const hidden = all.knowledge.find((entry) => entry.title === 'other decision');
    expect(hidden).toBeDefined();

    const allow = { AEGISX_ALLOWED_REPOS: repo };
    const listed = JSON.parse(cli(['knowledge', '--json'], allow).stdout) as KnowledgeJson;
    expect(listed.knowledge.map((entry) => entry.title)).not.toContain('other decision');

    const denied = cli(['knowledge', '--forget', String(hidden!.id)], allow);
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain('is not in AEGISX_ALLOWED_REPOS');

    // export honours the same door
    const dump = JSON.parse(cli(['export', '--format', 'json'], allow).stdout) as { knowledge: Array<{ title: string }> };
    expect(dump.knowledge.map((entry) => entry.title)).not.toContain('other decision');

    // …and so does the per-repo summary: it counts exactly what the listing shows,
    // so a hidden repo cannot reappear as a row in the CLI's totals.
    const summaries = JSON.parse(cli(['knowledge', '--repos', '--json'], allow).stdout) as {
      repos: Array<{ repo: string }>;
      totals: { facts: number; knowledge: number; sessions: number };
    };
    expect(summaries.repos.map((entry) => entry.repo)).toEqual([repo]);
    expect(summaries.totals.knowledge).toBe(3);

    // and the refused row is still there when the policy is lifted
    expect((JSON.parse(cli(['knowledge', '--json']).stdout) as KnowledgeJson).knowledge).toHaveLength(4);
  });

  it('--forget deletes exactly one entry, and a second attempt exits 1', () => {
    const before = JSON.parse(cli(['knowledge', '--json']).stdout) as KnowledgeJson;
    const target = before.knowledge.find((entry) => entry.title === 'two-space indent');
    expect(target).toBeDefined();

    const done = cli(['knowledge', '--forget', String(target!.id)]);
    expect(done.status).toBe(0);
    expect(done.stdout).toBe(`deleted knowledge #${target!.id}\n`);

    const after = JSON.parse(cli(['knowledge', '--json']).stdout) as KnowledgeJson;
    expect(after.knowledge).toHaveLength(before.knowledge.length - 1);
    expect(after.knowledge.map((entry) => entry.title)).not.toContain('two-space indent');

    const again = cli(['knowledge', '--forget', String(target!.id)]);
    expect(again.status).toBe(1);
    expect(again.stderr).toBe(`error: no knowledge entry with id ${target!.id}\n`);
  });
});
