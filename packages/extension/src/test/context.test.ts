import { describe, it, expect } from 'vitest';
import { parseMentions, capContent, buildContextPreamble, type ChatContext } from '../context';

describe('parseMentions', () => {
  it('extracts @paths and dedupes', () => {
    expect(parseMentions('look at @src/a.ts and @src/a.ts and @b.js please')).toEqual(['src/a.ts', 'b.js']);
  });
  it('returns [] when none', () => expect(parseMentions('no mentions here')).toEqual([]));
});

describe('capContent', () => {
  it('passes short content through untruncated', () => {
    expect(capContent('hello', 100)).toEqual({ content: 'hello', truncated: false });
  });
  it('truncates over the cap and flags it', () => {
    const r = capContent('x'.repeat(50), 10);
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(10 + 20); // + a short marker
    expect(r.content).toContain('truncated');
  });
});

describe('buildContextPreamble', () => {
  const base: ChatContext = { file: null, selection: null, mentions: [] };
  it('is empty when no context', () => expect(buildContextPreamble(base)).toBe(''));
  it('includes active file, selection, mention, and diagnostics', () => {
    const ctx: ChatContext = {
      file: { id: 'f', relPath: 'src/app.ts', language: 'typescript', content: 'const a=1;', truncated: false, diagnostics: ['12:5 error TS2345 nope'] },
      selection: { id: 's', relPath: 'src/app.ts', startLine: 10, endLine: 12, text: 'return x;' },
      mentions: [{ id: 'm', relPath: 'src/b.ts', language: 'typescript', content: 'export const b=2;', truncated: true, diagnostics: [] }],
    };
    const out = buildContextPreamble(ctx);
    expect(out).toContain('src/app.ts');
    expect(out).toContain('const a=1;');
    expect(out).toContain('L10');
    expect(out).toContain('return x;');
    expect(out).toContain('src/b.ts');
    expect(out).toContain('truncated');
    expect(out).toContain('TS2345');
  });
});
