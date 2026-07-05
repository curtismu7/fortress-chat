# Phase D — Local-Embeddings @codebase RAG

**Status:** Approved design
**Date:** 2026-07-05

## Goal

The VS Code extension can index the open workspace with a **local** embedding
model (run via the manager daemon / llama.cpp) and answer whole-repo questions by
retrieving relevant code chunks into the chat context. Reuses the existing
`manager` (llama.cpp lifecycle, downloads, memory guard) and `shared`
(governance, catalog) packages.

## Key decisions

- **Local embeddings** via a dedicated `llama-server --embedding` process.
- **Always-on embedding server while an index exists** — snappy `@codebase`
  queries at the cost of ~150-300MB RAM on top of the chat model.
- **Embedding model:** `nomic-embed-text-v1.5` (GGUF, 768-dim). US-origin (Nomic
  AI), code-capable, open license → passes the same US-only governance as chat
  models.
- **Chunking:** line windows (~50 lines, 10-line overlap). Language-agnostic, no
  tree-sitter.
- **Index storage:** extension storage (`globalStorageUri/<workspaceHash>/`),
  never in the user's repo. `meta.json` + packed-Float32 `vectors.bin`.
- **Retrieval:** brute-force cosine top-k (zero deps; ms at repo scale).
- **Trigger:** explicit `@codebase` mention (opt-in), via existing
  `parseMentions`.
- **Incremental re-index:** debounced `FileSystemWatcher`, hash-based per-file.

## Architecture

### 1. Manager daemon — second (embedding) server

- A second `Supervisor` instance runs
  `llama-server -m <embed-model> --embedding --pooling mean -c <ctx>
  --host 127.0.0.1 --port <p>` alongside the chat model. Started when an index
  exists; stopped on `/shutdown`.
- New token-authed routes:
  - `POST /embed` — body `{ texts: string[] }` → `{ vectors: number[][] }`.
    Proxies llama.cpp `/embedding`, preserving input order. Rejects with 428 if
    the embed model is not downloaded, 503 if the embed server is not ready.
  - `POST /embed/start` — ensure embed model downloaded + embed server running.
  - `POST /embed/stop` — stop the embed server.
- `GET /status` gains an `embed` block: `{ state, modelId, endpoint }`.
- `checkFit` (memory guard) accounts for **both** models' `memoryBytes` before
  starting either. If the pair does not fit, `/embed/start` returns the existing
  `insufficient-memory` rejection shape.

### 2. Shared — catalog + governance + types

- Add `nomic-embed-text-v1.5` to `catalog.json` (GGUF file, `sha256`/`bytes`
  pinned; `embedding: true`, `dims: 768`). Downloaded through the existing
  `/download` flow.
- Extend `modelSchema`: add optional `embedding: boolean` and `dims: number`;
  extend `family` enum with `embedding`.
- Governance: the embedding model passes the US-only policy (Nomic AI = US),
  fail-closed like every other model.
- Add request/response types for `/embed` to `api.ts`.

### 3. Extension — RAG engine (`src/rag/`)

- `chunker.ts` (pure) — split file text into line windows (~50 lines, 10-line
  overlap); return `{ startLine, endLine, text }[]`. Skips empty/whitespace-only
  windows.
- `indexer.ts` — walk the workspace honoring `.gitignore`; skip binaries,
  `node_modules`, `.git`, and files over a size cap; chunk each file; batch chunk
  texts to manager `/embed`; write to the store. Hash each file (content SHA) and
  **skip files whose hash is unchanged**. Emits progress
  `{ filesDone, filesTotal, chunksDone }`.
- `store.ts` — persistence + query. On disk:
  `globalStorageUri/<workspaceHash>/meta.json`
  (`{ dims, model, chunks: { file, startLine, endLine, fileHash }[] }`) and
  `vectors.bin` (packed Float32, `dims` per chunk, row-aligned to
  `chunks[]`). Loads vectors into a single `Float32Array` in memory. Exposes
  `topK(queryVec, k)` via brute-force cosine. Handles add/replace/remove by file.
- `retriever.ts` — embed a query string via `/embed`, call `store.topK`, return
  chunks with `file:line` ranges and text.
- `watcher.ts` — `FileSystemWatcher` on workspace files; debounce (~1s);
  re-index changed/created files, drop deleted files from the store.

### 4. Wiring into `ChatViewProvider`

- Extend the existing `parseMentions` to recognize `@codebase`.
- On a message with `@codebase`: retrieve top-k, inject the chunks into the
  **system preamble** (reusing the existing `collectContext` preamble mechanism)
  formatted with `file:line` headers, and post the source list to the webview.
- Guard: if no index exists or the embed model/server is unavailable, fall back
  to normal chat and surface a one-line notice (not a hard error).

### 5. Webview UX (`media/`)

- An **Index workspace** control plus a status line: `indexed N files /
  M chunks · updated <relative>`, with a progress bar during indexing (reuses the
  existing download-bar styles). Lives in a small RAG section in the gallery.
- `@codebase` shows as an active chip when present in the input.
- Retrieved **sources render as clickable `file:line`** under the answer.

## Data flow

- **Index:** click *Index workspace* → ensure embed model downloaded + embed
  server up (`/embed/start`) → walk/chunk/batch-embed (`/embed`) → write store →
  live progress → status line updates.
- **Query:** message contains `@codebase` → embed query (`/embed`) → `store.topK`
  → inject chunks into system preamble with citations → stream answer → show
  `file:line` sources.
- **Incremental:** file save → watcher (debounced) → re-embed that file's chunks
  → update store rows for that file.

## Error handling

- Embed model not downloaded → reuse the download prompt/UI (via the 428 from
  `/embed*`).
- Embed-server crash → banner + retry; index left intact on disk.
- No `@codebase` / empty index → normal chat, no error.
- Large repo → cap files/chunks with a **visible** notice in the status line and
  chat (no silent truncation).
- Embed model failing governance → fail-closed, index disabled.

## Testing (vitest, reuses `vscode-stub`)

- `chunker` — window sizing, overlap, boundary/short-file/empty cases.
- cosine + `topK` ranking correctness and ordering.
- `store` round-trip — write → read `vectors.bin` + `meta.json`; add/replace/remove
  by file; dims mismatch guarded.
- indexer incremental — unchanged-hash files skipped; deleted files removed.
- gitignore/binary/size filtering.
- retriever injection format (`file:line` headers, top-k count).
- `/embed` mocked at the daemon-client boundary.

## Out of scope (YAGNI)

No tree-sitter, no external vector DB, no re-ranker model, no multi-root
workspaces, no auto-index-on-open (indexing is always user-initiated).
