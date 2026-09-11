/**
 * Shared FTS5 query builder.
 * Free text is split into terms; each term is quoted (injection-safe) and
 * AND-joined. Uppercase AND / OR / NOT tokens are passed through as FTS5
 * operators so users can write "login OR signup".
 *
 * Semantic-lite (T0): each plain term is expanded before matching so a
 * recall phrased in one language still hits facts written in another, and
 * short stems still hit longer words — with no model and no network:
 *   1. bilingual synonym groups (ID ↔ EN, hand-written, deterministic)
 *   2. common prefix expansion (auth → authentication, port → portable…)
 *   3. hard cap on the number of OR alternatives per term (query blow-up guard)
 */
const OPERATORS = new Set(['AND', 'OR', 'NOT']);
const MAX_TERMS = 24;
const MAX_ALTS_PER_TERM = 5;

/**
 * Hand-written synonym groups — deterministic, zero-cost, trivially correctable.
 * One term per language side keeps groups small; recall matches ANY group hit
 * via OR, so covering the two languages users of this tool actually mix is the
 * highest-value expansion available without embeddings.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  // auth & users
  ['auth', 'login', 'masuk', 'sesi', 'session', 'autentikasi'],
  ['password', 'sandi', 'kata-sandi', 'passphrase'],
  ['user', 'pengguna', 'akun', 'account'],
  ['register', 'daftar', 'signup', 'pendaftaran'],
  ['logout', 'keluar', 'keluar-sesi'],
  // running & building
  ['run', 'jalan', 'jalankan', 'serve', 'start', 'mulai'],
  ['build', 'kompilasi', 'compile', 'bangun'],
  ['port', 'pintu'],
  ['server', 'host', 'peladen'],
  ['deploy', 'rilis', 'release', 'publikasi'],
  // testing & quality
  ['test', 'uji', 'tes', 'spec', 'pengujian'],
  ['bug', 'error', 'kesalahan', 'galat', 'issue'],
  ['lint', 'linter', 'gaya-kode'],
  ['benchmark', 'tuning', 'performa', 'performance'],
  // data & infra
  ['database', 'db', 'basis-data', 'sqlite', 'postgres', 'mysql'],
  ['cache', 'tampungan', 'lru'],
  ['env', 'environment', 'lingkungan', 'variabel'],
  ['api', 'endpoint', 'route', 'rute', 'sambungan'],
  ['secret', 'rahasia', 'credential', 'kredensial', 'token'],
  ['key', 'kunci'],
  // project meta
  ['stack', 'teknologi', 'framework', 'kerangka'],
  ['convention', 'konvensi', 'aturan', 'kebiasaan'],
  ['decision', 'keputusan', 'putusan'],
  ['gotcha', 'jebakan', 'perangkap', 'caveat'],
  ['todo', 'tugas', 'task', 'backlog'],
  ['install', 'pasang', 'instalasi', 'setup', 'siapkan'],
  ['upgrade', 'naikkan', 'update', 'perbarui', 'bump'],
];

/** Terms already covered by an operator group or expansion are skipped. */
const EXPANSION_INDEX: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, readonly string[]>();
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) {
      // a term maps to all OTHER members of its group
      map.set(term, group.filter((t) => t !== term));
    }
  }
  return map;
})();

/** Common English morphology suffixes safe to stem off for prefix matching. */
const SUFFIXES = ['ation', 'ment', 'ness', 'ingly', 'ing', 'ers', 'er', 'ed', 'es', 's'] as const;

/** Strip a common suffix so "authentication" → "authent" style stems match longer forms. */
export function stemWord(term: string): string {
  for (const suffix of SUFFIXES) {
    if (term.length > suffix.length + 3 && term.endsWith(suffix)) {
      return term.slice(0, -suffix.length);
    }
  }
  return term;
}

/** Full FTS alternatives for one user term: itself, synonyms, and prefix stems. */
export function expandTerm(term: string): string[] {
  const lower = term.toLowerCase();
  const alts = new Set<string>([term]);
  for (const syn of EXPANSION_INDEX.get(lower) ?? []) {
    alts.add(syn);
  }
  // prefix expansion: a short stem matches longer words via FTS5 prefix syntax
  if (!EXPANSION_INDEX.has(lower) && lower.length >= 4) {
    const stem = stemWord(lower);
    if (stem.length >= 4 && stem !== lower) {
      alts.add(`${stem}*`);
    }
  }
  return [...alts].slice(0, MAX_ALTS_PER_TERM);
}

/** OR-join the alternatives of one term: `"login" OR "masuk" OR …` */
function termClause(term: string): string {
  const alts = expandTerm(term);
  return alts.length === 1 ? `"${alts[0]}"` : `(${alts.map((a) => `"${a}"`).join(' OR ')})`;
}

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
    parts.push(termClause(clean));
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
