# Developer Mode (Fireworks bypass) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in "Developer Mode" that bypasses the US-only governance guard and lets the user chat with any Fireworks-hosted model, triggered by `Ctrl+Alt+M`, with a loud "governance bypassed" indicator.

**Architecture:** Extension-only. A single, clearly-named `resolveDevTarget(slug, key)` builds a Fireworks OpenAI-compatible request **without** `assertAllowed` — the only place governance is skipped. A `toggleDevMode` command (keybinding `ctrl+alt+m`) flips a `globalState` flag; the webview reveals a Dev section (Fireworks key field + preset/free-text model picker + red bypass banner) only when on. The guarded `resolveTarget`/`assertAllowed` path is untouched.

**Tech Stack:** TypeScript 5, VS Code extension API, esbuild, vitest. Reuses the existing `streamChat`/`runAgentTurn` (they accept any `{url, headers, bodyExtra, model}` target) and the `secrets.ts` SecretStorage pattern.

## Global Constraints

- Work from `/Users/cmuir/Development/curtis-llama/fortress-chat`, branch `main`. Stage files explicitly (never `git add -A`). Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- The bypass lives ONLY in `resolveDevTarget`; it must NOT import or call `assertAllowed`. The guarded `resolveTarget` in `providers/target.ts` must remain unchanged and still call `assertAllowed` first.
- Fireworks transport: `https://api.fireworks.ai/inference/v1/chat/completions`, header `authorization: Bearer <key>`, `model: <slug>`, no `provider` pin.
- Fireworks key stored ONLY in `context.secrets` (id `fortressChat.fireworksKey`); never on disk, never posted to the webview (only a boolean `fireworksKeySet`), never committed.
- Dev Mode is OFF by default; first enable requires a modal confirm; a persistent "⚠ Developer mode — US-only governance is BYPASSED" banner shows whenever on.
- Verified preset slug: GLM-5.2 = `accounts/fireworks/models/glm-5p2`.
- Node 20+ builtins + `fetch` + `vscode` only. TDD for the logic task; manual verification for the webview task.

## File Structure

```text
packages/extension/src/
├── providers/dev.ts        # NEW: resolveDevTarget(slug,key) — the isolated bypass
├── devPresets.ts           # NEW: DEV_PRESETS list (label + Fireworks slug)
├── secrets.ts              # +getFireworksKey/setFireworksKey
├── extension.ts            # +register toggleDevMode command
├── chat/ChatViewProvider.ts# +devMode state, dev routing, message handlers
└── test/dev.test.ts        # NEW: resolveDevTarget shape + no-assertAllowed
packages/extension/
├── package.json            # +command + keybinding contributions
└── media/chat.html|css|js  # +Dev section, bypass banner, DEV marker
```

---

### Task 1: dev bypass core (resolveDevTarget + Fireworks key + presets)

**Files:**
- Create: `packages/extension/src/providers/dev.ts`, `packages/extension/src/devPresets.ts`, `packages/extension/src/test/dev.test.ts`
- Modify: `packages/extension/src/secrets.ts`

**Interfaces:**
- Consumes: `ResolvedTarget` from `./target` (shape `{ url, headers, bodyExtra, model? }`).
- Produces:
  - `function resolveDevTarget(slug: string, key: string): ResolvedTarget`
  - `const DEV_PRESETS: { label: string; slug: string }[]`
  - `const FIREWORKS_KEY_ID = 'fortressChat.fireworksKey'`, `getFireworksKey(secrets)`, `setFireworksKey(secrets, key)`

- [ ] **Step 1: Write the failing test** (`packages/extension/src/test/dev.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDevTarget } from '../providers/dev';
import { DEV_PRESETS } from '../devPresets';

describe('resolveDevTarget (governance bypass)', () => {
  it('builds a Fireworks OpenAI-compatible target with no provider pin', () => {
    const t = resolveDevTarget('accounts/fireworks/models/glm-5p2', 'fw_test');
    expect(t.url).toBe('https://api.fireworks.ai/inference/v1/chat/completions');
    expect(t.headers.authorization).toBe('Bearer fw_test');
    expect(t.headers['content-type']).toBe('application/json');
    expect(t.model).toBe('accounts/fireworks/models/glm-5p2');
    expect(t.bodyExtra).toEqual({}); // NO provider pin — this is the bypass
  });

  it('throws when the key is missing', () => {
    expect(() => resolveDevTarget('accounts/fireworks/models/glm-5p2', '')).toThrow(/key/i);
  });

  it('does NOT import assertAllowed (the bypass must be guard-free)', () => {
    const src = readFileSync(join(__dirname, '..', 'providers', 'dev.ts'), 'utf8');
    expect(src).not.toMatch(/assertAllowed/);
  });
});

describe('DEV_PRESETS', () => {
  it('includes GLM-5.2 with the verified slug', () => {
    expect(DEV_PRESETS.some((p) => p.slug === 'accounts/fireworks/models/glm-5p2')).toBe(true);
    for (const p of DEV_PRESETS) expect(p.slug).toMatch(/^accounts\/fireworks\/models\/.+/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w fortress-chat`
Expected: FAIL — cannot resolve `../providers/dev`.

- [ ] **Step 3: Implement the presets** (`packages/extension/src/devPresets.ts`)

```ts
// Fireworks model presets for Developer Mode. Slugs are best-effort against the
// Fireworks catalog (which changes); the free-text box is the reliable fallback.
export const DEV_PRESETS: { label: string; slug: string }[] = [
  { label: 'GLM-5.2', slug: 'accounts/fireworks/models/glm-5p2' },
  { label: 'Llama 3.3 70B', slug: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
  { label: 'DeepSeek V3', slug: 'accounts/fireworks/models/deepseek-v3' },
  { label: 'Qwen 2.5 72B', slug: 'accounts/fireworks/models/qwen2p5-72b-instruct' },
  { label: 'Mixtral 8x22B', slug: 'accounts/fireworks/models/mixtral-8x22b-instruct' },
];
```

- [ ] **Step 4: Implement the bypass** (`packages/extension/src/providers/dev.ts`)

```ts
import type { ResolvedTarget } from './target';

// Developer Mode ONLY. This deliberately skips the US-only governance guard
// (assertAllowed) and sends to Fireworks' OpenAI-compatible API. This is the
// single, auditable place governance is bypassed — grep resolveDevTarget.
export function resolveDevTarget(slug: string, key: string): ResolvedTarget {
  if (!key) throw new Error('No Fireworks API key — add your key in Developer Mode.');
  return {
    url: 'https://api.fireworks.ai/inference/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    bodyExtra: {},
    model: slug,
  };
}
```

- [ ] **Step 5: Add Fireworks key helpers** (`packages/extension/src/secrets.ts`)

Append to the existing file (which already exports the OpenRouter helpers):

```ts
export const FIREWORKS_KEY_ID = 'fortressChat.fireworksKey';

export function getFireworksKey(secrets: SecretStorage): Promise<string | undefined> {
  return Promise.resolve(secrets.get(FIREWORKS_KEY_ID));
}
export async function setFireworksKey(secrets: SecretStorage, key: string): Promise<void> {
  await secrets.store(FIREWORKS_KEY_ID, key.trim());
}
```

(`SecretStorage` is already imported at the top of `secrets.ts`.)

- [ ] **Step 6: Run to verify it passes**

Run: `npm run build -w @fortress-chat/shared && npm test -w fortress-chat`
Expected: dev tests pass; full extension suite still green.

- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/providers/dev.ts packages/extension/src/devPresets.ts packages/extension/src/secrets.ts packages/extension/src/test/dev.test.ts
git commit -m "feat(extension): Fireworks dev-mode bypass core (resolveDevTarget, presets, key)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: command, keybinding, and Dev-Mode webview

**Files:**
- Modify: `packages/extension/package.json`, `packages/extension/src/extension.ts`, `packages/extension/src/chat/ChatViewProvider.ts`, `packages/extension/media/chat.html`, `packages/extension/media/chat.css`, `packages/extension/media/chat.js`

**Interfaces:**
- Consumes: `resolveDevTarget` (Task 1), `DEV_PRESETS` (Task 1), `getFireworksKey`/`setFireworksKey` (Task 1), existing `streamChat`/`runAgentTurn`/`Session`.
- Produces: command `fortress-chat.toggleDevMode`; webview messages `devMode`, `devPresets`, `fireworksKeySet` (provider→webview) and `toggleDevModeAck`, `setFireworksKey`, `selectDevModel` (webview→provider).

This is a UI task: verify by build + manual smoke test (the bypass logic is unit-tested in Task 1).

- [ ] **Step 1: Contribute the command + keybinding** (`packages/extension/package.json`)

In `contributes.commands`, add alongside the existing `fortress-chat.openChat`:

```json
{ "command": "fortress-chat.toggleDevMode", "title": "FortressChat: Toggle Developer Mode" }
```

Add a top-level `contributes.keybindings` (sibling of `commands`/`views`):

```json
"keybindings": [
  { "command": "fortress-chat.toggleDevMode", "key": "ctrl+alt+m", "mac": "ctrl+alt+m" }
]
```

- [ ] **Step 2: Register the command** (`packages/extension/src/extension.ts`)

In `activate`, after the existing `registerWebviewViewProvider`/`openChat` registrations, add (assuming the provider instance is `provider`):

```ts
context.subscriptions.push(
  vscode.commands.registerCommand('fortress-chat.toggleDevMode', async () => {
    const on = !context.globalState.get<boolean>('fortressChat.devMode', false);
    if (on) {
      const ok = await vscode.window.showWarningMessage(
        'Developer Mode bypasses the US-only governance and lets you use any Fireworks model (including non-US). Continue?',
        { modal: true }, 'Enable',
      );
      if (ok !== 'Enable') return;
    }
    await context.globalState.update('fortressChat.devMode', on);
    provider.setDevMode(on);
    void vscode.window.showInformationMessage(`FortressChat Developer Mode ${on ? 'ON — governance BYPASSED' : 'off'}`);
  }),
);
```

(If `activate` doesn't keep the provider in a `provider` variable, assign it: `const provider = new ChatViewProvider(...)` and pass that to `registerWebviewViewProvider`.)

- [ ] **Step 3: Add Dev-Mode state + routing to the provider** (`packages/extension/src/chat/ChatViewProvider.ts`)

Add imports at the top:

```ts
import { resolveDevTarget } from '../providers/dev';
import { DEV_PRESETS } from '../devPresets';
import { getFireworksKey, setFireworksKey, getOpenRouterKey, setOpenRouterKey } from '../secrets';
```

(Merge the secrets import with the existing one — do not duplicate `getOpenRouterKey`/`setOpenRouterKey`.)

Add fields to the class:

```ts
private devMode = false;
private devModel: string | null = null;
```

Initialize `devMode` from globalState in the constructor (after `this.session = ...`):

```ts
this.devMode = context.globalState.get<boolean>('fortressChat.devMode', false);
```

Add a public method and post dev state from `sendInitial`/`init`. Add this method:

```ts
setDevMode(on: boolean): void {
  this.devMode = on;
  if (!on) { this.devModel = null; this.selected = this.selected?.provider === 'openrouter' || this.selected?.provider === 'local' ? this.selected : null; }
  void this.postDev();
}

private async postDev(): Promise<void> {
  this.post({ type: 'devMode', on: this.devMode, presets: DEV_PRESETS, fireworksKeySet: !!(await getFireworksKey(this.context.secrets)) });
}
```

In `init()` (or `sendInitial()` if present), after the policy/status posts, call `await this.postDev();`.

In `onMessage`'s switch, add these cases:

```ts
case 'setFireworksKey': await setFireworksKey(this.context.secrets, String(m.key)); void this.postDev(); return;
case 'selectDevModel': this.devModel = String(m.slug) || null; this.selected = null; await this.pushStatus(); return;
```

In `handleSend`, replace the target resolution so a dev model bypasses the guard. Find the block that does `target = resolveTarget(this.selected, await this.targetDeps());` inside its try/catch and change it to:

```ts
let target;
try {
  if (this.devMode && this.devModel) {
    const key = await getFireworksKey(this.context.secrets);
    target = resolveDevTarget(this.devModel, key ?? '');
  } else if (this.selected) {
    target = resolveTarget(this.selected, await this.targetDeps());
  } else {
    this.banner('Pick a model first.'); this.post({ type: 'restoreInput', text }); return;
  }
} catch (e) {
  this.banner(String(e instanceof Error ? e.message : e));
  this.post({ type: 'restoreInput', text });
  return;
}
```

(Remove the now-redundant earlier `if (!this.selected) {...}` guard at the top of `handleSend` if present, since the block above handles "no model selected".)

- [ ] **Step 4: Add the Dev section to the webview HTML** (`packages/extension/media/chat.html`)

Immediately after the `</section>` that closes `#gallery` (before `<header id="chat-head">`), add:

```html
<section id="dev" hidden>
  <div class="devbanner">⚠ Developer mode — US-only governance is BYPASSED</div>
  <div id="fw-key-row"><input id="fw-key" type="password" placeholder="Fireworks API key (stored in your OS keychain)" /><button id="fw-key-save">Save</button></div>
  <div class="devrow">
    <select id="dev-preset"></select>
    <input id="dev-slug" placeholder="or paste accounts/fireworks/models/…" />
    <button id="dev-use">Use</button>
  </div>
</section>
```

- [ ] **Step 5: Add Dev styles** (`packages/extension/media/chat.css`)

Append:

```css
#dev { padding: 8px; border-bottom: 1px solid var(--vscode-widget-border, #333); }
.devbanner { background: rgba(210,60,60,.18); border: 1px solid #6b2e2e; color: #e88; border-radius: 4px; padding: 6px 8px; font-size: 11.5px; font-weight: 600; margin-bottom: 8px; }
#fw-key-row, .devrow { display: flex; gap: 4px; margin-bottom: 6px; }
#fw-key, #dev-slug { flex: 1; }
.dev-active { color: #e88; }
```

- [ ] **Step 6: Wire the Dev section in the webview JS** (`packages/extension/media/chat.js`)

In the `window.addEventListener('message', ...)` handler, add:

```js
if (m.type === 'devMode') {
  window.__dev = m.on;
  $('dev').hidden = !m.on;
  $('fw-key-row').hidden = m.fireworksKeySet;
  $('dev-preset').innerHTML = '<option value="">— pick a Fireworks model —</option>' +
    (m.presets || []).map((p) => `<option value="${p.slug}">${esc(p.label)}</option>`).join('');
}
```

At the end of the file (after the other handler bindings), add:

```js
$('fw-key-save').onclick = () => { const k = $('fw-key').value.trim(); if (k) vscode.postMessage({ type: 'setFireworksKey', key: k }); };
$('dev-use').onclick = () => {
  const slug = ($('dev-slug').value.trim() || $('dev-preset').value || '').trim();
  if (!slug) return;
  vscode.postMessage({ type: 'selectDevModel', slug });
  $('chat-head').hidden = false; $('composer').hidden = false; $('send').disabled = false;
  $('active-model').innerHTML = '<span class="dev-active">⚠ DEV · ' + esc(slug) + '</span>';
};
```

- [ ] **Step 7: Build + manual smoke test**

Run: `npm run build -w @fortress-chat/shared && npm run build -w fortress-chat` (both bundles + tsc clean), then `npm test -w fortress-chat` (existing suite green).
Manual (Extension Dev Host / installed): press `Ctrl+Alt+M` → confirm dialog → the Dev section + red banner appear → save the Fireworks key → pick GLM-5.2 → send → reply streams from Fireworks and the header shows "⚠ DEV". Press `Ctrl+Alt+M` again → Dev section hidden, governed gallery restored.

- [ ] **Step 8: Commit**

```bash
git add packages/extension/package.json packages/extension/src/extension.ts packages/extension/src/chat/ChatViewProvider.ts packages/extension/media/chat.html packages/extension/media/chat.css packages/extension/media/chat.js
git commit -m "feat(extension): Developer Mode toggle (Ctrl+Alt+M) with Fireworks dev section and bypass banner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** bypass isolation (T1 `resolveDevTarget`, no `assertAllowed` — asserted by test); Fireworks key in SecretStorage (T1 secrets, T2 UI); command + `ctrl+alt+m` + first-enable confirm (T2); persistent bypass banner + DEV marker (T2 webview); preset list incl. verified GLM-5.2 + free-text (T1 presets, T2 UI); governed path unchanged (T1 test asserts, T2 routes dev only when `devMode && devModel`).
- **Type consistency:** `resolveDevTarget` returns `ResolvedTarget` (same shape `streamChat`/`completeOnce` already consume); `DEV_PRESETS: {label,slug}[]` used verbatim in provider post + webview; secrets helpers mirror the OpenRouter pair.
- **Governance guarantee:** `providers/target.ts` and the `shared` policy/governance code are not modified; the bypass is reachable only via `devMode && devModel`.
