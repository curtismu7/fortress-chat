# Fortress Code — Phase B: Conversation Quality (design)

**Status:** Approved (brainstorming session with Curtis, 2026-07-04)
**Part of:** the coding-UX roadmap (Phase B of A→B→C→D). Builds on Phase A (editor context + code rendering).

## 1. Goal

Make the chat feel like a real assistant: fold reasoning-model "thinking", keep multiple chats, regenerate / edit-and-resend, and show token size + usage.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Reasoning detection | **Both** — inline `<think>…</think>` AND the streaming `reasoning`/`reasoning_content` delta field. Folded into a collapsible section; **never persisted**. |
| Cost | **Token usage only** — API `usage` per reply + running total; live context-size meter vs model window. No dollar figures. |
| Multiple chats | **Full switcher** — named chats in `workspaceState`, dropdown to switch, New chat starts fresh. |

## 3. Architecture (extension-only)

### 3.1 `reasoning.ts` (pure, tested)
`splitThink(text: string): { content: string; reasoning: string }` — removes `<think>…</think>` blocks from `content` and returns them joined as `reasoning`. Unclosed `<think>` at end (mid-stream) → everything after the tag is reasoning.

### 3.2 `tokens.ts` (pure, tested)
`estimateTokens(text: string): number` = `Math.ceil(len/4)`. `estimateMessagesTokens(messages: {content:string}[]): number` sums content + a small per-message overhead.

### 3.3 `stream.ts` / `loop.ts` — reasoning + usage capture
`streamChat` gains an optional `onReasoning?: (t: string) => void` and returns `{ content, reasoning, usage }` instead of a bare string (callers updated). It reads `delta.reasoning ?? delta.reasoning_content` into the reasoning channel, `delta.content` into content, and captures the final `usage` object (request `stream_options: { include_usage: true }`). `completeOnce` similarly returns `usage`. Inline `<think>` is split by the webview at render time (content stream may interleave), but the persisted content is `splitThink(full).content`.

### 3.4 `sessionStore.ts` — multiple chats (tested)
Wraps the existing `Session` per chat:
```ts
interface ChatMeta { id: string; title: string }
class SessionStore {
  activeId: string;
  metas(): ChatMeta[];                 // ordered, newest first
  active(): Session;                   // the live Session for activeId
  newChat(): void;                     // create + switch to a fresh chat
  switchTo(id: string): void;
  touchTitle(): void;                  // set active title from its first user message if untitled
  save(): void;
  static load(state: vscode.Memento): SessionStore;   // restores metas + per-chat messages + activeId
}
```
Persisted in `workspaceState`: `{ activeId, metas: ChatMeta[], messagesById: Record<string, ChatMessage[]> }`. Migration: an existing single `Session` (`fortressCode.session` key) becomes the first chat on first load.

### 3.5 `ChatViewProvider` wiring
- Replace the single `this.session` with `this.store: SessionStore`; `this.store.active()` is used everywhere `this.session` was. On send, after the assistant reply, call `store.touchTitle()` and `store.save()`; post the chat list (`{type:'chats', metas, activeId}`).
- **Reasoning:** pass an `onReasoning` to `streamChat`; post `{type:'reasoning', text}` (live) and, on done, the reply is `splitThink(full).content`; post `{type:'usage', promptTokens, completionTokens, total}`.
- **Regenerate** (`regenerate()`): drop the last assistant message from the active session and re-run the last user turn (re-collect context).
- **Edit-resend** (`editResend(index, text)`): truncate the active messages to `index`, then `handleSend(text)`.
- **New chat / switch:** `case 'newChat'` → `store.newChat()`; `case 'switchChat'` → `store.switchTo(id)`; both re-post history + chat list.
- **Meter:** on each keystroke the webview asks for size, OR the host posts the active model's context window on `state`; the webview computes `estimateTokens(input + lastHistory)` locally against that window (estimateTokens duplicated tiny in the webview). The host provides `contextWindow` in the `state` message (local 8192; OpenRouter/Fireworks `contextLength`; else 8192).

### 3.6 Webview
- Assistant message layout: an optional `<details class="reasoning"><summary>▸ Reasoning</summary>…</details>` (auto-open while streaming, closed on done) above the answer body; a footer row under each assistant reply with **Regenerate** + token-usage text; an **✎** on each user message (edit-resend).
- Header: a **chat `<select>`** (switch) beside New chat.
- Input: a small **`~2.1k / 8k`** meter that turns amber past ~90%.

## 4. Data flow

send → host streams, routing `content`→answer and `reasoning`→collapsible (live) → on done: persist `splitThink(content).content` only, auto-title, post chat list + `usage` → webview shows folded reasoning, usage, regenerate/edit affordances. Switching chats / new chat swaps the active `Session` and re-renders.

## 5. Testing

- **Unit:** `splitThink` (extract/strip, unclosed tag); `estimateTokens`/`estimateMessagesTokens`; `SessionStore` (new/switch/title/persist/migrate); `streamChat` capturing `reasoning_content` separately from content and returning `usage` (stub server emits both + a final usage chunk).
- **Manual (UAT):** GLM-5.2 thinking folds; multiple chats switch and persist across reload; regenerate re-answers; edit-and-resend rewrites the branch; meter tracks input size; usage shows after replies.

## 6. Success criteria

1. Reasoning content is folded into a collapsible section and NOT saved into the persisted answer (both `<think>` and `reasoning_content` paths).
2. At least two chats coexist, switch, and survive a reload; New chat never destroys another chat.
3. Regenerate replaces the last answer; edit-resend truncates and re-runs from an edited user message.
4. The input meter shows request size vs the active model's context window; per-reply and running token usage display.
5. No regression to Phase A context, governance/dev routing, or existing tests.
