import type { ChatMessage } from '@fortress-code/shared';

const EDIT_SYSTEM = 'You are a precise code editor. Rewrite the user\'s selected code according to their instruction. Output ONLY the new code — no explanations, no markdown fences.';

export function buildInlineEditMessages(code: string, instruction: string, language: string): ChatMessage[] {
  return [
    { role: 'system', content: EDIT_SYSTEM },
    { role: 'user', content: `Instruction: ${instruction}\n\nCode (${language}):\n${code}` },
  ];
}

export function stripCodeFences(text: string): string {
  const t = String(text).trim();
  // If the model wrapped the code in a fence (possibly with surrounding prose or
  // multiple blocks), take the FIRST fenced block's contents. Otherwise return as-is.
  const m = t.match(/```[^\n]*\n([\s\S]*?)```/);
  return (m ? m[1].replace(/\n+$/, '') : t).trim();
}
