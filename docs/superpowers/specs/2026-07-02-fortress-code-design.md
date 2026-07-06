# FortressChat — Design Spec

**Date:** 2026-07-02
**Status:** Approved (brainstorming session with Curtis)
**Repo:** brand-new public GitHub repository (`fortress-chat`, working title)

## 1. Problem & Goals

llama-vscode is too hard to set up and operate, and it fails badly under real conditions.
Problems observed first-hand on 2026-07-02:

1. **Memory oversubscription**: no awareness of system memory. ~77 GB of model
   weights were loaded on a 64 GB Mac; llama-server's Metal backend failed every
   request with `Compute error` (HTTP 500).
2. **Loading-state bug**: requests sent while llama-server was loading a model
   bounced off HTTP 503 and surfaced as raw errors in chat.
3. **Poisoned-history bug**: llama-vscode stored the error text as a chat message
   *without a `role` field*; every subsequent request replayed the malformed
   history and failed with `Failed to parse messages: Missing 'role' in message`.
   The session was unrecoverable.
4. **Configuration burden**: models/envs are configured by hand-editing
   `settings.json`; unremovable "predefined" envs clutter the picker; no built-in
   model download.

**Goals (v1):**

- VS Code extension with a **chat panel** and a **file-editing agent** backed by
  local llama.cpp inference.
- **Zero-to-working setup**: works for users with no models and no llama.cpp
  installed. One-screen first run, one-click download, no settings.json editing.
- **US-origin models only**: curated catalog of Google Gemma 3 and OpenAI gpt-oss.
- **Automatic memory safety**: never start a model that doesn't fit; fix the
  three failure modes above by construction.
- Distribution: public GitHub repo; CI builds a `.vsix` attached to GitHub
  Releases. Marketplace publishing deferred.
- Platform: Apple Silicon macOS first; download layer designed so Windows/Linux
  slot in later.

**Non-goals (v1):** inline FIM completions, RAG/embeddings, terminal tool for the
agent, marketplace listing, non-macOS platforms.

## 2. Architecture

Monorepo with two runtime components and a shared contract package.

```text
fortress-chat/
├── packages/
│   ├── manager/        # background daemon: server lifecycle, memory guard, downloads
│   ├── extension/      # VS Code extension: chat UI, agent loop, tools
│   └── shared/         # manager API contract types, catalog.json + schema
├── .github/workflows/  # CI: lint, test, build .vsix on tag → GitHub Release
└── docs/
```

### 2.1 Manager daemon (`packages/manager/`, Node.js + TypeScript)

A single background process that owns everything heavy:

- Downloads/updates the **pinned `llama-server` binary** (official llama.cpp
  GitHub release, macOS arm64) and **GGUF models** into
  `~/Library/Application Support/fortress-chat/`.
- Spawns and supervises **exactly one llama-server at a time** (one-model
  policy), health-checks it, detects crashes, restarts on demand.
- Enforces the **pre-flight memory check** (§4) and provides the **foreign
  process scan** (other `llama-server` / `llama serve` / `ollama runner`
  processes with model names and estimated sizes).
- Serves a REST API bound to **127.0.0.1 only**, authenticated via a token file
  in its data dir (only local processes that can read the user's home dir can
  connect).

**Lifecycle:** the extension spawns the daemon detached on first use — no
launchd, no installer. The daemon writes a pidfile + port file; any number of VS
Code windows/reloads reconnect to the same instance. **Idle policy:** if no
client has connected for 30 minutes and no chat activity occurred, unload the
model and exit. (Approved: on-demand detached daemon, 30-minute idle exit.)

**Server state machine:** `downloading → starting → loading-model → ready →
stopping | crashed`. State is exposed over the API and drives all client
behavior.

### 2.2 Extension (`packages/extension/`, thin client)

- Chat webview (sidebar panel), agent loop, and tool execution — tools live here
  because they need workspace access and the diff-approval UI.
- Inference streams **directly** from the extension to llama-server's
  OpenAI-compatible API (daemon hands out the endpoint). The daemon manages
  lifecycle; it does not proxy tokens.

### 2.3 Shared (`packages/shared/`)

- TypeScript types for the manager REST API (single source of truth, both sides
  import it).
- `catalog.json` + JSON schema.

## 3. Model catalog & first run

### 3.1 Catalog

Static `catalog.json` shipped in the extension, updated via normal releases.
US-origin families only. Every entry pins: Hugging Face repo, filename, SHA256,
license, memory estimate, RAM tier, `toolCalling` flag. All sources are
`ggml-org`/official GGUF uploads — no third-party quants.

| Model | Quant | ~Memory needed | RAM tier | toolCalling |
| --- | --- | --- | --- | --- |
| Gemma 3 1B QAT | Q4_0 | ~1.5 GB | any (8 GB+) | no |
| Gemma 3 4B QAT | Q4_0 | ~3.5 GB | 8 GB+ | no |
| Gemma 3 12B QAT | Q4_0 | ~9 GB | 16 GB+ | yes |
| Gemma 3 27B QAT | Q4_0 | ~18 GB | 32 GB+ | yes |
| gpt-oss-20B | MXFP4 | ~14 GB | 24 GB+ | yes |
| gpt-oss-120B | MXFP4 | ~62 GB | 96 GB+ | yes |

Agent mode requires a `toolCalling: true` model; the UI recommends those when
agent mode is used and disables the agent toggle otherwise (§6).

### 3.2 First run (zero to chatting)

1. User opens the chat panel → extension starts the daemon.
2. Daemon finds no binary/models → panel shows a one-screen setup:
   *"This Mac has 64 GB RAM. Recommended: gpt-oss-20B (agent-capable, ~14 GB).
   [Download] — or pick another."*
3. One click downloads the llama-server binary (~15 MB) and the model with a
   progress bar, verifies SHA256, starts the server, greets the user when
   `/health` is green.

### 3.3 Downloads

- Resumable: HTTP range requests, `.part` file renamed only on successful
  completion + checksum pass.
- Refuse to start a download when disk space is insufficient.

### 3.4 Model switching

Dropdown in the chat panel: downloaded models on top, RAM-appropriate
recommendations badged. Switching = daemon stops the old server, runs the memory
guard, starts the new one.

## 4. Memory guard

Runs in the daemon before any server start.

**Required memory** = model file size + KV-cache estimate (from configured
context length; default 8192 tokens) + ~1.5 GB overhead.
**Available memory** = free + inactive pages (via `vm_stat`), not just "free".

Outcomes:

1. **Fits with ≥15% system headroom remaining** → start.
2. **Fits only if managed server stops** → stop own previous server (one-model
   policy), then start.
3. **Doesn't fit** → do **not** start. Panel explains why and lists foreign
   memory hogs found by the process scan, with a **"Stop these and continue"**
   button. Foreign processes are killed **only** on that explicit click — never
   automatically. If stopping them still wouldn't free enough, say so and
   recommend a smaller catalog model.

(Approved policy: "manage own + warn on others".)

## 5. Error handling

- **No requests before ready:** the extension never sends a chat request unless
  the daemon reports `ready` (backed by llama-server `/health`). While loading,
  the panel shows "Loading `<model>`… `~<estimate>`" — the 503 class of failure
  is unreachable.
- **Typed chat history:** every history entry must have `role` and `content`,
  enforced at the type level and validated before every request. Transport and
  server errors are **never** appended to history; they render as a dismissible
  banner above the input, and the failed user message returns to the input box
  for retry. The poisoned-history failure is structurally impossible.
- **Crash recovery:** daemon detects llama-server exit, reports `crashed` with
  the last stderr lines, offers one-click restart. Chat session survives intact.
- **Generation watchdog:** if a generation streams no tokens for 60 s, the
  extension cancels the request (llama.cpp abort) instead of hanging the panel.

## 6. Chat & agent

### 6.1 Chat

- Sidebar webview; tokens stream via OpenAI-compatible `/v1/chat/completions`
  SSE directly from llama-server.
- Markdown + syntax highlighting; code-block copy/insert buttons; "add current
  file/selection to context" button; new-chat button.
- Sessions persist in `workspaceState` (survive window reload).

### 6.2 Agent mode

- A toggle in the same panel (not a separate UI).
- Tools (v1, approved set): `read_file`, `list_files`, `search` (grep),
  `edit_file`.
- Loop: model responds → execute tool calls → append results → repeat.
  Max 10 iterations; steps surfaced as a list in the UI; cancellable.
- `edit_file` opens a native VS Code diff with **Apply / Reject** — nothing
  touches disk without Apply.
- Read scope is the workspace folder only; the agent cannot read outside it.
- No terminal tool in v1.
- Toggle disabled (with a hint to switch models) when the loaded model lacks
  `toolCalling: true`.

## 7. Testing

- **Unit (vitest):** memory math (RAM tiers, fit calculations), catalog schema
  validation, chat-history validator (regression test: reject role-less
  messages), server state-machine transitions.
- **Integration (CI):** daemon run for real against a stub llama-server (tiny
  mock that serves `/health` and canned SSE). Covers lifecycle, crash detection,
  port-file reconnect, idle exit.
- **Manual UAT (Curtis's 64 GB Mac):** fresh-install first run (delete data dir
  → ≤3 clicks to chatting with gpt-oss-20B); memory-pressure scenario with the
  AI-DEMO2 8091–94 llama-server tier running.

## 8. Success criteria (v1 done =)

1. A user with nothing installed reaches a working chat in ≤3 clicks.
2. The daemon never starts a model that doesn't fit available memory.
3. A mid-chat llama-server crash never corrupts the chat session.
4. Agent mode can complete an approved multi-file edit.
5. CI produces an installable `.vsix` from a tagged release.
