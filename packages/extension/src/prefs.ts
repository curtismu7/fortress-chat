export interface SavedPrompt { id: string; title: string; text: string }
export interface Params { temperature?: number; top_p?: number; max_tokens?: number }
export interface Persona { id: string; name: string; systemPrompt: string; modelId?: string; params?: Params }
export type ThemeMode = 'dark' | 'light';
export interface MementoLike { get(key: string): unknown; update(key: string, value: unknown): unknown }

const DEFAULT_PROMPTS: SavedPrompt[] = [
  {
    id: 'default-project-plan',
    title: 'Plan A Project Change',
    text: 'Create a concise implementation plan for this project change:\n- Goal:\n- Files likely to change:\n- Risks and edge cases:\n- Verification steps:\nKeep it short and actionable.',
  },
  {
    id: 'default-project-review',
    title: 'Review A Project Diff',
    text: 'Review this project diff with a code-review mindset. Prioritize:\n1. Bugs and regressions\n2. Security or safety risks\n3. Missing tests\nReference exact files and suggest minimal fixes.',
  },
  {
    id: 'default-project-test',
    title: 'Add Tests For Change',
    text: 'Based on the current project changes, propose and add focused tests:\n- unit tests for core logic\n- integration tests for user-facing behavior\n- one negative/error-path test\nThen summarize what is covered and what is still a gap.',
  },
];

const PROMPTS_KEY = 'fortressChat.prompts';
const PARAMS_KEY = 'fortressChat.params';
const PERSONAS_KEY = 'fortressChat.personas';
const THEME_KEY = 'fortressChat.theme';
// Pre-rename keys (fortressCode → fortressChat). Used for one-time migration.
const LEGACY_PROMPTS = 'fortressCode.prompts';
const LEGACY_PARAMS = 'fortressCode.params';
const LEGACY_PERSONAS = 'fortressCode.personas';
const LEGACY_THEME = 'fortressCode.theme';

const RANGES: Record<keyof Params, (v: number) => boolean> = {
  temperature: (v) => v >= 0 && v <= 2,
  top_p: (v) => v >= 0 && v <= 1,
  max_tokens: (v) => Number.isInteger(v) && v > 0,
};

/** One-time migration of a single pre-rename key to its new name. */
function migrate(state: MementoLike, legacyKey: string, newKey: string): void {
  if (state.get(newKey) !== undefined) return;
  const legacy = state.get(legacyKey);
  if (legacy === undefined) return;
  void state.update(newKey, legacy);
  void state.update(legacyKey, undefined);
}

function seedDefaultPrompts(state: MementoLike): void {
  const raw = state.get(PROMPTS_KEY);
  if (!Array.isArray(raw)) {
    void state.update(PROMPTS_KEY, DEFAULT_PROMPTS);
    return;
  }
  const existing = raw.filter((p): p is SavedPrompt =>
    !!p && typeof p.id === 'string' && typeof p.title === 'string' && typeof p.text === 'string');
  const seen = new Set(existing.map((p) => p.id));
  const missing = DEFAULT_PROMPTS.filter((p) => !seen.has(p.id));
  if (missing.length) void state.update(PROMPTS_KEY, [...existing, ...missing]);
}

export class Prefs {
  constructor(private state: MementoLike) {
    migrate(state, LEGACY_PROMPTS, PROMPTS_KEY);
    migrate(state, LEGACY_PARAMS, PARAMS_KEY);
    migrate(state, LEGACY_PERSONAS, PERSONAS_KEY);
    migrate(state, LEGACY_THEME, THEME_KEY);
    seedDefaultPrompts(state);
  }

  prompts(): SavedPrompt[] {
    const raw = this.state.get(PROMPTS_KEY);
    return Array.isArray(raw) ? raw.filter((p): p is SavedPrompt =>
      !!p && typeof p.id === 'string' && typeof p.title === 'string' && typeof p.text === 'string') : [];
  }
  savePrompt(p: SavedPrompt): void {
    const text = p.text.trim();
    const title = p.title?.trim() || text.split('\n')[0]?.trim().slice(0, 60) || 'Prompt';
    const saved = { ...p, text, title };
    const list = this.prompts();
    const i = list.findIndex((x) => x.id === saved.id);
    if (i >= 0) list[i] = saved; else list.push(saved);
    void this.state.update(PROMPTS_KEY, list);
  }
  deletePrompt(id: string): void {
    void this.state.update(PROMPTS_KEY, this.prompts().filter((x) => x.id !== id));
  }

  params(): Params {
    const raw = this.state.get(PARAMS_KEY);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Params) : {};
  }
  setParams(p: Params): void {
    const out: Params = {};
    for (const key of Object.keys(RANGES) as (keyof Params)[]) {
      const v = p[key];
      if (typeof v === 'number' && !Number.isNaN(v) && RANGES[key](v)) out[key] = v;
    }
    void this.state.update(PARAMS_KEY, out);
  }

  personas(): Persona[] {
    const raw = this.state.get(PERSONAS_KEY);
    return Array.isArray(raw) ? raw.filter((p): p is Persona =>
      !!p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.systemPrompt === 'string') : [];
  }
  savePersona(p: Persona): void {
    const list = this.personas();
    const i = list.findIndex((x) => x.id === p.id);
    if (i >= 0) list[i] = p; else list.push(p);
    void this.state.update(PERSONAS_KEY, list);
  }
  deletePersona(id: string): void {
    void this.state.update(PERSONAS_KEY, this.personas().filter((x) => x.id !== id));
  }

  theme(): ThemeMode {
    const raw = this.state.get(THEME_KEY);
    return raw === 'light' ? 'light' : 'dark';
  }

  setTheme(mode: unknown): void {
    const next: ThemeMode = mode === 'light' ? 'light' : 'dark';
    void this.state.update(THEME_KEY, next);
  }
}
