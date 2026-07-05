# Top-15 Chat-Harness Features — Fortress Code Roadmap

**Date:** 2026-07-05
**Source:** 3-agent survey of ~20 chat harnesses (2025-2026 state):
local-first apps (LM Studio, Jan, Msty, AnythingLLM, GPT4All, Cherry Studio,
Chatbox), self-hosted UIs (Open WebUI, LibreChat, big-AGI, TypingMind,
ChatWise, Lobe Chat), first-party apps (ChatGPT, Claude, Gemini, Copilot) and
coding chat UIs (Cursor, GitHub Copilot Chat, Continue.dev).

**Method:** feature frequency across all three categories, minus what Fortress
Code already ships (governed model gallery + downloads, multi-chat sessions,
edit-resend/regenerate, reasoning fold, @file mentions, @codebase RAG with
clickable sources, incremental indexing, agent tools + inline edit in the
extension, dev mode, token meter), weighted by fit with the product identity:
**local-first, US-governed, privacy-forward**.

Targets both frontends where possible: the webview (chat.html/css/js) and
ChatController/ChatViewProvider are shared between the VS Code extension and
the Mac app, so most features land in both at once.

## The Top 15

| # | Feature | Prevalence | Effort | Phase |
|---|---------|-----------|--------|-------|
| 1 | Personas / custom assistants (system-prompt + model + params presets) | 13/20 | S | 1 |
| 2 | Prompt library (saved prompts with variables) | 6/20 | S | 1 |
| 3 | Model params UI (temperature, top-p, max tokens per chat) | 6/20 | S | 1 |
| 4 | Chat export (Markdown/HTML file) | 6/20 | S | 1 |
| 5 | Chat search (across all conversations) + folders | 5/20 | S | 1 |
| 6 | Conversation branching / fork-from-message | 10/20 | S | 1 |
| 7 | Math (LaTeX) + Mermaid diagram rendering | 8/20 | M | 1 |
| 8 | Document/PDF RAG — chat with any docs, not just code | 19/20 | M | 2 |
| 9 | Persistent memory (local, editable user facts injected into context) | 6/20 | M | 2 |
| 10 | Vision / image input (Gemma 3 ≥4B is multimodal via llama.cpp mmproj — fully local) | 14/20 | M | 3 |
| 11 | Voice: STT input (local whisper.cpp) + TTS output (macOS `say` v1) | 8/20 | L | 3 |
| 12 | MCP client — connect external tool servers to agent mode | 18/20 | L | 4 |
| 13 | Web search with citations (US-governed provider allow-list, fail-closed) | 17/20 | M | 4 |
| 14 | Artifacts — live sandboxed HTML/SVG/Mermaid preview pane | 12/20 | L | 4 |
| 15 | Multi-model compare — same prompt to two models side-by-side | 7/20 | M | 4 |

Effort: S = days, M = ~week, L = multi-week. Prevalence = apps shipping it
across the 20 surveyed.

## Phases (each gets its own spec → plan → build cycle)

### Phase 1 — Chat UX quick wins (items 1-7)
All UI + controller work in the shared webview/controller; no new services.
- Personas: named presets bundling system prompt + model + params; picker in
  the chat header; per-chat override. Prompt library rides the same storage
  with `{variable}` substitution.
- Params UI: a small settings popover; values flow into the existing
  streamChat request.
- Export: active chat → Markdown (file save dialog in app; workspace file in
  extension).
- Search: substring/rank search over the session store; folders = tags on
  ChatMeta.
- Branch/fork: "fork from here" copies messages[0..i] into a new chat
  (SessionStore.newChat + splice — the store already supports everything
  needed).
- Math/Mermaid: vendor KaTeX + Mermaid into media/ (CSP-safe, no CDN), render
  fenced ```mermaid blocks and $...$ math in the existing markdown pipeline.

### Phase 2 — Knowledge (items 8-9)
- Document RAG: reuse the ENTIRE Phase D engine (chunker → VectorStore →
  embed via nomic → retriever). New: a docs ingestion path (txt/md native;
  PDF text extraction via a vendored extractor), an `@docs` mention, and a
  "Add documents" UI. Same governance (local embeddings only).
- Memory: a local, user-editable memory file (facts the model may store via a
  lightweight "remember this" affordance + settings editor); injected into
  the system preamble; off by default, privacy-forward.

### Phase 3 — Modalities (items 10-11)
- Vision: download the Gemma 3 mmproj alongside vision-capable models
  (catalog addition); image attach button + clipboard paste in the webview;
  llama.cpp multimodal chat endpoint.
- Voice v1: STT via whisper.cpp (manager gains a transcribe endpoint, small
  US-origin Whisper model in the catalog); TTS via macOS `say` (app) /
  system TTS. Voice "calls" are out of scope.

### Phase 4 — Tools & ecosystem (items 12-15)
- MCP client: agent mode gains MCP server connections (stdio first);
  governed: servers are user-added, tool calls surfaced with approval, no
  default remote servers.
- Web search: pluggable providers behind a **US-governed allow-list**
  (fail-closed, same PolicyEntry pattern as models); results injected with
  citations rendered like @codebase sources.
- Artifacts: sandboxed iframe pane (srcdoc, no network per CSP) rendering
  HTML/SVG/Mermaid from code blocks; "open as artifact" affordance.
- Multi-model compare: split view sending one prompt to two targets
  (local + OpenRouter, or two OpenRouter models; two local models only if
  RAM fit allows — reuse the two-model fit math).

## Explicitly not adopted (and why)
- Scheduled tasks / background agents — server-ish, off local-first mission for now.
- Deep-research mode — composition of web search + agent loop; revisit after Phase 4.
- Code interpreter sandbox — extension agent mode already runs commands with approval.
- Share links — requires hosting; export covers the need.
- Image generation, translation panels, channels/rooms — off-mission.

## Governance thread (applies throughout)
Anything that sends data off-device (web search providers, MCP remote
servers, vision via OpenRouter) goes through the same US-only, fail-closed
policy registry as models. This keeps the product's core promise coherent as
the surface grows.
