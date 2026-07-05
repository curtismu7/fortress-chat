import type { ChatMessage } from '@fortress-code/shared';

export function exportMarkdown(title: string, messages: ChatMessage[], now: Date): string {
  const parts: string[] = [`# ${title}`, `_Exported ${now.toISOString().slice(0, 10)}_`];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    parts.push(`## ${m.role === 'user' ? 'User' : 'Assistant'}\n\n${m.content}`);
    if (m.sources?.length) {
      parts.push('Sources:\n' + m.sources.map((s) => `- ${s.file}:L${s.startLine}-L${s.endLine}`).join('\n'));
    }
  }
  return parts.join('\n\n') + '\n';
}
