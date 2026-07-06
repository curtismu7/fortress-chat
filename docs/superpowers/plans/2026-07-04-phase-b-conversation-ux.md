# Phase B — Conversation Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use `- [ ]` tracking.

**Goal:** Fold reasoning-model "thinking", support multiple chats, regenerate / edit-and-resend, and show token size + usage.

**Architecture:** Extension-only. Pure modules `reasoning.ts` (`splitThink`) and `tokens.ts` (`estimateTokens`) are unit-tested; `sessionStore.ts` manages many `Session`s in `workspaceState`; `stream.ts`/`loop.ts` capture a reasoning channel + `usage`; `ChatViewProvider` + `media/chat.*` wire it up.

**Tech Stack:** TypeScript, VS Code API, framework-free webview, vitest. No new deps.

## Global Constraints

- Work from `/Users/cmuir/Development/curtis-llama/fortress-chat`, branch `main`. Stage explicitly. Trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Reasoning is **never persisted** — saved answer content is `splitThink(full).content`.
- No new runtime deps; no daemon/`shared` change. TDD for pure modules + stream; manual for webview.
- Provider/dev/governance routing and Phase A context stay unchanged in behavior.

## File Structure

```text
packages/extension/src/
├── reasoning.ts     # NEW splitThink
├── tokens.ts        # NEW estimateTokens, estimateMessagesTokens
├── sessionStore.ts  # NEW multi-chat over Session
├── providers/stream.ts  # onReasoning + return {content,reasoning,usage}
├── agent/loop.ts        # completeOnce returns usage (content/toolCalls unchanged)
├── chat/ChatViewProvider.ts  # store, reasoning routing, regenerate, editResend, usage, meter data, chat list
└── test/{reasoning,tokens,sessionStore,streamReasoning}.test.ts
packages/extension/media/chat.html|css|js  # reasoning <details>, chat switcher, per-msg buttons, meter
```

---

### Task 1: `reasoning.ts` + `tokens.ts` (pure, TDD)

**Files:** Create `src/reasoning.ts`, `src/tokens.ts`, `src/test/reasoning.test.ts`, `src/test/tokens.test.ts`

- [ ] **Step 1: failing tests**

`src/test/reasoning.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { splitThink } from '../reasoning';
describe('splitThink', () => {
  it('extracts and strips a think block', () => {
    expect(splitThink('<think>hmm</think>Answer')).toEqual({ content: 'Answer', reasoning: 'hmm' });
  });
  it('joins multiple think blocks and trims content', () => {
    const r = splitThink('<think>a</think>X<think>b</think>Y');
    expect(r.content).toBe('XY');
    expect(r.reasoning).toBe('a\nb');
  });
  it('treats an unclosed think tail as reasoning', () => {
    expect(splitThink('done<think>still thinking')).toEqual({ content: 'done', reasoning: 'still thinking' });
  });
  it('passes plain content through', () => {
    expect(splitThink('just text')).toEqual({ content: 'just text', reasoning: '' });
  });
});
```
`src/test/tokens.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateMessagesTokens } from '../tokens';
describe('tokens', () => {
  it('estimates ~len/4', () => { expect(estimateTokens('abcd')).toBe(1); expect(estimateTokens('a'.repeat(10))).toBe(3); });
  it('sums messages with overhead', () => {
    expect(estimateMessagesTokens([{ content: 'abcd' }, { content: 'abcd' }])).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: run → FAIL** (`npm test -w fortress-chat`)

- [ ] **Step 3: implement**

`src/reasoning.ts`:
```ts
export function splitThink(text: string): { content: string; reasoning: string } {
  const reasoning: string[] = [];
  let content = String(text).replace(/<think>([\s\S]*?)<\/think>/g, (_m, r) => { reasoning.push(r); return ''; });
  const open = content.indexOf('<think>');
  if (open >= 0) { reasoning.push(content.slice(open + 7)); content = content.slice(0, open); }
  return { content: content.trim(), reasoning: reasoning.join('\n').trim() };
}
```
`src/tokens.ts`:
```ts
export function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}
export function estimateMessagesTokens(messages: { content: string }[]): number {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
}
```

- [ ] **Step 4: run → PASS**; **Step 5: commit** (`git add src/reasoning.ts src/tokens.ts src/test/reasoning.test.ts src/test/tokens.test.ts` → `feat(extension): reasoning splitter + token estimator`)

---

### Task 2: `sessionStore.ts` (multi-chat, TDD)

**Files:** Create `src/sessionStore.ts`, `src/test/sessionStore.test.ts`

**Interfaces:** Consumes `Session` (`./chat/session`), `ChatMessage`, `validateHistory` (shared).
Produces:
```ts
interface ChatMeta { id: string; title: string }
class SessionStore {
  activeId: string;
  metas(): ChatMeta[];
  active(): Session;
  newChat(): void;
  switchTo(id: string): void;
  touchTitle(): void;
  save(): void;
  static load(state: MementoLike): SessionStore;
}
```
`MementoLike = { get(k): unknown; update(k, v): Thenable<void>|void }`. Persist key `fortressChat.chats` = `{ activeId, metas, messagesById }`. Migration: if absent but legacy `fortressChat.session` messages exist, seed one chat from them. IDs come from an injected counter (avoid `Date.now()` for testability): use `crypto.randomUUID()` at runtime.

- [ ] **Step 1: failing test** (`src/test/sessionStore.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { SessionStore } from '../sessionStore';

function mem(init: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(init));
  return { get: (k: string) => m.get(k), update: (k: string, v: unknown) => { m.set(k, v); return Promise.resolve(); }, _m: m } as any;
}

describe('SessionStore', () => {
  it('starts with one empty chat', () => {
    const s = SessionStore.load(mem());
    expect(s.metas()).toHaveLength(1);
    expect(s.active().messages).toEqual([]);
  });
  it('newChat adds and switches without losing the old', () => {
    const s = SessionStore.load(mem());
    s.active().addUser('first'); s.touchTitle(); s.save();
    const firstId = s.activeId;
    s.newChat();
    expect(s.metas()).toHaveLength(2);
    expect(s.active().messages).toEqual([]);
    s.switchTo(firstId);
    expect(s.active().messages[0].content).toBe('first');
  });
  it('titles from the first user message', () => {
    const s = SessionStore.load(mem());
    s.active().addUser('explain my code please'); s.touchTitle();
    expect(s.metas()[0].title).toContain('explain');
  });
  it('persists and reloads', () => {
    const store = mem();
    const s = SessionStore.load(store);
    s.active().addUser('persisted'); s.touchTitle(); s.save();
    expect(SessionStore.load(store).active().messages[0].content).toBe('persisted');
  });
  it('migrates a legacy single session', () => {
    const store = mem({ 'fortressChat.session': [{ role: 'user', content: 'legacy' }] });
    const s = SessionStore.load(store);
    expect(s.active().messages[0].content).toBe('legacy');
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement** (`src/sessionStore.ts`)

```ts
import { randomUUID } from 'node:crypto';
import { validateHistory, type ChatMessage } from '@fortress-chat/shared';
import { Session } from './chat/session';

export interface ChatMeta { id: string; title: string }
interface MementoLike { get(key: string): unknown; update(key: string, value: unknown): Thenable<void> | void }
const KEY = 'fortressChat.chats';
const LEGACY = 'fortressChat.session';

export class SessionStore {
  activeId: string;
  private order: string[];                 // ids, newest first
  private titles: Map<string, string>;
  private sessions: Map<string, Session>;

  private constructor(private state: MementoLike, activeId: string, order: string[], titles: Map<string, string>, sessions: Map<string, Session>) {
    this.activeId = activeId; this.order = order; this.titles = titles; this.sessions = sessions;
  }

  metas(): ChatMeta[] { return this.order.map((id) => ({ id, title: this.titles.get(id) || 'New chat' })); }
  active(): Session { return this.sessions.get(this.activeId)!; }

  newChat(): void {
    const id = randomUUID();
    this.order.unshift(id); this.titles.set(id, 'New chat'); this.sessions.set(id, new Session());
    this.activeId = id; this.save();
  }
  switchTo(id: string): void { if (this.sessions.has(id)) { this.activeId = id; this.save(); } }
  touchTitle(): void {
    const first = this.active().messages.find((m) => m.role === 'user');
    if (first && (this.titles.get(this.activeId) || 'New chat') === 'New chat') {
      this.titles.set(this.activeId, first.content.slice(0, 40));
    }
  }
  save(): void {
    const messagesById: Record<string, ChatMessage[]> = {};
    for (const [id, s] of this.sessions) messagesById[id] = s.messages;
    void this.state.update(KEY, { activeId: this.activeId, metas: this.metas(), messagesById });
  }

  static load(state: MementoLike): SessionStore {
    const raw = state.get(KEY) as { activeId: string; metas: ChatMeta[]; messagesById: Record<string, ChatMessage[]> } | undefined;
    if (raw && raw.metas?.length) {
      const order = raw.metas.map((m) => m.id);
      const titles = new Map(raw.metas.map((m) => [m.id, m.title] as const));
      const sessions = new Map<string, Session>();
      for (const id of order) {
        const s = new Session();
        try { s.messages = validateHistory(raw.messagesById[id] ?? []); } catch { s.messages = []; }
        sessions.set(id, s);
      }
      const activeId = sessions.has(raw.activeId) ? raw.activeId : order[0];
      return new SessionStore(state, activeId, order, titles, sessions);
    }
    // fresh or legacy migration
    const legacy = state.get(LEGACY);
    const s = new Session();
    try { if (legacy) s.messages = validateHistory(legacy); } catch { s.messages = []; }
    const id = randomUUID();
    const store = new SessionStore(state, id, [id], new Map([[id, 'New chat']]), new Map([[id, s]]));
    store.touchTitle();
    store.save();
    return store;
  }
}
```

- [ ] **Step 4: run → PASS**; **Step 5: commit** (`git add src/sessionStore.ts src/test/sessionStore.test.ts` → `feat(extension): multi-chat SessionStore with persistence + legacy migration`)

---

### Task 3: reasoning + usage capture in `stream.ts` / `loop.ts` (TDD)

**Files:** Modify `src/providers/stream.ts`, `src/agent/loop.ts`; add `src/test/streamReasoning.test.ts`

**Interfaces:** `streamChat(target, messages, onToken, signal, onReasoning?): Promise<{ content: string; reasoning: string; usage: Usage | null }>` where `interface Usage { promptTokens: number; completionTokens: number }`. `completeOnce` returns `{ content, toolCalls, usage }`.

- [ ] **Step 1: failing test** (`src/test/streamReasoning.test.ts`)

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { streamChat } from '../providers/stream';
import type { ResolvedTarget } from '../providers/target';

let server: Server; let target: ResolvedTarget;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"!"}}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n');
    res.write('data: [DONE]\n\n'); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  target = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, headers: {}, bodyExtra: {} };
});
afterAll(() => server.close());

describe('streamChat reasoning + usage', () => {
  it('separates reasoning from content and captures usage', async () => {
    const content: string[] = []; const reason: string[] = [];
    const r = await streamChat(target, [{ role: 'user', content: 'hi' }], (t) => content.push(t), new AbortController().signal, (t) => reason.push(t));
    expect(r.content).toBe('Hi!');
    expect(r.reasoning).toBe('thinking');
    expect(r.usage).toEqual({ promptTokens: 11, completionTokens: 2 });
    expect(content.join('')).toBe('Hi!');
    expect(reason.join('')).toBe('thinking');
  });
});
```

- [ ] **Step 2: run → FAIL**

- [ ] **Step 3: implement** — in `stream.ts`, change the signature and the delta loop:
  - Add param `onReasoning?: (t: string) => void`; accumulate `let content = ''`, `let reasoning = ''`, `let usage: {promptTokens:number;completionTokens:number}|null = null`; body adds `stream_options: { include_usage: true }`.
  - Per event JSON `j`: `const d = j.choices?.[0]?.delta ?? {}`; if `d.content` → `content += d.content; onToken(d.content)` + reset watchdog; if `d.reasoning ?? d.reasoning_content` → `reasoning += that; onReasoning?.(that)` + reset watchdog; if `j.usage` → `usage = { promptTokens: j.usage.prompt_tokens ?? 0, completionTokens: j.usage.completion_tokens ?? 0 }`.
  - Return `{ content, reasoning, usage }`.
  - In `agent/loop.ts` `completeOnce`: after `const msg = json.choices?.[0]?.message`, also read `json.usage` and return `{ content, toolCalls, usage }`; `runAgentTurn` ignores usage (agent turns can sum later — out of scope). Update `runAgentTurn`'s destructure to `const { content, toolCalls } = await complete(...)`.

- [ ] **Step 4: run → PASS** (plus existing stream/loop tests — update the old `streamChat` assertions: callers of `streamChat` now get an object; the existing `stream.test.ts` expects a string `full` — update those two assertions to `(await streamChat(...)).content`).

- [ ] **Step 5: commit** (`feat(extension): capture reasoning channel + token usage from the stream`)

---

### Task 4: `ChatViewProvider` wiring (store, reasoning, regenerate, edit-resend, usage, meter, chat list)

**Files:** Modify `src/chat/ChatViewProvider.ts`

- [ ] Replace `private session: Session` with `private store: SessionStore` (import `SessionStore`, `splitThink`, `estimateMessagesTokens`); constructor `this.store = SessionStore.load(context.workspaceState)`. Replace every `this.session` with `this.store.active()`.
- [ ] Add `private postChats()` → `this.post({ type: 'chats', metas: this.store.metas(), activeId: this.store.activeId })`; call it in `init` and after send/new/switch.
- [ ] `handleSend`: pass `onReasoning` to `streamChat`, post `{type:'reasoning', text}` live; after: `const { content, reasoning, usage } = await streamChat(...)`; `this.store.active().addAssistant(splitThink(content).content)`; `this.store.touchTitle(); this.store.save(); this.postChats();` and `this.post({ type:'usage', usage })`; post `{type:'reasoningDone'}` so the webview collapses. (Agent path unchanged except `.active()`.)
- [ ] Add context-window to `state`: in `pushStatus`, include `contextWindow` — for a selected local model use 8192; for OpenRouter/dev use the entry's `contextLength` if known else 8192. Simplest: post `{type:'contextWindow', tokens: <n>}` from `selectModel`/`selectDevModel`.
- [ ] `onMessage` new cases: `newChat` → `this.store.newChat(); this.post history + postChats()`; `switchChat` → `this.store.switchTo(id); post history + postChats()`; `regenerate` → drop last assistant of active, re-run last user turn via `handleSend(lastUserText)` (guard: find last user message); `editResend` → truncate active `messages` to `index`, `handleSend(text)`.
- [ ] Manual: build + test; verify no type errors.
- [ ] Commit (`feat(extension): wire multi-chat store, reasoning fold, regenerate, edit-resend, usage`)

---

### Task 5: webview (`media/chat.*`)

**Files:** Modify `media/chat.html|css|js`

- [ ] Header: a `<select id="chat-picker">` before New chat; on change post `{type:'switchChat', id}`. Handler for `{type:'chats'}` fills options + selects activeId.
- [ ] Reasoning: assistant render wraps optional `<details class="reasoning" open><summary>▸ Reasoning</summary><pre>…</pre></details>` above the answer. Live `{type:'reasoning', text}` appends into a streaming reasoning box; `{type:'reasoningDone'}` sets it closed. `renderMarkdown` runs `splitThink`-equivalent client-side is unnecessary (host already stripped persisted `<think>`); but for LIVE inline `<think>` route via the reasoning box (host sends reasoning separately, so inline think in content is rare — leave content as-is).
- [ ] Per-message affordances: under each assistant reply a footer `<button class="regen">↻ Regenerate</button><span class="usage"></span>`; each user message gets a `<button class="editmsg">✎</button>`. Delegated clicks: regen → `{type:'regenerate'}`; editmsg → put that message's text into `#input` and post `{type:'editResend', index}` on next send (simplest: on ✎ click, set input value + post `{type:'editResend', index}` is deferred — instead: ✎ loads text into input and stores a pending edit index; the send handler includes it). Keep simple: ✎ → `vscode.postMessage({type:'editResend', index})` after loading text is host-driven; host truncates and the user re-types. Implement: ✎ posts `{type:'editLoad', index}`; host replies `{type:'restoreInput', text}` and truncates to index; user edits + sends normally.
- [ ] Usage: `{type:'usage'}` → set the last reply's `.usage` text to `↑p ↓c tokens`; keep a running total in the header.
- [ ] Meter: `#meter` near input shows `~{est}k / {window}k`; recompute on input keyup using a tiny local `Math.ceil(len/4)` over input + rough history; amber past 90%. Host posts `{type:'contextWindow', tokens}`.
- [ ] Manual smoke (build); commit (`feat(extension): reasoning fold UI, chat switcher, regenerate/edit, token meter`)

---

## Self-Review Notes
- **Spec coverage:** splitThink+tokens (T1); multi-chat store+migration (T2); reasoning+usage stream capture (T3); provider wiring incl. regenerate/edit-resend/usage/context-window (T4); reasoning `<details>`, switcher, per-msg buttons, meter (T5).
- **Type consistency:** `streamChat` now returns `{content,reasoning,usage}` — all callers (ChatViewProvider, stream.test) updated (T3/T4); `SessionStore.active()` returns a `Session` so existing `.addUser/.addAssistant/.toRequestMessages/.messages` calls are unchanged.
- **Reasoning not persisted:** saved content = `splitThink(content).content`; `reasoning_content` never enters `session.messages`.
