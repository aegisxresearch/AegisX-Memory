/**
 * README.md and README.id.md are translations of one document, and nothing in
 * the build ever reads them — so the only thing keeping them in step is
 * discipline. That slipped before, and the failure is quiet: a section added to
 * one language leaves readers of the other with a table of contents pointing at
 * a heading that does not exist.
 *
 * These tests compare structure, never prose: heading levels, section numbers
 * and code fences must line up one for one while the text stays free to be a
 * translation.
 *
 * The parse is fence-aware deliberately. A `# comment` inside a bash block is
 * not a heading — and each README holds fourteen of them at column 0 — so a
 * naive `^#{1,6}\s` scan would report ~15 H1s per file and compare comments
 * instead of document structure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const EN = path.resolve('README.md');
const ID = path.resolve('README.id.md');

interface Heading {
  level: number;
  text: string;
}

/** Headings that live outside fenced code blocks, in document order. */
function headings(file: string): Heading[] {
  const found: Heading[] = [];
  let inFence = false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const level = match[1]?.length;
    const text = match[2];
    if (level === undefined || text === undefined || text === '') continue;
    found.push({ level, text });
  }
  return found;
}

/**
 * The decimal label a heading opens with — `## 13. Diagnostics` → `13`,
 * `### 5.4 Verifikasi` → `5.4` — or `null` for the unnumbered handful (the
 * title, the TL;DR banner, the table of contents).
 */
function sectionNumber(heading: Heading): string | null {
  const match = /^(\d+(?:\.\d+)*)\.?\s/.exec(heading.text);
  return match?.[1] ?? null;
}

/** Level + section number per heading: the part the two files must share. */
function outline(file: string): string[] {
  return headings(file).map((h) => `${'#'.repeat(h.level)} ${sectionNumber(h) ?? '-'}`);
}

function fenceCount(file: string): number {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => /^\s*```/.test(line)).length;
}

/** Table-of-contents entries (`13. [Title](#anchor)`), in order. */
function tocNumbers(file: string): string[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => /^\d+\.\s+\[[^\]]+\]\(#/.test(line))
    .map((line) => /^(\d+)\./.exec(line)?.[1] ?? '');
}

/** The numbered top-level sections a table of contents is supposed to list. */
function numberedSections(file: string): string[] {
  return headings(file)
    .filter((h) => h.level === 2 && /^\d+\.\s/.test(h.text))
    .map((h) => /^(\d+)\./.exec(h.text)?.[1] ?? '');
}

describe('README.md ⇄ README.id.md parity', () => {
  it('happy: both READMEs are where the suite expects them', () => {
    // `path.resolve` is cwd-relative, exactly like test/version.test.ts — a
    // wrong cwd should say so here rather than surface as a bare ENOENT.
    expect(fs.existsSync(EN)).toBe(true);
    expect(fs.existsSync(ID)).toBe(true);
  });

  it('happy: the heading outline lines up one for one', () => {
    expect(outline(ID)).toEqual(outline(EN));
    // A guard on the guard: two empty files are trivially "in sync".
    expect(headings(EN).length).toBeGreaterThan(30);
  });

  it('happy: every section carries the same number in both languages', () => {
    const en = headings(EN).map(sectionNumber);
    expect(headings(ID).map(sectionNumber)).toEqual(en);
    // 17.1 is the kind of subsection that exists in one language only after a
    // rushed edit, which is precisely what this locks down.
    expect(en).toContain('17.1');
    expect(en.filter((n) => n !== null).length).toBeGreaterThan(25);
  });

  it('regression: `#` comments inside code fences are not headings', () => {
    for (const file of [EN, ID]) {
      const h1 = headings(file).filter((h) => h.level === 1);
      expect(h1).toHaveLength(1);
      expect(h1[0]?.text).toBe('AegisX-Memory');
    }
  });

  it('guards the parse: code fences are balanced, so no heading hides inside one', () => {
    // An odd fence count means the parser swallows the rest of the file — and
    // two files broken the same way would still pass the parity tests above.
    for (const file of [EN, ID]) {
      expect(fenceCount(file) % 2).toBe(0);
      expect(fenceCount(file)).toBeGreaterThan(10);
    }
  });

  it('the table of contents lists every numbered section, in order', () => {
    for (const file of [EN, ID]) {
      expect(tocNumbers(file)).toEqual(numberedSections(file));
    }
    // ...and both languages list the same section numbers.
    expect(tocNumbers(ID)).toEqual(tocNumbers(EN));
  });
});
