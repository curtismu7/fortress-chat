import { z } from 'zod';

export class HistoryValidationError extends Error {}

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
});

export type ToolCall = z.infer<typeof toolCallSchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type Role = ChatMessage['role'];

export function validateHistory(input: unknown): ChatMessage[] {
  const parsed = z.array(messageSchema).safeParse(input);
  if (!parsed.success) {
    throw new HistoryValidationError(`Invalid chat history: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}
