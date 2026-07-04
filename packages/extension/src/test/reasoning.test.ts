import { describe, it, expect } from 'vitest';
import { splitThink } from '../reasoning';

describe('splitThink', () => {
  it('extracts and strips a think block', () => {
    expect(splitThink('<think>hmm</think>Answer')).toEqual({ content: 'Answer', reasoning: 'hmm' });
  });
  it('joins multiple think blocks and trims content', () => {
    const r = splitThink('<think>a</think>X<think>b</think>Y');
    expect(r.content).toBe('XY');
    expect(r.reasoning).toBe('a\nb');
  });
  it('treats an unclosed think tail as reasoning', () => {
    expect(splitThink('done<think>still thinking')).toEqual({ content: 'done', reasoning: 'still thinking' });
  });
  it('passes plain content through', () => {
    expect(splitThink('just text')).toEqual({ content: 'just text', reasoning: '' });
  });
  it('strips a stray orphan close tag', () => {
    expect(splitThink('hello</think>world').content).toBe('helloworld');
  });
  it('never leaks a literal think tag from nested blocks', () => {
    expect(splitThink('<think>a<think>b</think>c</think>Answer').content).not.toMatch(/think/);
  });
});
