export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}
export function estimateMessagesTokens(messages: { content: string }[]): number {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
}
