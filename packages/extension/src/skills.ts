// packages/extension/src/skills.ts
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
  path: string;
  source: string;
}

export const DEFAULT_SKILL_DIRS = [
  '~/.cursor/skills-cursor',
  '~/.claude/skills',
  '~/.codex/skills',
  '.fortress/skills',
] as const;

const IGNORE = new Set(['node_modules', '.git', 'dist', 'out', '.venv', '.vscode-test']);
const MAX_SKILLS = 200;
const MAX_DEPTH = 6;

/** Expand ~ and workspace-relative skill directory entries to absolute paths. */
export function expandSkillDirs(dirs: string[], workspaceRoot?: string): string[] {
  const home = homedir();
  const out: string[] = [];
  for (const raw of dirs) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let abs = trimmed.startsWith('~/') ? join(home, trimmed.slice(2))
      : trimmed === '~' ? home
      : trimmed.startsWith('/') ? trimmed
      : workspaceRoot ? join(workspaceRoot, trimmed)
      : '';
    if (!abs) continue;
    abs = resolve(abs);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

/** Parse a SKILL.md file into name, description, and instruction body. */
export function parseSkillFile(content: string, fallbackName: string): { name: string; description: string; body: string } {
  let text = content.replace(/\r\n/g, '\n');
  let name = fallbackName;
  let description = '';

  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^([a-zA-Z_-]+):\s*(.+)$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = m[2].trim().replace(/^["']|["']$/g, '');
      if (key === 'name') name = val;
      if (key === 'description') description = val;
    }
    text = text.slice(fm[0].length);
  }

  const heading = text.match(/^#\s+(.+)$/m);
  if (heading && name === fallbackName) name = heading[1].trim();

  const lines = text.split('\n');
  const bodyStart = lines.findIndex((l) => l.trim() && !l.startsWith('#'));
  const body = (bodyStart >= 0 ? lines.slice(bodyStart).join('\n') : text).trim();
  if (!description && bodyStart >= 0) {
    description = lines.slice(bodyStart).find((l) => l.trim() && !l.startsWith('#'))?.trim().slice(0, 120) ?? '';
  }

  return { name: name || fallbackName, description, body: body || text.trim() };
}

function skillId(absPath: string): string {
  return createHash('sha256').update(absPath).digest('hex').slice(0, 16);
}

function walkSkills(dir: string, source: string, depth: number, acc: Skill[]): void {
  if (acc.length >= MAX_SKILLS || depth > MAX_DEPTH || !existsSync(dir)) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }

  const skillFile = join(dir, 'SKILL.md');
  if (existsSync(skillFile)) {
    try {
      const raw = readFileSync(skillFile, 'utf8');
      const fallback = basename(dirname(skillFile));
      const parsed = parseSkillFile(raw, fallback);
      const abs = resolve(skillFile);
      acc.push({
        id: skillId(abs),
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
        path: abs,
        source,
      });
    } catch { /* skip unreadable */ }
  }

  for (const name of entries) {
    if (IGNORE.has(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkSkills(full, source, depth + 1, acc);
    if (acc.length >= MAX_SKILLS) return;
  }
}

/** Discover SKILL.md files under configured directories. */
export function discoverSkills(dirs: string[], workspaceRoot?: string): Skill[] {
  const expanded = expandSkillDirs(dirs.length ? dirs : [...DEFAULT_SKILL_DIRS], workspaceRoot);
  const acc: Skill[] = [];
  const seen = new Set<string>();

  for (const dir of expanded) {
    if (!existsSync(dir)) continue;
    const before = acc.length;
    walkSkills(dir, dir, 0, acc);
    if (acc.length === before && existsSync(join(dir, 'SKILL.md'))) {
      try {
        const abs = resolve(join(dir, 'SKILL.md'));
        if (!seen.has(abs)) {
          const raw = readFileSync(abs, 'utf8');
          const parsed = parseSkillFile(raw, basename(dir));
          acc.push({ id: skillId(abs), ...parsed, path: abs, source: dir });
        }
      } catch { /* skip */ }
    }
    for (const s of acc) seen.add(s.path);
  }

  return acc.sort((a, b) => a.name.localeCompare(b.name));
}
