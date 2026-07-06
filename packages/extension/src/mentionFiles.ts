// packages/extension/src/mentionFiles.ts
import { listFiles } from './rag/indexer';

const SPECIAL = [
  { id: 'codebase', label: '@codebase', hint: 'Search the indexed repo' },
  { id: 'docs', label: '@docs', hint: 'Search indexed documents' },
];

/** Filter workspace files and special mentions for the @ picker. */
export function mentionCandidates(root: string | undefined, query: string, limit = 12): { id: string; label: string; hint?: string }[] {
  const q = query.trim().toLowerCase();
  const specials = SPECIAL.filter((s) => !q || s.label.toLowerCase().includes(q) || s.id.includes(q));
  if (!root) return specials.slice(0, limit);
  let files: string[] = [];
  try { files = listFiles(root); } catch { files = []; }
  const matched = files
    .filter((f) => !q || f.toLowerCase().includes(q))
    .slice(0, Math.max(0, limit - specials.length))
    .map((f) => ({ id: f, label: `@${f}`, hint: 'File' }));
  return [...specials, ...matched].slice(0, limit);
}
