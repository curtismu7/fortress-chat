# FortressChat Mac — Design

**Status:** Approved design
**Date:** 2026-07-05

## What it is

A standalone macOS Electron app: private, local-first ChatGPT with US-only
model governance — plus "Open Folder" to index any codebase and ask
`@codebase` questions with clickable sources. Same brain as the VS Code
extension, no VS Code required.

## Key decisions

- **Scope (v1):** chat + folder `@codebase` RAG. No editing, no agent tools.
- **Framework:** Electron. The manager daemon already spawns under
  `ELECTRON_RUN_AS_NODE=1`, so it runs unchanged; TypeScript-only; mature
  packaging.
- **Distribution:** unsigned DMG attached to GitHub Releases on a public
  repo; README documents right-click → Open past Gatekeeper. Signing can be
  added later without rework.
- **Repo:** NEW separate repo `fortress-chat-mac`
  (github.com/curtismu7/fortress-chat-mac), consuming the main repo via a
  **git submodule pinned to a commit** — no npm publishing, deliberate and
  reviewable updates.

## Repo layout & reuse

```text
fortress-chat-mac/
  vendor/fortress-chat        <- git submodule, pinned commit of main repo
  src/main/                   <- Electron main process (TypeScript)
    main.ts                   <- app lifecycle, BrowserWindow, menu
    daemon.ts                 <- spawn/ensure manager (reuses vendor manager bundle)
    controller.ts             <- ChatController (port of ChatViewProvider)
    sessions.ts               <- file-based session store (replaces Memento)
    secrets.ts                <- safeStorage-backed key store (replaces SecretStorage)
    rag.ts                    <- RagService wiring for the opened folder
  src/preload.js              <- contextBridge: postMessage/onMessage only
  renderer/                   <- build-time copy of vendor media/ + shim + theme
    chat.html chat.css chat.js  (byte-identical to extension where possible)
    vscode-shim.js            <- defines `acquireVsCodeApi()` over the bridge
    theme.css                 <- the 34 --vscode-* variables, light/dark
  scripts/sync-renderer.mjs   <- copies media/ from the submodule at build
  package.json  electron-builder.yml  tsconfig.json  vitest.config.ts
```

- `@fortress-chat/shared` and `@fortress-chat/manager` are imported from the
  submodule via `file:vendor/fortress-chat/packages/...` references.
- The chat UI (`chat.html/css/js`) is copied, not forked: the only
  renderer-side additions are `vscode-shim.js` (3-line `acquireVsCodeApi`
  shim over the preload bridge) and `theme.css`.
- Updating shared code = bump the submodule pin, review the diff, commit.

## Main-process components

- **Daemon spawn:** reuse `ensureDaemon` semantics against the manager
  bundle built from the submodule (`ELECTRON_RUN_AS_NODE=1` already in
  place). Daemon stays 127.0.0.1 + token auth; app shuts it down on quit
  only if it started it.
- **ChatController:** port of `ChatViewProvider` minus editor-specific
  parts. Keeps: message routing, model gallery/download/start flows,
  governance blocks, OpenRouter + dev mode (Ctrl+Alt+M), streaming with
  reasoning fold, multi-chat sessions, regenerate/edit-resend, `@codebase`
  retrieval + sources, index progress. Drops: active-file/selection chips,
  diagnostics, inline edit.
- **Sessions:** JSON file store in `app.getPath('userData')`, same
  validated message schema (including `sources`) from shared.
- **Secrets:** Electron `safeStorage` (Keychain-backed) for OpenRouter and
  Fireworks keys.
- **Open Folder:** native dialog sets the RAG root; index/store lives under
  `userData/rag/<sha256(root).slice(0,16)>` — identical keying to the
  extension.
- **Source clicks:** `{type:'openSource'}` → v1 opens the file with the
  system default app via `shell.openPath` (line range shown in the link
  text; no built-in viewer in v1).

## Security

- `contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer.
- Strict CSP (self-only) matching the extension webview's.
- Exactly one preload API: `postMessage(msg)` / `onMessage(cb)`.
- Renderer HTML built with the same DOM-construction rules (the
  attribute-injection XSS fixed in the extension stays fixed here — same
  files).
- Keys never touch the renderer; governance (`assertAllowed`) enforced in
  the main process exactly as the extension enforces it.

## Packaging & distribution

- `electron-builder` produces an unsigned **arm64-only** `.dmg` for v1
  (matches the pinned llama.cpp binary; Intel support is out of scope).
- `npm run dist` builds; releases attached manually (or via CI later) to
  GitHub Releases on `fortress-chat-mac`.
- README: install steps + the right-click → Open Gatekeeper note.

## Error handling

- Daemon fails to start → blocking error screen with the daemon.log path.
- Download/index/embed failures → same banner + graceful-fallback behavior
  as the extension (the controller port preserves those paths).
- Bad/missing submodule build artifacts → build script fails loudly with
  the exact `git submodule update --init` remedy.

## Testing

- Vitest in the app repo: session store round-trip, secrets wrapper (mock
  safeStorage), controller message routing against a mocked DaemonClient
  (send → history/state/sources posts), RAG-root keying.
- Shared/manager suites continue to run in the main repo (submodule).
- Scripted smoke: launch Electron headless-ish, wait for daemon `/status`
  200 through the app's spawn path.
- Manual DMG smoke before each release: install, download model, chat,
  open folder, index, `@codebase` query, click a source.

## Out of scope (v1)

File editing, agent tools, inline completions, auto-update, Windows/Linux,
code signing/notarization, built-in file viewer.
