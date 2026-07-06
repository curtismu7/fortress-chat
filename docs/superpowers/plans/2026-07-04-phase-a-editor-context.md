# Phase A — See & Apply Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat aware of the editor (active file, selection, `@file` mentions, diagnostics as removable chips), render assistant code with Copy / Insert / Apply-as-diff, and add selection right-click actions + slash commands.

**Architecture:** Extension-only. A pure, unit-tested `context.ts` assembles a context preamble; `ChatViewProvider` collects editor state via `vscode`, posts chips, and prepends the preamble on send. The webview gains a framework-free markdown renderer with per-code-block action buttons. Selection commands feed templated prompts.

**Tech Stack:** TypeScript, VS Code API, framework-free webview JS, vitest. No new deps.

## Global Constraints

- Work from `/Users/cmuir/Development/curtis-llama/fortress-chat`, branch `main`. Stage explicitly. Commit trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- No new runtime deps; no daemon or `@fortress-chat/shared` change. `context.ts` core logic must be `vscode`-free (unit-testable); the `vscode`-facing collector lives in `ChatViewProvider`.
- File-content cap: 30_000 bytes per attached file; truncate and flag `truncated: true`.
- `@file` mentions and Apply targets are path-confined (reuse `resolveInWorkspace` from `agent/tools.ts`).
- Lightweight rendering: markdown + monospace code blocks, NO per-token syntax colors. All webview text escaped (no HTML injection).
- Streaming stays raw monospace; markdown re-renders on completion (existing `history` re-render).
- Apply-as-diff targets the active file's selection (or whole file if none) via the agent tools' diff-approval flow.
- Node 20+ / `fetch` / `vscode` only. TDD for `context.ts`; manual verification for webview/commands.

## File Structure

```text
packages/extension/src/
├── context.ts              # NEW: parseMentions, capContent, buildContextPreamble (vscode-free)
├── chat/ChatViewProvider.ts# collect editor context, post chips, prepend preamble, insert/apply handlers
├── extension.ts            # selection-action commands
├── agent/tools.ts          # export editFileWithApproval for reuse (currently module-private)
└── test/context.test.ts    # NEW
packages/extension/
├── package.json            # selection commands + editor/context menus
└── media/chat.html|css|js  # chips row, markdown renderer, code-block buttons, slash parsing
```

---

### Task 1: context core (`context.ts`) — TDD

**Files:** Create `packages/extension/src/context.ts`, `packages/extension/src/test/context.test.ts`

**Interfaces:**
- Produces:
  - `interface AttachedFile { id: string; relPath: string; language: string; content: string; truncated: boolean; diagnostics: string[] }`
  - `interface SelectionCtx { id: string; relPath: string; startLine: number; endLine: number; text: string }`
  - `interface ChatContext { file: AttachedFile | null; selection: SelectionCtx | null; mentions: AttachedFile[] }`
  - `function parseMentions(input: string): string[]`
  - `function capContent(text: string, maxBytes?: number): { content: string; truncated: boolean }`
  - `function buildContextPreamble(ctx: ChatContext): string`

- [ ] **Step 1: Write the failing test** (`packages/extension/src/test/context.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { parseMentions, capContent, buildContextPreamble, type ChatContext } from '../context';

describe('parseMentions', () => {
  it('extracts @paths and dedupes', () => {
    expect(parseMentions('look at @src/a.ts and @src/a.ts and @b.js please')).toEqual(['src/a.ts', 'b.js']);
  });
  it('returns [] when none', () => expect(parseMentions('no mentions here')).toEqual([]));
});

describe('capContent', () => {
  it('passes short content through untruncated', () => {
    expect(capContent('hello', 100)).toEqual({ content: 'hello', truncated: false });
  });
  it('truncates over the cap and flags it', () => {
    const r = capContent('x'.repeat(50), 10);
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBeLessThanOrEqual(10 + 20); // + a short marker
    expect(r.content).toContain('truncated');
  });
});

describe('buildContextPreamble', () => {
  const base: ChatContext = { file: null, selection: null, mentions: [] };
  it('is empty when no context', () => expect(buildContextPreamble(base)).toBe(''));
  it('includes active file, selection, mention, and diagnostics', () => {
    const ctx: ChatContext = {
      file: { id: 'f', relPath: 'src/app.ts', language: 'typescript', content: 'const a=1;', truncated: false, diagnostics: ['12:5 error TS2345 nope'] },
      selection: { id: 's', relPath: 'src/app.ts', startLine: 10, endLine: 12, text: 'return x;' },
      mentions: [{ id: 'm', relPath: 'src/b.ts', language: 'typescript', content: 'export const b=2;', truncated: true, diagnostics: [] }],
    };
    const out = buildContextPreamble(ctx);
    expect(out).toContain('src/app.ts');
    expect(out).toContain('const a=1;');
    expect(out).toContain('L10');            // selection range
    expect(out).toContain('return x;');
    expect(out).toContain('src/b.ts');       // mention
    expect(out).toContain('truncated');      // mention flagged
    expect(out).toContain('TS2345');         // diagnostics
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w fortress-chat`
Expected: FAIL — cannot resolve `../context`.

- [ ] **Step 3: Implement** (`packages/extension/src/context.ts`)

```ts
export interface AttachedFile { id: string; relPath: string; language: string; content: string; truncated: boolean; diagnostics: string[] }
export interface SelectionCtx { id: string; relPath: string; startLine: number; endLine: number; text: string }
export interface ChatContext { file: AttachedFile | null; selection: SelectionCtx | null; mentions: AttachedFile[] }

export function parseMentions(input: string): string[] {
  const out: string[] = [];
  const re = /@([^\s@]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export function capContent(text: string, maxBytes = 30_000): { content: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { content: text, truncated: false };
  return { content: text.slice(0, maxBytes) + '\n…(truncated)', truncated: true };
}

function fileBlock(label: string, f: AttachedFile): string {
  const head = `[context] ${label} ${f.relPath} (${f.language})${f.truncated ? ', truncated' : ''}`;
  const diag = f.diagnostics.length ? `\n[diagnostics] ${f.relPath}:\n${f.diagnostics.map((d) => '  ' + d).join('\n')}` : '';
  return `${head}\n\`\`\`${f.language}\n${f.content}\n\`\`\`${diag}`;
}

export function buildContextPreamble(ctx: ChatContext): string {
  const parts: string[] = [];
  if (ctx.file) parts.push(fileBlock('active file', ctx.file));
  if (ctx.selection) parts.push(`[context] selection ${ctx.selection.relPath} L${ctx.selection.startLine}-${ctx.selection.endLine}\n\`\`\`\n${ctx.selection.text}\n\`\`\``);
  for (const mn of ctx.mentions) parts.push(fileBlock('mentioned file', mn));
  return parts.join('\n\n');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build -w @fortress-chat/shared && npm test -w fortress-chat`
Expected: context tests pass; full suite green.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/context.ts packages/extension/src/test/context.test.ts
git commit -m "feat(extension): editor-context assembly core (mentions, cap, preamble)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: collect context + chips + prepend on send

**Files:** Modify `packages/extension/src/chat/ChatViewProvider.ts`, `packages/extension/media/chat.html`, `chat.css`, `chat.js`

**Interfaces:**
- Consumes: `buildContextPreamble`, `parseMentions`, `capContent`, types from `../context`; `resolveInWorkspace` from `../agent/tools`.
- Produces: provider→webview `{type:'context', chips:[{id,label,kind}]}`; webview→provider `{type:'excludeContext', id}`.

- [ ] **Step 1: Add context collection to the provider** (`ChatViewProvider.ts`)

Add imports:
```ts
import { buildContextPreamble, parseMentions, capContent, type ChatContext, type AttachedFile } from '../context';
import { resolveInWorkspace } from '../agent/tools';
import { readFileSync } from 'node:fs';
```
Add field: `private excluded = new Set<string>();`

Add a collector method (ids are stable per kind so exclusions persist across polls of the same file/selection):
```ts
private async collectContext(userText: string): Promise<ChatContext> {
  const ed = vscode.window.activeTextEditor;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const rel = (p: string) => root ? vscode.workspace.asRelativePath(p) : p;
  const diagsFor = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).map((d) =>
    `${d.range.start.line + 1}:${d.range.start.character + 1} ${vscode.DiagnosticSeverity[d.severity].toLowerCase()} ${d.message}`);

  let file: AttachedFile | null = null;
  let selection: ChatContext['selection'] = null;
  if (ed) {
    const doc = ed.document;
    const relPath = rel(doc.fileName);
    const fileId = 'file:' + relPath;
    if (!this.excluded.has(fileId)) {
      const cap = capContent(doc.getText());
      file = { id: fileId, relPath, language: doc.languageId, content: cap.content, truncated: cap.truncated, diagnostics: diagsFor(doc.uri) };
    }
    if (!ed.selection.isEmpty) {
      const selId = 'sel:' + relPath;
      if (!this.excluded.has(selId)) {
        selection = { id: selId, relPath, startLine: ed.selection.start.line + 1, endLine: ed.selection.end.line + 1, text: doc.getText(ed.selection) };
      }
    }
  }
  const mentions: AttachedFile[] = [];
  if (root) for (const mrel of parseMentions(userText)) {
    const mid = 'mention:' + mrel;
    if (this.excluded.has(mid)) continue;
    try {
      const abs = resolveInWorkspace(root, mrel);
      const cap = capContent(readFileSync(abs, 'utf8'));
      mentions.push({ id: mid, relPath: mrel, language: mrel.split('.').pop() ?? '', content: cap.content, truncated: cap.truncated, diagnostics: [] });
    } catch { /* skip unreadable/escaping mention */ }
  }
  return { file, selection, mentions };
}

private async postChips(): Promise<void> {
  const ctx = await this.collectContext('');
  const chips: { id: string; label: string; kind: string }[] = [];
  if (ctx.file) chips.push({ id: ctx.file.id, label: '📄 ' + ctx.file.relPath, kind: 'file' });
  if (ctx.selection) chips.push({ id: ctx.selection.id, label: `✂ ${ctx.selection.relPath} L${ctx.selection.startLine}-${ctx.selection.endLine}`, kind: 'sel' });
  this.post({ type: 'context', chips });
}
```

- [ ] **Step 2: Wire editor-change events + initial chips** (`ChatViewProvider.ts`, in `init()` after the poller setup)

```ts
const refresh = () => void this.postChips();
this.context.subscriptions.push(
  vscode.window.onDidChangeActiveTextEditor(refresh),
  vscode.window.onDidChangeTextEditorSelection(refresh),
);
await this.postChips();
```

- [ ] **Step 3: Handle `excludeContext` + prepend preamble on send** (`ChatViewProvider.ts`)

In `onMessage` switch add:
```ts
case 'excludeContext': this.excluded.add(String(m.id)); void this.postChips(); return;
```
When a new file/selection appears the ids change, so exclusions naturally lapse; also clear stale exclusions in `postChips` is unnecessary (Set grows slowly). In `handleSend`, after resolving `target` and before `this.session.addUser(text)`, build the preamble and send it as a prior user message:
```ts
const preamble = buildContextPreamble(await this.collectContext(text));
if (preamble) this.session.messages.push({ role: 'user', content: preamble });
```
(The `preTurnLen` snapshot already taken before `addUser` must move ABOVE this push so a failed turn rolls back the preamble too — set `const preTurnLen = this.session.messages.length;` immediately before the preamble push.)

- [ ] **Step 4: Chips UI** (`chat.html` — add above the footer input; `chat.css`; `chat.js`)

`chat.html`: inside `<footer id="composer">`, before the `<textarea>`:
```html
<div id="chips"></div>
```
`chat.css` append:
```css
#chips { display: flex; flex-wrap: wrap; gap: 4px; width: 100%; margin-bottom: 4px; }
.chip { display: inline-flex; align-items: center; gap: 4px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 10px; padding: 1px 7px; font-size: 10.5px; }
.chip button { background: none; border: none; color: inherit; cursor: pointer; padding: 0 0 0 2px; font-size: 11px; }
```
(Also set `#composer { flex-wrap: wrap; }` so chips sit above the row.)
`chat.js` — in the message handler add:
```js
if (m.type === 'context') {
  $('chips').innerHTML = (m.chips || []).map((c) => `<span class="chip">${esc(c.label)}<button data-chip="${c.id}">×</button></span>`).join('');
  document.querySelectorAll('#chips button').forEach((b) => b.onclick = () => vscode.postMessage({ type: 'excludeContext', id: b.dataset.chip }));
}
```

- [ ] **Step 5: Build + test + manual smoke**

Run: `npm run build -w fortress-chat && npm test -w fortress-chat` (green; no new unit tests here).
Manual: open a file → a `📄 file` chip shows; select text → a `✂ sel` chip shows; `×` removes it; ask "what file am I looking at?" → the model answers correctly.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/chat/ChatViewProvider.ts packages/extension/media/chat.html packages/extension/media/chat.css packages/extension/media/chat.js
git commit -m "feat(extension): attach active file/selection/@mentions as removable context chips

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: markdown rendering + code-block actions

**Files:** Modify `packages/extension/media/chat.js`, `chat.css`; `packages/extension/src/agent/tools.ts` (export the diff helper); `packages/extension/src/chat/ChatViewProvider.ts` (insert/apply handlers)

**Interfaces:**
- Consumes: `editFileWithApproval` (newly exported from `agent/tools.ts`).
- Produces: webview→provider `{type:'insertCode', code}` and `{type:'applyCode', code}`.

- [ ] **Step 1: Export the diff helper** (`packages/extension/src/agent/tools.ts`)

Change `async function editFileWithApproval(` to `export async function editFileWithApproval(` (no behavior change).

- [ ] **Step 2: Markdown renderer + code blocks** (`chat.js`)

Add near the top (after `esc`):
```js
let cbCodes = [];
function renderInline(t) {
  return esc(t)
    .replace(/`([^`]+)`/g, '<code class="inl">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');
}
function renderMarkdown(text) {
  const parts = String(text).split('```');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const nl = parts[i].indexOf('\n');
      const lang = nl >= 0 ? parts[i].slice(0, nl).trim() : '';
      const code = (nl >= 0 ? parts[i].slice(nl + 1) : parts[i]).replace(/\n$/, '');
      const id = cbCodes.push(code) - 1;
      out += `<div class="codeblock"><div class="cb-head"><span>${esc(lang || 'code')}</span><span class="cb-btns"><button data-cb="${id}" data-act="copy">Copy</button><button data-cb="${id}" data-act="insert">Insert</button><button data-cb="${id}" data-act="apply">Apply</button></span></div><pre><code>${esc(code)}</code></pre></div>`;
    } else if (parts[i]) {
      out += `<div class="md">${renderInline(parts[i])}</div>`;
    }
  }
  return out;
}
```
Change `renderHistory` to reset `cbCodes` and render assistant messages via markdown (user stays plain):
```js
function renderHistory(messages) {
  streaming = ''; cbCodes = [];
  $('messages').innerHTML = messages
    .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
    .map((m) => m.role === 'assistant'
      ? `<div class="msg assistant">${renderMarkdown(m.content)}</div>`
      : `<div class="msg user"><pre>${esc(m.content)}</pre></div>`)
    .join('');
  $('messages').scrollTop = $('messages').scrollHeight;
}
```
Add a delegated click handler (after the other bindings):
```js
$('messages').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cb]');
  if (!b) return;
  const code = cbCodes[+b.dataset.cb];
  if (b.dataset.act === 'copy') { navigator.clipboard.writeText(code); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 900); }
  if (b.dataset.act === 'insert') vscode.postMessage({ type: 'insertCode', code });
  if (b.dataset.act === 'apply') vscode.postMessage({ type: 'applyCode', code });
});
```

- [ ] **Step 3: Code-block styles** (`chat.css` append)

```css
.codeblock { border: 1px solid var(--vscode-widget-border, #333); border-radius: 6px; margin: 6px 0; overflow: hidden; }
.cb-head { display: flex; justify-content: space-between; align-items: center; background: var(--vscode-editorWidget-background); padding: 3px 8px; font-size: 10.5px; }
.cb-btns button { background: none; border: 1px solid var(--vscode-widget-border, #444); color: inherit; border-radius: 3px; font-size: 10px; padding: 1px 6px; margin-left: 3px; cursor: pointer; }
.codeblock pre { margin: 0; padding: 8px; overflow-x: auto; background: var(--vscode-textCodeBlock-background, #1e1e1e); }
.codeblock code, code.inl { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
code.inl { background: var(--vscode-textCodeBlock-background, #2a2a2a); padding: 0 3px; border-radius: 3px; }
.md { white-space: normal; }
```

- [ ] **Step 4: Insert/apply handlers** (`ChatViewProvider.ts`)

Add import: `import { editFileWithApproval } from '../agent/tools';`
In `onMessage` switch add:
```ts
case 'insertCode': {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { this.banner('Open a file to insert into.'); return; }
  await ed.edit((b) => b.insert(ed.selection.active, String(m.code)));
  return;
}
case 'applyCode': {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { this.banner('Open a file to apply into.'); return; }
  const rel = vscode.workspace.asRelativePath(ed.document.fileName);
  const next = ed.selection.isEmpty
    ? String(m.code)
    : ed.document.getText().slice(0, ed.document.offsetAt(ed.selection.start)) + String(m.code) + ed.document.getText().slice(ed.document.offsetAt(ed.selection.end));
  await editFileWithApproval(ed.document.fileName, next, rel);
  return;
}
```

- [ ] **Step 5: Build + test + manual**

Run: `npm run build -w fortress-chat && npm test -w fortress-chat` (green).
Manual: get a reply with a fenced code block → it renders in a bordered box with Copy/Insert/Apply; Copy copies; Insert inserts at cursor; Apply opens a review diff on the active file.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/media/chat.js packages/extension/media/chat.css packages/extension/src/agent/tools.ts packages/extension/src/chat/ChatViewProvider.ts
git commit -m "feat(extension): render markdown + code blocks with Copy/Insert/Apply-as-diff

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: selection commands + slash commands

**Files:** Modify `packages/extension/package.json`, `packages/extension/src/extension.ts`, `packages/extension/src/chat/ChatViewProvider.ts`, `packages/extension/media/chat.js`

**Interfaces:**
- Produces: commands `fortress-chat.explainSelection|fixSelection|testSelection|refactorSelection|docSelection`; provider method `runSelectionAction(kind)`.

- [ ] **Step 1: Contribute commands + editor menu** (`package.json`)

Add to `contributes.commands` (each): titles "FortressChat: Explain / Fix / Add Tests / Refactor / Document Selection", commands `fortress-chat.explainSelection` etc. Add:
```json
"menus": {
  "editor/context": [
    { "submenu": "fortress-chat.selection", "group": "1_modification", "when": "editorHasSelection" }
  ],
  "fortress-chat.selection": [
    { "command": "fortress-chat.explainSelection", "group": "1@1" },
    { "command": "fortress-chat.fixSelection", "group": "1@2" },
    { "command": "fortress-chat.testSelection", "group": "1@3" },
    { "command": "fortress-chat.refactorSelection", "group": "1@4" },
    { "command": "fortress-chat.docSelection", "group": "1@5" }
  ]
},
"submenus": [ { "id": "fortress-chat.selection", "label": "FortressChat" } ]
```

- [ ] **Step 2: Register commands** (`extension.ts`, inside the `context.subscriptions.push(...)`)

```ts
...(['explain', 'fix', 'test', 'refactor', 'doc'].map((k) =>
  vscode.commands.registerCommand(`fortress-chat.${k}Selection`, async () => {
    await vscode.commands.executeCommand('fortressChat.chat.focus');
    provider.runSelectionAction(k);
  }))),
```

- [ ] **Step 3: Provider action → templated send** (`ChatViewProvider.ts`)

```ts
private static ACTION_PROMPTS: Record<string, string> = {
  explain: 'Explain what this code does, clearly and concisely.',
  fix: 'Find and fix bugs in this code. Return the corrected code.',
  test: 'Write unit tests for this code.',
  refactor: 'Refactor this code for clarity and quality without changing behavior.',
  doc: 'Add clear doc comments to this code.',
};

runSelectionAction(kind: string): void {
  const prompt = ChatViewProvider.ACTION_PROMPTS[kind];
  if (prompt) void this.handleSend(prompt); // collectContext() attaches the current selection automatically
}
```

- [ ] **Step 4: Slash commands** (`chat.js`, in the `$('send').onclick` handler)

Replace the send onclick body's `const t = $('input').value.trim();` flow to expand slash commands:
```js
$('send').onclick = () => {
  let t = $('input').value.trim();
  if (!t) return;
  const slash = { '/explain': 'Explain this code.', '/fix': 'Find and fix bugs in this code.', '/test': 'Write unit tests for this code.', '/refactor': 'Refactor this code without changing behavior.', '/doc': 'Add doc comments to this code.' };
  const cmd = t.split(/\s+/)[0];
  if (slash[cmd]) t = slash[cmd] + (t.slice(cmd.length).trim() ? ' ' + t.slice(cmd.length).trim() : '');
  $('input').value = ''; $('banner').hidden = true; $('steps').innerHTML = ''; $('steps').hidden = true;
  vscode.postMessage({ type: 'send', text: t }); $('cancel').hidden = false;
};
```

- [ ] **Step 5: Build + test + manual**

Run: `npm run build -w fortress-chat && npm test -w fortress-chat` (green).
Manual: select code → right-click → FortressChat → Explain (chat sends an explanation prompt with the selection attached); `/fix` in the input expands and runs.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/package.json packages/extension/src/extension.ts packages/extension/src/chat/ChatViewProvider.ts packages/extension/media/chat.js
git commit -m "feat(extension): selection right-click actions and slash commands

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** context assembly + cap (T1); active file/selection/@mentions/diagnostics chips + prepend on send + exclude (T2); markdown + code blocks + Copy/Insert/Apply-as-diff (T3); selection right-click actions + slash commands (T4). Streaming-raw-then-markdown-on-done is preserved (T3 uses the existing `history` re-render). Cap protects small-model context (T1).
- **Type consistency:** `ChatContext`/`AttachedFile`/`SelectionCtx` defined in `context.ts` (T1), consumed by the collector (T2); chip `{id,label,kind}` shape consistent provider↔webview; `editFileWithApproval(abs, content, rel)` signature matches its definition in `agent/tools.ts`.
- **Governance:** unchanged — context is prepended to messages regardless of provider; dev/governed send paths untouched.
