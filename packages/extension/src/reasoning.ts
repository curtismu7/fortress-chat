export function splitThink(text: string): { content: string; reasoning: string } {
  const reasoning: string[] = [];
  let content = String(text).replace(/<think>([\s\S]*?)<\/think>/g, (_m, r) => { reasoning.push(r); return ''; });
  const open = content.indexOf('<think>');
  if (open >= 0) { reasoning.push(content.slice(open + 7)); content = content.slice(0, open); }
  content = content.replace(/<\/?think>/g, ''); // strip any stray/orphan tags so they never leak into the reply
  return { content: content.trim(), reasoning: reasoning.join('\n').trim() };
}
