export interface AttachedFile { id: string; relPath: string; language: string; content: string; truncated: boolean; diagnostics: string[] }
export interface SelectionCtx { id: string; relPath: string; startLine: number; endLine: number; text: string }
export interface ChatContext { file: AttachedFile | null; selection: SelectionCtx | null; mentions: AttachedFile[] }

export function parseMentions(input: string): string[] {
  const out: string[] = [];
  const re = /@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export function capContent(text: string, maxBytes = 30_000): { content: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { content: text, truncated: false };
  return { content: text.slice(0, maxBytes) + '\n…(truncated)', truncated: true };
}

function fileBlock(label: string, f: AttachedFile): string {
  const head = `[context] ${label} ${f.relPath} (${f.language})${f.truncated ? ', truncated' : ''}`;
  const diag = f.diagnostics.length ? `\n[diagnostics] ${f.relPath}:\n${f.diagnostics.map((d) => '  ' + d).join('\n')}` : '';
  return `${head}\n\`\`\`${f.language}\n${f.content}\n\`\`\`${diag}`;
}

export function buildContextPreamble(ctx: ChatContext): string {
  const parts: string[] = [];
  if (ctx.file) parts.push(fileBlock('active file', ctx.file));
  if (ctx.selection) parts.push(`[context] selection ${ctx.selection.relPath} L${ctx.selection.startLine}-${ctx.selection.endLine}\n\`\`\`\n${ctx.selection.text}\n\`\`\``);
  for (const mn of ctx.mentions) parts.push(fileBlock('mentioned file', mn));
  return parts.join('\n\n');
}
