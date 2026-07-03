# Fortress Code — Governance + OpenRouter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an enforced US-only model-governance layer and a co-equal OpenRouter cloud provider to Fortress Code, then build the extension's chat + agent surface on top of a "one governed gallery" UI — extension-side only; the manager daemon is untouched.

**Architecture:** A single governed registry in `packages/shared` (`policy.ts` + `governance.ts`) is the source of truth for "is this model US-approved". The extension resolves every chat/agent request to a `ResolvedTarget` via `resolveTarget(entry, deps)`, which calls `assertAllowed(entry)` first (fail-closed) and then builds a local (llama-server) or OpenRouter request. OpenRouter requests pin US inference providers with `allow_fallbacks:false`. The OpenRouter key lives in VS Code SecretStorage. The webview is a governed gallery: provider toggle, per-provider requirements, model cards with governance badges, and a gated add-model flow.

**Tech Stack:** TypeScript 5 (strict), Node 20+, npm workspaces, zod, vitest, esbuild, @vscode/vsce. Extension host + framework-free webview. Continues the monorepo from `2026-07-02-fortress-code-v1.md` (Tasks 1–12 complete).

## Global Constraints

- **Continues an existing branch:** `feat/v1`. Tasks 1–12 are committed. `packages/shared` (catalog, api, messages) and `packages/manager` (the daemon) are DONE and must NOT be modified except where a task explicitly says so. The extension currently has only: `package.json`, `esbuild.mjs`, `tsconfig.json`, `src/extension.ts`, `src/daemon.ts` (exports `DaemonClient`, `ensureDaemon`), a minimal `src/chat/ChatViewProvider.ts` stub, and `src/test/daemon.test.ts`.
- **Governance rule (verbatim):** a model is allowed iff `approved === true && origin.country === 'US' && (provider==='local' ? hosting.kind==='on-device' : hosting.kind==='openrouter' && hosting.usProviders.length > 0)`. Fail closed everywhere: unknown/non-US → blocked; OpenRouter with no serviceable US provider → error, never a silent fallback.
- **"US model" = US-origin developer AND US inference/hosting.** Enforced by the curated registry, NOT runtime auto-detection (OpenRouter exposes no reliable origin/country field).
- **OpenRouter request routing (verbatim):** every OpenRouter request body includes `provider: { only: <entry.hosting.usProviders>, allow_fallbacks: false, data_collection: "deny" }` and `model: <entry.openrouter.slug>`. Base URL `https://openrouter.ai/api/v1/chat/completions`. Header `Authorization: Bearer <key>`.
- **OpenRouter key** stored ONLY in `context.secrets` (VS Code SecretStorage). Never written to disk, `daemon.json`, or workspaceState; never sent anywhere but `openrouter.ai`.
- **Daemon stays local-only.** The extension calls OpenRouter directly (as it already calls local llama-server directly).
- **Chat history** entries MUST validate as `{role, content}` via the existing `validateHistory`; errors are never appended to history.
- **Dependencies:** no new runtime npm deps beyond `@fortress-code/shared` and what Tasks 1–12 already declared. Node 20+ builtins + browser-standard `fetch` only.
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **TDD:** logic tasks start with a failing test; webview/UI steps use the stated manual checks.
- Work from `/Users/cmuir/Development/fortress-code-v1`. Stage files explicitly (never `git add -A`); confirm `git branch --show-current` is `feat/v1` before each commit.

## File Structure

```text
packages/shared/src/
├── policy.ts          # PolicyEntry, loadPolicy(), localEntries(), openRouterEntries(), explainBlock()
├── governance.ts      # isAllowed(), assertAllowed(), PolicyViolationError
└── index.ts           # + re-export policy, governance
packages/shared/test/
├── policy.test.ts
└── governance.test.ts

packages/extension/src/
├── chat/
│   ├── session.ts             # typed history + workspaceState persistence
│   └── ChatViewProvider.ts    # (rework) governed-gallery host + message routing
├── providers/
│   ├── target.ts              # ResolvedTarget + resolveTarget(entry, deps) (guard + build)
│   └── stream.ts              # streamChat(target, messages, onToken, signal) + WatchdogError
├── agent/
│   ├── tools.ts               # read_file/list_files/search/edit_file + path confinement
│   └── loop.ts                # completeOnce(target,...) + runAgentTurn(...) (provider-generalized)
├── secrets.ts                 # getOpenRouterKey/setOpenRouterKey (SecretStorage wrapper)
└── test/
    ├── session.test.ts
    ├── stream.test.ts
    ├── target.test.ts
    ├── tools.test.ts
    └── loop.test.ts
packages/extension/media/
├── chat.html  chat.css  chat.js   # governed gallery + chat surface
```

---

### Task 13: shared — governance policy registry + guard

**Files:**
- Create: `packages/shared/src/policy.ts`, `packages/shared/src/governance.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/governance.test.ts`, `packages/shared/test/policy.test.ts`

**Interfaces:**
- Consumes: `loadCatalog`, `CatalogModel` from `./catalog` (Task 3, done).
- Produces:
  - `type Provider = 'local' | 'openrouter'`
  - `interface Origin { org: string; country: 'US' }`
  - `type Hosting = { kind: 'on-device' } | { kind: 'openrouter'; usProviders: string[] }`
  - `interface PolicyEntry { id: string; displayName: string; provider: Provider; agentCapable: boolean; origin: Origin; hosting: Hosting; approved: boolean; local?: { catalogId: string }; openrouter?: { slug: string; contextLength: number } }`
  - `function loadPolicy(): PolicyEntry[]`, `function localEntries(): PolicyEntry[]`, `function openRouterEntries(): PolicyEntry[]`
  - `function explainBlock(slugOrId: string): string | null`
  - `class PolicyViolationError extends Error { reason: string }`, `function isAllowed(e: PolicyEntry): boolean`, `function assertAllowed(e: PolicyEntry): void`

- [ ] **Step 1: Write the failing governance test** (`packages/shared/test/governance.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { isAllowed, assertAllowed, PolicyViolationError, type PolicyEntry } from '../src/governance';

const local = (over: Partial<PolicyEntry> = {}): PolicyEntry => ({
  id: 'x', displayName: 'X', provider: 'local', agentCapable: true,
  origin: { org: 'Google', country: 'US' }, hosting: { kind: 'on-device' },
  approved: true, local: { catalogId: 'x' }, ...over,
});
const or = (over: Partial<PolicyEntry> = {}): PolicyEntry => ({
  id: 'y', displayName: 'Y', provider: 'openrouter', agentCapable: true,
  origin: { org: 'OpenAI', country: 'US' },
  hosting: { kind: 'openrouter', usProviders: ['openai'] },
  approved: true, openrouter: { slug: 'openai/gpt-4o', contextLength: 128000 }, ...over,
});

describe('isAllowed', () => {
  it('allows an approved US on-device model', () => expect(isAllowed(local())).toBe(true));
  it('allows an approved US OpenRouter model with US providers', () => expect(isAllowed(or())).toBe(true));
  it('blocks a non-approved model', () => expect(isAllowed(local({ approved: false }))).toBe(false));
  it('blocks OpenRouter with no US providers (fail closed)', () =>
    expect(isAllowed(or({ hosting: { kind: 'openrouter', usProviders: [] } }))).toBe(false));
  it('blocks a non-US origin even if approved', () =>
    // @ts-expect-error deliberately construct an invalid country to prove the runtime guard
    expect(isAllowed(local({ origin: { org: 'DeepSeek', country: 'CN' } }))).toBe(false));
});

describe('assertAllowed', () => {
  it('throws PolicyViolationError for a blocked model', () => {
    expect(() => assertAllowed(local({ approved: false }))).toThrow(PolicyViolationError);
  });
  it('does not throw for an allowed model', () => expect(() => assertAllowed(or())).not.toThrow());
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @fortress-code/shared`
Expected: FAIL — cannot resolve `../src/governance`.

- [ ] **Step 3: Implement the guard** (`packages/shared/src/governance.ts`)

```ts
export type Provider = 'local' | 'openrouter';
export interface Origin { org: string; country: 'US' }
export type Hosting = { kind: 'on-device' } | { kind: 'openrouter'; usProviders: string[] };

export interface PolicyEntry {
  id: string;
  displayName: string;
  provider: Provider;
  agentCapable: boolean;
  origin: Origin;
  hosting: Hosting;
  approved: boolean;
  local?: { catalogId: string };
  openrouter?: { slug: string; contextLength: number };
}

export class PolicyViolationError extends Error {
  constructor(message: string, public reason: string) {
    super(message);
    this.name = 'PolicyViolationError';
  }
}

export function isAllowed(e: PolicyEntry): boolean {
  if (!e.approved) return false;
  if (e.origin.country !== 'US') return false;
  if (e.provider === 'local') return e.hosting.kind === 'on-device';
  return e.hosting.kind === 'openrouter' && e.hosting.usProviders.length > 0;
}

export function assertAllowed(e: PolicyEntry): void {
  if (!isAllowed(e)) {
    throw new PolicyViolationError(
      `Model ${e.id} violates the US-only policy`,
      !e.approved ? 'not-approved'
        : e.origin.country !== 'US' ? 'non-us-origin'
        : 'no-us-hosting',
    );
  }
}
```

- [ ] **Step 4: Run governance test to verify it passes**

Run: `npm test -w @fortress-code/shared`
Expected: governance tests PASS.

- [ ] **Step 5: Write the failing policy test** (`packages/shared/test/policy.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { loadPolicy, localEntries, openRouterEntries, explainBlock } from '../src/policy';
import { isAllowed } from '../src/governance';

describe('policy registry', () => {
  it('maps every local catalog model to an approved US on-device entry', () => {
    const locals = localEntries();
    expect(locals.length).toBe(6); // the six catalog models
    for (const e of locals) {
      expect(e.provider).toBe('local');
      expect(e.origin.country).toBe('US');
      expect(e.hosting.kind).toBe('on-device');
      expect(isAllowed(e)).toBe(true);
      expect(e.local?.catalogId).toBe(e.id);
    }
    const orgs = new Set(locals.map((e) => e.origin.org));
    expect(orgs).toContain('Google');   // gemma
    expect(orgs).toContain('OpenAI');   // gpt-oss
  });

  it('every OpenRouter entry is US-origin with pinned US providers and passes the guard', () => {
    const ors = openRouterEntries();
    expect(ors.length).toBeGreaterThan(0);
    for (const e of ors) {
      expect(e.provider).toBe('openrouter');
      expect(e.origin.country).toBe('US');
      expect(e.hosting.kind === 'openrouter' && e.hosting.usProviders.length).toBeTruthy();
      expect(e.openrouter?.slug).toMatch(/.+\/.+/);
      expect(isAllowed(e)).toBe(true);
    }
  });

  it('loadPolicy is local + openrouter combined', () => {
    expect(loadPolicy().length).toBe(localEntries().length + openRouterEntries().length);
  });

  it('explainBlock names known non-US developers and is null for approved slugs', () => {
    expect(explainBlock('deepseek/deepseek-chat')).toMatch(/China/i);
    expect(explainBlock('qwen/qwen-2.5-72b-instruct')).toMatch(/China/i);
    expect(explainBlock('mistralai/mistral-large')).toMatch(/France/i);
    expect(explainBlock('openai/gpt-4o')).toBeNull();       // it's approved
    expect(explainBlock('some/unknown-model')).toMatch(/not on the .*approved/i);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm test -w @fortress-code/shared`
Expected: FAIL — cannot resolve `../src/policy`.

- [ ] **Step 7: Implement the registry** (`packages/shared/src/policy.ts`)

```ts
import { loadCatalog, type CatalogModel } from './catalog';
import type { PolicyEntry } from './governance';

const LOCAL_ORG: Record<CatalogModel['family'], string> = {
  gemma3: 'Google',
  'gpt-oss': 'OpenAI',
};

export function localEntries(): PolicyEntry[] {
  return loadCatalog().map((m): PolicyEntry => ({
    id: m.id,
    displayName: m.displayName,
    provider: 'local',
    agentCapable: m.toolCalling,
    origin: { org: LOCAL_ORG[m.family], country: 'US' },
    hosting: { kind: 'on-device' },
    approved: true,
    local: { catalogId: m.id },
  }));
}

// Curated US-origin OpenRouter models with US inference providers pinned.
// MAINTENANCE: adding an entry is a governance decision — verify the developer is
// US-headquartered AND that every listed provider is US-operated on OpenRouter.
// Provider slugs follow OpenRouter's provider names; re-verify against
// https://openrouter.ai/docs when updating.
export function openRouterEntries(): PolicyEntry[] {
  return [
    {
      id: 'or-gpt-4o', displayName: 'GPT-4o (OpenRouter)', provider: 'openrouter', agentCapable: true,
      origin: { org: 'OpenAI', country: 'US' },
      hosting: { kind: 'openrouter', usProviders: ['openai', 'azure'] },
      approved: true, openrouter: { slug: 'openai/gpt-4o', contextLength: 128000 },
    },
    {
      id: 'or-gpt-4o-mini', displayName: 'GPT-4o mini (OpenRouter)', provider: 'openrouter', agentCapable: true,
      origin: { org: 'OpenAI', country: 'US' },
      hosting: { kind: 'openrouter', usProviders: ['openai', 'azure'] },
      approved: true, openrouter: { slug: 'openai/gpt-4o-mini', contextLength: 128000 },
    },
    {
      id: 'or-claude-3-5-sonnet', displayName: 'Claude 3.5 Sonnet (OpenRouter)', provider: 'openrouter', agentCapable: true,
      origin: { org: 'Anthropic', country: 'US' },
      hosting: { kind: 'openrouter', usProviders: ['anthropic', 'amazon-bedrock', 'google-vertex'] },
      approved: true, openrouter: { slug: 'anthropic/claude-3.5-sonnet', contextLength: 200000 },
    },
    {
      id: 'or-llama-3-3-70b', displayName: 'Llama 3.3 70B (OpenRouter)', provider: 'openrouter', agentCapable: true,
      origin: { org: 'Meta', country: 'US' },
      hosting: { kind: 'openrouter', usProviders: ['together', 'fireworks', 'lambda'] },
      approved: true, openrouter: { slug: 'meta-llama/llama-3.3-70b-instruct', contextLength: 131072 },
    },
  ];
}

export function loadPolicy(): PolicyEntry[] {
  return [...localEntries(), ...openRouterEntries()];
}

// Known non-US developer prefixes → human-readable reason. Used by the add-model
// blocked state. Extend as needed; unknown slugs fall through to the generic message.
const NON_US: { test: RegExp; reason: string }[] = [
  { test: /^deepseek\//i, reason: 'DeepSeek is a China-based developer.' },
  { test: /^(qwen|alibaba)\//i, reason: 'Qwen (Alibaba) is a China-based developer.' },
  { test: /^(01-ai|yi)\//i, reason: 'Yi (01.AI) is a China-based developer.' },
  { test: /^(thudm|z-ai|zhipu|glm)\//i, reason: 'GLM (Zhipu AI) is a China-based developer.' },
  { test: /^(mistralai|mistral)\//i, reason: 'Mistral AI is a France-based developer.' },
  { test: /^cohere\//i, reason: 'Cohere is a Canada-based developer.' },
];

export function explainBlock(slugOrId: string): string | null {
  if (loadPolicy().some((e) => e.openrouter?.slug === slugOrId || e.id === slugOrId)) return null;
  for (const n of NON_US) if (n.test.test(slugOrId)) return n.reason;
  return 'This model is not on the US-approved list.';
}
```

In `packages/shared/src/index.ts` add:

```ts
export * from './governance';
export * from './policy';
```

- [ ] **Step 8: Run all shared tests to verify they pass**

Run: `npm test -w @fortress-code/shared`
Expected: all shared tests PASS (governance + policy + prior catalog/messages).

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/policy.ts packages/shared/src/governance.ts packages/shared/src/index.ts packages/shared/test/policy.test.ts packages/shared/test/governance.test.ts
git commit -m "feat(shared): US-only governance registry and fail-closed policy guard

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: extension — chat session + provider target/stream (local)

**Files:**
- Create: `packages/extension/src/chat/session.ts`, `packages/extension/src/providers/target.ts`, `packages/extension/src/providers/stream.ts`
- Test: `packages/extension/src/test/session.test.ts`, `packages/extension/src/test/target.test.ts`, `packages/extension/src/test/stream.test.ts`

**Interfaces:**
- Consumes: `validateHistory`, `ChatMessage`, `PolicyEntry`, `assertAllowed` from `@fortress-code/shared`.
- Produces:
  - `class Session { messages: ChatMessage[]; addUser(t); addAssistant(t); addToolExchange(a, results); clear(); toRequestMessages(systemPrompt): ChatMessage[]; save(state); static load(state): Session }`
  - `interface TargetDeps { localEndpoint?: string; openRouterKey?: string }`
  - `interface ResolvedTarget { url: string; headers: Record<string,string>; bodyExtra: Record<string,unknown>; model?: string }`
  - `function resolveTarget(entry: PolicyEntry, deps: TargetDeps): ResolvedTarget` (calls `assertAllowed` first; local branch only in this task)
  - `class WatchdogError extends Error`
  - `function streamChat(target: ResolvedTarget, messages: ChatMessage[], onToken: (t: string) => void, signal: AbortSignal): Promise<string>`

- [ ] **Step 1: Write the failing session test** (`packages/extension/src/test/session.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { Session } from '../chat/session';

describe('Session', () => {
  it('builds request messages with system prompt first', () => {
    const s = new Session();
    s.addUser('hi'); s.addAssistant('hello');
    const msgs = s.toRequestMessages('SYS');
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(msgs).toHaveLength(3);
  });

  it('round-trips through a Memento-like store', () => {
    const store = new Map<string, unknown>();
    const memento = { get: (k: string) => store.get(k), update: (k: string, v: unknown) => (store.set(k, v), Promise.resolve()) } as any;
    const s = new Session();
    s.addUser('persisted');
    s.save(memento);
    expect(Session.load(memento).messages[0].content).toBe('persisted');
  });

  it('drops a poisoned persisted history rather than throwing', () => {
    const store = new Map<string, unknown>([['fortressCode.session', [{ content: 'Request failed with status code 503' }]]]);
    const memento = { get: (k: string) => store.get(k), update: () => Promise.resolve() } as any;
    expect(Session.load(memento).messages).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w fortress-code`
Expected: FAIL — cannot resolve `../chat/session`.

- [ ] **Step 3: Implement session** (`packages/extension/src/chat/session.ts`)

```ts
import type { Memento } from 'vscode';
import { validateHistory, type ChatMessage } from '@fortress-code/shared';

const KEY = 'fortressCode.session';

export class Session {
  messages: ChatMessage[] = [];

  addUser(text: string): void { this.messages.push({ role: 'user', content: text }); }
  addAssistant(text: string): void { this.messages.push({ role: 'assistant', content: text }); }
  addToolExchange(assistant: ChatMessage, results: ChatMessage[]): void { this.messages.push(assistant, ...results); }
  clear(): void { this.messages = []; }

  toRequestMessages(systemPrompt: string): ChatMessage[] {
    return validateHistory([{ role: 'system', content: systemPrompt }, ...this.messages]);
  }

  save(state: Memento): void { void state.update(KEY, this.messages); }

  static load(state: Memento): Session {
    const s = new Session();
    try { s.messages = validateHistory(state.get(KEY) ?? []); } catch { s.messages = []; }
    return s;
  }
}
```

- [ ] **Step 4: Run session test to verify it passes**

Run: `npm test -w fortress-code`
Expected: session tests PASS.

- [ ] **Step 5: Write the failing target test** (`packages/extension/src/test/target.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { resolveTarget } from '../providers/target';
import { PolicyViolationError, type PolicyEntry } from '@fortress-code/shared';

const localEntry: PolicyEntry = {
  id: 'gpt-oss-20b', displayName: 'gpt-oss', provider: 'local', agentCapable: true,
  origin: { org: 'OpenAI', country: 'US' }, hosting: { kind: 'on-device' },
  approved: true, local: { catalogId: 'gpt-oss-20b' },
};

describe('resolveTarget (local)', () => {
  it('builds a local llama-server target with no auth and no bodyExtra', () => {
    const t = resolveTarget(localEntry, { localEndpoint: 'http://127.0.0.1:5599' });
    expect(t.url).toBe('http://127.0.0.1:5599/v1/chat/completions');
    expect(t.headers['content-type']).toBe('application/json');
    expect(t.headers.authorization).toBeUndefined();
    expect(t.bodyExtra).toEqual({});
    expect(t.model).toBeUndefined(); // llama-server ignores model
  });

  it('throws if the local endpoint is missing', () => {
    expect(() => resolveTarget(localEntry, {})).toThrow(/endpoint/i);
  });

  it('throws PolicyViolationError before building for a disallowed entry', () => {
    const bad = { ...localEntry, approved: false };
    expect(() => resolveTarget(bad, { localEndpoint: 'http://x' })).toThrow(PolicyViolationError);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npm test -w fortress-code`
Expected: FAIL — cannot resolve `../providers/target`.

- [ ] **Step 7: Implement target (local branch)** (`packages/extension/src/providers/target.ts`)

```ts
import { assertAllowed, type PolicyEntry } from '@fortress-code/shared';

export interface TargetDeps {
  localEndpoint?: string;   // http://127.0.0.1:PORT from daemon status, when a local model is ready
  openRouterKey?: string;   // from SecretStorage, for OpenRouter entries
}

export interface ResolvedTarget {
  url: string;
  headers: Record<string, string>;
  bodyExtra: Record<string, unknown>;
  model?: string;
}

export function resolveTarget(entry: PolicyEntry, deps: TargetDeps): ResolvedTarget {
  assertAllowed(entry); // fail closed before we build anything

  if (entry.provider === 'local') {
    if (!deps.localEndpoint) throw new Error('No local model endpoint — start a local model first.');
    return {
      url: `${deps.localEndpoint}/v1/chat/completions`,
      headers: { 'content-type': 'application/json' },
      bodyExtra: {},
    };
  }

  // OpenRouter branch is added in Task 15.
  throw new Error(`Unsupported provider: ${entry.provider}`);
}
```

- [ ] **Step 8: Run target test to verify it passes**

Run: `npm test -w fortress-code`
Expected: local target tests PASS (the disallowed-entry and missing-endpoint cases too).

- [ ] **Step 9: Write the failing stream test** (`packages/extension/src/test/stream.test.ts`)

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { streamChat, WatchdogError } from '../providers/stream';
import type { ResolvedTarget } from '../providers/target';

let server: Server; let target: ResolvedTarget;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  target = { url: `${base}/v1/chat/completions`, headers: { 'content-type': 'application/json' }, bodyExtra: {} };
});
afterAll(() => server.close());

describe('streamChat', () => {
  it('concatenates SSE deltas and reports tokens', async () => {
    const tokens: string[] = [];
    const full = await streamChat(target, [{ role: 'user', content: 'hi' }], (t) => tokens.push(t), new AbortController().signal);
    expect(full).toBe('Hello');
    expect(tokens).toEqual(['Hel', 'lo']);
  });

  it('watchdog rejects when the stream stalls', async () => {
    process.env.FC_WATCHDOG_MS = '200';
    const stall = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' }));
    await new Promise<void>((r) => stall.listen(0, '127.0.0.1', r));
    const stallTarget: ResolvedTarget = { url: `http://127.0.0.1:${(stall.address() as AddressInfo).port}/v1/chat/completions`, headers: {}, bodyExtra: {} };
    await expect(streamChat(stallTarget, [{ role: 'user', content: 'hi' }], () => {}, new AbortController().signal))
      .rejects.toThrow(WatchdogError);
    stall.close();
    delete process.env.FC_WATCHDOG_MS;
  });
});
```

- [ ] **Step 10: Run to verify it fails**

Run: `npm test -w fortress-code`
Expected: FAIL — cannot resolve `../providers/stream`.

- [ ] **Step 11: Implement stream** (`packages/extension/src/providers/stream.ts`)

```ts
import type { ChatMessage } from '@fortress-code/shared';
import type { ResolvedTarget } from './target';

export class WatchdogError extends Error {}

export async function streamChat(
  target: ResolvedTarget, messages: ChatMessage[], onToken: (t: string) => void, signal: AbortSignal,
): Promise<string> {
  const watchdogMs = Number(process.env.FC_WATCHDOG_MS ?? 60_000);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort);
  let timer = setTimeout(() => ctrl.abort(new WatchdogError('no tokens for 60s')), watchdogMs);
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...target.headers },
      body: JSON.stringify({ ...(target.model ? { model: target.model } : {}), messages, stream: true, ...target.bodyExtra }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Model server HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    let full = '';
    let buf = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const data = event.replace(/^data: /m, '').trim();
        if (!data || data === '[DONE]') continue;
        const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length) {
          clearTimeout(timer);
          timer = setTimeout(() => ctrl.abort(new WatchdogError('no tokens for 60s')), watchdogMs);
          full += delta;
          onToken(delta);
        }
      }
    }
    return full;
  } catch (e) {
    if (ctrl.signal.reason instanceof WatchdogError) throw ctrl.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
```

- [ ] **Step 12: Run all extension tests to verify they pass**

Run: `npm run build -w @fortress-code/shared && npm test -w fortress-code`
Expected: session + target + stream + prior daemon tests PASS.

- [ ] **Step 13: Commit**

```bash
git add packages/extension/src/chat/session.ts packages/extension/src/providers/target.ts packages/extension/src/providers/stream.ts packages/extension/src/test/session.test.ts packages/extension/src/test/target.test.ts packages/extension/src/test/stream.test.ts
git commit -m "feat(extension): typed session, provider target resolver (local), and SSE streamChat

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 15: extension — OpenRouter provider target + SecretStorage key

**Files:**
- Modify: `packages/extension/src/providers/target.ts` (add the OpenRouter branch)
- Create: `packages/extension/src/secrets.ts`
- Test: `packages/extension/src/test/target.test.ts` (add OpenRouter cases)

**Interfaces:**
- Consumes: `PolicyEntry`, `assertAllowed`, `PolicyViolationError` from `@fortress-code/shared`.
- Produces:
  - `resolveTarget` now handles `provider === 'openrouter'`: builds `url = 'https://openrouter.ai/api/v1/chat/completions'`, `headers.authorization = 'Bearer <key>'`, `model = entry.openrouter.slug`, `bodyExtra.provider = { only: entry.hosting.usProviders, allow_fallbacks: false, data_collection: 'deny' }`. Throws if key missing.
  - `secrets.ts`: `const OPENROUTER_KEY_ID = 'fortressCode.openRouterKey'`, `async function getOpenRouterKey(secrets: vscode.SecretStorage): Promise<string | undefined>`, `async function setOpenRouterKey(secrets: vscode.SecretStorage, key: string): Promise<void>`, `async function clearOpenRouterKey(secrets: vscode.SecretStorage): Promise<void>`.

- [ ] **Step 1: Add the failing OpenRouter target tests** (append to `packages/extension/src/test/target.test.ts`)

```ts
import { PolicyViolationError as PVE } from '@fortress-code/shared';

const orEntry = {
  id: 'or-gpt-4o', displayName: 'GPT-4o', provider: 'openrouter', agentCapable: true,
  origin: { org: 'OpenAI', country: 'US' },
  hosting: { kind: 'openrouter', usProviders: ['openai', 'azure'] },
  approved: true, openrouter: { slug: 'openai/gpt-4o', contextLength: 128000 },
} as const;

describe('resolveTarget (openrouter)', () => {
  it('builds the fail-closed US-provider-pinned request', () => {
    const t = resolveTarget(orEntry as any, { openRouterKey: 'sk-or-abc' });
    expect(t.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(t.headers.authorization).toBe('Bearer sk-or-abc');
    expect(t.model).toBe('openai/gpt-4o');
    expect(t.bodyExtra.provider).toEqual({ only: ['openai', 'azure'], allow_fallbacks: false, data_collection: 'deny' });
  });

  it('throws if the OpenRouter key is missing', () => {
    expect(() => resolveTarget(orEntry as any, {})).toThrow(/key/i);
  });

  it('throws PolicyViolationError for an OpenRouter entry with no US providers', () => {
    const bad = { ...orEntry, hosting: { kind: 'openrouter', usProviders: [] } };
    expect(() => resolveTarget(bad as any, { openRouterKey: 'sk-or-abc' })).toThrow(PVE);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w fortress-code`
Expected: FAIL — OpenRouter branch throws `Unsupported provider`.

- [ ] **Step 3: Add the OpenRouter branch to `resolveTarget`** (`packages/extension/src/providers/target.ts`)

Replace the final `throw new Error(\`Unsupported provider: ${entry.provider}\`);` with:

```ts
  // OpenRouter: fail-closed — pin US providers, no fallback, deny data collection.
  if (!deps.openRouterKey) throw new Error('No OpenRouter API key — add your key to use cloud models.');
  if (entry.hosting.kind !== 'openrouter' || !entry.openrouter) throw new Error('Malformed OpenRouter entry');
  return {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${deps.openRouterKey}`,
      'http-referer': 'https://github.com/curtismuir/fortress-code',
      'x-title': 'Fortress Code',
    },
    bodyExtra: {
      provider: { only: entry.hosting.usProviders, allow_fallbacks: false, data_collection: 'deny' },
    },
    model: entry.openrouter.slug,
  };
```

(The `assertAllowed(entry)` call at the top of `resolveTarget` already guarantees `usProviders.length > 0` for an allowed OpenRouter entry, so the disallowed case throws `PolicyViolationError` before reaching this branch.)

- [ ] **Step 4: Run target tests to verify they pass**

Run: `npm test -w fortress-code`
Expected: all target tests (local + openrouter) PASS.

- [ ] **Step 5: Implement the SecretStorage wrapper** (`packages/extension/src/secrets.ts`)

```ts
import type { SecretStorage } from 'vscode';

export const OPENROUTER_KEY_ID = 'fortressCode.openRouterKey';

export function getOpenRouterKey(secrets: SecretStorage): Promise<string | undefined> {
  return Promise.resolve(secrets.get(OPENROUTER_KEY_ID));
}
export async function setOpenRouterKey(secrets: SecretStorage, key: string): Promise<void> {
  await secrets.store(OPENROUTER_KEY_ID, key.trim());
}
export async function clearOpenRouterKey(secrets: SecretStorage): Promise<void> {
  await secrets.delete(OPENROUTER_KEY_ID);
}
```

(`secrets.ts` imports only the `SecretStorage` type from `vscode`, so it type-checks under the build but is not unit-tested here; it is exercised in the Task 18 manual verification and Task 20 UAT.)

- [ ] **Step 6: Build to confirm types**

Run: `npm run build -w @fortress-code/shared && npm run build -w fortress-code`
Expected: esbuild produces both bundles; `tsc --noEmit` clean.

- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/providers/target.ts packages/extension/src/secrets.ts packages/extension/src/test/target.test.ts
git commit -m "feat(extension): fail-closed OpenRouter target with US-provider pinning and SecretStorage key

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 16: extension — agent tools (read_file, list_files, search, edit_file)

**Files:**
- Create: `packages/extension/src/agent/tools.ts`
- Test: `packages/extension/src/test/tools.test.ts`
- Modify: `packages/extension/package.json` (add the vitest `vscode` alias so tests don't load the real `vscode`)
- Create: `packages/extension/src/test/vscode-stub.ts`

**Interfaces:**
- Produces:
  - `const TOOL_SCHEMAS: object[]` — OpenAI function schemas for the four tools.
  - `function resolveInWorkspace(root: string, relPath: string): string` — throws `PathEscapeError` if the resolved path leaves `root`.
  - `class PathEscapeError extends Error`
  - `async function executeTool(name: string, args: any, workspaceRoot: string): Promise<string>`

- [ ] **Step 1: Add the vitest vscode alias** (`packages/extension/package.json`)

Add this key to the extension `package.json` (top level, alongside `scripts`):

```json
"vitest": { "resolve": { "alias": { "vscode": "./src/test/vscode-stub.ts" } } }
```

Create `packages/extension/src/test/vscode-stub.ts`:

```ts
export default {};
export const Uri = { file: (p: string) => ({ path: p }), parse: (s: string) => ({ with: (x: any) => x }) };
export const workspace = {} as any;
export const window = {} as any;
export const commands = {} as any;
```

(If the inline `vitest` key is not picked up by your vitest version, create `packages/extension/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({ resolve: { alias: { vscode: resolve(__dirname, 'src/test/vscode-stub.ts') } } });
```

)

- [ ] **Step 2: Write the failing test** (`packages/extension/src/test/tools.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { resolveInWorkspace, PathEscapeError, TOOL_SCHEMAS } from '../agent/tools';

describe('resolveInWorkspace', () => {
  it('resolves inside the workspace', () => {
    expect(resolveInWorkspace('/ws', 'src/a.ts')).toBe('/ws/src/a.ts');
  });
  it('blocks .. escape and absolute paths', () => {
    expect(() => resolveInWorkspace('/ws', '../etc/passwd')).toThrow(PathEscapeError);
    expect(() => resolveInWorkspace('/ws', '/etc/passwd')).toThrow(PathEscapeError);
    expect(() => resolveInWorkspace('/ws', 'a/../../x')).toThrow(PathEscapeError);
  });
});

describe('TOOL_SCHEMAS', () => {
  it('exposes exactly the four v1 tools', () => {
    const names = TOOL_SCHEMAS.map((t: any) => t.function.name).sort();
    expect(names).toEqual(['edit_file', 'list_files', 'read_file', 'search']);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm test -w fortress-code`
Expected: FAIL — cannot resolve `../agent/tools`.

- [ ] **Step 4: Implement** (`packages/extension/src/agent/tools.ts`)

```ts
import * as vscode from 'vscode';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, sep, join, relative } from 'node:path';

export class PathEscapeError extends Error {}

export const TOOL_SCHEMAS = [
  { type: 'function', function: { name: 'read_file', description: 'Read a text file from the workspace', parameters: { type: 'object', properties: { path: { type: 'string', description: 'workspace-relative path' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List files under a workspace directory (recursive, max 200 entries)', parameters: { type: 'object', properties: { path: { type: 'string', description: 'workspace-relative directory, "" for root' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search', description: 'Search file contents with a case-sensitive substring', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Replace the full contents of a file (or create it). The user reviews a diff and can reject.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: 'complete new file contents' } }, required: ['path', 'content'] } } },
];

export function resolveInWorkspace(root: string, relPath: string): string {
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) throw new PathEscapeError(`path escapes workspace: ${relPath}`);
  return abs;
}

const IGNORE = new Set(['node_modules', '.git', 'dist', 'out', '.venv']);

function walk(dir: string, root: string, acc: string[], limit: number): void {
  if (acc.length >= limit) return;
  for (const name of readdirSync(dir)) {
    if (IGNORE.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, acc, limit);
    else acc.push(relative(root, full));
    if (acc.length >= limit) return;
  }
}

async function editFileWithApproval(abs: string, content: string, rel: string): Promise<string> {
  const uri = vscode.Uri.file(abs);
  let original = '';
  try { original = readFileSync(abs, 'utf8'); } catch { /* new file */ }
  const left = vscode.Uri.parse(`untitled:${rel}.orig`).with({ scheme: 'fc-orig', path: rel });
  const provider = vscode.workspace.registerTextDocumentContentProvider('fc-orig', {
    provideTextDocumentContent: () => original,
  });
  const right = vscode.Uri.parse(`fc-new:${rel}`).with({ scheme: 'fc-new', path: rel });
  const provider2 = vscode.workspace.registerTextDocumentContentProvider('fc-new', {
    provideTextDocumentContent: () => content,
  });
  try {
    await vscode.commands.executeCommand('vscode.diff', left, right, `Agent edit: ${rel}`);
    const choice = await vscode.window.showInformationMessage(`Apply agent edit to ${rel}?`, { modal: true }, 'Apply', 'Reject');
    if (choice !== 'Apply') return 'rejected by user';
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: true, contents: Buffer.from(content, 'utf8') });
    await vscode.workspace.applyEdit(edit);
    return 'applied';
  } finally {
    provider.dispose(); provider2.dispose();
  }
}

export async function executeTool(name: string, args: any, workspaceRoot: string): Promise<string> {
  switch (name) {
    case 'read_file': {
      const abs = resolveInWorkspace(workspaceRoot, String(args.path));
      const body = readFileSync(abs, 'utf8');
      return body.length > 50_000 ? body.slice(0, 50_000) + '\n…(truncated)' : body;
    }
    case 'list_files': {
      const abs = resolveInWorkspace(workspaceRoot, String(args.path ?? ''));
      const acc: string[] = [];
      walk(abs, workspaceRoot, acc, 200);
      return acc.join('\n') || '(empty)';
    }
    case 'search': {
      const acc: string[] = [];
      walk(workspaceRoot, workspaceRoot, acc, 2000);
      const hits: string[] = [];
      for (const rel of acc) {
        try {
          const lines = readFileSync(join(workspaceRoot, rel), 'utf8').split('\n');
          lines.forEach((line, i) => {
            if (line.includes(String(args.query)) && hits.length < 100) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        } catch { /* binary or unreadable */ }
      }
      return hits.join('\n') || 'no matches';
    }
    case 'edit_file': {
      const rel = String(args.path);
      const abs = resolveInWorkspace(workspaceRoot, rel);
      return editFileWithApproval(abs, String(args.content), rel);
    }
    default:
      return `unknown tool: ${name}`;
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm test -w fortress-code`
Expected: tools tests PASS; vitest does not load the real `vscode`.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/agent/tools.ts packages/extension/src/test/tools.test.ts packages/extension/src/test/vscode-stub.ts packages/extension/package.json
git commit -m "feat(extension): four agent tools with workspace path confinement and diff-approval edits

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 17: extension — agent loop (provider-generalized)

**Files:**
- Create: `packages/extension/src/agent/loop.ts`
- Test: `packages/extension/src/test/loop.test.ts`

**Interfaces:**
- Consumes: `TOOL_SCHEMAS`, `executeTool` (Task 16); `ResolvedTarget` (Task 14); `Session` (Task 14); `ChatMessage`, `ToolCall` (shared).
- Produces:
  - `const MAX_ITERATIONS = 10`
  - `async function completeOnce(target: ResolvedTarget, messages: ChatMessage[], signal: AbortSignal): Promise<{ content: string; toolCalls: ToolCall[] }>` — POST with `tools: TOOL_SCHEMAS`, `stream: false`, honoring `target.model`/`target.bodyExtra` (so OpenRouter's provider pin is applied to agent calls too).
  - `async function runAgentTurn(target: ResolvedTarget, session: Session, systemPrompt: string, onStep: (s: string) => void, signal: AbortSignal, deps?: { complete?: typeof completeOnce; execute?: typeof executeTool; workspaceRoot?: string }): Promise<void>`

- [ ] **Step 1: Write the failing test** (`packages/extension/src/test/loop.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { runAgentTurn, MAX_ITERATIONS } from '../agent/loop';
import { Session } from '../chat/session';
import type { ResolvedTarget } from '../providers/target';

const target: ResolvedTarget = { url: 'http://x/v1/chat/completions', headers: {}, bodyExtra: {} };

function fakeCompleter(script: Array<{ content: string; toolCalls: any[] }>) {
  let i = 0;
  return async () => script[Math.min(i++, script.length - 1)];
}

describe('runAgentTurn', () => {
  it('executes tool calls then finishes on a content reply', async () => {
    const session = new Session();
    session.addUser('read a file');
    const executed: string[] = [];
    await runAgentTurn(target, session, 'SYS', () => {}, new AbortController().signal, {
      complete: fakeCompleter([
        { content: '', toolCalls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
        { content: 'The file says hi.', toolCalls: [] },
      ]),
      execute: async (name) => { executed.push(name); return 'hi'; },
      workspaceRoot: '/ws',
    });
    expect(executed).toEqual(['read_file']);
    expect(session.messages.at(-1)!).toEqual({ role: 'assistant', content: 'The file says hi.' });
    expect(session.messages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('stops after MAX_ITERATIONS of pure tool calls', async () => {
    const session = new Session();
    session.addUser('loop forever');
    let calls = 0;
    await runAgentTurn(target, session, 'SYS', () => {}, new AbortController().signal, {
      complete: async () => { calls++; return { content: '', toolCalls: [{ id: String(calls), type: 'function', function: { name: 'search', arguments: '{"query":"x"}' } }] }; },
      execute: async () => 'nothing',
      workspaceRoot: '/ws',
    });
    expect(calls).toBe(MAX_ITERATIONS);
    expect(session.messages.at(-1)!.content).toContain('iteration limit');
  });

  it('reports malformed tool arguments as a tool error, not a crash', async () => {
    const session = new Session();
    session.addUser('bad args');
    await runAgentTurn(target, session, 'SYS', () => {}, new AbortController().signal, {
      complete: fakeCompleter([
        { content: '', toolCalls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: 'NOT JSON' } }] },
        { content: 'done', toolCalls: [] },
      ]),
      execute: async () => 'never called',
      workspaceRoot: '/ws',
    });
    const toolMsg = session.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toContain('invalid arguments');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w fortress-code`
Expected: FAIL — cannot resolve `../agent/loop`.

- [ ] **Step 3: Implement** (`packages/extension/src/agent/loop.ts`)

```ts
import * as vscode from 'vscode';
import type { ChatMessage, ToolCall } from '@fortress-code/shared';
import { TOOL_SCHEMAS, executeTool } from './tools';
import type { Session } from '../chat/session';
import type { ResolvedTarget } from '../providers/target';

export const MAX_ITERATIONS = 10;

export async function completeOnce(
  target: ResolvedTarget, messages: ChatMessage[], signal: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const res = await fetch(target.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...target.headers },
    body: JSON.stringify({ ...(target.model ? { model: target.model } : {}), messages, tools: TOOL_SCHEMAS, stream: false, ...target.bodyExtra }),
    signal,
  });
  if (!res.ok) throw new Error(`Model server HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const msg = (await res.json())?.choices?.[0]?.message ?? {};
  return { content: typeof msg.content === 'string' ? msg.content : '', toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [] };
}

export async function runAgentTurn(
  target: ResolvedTarget, session: Session, systemPrompt: string,
  onStep: (step: string) => void, signal: AbortSignal,
  deps: { complete?: typeof completeOnce; execute?: typeof executeTool; workspaceRoot?: string } = {},
): Promise<void> {
  const complete = deps.complete ?? completeOnce;
  const execute = deps.execute ?? executeTool;
  const root = deps.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error('Agent mode needs an open workspace folder');

  const agentSystem = `${systemPrompt}\nYou can use tools to inspect and edit files in the user's workspace. Use tools when needed; when you have the answer, reply in plain text without tool calls.`;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal.aborted) throw new Error('cancelled');
    const { content, toolCalls } = await complete(target, session.toRequestMessages(agentSystem), signal);
    if (toolCalls.length === 0) {
      session.addAssistant(content || '(no reply)');
      return;
    }
    const assistantMsg: ChatMessage = { role: 'assistant', content: content ?? '', tool_calls: toolCalls };
    const results: ChatMessage[] = [];
    for (const tc of toolCalls) {
      onStep(`${tc.function.name}(${tc.function.arguments.slice(0, 120)})`);
      let result: string;
      try {
        let parsed: unknown;
        try { parsed = JSON.parse(tc.function.arguments); }
        catch { result = 'error: invalid arguments (not valid JSON)'; results.push({ role: 'tool', content: result, tool_call_id: tc.id }); continue; }
        result = await execute(tc.function.name, parsed, root);
      } catch (e) {
        result = `error: ${e}`;
      }
      results.push({ role: 'tool', content: result, tool_call_id: tc.id });
    }
    session.addToolExchange(assistantMsg, results);
  }
  session.addAssistant('Stopped: agent iteration limit (10) reached without a final answer.');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w fortress-code`
Expected: loop tests PASS (3).

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/agent/loop.ts packages/extension/src/test/loop.test.ts
git commit -m "feat(extension): provider-generalized agent loop with 10-iteration cap and tool errors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 18: extension — chat webview: governed gallery + chat surface

**Files:**
- Modify (replace the stub): `packages/extension/src/chat/ChatViewProvider.ts`
- Create: `packages/extension/media/chat.html`, `packages/extension/media/chat.css`, `packages/extension/media/chat.js`

**Interfaces:**
- Consumes: `Session` (T14), `resolveTarget`/`TargetDeps` (T14/15), `streamChat` (T14), `runAgentTurn` (T17), `getOpenRouterKey`/`setOpenRouterKey` (T15), `DaemonClient`/`ensureDaemon` (T12), and from shared: `loadPolicy`, `localEntries`, `openRouterEntries`, `explainBlock`, `assertAllowed`, `PolicyViolationError`, `type PolicyEntry`, `type StatusResponse`.
- Produces: the full `ChatViewProvider` (replaces the Task-12 stub, same constructor signature `constructor(context, connect: () => Promise<DaemonClient>)`).

This is a UI task: the logic it uses (governance, providers, session, agent loop) is unit-tested in Tasks 13–17; here we wire it and verify manually in the Extension Development Host.

- [ ] **Step 1: Implement the view provider** (`packages/extension/src/chat/ChatViewProvider.ts`)

```ts
import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPolicy, localEntries, explainBlock, type PolicyEntry, type StatusResponse } from '@fortress-code/shared';
import { DaemonClient } from '../daemon';
import { Session } from './session';
import { resolveTarget } from '../providers/target';
import { streamChat } from '../providers/stream';
import { runAgentTurn } from '../agent/loop';
import { getOpenRouterKey, setOpenRouterKey } from '../secrets';

const SYSTEM_PROMPT = 'You are Fortress Code, a helpful local coding assistant.';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private client: DaemonClient | null = null;
  private session: Session;
  private generating: AbortController | null = null;
  private agentMode = false;
  private selected: PolicyEntry | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(private context: vscode.ExtensionContext, private connect: () => Promise<DaemonClient>) {
    this.session = Session.load(context.workspaceState);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    let html = readFileSync(join(this.context.extensionPath, 'media', 'chat.html'), 'utf8');
    html = html.replace(/\{cspSource\}/g, view.webview.cspSource);
    for (const f of ['chat.css', 'chat.js']) {
      html = html.replace(f, view.webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString());
    }
    view.webview.html = html;
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    void this.init();
  }

  private post(msg: unknown): void { void this.view?.webview.postMessage(msg); }
  private banner(message: string): void { this.post({ type: 'error', message }); }

  private async init(): Promise<void> {
    try {
      this.client = await this.connect();
      this.post({ type: 'policy', local: localEntries(), openrouter: loadPolicy().filter((e) => e.provider === 'openrouter') });
      this.post({ type: 'openRouterKeySet', set: !!(await getOpenRouterKey(this.context.secrets)) });
      this.post({ type: 'history', messages: this.session.messages });
      this.poller = setInterval(() => void this.pushStatus(), 2000);
      this.context.subscriptions.push({ dispose: () => this.poller && clearInterval(this.poller) });
      await this.pushStatus();
    } catch (e) {
      this.banner(`Could not start the Fortress Code daemon: ${e}`);
    }
  }

  private async pushStatus(): Promise<void> {
    if (!this.client) return;
    try {
      const status: StatusResponse = await this.client.status();
      this.post({ type: 'state', status, selectedId: this.selected?.id ?? null });
    } catch { /* daemon idle-exited; next send re-spawns */ }
  }

  private async onMessage(m: any): Promise<void> {
    try {
      switch (m.type) {
        case 'send': return await this.handleSend(String(m.text));
        case 'cancel': this.generating?.abort(); return;
        case 'newChat': this.session.clear(); this.session.save(this.context.workspaceState); this.post({ type: 'history', messages: [] }); return;
        case 'agentToggle': this.agentMode = !!m.on; return;
        case 'selectModel': return await this.selectModel(String(m.id));
        case 'addModel': return this.handleAddModel(String(m.slug));
        case 'setOpenRouterKey': await setOpenRouterKey(this.context.secrets, String(m.key)); this.post({ type: 'openRouterKeySet', set: true }); return;
        case 'downloadModel': await this.client?.download(String(m.catalogId)); return;
        case 'installBinary': await this.client?.installBinary(); return;
        case 'killForeign': await this.client?.foreignKill(m.pids); return;
      }
    } catch (e) {
      this.banner(String(e));
    }
  }

  private async selectModel(id: string): Promise<void> {
    const entry = loadPolicy().find((e) => e.id === id);
    if (!entry) return;
    this.selected = entry;
    if (entry.provider === 'local') {
      if (!this.client) this.client = await this.connect();
      const r = await this.client.start(entry.local!.catalogId);
      if (!r.ok) this.post({ type: 'startRejected', rejection: r.rejection, modelId: id });
    }
    await this.pushStatus();
  }

  private handleAddModel(slug: string): void {
    const reason = explainBlock(slug);
    if (reason) { this.post({ type: 'addBlocked', slug, reason }); return; }
    // Approved slug: it is already in the registry; surface it as selectable.
    this.post({ type: 'addAccepted', slug });
  }

  private async targetDeps() {
    const status = this.client ? await this.client.status().catch(() => null) : null;
    return {
      localEndpoint: status?.endpoint ?? undefined,
      openRouterKey: await getOpenRouterKey(this.context.secrets),
    };
  }

  private async handleSend(text: string): Promise<void> {
    if (!this.selected) { this.banner('Pick a model first.'); this.post({ type: 'restoreInput', text }); return; }
    let target;
    try {
      target = resolveTarget(this.selected, await this.targetDeps());
    } catch (e) {
      this.banner(String(e instanceof Error ? e.message : e));
      this.post({ type: 'restoreInput', text });
      return;
    }
    this.session.addUser(text);
    this.post({ type: 'history', messages: this.session.messages });
    this.generating = new AbortController();
    try {
      if (this.agentMode) {
        await runAgentTurn(target, this.session, SYSTEM_PROMPT, (step) => this.post({ type: 'agentStep', step }), this.generating.signal);
      } else {
        const full = await streamChat(target, this.session.toRequestMessages(SYSTEM_PROMPT), (t) => this.post({ type: 'token', text: t }), this.generating.signal);
        this.session.addAssistant(full);
      }
      this.session.save(this.context.workspaceState);
      this.post({ type: 'history', messages: this.session.messages });
    } catch (e) {
      this.session.messages.pop(); // error hygiene: never leave a poisoned turn
      this.session.save(this.context.workspaceState);
      this.post({ type: 'history', messages: this.session.messages });
      this.post({ type: 'restoreInput', text });
      this.banner(String(e instanceof Error ? e.message : e));
    } finally {
      this.generating = null;
    }
  }
}
```

- [ ] **Step 2: Write the webview HTML** (`packages/extension/media/chat.html`)

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src {cspSource} 'unsafe-inline'; script-src {cspSource};" />
  <link rel="stylesheet" href="chat.css" />
</head>
<body>
  <div id="banner" hidden><span id="banner-text"></span><button id="banner-close">×</button></div>

  <section id="gallery">
    <div class="seg"><button id="seg-local" class="on">Local</button><button id="seg-or">OpenRouter</button></div>
    <div id="req-local" class="callout">🖥 Runs on this Mac — nothing leaves your machine. Needs RAM + a one-time download.</div>
    <div id="req-or" class="warn" hidden>☁️ Cloud — leaves your machine. Prompts &amp; code go to OpenRouter and pinned <b>US inference providers only, no fallback</b>. Less private than Local.</div>
    <div id="or-key" hidden><input id="or-key-input" type="password" placeholder="OpenRouter API key (stored in your OS keychain)" /><button id="or-key-save">Save</button></div>
    <div id="models"></div>
    <div id="add-row"><input id="add-slug" placeholder="Add an OpenRouter model (e.g. openai/gpt-4o)" /><button id="add-btn">＋ Add</button></div>
    <div id="add-blocked" hidden></div>
    <div id="setup" hidden></div>
  </section>

  <header id="chat-head" hidden>
    <span id="active-model"></span>
    <label><input type="checkbox" id="agent-toggle" /> Agent</label>
    <button id="new-chat">New chat</button>
  </header>
  <main id="messages"></main>
  <div id="steps" hidden></div>
  <footer id="composer" hidden>
    <textarea id="input" rows="2" placeholder="Ask your model…"></textarea>
    <button id="send">Send</button>
    <button id="cancel" hidden>Stop</button>
  </footer>
  <script src="chat.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write the webview CSS** (`packages/extension/media/chat.css`)

```css
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); display: flex; flex-direction: column; height: 100vh; margin: 0; font-size: 13px; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; }
input, textarea { background: var(--vscode-input-background); color: inherit; border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 5px 7px; }
#banner { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); padding: 6px; display: flex; justify-content: space-between; white-space: pre-wrap; }
#gallery { padding: 8px; overflow-y: auto; }
.seg { display: flex; gap: 4px; background: var(--vscode-editorWidget-background); border-radius: 6px; padding: 3px; margin-bottom: 8px; }
.seg button { flex: 1; background: transparent; color: inherit; }
.seg button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.callout { background: var(--vscode-editorWidget-background); border-left: 3px solid var(--vscode-focusBorder); padding: 7px; border-radius: 4px; font-size: 11.5px; margin-bottom: 8px; }
.warn { background: rgba(210,160,60,.12); border-left: 3px solid #d6a85b; padding: 7px; border-radius: 4px; font-size: 11.5px; margin-bottom: 8px; }
#or-key { display: flex; gap: 4px; margin-bottom: 8px; } #or-key-input { flex: 1; }
.mcard { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, #333); border-radius: 6px; padding: 7px 8px; margin-bottom: 6px; cursor: pointer; }
.mcard.sel { border-color: var(--vscode-focusBorder); }
.mrow { display: flex; justify-content: space-between; align-items: center; }
.mname { font-weight: 600; }
.badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.b { font-size: 9.5px; padding: 1.5px 5px; border-radius: 10px; border: 1px solid; }
.b-us { color: #4ec98a; border-color: #2e6b4c; } .b-host { color: #5bb8d6; border-color: #2e5a6b; }
.b-agent { color: #d6a85b; border-color: #6b552e; } .b-ram { color: var(--vscode-descriptionForeground); border-color: #555; }
#add-row { display: flex; gap: 4px; margin-top: 4px; } #add-slug { flex: 1; }
#add-blocked { background: rgba(210,90,90,.12); border: 1px solid #6b2e2e; border-radius: 6px; padding: 8px; margin-top: 6px; font-size: 11.5px; }
#add-blocked .b { color: #e07a7a; border-color: #6b2e2e; }
#setup { background: var(--vscode-editorWidget-background); border-radius: 6px; padding: 10px; margin-top: 8px; }
header { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-top: 1px solid var(--vscode-widget-border,#333); }
#active-model { flex: 1; font-size: 11.5px; }
main { flex: 1; overflow-y: auto; padding: 0 8px; }
.msg { margin: 6px 0; padding: 8px; border-radius: 6px; }
.msg pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; }
.msg.user { background: var(--vscode-input-background); } .msg.assistant { background: var(--vscode-editorWidget-background); }
#steps { font-size: 11px; opacity: .8; padding: 4px 8px; }
footer { display: flex; gap: 6px; padding: 8px; } #input { flex: 1; resize: none; }
```

- [ ] **Step 4: Write the webview JS** (`packages/extension/media/chat.js`)

```js
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let streaming = '';
let provider = 'local';
let policy = { local: [], openrouter: [] };
let selectedId = null;

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function badges(m, status) {
  const out = [`<span class="b b-us">🇺🇸 US · ${esc(m.origin.org)}</span>`];
  out.push(m.provider === 'local' ? `<span class="b b-host">on-device</span>` : `<span class="b b-host">US providers pinned</span>`);
  if (m.agentCapable) out.push(`<span class="b b-agent">agent</span>`);
  if (m.provider === 'local') {
    const dl = status && status.downloadedModelIds.includes(m.local.catalogId);
    out.push(`<span class="b b-ram">${dl ? 'ready' : 'download'}</span>`);
  } else out.push(`<span class="b b-ram">cloud</span>`);
  return out.join('');
}

function renderModels(status) {
  const list = provider === 'local' ? policy.local : policy.openrouter;
  $('models').innerHTML = list.map((m) => `
    <div class="mcard ${m.id === selectedId ? 'sel' : ''}" data-id="${m.id}">
      <div class="mrow"><span class="mname">${esc(m.displayName)}</span>${m.id === selectedId ? '<span style="color:#4ec98a">✓</span>' : ''}</div>
      <div class="badges">${badges(m, status)}</div>
    </div>`).join('');
  document.querySelectorAll('.mcard').forEach((el) => el.onclick = () => vscode.postMessage({ type: 'selectModel', id: el.dataset.id }));
}

function renderState(status) {
  window.__status = status;
  renderModels(status);
  const setup = $('setup');
  if (provider === 'local' && !status.binaryInstalled) {
    setup.hidden = false;
    const gb = Math.round(status.ram.totalBytes / 2 ** 30);
    setup.innerHTML = `<b>Welcome to Fortress Code</b><p>This Mac has ${gb} GB RAM. One click installs the local engine.</p><button id="do-setup">Set up local engine</button>`;
    $('do-setup').onclick = () => vscode.postMessage({ type: 'installBinary' });
  } else if (status.download) {
    setup.hidden = false;
    const pct = Math.round((status.download.receivedBytes / status.download.totalBytes) * 100);
    setup.innerHTML = `<p>Downloading… ${pct}%</p><progress max="100" value="${pct}"></progress>`;
  } else if (status.state === 'loading-model' || status.state === 'starting') {
    setup.hidden = false; setup.innerHTML = `<p>Loading model…</p>`;
  } else setup.hidden = true;

  const ready = provider === 'openrouter' ? !!selectedId : (status.state === 'ready' && !!selectedId);
  $('chat-head').hidden = !selectedId; $('composer').hidden = !selectedId;
  $('send').disabled = !ready;
  if (selectedId) {
    const m = [...policy.local, ...policy.openrouter].find((x) => x.id === selectedId);
    $('active-model').textContent = (provider === 'openrouter' ? '☁️ ' : '🖥 ') + (m ? m.displayName : '');
    const agentEl = $('agent-toggle');
    agentEl.disabled = !m || !m.agentCapable;
    if (agentEl.disabled) agentEl.checked = false;
  }
}

function setProvider(p) {
  provider = p; selectedId = null;
  $('seg-local').classList.toggle('on', p === 'local');
  $('seg-or').classList.toggle('on', p === 'openrouter');
  $('req-local').hidden = p !== 'local';
  $('req-or').hidden = p !== 'openrouter';
  $('or-key').hidden = p !== 'openrouter' || window.__orKeySet;
  $('add-row').hidden = p !== 'openrouter';
  $('add-blocked').hidden = true;
  if (window.__status) renderState(window.__status);
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'policy') { policy = { local: m.local, openrouter: m.openrouter }; if (window.__status) renderState(window.__status); }
  if (m.type === 'openRouterKeySet') { window.__orKeySet = m.set; $('or-key').hidden = provider !== 'openrouter' || m.set; }
  if (m.type === 'state') { selectedId = m.selectedId; renderState(m.status); }
  if (m.type === 'history') renderHistory(m.messages);
  if (m.type === 'startRejected') renderRejection(m.rejection, m.modelId);
  if (m.type === 'addBlocked') { $('add-blocked').hidden = false; $('add-blocked').innerHTML = `<b style="color:#e07a7a">⛔ Blocked by policy</b><p>${esc(m.reason)}</p><span class="b">✗ non-US</span><p style="margin-top:6px">Approved US models are listed above, or request an addition.</p>`; }
  if (m.type === 'addAccepted') { $('add-blocked').hidden = false; $('add-blocked').innerHTML = `<p>${esc(m.slug)} is already on the approved list — select it above.</p>`; }
  if (m.type === 'restoreInput') $('input').value = m.text;
  if (m.type === 'error') { $('banner-text').textContent = m.message; $('banner').hidden = false; }
  if (m.type === 'token') appendToken(m.text);
  if (m.type === 'agentStep') { $('steps').hidden = false; $('steps').innerHTML += `<div>${esc(m.step)}</div>`; }
});

function renderHistory(messages) {
  streaming = '';
  $('messages').innerHTML = messages
    .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
    .map((m) => `<div class="msg ${m.role}"><pre>${esc(m.content)}</pre></div>`).join('');
  $('messages').scrollTop = $('messages').scrollHeight;
}
function appendToken(t) {
  streaming += t;
  let el = document.querySelector('.msg.streaming pre');
  if (!el) { const d = document.createElement('div'); d.className = 'msg assistant streaming'; d.innerHTML = '<pre></pre>'; $('messages').appendChild(d); el = d.querySelector('pre'); }
  el.textContent = streaming; $('messages').scrollTop = $('messages').scrollHeight;
}
function renderRejection(r, modelId) {
  const need = Math.round(r.requiredBytes / 2 ** 30), have = Math.round(r.availableBytes / 2 ** 30);
  const rows = r.foreign.map((p) => `<li>${esc(p.command.slice(0, 70))} — ${Math.round(p.rssBytes / 2 ** 30)} GB (pid ${p.pid})</li>`).join('');
  $('setup').hidden = false;
  $('setup').innerHTML = `<b>Not enough memory</b><p>Needs ~${need} GB but ${have} GB is available.</p>${r.foreign.length ? `<ul>${rows}</ul>` : ''}${r.wouldFitAfterForeignKill ? `<button id="kill-foreign">Stop those and continue</button>` : `<p>Even stopping those won't free enough — try a smaller model.</p>`}`;
  const btn = $('kill-foreign');
  if (btn) btn.onclick = () => { vscode.postMessage({ type: 'killForeign', pids: r.foreign.map((p) => p.pid) }); setTimeout(() => vscode.postMessage({ type: 'selectModel', id: modelId }), 1500); };
}

$('seg-local').onclick = () => setProvider('local');
$('seg-or').onclick = () => setProvider('openrouter');
$('or-key-save').onclick = () => { const k = $('or-key-input').value.trim(); if (k) vscode.postMessage({ type: 'setOpenRouterKey', key: k }); };
$('add-btn').onclick = () => { const s = $('add-slug').value.trim(); if (s) vscode.postMessage({ type: 'addModel', slug: s }); };
$('send').onclick = () => { const t = $('input').value.trim(); if (!t) return; $('input').value = ''; $('banner').hidden = true; $('steps').innerHTML = ''; $('steps').hidden = true; vscode.postMessage({ type: 'send', text: t }); $('cancel').hidden = false; };
$('cancel').onclick = () => { vscode.postMessage({ type: 'cancel' }); $('cancel').hidden = true; };
$('new-chat').onclick = () => vscode.postMessage({ type: 'newChat' });
$('agent-toggle').onchange = (e) => vscode.postMessage({ type: 'agentToggle', on: e.target.checked });
$('banner-close').onclick = () => { $('banner').hidden = true; };
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('send').click(); } });
```

- [ ] **Step 5: Build**

Run: `npm run build -w @fortress-code/shared && npm run build -w fortress-code`
Expected: esbuild produces both bundles; `tsc --noEmit` clean.

- [ ] **Step 6: Manual smoke test (Extension Development Host)**

Open `packages/extension` in VS Code, press F5, open the Fortress Code view. Verify:
- **Local tab:** setup screen appears if the engine isn't installed; model cards show 🇺🇸 US badges + on-device + agent + ready/download; selecting a downloaded model that fits starts it and enables Send.
- **OpenRouter tab:** the amber "leaves your machine" banner shows; an API-key field appears until a key is saved; approved US models list with "US providers pinned"; **pasting `deepseek/deepseek-chat` into Add → a Blocked-by-policy card with the China reason**; sending with no model shows a banner and restores the input (never into history).
- Governance: no non-US model is ever selectable or addable.

- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/chat/ChatViewProvider.ts packages/extension/media/chat.html packages/extension/media/chat.css packages/extension/media/chat.js
git commit -m "feat(extension): governed-gallery chat webview with provider toggle, badges, and blocked add-model

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 19: CI + packaging + README + lockfile + root build

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`
- Modify: root `package.json` (extend the build chain to include the extension), commit `package-lock.json` and the `.gitignore` `.superpowers/` entry.

**Interfaces:**
- Consumes: root `npm run build` / `npm test`, extension `npm run package`.
- Produces: green CI on push; `.vsix` on tags.

- [ ] **Step 1: Extend the root build to include the extension**

In root `package.json`, change the `build` script (currently `npm run build -w @fortress-code/shared && npm run build -w @fortress-code/manager`) to:

```json
"build": "npm run build -w @fortress-code/shared && npm run build -w @fortress-code/manager && npm run build -w fortress-code"
```

- [ ] **Step 2: Commit lockfile + gitignore hygiene**

The root `package-lock.json` is currently untracked and the `.gitignore` `.superpowers/` line is unstaged. CI's `npm ci` requires a committed, in-sync lockfile.

```bash
git add .gitignore package-lock.json
git commit -m "chore: commit lockfile and ignore .superpowers scratch (CI needs npm ci)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Write the CI workflow** (`.github/workflows/ci.yml`)

```yaml
name: ci
on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:

jobs:
  test:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: npm test

  package:
    needs: test
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: macos-14
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: npm run package -w fortress-code
      - uses: softprops/action-gh-release@v2
        with: { files: fortress-code.vsix }
```

- [ ] **Step 4: Write README.md**

```markdown
# Fortress Code

Local + US-governed AI chat and coding agent for VS Code. Run models fully on
your machine via llama.cpp, or use approved US models through OpenRouter — with
a governance policy that blocks any non-US model.

## Providers

- **Local (private):** Google Gemma 3 and OpenAI gpt-oss via llama.cpp. Nothing
  leaves your machine. A memory guard refuses to load a model that won't fit.
- **OpenRouter (cloud):** a curated set of **US-origin** models, pinned to **US
  inference providers with no fallback** (`data_collection: deny`). Prompts
  transit OpenRouter (a US company) — less private than Local; the UI says so.

## Governance

Only US-origin, US-hosted models are selectable or addable. Enforcement is a
curated allow-list maintained in the app (OpenRouter exposes no reliable
origin/country signal, so this cannot be auto-detected). Pasting a non-US model
is blocked with a plain-language reason. See
`docs/superpowers/specs/2026-07-03-governance-openrouter-design.md`.

## Install

Download `fortress-code.vsix` from the latest Release → VS Code Extensions →
Install from VSIX. Requirements: Apple Silicon Mac, macOS 13+, VS Code 1.90+.

## Development

    npm install
    npm run build
    npm test
```

- [ ] **Step 5: Build + package locally to verify**

Run: `npm run build && npm run package -w fortress-code`
Expected: `npm run build` clean across all three packages; `fortress-code.vsix` created at repo root.

- [ ] **Step 6: Commit**

```bash
git add package.json .github/workflows/ci.yml README.md
git commit -m "chore: CI (test + vsix release), README with governance docs, root build includes extension

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

**Note:** Creating the public GitHub repo and pushing (`gh repo create`) is an outward-facing action — leave it to the human/controller; do NOT run it from a subagent.

---

### Task 20: Manual UAT (human-required)

**Files:** none (verification task; fixes become normal TDD fixes in the owning package).

- [ ] **Step 1: Local path (base success criteria)** — fresh install, ≤3 clicks to chatting with a local model; memory-pressure rejection shows foreign processes and "stop these and continue"; crash resilience (kill the managed llama-server mid-stream → banner + intact history).

- [ ] **Step 2: Governance** — non-US model can never be selected or added; pasting `deepseek/deepseek-chat` (and `qwen/…`, `mistralai/…`) is blocked with the correct reason; only approved US models render.

- [ ] **Step 3: OpenRouter** — enable OpenRouter shows the persistent privacy notice + key prompt; key persists across reloads (SecretStorage) and never appears on disk; a US OpenRouter model streams a reply; capture one request and confirm the body carries `provider:{only:[…US…],allow_fallbacks:false,data_collection:"deny"}`.

- [ ] **Step 4: Agent across providers** — agent mode with a local tool-capable model AND an OpenRouter tool-capable model each perform a two-file edit with diff approval; Reject leaves files untouched.

- [ ] **Step 5: Record + release** — append a `## UAT <date>` section to the design-delta spec with pass/fail per item; fix failures (TDD in the owning package) and re-run; then the human creates the repo, pushes, and tags `v0.1.0` so CI attaches the vsix.

---

## Self-Review Notes

- **Spec coverage:** governance registry + guard (T13); provider abstraction + local (T14); OpenRouter fail-closed pinning + SecretStorage key (T15); agent tools (T16) + provider-generalized loop (T17); governed-gallery UI with provider toggle, badges, persistent OpenRouter notice, blocked add-model, first-run setup (T18); CI/packaging/README + lockfile + root-build (T19); all success criteria incl. governance + cross-provider agent (T20).
- **Type consistency:** `PolicyEntry`/`Origin`/`Hosting`/`Provider` defined once in `governance.ts` (T13), imported everywhere; `ResolvedTarget`/`resolveTarget`/`TargetDeps` defined in `target.ts` (T14), extended in T15, consumed by `streamChat` (T14), `completeOnce`/`runAgentTurn` (T17), and `ChatViewProvider` (T18); `Session` (T14) used by loop (T17) and view (T18); `TOOL_SCHEMAS`/`executeTool` (T16) used by loop (T17).
- **Deliberate deviations from the base v1 plan:** the original Tasks 13–15 (webview/tools/loop) are superseded by T14–T18 here, built governance-first; `session.ts`/`stream.ts` moved under the provider abstraction. Manager daemon (Tasks 4–11) untouched.
- **Honest limit (carried from the spec §2.1):** governance is a curated allow-list, not runtime origin detection; the README and UI state the residual OpenRouter trust explicitly.
```
