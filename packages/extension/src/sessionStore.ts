import { randomUUID } from 'node:crypto';
import { validateHistory, type ChatMessage } from '@fortress-code/shared';
import { Session } from './chat/session';

export interface ChatMeta { id: string; title: string }
interface MementoLike { get(key: string): unknown; update(key: string, value: unknown): Thenable<void> | void }
const KEY = 'fortressCode.chats';
const LEGACY = 'fortressCode.session';

export class SessionStore {
  activeId: string;
  private order: string[]; // ids, newest first
  private titles: Map<string, string>;
  private sessions: Map<string, Session>;

  private constructor(private state: MementoLike, activeId: string, order: string[], titles: Map<string, string>, sessions: Map<string, Session>) {
    this.activeId = activeId; this.order = order; this.titles = titles; this.sessions = sessions;
  }

  metas(): ChatMeta[] { return this.order.map((id) => ({ id, title: this.titles.get(id) || 'New chat' })); }
  active(): Session { return this.sessions.get(this.activeId)!; }

  newChat(): void {
    const id = randomUUID();
    this.order.unshift(id); this.titles.set(id, 'New chat'); this.sessions.set(id, new Session());
    this.activeId = id; this.save();
  }
  switchTo(id: string): void { if (this.sessions.has(id)) { this.activeId = id; this.save(); } }
  touchTitle(): void {
    const first = this.active().messages.find((m) => m.role === 'user' && m.content.trim());
    if (first && (this.titles.get(this.activeId) || 'New chat') === 'New chat') {
      this.titles.set(this.activeId, first.content.trim().slice(0, 40));
    }
  }
  save(): void {
    const messagesById: Record<string, ChatMessage[]> = {};
    for (const [id, s] of this.sessions) messagesById[id] = s.messages;
    void this.state.update(KEY, { activeId: this.activeId, metas: this.metas(), messagesById });
  }

  static load(state: MementoLike): SessionStore {
    const raw = state.get(KEY) as { activeId: string; metas: ChatMeta[]; messagesById: Record<string, ChatMessage[]> } | undefined;
    if (raw && raw.metas?.length) {
      const order = raw.metas.map((m) => m.id);
      const titles = new Map(raw.metas.map((m) => [m.id, m.title] as const));
      const sessions = new Map<string, Session>();
      for (const id of order) {
        const s = new Session();
        try { s.messages = validateHistory(raw.messagesById[id] ?? []); } catch { s.messages = []; }
        sessions.set(id, s);
      }
      const activeId = sessions.has(raw.activeId) ? raw.activeId : order[0];
      return new SessionStore(state, activeId, order, titles, sessions);
    }
    // fresh or legacy migration
    const legacy = state.get(LEGACY);
    const s = new Session();
    try { if (legacy) s.messages = validateHistory(legacy); } catch { s.messages = []; }
    const id = randomUUID();
    const store = new SessionStore(state, id, [id], new Map([[id, 'New chat']]), new Map([[id, s]]));
    store.touchTitle();
    store.save();
    return store;
  }
}
