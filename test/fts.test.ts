import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import { buildFtsQuery, expandTerm, stemWord } from '../src/core/fts.js';

describe('buildFtsQuery — basic shape (backward compatible)', () => {
  it('null for empty/whitespace input', () => {
    expect(buildFtsQuery('')).toBeNull();
    expect(buildFtsQuery('   ')).toBeNull();
  });

  it('quotes plain terms and AND-joins them with an explicit operator', () => {
    const q = buildFtsQuery('xyz abc');
    expect(q).toContain('"xyz"');
    expect(q).toContain('"abc"');
    expect(q).toContain('"xyz" AND "abc"');
    expect(q).not.toContain('OR');
  });

  it('passes through uppercase AND / OR / NOT as operators (with expansion)', () => {
    const q = buildFtsQuery('login OR signup');
    expect(q).toContain(') OR (');
    expect(q).toContain('"signup"');
  });

  it('ignores leading operators', () => {
    expect(buildFtsQuery('OR login')).not.toContain('OR OR');
  });

  it('drops an operator repeated back to back', () => {
    const q = buildFtsQuery('login OR OR signup');
    expect(q).not.toContain('OR OR');
    expect(q).toContain('"signup"');
  });
});

describe('buildFtsQuery — output is accepted by a real FTS5 table', () => {
  let db: InstanceType<typeof DatabaseConstructor>;
  let match: (input: string) => number;

  beforeEach(() => {
    db = new DatabaseConstructor(':memory:');
    db.exec('CREATE VIRTUAL TABLE docs USING fts5(body)');
    const insert = db.prepare('INSERT INTO docs(body) VALUES (?)');
    insert.run('sqlite locking notes');
    insert.run('the login flow stores a session cookie');
    insert.run('deployment runs on port 5000');
    match = (input) => {
      const q = buildFtsQuery(input);
      if (q === null) {
        return 0;
      }
      return (db.prepare('SELECT rowid FROM docs WHERE docs MATCH ?').all(q) as unknown[]).length;
    };
  });

  afterEach(() => db.close());

  it('two expanded synonym groups are AND-joined, not juxtaposed (regression)', () => {
    // Used to throw `fts5: syntax error near "("`: the clauses were joined by a
    // space, and FTS5 refuses `(group) (group)`.
    expect(() => match('sqlite locking')).not.toThrow();
    expect(match('sqlite locking')).toBe(1);
  });

  it('mixes an expanded group with a plain term', () => {
    expect(match('login cookie')).toBe(1);
    expect(match('port 5000')).toBe(1);
  });

  it('keeps an explicit operator between two expanded groups working', () => {
    expect(match('sqlite OR deployment')).toBe(2);
  });
});

describe('buildFtsQuery — semantic-lite expansion', () => {
  it('expands an Indonesian term with its English synonyms (OR group)', () => {
    const q = buildFtsQuery('uji');
    expect(q).toContain('"uji"');
    expect(q).toContain('"test"');
    expect(q).toContain('"tes"');
  });

  it('expands an English term with Indonesian synonyms', () => {
    const q = buildFtsQuery('password');
    expect(q).toContain('"sandi"');
    expect(q).toContain('"kata-sandi"');
  });

  it('AND-joins two expanded term groups with an explicit operator', () => {
    const q = buildFtsQuery('auth port');
    expect(q).toMatch(/^[(]/);
    expect(q).toContain('("port" OR "pintu")');
    expect(q).toContain(') AND ("port" OR "pintu")'); // never `) ("port"`
  });

  it('capped at MAX_ALTS_PER_TERM alternatives per term', () => {
    const q = buildFtsQuery('auth');
    const orCount = (q?.match(/ OR /g) ?? []).length;
    expect(orCount).toBeLessThanOrEqual(4); // 5 alts → 4 ORs
  });

  it('adds prefix stem for longer words outside synonym groups', () => {
    const q = buildFtsQuery('authentication');
    expect(q).toContain('"authentication"');
    expect(q).toContain('authentic*');
  });

  it('no expansion for terms in no group and shorter than 4 chars', () => {
    expect(expandTerm('xyz')).toEqual(['xyz']);
  });

  it('quoting stays injection-safe after expansion', () => {
    const q = buildFtsQuery('login" OR 1=1 --');
    // the raw quote is stripped; every surviving fragment is inside quotes
    expect(q).toContain('"1=1"');
    expect((q?.match(/"/g) ?? []).length % 2).toBe(0);
  });

  it('operator-ish terms still parse after expansion of neighbors', () => {
    expect(buildFtsQuery('uji AND bukan OR test')).toBeTruthy();
  });
});

describe('stemWord', () => {
  it('strips common suffixes', () => {
    expect(stemWord('authentication')).toBe('authentic');
    expect(stemWord('deployment')).toBe('deploy');
  });

  it('leaves short words and non-matching words alone', () => {
    expect(stemWord('auth')).toBe('auth');
    expect(stemWord('port')).toBe('port');
  });
});
