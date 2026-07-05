import type { ChatMessage } from '@fortress-code/shared';
import type { ChatMeta } from './sessionStore';

export function searchChats(query: string, metas: ChatMeta[], messagesById: Record<string, ChatMessage[]>): ChatMeta[] {
  const q = query.trim().toLowerCase();
  if (!q) return metas;
  const scored = metas.map((m, i) => {
    let score = m.title.toLowerCase().includes(q) ? 3 : 0;
    for (const msg of messagesById[m.id] ?? []) if (msg.content.toLowerCase().includes(q)) score += 1;
    return { m, score, i };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((x) => x.m);
}
