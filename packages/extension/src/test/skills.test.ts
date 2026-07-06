// packages/extension/src/test/skills.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverSkills, expandSkillDirs, parseSkillFile } from '../skills';

describe('parseSkillFile', () => {
  it('reads frontmatter name and description', () => {
    const raw = `---
name: GSD Plan
description: Run a planning phase
---
# Ignored heading

Do the plan steps.`;
    const p = parseSkillFile(raw, 'fallback');
    expect(p.name).toBe('GSD Plan');
    expect(p.description).toBe('Run a planning phase');
    expect(p.body).toContain('Do the plan steps');
  });

  it('uses first heading when no frontmatter name', () => {
    const p = parseSkillFile('# My Skill\n\nInstructions here.', 'dir');
    expect(p.name).toBe('My Skill');
    expect(p.body).toContain('Instructions here');
  });
});

describe('expandSkillDirs', () => {
  it('expands tilde and workspace-relative paths', () => {
    const dirs = expandSkillDirs(['~/.codex/skills', '.fortress/skills'], '/proj');
    expect(dirs.some((d) => d.includes('.codex/skills'))).toBe(true);
    expect(dirs.some((d) => d.endsWith('/proj/.fortress/skills'))).toBe(true);
  });
});

describe('discoverSkills', () => {
  it('finds nested SKILL.md files', () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-skills-'));
    const skillDir = join(root, 'gsd-plan');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# GSD Plan\n\nPlan the phase.\n');
    const skills = discoverSkills([root]);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('GSD Plan');
    expect(skills[0].body).toContain('Plan the phase');
  });
});
