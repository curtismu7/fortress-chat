# Phase 1 — Chat UX Quick Wins: Design

Artifact reference: <https://claude.ai/code/artifact/d8a0d358-2f32-4c15-9258-f1028f9973ac>

**Status:** Approved design
**Date:** 2026-07-05
**Scope:** Items 2-7 of the top-15 roadmap
(`docs/superpowers/plans/2026-07-05-top15-features-roadmap.md`).
Personas (item 1) were CUT by user decision — revisit only if requested.

## Goal

Six chat-UX features in the shared webview + twinned controllers, shipping
in BOTH frontends (VS Code extension and Mac app): prompt library, model
params UI, chat export, chat search, fork-from-message, LaTeX + Mermaid
rendering.

## Architecture

- **Shared webview:** all UI lands in `packages/extension/media/chat.{html,css,js}`
  (byte-identical copy consumed by the Mac app; only additive, CSP-safe changes).
- **Twinned controllers:** message handling added to BOTH
  `packages/extension/src/chat/ChatViewProvider.ts` and the Mac app's
  `src/main/controller.ts` (kept diffable, same case names).
- **One new pure module:** `packages/extension/src/prefs.ts` — prompt
  library and params storage over the existing `MementoLike` interface
  (globalState in the extension, `FileMemento` in the app). Vendored by the
  app like `sessionStore.ts` is.
- **Delivery:** build + ship the extension first; then bump the Mac app's
  submodule pin, re-sync the renderer, twin the controller cases, ship the app.

## Features

### 1. Prompt library
- `SavedPrompt { id: string; title: string; text: string }` with `{variable}`
  placeholders.
- Typing `/` in an EMPTY input opens a keyboard-navigable dropdown of saved
  prompts (filter as you type). Picking one inserts `text` into the input and
  selects the first `{variable}` occurrence for overtyping. No modal forms.
- CRUD via a small "Prompts" manage section (same inline visual pattern as
  the dev-mode section): add/edit/delete.

### 2. Model params UI
- Gear button in the chat header opens a small popover: temperature (0-2),
  top_p (0-1), max_tokens — each individually settable or "inherit default"
  (unset).
- Stored globally via `prefs.ts`; unset values are omitted from the request
  entirely.
- Injection point: merged into the request body via the existing
  `target.bodyExtra` mechanism in `streamChat` callers — no signature change.

### 3. Chat export (Markdown)
- "Export" button in the chat header. Renders the active session to Markdown:
  H1 title, ISO date, `## User` / `## Assistant` sections in order, reasoning
  (if stored) inside `<details><summary>Reasoning</summary>…</details>`,
  sources as a bullet list of `file:Lstart-Lend`.
- Pure renderer function (unit-tested) + frontend-specific save: extension
  uses `vscode.window.showSaveDialog`; the app adds a `saveFile` dep to
  `ControllerDeps` (dialog in `main.ts`).

### 4. Chat search
- A search input above the chat list; while non-empty, the chat picker shows
  ranked matches instead of the plain list.
- Matching: case-insensitive substring over titles and message contents;
  rank = title-hit (weight 3) + per-message hits (weight 1), descending.
  Implemented as a pure function over the SessionStore's in-memory data —
  no index.
- UI note: the current `<select id="chat-picker">` becomes a combo pattern —
  keep the select for compatibility, add the filter input beside/above it;
  selecting a result switches chats (existing `switchChat` message).
- Folders: DEFERRED (roadmap keeps them; flat searchable list suffices).

### 5. Fork-from-message
- A fork button (`⑂` — plain text glyph, allowed) beside each message's
  existing affordances → posts `{ type: 'forkChat', index }`.
- Controller: copies `messages[0..index]` (inclusive) into a NEW chat titled
  `Fork: <original title>` (truncated to 40 chars total), switches to it,
  posts `history` + `chats`. Implemented in SessionStore as
  `fork(index: number): void` (unit-tested).

### 6. LaTeX + Mermaid rendering
- Vendor locally into `media/vendor/` (CSP `script-src 'self'` compatible,
  no CDN): KaTeX (+ auto-render extension + fonts/CSS) and Mermaid ESM
  build. ~1.5MB added to the packaged extension — accepted.
- Post-pass after `renderMarkdown`:
  - fenced ```` ```mermaid ```` blocks → rendered diagram with a "show code"
    toggle; render failure → plain code block (fail-soft).
  - `$…$` / `$$…$$` → KaTeX auto-render with `trust: false`,
    `throwOnError: false`.
- Mermaid initialized with `securityLevel: 'strict'`, `startOnLoad: false`.
- XSS posture unchanged: content passes the existing escaping pipeline
  first; both libraries run in their safe configurations.
- Script tags added to `chat.html` (before `chat.js`); the Mac app's
  `sync-renderer` copies `media/vendor/` and its html-transform anchors are
  unaffected (guarded anchors will catch any drift).

## New webview protocol messages

Inbound (webview → controller): `savePrompt {prompt}`, `deletePrompt {id}`,
`setParams {params}`, `exportChat {}`, `searchChats {query}`, `forkChat
{index}`.
Outbound (controller → webview): `prefs { prompts, params }`,
`searchResults { metas }` (ranked ChatMeta list).
All handlers follow the existing banner-on-error pattern.

## Storage shapes (prefs.ts, one Memento key each)

- `fortressCode.prompts`: `SavedPrompt[]`
- `fortressCode.params`: `Params` (`{ temperature?, top_p?, max_tokens? }`)

## Error handling

- Storage failures, export failures, invalid fork index → banner; never
  crash the turn.
- Math/Mermaid render errors → fall back to plain code/text silently.

## Testing

- vitest (pure): `prefs.ts` CRUD + round-trip; `SessionStore.fork` (copy
  bounds, title, switch); export renderer (roles, reasoning details,
  sources); prompt `{variable}` insertion/selection offsets; search ranking
  (title vs content weights, case-insensitivity).
- Webview: `node --check`; Mac side re-runs the byte-identical sync test.
- Params injection: unit test that set params appear in the request body and
  unset ones are absent.

## Out of scope (v1)

Personas (cut by user decision), folders/tags, share links, prompt modal
forms, HTML export, export of non-active chats, KaTeX `trust:true` features.
