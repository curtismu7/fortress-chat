# FortressChat — Full Program Design (M0–M4)

**Status:** Approved (brainstorming session, 2026-07-06)
**Scope:** Complete the top-15 roadmap across extension + Mac app using dual-track milestones.
**Builds on:** `2026-07-05-top15-features-roadmap.md`, Gemini cloud delta (PR #9), local-US-only policy (PR #7).

## 1. Goal

Ship a coherent **local-first, US-governed** chat product on **both frontends** (VS Code extension + Mac Electron app) through five milestones. Each milestone delivers extension and Mac together before the next begins.

## 2. Execution strategy

**Dual-track milestones (locked):** For each milestone, merge extension work on `fortress-chat` main, bump the Mac vendor pin, sync renderer, port controller deltas, smoke-test both apps, then tag/release.

**Governance thread (all milestones):** Anything sending data off-device (Gemini, web search, MCP remote servers) uses the same US-only, fail-closed policy pattern as models. OpenRouter remains disabled; Gemini is the approved cloud path.

## 3. Current state (baseline)

| Area | Extension | Mac app |
|------|-----------|---------|
| Version | 0.1.9 | vendor pin `ebdec9d` (stale) |
| Local US models | ✅ | ✅ (stale UX) |
| Google Gemini | ✅ PR #9 | ❌ not ported |
| Sidebar chat UX | ✅ PR #7 | ❌ renderer stale |
| Phase 1 UX (personas, export, search, fork, KaTeX/Mermaid) | ✅ largely done | ⚠️ needs sync |
| `@docs` RAG (txt/md/json/csv) | ✅ scaffold | ⚠️ needs verify |
| Persistent memory | ✅ scaffold | ⚠️ needs verify |
| Image attach | ⚠️ placeholder text only | ⚠️ same |
| MCP client | ✅ agent mode | ⚠️ Mac settings path |
| Web search (DuckDuckGo) | ✅ agent tool | ⚠️ needs verify |
| Multi-model compare | ✅ scaffold | ⚠️ needs verify |
| Artifacts pane | ✅ iframe sandbox | ⚠️ needs verify |

---

## M0 — Release foundation

### Goal
Documented, shippable baseline at **v0.1.10** before feature milestones.

### Extension work
- Bump `packages/extension/package.json` version → `0.1.10`
- Update `README.md`: Local US models + Google Gemini (remove OpenRouter-first copy)
- Add short delta spec: `2026-07-06-gemini-cloud-design.md` (Gemini replaces OpenRouter)
- Document smoke checklist (below)

### Mac work
None — note vendor gap only.

### Smoke checklist (manual)
1. `npm run build && npm run test` (all workspaces)
2. `npm run package -w fortress-chat` → install VSIX
3. Local model: download → chat
4. Gemini: Settings → API key → Gemini model → chat
5. Sidebar: rename/delete chat; model picker stays open
6. Agent mode: requires open folder; tools run with approval

### Success criteria
- VSIX packages cleanly (no shell comments in command)
- README matches product reality
- All unit tests pass

---

## M1 — Mac parity sprint

### Goal
Mac app matches extension for chat core.

### Architecture

```text
fortress-code @ f6ee024+
    │ vendor bump + sync-renderer
    ▼
fortress-code-mac
  renderer/       ← chat.html/css/js copied (no fork)
  controller.ts   ← port ChatViewProvider deltas
  secrets.ts      ← GOOGLE_KEY_ID
```

### Controller ports (from ChatViewProvider)

| Feature | Messages / APIs |
|---------|-----------------|
| Policy | `{ type:'policy', local, hidden, google, openrouter:[] }` |
| Gemini key | `setGoogleKey`, `googleKeySet` |
| Target deps | `googleKey` in `targetDeps()` |
| Cloud-without-daemon | Init tolerates daemon failure when Google key set |
| Policy sanitize | Allow `selected.provider === 'google'` |
| Sidebar handlers | `renameChat`, `deleteChat`, `newChat` with agent flag |

### Mac secrets
- Add `GOOGLE_KEY_ID = 'fortressChat.googleKey'` to `secrets.ts` (same id as extension)
- Encrypted via existing `SecretStore`

### Data flow (Gemini on Mac)
1. User saves key → `SecretStore.set(GOOGLE_KEY_ID, key)`
2. Controller posts `googleKeySet: true` + `policy.google`
3. User picks Gemini model → `resolveTarget` → Google OpenAI-compat endpoint
4. Chat works without local llama binary when key is set

### Error handling
- Missing key: picker hint; send shows banner
- Bad key: HTTP error in banner
- Daemon failure: non-fatal when Google key present

### Testing
- Extend `controller.test.ts`: `googleKeySet`, `policy.google` in pushFullState
- Manual: Open Folder → local chat; Gemini key → cloud chat without binary
- Build DMG, smoke on clean Mac

### Success criteria
- Mac vendor pin ≥ `f6ee024`
- Gemini chat works on Mac
- Sidebar UX matches extension

---

## M2 — Knowledge layer (Phase 2)

### Goal
Polish document RAG and persistent memory to production quality on both frontends.

### What exists
- `DocsService`: indexes txt/md/json/csv via same RAG engine as `@codebase`
- `MemoryStore`: local JSON file, off by default, injected via system preamble
- Agent `remember` tool writes facts when user asks

### Gaps to close

**Document RAG**
- **PDF support:** vendored text extractor (e.g. `pdf-parse` or minimal pdftotext wrapper); reject encrypted PDFs with clear error
- **UI:** "Index documents" shows file count + chunk count; `@docs` mention shows retrieval status in chips
- **Indexing progress:** existing `docsProgress` message — ensure visible in settings panel
- **Mac:** `pickDocuments` dialog already exists; verify PDF mime filter

**Persistent memory**
- Settings panel: enable toggle + facts editor (exists — verify save/load on Mac)
- **"Remember this" affordance:** optional button on assistant replies → posts `{type:'rememberFact', text}` → appends to memory file (ask-mode friendly, not only agent tool)
- Privacy copy: "Stored locally; never sent except when enabled and included in your prompt"

### Architecture

```text
User → @docs mention → DocsService.retrieveHits → embed via daemon → preamble injection
User → remember → MemoryStore.save → next send includes MemoryStore.preamble()
```

### Error handling
- Embed server won't start (RAM): banner with RAM guidance
- Empty docs index: `@docs` returns helpful "index documents first" message
- PDF parse failure: skip file, report in progress UI

### Testing
- Unit: PDF text extraction on fixture PDF
- Integration: index 2 docs → `@docs` query returns chunks
- Memory: enable → add fact → verify preamble in next request (mock stream)

### Success criteria
- PDF + text docs indexable on both apps
- Memory toggle + facts persist across restart
- `@docs` retrieval shows clickable sources (reuse codebase source link pattern)

---

## M3 — Multimodal (Phase 3)

### Goal
Image input for cloud (Gemini vision) and local (Gemma 3 ≥4B + mmproj).

### What exists
- `attachImage` button stores base64 in `pendingImages`
- Context preamble adds placeholder text: "data available for vision-capable models"
- Images are **not** sent to the model API yet

### Cloud path — Gemini vision

**Approach:** Extend `streamChat` / message builder to include OpenAI-format image content parts when target is Google provider and images are attached.

```json
{ "role": "user", "content": [
  { "type": "text", "text": "What's in this image?" },
  { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
]}
```

- Only for `provider === 'google'` and models marked `visionCapable: true` in policy
- Add `visionCapable` flag to Gemini policy entries (2.5 Flash/Pro support vision)
- Non-vision model selected + image attached → banner: "Pick a vision-capable model"

### Local path — Gemma 3 multimodal

**Approach:** Catalog + manager changes (larger scope, isolated behind feature flag).

1. **Catalog:** Add `mmproj` file entries to Gemma 3 ≥4B models in `catalog.json`
2. **Manager:** Pass mmproj to llama-server when starting vision-capable model
3. **Extension:** Send images via llama.cpp multimodal chat format (OpenAI compat with image parts, if supported by server version)
4. **RAM guard:** mmproj adds memory — extend fit check

**Phasing within M3:** Ship Gemini vision first (extension + Mac, no manager changes). Local Gemma vision as M3b if manager work exceeds one milestone.

### UI
- Attach button + clipboard paste (extension: command; Mac: menu)
- Chip showing attached image count (exists — verify)
- Clear images before send (auto-clear after send — exists)

### Governance
- Gemini vision: US-origin Google API — already approved
- Local vision: on-device only — no policy change

### Testing
- Manual: attach PNG → Gemini 2.5 Flash → describe image
- Unit: message builder produces correct multimodal payload
- Local (M3b): Gemma 4B + mmproj smoke on 16GB Mac

### Success criteria
- Gemini vision works extension + Mac
- Local vision documented as follow-up if deferred to M3b

---

## M4 — Agent ecosystem (Phase 4)

### Goal
Harden MCP, web search, compare mode, and artifacts to production quality.

### What exists
- **MCP:** stdio client, tools merged into agent mode, VS Code settings for servers
- **Web search:** DuckDuckGo HTML scrape, `web_search` agent tool, US provider allow-list
- **Compare:** `multitask` mode, split pane, two concurrent streams
- **Artifacts:** sandboxed iframe (`sandbox="allow-scripts"`, no network), HTML code block button

### Gaps to close

**MCP client**
- Connection status per server in settings (connected / error / tool count)
- Mac: settings file editor for `fortressCode.mcpServers` (may exist — verify parity)
- Tool call approval UX: show server name + tool name before execute
- Fail closed: unknown MCP servers require explicit user config (no defaults)

**Web search**
- `@web` mention in ask mode (not only agent tool): inject search results like `@codebase`
- Render citations in assistant replies (reuse `.src-link` pattern)
- Provider registry in `shared` (same pattern as `googleEntries`) — DuckDuckGo only for v1

**Multi-model compare**
- Ensure compare works: local + Gemini, Gemini + Gemini, local + local (RAM check)
- Compare picker includes all available models (respects key gating)
- Clear compare pane on mode exit

**Artifacts**
- Support Mermaid blocks → render in artifact pane (convert to SVG client-side)
- CSP: confirm no network; `sandbox="allow-scripts"` only
- "Open as artifact" for `html`, `svg`, and `mermaid` fenced blocks

### Architecture

```text
Agent turn → MCP tools (stdio) + built-in tools (web_search, remember, file ops)
Ask mode  → @web mention → webSearch() → preamble injection with citations
Compare   → Promise.all(streamChat A, streamChat B)
Artifact  → postMessage showArtifact → iframe srcdoc
```

### Error handling
- MCP connect failure: per-server error in settings, agent continues without those tools
- Web search timeout (15s): graceful message in preamble
- Compare: if one model fails, show error in that pane only

### Testing
- MCP: mock stdio server returns tool schema; agent invokes tool
- Web search: mock fetch returns HTML fixture; citations parse
- Compare: unit test two-target resolution with different providers
- Artifacts: render HTML fixture in iframe (DOM check via e2e optional)

### Success criteria
- MCP status visible; agent uses configured tools reliably
- `@web` works in ask mode with citations
- Compare mode works across local + Gemini
- Artifacts render HTML/SVG/Mermaid safely offline

---

## 4. Milestone sequencing & releases

| Milestone | Extension version | Mac vendor pin | Release artifact |
|-----------|-------------------|----------------|------------------|
| M0 | 0.1.10 | (unchanged) | VSIX + release notes |
| M1 | 0.1.11 | f6ee024+ | VSIX + DMG |
| M2 | 0.1.12 | M1 pin | VSIX + DMG |
| M3 | 0.2.0 | M2 pin | VSIX + DMG (minor: vision) |
| M4 | 0.2.1 | M3 pin | VSIX + DMG |

Each milestone gets: spec delta (if needed) → implementation plan (`writing-plans`) → build → smoke → commit → release.

## 5. Explicitly out of scope

- OpenRouter re-enablement
- Developer mode / Fireworks cloud
- Image generation, voice STT (whisper.cpp), signing/notarization (can add later)
- Scheduled agents, share links, code interpreter sandbox

## 6. Risk register

| Risk | Mitigation |
|------|------------|
| Mac controller drift from ChatViewProvider | Sync renderer; diff controller after each extension milestone |
| PDF extraction deps bloat extension | Vendored minimal extractor; lazy load |
| Gemini vision API format changes | Pin to OpenAI-compat endpoint; unit test payload shape |
| Local mmproj RAM pressure | Extend memory guard; hide vision until mmproj downloaded |
| MCP security | Stdio only v1; no default servers; approval on tool calls |

## 7. Testing strategy (program-wide)

- **Unit:** vitest in shared + extension (existing); add Mac controller tests per milestone
- **Integration:** build both apps; no broken imports after vendor bump
- **Manual smoke:** checklist per milestone (section M0 + milestone-specific items)
- **E2E (stretch):** extend existing `@vscode/test-electron` harness for Gemini mock (optional)

---

**Next step:** Invoke `writing-plans` to produce implementation plan for **M0 + M1** first.
