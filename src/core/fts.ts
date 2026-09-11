/**
 * Shared FTS5 query builder.
 * Free text is split into terms; each term is quoted (injection-safe) and
 * AND-joined. Uppercase AND / OR / NOT tokens are passed through as FTS5
 * operators so users can write "login OR signup".
 */
const OPERATORS = new Set(['AND', 'OR', 'NOT']);
const MAX_TERMS = 24;

export function buildFtsQuery(input: string): string | null {
  const tokens = input.split(/\s+/).filter((t) => t.length > 0).slice(0, MAX_TERMS * 2);
  const parts: string[] = [];
  let sawTerm = false;
  for (const token of tokens) {
    if (OPERATORS.has(token)) {
      if (sawTerm) {
        parts.push(token);
      }
      continue;
    }
    const clean = token.replace(/["'()*:^]/g, ' ').trim();
    if (clean === '') {
      continue;
    }
    parts.push(`"${clean}"`);
    sawTerm = true;
    if (parts.filter((p) => !OPERATORS.has(p)).length >= MAX_TERMS) {
      break;
    }
  }
  while (parts.length > 0 && OPERATORS.has(parts[parts.length - 1] ?? '')) {
    parts.pop();
  }
  const query = parts.join(' ').trim();
  return query === '' ? null : query;
}
// touch
