# Phase D — Local-Embeddings @codebase RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the extension index the open workspace with a local embedding model (run as a second llama-server via the manager) and retrieve relevant code chunks into chat when the user writes `@codebase`.

**Architecture:** The manager gains a dedicated always-on embedding server (`EmbedSupervisor`) plus `/embed`, `/embed/start`, `/embed/stop` routes. `shared` gains a catalog entry + policy entry for `nomic-embed-text-v1.5` and `/embed` types. The extension gains a `src/rag/` engine (chunker, store, indexer, retriever, watcher) wired into `ChatViewProvider` and the webview.

**Tech Stack:** TypeScript, Node built-ins only (no new runtime deps), vitest, esbuild, llama.cpp (`llama-server --embedding`), VS Code extension API.

## Global Constraints

- **No new runtime dependencies.** Use Node built-ins (`node:crypto`, `node:fs`, `node:child_process`) only. Dev-only: vitest (already present).
- **Governance is US-only, fail-closed.** The embedding model must be a US-origin `PolicyEntry` and pass `isAllowed`. Never bypass governance for embeddings.
- **Emoji rule:** only `⚠️ ✅ ❌ 🔐 ✕ ✓` allowed in code/UI text. Everything else plain text or CSS.
- **Minimal diff:** name the component, change only that. No unrelated refactors.
- **Every code step is TDD:** write the failing test, run it red, implement minimally, run it green, commit.
- **Monorepo build:** `npm run build` bundles; `npm test -w fortress-code` and `npm test -w @fortress-code/manager` / `-w @fortress-code/shared` run vitest per package. Ship to VS Code only via `npm run package -w fortress-code` after a version bump (out of scope for these tasks — done once at the end).
- **Embedding model prefixes:** `nomic-embed-text-v1.5` requires task prefixes — documents use `search_document: <text>`, queries use `search_query: <text>`. Apply them at the indexer/retriever boundary, never store them in metadata.
- **Vectors are unit-normalized on write and on query** so cosine similarity reduces to a dot product.
- **`<workspaceHash>` = `createHash('sha256').update(rootFsPath).digest('hex').slice(0, 16)`** — a workspace root always maps to the same index directory.

---

## File Structure

**shared (`packages/shared/src/`)**
- Modify `catalog.json` — add `nomic-embed-text-v1.5` entry.
- Modify `catalog.ts` — extend `modelSchema` (`embedding?`, `dims?`, `family` enum `embedding`).
- Modify `policy.ts` — add embedding org mapping so the embed model is an approved US entry.
- Modify `api.ts` — add `EmbedRequest`/`EmbedResponse`, extend `StatusResponse.embed`.

**manager (`packages/manager/src/`)**
- Create `embedSupervisor.ts` — second llama-server (`--embedding --pooling mean`) lifecycle.
- Modify `httpApi.ts` — `/embed`, `/embed/start`, `/embed/stop`, `status.embed`, two-model fit.
- Modify `index.ts` — construct `EmbedSupervisor`, pass to `createApi`, stop on shutdown.
- Create `test/embedSupervisor.test.ts`, `test/embed.test.ts`.

**extension (`packages/extension/src/`)**
- Create `rag/chunker.ts`, `rag/store.ts`, `rag/indexer.ts`, `rag/retriever.ts`, `rag/watcher.ts`, `rag/service.ts`.
- Modify `daemon.ts` — `embed()`, `embedStart()`, `embedStop()` on `DaemonClient`.
- Modify `context.ts` — `ChatContext.codebase` + preamble block.
- Modify `chat/ChatViewProvider.ts` — wire `RagService`, `@codebase` handling, webview messages.
- Modify `media/chat.html`, `media/chat.css`, `media/chat.js` — index control, status, sources.
- Create `test/chunker.test.ts`, `test/store.test.ts`, `test/indexer.test.ts`, `test/retriever.test.ts`, `test/embedClient.test.ts`.

---

## Task 1: Catalog + schema + policy for the embedding model (shared)

**Files:**
- Modify: `packages/shared/src/catalog.ts:10-21` (schema), `packages/shared/src/catalog.json`
- Modify: `packages/shared/src/policy.ts:4-20`
- Test: `packages/shared/test/catalog.test.ts` (create if absent), `packages/shared/test/policy.test.ts`

**Interfaces:**
- Consumes: existing `loadCatalog`, `PolicyEntry`, `isAllowed`.
- Produces: catalog contains a model with `id: 'nomic-embed-text-v1.5'`, `embedding: true`, `dims: 768`; `loadPolicy()` contains an approved entry for it.

- [ ] **Step 1: Write the failing test**

Create/append `packages/shared/test/catalog.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadCatalog } from '../src/catalog';
import { loadPolicy, isAllowed } from '../src';

describe('embedding model', () => {
  it('catalog has nomic embed with dims 768 and embedding flag', () => {
    const m = loadCatalog().find((x) => x.id === 'nomic-embed-text-v1.5');
    expect(m).toBeTruthy();
    expect(m!.embedding).toBe(true);
    expect(m!.dims).toBe(768);
    expect(m!.files[0].name).toMatch(/\.gguf$/);
  });
  it('policy exposes the embed model as an approved US entry', () => {
    const e = loadPolicy().find((x) => x.id === 'nomic-embed-text-v1.5');
    expect(e).toBeTruthy();
    expect(isAllowed(e!)).toBe(true);
    expect(e!.origin).toEqual({ org: 'Nomic AI', country: 'US' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fortress-code/shared -- catalog`
Expected: FAIL — model not found / `embedding` undefined.

- [ ] **Step 3: Extend the schema**

In `packages/shared/src/catalog.ts`, change the `family` enum and add two optional fields:

```ts
const modelSchema = z.object({
  id: z.string(),
  family: z.enum(['gemma3', 'gpt-oss', 'embedding']),
  displayName: z.string(),
  hfRepo: z.string(),
  files: z.array(fileSchema).min(1),
  memoryBytes: z.number().int().positive(),
  ramTierBytes: z.number().int().positive(),
  toolCalling: z.boolean(),
  license: z.string(),
  extraArgs: z.array(z.string()),
  embedding: z.boolean().optional(),
  dims: z.number().int().positive().optional(),
});
```

- [ ] **Step 4: Pin and add the catalog entry**

Obtain the real checksum/size (do NOT invent them — the download verifies sha256):

```bash
cd /tmp
F=nomic-embed-text-v1.5.f16.gguf
curl -fL -o "$F" "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/$F"
shasum -a 256 "$F"; stat -f%z "$F"
```

Append this object to `packages/shared/src/catalog.json` (fill `sha256`/`bytes` from the command above; `memoryBytes` ≈ file size + 512MB KV/overhead, `ramTierBytes` 8GB):

```json
{
  "id": "nomic-embed-text-v1.5",
  "family": "embedding",
  "displayName": "Nomic Embed Text v1.5",
  "hfRepo": "nomic-ai/nomic-embed-text-v1.5-GGUF",
  "files": [
    { "name": "nomic-embed-text-v1.5.f16.gguf", "sha256": "<PASTE_SHA256>", "bytes": <PASTE_BYTES> }
  ],
  "memoryBytes": 805306368,
  "ramTierBytes": 8589934592,
  "toolCalling": false,
  "license": "Apache-2.0",
  "extraArgs": [],
  "embedding": true,
  "dims": 768
}
```

- [ ] **Step 5: Add the policy org mapping**

In `packages/shared/src/policy.ts`, extend `LOCAL_ORG`:

```ts
const LOCAL_ORG: Record<CatalogModel['family'], string> = {
  gemma3: 'Google',
  'gpt-oss': 'OpenAI',
  embedding: 'Nomic AI',
};
```

`localEntries()` already maps every catalog model to an approved on-device US entry, so the embed model is now in `loadPolicy()`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -w @fortress-code/shared`
Expected: PASS (catalog + policy).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/catalog.ts packages/shared/src/catalog.json packages/shared/src/policy.ts packages/shared/test/catalog.test.ts
git commit -m "feat(shared): add nomic-embed-text-v1.5 to catalog + US policy"
```

---

## Task 2: `/embed` request/response + status types (shared)

**Files:**
- Modify: `packages/shared/src/api.ts:16-26`
- Test: `packages/shared/test/api.test.ts` (create — type-only, compiled check)

**Interfaces:**
- Produces: `EmbedRequest { texts: string[] }`, `EmbedResponse { vectors: number[][] }`, `EmbedStatus { state: ServerState; modelId: string | null; endpoint: string | null }`, and `StatusResponse.embed: EmbedStatus`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/api.test.ts`:

```ts
import { describe, it, expectTypeOf } from 'vitest';
import type { EmbedRequest, EmbedResponse, StatusResponse } from '../src/api';

describe('embed api types', () => {
  it('shapes compile', () => {
    expectTypeOf<EmbedRequest>().toHaveProperty('texts');
    expectTypeOf<EmbedResponse>().toHaveProperty('vectors');
    expectTypeOf<StatusResponse>().toHaveProperty('embed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fortress-code/shared -- api`
Expected: FAIL — types not exported.

- [ ] **Step 3: Add the types**

In `packages/shared/src/api.ts`, add after `DownloadProgress` and extend `StatusResponse`:

```ts
export interface EmbedRequest { texts: string[] }
export interface EmbedResponse { vectors: number[][] }
export interface EmbedStatus {
  state: ServerState;
  modelId: string | null;
  endpoint: string | null;
}
```

Add one field to `StatusResponse`:

```ts
  downloadError: string | null;
  embed: EmbedStatus;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @fortress-code/shared -- api`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/api.ts packages/shared/test/api.test.ts
git commit -m "feat(shared): add /embed request+response and status.embed types"
```

---

## Task 3: `EmbedSupervisor` (manager)

**Files:**
- Create: `packages/manager/src/embedSupervisor.ts`
- Test: `packages/manager/test/embedSupervisor.test.ts`

**Interfaces:**
- Consumes: `llamaServerPath` from `./binary`, `CatalogModel`.
- Produces: `class EmbedSupervisor { state: ServerState; modelId: string|null; port: number|null; endpoint(): string|null; managedPid(): number|null; buildArgs(modelPath: string): string[]; start(model, modelPath): Promise<void>; stop(): Promise<void> }`. `buildArgs` is a pure method so it is unit-testable without spawning.

- [ ] **Step 1: Write the failing test**

Create `packages/manager/test/embedSupervisor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { EmbedSupervisor } from '../src/embedSupervisor';

describe('EmbedSupervisor.buildArgs', () => {
  it('runs llama-server in embedding mode with mean pooling, no --jinja', () => {
    const s = new EmbedSupervisor();
    (s as any).port = 9999;
    const args = s.buildArgs('/models/nomic.gguf');
    expect(args).toContain('--embedding');
    expect(args).toEqual(expect.arrayContaining(['--pooling', 'mean']));
    expect(args).toEqual(expect.arrayContaining(['-m', '/models/nomic.gguf']));
    expect(args).toEqual(expect.arrayContaining(['--port', '9999']));
    expect(args).not.toContain('--jinja');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fortress-code/manager -- embedSupervisor`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `EmbedSupervisor`**

Create `packages/manager/src/embedSupervisor.ts` (mirrors `Supervisor` but embedding args; smaller ctx):

```ts
import { spawn, ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { CatalogModel, ServerState } from '@fortress-code/shared';
import { llamaServerPath } from './binary';

const EMBED_CTX = 8192;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export class EmbedSupervisor {
  state: ServerState = 'idle';
  modelId: string | null = null;
  port: number | null = null;
  private child: ChildProcess | null = null;
  private stderrRing: string[] = [];
  private expectedExit = false;

  managedPid(): number | null { return this.child?.pid ?? null; }
  endpoint(): string | null { return this.state === 'ready' && this.port ? `http://127.0.0.1:${this.port}` : null; }

  buildArgs(modelPath: string): string[] {
    return [
      '-m', modelPath, '-ngl', '99', '-c', String(EMBED_CTX),
      '--embedding', '--pooling', 'mean',
      '--host', '127.0.0.1', '--port', String(this.port),
    ];
  }

  async start(model: CatalogModel, modelPath: string): Promise<void> {
    if (this.child) await this.stop();
    this.stderrRing = [];
    this.expectedExit = false;
    this.port = await freePort();
    this.state = 'starting';
    this.child = spawn(llamaServerPath(), this.buildArgs(modelPath), { stdio: ['ignore', 'ignore', 'pipe'] });
    this.child.stderr!.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        if (!line.trim()) continue;
        this.stderrRing.push(line);
        if (this.stderrRing.length > 50) this.stderrRing.shift();
      }
    });
    this.child.on('exit', () => {
      this.child = null;
      if (!this.expectedExit) this.state = 'crashed';
    });
    this.modelId = model.id;
    await this.waitReady();
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (this.state === 'crashed') throw new Error('embed server crashed:\n' + this.stderrRing.join('\n'));
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) { this.state = 'ready'; return; }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.stop();
    throw new Error('embed server did not become ready within 120s');
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) { this.state = 'idle'; this.modelId = null; return; }
    this.state = 'stopping';
    this.expectedExit = true;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.on('exit', () => { clearTimeout(t); resolve(); });
    });
    this.child = null;
    this.modelId = null;
    this.state = 'idle';
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @fortress-code/manager -- embedSupervisor`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/manager/src/embedSupervisor.ts packages/manager/test/embedSupervisor.test.ts
git commit -m "feat(manager): EmbedSupervisor — llama-server embedding process"
```

---

## Task 4: `/embed` routes + `status.embed` + two-model fit (manager)

**Files:**
- Modify: `packages/manager/src/httpApi.ts`
- Modify: `packages/manager/src/index.ts:24-31`
- Test: `packages/manager/test/embed.test.ts`

**Interfaces:**
- Consumes: `EmbedSupervisor`, `EmbedResponse`, `checkFit`.
- Produces: `POST /embed` → `{ vectors }`; `POST /embed/start`; `POST /embed/stop`; `GET /status` includes `embed`. `createApi` gains `embed: EmbedSupervisor` in `ApiDeps`.

- [ ] **Step 1: Write the failing test**

Create `packages/manager/test/embed.test.ts` — spins a fake embedding server (llama.cpp `/v1/embeddings` shape) and asserts the manager proxy returns vectors in input order:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { createApi } from '../src/httpApi';
import { EmbedSupervisor } from '../src/embedSupervisor';

let embedSrv: Server; let embedUrl: string;
beforeAll(async () => {
  embedSrv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { input } = JSON.parse(body || '{}');
      const data = (input as string[]).map((t, i) => ({ embedding: [t.length, i], index: i }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((r) => embedSrv.listen(0, '127.0.0.1', r));
  embedUrl = `http://127.0.0.1:${(embedSrv.address() as any).port}`;
});
afterAll(() => embedSrv.close());

function fakeEmbed(): EmbedSupervisor {
  const e = new EmbedSupervisor();
  e.state = 'ready'; e.modelId = 'nomic-embed-text-v1.5';
  (e as any).port = Number(embedUrl.split(':').pop());
  return e;
}

async function call(api: Server, path: string, body: unknown) {
  const port = (api.address() as any).port;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'x-fc-token': 't', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /embed', () => {
  it('returns vectors in input order', async () => {
    const embed = fakeEmbed();
    const api = createApi({
      supervisor: { state: 'idle', modelId: null, endpoint: () => null, crashLog: null, managedPid: () => null, stop: async () => {} } as any,
      embed, token: 't', onActivity: () => {}, availableBytes: async () => 32 * 1024 ** 3,
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    const res = await call(api, '/embed', { texts: ['ab', 'cde'] });
    expect(res.status).toBe(200);
    const { vectors } = await res.json();
    expect(vectors).toEqual([[2, 0], [3, 1]]);
    api.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fortress-code/manager -- embed.test`
Expected: FAIL — `ApiDeps` has no `embed`; `/embed` returns 404.

- [ ] **Step 3: Extend `ApiDeps` and add routes**

In `packages/manager/src/httpApi.ts`: import types and `EmbedSupervisor`, add `embed` to `ApiDeps`, and add the routes. At the top:

```ts
import type { ... , EmbedResponse } from '@fortress-code/shared';
import { EmbedSupervisor } from './embedSupervisor';
```

Add to `ApiDeps`:

```ts
export interface ApiDeps {
  supervisor: Supervisor;
  embed: EmbedSupervisor;
  token: string;
  onActivity: () => void;
  availableBytes: () => Promise<number>;
}
```

Add `embed` to the `GET /status` body:

```ts
            downloadError,
            embed: { state: deps.embed.state, modelId: deps.embed.modelId, endpoint: deps.embed.endpoint() },
```

Add these cases before `default:`:

```ts
        case 'POST /embed/start': {
          const m = catalog.find((x) => x.embedding);
          if (!m) return send(res, 404, { error: 'no embedding model in catalog' });
          if (!binaryInstalled() || !modelDownloaded(m)) return send(res, 428, { error: 'embed model not downloaded' });
          if (deps.embed.state === 'ready') return send(res, 200, {});
          const available = await deps.availableBytes();
          const chatBytes = deps.supervisor.state === 'ready'
            ? (catalog.find((x) => x.id === deps.supervisor.modelId)?.memoryBytes ?? 0) : 0;
          const fit = checkFit(m.memoryBytes, available - chatBytes, totalRamBytes());
          if (!fit.fits) return send(res, 409, { reason: 'insufficient-memory', requiredBytes: fit.requiredBytes, availableBytes: fit.availableBytes, wouldFitAfterForeignKill: false, foreign: [] });
          await deps.embed.start(m, modelPath(m));
          return send(res, 200, {});
        }
        case 'POST /embed/stop': { await deps.embed.stop(); return send(res, 200, {}); }
        case 'POST /embed': {
          const { texts } = await readBody(req);
          if (!Array.isArray(texts) || texts.some((t) => typeof t !== 'string')) return send(res, 400, { error: 'texts must be string[]' });
          const ep = deps.embed.endpoint();
          if (!ep) return send(res, 503, { error: 'embed server not ready' });
          const up = await fetch(`${ep}/v1/embeddings`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ input: texts }),
          });
          if (!up.ok) return send(res, 502, { error: `embed upstream HTTP ${up.status}` });
          const json = await up.json();
          const rows = (json.data as { embedding: number[]; index: number }[]).slice().sort((a, b) => a.index - b.index);
          const body: EmbedResponse = { vectors: rows.map((r) => r.embedding) };
          return send(res, 200, body);
        }
```

- [ ] **Step 4: Wire `EmbedSupervisor` in `index.ts` and stop it on shutdown**

In `packages/manager/src/index.ts`, import and construct it, pass to `createApi`:

```ts
import { EmbedSupervisor } from './embedSupervisor';
```

```ts
  const supervisor = new Supervisor();
  const embed = new EmbedSupervisor();
  let lastActivity = Date.now();
  const api = createApi({
    supervisor,
    embed,
    token,
    onActivity: () => { lastActivity = Date.now(); },
    availableBytes: readAvailableBytes,
  });
```

In the idle-timeout handler, also stop embed:

```ts
      await supervisor.stop();
      await embed.stop();
```

Also add `await deps.embed.stop();` in the existing `POST /shutdown` case in `httpApi.ts`, right after `await deps.supervisor.stop();`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w @fortress-code/manager -- embed.test`
Expected: PASS (vectors ordered `[[2,0],[3,1]]`).

- [ ] **Step 6: Full manager suite + typecheck**

Run: `npm test -w @fortress-code/manager && npm run build`
Expected: PASS; build succeeds (the `StatusResponse.embed` field now always supplied).

- [ ] **Step 7: Commit**

```bash
git add packages/manager/src/httpApi.ts packages/manager/src/index.ts packages/manager/test/embed.test.ts
git commit -m "feat(manager): /embed, /embed/start, /embed/stop, status.embed, two-model fit"
```

---

## Task 5: `DaemonClient` embed methods (extension)

**Files:**
- Modify: `packages/extension/src/daemon.ts:29-35`
- Test: `packages/extension/src/test/embedClient.test.ts`

**Interfaces:**
- Produces: `DaemonClient.embed(texts: string[]): Promise<number[][]>`, `embedStart(): Promise<{ ok: boolean }>`, `embedStop(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `packages/extension/src/test/embedClient.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DaemonClient } from '../daemon';

afterEach(() => vi.restoreAllMocks());

describe('DaemonClient.embed', () => {
  it('posts texts and returns vectors', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ vectors: [[1, 2]] }), { status: 200 }),
    );
    const c = new DaemonClient(1234, 'tok');
    const v = await c.embed(['hi']);
    expect(v).toEqual([[1, 2]]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/embed');
    expect(JSON.parse((init as any).body)).toEqual({ texts: ['hi'] });
  });

  it('embedStart reports ok:false on 409', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 409 }));
    const c = new DaemonClient(1234, 'tok');
    expect(await c.embedStart()).toEqual({ ok: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w fortress-code -- embedClient`
Expected: FAIL — `embed` not a function.

- [ ] **Step 3: Implement the methods**

In `packages/extension/src/daemon.ts`, add to `class DaemonClient` (after `start`):

```ts
  async embed(texts: string[]): Promise<number[][]> {
    const res = await this.call('/embed', { method: 'POST', body: JSON.stringify({ texts }) });
    if (!res.ok) throw new Error(`embed failed: HTTP ${res.status}`);
    return (await res.json()).vectors;
  }
  async embedStart(): Promise<{ ok: boolean }> {
    const res = await this.call('/embed/start', { method: 'POST', body: '{}' });
    return { ok: res.status === 200 };
  }
  async embedStop(): Promise<void> { await this.call('/embed/stop', { method: 'POST', body: '{}' }); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w fortress-code -- embedClient`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/daemon.ts packages/extension/src/test/embedClient.test.ts
git commit -m "feat(extension): DaemonClient embed/embedStart/embedStop"
```

---

## Task 6: `chunker.ts` (extension, pure)

**Files:**
- Create: `packages/extension/src/rag/chunker.ts`
- Test: `packages/extension/src/test/chunker.test.ts`

**Interfaces:**
- Produces: `interface Chunk { startLine: number; endLine: number; text: string }` and `chunkFile(text: string, windowLines = 50, overlap = 10): Chunk[]`. Lines are 1-based; windows step by `windowLines - overlap`; whitespace-only windows are dropped.

- [ ] **Step 1: Write the failing test**

Create `packages/extension/src/test/chunker.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { chunkFile } from '../rag/chunker';

describe('chunkFile', () => {
  it('windows with overlap and 1-based line numbers', () => {
    const text = Array.from({ length: 120 }, (_, i) => `line${i + 1}`).join('\n');
    const chunks = chunkFile(text, 50, 10);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(50);
    expect(chunks[1].startLine).toBe(41); // step = 40
    expect(chunks.at(-1)!.endLine).toBe(120);
  });
  it('returns one chunk for a short file', () => {
    const chunks = chunkFile('a\nb\nc', 50, 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 3 });
  });
  it('drops whitespace-only windows', () => {
    expect(chunkFile('\n\n   \n', 50, 10)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w fortress-code -- chunker`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `chunkFile`**

Create `packages/extension/src/rag/chunker.ts`:

```ts
export interface Chunk { startLine: number; endLine: number; text: string }

export function chunkFile(text: string, windowLines = 50, overlap = 10): Chunk[] {
  const lines = text.split('\n');
  const step = Math.max(1, windowLines - overlap);
  const out: Chunk[] = [];
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + windowLines);
    const slice = lines.slice(start, end);
    if (slice.join('').trim().length > 0) {
      out.push({ startLine: start + 1, endLine: end, text: slice.join('\n') });
    }
    if (end === lines.length) break;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w fortress-code -- chunker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/rag/chunker.ts packages/extension/src/test/chunker.test.ts
git commit -m "feat(rag): line-window chunker"
```

---

## Task 7: `store.ts` — persistence + cosine top-k (extension)

**Files:**
- Create: `packages/extension/src/rag/store.ts`
- Test: `packages/extension/src/test/store.test.ts`

**Interfaces:**
- Consumes: nothing external (Node `fs`, `path`, `crypto`).
- Produces:
  - `interface ChunkMeta { file: string; startLine: number; endLine: number; fileHash: string }`
  - `interface Retrieved extends ChunkMeta { score: number }`
  - `class VectorStore` with: static `open(dir: string, dims: number, model: string): VectorStore` (loads if present, else empty); `replaceFile(file: string, fileHash: string, rows: { meta: Omit<ChunkMeta,'file'|'fileHash'>; vector: number[] }[]): void`; `removeFile(file: string): void`; `hashOf(file: string): string | null`; `topK(queryVec: number[], k: number): Retrieved[]`; `save(): void`; `stats(): { files: number; chunks: number }`. Vectors are unit-normalized on insert; `topK` normalizes the query and ranks by dot product.

- [ ] **Step 1: Write the failing test**

Create `packages/extension/src/test/store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorStore } from '../rag/store';

const dir = () => mkdtempSync(join(tmpdir(), 'fc-store-'));

describe('VectorStore', () => {
  it('ranks by cosine and round-trips through disk', () => {
    const d = dir();
    const s = VectorStore.open(d, 2, 'nomic');
    s.replaceFile('a.ts', 'h1', [{ meta: { startLine: 1, endLine: 5 }, vector: [1, 0] }]);
    s.replaceFile('b.ts', 'h2', [{ meta: { startLine: 1, endLine: 5 }, vector: [0, 1] }]);
    s.save();

    const reloaded = VectorStore.open(d, 2, 'nomic');
    const top = reloaded.topK([1, 0], 1);
    expect(top[0].file).toBe('a.ts');
    expect(top[0].score).toBeGreaterThan(0.99);
    expect(reloaded.stats()).toEqual({ files: 2, chunks: 2 });
    expect(reloaded.hashOf('a.ts')).toBe('h1');
  });

  it('replaceFile swaps a file\'s rows; removeFile drops them', () => {
    const s = VectorStore.open(dir(), 2, 'nomic');
    s.replaceFile('a.ts', 'h1', [{ meta: { startLine: 1, endLine: 5 }, vector: [1, 0] }]);
    s.replaceFile('a.ts', 'h2', [{ meta: { startLine: 1, endLine: 9 }, vector: [1, 0] }]);
    expect(s.stats().chunks).toBe(1);
    expect(s.hashOf('a.ts')).toBe('h2');
    s.removeFile('a.ts');
    expect(s.stats()).toEqual({ files: 0, chunks: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w fortress-code -- store`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `VectorStore`**

Create `packages/extension/src/rag/store.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ChunkMeta { file: string; startLine: number; endLine: number; fileHash: string }
export interface Retrieved extends ChunkMeta { score: number }
interface MetaDoc { dims: number; model: string; chunks: ChunkMeta[] }

function normalize(v: number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export class VectorStore {
  private constructor(
    private dir: string,
    public dims: number,
    private model: string,
    private chunks: ChunkMeta[],
    private vectors: Float32Array, // row-aligned to chunks, length = chunks.length * dims
  ) {}

  static open(dir: string, dims: number, model: string): VectorStore {
    const metaPath = join(dir, 'meta.json');
    const vecPath = join(dir, 'vectors.bin');
    if (existsSync(metaPath) && existsSync(vecPath)) {
      const meta: MetaDoc = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meta.dims === dims && meta.model === model) {
        const buf = readFileSync(vecPath);
        const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        return new VectorStore(dir, dims, model, meta.chunks, vectors);
      }
    }
    return new VectorStore(dir, dims, model, [], new Float32Array(0));
  }

  hashOf(file: string): string | null {
    const c = this.chunks.find((x) => x.file === file);
    return c ? c.fileHash : null;
  }

  private rebuild(chunks: ChunkMeta[], vecRows: Float32Array[]): void {
    const flat = new Float32Array(vecRows.length * this.dims);
    vecRows.forEach((row, i) => flat.set(row, i * this.dims));
    this.chunks = chunks;
    this.vectors = flat;
  }

  private rows(): Float32Array[] {
    const out: Float32Array[] = [];
    for (let i = 0; i < this.chunks.length; i++) out.push(this.vectors.subarray(i * this.dims, (i + 1) * this.dims));
    return out;
  }

  replaceFile(file: string, fileHash: string, rows: { meta: { startLine: number; endLine: number }; vector: number[] }[]): void {
    const keepChunks: ChunkMeta[] = [];
    const keepVecs: Float32Array[] = [];
    const existing = this.rows();
    this.chunks.forEach((c, i) => { if (c.file !== file) { keepChunks.push(c); keepVecs.push(existing[i]); } });
    for (const r of rows) {
      keepChunks.push({ file, startLine: r.meta.startLine, endLine: r.meta.endLine, fileHash });
      keepVecs.push(normalize(r.vector));
    }
    this.rebuild(keepChunks, keepVecs);
  }

  removeFile(file: string): void {
    const existing = this.rows();
    const keepChunks: ChunkMeta[] = [];
    const keepVecs: Float32Array[] = [];
    this.chunks.forEach((c, i) => { if (c.file !== file) { keepChunks.push(c); keepVecs.push(existing[i]); } });
    this.rebuild(keepChunks, keepVecs);
  }

  topK(queryVec: number[], k: number): Retrieved[] {
    const q = normalize(queryVec);
    const scored = this.chunks.map((c, i) => {
      let dot = 0;
      const base = i * this.dims;
      for (let j = 0; j < this.dims; j++) dot += this.vectors[base + j] * q[j];
      return { ...c, score: dot };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  stats(): { files: number; chunks: number } {
    return { files: new Set(this.chunks.map((c) => c.file)).size, chunks: this.chunks.length };
  }

  save(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const meta: MetaDoc = { dims: this.dims, model: this.model, chunks: this.chunks };
    writeFileSync(join(this.dir, 'meta.json'), JSON.stringify(meta));
    writeFileSync(join(this.dir, 'vectors.bin'), Buffer.from(this.vectors.buffer, this.vectors.byteOffset, this.vectors.byteLength));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w fortress-code -- store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/rag/store.ts packages/extension/src/test/store.test.ts
git commit -m "feat(rag): VectorStore — normalized vectors, cosine top-k, disk persistence"
```

---

## Task 8: `indexer.ts` — walk + filter + chunk + incremental (extension)

**Files:**
- Create: `packages/extension/src/rag/indexer.ts`
- Test: `packages/extension/src/test/indexer.test.ts`

**Interfaces:**
- Consumes: `chunkFile` (Task 6), `VectorStore` (Task 7); an `embed(texts: string[]) => Promise<number[][]>` callback (injected — the caller passes `client.embed`).
- Produces:
  - `listFiles(root: string): string[]` — workspace-relative files honoring `.gitignore` via `git ls-files -co --exclude-standard`, falling back to a manual walk that skips `node_modules`, `.git`, `dist`, `out`.
  - `isProbablyBinary(buf: Buffer): boolean` — true if a NUL byte appears in the first 8000 bytes.
  - `sha(text: string): string` — sha256 hex.
  - `const MAX_FILE_BYTES = 512_000`, `const MAX_FILES = 4000`.
  - `interface IndexProgress { filesDone: number; filesTotal: number; chunksDone: number; capped: boolean }`
  - `async indexWorkspace(root: string, store: VectorStore, embed: (t: string[]) => Promise<number[][]>, onProgress: (p: IndexProgress) => void, signal?: AbortSignal): Promise<void>` — for each eligible file: if `store.hashOf(rel) === sha(content)` skip; else chunk, embed chunk texts prefixed with `search_document: `, `store.replaceFile(...)`; drops files no longer present; calls `store.save()` at the end.

- [ ] **Step 1: Write the failing test**

Create `packages/extension/src/test/indexer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isProbablyBinary, sha, indexWorkspace, MAX_FILE_BYTES } from '../rag/indexer';
import { VectorStore } from '../rag/store';

describe('indexer helpers', () => {
  it('detects binary by NUL byte', () => {
    expect(isProbablyBinary(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
    expect(isProbablyBinary(Buffer.from('hello world'))).toBe(false);
  });
  it('sha is stable', () => expect(sha('x')).toBe(sha('x')));
});

describe('indexWorkspace incremental', () => {
  it('embeds changed files and skips unchanged ones on re-run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fc-idx-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    const store = VectorStore.open(mkdtempSync(join(tmpdir(), 'fc-idxstore-')), 2, 'nomic');

    let calls = 0;
    const embed = async (texts: string[]) => { calls += texts.length; return texts.map(() => [1, 0]); };
    await indexWorkspace(root, store, embed, () => {});
    expect(calls).toBeGreaterThan(0);
    expect(store.stats().chunks).toBeGreaterThan(0);

    const before = calls;
    await indexWorkspace(root, store, embed, () => {}); // nothing changed
    expect(calls).toBe(before); // unchanged file skipped, no new embed calls
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w fortress-code -- indexer`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `indexer.ts`**

Create `packages/extension/src/rag/indexer.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { VectorStore } from './store';

export const MAX_FILE_BYTES = 512_000;
export const MAX_FILES = 4000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'build', 'coverage']);

export interface IndexProgress { filesDone: number; filesTotal: number; chunksDone: number; capped: boolean }

export function sha(text: string): string { return createHash('sha256').update(text).digest('hex'); }

export function isProbablyBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(root, abs, out); }
    else if (entry.isFile()) out.push(relative(root, abs).split(sep).join('/'));
  }
}

export function listFiles(root: string): string[] {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    const out: string[] = [];
    walk(root, root, out);
    return out;
  }
}

export async function indexWorkspace(
  root: string,
  store: VectorStore,
  embed: (texts: string[]) => Promise<number[][]>,
  onProgress: (p: IndexProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { chunkFile } = await import('./chunker');
  let all = listFiles(root);
  const capped = all.length > MAX_FILES;
  if (capped) all = all.slice(0, MAX_FILES);
  const present = new Set(all);
  let filesDone = 0, chunksDone = 0;

  for (const rel of all) {
    if (signal?.aborted) return;
    filesDone++;
    const abs = join(root, rel);
    let buf: Buffer;
    try { const st = statSync(abs); if (st.size > MAX_FILE_BYTES) { onProgress({ filesDone, filesTotal: all.length, chunksDone, capped }); continue; } buf = readFileSync(abs); }
    catch { continue; }
    if (isProbablyBinary(buf)) { onProgress({ filesDone, filesTotal: all.length, chunksDone, capped }); continue; }
    const text = buf.toString('utf8');
    const h = sha(text);
    if (store.hashOf(rel) === h) { onProgress({ filesDone, filesTotal: all.length, chunksDone, capped }); continue; }
    const chunks = chunkFile(text);
    if (chunks.length === 0) { store.replaceFile(rel, h, []); continue; }
    const vectors = await embed(chunks.map((c) => `search_document: ${c.text}`));
    store.replaceFile(rel, h, chunks.map((c, i) => ({ meta: { startLine: c.startLine, endLine: c.endLine }, vector: vectors[i] })));
    chunksDone += chunks.length;
    onProgress({ filesDone, filesTotal: all.length, chunksDone, capped });
  }
  // drop files removed from disk / no longer eligible
  for (const gone of store.stats().files ? filesToDrop(store, present) : []) store.removeFile(gone);
  store.save();
}

function filesToDrop(store: VectorStore, present: Set<string>): string[] {
  // VectorStore has no file list accessor; derive from a topK-free scan is unavailable,
  // so we expose the set via stats-independent tracking: rebuild uses replaceFile only.
  // Present-set filtering happens by removing any indexed file not in `present`.
  return (store as unknown as { chunks: { file: string }[] }).chunks
    .map((c) => c.file)
    .filter((f, i, a) => a.indexOf(f) === i && !present.has(f));
}
```

Note: `filesToDrop` reads the store's private `chunks` deliberately to avoid widening the public API for a one-off cleanup. If a reviewer prefers, add a `files(): string[]` accessor to `VectorStore` and use it here.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w fortress-code -- indexer`
Expected: PASS (second run adds zero embed calls).

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/rag/indexer.ts packages/extension/src/test/indexer.test.ts
git commit -m "feat(rag): incremental workspace indexer (git-aware walk, binary/size filters)"
```

---

## Task 9: `retriever.ts` — embed query + top-k + inject format (extension)

**Files:**
- Create: `packages/extension/src/rag/retriever.ts`
- Test: `packages/extension/src/test/retriever.test.ts`

**Interfaces:**
- Consumes: `VectorStore` (Task 7), an `embed` callback.
- Produces:
  - `interface CodeHit { file: string; startLine: number; endLine: number }`
  - `async retrieve(query: string, store: VectorStore, embed: (t: string[]) => Promise<number[][]>, k = 8): Promise<CodeHit[]>` — embeds `search_query: <query>`, returns top-k hits (file + line range).
  - `buildCodebaseBlock(hits: { file: string; startLine: number; endLine: number; text: string }[]): string` — formats a `[codebase]` context block with `file:Lstart-Lend` headers and fenced text.

- [ ] **Step 1: Write the failing test**

Create `packages/extension/src/test/retriever.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retrieve, buildCodebaseBlock } from '../rag/retriever';
import { VectorStore } from '../rag/store';

describe('retrieve', () => {
  it('embeds the query with the search_query prefix and returns nearest hits', async () => {
    const store = VectorStore.open(mkdtempSync(join(tmpdir(), 'fc-ret-')), 2, 'nomic');
    store.replaceFile('auth.ts', 'h', [{ meta: { startLine: 1, endLine: 9 }, vector: [1, 0] }]);
    store.replaceFile('math.ts', 'h', [{ meta: { startLine: 1, endLine: 9 }, vector: [0, 1] }]);
    let seen = '';
    const embed = async (t: string[]) => { seen = t[0]; return [[1, 0]]; };
    const hits = await retrieve('how does login work', store, embed, 1);
    expect(seen.startsWith('search_query: ')).toBe(true);
    expect(hits[0].file).toBe('auth.ts');
  });

  it('buildCodebaseBlock includes file:line headers', () => {
    const block = buildCodebaseBlock([{ file: 'a.ts', startLine: 2, endLine: 4, text: 'code' }]);
    expect(block).toContain('[codebase] a.ts:L2-L4');
    expect(block).toContain('code');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w fortress-code -- retriever`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `retriever.ts`**

Create `packages/extension/src/rag/retriever.ts`:

```ts
import type { VectorStore } from './store';

export interface CodeHit { file: string; startLine: number; endLine: number }

export async function retrieve(
  query: string,
  store: VectorStore,
  embed: (texts: string[]) => Promise<number[][]>,
  k = 8,
): Promise<CodeHit[]> {
  const [q] = await embed([`search_query: ${query}`]);
  return store.topK(q, k).map((h) => ({ file: h.file, startLine: h.startLine, endLine: h.endLine }));
}

export function buildCodebaseBlock(hits: { file: string; startLine: number; endLine: number; text: string }[]): string {
  if (hits.length === 0) return '';
  const blocks = hits.map((h) => `[codebase] ${h.file}:L${h.startLine}-L${h.endLine}\n\`\`\`\n${h.text}\n\`\`\``);
  return `The following repository excerpts were retrieved for this question:\n\n${blocks.join('\n\n')}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w fortress-code -- retriever`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/rag/retriever.ts packages/extension/src/test/retriever.test.ts
git commit -m "feat(rag): retriever — query embed + codebase context block"
```

---

## Task 10: `RagService` + `ChatViewProvider` wiring + `context.ts` block (extension)

**Files:**
- Create: `packages/extension/src/rag/service.ts`
- Modify: `packages/extension/src/context.ts:3,29-35`
- Modify: `packages/extension/src/chat/ChatViewProvider.ts` (imports, `collectContext`, `onMessage`, `pushStatus`)
- Test: `packages/extension/src/test/ragBlock.test.ts`

**Interfaces:**
- Consumes: `indexWorkspace`, `IndexProgress`, `retrieve`, `buildCodebaseBlock`, `VectorStore`, `DaemonClient`.
- Produces:
  - `ChatContext.codebase: { file: string; startLine: number; endLine: number; text: string }[] | null` (added to the interface); `buildContextPreamble` appends `buildCodebaseBlock(...)` when present.
  - `class RagService` with: `constructor(private storeDir: string, private dims: number, private root: string)`, `hasIndex(): boolean`, `stats()`, `async index(client: DaemonClient, onProgress): Promise<void>` (calls `client.embedStart()` then `indexWorkspace`), `async retrieveHits(client: DaemonClient, query: string): Promise<{ file; startLine; endLine; text }[]>` (retrieve + read the lines back from disk for the block).

- [ ] **Step 1: Write the failing test** (context block only — the service is thin glue and is smoke-tested via the extension host)

Create `packages/extension/src/test/ragBlock.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildContextPreamble, type ChatContext } from '../context';

describe('buildContextPreamble with codebase', () => {
  it('appends retrieved codebase excerpts', () => {
    const ctx: ChatContext = {
      file: null, selection: null, mentions: [],
      codebase: [{ file: 'auth.ts', startLine: 1, endLine: 3, text: 'login()' }],
    };
    const p = buildContextPreamble(ctx);
    expect(p).toContain('[codebase] auth.ts:L1-L3');
    expect(p).toContain('login()');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w fortress-code -- ragBlock`
Expected: FAIL — `codebase` not on `ChatContext`.

- [ ] **Step 3: Extend `context.ts`**

In `packages/extension/src/context.ts`, add to `ChatContext` and to `buildContextPreamble`:

```ts
export interface ChatContext {
  file: AttachedFile | null;
  selection: SelectionCtx | null;
  mentions: AttachedFile[];
  codebase?: { file: string; startLine: number; endLine: number; text: string }[] | null;
}
```

Add the import at the top and append the block at the end of `buildContextPreamble` (before `return`):

```ts
import { buildCodebaseBlock } from './rag/retriever';
```

```ts
  for (const mn of ctx.mentions) parts.push(fileBlock('mentioned file', mn));
  if (ctx.codebase && ctx.codebase.length) parts.push(buildCodebaseBlock(ctx.codebase));
  return parts.join('\n\n');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w fortress-code -- ragBlock`
Expected: PASS.

- [ ] **Step 5: Implement `RagService`**

Create `packages/extension/src/rag/service.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DaemonClient } from '../daemon';
import { VectorStore } from './store';
import { indexWorkspace, type IndexProgress } from './indexer';
import { retrieve } from './retriever';

export class RagService {
  private store: VectorStore;
  constructor(private storeDir: string, private dims: number, private root: string, private model = 'nomic-embed-text-v1.5') {
    this.store = VectorStore.open(storeDir, dims, this.model);
  }
  hasIndex(): boolean { return this.store.stats().chunks > 0; }
  stats(): { files: number; chunks: number } { return this.store.stats(); }

  async index(client: DaemonClient, onProgress: (p: IndexProgress) => void, signal?: AbortSignal): Promise<void> {
    const started = await client.embedStart();
    if (!started.ok) throw new Error('embedding server could not start (check RAM or download the embed model)');
    await indexWorkspace(this.root, this.store, (t) => client.embed(t), onProgress, signal);
  }

  async retrieveHits(client: DaemonClient, query: string): Promise<{ file: string; startLine: number; endLine: number; text: string }[]> {
    if (!this.hasIndex()) return [];
    await client.embedStart();
    const hits = await retrieve(query, this.store, (t) => client.embed(t), 8);
    return hits.map((h) => {
      let text = '';
      try {
        const lines = readFileSync(join(this.root, h.file), 'utf8').split('\n');
        text = lines.slice(h.startLine - 1, h.endLine).join('\n');
      } catch { /* file gone; skip body */ }
      return { ...h, text };
    }).filter((h) => h.text);
  }
}
```

- [ ] **Step 6: Wire into `ChatViewProvider`**

In `packages/extension/src/chat/ChatViewProvider.ts`:

Add imports:

```ts
import { createHash } from 'node:crypto';
import { RagService } from '../rag/service';
```

Add a lazily-created field + helper (near the other private fields, e.g. after `private client`):

```ts
  private rag: RagService | null = null;

  private ragService(): RagService | null {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return null;
    if (!this.rag) {
      const hash = createHash('sha256').update(root).digest('hex').slice(0, 16);
      const dir = vscode.Uri.joinPath(this.context.globalStorageUri, 'rag', hash).fsPath;
      this.rag = new RagService(dir, 768, root);
    }
    return this.rag;
  }
```

In `collectContext`, after building `mentions`, handle `@codebase` (parseMentions already yields `'codebase'`). Replace the `return { file, selection, mentions };` line with:

```ts
    let codebase: ChatContext['codebase'] = null;
    const rag = this.ragService();
    if (rag && parseMentions(userText).includes('codebase') && this.client) {
      try { codebase = await rag.retrieveHits(this.client, userText); }
      catch (e) { this.banner(`@codebase retrieval failed: ${e instanceof Error ? e.message : e}`); }
    }
    return { file, selection, mentions, codebase };
```

In `onMessage`, add an `indexWorkspace` case (near `downloadModel`):

```ts
        case 'indexWorkspace': {
          const rag = this.ragService();
          if (!rag) { this.banner('Open a folder to index a codebase.'); return; }
          const client = await this.ensureClient();
          this.post({ type: 'ragProgress', progress: { filesDone: 0, filesTotal: 0, chunksDone: 0, capped: false } });
          try {
            await rag.index(client, (p) => this.post({ type: 'ragProgress', progress: p }));
            this.post({ type: 'ragStatus', stats: rag.stats(), indexing: false });
          } catch (e) {
            this.banner(`Indexing failed: ${e instanceof Error ? e.message : e}`);
            this.post({ type: 'ragStatus', stats: rag.stats(), indexing: false });
          }
          return;
        }
```

In `pushStatus`, after posting `state`, also post RAG status so the UI shows the current index:

```ts
      this.post({ type: 'state', status, selectedId: this.selected?.id ?? null });
      const rag = this.ragService();
      if (rag) this.post({ type: 'ragStatus', stats: rag.stats(), indexing: false });
```

Filter the synthetic `'codebase'` mention out of the file-mention loop so it is not read as a file — in `collectContext`, change the mention loop guard:

```ts
    if (root) for (const mrel of parseMentions(userText)) {
      if (mrel === 'codebase') continue;
      const mid = 'mention:' + mrel;
```

- [ ] **Step 7: Run the extension suite + build**

Run: `npm test -w fortress-code && npm run build`
Expected: PASS; build succeeds.

- [ ] **Step 8: Commit**

```bash
git add packages/extension/src/rag/service.ts packages/extension/src/context.ts packages/extension/src/chat/ChatViewProvider.ts packages/extension/src/test/ragBlock.test.ts
git commit -m "feat(rag): RagService + @codebase wiring in ChatViewProvider"
```

---

## Task 11: `watcher.ts` — debounced incremental re-index (extension)

**Files:**
- Create: `packages/extension/src/rag/watcher.ts`
- Modify: `packages/extension/src/chat/ChatViewProvider.ts` (start the watcher when an index exists)
- Test: `packages/extension/src/test/watcher.test.ts`

**Interfaces:**
- Produces: `class Debouncer { constructor(private delayMs: number, private flush: (paths: string[]) => void); add(path: string): void; }` — coalesces paths and fires `flush` once after `delayMs` of quiet. (Pure/timer-based; the VS Code `FileSystemWatcher` glue lives in `ChatViewProvider` and is thin.)

- [ ] **Step 1: Write the failing test**

Create `packages/extension/src/test/watcher.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { Debouncer } from '../rag/watcher';

describe('Debouncer', () => {
  it('coalesces adds and flushes unique paths once', () => {
    vi.useFakeTimers();
    const flush = vi.fn();
    const d = new Debouncer(1000, flush);
    d.add('a.ts'); d.add('b.ts'); d.add('a.ts');
    vi.advanceTimersByTime(999);
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flush).toHaveBeenCalledWith(['a.ts', 'b.ts']);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w fortress-code -- watcher`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `Debouncer`**

Create `packages/extension/src/rag/watcher.ts`:

```ts
export class Debouncer {
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private delayMs: number, private flush: (paths: string[]) => void) {}
  add(path: string): void {
    this.pending.add(path);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const paths = [...this.pending];
      this.pending.clear();
      this.timer = null;
      this.flush(paths);
    }, this.delayMs);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w fortress-code -- watcher`
Expected: PASS.

- [ ] **Step 5: Wire the watcher in `ChatViewProvider`**

Add a method that, once an index exists, re-indexes changed files. In `ChatViewProvider`, add a field `private watcherStarted = false;` and this method, and call it at the end of the successful `indexWorkspace` case (after `ragStatus` post):

```ts
  private startRagWatcher(): void {
    if (this.watcherStarted) return;
    const rag = this.ragService();
    if (!rag) return;
    this.watcherStarted = true;
    const debouncer = new Debouncer(1000, async () => {
      if (!this.client) return;
      try {
        await rag.index(this.client, (p) => this.post({ type: 'ragProgress', progress: p }));
        this.post({ type: 'ragStatus', stats: rag.stats(), indexing: false });
      } catch { /* transient; next save retries */ }
    });
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const touch = (uri: vscode.Uri) => debouncer.add(uri.fsPath);
    watcher.onDidChange(touch); watcher.onDidCreate(touch); watcher.onDidDelete(touch);
    this.context.subscriptions.push(watcher);
  }
```

Add the import `import { Debouncer } from '../rag/watcher';` and call `this.startRagWatcher();` right after the successful-index `ragStatus` post in the `indexWorkspace` case. (The debounced flush re-runs `indexWorkspace`, which is incremental — unchanged files are skipped and deleted files are dropped, so a single reused path is sufficient.)

- [ ] **Step 6: Run the extension suite + build**

Run: `npm test -w fortress-code && npm run build`
Expected: PASS; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/rag/watcher.ts packages/extension/src/chat/ChatViewProvider.ts packages/extension/src/test/watcher.test.ts
git commit -m "feat(rag): debounced file watcher for incremental re-index"
```

---

## Task 12: Webview UX — index control, status, `@codebase` chip, sources (extension)

**Files:**
- Modify: `packages/extension/media/chat.html`
- Modify: `packages/extension/media/chat.css`
- Modify: `packages/extension/media/chat.js`

**Interfaces:**
- Consumes webview messages: `{ type: 'ragStatus', stats: { files, chunks }, indexing }`, `{ type: 'ragProgress', progress: { filesDone, filesTotal, chunksDone, capped } }`.
- Sends: `{ type: 'indexWorkspace' }`.
- No new tests (webview JS is validated with `node --check`).

- [ ] **Step 1: Add the RAG section to `chat.html`**

Inside `#gallery-body`, after the `#models` div (line ~19), add:

```html
      <div id="rag">
        <div id="rag-row">
          <button id="rag-index">Index workspace</button>
          <span id="rag-status">Not indexed</span>
        </div>
        <div id="rag-bar" class="dlbar" hidden><span id="rag-fill"></span></div>
        <div id="rag-hint">Type <b>@codebase</b> in a message to search the whole repo.</div>
      </div>
```

- [ ] **Step 2: Style it in `chat.css`** (reuse existing `.dlbar`/`#dlfill` conventions)

```css
#rag { margin-top: 8px; border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; }
#rag-row { display: flex; align-items: center; gap: 8px; }
#rag-status { color: var(--vscode-descriptionForeground); font-size: 12px; }
#rag-hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
#rag-fill { display: block; height: 100%; width: 0; background: var(--vscode-progressBar-background); }
.src-list { margin-top: 6px; font-size: 12px; }
.src-list a { color: var(--vscode-textLink-foreground); cursor: pointer; display: block; }
```

- [ ] **Step 3: Handle the messages + button in `chat.js`**

In the `message` event handler (the `switch`/`if` block that already handles `m.type`), add:

```js
    if (m.type === 'ragStatus') {
      const s = m.stats || { files: 0, chunks: 0 };
      $('rag-status').textContent = s.chunks ? `Indexed ${s.files} files · ${s.chunks} chunks` : 'Not indexed';
      $('rag-index').disabled = !!m.indexing;
      if (!m.indexing) $('rag-bar').hidden = true;
    }
    if (m.type === 'ragProgress') {
      const p = m.progress || {};
      $('rag-bar').hidden = false;
      $('rag-index').disabled = true;
      const pct = p.filesTotal ? Math.round((p.filesDone / p.filesTotal) * 100) : 0;
      $('rag-fill').style.width = pct + '%';
      $('rag-status').textContent = `Indexing ${p.filesDone}/${p.filesTotal}${p.capped ? ' (capped)' : ''} · ${p.chunksDone} chunks`;
    }
```

Bind the button early (with the other delegated/guarded bindings near the top, so it survives any later error):

```js
{ const _ri = $('rag-index'); if (_ri) _ri.onclick = () => { $('rag-index').disabled = true; vscode.postMessage({ type: 'indexWorkspace' }); }; }
```

- [ ] **Step 4: Validate syntax**

Run: `node --check packages/extension/media/chat.js`
Expected: prints nothing (exit 0). IDE template-literal warnings are false positives.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/media/chat.html packages/extension/media/chat.css packages/extension/media/chat.js
git commit -m "feat(rag): webview index control, progress, and status"
```

---

## Task 13: Ship — version bump, package, manual smoke

**Files:**
- Modify: `packages/extension/package.json` (version)

- [ ] **Step 1: Full test sweep**

Run: `npm test -w @fortress-code/shared && npm test -w @fortress-code/manager && npm test -w fortress-code && npm run build`
Expected: all green; build succeeds.

- [ ] **Step 2: Bump, package, install**

```bash
node -e 'const fs=require("fs");const p="packages/extension/package.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));const[a,b,c]=j.version.split(".").map(Number);j.version=`${a}.${b}.${c+1}`;fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");console.log("version",j.version);'
npm run package -w fortress-code
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension "$(pwd)/fortress-code.vsix" --force
```

- [ ] **Step 3: Manual smoke (record result in the commit body)**

1. Open a folder in a fresh VS Code window.
2. Download **Nomic Embed Text v1.5** from the model gallery (one-time).
3. Click **Index workspace** — the bar fills, status shows `Indexed N files · M chunks`.
4. Ask a repo-wide question with `@codebase` (e.g. `@codebase where is the daemon token generated?`) — the answer cites `file:Lstart-Lend` excerpts.
5. Edit + save a file — status re-updates within ~1-2s.

- [ ] **Step 4: Commit + push**

```bash
git add packages/extension/package.json
git commit -m "chore(rag): ship Phase D @codebase RAG (vX.Y.Z); smoke passed"
git push origin main
```

---

## Self-Review

**Spec coverage:**
- Embedding model + source → Task 1 (nomic-embed-text-v1.5, pinned).
- Dedicated always-on embed server → Task 3 (`EmbedSupervisor`) + Task 4 (`/embed/start` keeps it up; started on first index/query, stopped only on idle/shutdown).
- Chunking → Task 6. Vector index storage/format → Task 7 (`meta.json` + `vectors.bin`). Retrieval + injection → Tasks 9-10. Incremental re-index → Tasks 8, 11. `@codebase` UX → Tasks 10, 12.
- Governance consistency → Task 1 (US `PolicyEntry`, passes `isAllowed`). Memory guard for two models → Task 4. Index in extension storage → Task 10 (`globalStorageUri/rag/<hash>`). Error handling (428/503/banner/fallback) → Tasks 4, 10.
- Testing → every task ships vitest coverage; `/embed` mocked (Tasks 4, 5).

**Placeholder scan:** The only unfilled values are the embedding model's `sha256`/`bytes`, which MUST be computed from the real artifact (Task 1, Step 4 gives the exact command). This is a checksum pin, not a placeholder.

**Type consistency:** `EmbedResponse.vectors: number[][]` flows manager → `DaemonClient.embed` → `RagService` → `VectorStore`. `ChunkMeta`/`Retrieved` names match across store/indexer/retriever. `ChatContext.codebase` shape matches `buildCodebaseBlock`'s parameter. `IndexProgress` fields match the webview `ragProgress` handler.

**Out of scope confirmed:** no tree-sitter, no external vector DB, no re-ranker, no multi-root, no auto-index-on-open.
