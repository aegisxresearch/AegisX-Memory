import { describe, expect, it } from 'vitest';
import { buildFtsQuery, expandTerm, stemWord } from '../src/core/fts.js';

describe('buildFtsQuery — basic shape (backward compatible)', () => {
  it('null for empty/whitespace input', () => {
    expect(buildFtsQuery('')).toBeNull();
    expect(buildFtsQuery('   ')).toBeNull();
  });

  it('quotes and AND-joins plain terms (implicit AND via space)', () => {
    const q = buildFtsQuery('xyz abc');
    expect(q).toContain('"xyz"');
    expect(q).toContain('"abc"');
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

  it('AND-joins two expanded term groups (implicit AND)', () => {
    const q = buildFtsQuery('auth port');
    expect(q).toMatch(/^[(]/);
    expect(q).toContain('("port" OR "pintu")');
    expect(q).not.toContain(' OR ("port'); // groups are separate clauses
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
