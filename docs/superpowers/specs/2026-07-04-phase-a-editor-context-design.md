# FortressChat — Phase A: See & Apply Code (design)

**Status:** Approved (brainstorming session with Curtis, 2026-07-04)
**Part of:** the 7-improvement coding-UX roadmap (Phase A of A→B→C→D). Builds on the existing chat webview (`ChatViewProvider` + `media/chat.*`) and agent tools.

## 1. Goal

Turn the sidebar chat from "a chatbot that can't see your code" into a coding assistant: it reads your editor context, renders code you can act on, and offers selection-driven actions. Three coupled features:
1. **Editor context** — active file, selection, `@file` mentions, and diagnostics, shown as removable chips.
2. **Code rendering & apply** — lightweight markdown + fenced code blocks with Copy / Insert-at-cursor / Apply-as-diff.
3. **Selection actions & slash commands** — right-click Explain/Fix/Test/Refactor/Document, and `/explain` `/fix` `/test` `/refactor` `/doc`.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Code rendering | **Lightweight** — markdown + monospace, theme-colored code blocks with action buttons; **no per-token syntax colors** (framework-free, no bundled highlighter). |
| Context inclusion | **Auto + controllable chips** — auto-attach selection + active file, shown as removable chips; plus `@file` mentions. |
| Apply-as-diff target | The **active file's selection** (or whole active file if no selection); always via the existing diff-approval flow. Multi-file apply is Phase C. |
| Streaming render | Stream **raw** monospace; **re-render markdown on completion** (avoid reparsing each token). |
| File-content cap | ~30 KB per attached file (truncate with a note) to protect small local models' context windows. |

## 3. Architecture

Extension-side only (host + webview). No daemon or `shared` change.

### 3.1 `extension/src/context.ts` (new, host-side, unit-tested)
Pure-ish context assembly, decoupled from `vscode` for testability:

```ts
interface AttachedFile { id: string; relPath: string; language: string; content: string; truncated: boolean; diagnostics: string[] }
interface SelectionCtx { id: string; relPath: string; startLine: number; endLine: number; text: string }
interface ChatContext { file: AttachedFile | null; selection: SelectionCtx | null; mentions: AttachedFile[] }

function parseMentions(input: string): string[]           // extract @path tokens
function capContent(text: string, maxBytes = 30_000): { content: string; truncated: boolean }
function buildContextPreamble(ctx: ChatContext): string   // formats attached context into one message string
```

A thin `vscode`-facing collector in `ChatViewProvider` reads `window.activeTextEditor` (document, selection, fileName), resolves `@` mentions against the workspace (path-confined, reusing the agent tools' `resolveInWorkspace`), pulls `languages.getDiagnostics(uri)`, and hands plain data to the pure functions above.

`buildContextPreamble` produces a fenced, labeled block prepended as a `user` message before the actual prompt, e.g.:
```
[context] active file src/app.ts (typescript){, truncated}
```lang
…content…
```
[context] selection src/app.ts L10–24
…
[diagnostics] src/app.ts: 12:5 error TS2345 …
```

### 3.2 Context chips (webview)
Above the input, a `#chips` row renders one chip per attached item (`📄 file`, `✂ sel L10–24`, `@ other.ts`) each with an `×`. The host posts `{type:'context', chips:[{id,label,kind}]}` whenever the active editor or selection changes (`onDidChangeActiveTextEditor`, `onDidChangeTextEditorSelection`, debounced). Clicking `×` posts `{type:'excludeContext', id}`; the host adds the id to an `excluded` set so the next send omits it. Excluded ids reset when the underlying file/selection changes.

### 3.3 Markdown + code blocks (webview)
A small framework-free renderer in `chat.js` (`renderMarkdown(text)`): fenced ```lang blocks → `<div class="codeblock"><div class="cb-head">lang · Copy · Insert · Apply</div><pre><code>…</code></pre></div>`; plus inline `code`, `**bold**`, `- lists`, `# headings`. All text is escaped (no raw HTML injection). Assistant messages render markdown **on `done`**; during streaming the partial text shows in a raw `<pre>`. Code-block buttons post to the host:
- `Copy` → `navigator.clipboard.writeText` (webview) — no host round-trip.
- `Insert` → `{type:'insertCode', code}` → host `activeTextEditor.edit(b => b.insert(active.selection.active, code))`.
- `Apply` → `{type:'applyCode', code}` → host runs the agent tools' diff-approval against the active file, replacing the current selection (or whole file if none); user approves/rejects.

### 3.4 Selection actions & slash commands
- **Commands** (`extension.ts`): `fortress-chat.explainSelection` / `.fixSelection` / `.testSelection` / `.refactorSelection` / `.docSelection`. Each reads the active selection, focuses the chat view, and drives a send with a templated prompt (e.g. Explain → "Explain this code:") plus the selection as context. Contributed to `contributes.menus["editor/context"]` under a "FortressChat" group, `when: editorHasSelection`.
- **Slash commands** (webview): if the input starts with `/explain|/fix|/test|/refactor|/doc`, expand to the same template against the current selection/active file before sending.

### 3.5 `handleSend` integration
Before building the request messages, the host assembles the (non-excluded) `ChatContext`, and if non-empty prepends `buildContextPreamble(ctx)` as a `user` message ahead of the user's text. Governed and dev paths both get context. Nothing about provider selection changes.

## 4. Data flow

editor change → host posts `context` chips → webview renders chips → user may `×`-exclude → send → host gathers included context → prepends preamble → streams → on `done` webview renders markdown+code blocks → code-block button → host inserts/diffs into the editor.

## 5. Testing

- **Unit (`context.test.ts`):** `parseMentions` extracts `@paths`; `capContent` truncates at the cap and flags it; `buildContextPreamble` includes file/selection/diagnostics and omits absent parts; excluded items don't appear.
- **Manual (UAT):** chips reflect the active file/selection and update on switch; `×` removes an item from the next send; a reply with a code block renders with Copy/Insert/Apply and each works; `@file` attaches a file; right-click Explain/Fix/etc. and `/explain` etc. drive a contextual prompt; truncation note shows on a large file.

## 6. Success criteria

1. The model demonstrably sees the active file/selection (ask "what file am I in?" → correct answer) with visible, removable chips.
2. Assistant code blocks render distinctly and Copy / Insert-at-cursor / Apply-as-diff all work; Apply routes through the review diff.
3. Right-click and slash actions send a contextual prompt about the selection.
4. Attached content is capped so a large file can't silently blow a small local model's context (truncation is shown).
5. No regression to governed/dev send paths or existing tests.
