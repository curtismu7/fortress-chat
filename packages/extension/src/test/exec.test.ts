import { describe, it, expect } from 'vitest';
import { truncate, parseRgHits } from '../agent/exec';

describe('truncate', () => {
  it('passes short text through', () => expect(truncate('hi', 10)).toBe('hi'));
  it('truncates and marks it', () => {
    const r = truncate('x'.repeat(50), 10);
    expect(r.startsWith('x'.repeat(10))).toBe(true);
    expect(r).toContain('truncated');
  });
});

describe('parseRgHits', () => {
  it('keeps path:line: hits, drops junk', () => {
    const r = parseRgHits('src/a.ts:12:foo()\nnot a hit\nsrc/b.ts:3:bar()', 100);
    expect(r).toContain('src/a.ts:12:foo()');
    expect(r).toContain('src/b.ts:3:bar()');
    expect(r).not.toContain('not a hit');
  });
  it('caps and notes overflow', () => {
    const many = Array.from({ length: 5 }, (_, i) => `f${i}.ts:1:x`).join('\n');
    expect(parseRgHits(many, 2)).toContain('more matches');
  });
});
