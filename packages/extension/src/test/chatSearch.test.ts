import { describe, it, expect } from 'vitest';
import { searchChats } from '../chatSearch';

const metas = [{ id: 'a', title: 'Rust helpers' }, { id: 'b', title: 'Notes' }, { id: 'c', title: 'misc' }];
const msgs = {
  a: [{ role: 'user', content: 'hi' }],
  b: [{ role: 'user', content: 'rust question' }, { role: 'assistant', content: 'RUST answer' }],
  c: [{ role: 'user', content: 'nothing' }],
} as any;

describe('searchChats', () => {
  it('ranks title hits above content hits, case-insensitive', () => {
    const r = searchChats('rust', metas, msgs);
    expect(r.map((m) => m.id)).toEqual(['a', 'b']); // a: 3 (title), b: 2 (two messages)
  });
  it('empty query returns all unchanged', () => {
    expect(searchChats('  ', metas, msgs)).toEqual(metas);
  });
});
