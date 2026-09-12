/**
 * Terminal renderers for the CLI's owner-facing read commands (`export`,
 * `knowledge`).
 *
 * Kept out of the entry point for the same reason the doctor report is: these
 * are pure functions — payload in, text out — so they can be tested without a
 * database, a terminal, or the process's stdout. The `--json` paths never come
 * through here; they print the structured payload the other commands share.
 */
import type { KnowledgeRecord, MemoryExport, MemoryFact, SessionRecord } from '../core/types.js';

/** One-line preview for terminal output (the store and `--json` keep it whole). */
function preview(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Inline code span, falling back to plain text when the content would break it. */
function code(text: string): string {
  return text.includes('`') ? text : `\`${text}\``;
}

/** Escape the one character that would split a markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** Date half of an ISO timestamp — a dump is read at day resolution. */
function day(iso: string | undefined): string {
  return iso === undefined || iso.length < 10 ? '—' : iso.slice(0, 10);
}

/**
 * The owner's view of the knowledge store: one line per entry (id and kind,
 * which are the two things `--forget` and `--kind` key on) with the entry's
 * repository, date and a body preview underneath.
 */
export function renderKnowledgeList(entries: KnowledgeRecord[]): string {
  if (entries.length === 0) {
    return 'no knowledge entries stored yet\n';
  }
  const lines: string[] = [`knowledge (${entries.length}):`];
  for (const entry of entries) {
    lines.push(`  #${entry.id ?? '?'}  [${entry.kind}] ${preview(entry.title)}`);
    const meta = [entry.repo ?? '—', day(entry.updatedAt)];
    // A handoff-sourced entry's body *is* its sentence, so echoing it would just
    // repeat the title on the next line.
    if (entry.body.trim().length > 0 && entry.body.trim() !== entry.title.trim()) {
      meta.push(preview(entry.body, 84));
    }
    lines.push(`       ${meta.join(' · ')}`);
  }
  return lines.join('\n') + '\n';
}

/** `3 facts` / `1 fact` — the CLI counts should read like sentences. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * One line per repository: what each holds, in the same three numbers the
 * dashboard's repo picker and memory page report (`Store.countForRepo`).
 *
 * `aegisxmemory knowledge --repos` is the terminal twin of that picker, so the
 * totals are read from the same source rather than recomputed here — two
 * implementations of "how much does this repo hold" is how they drift.
 */
export function renderRepoSummaries(
  summaries: Array<{ repo: string; counts: { facts: number; knowledge: number; sessions: number } }>,
  /** The repo the caller narrowed to, so an empty result can name it instead of
   *  claiming the whole store is empty. */
  scope?: string,
): string {
  if (summaries.length === 0) {
    return scope === undefined
      ? 'no repositories have memory yet — run “aegisxmemory index .” inside a project\n'
      : `no memory stored for ${scope}\n`;
  }
  const width = Math.max(...summaries.map((entry) => entry.repo.length));
  const lines: string[] = [`repos with memory (${summaries.length}):`];
  for (const entry of summaries) {
    const { facts, knowledge, sessions } = entry.counts;
    lines.push(
      `  ${entry.repo.padEnd(width)}  ` +
        `${plural(knowledge, 'knowledge entry', 'knowledge entries')} · ` +
        `${plural(facts, 'fact')} · ${plural(sessions, 'handoff')}`,
    );
  }
  const totals = summaries.reduce(
    (sum, entry) => ({
      facts: sum.facts + entry.counts.facts,
      knowledge: sum.knowledge + entry.counts.knowledge,
      sessions: sum.sessions + entry.counts.sessions,
    }),
    { facts: 0, knowledge: 0, sessions: 0 },
  );
  lines.push(
    '',
    `${plural(summaries.length, 'repo')} · ${plural(totals.knowledge, 'knowledge entry', 'knowledge entries')} · ` +
      `${plural(totals.facts, 'fact')} · ${plural(totals.sessions, 'handoff')}`,
  );
  return lines.join('\n') + '\n';
}

function factLine(fact: MemoryFact): string {
  const parts = [`- ${code(fact.key)} = ${code(fact.value)}`];
  if (fact.repoHint !== null) {
    parts.push(code(fact.repoHint));
  }
  parts.push(day(fact.updatedAt));
  if (fact.previousValue !== undefined) {
    parts.push(`was ${code(fact.previousValue)}`);
  }
  return parts.join(' · ');
}

function knowledgeSection(entry: KnowledgeRecord): string {
  const lines: string[] = [`### ${entry.kind} · ${entry.title}`, ''];
  const meta: string[] = [];
  if (entry.repo !== undefined) {
    meta.push(code(entry.repo));
  }
  meta.push(`updated ${day(entry.updatedAt)}`);
  if (entry.anchors.length > 0) {
    meta.push(`anchors: ${entry.anchors.map((anchor) => code(anchor)).join(', ')}`);
  }
  lines.push(meta.join(' · '), '');
  // Blockquote keeps a multi-line body visually distinct from the next heading.
  for (const line of entry.body.split('\n')) {
    lines.push(`> ${line}`);
  }
  return lines.join('\n');
}

function handoffSection(session: SessionRecord): string {
  const lines: string[] = [`### ${session.goal}`, '', `${code(session.repo)} · ${day(session.createdAt)}`, ''];
  const lists: Array<[string, string[]]> = [
    ['Facts', session.facts],
    ['Decisions', session.decisions],
    ['Gotchas', session.gotchas],
    ['Conventions', session.conventions],
    ['Next steps', session.nextSteps],
  ];
  for (const [label, items] of lists) {
    if (items.length > 0) {
      lines.push(`- **${label}:** ${items.join('; ')}`);
    }
  }
  return lines.join('\n');
}

/**
 * Whole-memory dump as markdown. The counts in each heading are what the dump
 * actually contains, and a section that reached the export row cap says so
 * instead of ending silently.
 */
export function renderExportMarkdown(data: MemoryExport, home: string): string {
  const out: string[] = [];
  out.push('# AegisX-Memory export', '');
  out.push(
    `_Generated ${data.generatedAt} · memory home ${code(home)} · local-first, nothing left this machine._`,
    '',
  );
  out.push('## Summary', '');
  out.push(
    `**${data.totals.repos}** repositor${data.totals.repos === 1 ? 'y' : 'ies'} · ` +
      `**${data.totals.facts}** facts · ` +
      `**${data.totals.knowledge}** knowledge entries · ` +
      `**${data.totals.sessions}** handoffs`,
    '',
  );

  if (data.repos.length > 0) {
    out.push('## Repositories', '');
    out.push('| Repository | Files | Symbols | Scans | Recalls | Hit rate | Tokens saved (est.) |');
    out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const repo of data.repos) {
      out.push(
        `| ${cell(code(repo.repo))} | ${repo.files} | ${repo.symbols} | ${repo.scans} | ${repo.recalls} | ` +
          `${repo.hitRate === null ? '—' : `${repo.hitRate}%`} | ` +
          `${repo.tokensSavedEstimate === null ? '—' : repo.tokensSavedEstimate} |`,
      );
    }
    out.push('');
  }

  out.push(`## Facts (${data.facts.length})`, '');
  out.push(data.facts.length === 0 ? '_No facts stored._' : data.facts.map(factLine).join('\n'), '');

  out.push(`## Knowledge (${data.knowledge.length})`, '');
  out.push(
    data.knowledge.length === 0
      ? '_No knowledge entries stored._'
      : data.knowledge.map(knowledgeSection).join('\n\n'),
    '',
  );

  out.push(`## Handoffs (${data.sessions.length})`, '');
  out.push(
    data.sessions.length === 0
      ? '_No handoffs stored._'
      : data.sessions.map(handoffSection).join('\n\n'),
    '',
  );

  const capped: string[] = [];
  if (data.facts.length >= data.rowLimit) capped.push('facts');
  if (data.knowledge.length >= data.rowLimit) capped.push('knowledge');
  if (data.sessions.length >= data.rowLimit) capped.push('handoffs');
  if (capped.length > 0) {
    out.push(
      `> **Truncated:** ${capped.join(', ')} reached the ${data.rowLimit}-row export cap for this dump.`,
      '',
    );
  }

  return out.join('\n').replace(/\n+$/, '') + '\n';
}
