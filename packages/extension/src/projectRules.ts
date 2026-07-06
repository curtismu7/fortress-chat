// packages/extension/src/projectRules.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RULES_CANDIDATES = ['.fortress/rules.md', '.fortresscode.md', 'FORTRESS.md'] as const;
export const DEFAULT_RULES_PATH = '.fortress/rules.md';

/** Load project rules markdown from the workspace, if present. */
export function loadProjectRules(root: string | undefined): { text: string; path: string | null } {
  if (!root) return { text: '', path: null };
  for (const rel of RULES_CANDIDATES) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    try {
      const text = readFileSync(abs, 'utf8').trim();
      if (text) return { text: `[project rules from ${rel}]\n${text}`, path: rel };
    } catch { /* try next */ }
  }
  return { text: '', path: null };
}

/** Preferred path for creating a new rules file. */
export function defaultRulesRel(root: string | undefined): string {
  if (!root) return DEFAULT_RULES_PATH;
  for (const rel of RULES_CANDIDATES) {
    if (existsSync(join(root, rel))) return rel;
  }
  return DEFAULT_RULES_PATH;
}
