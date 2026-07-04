# Fortress Code — Inline Edit (Cmd+Shift+K) design

**Status:** Approved (brainstorming session with Curtis, 2026-07-04)
**Builds on:** Phase A (selection context + `editFileWithApproval` diff flow) and the provider/model routing.

## 1. Goal

Edit code in place: select code, press **Cmd+Shift+K**, type an instruction, and the currently-selected model rewrites just that selection — shown as a **diff you approve/reject**. No sidebar, no chat history pollution.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Keybinding | `cmd+shift+k` (mac) / `ctrl+shift+k`; palette "Fortress Code: Inline Edit"; `when: editorTextFocus`. |
| Input UX | Native `showInputBox` for the instruction. |
| Result review | Reuse `editFileWithApproval` (whole-file diff: before + newCode + after). |
| Model | The model already selected in the panel — governed or Fireworks-dev — via the same routing as chat. |
| No selection | Act on the current line. |

## 3. Architecture (extension-only)

### 3.1 `inlineEdit.ts` (pure, tested)
```ts
import type { ChatMessage } from '@fortress-code/shared';
function buildInlineEditMessages(code: string, instruction: string, language: string): ChatMessage[]
// [ {role:'system', content: EDIT_SYSTEM}, {role:'user', content: `Instruction: ${instruction}\n\nCode (${language}):\n${code}`} ]
function stripCodeFences(text: string): string
// removes a leading ```lang and trailing ``` if the whole reply is fenced; else returns trimmed text
```
`EDIT_SYSTEM` = "You are a precise code editor. Rewrite the user's selected code according to their instruction. Output ONLY the new code — no explanations, no markdown fences."

### 3.2 `ChatViewProvider`
- Extract `private async currentTarget(): Promise<ResolvedTarget>` from `handleSend`'s routing (devMode+devModel → `resolveDevTarget`; else `resolved`Target with `assertAllowed`; else throw "Pick a model first."). `handleSend` calls it too (no behavior change).
- `async inlineEdit(code, instruction, language, signal): Promise<string>` — `currentTarget()`, then `streamChat(target, buildInlineEditMessages(...), () => {}, signal)` (no tools, no reasoning UI), return `stripCodeFences(result.content)`.

### 3.3 `extension.ts` — the command
`registerCommand('fortress-code.inlineEdit', …)`:
1. `const ed = window.activeTextEditor; if (!ed) return`.
2. `const range = ed.selection.isEmpty ? ed.document.lineAt(ed.selection.active.line).range : ed.selection`.
3. `const instruction = await window.showInputBox({ prompt: 'Inline edit', placeHolder: 'e.g. add error handling' }); if (!instruction) return`.
4. `window.withProgress({ location: Notification, title: 'Fortress Code editing…' }, async () => { const newCode = await provider.inlineEdit(ed.document.getText(range), instruction, ed.document.languageId, token); … })` (a `CancellationTokenSource` bridged to an `AbortSignal`).
5. Build `next` = full document text with `range` replaced by `newCode`; `rel = asRelativePath(fileName)`; `await editFileWithApproval(ed.document.fileName, next, rel)`.
6. Errors → `window.showErrorMessage`.

### 3.4 `package.json`
Command `fortress-code.inlineEdit` (title "Fortress Code: Inline Edit") + keybinding `{ key: 'ctrl+shift+k', mac: 'cmd+shift+k', when: 'editorTextFocus' }`.

## 4. Governance

No new surface. `currentTarget()` is the same `assertAllowed`-gated resolver chat uses; dev mode routes to Fireworks exactly as chat does. The bypass remains confined to `resolveDevTarget`.

## 5. Testing

- **Unit (`inlineEdit.test.ts`):** `stripCodeFences('```ts\ncode\n```')` → `'code'`; `stripCodeFences('bare')` → `'bare'`; `buildInlineEditMessages` yields a system message + a user message containing the instruction and the code, with the EDIT_SYSTEM output-only directive.
- **Manual (UAT):** select code → Cmd+Shift+K → "add JSDoc" → a diff opens with the edited code; Apply writes it, Reject leaves the file unchanged; no selection → edits the current line; works with a local model and with GLM-5.2 in dev mode.

## 6. Success criteria

1. Cmd+Shift+K on a selection prompts for an instruction and produces an in-place **diff** of just that region (or the current line if no selection).
2. The result is the model's code only — no markdown fences or prose leak into the file.
3. It uses the panel's currently-selected model and respects governance/dev routing unchanged.
4. Apply writes the edit; Reject is a no-op; no chat history entry is created.
5. No regression to chat send, Phase A/B, or existing tests.
