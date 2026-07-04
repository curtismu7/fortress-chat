# Inline Edit (Cmd+Shift+K) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. `- [ ]` tracking.

**Goal:** Select code → Cmd+Shift+K → type an instruction → the selected model rewrites the region → diff you approve.

**Architecture:** Extension-only, reuses `streamChat`, provider routing, and `editFileWithApproval`. A pure `inlineEdit.ts` (message-building + fence-stripping) is unit-tested.

**Tech Stack:** TypeScript, VS Code API, vitest. No new deps.

## Global Constraints
- Work from `/Users/cmuir/Development/curtis-llama/fortress-code`, branch `main`. Stage explicitly. Trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Route through the panel's currently-selected model via the same `assertAllowed`-gated resolver chat uses; dev mode → Fireworks. No new governance surface.
- Output must be code-only (strip ```fences); no chat-history entry created.

---

### Task 1: `inlineEdit.ts` (pure, TDD)

**Files:** Create `src/inlineEdit.ts`, `src/test/inlineEdit.test.ts`

- [ ] **Step 1: failing test**
```ts
import { describe, it, expect } from 'vitest';
import { buildInlineEditMessages, stripCodeFences } from '../inlineEdit';
describe('stripCodeFences', () => {
  it('strips a fenced block', () => expect(stripCodeFences('```ts\nconst a=1;\n```')).toBe('const a=1;'));
  it('strips a bare fence', () => expect(stripCodeFences('```\nx\n```')).toBe('x'));
  it('leaves unfenced text (trimmed)', () => expect(stripCodeFences('  bare code  ')).toBe('bare code'));
});
describe('buildInlineEditMessages', () => {
  it('has an output-only system msg and includes code + instruction', () => {
    const m = buildInlineEditMessages('const a=1;', 'make it a let', 'typescript');
    expect(m[0].role).toBe('system');
    expect(m[0].content).toMatch(/only the new code/i);
    expect(m[1].role).toBe('user');
    expect(m[1].content).toContain('make it a let');
    expect(m[1].content).toContain('const a=1;');
    expect(m[1].content).toContain('typescript');
  });
});
```
- [ ] **Step 2: run → FAIL** (`npm test -w fortress-code`)
- [ ] **Step 3: implement** (`src/inlineEdit.ts`)
```ts
import type { ChatMessage } from '@fortress-code/shared';

const EDIT_SYSTEM = 'You are a precise code editor. Rewrite the user\'s selected code according to their instruction. Output ONLY the new code — no explanations, no markdown fences.';

export function buildInlineEditMessages(code: string, instruction: string, language: string): ChatMessage[] {
  return [
    { role: 'system', content: EDIT_SYSTEM },
    { role: 'user', content: `Instruction: ${instruction}\n\nCode (${language}):\n${code}` },
  ];
}

export function stripCodeFences(text: string): string {
  const t = String(text).trim();
  const m = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return (m ? m[1] : t).trim();
}
```
- [ ] **Step 4: run → PASS**; **Step 5: commit** (`git add src/inlineEdit.ts src/test/inlineEdit.test.ts` → `feat(extension): inline-edit prompt builder + fence stripper`)

---

### Task 2: provider `currentTarget()` + `inlineEdit()`

**Files:** Modify `src/chat/ChatViewProvider.ts`

- [ ] Extract routing into `private async currentTarget(): Promise<ResolvedTarget>`:
```ts
private async currentTarget(): Promise<ResolvedTarget> {
  if (this.devMode && this.devModel) {
    const key = await getFireworksKey(this.context.secrets);
    return resolveDevTarget(this.devModel, key ?? '');
  }
  if (this.selected) {
    if (!this.client) this.client = await this.connect();
    return resolveTarget(this.selected, await this.targetDeps());
  }
  throw new Error('Pick a model first.');
}
```
Import `type { ResolvedTarget } from '../providers/target'`. Replace the `try { if (devMode…) … } catch {…}` block at the top of `handleSend` with `let target; try { target = await this.currentTarget(); } catch (e) { this.banner(String(e instanceof Error ? e.message : e)); this.post({ type: 'restoreInput', text }); return; }` (same behavior).
- [ ] Add:
```ts
async inlineEdit(code: string, instruction: string, language: string, signal: AbortSignal): Promise<string> {
  const target = await this.currentTarget();
  const r = await streamChat(target, buildInlineEditMessages(code, instruction, language), () => {}, signal);
  return stripCodeFences(r.content);
}
```
Import `buildInlineEditMessages, stripCodeFences` from `../inlineEdit`.
- [ ] Build + typecheck clean. Commit (`feat(extension): provider currentTarget() + inlineEdit()`)

---

### Task 3: command + keybinding

**Files:** Modify `src/extension.ts`, `package.json`

- [ ] `package.json`: add command `fortress-code.inlineEdit` (title "Fortress Code: Inline Edit") and keybinding `{ command: 'fortress-code.inlineEdit', key: 'ctrl+shift+k', mac: 'cmd+shift+k', when: 'editorTextFocus' }`.
- [ ] `extension.ts`: add to the `context.subscriptions.push(...)`:
```ts
vscode.commands.registerCommand('fortress-code.inlineEdit', async () => {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { void vscode.window.showErrorMessage('Open a file first.'); return; }
  const range = ed.selection.isEmpty ? ed.document.lineAt(ed.selection.active.line).range : ed.selection;
  const instruction = await vscode.window.showInputBox({ prompt: 'Fortress Code — inline edit', placeHolder: 'e.g. add error handling' });
  if (!instruction) return;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Fortress Code editing…', cancellable: true }, async (_p, token) => {
    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());
    try {
      const newCode = await provider.inlineEdit(ed.document.getText(range), instruction, ed.document.languageId, ac.signal);
      const full = ed.document.getText();
      const next = full.slice(0, ed.document.offsetAt(range.start)) + newCode + full.slice(ed.document.offsetAt(range.end));
      await editFileWithApproval(ed.document.fileName, next, vscode.workspace.asRelativePath(ed.document.fileName));
    } catch (e) {
      void vscode.window.showErrorMessage(`Inline edit failed: ${e instanceof Error ? e.message : e}`);
    }
  });
}),
```
Import `editFileWithApproval` from `./agent/tools` in `extension.ts`.
- [ ] Build + typecheck + test green. Manual: select code → Cmd+Shift+K → instruction → diff → Apply/Reject. Commit (`feat(extension): inline-edit command (Cmd+Shift+K)`)

---

## Self-Review Notes
- **Spec coverage:** pure builder/stripper (T1); routing reuse + inlineEdit (T2); command/keybinding/input/progress/diff (T3).
- **Type consistency:** `streamChat` returns `{content,…}` (Phase B) — inlineEdit uses `.content`; `currentTarget()` returns `ResolvedTarget` consumed by both handleSend and inlineEdit; `editFileWithApproval(abs, content, rel)` signature matches.
- **Governance:** `currentTarget()` is the same gated resolver; no bypass added outside `resolveDevTarget`.
