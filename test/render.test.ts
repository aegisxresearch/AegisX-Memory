/**
 * The CLI's owner-facing renderers are pure functions, so they are tested on
 * their own — no database, no terminal, no child process. The end-to-end CLI
 * behaviour (options, exit codes) is covered separately in knowledge-cli.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { renderExportMarkdown, renderKnowledgeList } from '../src/cli/render.js';
import type { MemoryExport } from '../src/core/types.js';

function dump(overrides: Partial<MemoryExport> = {}): MemoryExport {
  return {
    generatedAt: '2026-09-12T10:00:00.000Z',
    rowLimit: 5_000,
    totals: { repos: 0, facts: 0, knowledge: 0, sessions: 0 },
    repos: [],
    facts: [],
    knowledge: [],
    sessions: [],
    ...overrides,
  };
}

describe('renderKnowledgeList', () => {
  it('names the count, and the id and kind the CLI keys on', () => {
    const text = renderKnowledgeList([
      { id: 7, kind: 'decision', title: 'pick sqlite', body: 'WAL + FTS5', anchors: [], updatedAt: '2026-09-12T00:00:00.000Z', repo: '~/demo' },
      { id: 8, kind: 'gotcha', title: 'port clash', body: 'dev server on 5000', anchors: [], updatedAt: '2026-09-11T00:00:00.000Z', repo: '~/demo' },
    ]);

    expect(text).toContain('knowledge (2):');
    expect(text).toContain('#7  [decision] pick sqlite');
    expect(text).toContain('#8  [gotcha] port clash');
    expect(text).toContain('~/demo · 2026-09-12 · WAL + FTS5');
    expect(text).toContain('~/demo · 2026-09-11 · dev server on 5000');
  });

  it('does not echo a body that is just the title again', () => {
    const text = renderKnowledgeList([
      { id: 3, kind: 'decision', title: 'pick sqlite', body: 'pick sqlite', anchors: [], updatedAt: '2026-09-12T00:00:00.000Z', repo: '~/demo' },
    ]);
    expect(text).toContain('~/demo · 2026-09-12');
    expect(text).not.toContain('2026-09-12 · pick sqlite');
  });

  it('collapses a multi-line body onto the preview line', () => {
    const text = renderKnowledgeList([
      { id: 1, kind: 'convention', title: 'tidy', body: 'first line\nsecond line', anchors: [], updatedAt: '2026-09-12T00:00:00.000Z', repo: '~/demo' },
    ]);
    expect(text).toContain('first line second line');
    expect(text).not.toContain('first line\nsecond line');
  });

  it('says so when there is nothing to list', () => {
    expect(renderKnowledgeList([])).toBe('no knowledge entries stored yet\n');
  });
});

describe('renderExportMarkdown', () => {
  it('renders every section, with counts that match the lists', () => {
    const text = renderExportMarkdown(
      dump({
        totals: { repos: 1, facts: 1, knowledge: 1, sessions: 1 },
        repos: [{ repo: '~/demo', files: 8, symbols: 18, scans: 9, recalls: 3, hitRate: 33.3, tokensSavedEstimate: 1_200 }],
        facts: [{ key: 'project.demo.stack', value: 'flask', repoHint: '~/demo', updatedAt: '2026-09-12T00:00:00.000Z' }],
        knowledge: [
          { id: 1, kind: 'decision', title: 'pick sqlite', body: 'WAL + FTS5', anchors: ['docs/adr-1.md'], updatedAt: '2026-09-12T00:00:00.000Z', repo: '~/demo' },
        ],
        sessions: [
          { repo: '~/demo', goal: 'ship it', facts: ['f1'], decisions: ['pick sqlite'], gotchas: [], conventions: [], nextSteps: ['write tests'], createdAt: '2026-09-12T00:00:00.000Z' },
        ],
      }),
      '/home/me/.aegisx',
    );

    expect(text).toContain('# AegisX-Memory export');
    expect(text).toContain('/home/me/.aegisx');
    expect(text).toContain('**1** repository · **1** facts · **1** knowledge entries · **1** handoffs');
    expect(text).toContain('## Repositories');
    expect(text).toContain('| `~/demo` | 8 | 18 | 9 | 3 | 33.3% | 1200 |');
    expect(text).toContain('## Facts (1)');
    expect(text).toContain('- `project.demo.stack` = `flask` · `~/demo` · 2026-09-12');
    expect(text).toContain('## Knowledge (1)');
    expect(text).toContain('### decision · pick sqlite');
    expect(text).toContain('anchors: `docs/adr-1.md`');
    expect(text).toContain('> WAL + FTS5');
    expect(text).toContain('## Handoffs (1)');
    expect(text).toContain('### ship it');
    expect(text).toContain('- **Facts:** f1');
    expect(text).toContain('- **Next steps:** write tests');
    // an empty list is left out of a handoff rather than printed as a blank row
    expect(text).not.toContain('- **Gotchas:**');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('records the superseded value of a re-pinned fact', () => {
    const text = renderExportMarkdown(
      dump({
        totals: { repos: 0, facts: 1, knowledge: 0, sessions: 0 },
        facts: [{ key: 'project.x.port', value: '3000', previousValue: '8000', repoHint: null, updatedAt: '2026-09-12T00:00:00.000Z' }],
      }),
      '/h',
    );
    expect(text).toContain('- `project.x.port` = `3000` · 2026-09-12 · was `8000`');
  });

  it('notes a section that hit the row cap instead of ending silently', () => {
    const facts = Array.from({ length: 2 }, (_, i) => ({
      key: `k${i}`,
      value: 'v',
      repoHint: null,
      updatedAt: '2026-09-12T00:00:00.000Z',
    }));
    const text = renderExportMarkdown(
      dump({ rowLimit: 2, totals: { repos: 0, facts: 2, knowledge: 0, sessions: 0 }, facts }),
      '/h',
    );
    expect(text).toContain('**Truncated:** facts reached the 2-row export cap');
  });

  it('shows empty sections as empty rather than omitting them', () => {
    const text = renderExportMarkdown(dump(), '/h');
    expect(text).toContain('**0** repositories');
    expect(text).toContain('_No facts stored._');
    expect(text).toContain('_No knowledge entries stored._');
    expect(text).toContain('_No handoffs stored._');
    expect(text).not.toContain('## Repositories');
    expect(text).not.toContain('Truncated');
  });

  it('keeps a pipe in a repo path from splitting the table row', () => {
    const text = renderExportMarkdown(
      dump({
        totals: { repos: 1, facts: 0, knowledge: 0, sessions: 0 },
        repos: [{ repo: 'a|b', files: 0, symbols: 0, scans: 0, recalls: 0, hitRate: null, tokensSavedEstimate: null }],
      }),
      '/h',
    );
    expect(text).toContain('| `a\\|b` | 0 | 0 | 0 | 0 | — | — |');
  });
});
