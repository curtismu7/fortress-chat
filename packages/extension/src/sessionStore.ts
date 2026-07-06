import { randomUUID } from 'node:crypto';
import { validateHistory, type ChatMessage } from '@fortress-chat/shared';
import { Session } from './chat/session';

export interface ChatMeta { id: string; title: string; folder?: string; personaId?: string; skillId?: string; agentMode?: boolean }
interface MementoLike { get(key: string): unknown; update(key: string, value: unknown): Thenable<void> | void }
const KEY = 'fortressChat.chats';
const LEGACY = 'fortressChat.session';
// Pre-rename keys (fortressCode → fortressChat). Used for one-time migration.
const PRE_RENAME_KEY = 'fortressCode.chats';
const PRE_RENAME_LEGACY = 'fortressCode.session';

export class SessionStore {
  activeId: string;
  private order: string[];
  private titles: Map<string, string>;
  private folders: Map<string, string>;
  private personaIds: Map<string, string>;
  private skillIds: Map<string, string>;
  private agentModes: Map<string, boolean>;
  private sessions: Map<string, Session>;

  private constructor(
    private state: MementoLike, activeId: string, order: string[],
    titles: Map<string, string>, folders: Map<string, string>, personaIds: Map<string, string>,
    skillIds: Map<string, string>, agentModes: Map<string, boolean>,
    sessions: Map<string, Session>,
  ) {
    this.activeId = activeId; this.order = order; this.titles = titles;
    this.folders = folders; this.personaIds = personaIds; this.skillIds = skillIds;
    this.agentModes = agentModes; this.sessions = sessions;
  }

  metas(): ChatMeta[] {
    return this.order.map((id) => ({
      id,
      title: this.titles.get(id) || 'New chat',
      folder: this.folders.get(id),
      personaId: this.personaIds.get(id),
      skillId: this.skillIds.get(id),
      agentMode: this.agentModes.get(id) || undefined,
    }));
  }

  listFolders(): string[] {
    return [...new Set([...this.folders.values()].filter(Boolean))].sort();
  }

  setFolder(chatId: string, folder: string | undefined): void {
    if (!this.sessions.has(chatId)) return;
    if (folder?.trim()) this.folders.set(chatId, folder.trim());
    else this.folders.delete(chatId);
    this.save();
  }

  setPersona(chatId: string, personaId: string | undefined): void {
    if (!this.sessions.has(chatId)) return;
    if (personaId) this.personaIds.set(chatId, personaId);
    else this.personaIds.delete(chatId);
    this.save();
  }

  setSkill(chatId: string, skillId: string | undefined): void {
    if (!this.sessions.has(chatId)) return;
    if (skillId) this.skillIds.set(chatId, skillId);
    else this.skillIds.delete(chatId);
    this.save();
  }

  // Persist agent-mode per chat so switching chats restores it. True sets, false/undefined clears.
  setAgentMode(chatId: string, on: boolean): void {
    if (!this.sessions.has(chatId)) return;
    if (on) this.agentModes.set(chatId, true);
    else this.agentModes.delete(chatId);
    this.save();
  }

  active(): Session { return this.sessions.get(this.activeId)!; }
  messagesById(): Record<string, ChatMessage[]> {
    const result: Record<string, ChatMessage[]> = {};
    for (const [id, session] of this.sessions) result[id] = session.messages;
    return result;
  }

  newChat(agentMode?: boolean): void {
    const id = randomUUID();
    this.order.unshift(id); this.titles.set(id, 'New chat'); this.sessions.set(id, new Session());
    if (agentMode) this.agentModes.set(id, true);
    this.activeId = id; this.save();
  }
  switchTo(id: string): void { if (this.sessions.has(id)) { this.activeId = id; this.save(); } }
  fork(index: number): void {
    const src = this.sessions.get(this.activeId);
    if (!src || src.messages.length === 0 || index < 0) return;
    const upTo = Math.min(index, src.messages.length - 1);
    const copy = new Session();
    copy.messages = src.messages.slice(0, upTo + 1).map((m) => ({
      ...m,
      ...(m.sources ? { sources: m.sources.map((s) => ({ ...s })) } : {}),
      ...(m.tool_calls ? { tool_calls: m.tool_calls.map((t) => ({ ...t, function: { ...t.function } })) } : {}),
    }));
    const id = randomUUID();
    const title = ('Fork: ' + (this.titles.get(this.activeId) || 'New chat')).slice(0, 40);
    this.order.unshift(id); this.titles.set(id, title); this.sessions.set(id, copy);
    const folder = this.folders.get(this.activeId);
    if (folder) this.folders.set(id, folder);
    const persona = this.personaIds.get(this.activeId);
    if (persona) this.personaIds.set(id, persona);
    const skill = this.skillIds.get(this.activeId);
    if (skill) this.skillIds.set(id, skill);
    const agentMode = this.agentModes.get(this.activeId);
    if (agentMode) this.agentModes.set(id, agentMode);
    this.activeId = id; this.save();
  }
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
    type Stored = { activeId: string; metas: ChatMeta[]; messagesById: Record<string, ChatMessage[]> };
    const raw = state.get(KEY) as Stored | undefined;
    // One-time migration from pre-rename 'fortressCode.chats' key.
    if (!raw) {
      const preRename = state.get(PRE_RENAME_KEY) as Stored | undefined;
      if (preRename?.metas?.length) {
        void state.update(KEY, preRename);
        void state.update(PRE_RENAME_KEY, undefined);
        return SessionStore.load(state);
      }
    }
    if (raw && raw.metas?.length) {
      const order = raw.metas.map((m) => m.id);
      const titles = new Map(raw.metas.map((m) => [m.id, m.title] as const));
      const folders = new Map(raw.metas.filter((m) => m.folder).map((m) => [m.id, m.folder!] as const));
      const personaIds = new Map(raw.metas.filter((m) => m.personaId).map((m) => [m.id, m.personaId!] as const));
      const skillIds = new Map(raw.metas.filter((m) => m.skillId).map((m) => [m.id, m.skillId!] as const));
      const agentModes = new Map(raw.metas.filter((m) => m.agentMode).map((m) => [m.id, m.agentMode!] as const));
      const sessions = new Map<string, Session>();
      for (const id of order) {
        const s = new Session();
        try { s.messages = validateHistory(raw.messagesById[id] ?? []); } catch { s.messages = []; }
        sessions.set(id, s);
      }
      const activeId = sessions.has(raw.activeId) ? raw.activeId : order[0];
      return new SessionStore(state, activeId, order, titles, folders, personaIds, skillIds, agentModes, sessions);
    }
    const legacy = state.get(LEGACY) ?? state.get(PRE_RENAME_LEGACY);
    const s = new Session();
    try { if (legacy) s.messages = validateHistory(legacy); } catch { s.messages = []; }
    const id = randomUUID();
    const store = new SessionStore(state, id, [id], new Map([[id, 'New chat']]), new Map(), new Map(), new Map(), new Map(), new Map([[id, s]]));
    store.touchTitle();
    store.save();
    return store;
  }
}
