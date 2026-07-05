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
});
