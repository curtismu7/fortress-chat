import { describe, it, expect } from 'vitest';
import { SessionStore } from '../sessionStore';

function mem(init: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(init));
  return { get: (k: string) => m.get(k), update: (k: string, v: unknown) => { m.set(k, v); return Promise.resolve(); }, _m: m } as any;
}

describe('SessionStore', () => {
  it('starts with one empty chat', () => {
    const s = SessionStore.load(mem());
    expect(s.metas()).toHaveLength(1);
    expect(s.active().messages).toEqual([]);
  });
  it('newChat adds and switches without losing the old', () => {
    const s = SessionStore.load(mem());
    s.active().addUser('first'); s.touchTitle(); s.save();
    const firstId = s.activeId;
    s.newChat();
    expect(s.metas()).toHaveLength(2);
    expect(s.active().messages).toEqual([]);
    s.switchTo(firstId);
    expect(s.active().messages[0].content).toBe('first');
  });
  it('titles from the first user message', () => {
    const s = SessionStore.load(mem());
    s.active().addUser('explain my code please'); s.touchTitle();
    expect(s.metas()[0].title).toContain('explain');
  });
  it('persists and reloads', () => {
    const store = mem();
    const s = SessionStore.load(store);
    s.active().addUser('persisted'); s.touchTitle(); s.save();
    expect(SessionStore.load(store).active().messages[0].content).toBe('persisted');
  });
  it('round-trips assistant message sources through save/load', () => {
    const store = mem();
    const s = SessionStore.load(store);
    s.active().addUser('what does this do?');
    s.active().addAssistant('it does that');
    const last = s.active().messages[s.active().messages.length - 1];
    last.sources = [{ file: 'src/a.ts', startLine: 10, endLine: 20 }];
    s.save();
    const reloaded = SessionStore.load(store).active().messages;
    expect(reloaded[reloaded.length - 1].sources).toEqual([{ file: 'src/a.ts', startLine: 10, endLine: 20 }]);
  });

  it('migrates a legacy single session', () => {
    const store = mem({ 'fortressCode.session': [{ role: 'user', content: 'legacy' }] });
    const s = SessionStore.load(store);
    expect(s.active().messages[0].content).toBe('legacy');
  });

  it('fork copies messages up to index into a new active chat', () => {
    const store = SessionStore.load(mem());
    store.active().addUser('one');
    store.active().addAssistant('two');
    store.active().addUser('three');
    store.touchTitle();
    const originalId = store.activeId;
    store.fork(1); // keep 'one','two'
    expect(store.activeId).not.toBe(originalId);
    expect(store.active().messages.map((m) => m.content)).toEqual(['one', 'two']);
    expect(store.metas()[0].title.startsWith('Fork: ')).toBe(true);
  });

  it('fork with out-of-range index clamps to full copy', () => {
    const store = SessionStore.load(mem());
    store.active().addUser('only');
    store.fork(99);
    expect(store.active().messages).toHaveLength(1);
  });

  it('fork deep-copies sources so fork and original are independent', () => {
    const store = SessionStore.load(mem());
    store.active().addUser('q');
    store.active().messages.push({ role: 'assistant', content: 'a', sources: [{ file: 'x.ts', startLine: 1, endLine: 2 }] } as any);
    const originalMsgs = store.active().messages;
    store.fork(1);
    const forked = store.active().messages;
    expect(forked[1].sources).toEqual(originalMsgs[1].sources);
    expect(forked[1].sources).not.toBe(originalMsgs[1].sources);
    expect(forked[1].sources![0]).not.toBe(originalMsgs[1].sources![0]);
  });

  it('fork(-1) leaves activeId unchanged', () => {
    const store = SessionStore.load(mem());
    store.active().addUser('message');
    const originalId = store.activeId;
    store.fork(-1);
    expect(store.activeId).toBe(originalId);
  });

  it('fork on empty store leaves activeId unchanged', () => {
    const store = SessionStore.load(mem());
    const originalId = store.activeId;
    store.fork(0);
    expect(store.activeId).toBe(originalId);
  });
});
