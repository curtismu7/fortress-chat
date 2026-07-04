import { describe, it, expect } from 'vitest';
import { buildInlineEditMessages, stripCodeFences } from '../inlineEdit';

describe('stripCodeFences', () => {
  it('strips a fenced block', () => expect(stripCodeFences('```ts\nconst a=1;\n```')).toBe('const a=1;'));
  it('strips a bare fence', () => expect(stripCodeFences('```\nx\n```')).toBe('x'));
  it('leaves unfenced text (trimmed)', () => expect(stripCodeFences('  bare code  ')).toBe('bare code'));
  it('takes the first fenced block when the model adds prose', () => expect(stripCodeFences('Sure:\n```js\nconst a=1;\n```\ndone')).toBe('const a=1;'));
  it('takes the first block when there are multiple', () => expect(stripCodeFences('```js\nfoo()\n```\nand\n```js\nbar()\n```')).toBe('foo()'));
});

describe('buildInlineEditMessages', () => {
  it('has an output-only system msg and includes code + instruction', () => {
    const m = buildInlineEditMessages('const a=1;', 'make it a let', 'typescript');
    expect(m[0].role).toBe('system');
    expect(m[0].content).toMatch(/only the new code/i);
    expect(m[1].role).toBe('user');
    expect(m[1].content).toContain('make it a let');
    expect(m[1].content).toContain('const a=1;');
    expect(m[1].content).toContain('typescript');
  });
});
