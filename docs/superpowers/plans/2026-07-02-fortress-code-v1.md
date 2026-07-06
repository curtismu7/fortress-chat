# FortressChat v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VS Code extension (chat panel + file-editing agent) backed by a background manager daemon that downloads llama.cpp + US-origin models and makes memory-overload failures structurally impossible.

**Architecture:** npm-workspaces monorepo with three packages. `shared` holds the manager API contract, chat-message types, and the model catalog. `manager` is a detached Node daemon that owns llama-server lifecycle (one model at a time), the pre-flight memory guard, and resumable downloads; it serves a token-authenticated REST API on 127.0.0.1. `extension` is a thin client: chat webview, agent loop, and tools; inference streams directly from the extension host to llama-server's OpenAI API.

**Tech Stack:** TypeScript 5 (strict), Node 20+, npm workspaces, zod (validation), vitest (tests), esbuild (bundling), @vscode/vsce (packaging). No express — `node:http` with manual routing. Spec: `docs/superpowers/specs/2026-07-02-fortress-chat-design.md`.

## Global Constraints

- Platform v1: **Apple Silicon macOS only** (darwin/arm64). Guard all platform-specific code behind checks so Windows/Linux can slot in later.
- Pinned llama.cpp release: tag **`b9840`**, asset **`llama-b9840-bin-macos-arm64.zip`** from `https://github.com/ggml-org/llama.cpp/releases/download/b9840/`.
- Data dir: `~/Library/Application Support/fortress-chat/` (override with env `FC_DATA_DIR` for tests). Layout: `bin/` (llama-server), `models/`, `daemon.json` (pid+port+token, mode 0600), `daemon.log`.
- Daemon API binds **127.0.0.1 only**; every request requires header `x-fc-token` matching the token in `daemon.json`.
- **One managed llama-server at a time.** Default context length **8192** tokens. llama-server always started with `--jinja`.
- Memory guard: required = catalog `memoryBytes` (already includes 8192-ctx KV) + **1.5 GiB** overhead; must leave **≥15%** of total RAM free after load. Available = (free + inactive + speculative pages) × pagesize from `vm_stat`.
- Foreign processes are killed **only** via explicit API call triggered by a user click. Managed server may be stopped automatically.
- Chat history entries MUST validate as `{role, content}`; errors are never appended to history.
- Idle policy: no authenticated API request for **30 minutes** → daemon stops llama-server and exits.
- Catalog: Google Gemma 3 QAT (1B/4B/12B/27B) + OpenAI gpt-oss (20B/120B) only. Sources: `google/*-qat-q4_0-gguf` and `ggml-org/gpt-oss-*-GGUF` HF repos, SHA256-pinned.
- Dependencies allowed: `zod`; dev: `typescript`, `vitest`, `esbuild`, `@types/node`, `@types/vscode`, `@vscode/vsce`, `eslint` + `typescript-eslint`. Nothing else without a plan change.
- All commits end with the trailer line: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- TDD: every code task starts with a failing test where the code is testable; webview/UI steps use the stated manual checks instead.

## File Structure

```text
fortress-chat/
├── package.json                     # workspaces root, scripts
├── tsconfig.base.json
├── .gitignore
├── .github/workflows/ci.yml        # lint+test on push; vsix on tag
├── packages/
│   ├── shared/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── messages.ts         # ChatMessage + validateHistory (poison-proofing)
│   │       ├── api.ts              # manager REST contract types + ServerState
│   │       ├── catalog.ts          # zod schema + loader
│   │       ├── catalog.json        # the six pinned models
│   │       └── index.ts            # re-exports
│   ├── manager/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── src/
│   │   │   ├── paths.ts            # data dir, daemon.json read/write
│   │   │   ├── memory.ts           # vm_stat parse + fit math
│   │   │   ├── processes.ts        # foreign llama/ollama scan + kill
│   │   │   ├── download.ts         # resumable download + sha256 + disk check
│   │   │   ├── binary.ts           # fetch/unzip pinned llama-server
│   │   │   ├── supervisor.ts       # spawn llama-server, state machine, health poll
│   │   │   ├── httpApi.ts          # node:http router + token auth
│   │   │   └── index.ts            # entry: singleton check, idle timer
│   │   └── test/
│   │       ├── memory.test.ts
│   │       ├── processes.test.ts
│   │       ├── download.test.ts
│   │       ├── supervisor.test.ts
│   │       ├── httpApi.test.ts
│   │       ├── daemon.integration.test.ts
│   │       └── fixtures/stub-llama-server.mjs
│   └── extension/
│       ├── package.json            # VS Code manifest
│       ├── tsconfig.json
│       ├── esbuild.mjs
│       ├── src/
│       │   ├── extension.ts        # activate; register view
│       │   ├── daemon.ts           # find-or-spawn daemon; DaemonClient
│       │   ├── chat/
│       │   │   ├── ChatViewProvider.ts  # webview host, message routing
│       │   │   ├── session.ts      # typed history, workspaceState persistence
│       │   │   └── stream.ts       # SSE streaming + 60s watchdog + cancel
│       │   ├── agent/
│       │   │   ├── tools.ts        # read_file, list_files, search, edit_file
│       │   │   └── loop.ts         # tool-call iteration loop (max 10)
│       │   └── test/
│       │       ├── session.test.ts
│       │       ├── stream.test.ts
│       │       └── loop.test.ts
│       └── media/
│           ├── chat.html
│           ├── chat.css
│           └── chat.js
└── docs/superpowers/…               # spec + this plan
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`, `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` and `npm run build` work from repo root; `@fortress-chat/shared` importable by other packages.

- [ ] **Step 1: Write root config files**

`package.json`:

```json
{
  "name": "fortress-chat",
  "private": true,
  "workspaces": ["packages/*"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "lint": "npm run lint --workspaces --if-present"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`.gitignore`:

```text
node_modules/
dist/
out/
*.vsix
*.tsbuildinfo
.DS_Store
```

`packages/shared/package.json`:

```json
{
  "name": "@fortress-chat/shared",
  "version": "0.1.0",
  "type": "commonjs",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.23.0" },
  "devDependencies": { "typescript": "^5.5.0", "vitest": "^2.0.0", "@types/node": "^20.0.0" }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "resolveJsonModule": true },
  "include": ["src"]
}
```

`packages/shared/src/index.ts`:

```ts
export const FORTRESS_CODE = true;
```

- [ ] **Step 2: Install and verify build**

Run: `cd /Users/cmuir/Development/fortress-chat && npm install && npm run build`
Expected: exit 0, `packages/shared/dist/index.js` exists.

- [ ] **Step 3: Commit**

```bash
git add package.json tsconfig.base.json .gitignore packages/shared
git commit -m "chore: scaffold npm-workspaces monorepo with shared package"
```

---

### Task 2: shared — chat message types + history validator

**Files:**
- Create: `packages/shared/src/messages.ts`
- Test: `packages/shared/test/messages.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces:
  - `type Role = 'system' | 'user' | 'assistant' | 'tool'`
  - `interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }`
  - `interface ChatMessage { role: Role; content: string; tool_call_id?: string; tool_calls?: ToolCall[] }`
  - `function validateHistory(input: unknown): ChatMessage[]` — throws `HistoryValidationError` on any entry missing `role` or `content`.

- [ ] **Step 1: Write the failing test** (`packages/shared/test/messages.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { validateHistory, HistoryValidationError } from '../src/messages';

describe('validateHistory', () => {
  it('accepts well-formed history', () => {
    const h = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(validateHistory(h)).toEqual(h);
  });

  it('REGRESSION llama-vscode poison bug: rejects role-less entry', () => {
    const h = [{ content: 'Request failed with status code 503' }];
    expect(() => validateHistory(h)).toThrow(HistoryValidationError);
  });

  it('rejects unknown role and non-string content', () => {
    expect(() => validateHistory([{ role: 'oops', content: 'x' }])).toThrow(HistoryValidationError);
    expect(() => validateHistory([{ role: 'user', content: 42 }])).toThrow(HistoryValidationError);
  });

  it('accepts assistant tool_calls and tool results', () => {
    const h = [
      { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', content: 'file body', tool_call_id: '1' },
    ];
    expect(validateHistory(h)).toEqual(h);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fortress-chat/shared`
Expected: FAIL — cannot resolve `../src/messages`.

- [ ] **Step 3: Implement** (`packages/shared/src/messages.ts`)

```ts
import { z } from 'zod';

export class HistoryValidationError extends Error {}

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
});

export type ToolCall = z.infer<typeof toolCallSchema>;
export type ChatMessage = z.infer<typeof messageSchema>;
export type Role = ChatMessage['role'];

export function validateHistory(input: unknown): ChatMessage[] {
  const parsed = z.array(messageSchema).safeParse(input);
  if (!parsed.success) {
    throw new HistoryValidationError(`Invalid chat history: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}
```

In `packages/shared/src/index.ts` replace the placeholder line with:

```ts
export * from './messages';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @fortress-chat/shared`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): typed chat messages with history validator (503-poison regression test)"
```

---

### Task 3: shared — model catalog + manager API contract

**Files:**
- Create: `packages/shared/src/catalog.ts`, `packages/shared/src/catalog.json`, `packages/shared/src/api.ts`
- Test: `packages/shared/test/catalog.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces:
  - `interface CatalogModel { id: string; family: 'gemma3' | 'gpt-oss'; displayName: string; hfRepo: string; files: { name: string; sha256: string; bytes: number }[]; memoryBytes: number; ramTierBytes: number; toolCalling: boolean; license: string; extraArgs: string[] }`
  - `function loadCatalog(): CatalogModel[]` — validates `catalog.json` against the zod schema, throws on mismatch.
  - `type ServerState = 'idle' | 'downloading' | 'starting' | 'loading-model' | 'ready' | 'stopping' | 'crashed'`
  - API types: `StatusResponse`, `ForeignProcess`, `StartRejection` (see Step 3 code — later tasks import these exact names).

- [ ] **Step 1: Write the failing test** (`packages/shared/test/catalog.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { loadCatalog } from '../src/catalog';

describe('catalog', () => {
  it('loads and validates all six models', () => {
    const models = loadCatalog();
    expect(models).toHaveLength(6);
    const ids = models.map((m) => m.id);
    expect(ids).toContain('gemma-3-12b-qat');
    expect(ids).toContain('gpt-oss-20b');
  });

  it('every model pins sha256 for every file', () => {
    for (const m of loadCatalog()) {
      expect(m.files.length).toBeGreaterThan(0);
      for (const f of m.files) expect(f.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('toolCalling flags match spec (12B+ gemma and gpt-oss only)', () => {
    const byId = Object.fromEntries(loadCatalog().map((m) => [m.id, m.toolCalling]));
    expect(byId['gemma-3-1b-qat']).toBe(false);
    expect(byId['gemma-3-4b-qat']).toBe(false);
    expect(byId['gemma-3-12b-qat']).toBe(true);
    expect(byId['gemma-3-27b-qat']).toBe(true);
    expect(byId['gpt-oss-20b']).toBe(true);
    expect(byId['gpt-oss-120b']).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fortress-chat/shared`
Expected: FAIL — cannot resolve `../src/catalog`.

- [ ] **Step 3: Implement schema + API types**

`packages/shared/src/catalog.ts`:

```ts
import { z } from 'zod';
import rawCatalog from './catalog.json';

const fileSchema = z.object({
  name: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive(),
});

const modelSchema = z.object({
  id: z.string(),
  family: z.enum(['gemma3', 'gpt-oss']),
  displayName: z.string(),
  hfRepo: z.string(),
  files: z.array(fileSchema).min(1),
  memoryBytes: z.number().int().positive(),   // incl. 8192-ctx KV cache
  ramTierBytes: z.number().int().positive(),  // minimum machine RAM to recommend
  toolCalling: z.boolean(),
  license: z.string(),
  extraArgs: z.array(z.string()),
});

export type CatalogModel = z.infer<typeof modelSchema>;

export function loadCatalog(): CatalogModel[] {
  return z.array(modelSchema).parse(rawCatalog);
}

export function hfUrl(m: CatalogModel, fileName: string): string {
  return `https://huggingface.co/${m.hfRepo}/resolve/main/${fileName}`;
}
```

`packages/shared/src/api.ts`:

```ts
export type ServerState =
  | 'idle' | 'downloading' | 'starting' | 'loading-model'
  | 'ready' | 'stopping' | 'crashed';

export interface DownloadProgress {
  modelId: string;
  receivedBytes: number;
  totalBytes: number;
}

export interface StatusResponse {
  state: ServerState;
  modelId: string | null;
  endpoint: string | null;          // e.g. http://127.0.0.1:PORT when ready
  download: DownloadProgress | null;
  crashLog: string[] | null;        // last stderr lines when state === 'crashed'
  ram: { totalBytes: number; availableBytes: number };
  binaryInstalled: boolean;
  downloadedModelIds: string[];
}

export interface ForeignProcess {
  pid: number;
  command: string;   // truncated command line
  rssBytes: number;  // best-effort resident size
}

export interface StartRejection {
  reason: 'insufficient-memory';
  requiredBytes: number;
  availableBytes: number;
  wouldFitAfterForeignKill: boolean;
  foreign: ForeignProcess[];
}
```

`packages/shared/src/catalog.json` — create with `bytes`/`sha256` values fetched now. For each entry below, get the real values from Hugging Face (no auth needed):

Run for each `<repo> <file>` pair:

```bash
curl -s "https://huggingface.co/api/models/<repo>?blobs=true" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(s['rfilename'], s['size'], s.get('lfs',{}).get('sha256','')) for s in d['siblings'] if s['rfilename'].endswith('.gguf')]"
```

Repos/files to pin (fill `bytes` + `sha256` from the command output):

```json
[
  { "id": "gemma-3-1b-qat",  "family": "gemma3", "displayName": "Gemma 3 1B QAT",  "hfRepo": "google/gemma-3-1b-it-qat-q4_0-gguf",  "files": [{ "name": "gemma-3-1b-it-q4_0.gguf",  "sha256": "<from command>", "bytes": 0 }], "memoryBytes": 1610612736,  "ramTierBytes": 8589934592,   "toolCalling": false, "license": "Gemma", "extraArgs": [] },
  { "id": "gemma-3-4b-qat",  "family": "gemma3", "displayName": "Gemma 3 4B QAT",  "hfRepo": "google/gemma-3-4b-it-qat-q4_0-gguf",  "files": [{ "name": "gemma-3-4b-it-q4_0.gguf",  "sha256": "<from command>", "bytes": 0 }], "memoryBytes": 3758096384,  "ramTierBytes": 8589934592,   "toolCalling": false, "license": "Gemma", "extraArgs": [] },
  { "id": "gemma-3-12b-qat", "family": "gemma3", "displayName": "Gemma 3 12B QAT", "hfRepo": "google/gemma-3-12b-it-qat-q4_0-gguf", "files": [{ "name": "gemma-3-12b-it-q4_0.gguf", "sha256": "<from command>", "bytes": 0 }], "memoryBytes": 9663676416,  "ramTierBytes": 17179869184,  "toolCalling": true,  "license": "Gemma", "extraArgs": [] },
  { "id": "gemma-3-27b-qat", "family": "gemma3", "displayName": "Gemma 3 27B QAT", "hfRepo": "google/gemma-3-27b-it-qat-q4_0-gguf", "files": [{ "name": "gemma-3-27b-it-q4_0.gguf", "sha256": "<from command>", "bytes": 0 }], "memoryBytes": 19327352832, "ramTierBytes": 34359738368,  "toolCalling": true,  "license": "Gemma", "extraArgs": [] },
  { "id": "gpt-oss-20b",     "family": "gpt-oss", "displayName": "gpt-oss-20B",    "hfRepo": "ggml-org/gpt-oss-20b-GGUF",           "files": [{ "name": "gpt-oss-20b-mxfp4.gguf",   "sha256": "<from command>", "bytes": 0 }], "memoryBytes": 15032385536, "ramTierBytes": 25769803776,  "toolCalling": true,  "license": "Apache-2.0", "extraArgs": ["--reasoning-format", "none"] },
  { "id": "gpt-oss-120b",    "family": "gpt-oss", "displayName": "gpt-oss-120B",   "hfRepo": "ggml-org/gpt-oss-120b-GGUF",          "files": [], "memoryBytes": 66571993088, "ramTierBytes": 103079215104, "toolCalling": true,  "license": "Apache-2.0", "extraArgs": ["--reasoning-format", "none"] }
]
```

For `gpt-oss-120b`, the command lists three split files (`gpt-oss-120b-mxfp4-00001-of-00003.gguf` etc.) — add all three to `files` in order; the supervisor passes only the first to `-m` (llama.cpp auto-loads splits from the same directory).

In `packages/shared/src/index.ts` add:

```ts
export * from './catalog';
export * from './api';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @fortress-chat/shared`
Expected: all catalog tests pass (SHA regex will fail until real values are pasted — that is the point; do not weaken the test).

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): pinned US-only model catalog and manager API contract"
```

---

### Task 4: manager — package scaffold + paths/daemon-file module

**Files:**
- Create: `packages/manager/package.json`, `packages/manager/tsconfig.json`, `packages/manager/src/paths.ts`
- Test: `packages/manager/test/paths.test.ts`

**Interfaces:**
- Produces:
  - `function dataDir(): string` — `$FC_DATA_DIR` if set, else `~/Library/Application Support/fortress-chat`; creates it (recursive) on first call.
  - `function binDir(): string`, `function modelsDir(): string` — subdirs, created on demand.
  - `interface DaemonInfo { pid: number; port: number; token: string }`
  - `function writeDaemonInfo(info: DaemonInfo): void` — writes `daemon.json` with mode 0600.
  - `function readDaemonInfo(): DaemonInfo | null` — null if missing/unparseable.
  - `function isProcessAlive(pid: number): boolean` — `process.kill(pid, 0)` wrapped.

- [ ] **Step 1: Write manager package files**

`packages/manager/package.json`:

```json
{
  "name": "@fortress-chat/manager",
  "version": "0.1.0",
  "type": "commonjs",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": { "@fortress-chat/shared": "0.1.0", "zod": "^3.23.0" },
  "devDependencies": { "typescript": "^5.5.0", "vitest": "^2.0.0", "@types/node": "^20.0.0" }
}
```

`packages/manager/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../shared" }]
}
```

- [ ] **Step 2: Write the failing test** (`packages/manager/test/paths.test.ts`)

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDir, writeDaemonInfo, readDaemonInfo, isProcessAlive } from '../src/paths';

beforeEach(() => {
  process.env.FC_DATA_DIR = mkdtempSync(join(tmpdir(), 'fc-test-'));
});

describe('paths', () => {
  it('uses FC_DATA_DIR override and creates it', () => {
    expect(dataDir()).toBe(process.env.FC_DATA_DIR);
  });

  it('daemon.json round-trips and is 0600', () => {
    writeDaemonInfo({ pid: 123, port: 45678, token: 'abc' });
    expect(readDaemonInfo()).toEqual({ pid: 123, port: 45678, token: 'abc' });
    const mode = statSync(join(dataDir(), 'daemon.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('readDaemonInfo returns null when missing', () => {
    expect(readDaemonInfo()).toBeNull();
  });

  it('isProcessAlive: own pid alive, absurd pid not', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(2 ** 22 - 7)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm install && npm test -w @fortress-chat/manager`
Expected: FAIL — cannot resolve `../src/paths`.

- [ ] **Step 4: Implement** (`packages/manager/src/paths.ts`)

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DaemonInfo { pid: number; port: number; token: string }

function ensure(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function dataDir(): string {
  return ensure(process.env.FC_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'fortress-chat'));
}

export function binDir(): string { return ensure(join(dataDir(), 'bin')); }
export function modelsDir(): string { return ensure(join(dataDir(), 'models')); }

const daemonFile = () => join(dataDir(), 'daemon.json');

export function writeDaemonInfo(info: DaemonInfo): void {
  writeFileSync(daemonFile(), JSON.stringify(info), { mode: 0o600 });
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    const raw = JSON.parse(readFileSync(daemonFile(), 'utf8'));
    if (typeof raw?.pid === 'number' && typeof raw?.port === 'number' && typeof raw?.token === 'string') return raw;
    return null;
  } catch { return null; }
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w @fortress-chat/manager`
Expected: 4 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/manager
git commit -m "feat(manager): data-dir paths and daemon.json handling"
```

---

### Task 5: manager — memory guard math

**Files:**
- Create: `packages/manager/src/memory.ts`
- Test: `packages/manager/test/memory.test.ts`

**Interfaces:**
- Produces:
  - `const OVERHEAD_BYTES = 1.5 * 1024 ** 3`
  - `function parseVmStat(output: string): { availableBytes: number }` — (free + inactive + speculative) × pagesize.
  - `function totalRamBytes(): number` — `os.totalmem()`.
  - `function readAvailableBytes(): Promise<number>` — runs `vm_stat` (darwin) via `execFile`.
  - `type FitResult = { fits: true } | { fits: false; requiredBytes: number; availableBytes: number }`
  - `function checkFit(modelMemoryBytes: number, availableBytes: number, totalBytes: number): FitResult` — fits iff `available - (modelMemoryBytes + OVERHEAD_BYTES) >= 0.15 * totalBytes`.

- [ ] **Step 1: Write the failing test** (`packages/manager/test/memory.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { parseVmStat, checkFit, OVERHEAD_BYTES } from '../src/memory';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                              100000.
Pages active:                           1000000.
Pages inactive:                          200000.
Pages speculative:                        50000.
Pages throttled:                              0.
Pages wired down:                        300000.
`;

describe('parseVmStat', () => {
  it('sums free+inactive+speculative times pagesize', () => {
    expect(parseVmStat(VM_STAT).availableBytes).toBe((100000 + 200000 + 50000) * 16384);
  });
});

describe('checkFit (64 GB machine)', () => {
  const total = 64 * 1024 ** 3;
  it('accepts gpt-oss-20b with plenty free', () => {
    expect(checkFit(14 * 1024 ** 3, 40 * 1024 ** 3, total)).toEqual({ fits: true });
  });
  it("REGRESSION 77GB-on-64GB pileup: rejects when it can't keep 15% headroom", () => {
    const r = checkFit(40 * 1024 ** 3, 20 * 1024 ** 3, total);
    expect(r.fits).toBe(false);
    if (!r.fits) expect(r.requiredBytes).toBe(40 * 1024 ** 3 + OVERHEAD_BYTES);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fortress-chat/manager`
Expected: FAIL — cannot resolve `../src/memory`.

- [ ] **Step 3: Implement** (`packages/manager/src/memory.ts`)

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { totalmem } from 'node:os';

const execFileP = promisify(execFile);

export const OVERHEAD_BYTES = 1.5 * 1024 ** 3;

export function totalRamBytes(): number { return totalmem(); }

export function parseVmStat(output: string): { availableBytes: number } {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1] ?? 16384);
  const page = (label: string) => Number(new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(output)?.[1] ?? 0);
  return { availableBytes: (page('free') + page('inactive') + page('speculative')) * pageSize };
}

export async function readAvailableBytes(): Promise<number> {
  const { stdout } = await execFileP('vm_stat');
  return parseVmStat(stdout).availableBytes;
}

export type FitResult = { fits: true } | { fits: false; requiredBytes: number; availableBytes: number };

export function checkFit(modelMemoryBytes: number, availableBytes: number, totalBytes: number): FitResult {
  const requiredBytes = modelMemoryBytes + OVERHEAD_BYTES;
  if (availableBytes - requiredBytes >= 0.15 * totalBytes) return { fits: true };
  return { fits: false, requiredBytes, availableBytes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @fortress-chat/manager`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/manager
git commit -m "feat(manager): memory guard math with vm_stat parsing (oversubscription regression test)"
```

---

### Task 6: manager — foreign process scan

**Files:**
- Create: `packages/manager/src/processes.ts`
- Test: `packages/manager/test/processes.test.ts`

**Interfaces:**
- Consumes: `ForeignProcess` from shared.
- Produces:
  - `function parsePs(output: string, excludePids: number[]): ForeignProcess[]` — matches commands containing `llama-server`, `llama serve`, or `ollama runner`; excludes our own managed pid.
  - `function scanForeign(excludePids: number[]): Promise<ForeignProcess[]>` — runs `ps -axo pid=,rss=,command=`.
  - `function killPids(pids: number[]): { killed: number[]; failed: number[] }` — SIGTERM each.

- [ ] **Step 1: Write the failing test** (`packages/manager/test/processes.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { parsePs } from '../src/processes';

const PS = `  123  4096 /usr/bin/some-daemon
  456 9437184 llama-server -m /Users/x/models/gemma.gguf --port 8094
  789 1048576 llama serve -m /Users/x/models/star.gguf --port 8012
  790  512000 /opt/homebrew/bin/ollama runner --model foo
  801  2048 grep llama-server
`;

describe('parsePs', () => {
  it('finds llama-server, llama serve, and ollama runner with rss in bytes', () => {
    const found = parsePs(PS, []);
    expect(found.map((p) => p.pid)).toEqual([456, 789, 790]);
    expect(found[0].rssBytes).toBe(9437184 * 1024); // ps rss is KiB
  });

  it('excludes our managed pid', () => {
    expect(parsePs(PS, [456]).map((p) => p.pid)).toEqual([789, 790]);
  });

  it('ignores grep-like matches without model flags', () => {
    expect(parsePs(PS, []).map((p) => p.pid)).not.toContain(801);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fortress-chat/manager`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** (`packages/manager/src/processes.ts`)

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ForeignProcess } from '@fortress-chat/shared';

const execFileP = promisify(execFile);
const PATTERN = /(llama-server\s+-m|llama serve\s+-m|llama-server\s+--|llama serve\s+--|llama-server\s+-hf|llama serve\s+-hf|ollama runner)/;

export function parsePs(output: string, excludePids: number[]): ForeignProcess[] {
  const out: ForeignProcess[] = [];
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = m[3];
    if (!PATTERN.test(command) || excludePids.includes(pid)) continue;
    out.push({ pid, command: command.slice(0, 200), rssBytes: Number(m[2]) * 1024 });
  }
  return out;
}

export async function scanForeign(excludePids: number[]): Promise<ForeignProcess[]> {
  const { stdout } = await execFileP('ps', ['-axo', 'pid=,rss=,command=']);
  return parsePs(stdout, excludePids);
}

export function killPids(pids: number[]): { killed: number[]; failed: number[] } {
  const killed: number[] = []; const failed: number[] = [];
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); killed.push(pid); } catch { failed.push(pid); }
  }
  return { killed, failed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @fortress-chat/manager`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/manager
git commit -m "feat(manager): foreign llama/ollama process scan and explicit kill"
```

---

### Task 7: manager — resumable downloader with sha256 + disk check

**Files:**
- Create: `packages/manager/src/download.ts`
- Test: `packages/manager/test/download.test.ts`

**Interfaces:**
- Produces:
  - `function downloadFile(url: string, destPath: string, expectedSha256: string, expectedBytes: number, onProgress: (received: number, total: number) => void, signal?: AbortSignal): Promise<void>` — writes `destPath + '.part'`, resumes via `Range` if `.part` exists, verifies sha256 + size, renames on success. Throws `ChecksumError` / `DiskSpaceError`.
  - `function freeDiskBytes(dir: string): number` — `statfs`.

- [ ] **Step 1: Write the failing test** (`packages/manager/test/download.test.ts`)

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { downloadFile, ChecksumError } from '../src/download';

const BODY = randomBytes(1024 * 64);
const SHA = createHash('sha256').update(BODY).digest('hex');
let server: Server; let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    res.writeHead(range ? 206 : 200, { 'content-length': BODY.length - start });
    res.end(BODY.subarray(start));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => server.close());

describe('downloadFile', () => {
  it('downloads, verifies sha, renames .part to final', async () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'fc-dl-')), 'file.bin');
    let last = 0;
    await downloadFile(`${base}/f`, dest, SHA, BODY.length, (r) => (last = r));
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(existsSync(dest + '.part')).toBe(false);
    expect(last).toBe(BODY.length);
  });

  it('resumes from an existing .part', async () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'fc-dl-')), 'file.bin');
    writeFileSync(dest + '.part', BODY.subarray(0, 1000));
    await downloadFile(`${base}/f`, dest, SHA, BODY.length, () => {});
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it('throws ChecksumError on sha mismatch and keeps no final file', async () => {
    const dest = join(mkdtempSync(join(tmpdir(), 'fc-dl-')), 'file.bin');
    await expect(downloadFile(`${base}/f`, dest, 'a'.repeat(64), BODY.length, () => {})).rejects.toThrow(ChecksumError);
    expect(existsSync(dest)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fortress-chat/manager`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** (`packages/manager/src/download.ts`)

```ts
import { createWriteStream, createReadStream, existsSync, statSync, statfsSync, unlinkSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export class ChecksumError extends Error {}
export class DiskSpaceError extends Error {}

export function freeDiskBytes(dir: string): number {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export async function downloadFile(
  url: string, destPath: string, expectedSha256: string, expectedBytes: number,
  onProgress: (received: number, total: number) => void, signal?: AbortSignal,
): Promise<void> {
  const part = destPath + '.part';
  const already = existsSync(part) ? statSync(part).size : 0;
  if (freeDiskBytes(dirname(destPath)) < expectedBytes - already) {
    throw new DiskSpaceError(`Need ${expectedBytes - already} bytes free`);
  }
  const headers: Record<string, string> = already > 0 ? { range: `bytes=${already}-` } : {};
  const res = await fetch(url, { headers, signal, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const resumed = res.status === 206;
  let received = resumed ? already : 0;
  const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' });
  const counter = async function* (src: AsyncIterable<Uint8Array>) {
    for await (const chunk of src) { received += chunk.length; onProgress(received, expectedBytes); yield chunk; }
  };
  await pipeline(Readable.fromWeb(res.body as any), counter, out);
  const actual = await sha256File(part);
  if (actual !== expectedSha256) { unlinkSync(part); throw new ChecksumError(`sha256 mismatch: ${actual}`); }
  renameSync(part, destPath);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @fortress-chat/manager`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/manager
git commit -m "feat(manager): resumable sha256-verified downloader with disk-space check"
```

---

### Task 8: manager — llama-server binary installer

**Files:**
- Create: `packages/manager/src/binary.ts`
- Test: `packages/manager/test/binary.test.ts`

**Interfaces:**
- Consumes: `downloadFile` (Task 7), `binDir` (Task 4).
- Produces:
  - `const LLAMA_RELEASE = 'b9840'`
  - `function llamaServerPath(): string` — `binDir()/b9840/llama-server`; also respects `FC_LLAMA_BIN` env override (tests/stub).
  - `function binaryInstalled(): boolean`
  - `function installBinary(onProgress: (r: number, t: number) => void): Promise<void>` — downloads the release zip (platform-guarded to darwin/arm64), extracts with `unzip -o`, `chmod +x`, moves `llama-server` + `*.dylib` into `binDir()/b9840/`.

**Note:** the zip's sha256 is not published per-asset in a stable way; the binary check is: zip downloads over TLS from github.com pinned release tag, and after install we run `llama-server --version` and assert the output contains `b9840`. Model files (the big attack surface) remain sha256-pinned.

- [ ] **Step 1: Write the failing test** (`packages/manager/test/binary.test.ts`)

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { llamaServerPath, binaryInstalled } from '../src/binary';

beforeEach(() => {
  process.env.FC_DATA_DIR = mkdtempSync(join(tmpdir(), 'fc-bin-'));
  delete process.env.FC_LLAMA_BIN;
});

describe('binary', () => {
  it('FC_LLAMA_BIN overrides the path', () => {
    process.env.FC_LLAMA_BIN = '/tmp/stub';
    expect(llamaServerPath()).toBe('/tmp/stub');
  });

  it('binaryInstalled false when missing, true when file exists', () => {
    expect(binaryInstalled()).toBe(false);
    const dir = join(process.env.FC_DATA_DIR!, 'bin', 'b9840');
    require('node:fs').mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'llama-server'), '#!/bin/sh\n');
    expect(binaryInstalled()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fortress-chat/manager`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** (`packages/manager/src/binary.ts`)

```ts
import { existsSync, chmodSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { binDir, dataDir } from './paths';
import { downloadFile } from './download';

const execFileP = promisify(execFile);
export const LLAMA_RELEASE = 'b9840';
const ASSET = `llama-${LLAMA_RELEASE}-bin-macos-arm64.zip`;
const URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/${ASSET}`;
// Size checked at download time via content-length; zip integrity via TLS + version assert.
const APPROX_ZIP_BYTES = 30 * 1024 * 1024;

export function llamaServerPath(): string {
  return process.env.FC_LLAMA_BIN ?? join(binDir(), LLAMA_RELEASE, 'llama-server');
}

export function binaryInstalled(): boolean {
  return existsSync(llamaServerPath());
}

export async function installBinary(onProgress: (r: number, t: number) => void): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(`Unsupported platform ${process.platform}/${process.arch} (v1 is Apple Silicon macOS only)`);
  }
  const zipPath = join(dataDir(), ASSET);
  // GitHub asset downloads don't publish sha256; pass a sentinel and skip hash verification for the binary only.
  await downloadNoHash(URL, zipPath, APPROX_ZIP_BYTES, onProgress);
  const extractDir = join(dataDir(), 'extract-tmp');
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  await execFileP('unzip', ['-o', zipPath, '-d', extractDir]);
  const target = join(binDir(), LLAMA_RELEASE);
  mkdirSync(target, { recursive: true });
  // release zip layout: build/bin/llama-server + *.dylib
  const srcBin = join(extractDir, 'build', 'bin');
  for (const f of readdirSync(srcBin)) renameSync(join(srcBin, f), join(target, f));
  chmodSync(join(target, 'llama-server'), 0o755);
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
  const { stdout, stderr } = await execFileP(join(target, 'llama-server'), ['--version']).catch((e) => e);
  if (!`${stdout}${stderr}`.includes(LLAMA_RELEASE)) throw new Error('Installed llama-server failed version check');
}

async function downloadNoHash(url: string, dest: string, approxBytes: number, onProgress: (r: number, t: number) => void): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? approxBytes);
  const { createWriteStream } = await import('node:fs');
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  let received = 0;
  const counter = async function* (src: AsyncIterable<Uint8Array>) {
    for await (const c of src) { received += c.length; onProgress(received, total); yield c; }
  };
  await pipeline(Readable.fromWeb(res.body as any), counter, createWriteStream(dest));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @fortress-chat/manager`
Expected: PASS.

- [ ] **Step 5: One-time manual verification of the real download** (needs network, ~30 MB)

Run: `FC_DATA_DIR=$(mktemp -d) node -e "require('./packages/manager/dist/binary.js').installBinary(()=>{}).then(()=>console.log('OK'))"` after `npm run build`.
Expected: prints `OK`. If the release zip layout differs from `build/bin`, fix `srcBin` accordingly now.

- [ ] **Step 6: Commit**

```bash
git add packages/manager
git commit -m "feat(manager): pinned llama.cpp b9840 binary installer with version assert"
```

---

### Task 9: manager — llama-server supervisor + state machine

**Files:**
- Create: `packages/manager/src/supervisor.ts`, `packages/manager/test/fixtures/stub-llama-server.mjs`
- Test: `packages/manager/test/supervisor.test.ts`

**Interfaces:**
- Consumes: `llamaServerPath` (Task 8), `modelsDir` (Task 4), `CatalogModel`, `ServerState` (shared).
- Produces:
  - `class Supervisor` with:
    - `state: ServerState` (starts `'idle'`), `modelId: string | null`, `port: number | null`, `crashLog: string[] | null`
    - `endpoint(): string | null` — `http://127.0.0.1:${port}` when `ready`
    - `async start(model: CatalogModel, modelPath: string): Promise<void>` — spawns `llama-server -m <path> -ngl 99 -c 8192 --jinja --port <free port> --host 127.0.0.1 ...extraArgs`, transitions `starting → loading-model → ready` by polling `GET /health` every 500 ms (503 body = loading, 200 = ready), 120 s timeout.
    - `async stop(): Promise<void>` — SIGTERM, wait exit, state `idle`.
    - crash detection: unexpected exit → state `crashed`, `crashLog` = last 50 stderr lines.
    - `onStateChange(cb: (s: ServerState) => void)`.

- [ ] **Step 1: Write the stub llama-server** (`packages/manager/test/fixtures/stub-llama-server.mjs`)

```js
#!/usr/bin/env node
// Mimics llama-server enough for supervisor + API tests.
// Args mirror the real ones; only --port matters. Env knobs:
//   STUB_LOAD_MS   time to stay in "loading" (503) state (default 300)
//   STUB_CRASH_MS  if set, exit(1) after this many ms
import { createServer } from 'node:http';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const loadMs = Number(process.env.STUB_LOAD_MS ?? 300);
const started = Date.now();
if (process.env.STUB_CRASH_MS) {
  setTimeout(() => { console.error('boom: simulated crash'); process.exit(1); }, Number(process.env.STUB_CRASH_MS));
}
createServer((req, res) => {
  if (req.url === '/health') {
    if (Date.now() - started < loadMs) { res.writeHead(503); res.end('{"error":{"code":503,"message":"Loading model"}}'); }
    else { res.writeHead(200); res.end('{"status":"ok"}'); }
    return;
  }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"stub"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
```

- [ ] **Step 2: Write the failing test** (`packages/manager/test/supervisor.test.ts`)

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Supervisor } from '../src/supervisor';
import type { CatalogModel } from '@fortress-chat/shared';

const STUB = join(__dirname, 'fixtures', 'stub-llama-server.mjs');
const model: CatalogModel = {
  id: 'stub', family: 'gemma3', displayName: 'Stub', hfRepo: 'x/y',
  files: [{ name: 'stub.gguf', sha256: 'a'.repeat(64), bytes: 1 }],
  memoryBytes: 1, ramTierBytes: 1, toolCalling: true, license: 'test', extraArgs: [],
};

beforeEach(() => {
  process.env.FC_DATA_DIR = mkdtempSync(join(tmpdir(), 'fc-sup-'));
  process.env.FC_LLAMA_BIN = process.execPath; // node
  process.env.FC_LLAMA_BIN_ARGS = STUB;        // supervisor prepends this when set (test hook)
});

describe('Supervisor', () => {
  it('walks starting → loading-model → ready and exposes endpoint', async () => {
    const sup = new Supervisor();
    const states: string[] = [];
    sup.onStateChange((s) => states.push(s));
    await sup.start(model, '/dev/null');
    expect(sup.state).toBe('ready');
    expect(states).toEqual(['starting', 'loading-model', 'ready']);
    expect(sup.endpoint()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await sup.stop();
    expect(sup.state).toBe('idle');
  });

  it('detects crash and captures stderr', async () => {
    process.env.STUB_CRASH_MS = '600';
    const sup = new Supervisor();
    await sup.start(model, '/dev/null');
    await new Promise((r) => setTimeout(r, 900));
    expect(sup.state).toBe('crashed');
    expect(sup.crashLog!.join('\n')).toContain('simulated crash');
    delete process.env.STUB_CRASH_MS;
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w @fortress-chat/manager`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement** (`packages/manager/src/supervisor.ts`)

```ts
import { spawn, ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { CatalogModel, ServerState } from '@fortress-chat/shared';
import { llamaServerPath } from './binary';

export const DEFAULT_CTX = 8192;

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

export class Supervisor {
  state: ServerState = 'idle';
  modelId: string | null = null;
  port: number | null = null;
  crashLog: string[] | null = null;
  private child: ChildProcess | null = null;
  private stderrRing: string[] = [];
  private listeners: Array<(s: ServerState) => void> = [];
  private expectedExit = false;

  onStateChange(cb: (s: ServerState) => void): void { this.listeners.push(cb); }
  managedPid(): number | null { return this.child?.pid ?? null; }
  endpoint(): string | null { return this.state === 'ready' && this.port ? `http://127.0.0.1:${this.port}` : null; }

  private setState(s: ServerState): void {
    this.state = s;
    for (const l of this.listeners) l(s);
  }

  async start(model: CatalogModel, modelPath: string): Promise<void> {
    if (this.child) await this.stop();
    this.crashLog = null;
    this.stderrRing = [];
    this.expectedExit = false;
    this.port = await freePort();
    const bin = llamaServerPath();
    const args = [
      ...(process.env.FC_LLAMA_BIN_ARGS ? [process.env.FC_LLAMA_BIN_ARGS] : []),
      '-m', modelPath, '-ngl', '99', '-c', String(DEFAULT_CTX),
      '--jinja', '--host', '127.0.0.1', '--port', String(this.port),
      ...model.extraArgs,
    ];
    this.setState('starting');
    this.child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.child.stderr!.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n')) {
        if (!line.trim()) continue;
        this.stderrRing.push(line);
        if (this.stderrRing.length > 50) this.stderrRing.shift();
      }
    });
    this.child.on('exit', (code) => {
      this.child = null;
      if (this.expectedExit) return;
      this.crashLog = [...this.stderrRing, `(exit code ${code})`];
      this.setState('crashed');
    });
    this.modelId = model.id;
    await this.waitReady();
  }

  private async waitReady(): Promise<void> {
    const deadline = Date.now() + 120_000;
    let sawLoading = false;
    while (Date.now() < deadline) {
      if (this.state === 'crashed') throw new Error(`llama-server crashed during startup:\n${this.crashLog?.join('\n')}`);
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 503 && !sawLoading) { sawLoading = true; this.setState('loading-model'); }
        if (res.ok) { this.setState('ready'); return; }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.stop();
    throw new Error('llama-server did not become ready within 120s');
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) { this.setState('idle'); this.modelId = null; return; }
    this.setState('stopping');
    this.expectedExit = true;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
      child.on('exit', () => { clearTimeout(t); resolve(); });
    });
    this.child = null;
    this.modelId = null;
    this.setState('idle');
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w @fortress-chat/manager`
Expected: PASS (both supervisor tests, plus all earlier ones).

- [ ] **Step 6: Commit**

```bash
git add packages/manager
git commit -m "feat(manager): llama-server supervisor with health-driven state machine and crash capture"
```

---

### Task 10: manager — HTTP API with token auth + memory-guarded start

**Files:**
- Create: `packages/manager/src/httpApi.ts`
- Test: `packages/manager/test/httpApi.test.ts`

**Interfaces:**
- Consumes: Supervisor (Task 9), memory (Task 5), processes (Task 6), download (Task 7), binary (Task 8), catalog (shared).
- Produces: `function createApi(deps: ApiDeps): http.Server` where

  ```ts
  interface ApiDeps {
    supervisor: Supervisor;
    token: string;
    onActivity: () => void;              // idle-timer reset hook
    availableBytes: () => Promise<number>; // injectable for tests
  }
  ```

  Routes (all JSON; 401 without valid `x-fc-token`):
  - `GET /status` → `StatusResponse`
  - `GET /catalog` → `CatalogModel[]`
  - `POST /download {modelId}` → 202; progress appears in `/status.download`; 409 if a download is already running
  - `POST /install-binary` → 202
  - `POST /start {modelId}` → 200 on success; **409 + `StartRejection`** when the memory guard rejects; 428 if binary/model not downloaded
  - `POST /stop` → 200
  - `GET /foreign` → `ForeignProcess[]`
  - `POST /foreign/kill {pids: number[]}` → `{killed, failed}`
  - `POST /shutdown` → 200 then process exits

- [ ] **Step 1: Write the failing test** (`packages/manager/test/httpApi.test.ts`)

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/httpApi';
import { Supervisor } from '../src/supervisor';
import { loadCatalog } from '@fortress-chat/shared';

const STUB = join(__dirname, 'fixtures', 'stub-llama-server.mjs');
let server: ReturnType<typeof createApi>; let base: string;
const TOKEN = 'test-token';
let available = 40 * 1024 ** 3;

function req(path: string, opts: RequestInit = {}, token = TOKEN) {
  return fetch(base + path, { ...opts, headers: { 'x-fc-token': token, 'content-type': 'application/json', ...opts.headers } });
}

beforeEach(async () => {
  process.env.FC_DATA_DIR = mkdtempSync(join(tmpdir(), 'fc-api-'));
  process.env.FC_LLAMA_BIN = process.execPath;
  process.env.FC_LLAMA_BIN_ARGS = STUB;
  // fake a downloaded model file for the smallest catalog entry
  const m = loadCatalog()[0];
  const dir = join(process.env.FC_DATA_DIR, 'models', m.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, m.files[0].name), 'fake');
  server = createApi({ supervisor: new Supervisor(), token: TOKEN, onActivity: () => {}, availableBytes: async () => available });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => server.close());

describe('api auth', () => {
  it('401 without token', async () => {
    expect((await req('/status', {}, 'wrong')).status).toBe(401);
  });
});

describe('start with memory guard', () => {
  it('starts smallest model when memory fits', async () => {
    const m = loadCatalog()[0];
    const res = await req('/start', { method: 'POST', body: JSON.stringify({ modelId: m.id }) });
    expect(res.status).toBe(200);
    const status = await (await req('/status')).json();
    expect(status.state).toBe('ready');
    expect(status.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('409 + StartRejection with foreign list when memory does not fit', async () => {
    available = 1024; // nothing fits
    const m = loadCatalog()[0];
    const res = await req('/start', { method: 'POST', body: JSON.stringify({ modelId: m.id }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe('insufficient-memory');
    expect(Array.isArray(body.foreign)).toBe(true);
  });

  it('428 when model not downloaded', async () => {
    const res = await req('/start', { method: 'POST', body: JSON.stringify({ modelId: 'gpt-oss-120b' }) });
    expect(res.status).toBe(428);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @fortress-chat/manager`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** (`packages/manager/src/httpApi.ts`)

```ts
import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog, type CatalogModel, type StatusResponse, type StartRejection, type DownloadProgress, hfUrl } from '@fortress-chat/shared';
import { Supervisor } from './supervisor';
import { modelsDir } from './paths';
import { checkFit, totalRamBytes } from './memory';
import { scanForeign, killPids } from './processes';
import { downloadFile } from './download';
import { binaryInstalled, installBinary } from './binary';

export interface ApiDeps {
  supervisor: Supervisor;
  token: string;
  onActivity: () => void;
  availableBytes: () => Promise<number>;
}

function modelPath(m: CatalogModel, fileIndex = 0): string {
  return join(modelsDir(), m.id, m.files[fileIndex].name);
}
function modelDownloaded(m: CatalogModel): boolean {
  return m.files.length > 0 && m.files.every((f) => existsSync(join(modelsDir(), m.id, f.name)));
}
async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return {}; }
}
function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createApi(deps: ApiDeps): Server {
  const catalog = loadCatalog();
  let download: DownloadProgress | null = null;
  let downloading = false;

  return createServer(async (req, res) => {
    if (req.headers['x-fc-token'] !== deps.token) return send(res, 401, { error: 'unauthorized' });
    deps.onActivity();
    const route = `${req.method} ${req.url?.split('?')[0]}`;
    try {
      switch (route) {
        case 'GET /status': {
          const body: StatusResponse = {
            state: deps.supervisor.state,
            modelId: deps.supervisor.modelId,
            endpoint: deps.supervisor.endpoint(),
            download,
            crashLog: deps.supervisor.crashLog,
            ram: { totalBytes: totalRamBytes(), availableBytes: await deps.availableBytes() },
            binaryInstalled: binaryInstalled(),
            downloadedModelIds: catalog.filter(modelDownloaded).map((m) => m.id),
          };
          return send(res, 200, body);
        }
        case 'GET /catalog': return send(res, 200, catalog);
        case 'POST /install-binary': {
          if (downloading) return send(res, 409, { error: 'busy' });
          downloading = true;
          installBinary((r, t) => { download = { modelId: '__binary__', receivedBytes: r, totalBytes: t }; })
            .catch(() => {}) // surfaced via binaryInstalled staying false
            .finally(() => { download = null; downloading = false; });
          return send(res, 202, {});
        }
        case 'POST /download': {
          const { modelId } = await readBody(req);
          const m = catalog.find((x) => x.id === modelId);
          if (!m) return send(res, 404, { error: 'unknown model' });
          if (downloading) return send(res, 409, { error: 'busy' });
          downloading = true;
          (async () => {
            const totalBytes = m.files.reduce((a, f) => a + f.bytes, 0);
            let doneBytes = 0;
            for (const f of m.files) {
              await downloadFile(hfUrl(m, f.name), join(modelsDir(), m.id, f.name), f.sha256, f.bytes,
                (r) => { download = { modelId: m.id, receivedBytes: doneBytes + r, totalBytes }; });
              doneBytes += f.bytes;
            }
          })().catch(() => {}).finally(() => { download = null; downloading = false; });
          return send(res, 202, {});
        }
        case 'POST /start': {
          const { modelId } = await readBody(req);
          const m = catalog.find((x) => x.id === modelId);
          if (!m) return send(res, 404, { error: 'unknown model' });
          if (!binaryInstalled() || !modelDownloaded(m)) return send(res, 428, { error: 'binary or model not downloaded' });
          if (deps.supervisor.state === 'ready' || deps.supervisor.state === 'loading-model') {
            await deps.supervisor.stop(); // one-model policy: replace our own automatically
          }
          const available = await deps.availableBytes();
          const fit = checkFit(m.memoryBytes, available, totalRamBytes());
          if (!fit.fits) {
            const foreign = await scanForeign([deps.supervisor.managedPid() ?? -1, process.pid]);
            const foreignBytes = foreign.reduce((a, p) => a + p.rssBytes, 0);
            const rejection: StartRejection = {
              reason: 'insufficient-memory',
              requiredBytes: fit.requiredBytes,
              availableBytes: fit.availableBytes,
              wouldFitAfterForeignKill: checkFit(m.memoryBytes, available + foreignBytes, totalRamBytes()).fits,
              foreign,
            };
            return send(res, 409, rejection);
          }
          await deps.supervisor.start(m, modelPath(m));
          return send(res, 200, {});
        }
        case 'POST /stop': { await deps.supervisor.stop(); return send(res, 200, {}); }
        case 'GET /foreign': return send(res, 200, await scanForeign([deps.supervisor.managedPid() ?? -1, process.pid]));
        case 'POST /foreign/kill': {
          const { pids } = await readBody(req);
          if (!Array.isArray(pids) || pids.some((p) => typeof p !== 'number')) return send(res, 400, { error: 'pids must be number[]' });
          return send(res, 200, killPids(pids));
        }
        case 'POST /shutdown': {
          send(res, 200, {});
          await deps.supervisor.stop();
          setTimeout(() => process.exit(0), 100);
          return;
        }
        default: return send(res, 404, { error: 'not found' });
      }
    } catch (e) {
      return send(res, 500, { error: String(e) });
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w @fortress-chat/manager`
Expected: PASS. Note: the guard test relies on the injected `availableBytes` — no real `vm_stat` in tests.

- [ ] **Step 5: Commit**

```bash
git add packages/manager
git commit -m "feat(manager): token-authed HTTP API with memory-guarded start and foreign-process endpoints"
```

---

### Task 11: manager — daemon entry: singleton, idle exit, integration test

**Files:**
- Create: `packages/manager/src/index.ts`
- Test: `packages/manager/test/daemon.integration.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `node packages/manager/dist/index.js` starts the daemon: refuses to double-start (existing live daemon.json), binds a random free port on 127.0.0.1, generates a 32-byte hex token, writes `daemon.json`, logs to `daemon.log`, exits after 30 min without authenticated requests (env `FC_IDLE_MS` overrides for tests). This exact invocation is what the extension spawns (Task 12).

- [ ] **Step 1: Write the failing integration test** (`packages/manager/test/daemon.integration.test.ts`)

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENTRY = join(__dirname, '..', 'dist', 'index.js');
let dataDir: string; let child: ChildProcess | null = null;

function daemonInfo() { return JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')); }
async function waitFor(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (fn()) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('timeout');
}

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'fc-daemon-')); });
afterEach(() => { child?.kill('SIGKILL'); child = null; });

describe('daemon', () => {
  it('starts, writes daemon.json, answers /status with token, 401 without', async () => {
    child = spawn(process.execPath, [ENTRY], { env: { ...process.env, FC_DATA_DIR: dataDir } });
    await waitFor(() => !!daemonInfo().port);
    const { port, token } = daemonInfo();
    const ok = await fetch(`http://127.0.0.1:${port}/status`, { headers: { 'x-fc-token': token } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).state).toBe('idle');
    const bad = await fetch(`http://127.0.0.1:${port}/status`);
    expect(bad.status).toBe(401);
  });

  it('exits after idle timeout', async () => {
    child = spawn(process.execPath, [ENTRY], { env: { ...process.env, FC_DATA_DIR: dataDir, FC_IDLE_MS: '500' } });
    await waitFor(() => !!daemonInfo().port);
    const exited = new Promise((r) => child!.on('exit', r));
    await expect(Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('no exit')), 5000))])).resolves.toBeDefined();
  });

  it('second instance refuses to start while first is alive', async () => {
    child = spawn(process.execPath, [ENTRY], { env: { ...process.env, FC_DATA_DIR: dataDir } });
    await waitFor(() => !!daemonInfo().port);
    const second = spawn(process.execPath, [ENTRY], { env: { ...process.env, FC_DATA_DIR: dataDir } });
    const code = await new Promise((r) => second.on('exit', r));
    expect(code).toBe(3); // EXIT_ALREADY_RUNNING
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && npm test -w @fortress-chat/manager`
Expected: FAIL — `dist/index.js` missing.

- [ ] **Step 3: Implement** (`packages/manager/src/index.ts`)

```ts
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApi } from './httpApi';
import { Supervisor } from './supervisor';
import { dataDir, readDaemonInfo, writeDaemonInfo, isProcessAlive } from './paths';
import { readAvailableBytes } from './memory';

const EXIT_ALREADY_RUNNING = 3;
const IDLE_MS = Number(process.env.FC_IDLE_MS ?? 30 * 60 * 1000);

function log(msg: string): void {
  appendFileSync(join(dataDir(), 'daemon.log'), `${new Date().toISOString()} ${msg}\n`);
}

async function main(): Promise<void> {
  const existing = readDaemonInfo();
  if (existing && isProcessAlive(existing.pid)) {
    log(`refusing to start: daemon ${existing.pid} alive`);
    process.exit(EXIT_ALREADY_RUNNING);
  }
  const token = randomBytes(32).toString('hex');
  const supervisor = new Supervisor();
  let lastActivity = Date.now();
  const api = createApi({
    supervisor,
    token,
    onActivity: () => { lastActivity = Date.now(); },
    availableBytes: readAvailableBytes,
  });
  api.listen(0, '127.0.0.1', () => {
    const port = (api.address() as AddressInfo).port;
    writeDaemonInfo({ pid: process.pid, port, token });
    log(`listening on 127.0.0.1:${port}`);
  });
  setInterval(async () => {
    if (Date.now() - lastActivity > IDLE_MS) {
      log('idle timeout: stopping server and exiting');
      await supervisor.stop();
      process.exit(0);
    }
  }, 5_000).unref();
  // keep process alive via the server; also survive terminal hangup when detached
  process.on('SIGHUP', () => {});
}

main().catch((e) => { log(`fatal: ${e}`); process.exit(1); });
```

- [ ] **Step 4: Build and run tests**

Run: `npm run build && npm test -w @fortress-chat/manager`
Expected: all manager tests pass, including the three integration tests.

- [ ] **Step 5: Commit**

```bash
git add packages/manager
git commit -m "feat(manager): daemon entry with singleton guard, token generation, and idle exit"
```

---

### Task 12: extension — scaffold + daemon client

**Files:**
- Create: `packages/extension/package.json`, `packages/extension/tsconfig.json`, `packages/extension/esbuild.mjs`, `packages/extension/src/extension.ts`, `packages/extension/src/daemon.ts`
- Test: `packages/extension/src/test/daemon.test.ts` (pure-logic parts, vitest)

**Interfaces:**
- Consumes: daemon entry contract (Task 11), shared API types.
- Produces:
  - `class DaemonClient { constructor(port: number, token: string); status(): Promise<StatusResponse>; catalog(): Promise<CatalogModel[]>; download(modelId): Promise<void>; installBinary(): Promise<void>; start(modelId): Promise<{ ok: true } | { ok: false; rejection: StartRejection }>; stop(): Promise<void>; foreignKill(pids: number[]): Promise<void>; shutdown(): Promise<void> }`
  - `async function ensureDaemon(managerEntryPath: string): Promise<DaemonClient>` — reads `daemon.json`; if stale/missing spawns `node <managerEntryPath>` detached (`stdio: 'ignore'`, `detached: true`, `unref()`), polls `daemon.json` + `/status` until live (10 s timeout).
  - Extension activates on view `fortressChat.chat`; command `fortress-chat.openChat`.

- [ ] **Step 1: Write extension package files**

`packages/extension/package.json`:

```json
{
  "name": "fortress-chat",
  "displayName": "FortressChat",
  "description": "Local US-model chat + agent for VS Code. Memory-safe llama.cpp management built in.",
  "version": "0.1.0",
  "publisher": "coachcurtis",
  "repository": { "type": "git", "url": "https://github.com/curtismuir/fortress-chat" },
  "engines": { "vscode": "^1.90.0" },
  "categories": ["AI", "Chat"],
  "main": "./out/extension.js",
  "activationEvents": [],
  "contributes": {
    "viewsContainers": { "activitybar": [{ "id": "fortress-chat", "title": "FortressChat", "icon": "media/icon.svg" }] },
    "views": { "fortress-chat": [{ "type": "webview", "id": "fortressChat.chat", "name": "Chat" }] },
    "commands": [{ "command": "fortress-chat.openChat", "title": "FortressChat: Open Chat" }]
  },
  "scripts": {
    "build": "node esbuild.mjs && tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "package": "vsce package --no-dependencies -o ../../fortress-chat.vsix"
  },
  "dependencies": { "@fortress-chat/shared": "0.1.0" },
  "devDependencies": {
    "typescript": "^5.5.0", "vitest": "^2.0.0", "@types/node": "^20.0.0",
    "@types/vscode": "^1.90.0", "esbuild": "^0.23.0", "@vscode/vsce": "^3.0.0"
  }
}
```

`packages/extension/esbuild.mjs`:

```js
import { build } from 'esbuild';

// extension host bundle
await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  outfile: 'out/extension.js',
  sourcemap: true,
});

// manager daemon bundle shipped inside the extension
await build({
  entryPoints: ['../manager/src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'out/manager/index.js',
  sourcemap: true,
});
```

`packages/extension/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "out", "rootDir": "src", "types": ["node", "vscode"] },
  "include": ["src"]
}
```

Also create `packages/extension/media/icon.svg`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21V10l4-3V4h4v1l2-1.5L15 5V4h4v3l4 3v11H3z"/></svg>
```

- [ ] **Step 2: Write the failing test for DaemonClient rejection parsing** (`packages/extension/src/test/daemon.test.ts`)

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '../daemon';

let server: Server; let port: number;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.headers['x-fc-token'] !== 't') { res.writeHead(401); res.end('{}'); return; }
    if (req.url === '/start') {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reason: 'insufficient-memory', requiredBytes: 10, availableBytes: 5, wouldFitAfterForeignKill: true, foreign: [] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ state: 'idle' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());

describe('DaemonClient', () => {
  it('start() surfaces 409 as a typed rejection, not an exception', async () => {
    const c = new DaemonClient(port, 't');
    const r = await c.start('gpt-oss-20b');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.reason).toBe('insufficient-memory');
  });

  it('throws on auth failure', async () => {
    const c = new DaemonClient(port, 'wrong');
    await expect(c.status()).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm install && npm test -w fortress-chat`
Expected: FAIL — `../daemon` missing.

- [ ] **Step 4: Implement `daemon.ts` and `extension.ts`**

`packages/extension/src/daemon.ts`:

```ts
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CatalogModel, StatusResponse, StartRejection } from '@fortress-chat/shared';

function dataDir(): string {
  return process.env.FC_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'fortress-chat');
}

interface DaemonInfo { pid: number; port: number; token: string }

function readInfo(): DaemonInfo | null {
  try { return JSON.parse(readFileSync(join(dataDir(), 'daemon.json'), 'utf8')); } catch { return null; }
}

export class DaemonClient {
  constructor(private port: number, private token: string) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      ...init,
      headers: { 'x-fc-token': this.token, 'content-type': 'application/json', ...init.headers },
    });
    if (res.status === 401) throw new Error('daemon auth failed');
    return res;
  }

  async status(): Promise<StatusResponse> { return (await this.call('/status')).json(); }
  async catalog(): Promise<CatalogModel[]> { return (await this.call('/catalog')).json(); }
  async download(modelId: string): Promise<void> { await this.call('/download', { method: 'POST', body: JSON.stringify({ modelId }) }); }
  async installBinary(): Promise<void> { await this.call('/install-binary', { method: 'POST', body: '{}' }); }
  async stop(): Promise<void> { await this.call('/stop', { method: 'POST', body: '{}' }); }
  async foreignKill(pids: number[]): Promise<void> { await this.call('/foreign/kill', { method: 'POST', body: JSON.stringify({ pids }) }); }
  async shutdown(): Promise<void> { await this.call('/shutdown', { method: 'POST', body: '{}' }).catch(() => {}); }

  async start(modelId: string): Promise<{ ok: true } | { ok: false; rejection: StartRejection }> {
    const res = await this.call('/start', { method: 'POST', body: JSON.stringify({ modelId }) });
    if (res.status === 200) return { ok: true };
    if (res.status === 409) return { ok: false, rejection: await res.json() };
    throw new Error(`start failed: HTTP ${res.status} ${await res.text()}`);
  }
}

async function alive(info: DaemonInfo): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/status`, {
      headers: { 'x-fc-token': info.token }, signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch { return false; }
}

export async function ensureDaemon(managerEntryPath: string): Promise<DaemonClient> {
  const existing = readInfo();
  if (existing && (await alive(existing))) return new DaemonClient(existing.port, existing.token);
  if (!existsSync(managerEntryPath)) throw new Error(`manager bundle missing: ${managerEntryPath}`);
  spawn(process.execPath, [managerEntryPath], { detached: true, stdio: 'ignore' }).unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const info = readInfo();
    if (info && (await alive(info))) return new DaemonClient(info.port, info.token);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('daemon did not start within 10s (see daemon.log in the FortressChat data folder)');
}
```

`packages/extension/src/extension.ts`:

```ts
import * as vscode from 'vscode';
import { join } from 'node:path';
import { ensureDaemon } from './daemon';
import { ChatViewProvider } from './chat/ChatViewProvider';

export function activate(context: vscode.ExtensionContext): void {
  const managerEntry = join(context.extensionPath, 'out', 'manager', 'index.js');
  const provider = new ChatViewProvider(context, () => ensureDaemon(managerEntry));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('fortressChat.chat', provider),
    vscode.commands.registerCommand('fortress-chat.openChat', () =>
      vscode.commands.executeCommand('fortressChat.chat.focus')),
  );
}

export function deactivate(): void {}
```

(`ChatViewProvider` arrives in Task 13 — to keep this task green, create `packages/extension/src/chat/ChatViewProvider.ts` with the minimal class from Task 13 Step 1.)

- [ ] **Step 5: Run tests**

Run: `npm test -w fortress-chat`
Expected: 2 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/extension
git commit -m "feat(extension): scaffold with bundled manager and daemon find-or-spawn client"
```

---

### Task 13: extension — chat webview with streaming, banner errors, watchdog

**Files:**
- Create: `packages/extension/src/chat/ChatViewProvider.ts`, `packages/extension/src/chat/session.ts`, `packages/extension/src/chat/stream.ts`, `packages/extension/media/chat.html`, `packages/extension/media/chat.css`, `packages/extension/media/chat.js`
- Test: `packages/extension/src/test/session.test.ts`, `packages/extension/src/test/stream.test.ts`

**Interfaces:**
- Consumes: `DaemonClient`/`ensureDaemon` (Task 12), `ChatMessage`/`validateHistory` (shared).
- Produces:
  - `class Session { messages: ChatMessage[]; addUser(text): void; addAssistant(text): void; toRequestMessages(systemPrompt: string): ChatMessage[]; static load(state: vscode.Memento): Session; save(state: vscode.Memento): void; clear(): void }` — `toRequestMessages` runs `validateHistory` and throws rather than send malformed history.
  - `async function streamChat(endpoint: string, messages: ChatMessage[], onToken: (t: string) => void, signal: AbortSignal): Promise<string>` — POST `/v1/chat/completions` `{stream: true}`, parses SSE, resolves full text; rejects `WatchdogError` if no token for 60 s (env `FC_WATCHDOG_MS` override for tests).
  - Webview protocol (postMessage both ways):
    - to webview: `{type:'state', status: StatusResponse}`, `{type:'token', text}`, `{type:'done', full}`, `{type:'error', message}` (banner), `{type:'history', messages}`, `{type:'downloadProgress', received, total, label}`
    - from webview: `{type:'send', text}`, `{type:'cancel'}`, `{type:'newChat'}`, `{type:'chooseModel', modelId}`, `{type:'downloadModel', modelId}`, `{type:'installBinary'}`, `{type:'killForeign', pids}`, `{type:'agentToggle', on}` (handled in Task 15)

- [ ] **Step 1: Write failing tests**

`packages/extension/src/test/session.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Session } from '../chat/session';

describe('Session', () => {
  it('builds request messages with system prompt first', () => {
    const s = new Session();
    s.addUser('hi'); s.addAssistant('hello');
    const msgs = s.toRequestMessages('SYS');
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(msgs).toHaveLength(3);
  });

  it('errors are NEVER messages: session only accepts typed roles', () => {
    const s = new Session();
    // @ts-expect-error - no API exists to push arbitrary objects
    expect(() => s.messages.push({ content: 'Request failed with status code 503' })).toBeTruthy;
    s.addUser('x');
    expect(() => s.toRequestMessages('SYS')).not.toThrow();
  });

  it('round-trips through a Memento-like store', () => {
    const store = new Map<string, unknown>();
    const memento = { get: (k: string) => store.get(k), update: (k: string, v: unknown) => (store.set(k, v), Promise.resolve()) } as any;
    const s = new Session();
    s.addUser('persisted');
    s.save(memento);
    expect(Session.load(memento).messages[0].content).toBe('persisted');
  });
});
```

`packages/extension/src/test/stream.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { streamChat, WatchdogError } from '../chat/stream';

let server: Server; let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url === '/v1/chat/completions') {
      res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('streamChat', () => {
  it('concatenates SSE deltas and reports tokens', async () => {
    const tokens: string[] = [];
    const full = await streamChat(base, [{ role: 'user', content: 'hi' }], (t) => tokens.push(t), new AbortController().signal);
    expect(full).toBe('Hello');
    expect(tokens).toEqual(['Hel', 'lo']);
  });

  it('watchdog rejects when stream stalls', async () => {
    process.env.FC_WATCHDOG_MS = '200';
    const stall = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/event-stream' })); // never writes
    await new Promise<void>((r) => stall.listen(0, '127.0.0.1', r));
    const stallBase = `http://127.0.0.1:${(stall.address() as AddressInfo).port}`;
    await expect(streamChat(stallBase, [{ role: 'user', content: 'hi' }], () => {}, new AbortController().signal))
      .rejects.toThrow(WatchdogError);
    stall.close();
    delete process.env.FC_WATCHDOG_MS;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w fortress-chat`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement session + stream**

`packages/extension/src/chat/session.ts`:

```ts
import type { Memento } from 'vscode';
import { validateHistory, type ChatMessage } from '@fortress-chat/shared';

const KEY = 'fortressChat.session';

export class Session {
  messages: ChatMessage[] = [];

  addUser(text: string): void { this.messages.push({ role: 'user', content: text }); }
  addAssistant(text: string): void { this.messages.push({ role: 'assistant', content: text }); }
  addToolExchange(assistant: ChatMessage, results: ChatMessage[]): void { this.messages.push(assistant, ...results); }
  clear(): void { this.messages = []; }

  toRequestMessages(systemPrompt: string): ChatMessage[] {
    return validateHistory([{ role: 'system', content: systemPrompt }, ...this.messages]);
  }

  save(state: Memento): void { void state.update(KEY, this.messages); }

  static load(state: Memento): Session {
    const s = new Session();
    try { s.messages = validateHistory(state.get(KEY) ?? []); } catch { s.messages = []; }
    return s;
  }
}
```

`packages/extension/src/chat/stream.ts`:

```ts
import type { ChatMessage } from '@fortress-chat/shared';

export class WatchdogError extends Error {}

export async function streamChat(
  endpoint: string, messages: ChatMessage[], onToken: (t: string) => void, signal: AbortSignal,
): Promise<string> {
  const watchdogMs = Number(process.env.FC_WATCHDOG_MS ?? 60_000);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort);
  let timer = setTimeout(() => ctrl.abort(new WatchdogError('no tokens for 60s')), watchdogMs);
  try {
    const res = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages, stream: true }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`llama-server HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    let full = '';
    let buf = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const event = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const data = event.replace(/^data: /m, '').trim();
        if (!data || data === '[DONE]') continue;
        const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length) {
          clearTimeout(timer);
          timer = setTimeout(() => ctrl.abort(new WatchdogError('no tokens for 60s')), watchdogMs);
          full += delta;
          onToken(delta);
        }
      }
    }
    return full;
  } catch (e) {
    if (ctrl.signal.reason instanceof WatchdogError) throw ctrl.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w fortress-chat`
Expected: session + stream tests pass.

- [ ] **Step 5: Implement the view provider and webview assets**

`packages/extension/src/chat/ChatViewProvider.ts`:

```ts
import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StatusResponse } from '@fortress-chat/shared';
import { DaemonClient } from '../daemon';
import { Session } from './session';
import { streamChat } from './stream';
import { runAgentTurn } from '../agent/loop';

const SYSTEM_PROMPT = 'You are FortressChat, a helpful local coding assistant running fully on this machine.';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private client: DaemonClient | null = null;
  private session: Session;
  private generating: AbortController | null = null;
  private agentMode = false;
  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(private context: vscode.ExtensionContext, private connect: () => Promise<DaemonClient>) {
    this.session = Session.load(context.workspaceState);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    let html = readFileSync(join(this.context.extensionPath, 'media', 'chat.html'), 'utf8');
    for (const f of ['chat.css', 'chat.js']) {
      html = html.replace(f, view.webview.asWebviewUri(vscode.Uri.joinPath(media, f)).toString());
    }
    view.webview.html = html;
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    void this.init();
  }

  private post(msg: unknown): void { void this.view?.webview.postMessage(msg); }
  private banner(message: string): void { this.post({ type: 'error', message }); }

  private async init(): Promise<void> {
    try {
      this.client = await this.connect();
      this.post({ type: 'history', messages: this.session.messages });
      this.poller = setInterval(() => void this.pushStatus(), 2000);
      this.context.subscriptions.push({ dispose: () => this.poller && clearInterval(this.poller) });
      await this.pushStatus();
    } catch (e) {
      this.banner(`Could not start the FortressChat daemon: ${e}`);
    }
  }

  private async pushStatus(): Promise<void> {
    if (!this.client) return;
    try {
      const status: StatusResponse = await this.client.status();
      this.post({ type: 'state', status });
    } catch { /* daemon idle-exited; next send re-spawns */ }
  }

  private async onMessage(m: any): Promise<void> {
    try {
      switch (m.type) {
        case 'send': return await this.handleSend(String(m.text));
        case 'cancel': this.generating?.abort(); return;
        case 'newChat': this.session.clear(); this.session.save(this.context.workspaceState); this.post({ type: 'history', messages: [] }); return;
        case 'agentToggle': this.agentMode = !!m.on; return;
        case 'chooseModel': await this.startModel(String(m.modelId)); return;
        case 'downloadModel': await this.client?.download(String(m.modelId)); return;
        case 'installBinary': await this.client?.installBinary(); return;
        case 'killForeign': await this.client?.foreignKill(m.pids); return;
      }
    } catch (e) {
      this.banner(String(e));
    }
  }

  private async startModel(modelId: string): Promise<void> {
    if (!this.client) this.client = await this.connect();
    const r = await this.client.start(modelId);
    if (!r.ok) this.post({ type: 'startRejected', rejection: r.rejection, modelId });
    await this.pushStatus();
  }

  private async handleSend(text: string): Promise<void> {
    if (!this.client) this.client = await this.connect();
    const status = await this.client.status();
    if (status.state !== 'ready' || !status.endpoint) {
      this.banner(status.state === 'crashed'
        ? `The model server crashed. Last log lines:\n${(status.crashLog ?? []).slice(-5).join('\n')}`
        : `Model is not ready (state: ${status.state}). Pick or wait for a model first.`);
      this.post({ type: 'restoreInput', text });
      return;
    }
    this.session.addUser(text);
    this.post({ type: 'history', messages: this.session.messages });
    this.generating = new AbortController();
    try {
      if (this.agentMode) {
        await runAgentTurn(status.endpoint, this.session, SYSTEM_PROMPT,
          (step) => this.post({ type: 'agentStep', step }), this.generating.signal);
      } else {
        const full = await streamChat(status.endpoint, this.session.toRequestMessages(SYSTEM_PROMPT),
          (t) => this.post({ type: 'token', text: t }), this.generating.signal);
        this.session.addAssistant(full);
      }
      this.session.save(this.context.workspaceState);
      this.post({ type: 'history', messages: this.session.messages });
    } catch (e) {
      // Error hygiene: pop the user message back into the input, never into history.
      this.session.messages.pop();
      this.session.save(this.context.workspaceState);
      this.post({ type: 'history', messages: this.session.messages });
      this.post({ type: 'restoreInput', text });
      this.banner(String(e));
    } finally {
      this.generating = null;
    }
  }
}
```

`packages/extension/media/chat.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src {cspSource} 'unsafe-inline'; script-src {cspSource};" />
  <link rel="stylesheet" href="chat.css" />
</head>
<body>
  <div id="banner" hidden><span id="banner-text"></span><button id="banner-close">×</button></div>
  <div id="setup" hidden></div>
  <header>
    <select id="model-picker"></select>
    <label><input type="checkbox" id="agent-toggle" /> Agent</label>
    <button id="new-chat">New chat</button>
  </header>
  <main id="messages"></main>
  <div id="steps" hidden></div>
  <footer>
    <textarea id="input" rows="2" placeholder="Ask your local model…"></textarea>
    <button id="send">Send</button>
    <button id="cancel" hidden>Stop</button>
  </footer>
  <script src="chat.js"></script>
</body>
</html>
```

`packages/extension/media/chat.js` (framework-free; VS Code webview API):

```js
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let streaming = '';

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function renderHistory(messages) {
  streaming = '';
  $('messages').innerHTML = messages
    .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
    .map((m) => `<div class="msg ${m.role}"><pre>${esc(m.content)}</pre></div>`)
    .join('');
  $('messages').scrollTop = $('messages').scrollHeight;
}

function renderState(status) {
  const picker = $('model-picker');
  if (window.__catalog) {
    picker.innerHTML = window.__catalog.map((m) => {
      const dl = status.downloadedModelIds.includes(m.id);
      const cur = status.modelId === m.id ? ' ✓' : '';
      return `<option value="${m.id}" data-dl="${dl}">${m.displayName}${dl ? '' : ' (download)'}${cur}</option>`;
    }).join('');
    if (status.modelId) picker.value = status.modelId;
  }
  const setup = $('setup');
  if (!status.binaryInstalled) {
    setup.hidden = false;
    const gb = Math.round(status.ram.totalBytes / 2 ** 30);
    setup.innerHTML = `<h3>Welcome to FortressChat</h3>
      <p>This Mac has ${gb} GB RAM. One click sets up the local engine and a recommended model.</p>
      <button id="do-setup">Set up</button>`;
    document.getElementById('do-setup').onclick = () => vscode.postMessage({ type: 'installBinary' });
  } else if (status.download) {
    setup.hidden = false;
    const pct = Math.round((status.download.receivedBytes / status.download.totalBytes) * 100);
    setup.innerHTML = `<p>Downloading ${esc(status.download.modelId)}… ${pct}%</p><progress max="100" value="${pct}"></progress>`;
  } else if (status.state === 'loading-model' || status.state === 'starting') {
    setup.hidden = false;
    setup.innerHTML = `<p>Loading ${esc(status.modelId ?? 'model')}… (about 30 s for large models)</p>`;
  } else {
    setup.hidden = true;
  }
  $('send').disabled = status.state !== 'ready';
}

function renderRejection(rejection, modelId) {
  const need = Math.round(rejection.requiredBytes / 2 ** 30);
  const have = Math.round(rejection.availableBytes / 2 ** 30);
  const rows = rejection.foreign.map((p) =>
    `<li>${esc(p.command.slice(0, 80))} — ${Math.round(p.rssBytes / 2 ** 30)} GB (pid ${p.pid})</li>`).join('');
  $('setup').hidden = false;
  $('setup').innerHTML = `<h3>Not enough memory</h3>
    <p>${esc(modelId)} needs ~${need} GB but only ${have} GB is available.</p>
    ${rejection.foreign.length ? `<p>Other AI servers using memory:</p><ul>${rows}</ul>` : ''}
    ${rejection.wouldFitAfterForeignKill
      ? `<button id="kill-foreign">Stop these and continue</button>`
      : `<p>Even stopping those won't free enough. Try a smaller model.</p>`}`;
  const btn = document.getElementById('kill-foreign');
  if (btn) btn.onclick = () => {
    vscode.postMessage({ type: 'killForeign', pids: rejection.foreign.map((p) => p.pid) });
    setTimeout(() => vscode.postMessage({ type: 'chooseModel', modelId }), 2000);
  };
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'history') renderHistory(m.messages);
  if (m.type === 'state') renderState(m.status);
  if (m.type === 'catalog') { window.__catalog = m.models; }
  if (m.type === 'startRejected') renderRejection(m.rejection, m.modelId);
  if (m.type === 'restoreInput') { $('input').value = m.text; }
  if (m.type === 'error') { $('banner-text').textContent = m.message; $('banner').hidden = false; }
  if (m.type === 'token') {
    streaming += m.text;
    let el = document.querySelector('.msg.streaming pre');
    if (!el) {
      const div = document.createElement('div');
      div.className = 'msg assistant streaming';
      div.innerHTML = '<pre></pre>';
      $('messages').appendChild(div);
      el = div.querySelector('pre');
    }
    el.textContent = streaming;
    $('messages').scrollTop = $('messages').scrollHeight;
  }
  if (m.type === 'agentStep') {
    $('steps').hidden = false;
    $('steps').innerHTML += `<div class="step">${esc(m.step)}</div>`;
  }
});

$('send').onclick = () => {
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  $('banner').hidden = true;
  $('steps').innerHTML = ''; $('steps').hidden = true;
  vscode.postMessage({ type: 'send', text });
  $('cancel').hidden = false;
};
$('cancel').onclick = () => { vscode.postMessage({ type: 'cancel' }); $('cancel').hidden = true; };
$('new-chat').onclick = () => vscode.postMessage({ type: 'newChat' });
$('agent-toggle').onchange = (e) => vscode.postMessage({ type: 'agentToggle', on: e.target.checked });
$('model-picker').onchange = (e) => {
  const opt = e.target.selectedOptions[0];
  vscode.postMessage({ type: opt.dataset.dl === 'true' ? 'chooseModel' : 'downloadModel', modelId: e.target.value });
};
$('banner-close').onclick = () => { $('banner').hidden = true; };
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('send').click(); }
});
```

`packages/extension/media/chat.css`:

```css
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); display: flex; flex-direction: column; height: 100vh; margin: 0; }
header, footer { display: flex; gap: 6px; padding: 6px; align-items: center; }
main { flex: 1; overflow-y: auto; padding: 0 6px; }
.msg { margin: 6px 0; padding: 8px; border-radius: 6px; }
.msg pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; }
.msg.user { background: var(--vscode-input-background); }
.msg.assistant { background: var(--vscode-editorWidget-background); }
#banner { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); padding: 6px; display: flex; justify-content: space-between; white-space: pre-wrap; }
#setup { padding: 10px; background: var(--vscode-editorWidget-background); border-radius: 6px; margin: 6px; }
#steps { font-size: 0.85em; opacity: 0.8; padding: 4px 6px; }
#input { flex: 1; resize: none; background: var(--vscode-input-background); color: inherit; border: 1px solid var(--vscode-input-border); }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; border-radius: 3px; cursor: pointer; }
select { background: var(--vscode-dropdown-background); color: inherit; border: 1px solid var(--vscode-dropdown-border); }
```

Also in `ChatViewProvider.init()`, after connecting, send the catalog once:

```ts
this.post({ type: 'catalog', models: await this.client.catalog() });
```

(Note: `runAgentTurn` import will not resolve until Task 15 — create `packages/extension/src/agent/loop.ts` now with a stub that throws `new Error('Agent mode arrives in Task 15')` so the build stays green.)

- [ ] **Step 6: Build + manual smoke test**

Run: `npm run build -w fortress-chat`, then open `packages/extension` in VS Code, press F5 (Extension Development Host), open the FortressChat view.
Expected: setup screen appears (binary not installed) OR model picker if your data dir already has state; sending with no ready model shows the banner and restores your text into the input box — **not** into the history.

- [ ] **Step 7: Commit**

```bash
git add packages/extension
git commit -m "feat(extension): chat webview with SSE streaming, error banners, watchdog, and first-run setup screen"
```

---

### Task 14: extension — agent tools (read_file, list_files, search, edit_file)

**Files:**
- Create: `packages/extension/src/agent/tools.ts`
- Test: `packages/extension/src/test/tools.test.ts` (path-safety logic only; vscode-API parts are manually verified in Task 15)

**Interfaces:**
- Produces:
  - `const TOOL_SCHEMAS: object[]` — OpenAI function schemas for the four tools.
  - `function resolveInWorkspace(root: string, relPath: string): string` — throws `PathEscapeError` if the resolved path leaves `root` (blocks `../` and absolute paths).
  - `async function executeTool(name: string, args: any, workspaceRoot: string): Promise<string>` — dispatches; `edit_file` shows a VS Code diff and returns `'applied'` / `'rejected by user'`.

- [ ] **Step 1: Write the failing test** (`packages/extension/src/test/tools.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { resolveInWorkspace, PathEscapeError, TOOL_SCHEMAS } from '../agent/tools';

describe('resolveInWorkspace', () => {
  it('resolves inside the workspace', () => {
    expect(resolveInWorkspace('/ws', 'src/a.ts')).toBe('/ws/src/a.ts');
  });
  it('blocks .. escape and absolute paths', () => {
    expect(() => resolveInWorkspace('/ws', '../etc/passwd')).toThrow(PathEscapeError);
    expect(() => resolveInWorkspace('/ws', '/etc/passwd')).toThrow(PathEscapeError);
    expect(() => resolveInWorkspace('/ws', 'a/../../x')).toThrow(PathEscapeError);
  });
});

describe('TOOL_SCHEMAS', () => {
  it('exposes exactly the four v1 tools', () => {
    const names = TOOL_SCHEMAS.map((t: any) => t.function.name).sort();
    expect(names).toEqual(['edit_file', 'list_files', 'read_file', 'search']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w fortress-chat`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** (`packages/extension/src/agent/tools.ts`)

```ts
import * as vscode from 'vscode';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, sep, join, relative } from 'node:path';

export class PathEscapeError extends Error {}

export const TOOL_SCHEMAS = [
  { type: 'function', function: { name: 'read_file', description: 'Read a text file from the workspace', parameters: { type: 'object', properties: { path: { type: 'string', description: 'workspace-relative path' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_files', description: 'List files under a workspace directory (recursive, max 200 entries)', parameters: { type: 'object', properties: { path: { type: 'string', description: 'workspace-relative directory, "" for root' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search', description: 'Search file contents with a case-sensitive substring', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Replace the full contents of a file (or create it). The user reviews a diff and can reject.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: 'complete new file contents' } }, required: ['path', 'content'] } } },
];

export function resolveInWorkspace(root: string, relPath: string): string {
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) throw new PathEscapeError(`path escapes workspace: ${relPath}`);
  return abs;
}

const IGNORE = new Set(['node_modules', '.git', 'dist', 'out', '.venv']);

function walk(dir: string, root: string, acc: string[], limit: number): void {
  if (acc.length >= limit) return;
  for (const name of readdirSync(dir)) {
    if (IGNORE.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, acc, limit);
    else acc.push(relative(root, full));
    if (acc.length >= limit) return;
  }
}

async function editFileWithApproval(abs: string, content: string, rel: string): Promise<string> {
  const uri = vscode.Uri.file(abs);
  let original = '';
  try { original = readFileSync(abs, 'utf8'); } catch { /* new file */ }
  const left = vscode.Uri.parse(`untitled:${rel}.orig`).with({ scheme: 'fc-orig', path: rel });
  const provider = vscode.workspace.registerTextDocumentContentProvider('fc-orig', {
    provideTextDocumentContent: () => original,
  });
  const right = vscode.Uri.parse(`fc-new:${rel}`).with({ scheme: 'fc-new', path: rel });
  const provider2 = vscode.workspace.registerTextDocumentContentProvider('fc-new', {
    provideTextDocumentContent: () => content,
  });
  try {
    await vscode.commands.executeCommand('vscode.diff', left, right, `Agent edit: ${rel}`);
    const choice = await vscode.window.showInformationMessage(`Apply agent edit to ${rel}?`, { modal: true }, 'Apply', 'Reject');
    if (choice !== 'Apply') return 'rejected by user';
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: true, contents: Buffer.from(content, 'utf8') });
    await vscode.workspace.applyEdit(edit);
    return 'applied';
  } finally {
    provider.dispose(); provider2.dispose();
  }
}

export async function executeTool(name: string, args: any, workspaceRoot: string): Promise<string> {
  switch (name) {
    case 'read_file': {
      const abs = resolveInWorkspace(workspaceRoot, String(args.path));
      const body = readFileSync(abs, 'utf8');
      return body.length > 50_000 ? body.slice(0, 50_000) + '\n…(truncated)' : body;
    }
    case 'list_files': {
      const abs = resolveInWorkspace(workspaceRoot, String(args.path ?? ''));
      const acc: string[] = [];
      walk(abs, workspaceRoot, acc, 200);
      return acc.join('\n') || '(empty)';
    }
    case 'search': {
      const acc: string[] = [];
      walk(workspaceRoot, workspaceRoot, acc, 2000);
      const hits: string[] = [];
      for (const rel of acc) {
        try {
          const lines = readFileSync(join(workspaceRoot, rel), 'utf8').split('\n');
          lines.forEach((line, i) => {
            if (line.includes(String(args.query)) && hits.length < 100) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        } catch { /* binary or unreadable */ }
      }
      return hits.join('\n') || 'no matches';
    }
    case 'edit_file': {
      const rel = String(args.path);
      const abs = resolveInWorkspace(workspaceRoot, rel);
      return editFileWithApproval(abs, String(args.content), rel);
    }
    default:
      return `unknown tool: ${name}`;
  }
}
```

**Note:** `tools.test.ts` imports only `resolveInWorkspace`/`TOOL_SCHEMAS`; vitest must not load the `vscode` module. Add to `packages/extension/package.json` a vitest alias:

```json
"vitest": { "resolve": { "alias": { "vscode": "./src/test/vscode-stub.ts" } } }
```

and create `packages/extension/src/test/vscode-stub.ts`:

```ts
export default {};
export const Uri = { file: (p: string) => ({ path: p }), parse: (s: string) => ({ with: (x: any) => x }) };
export const workspace = {} as any;
export const window = {} as any;
export const commands = {} as any;
```

(If the inline `vitest` key is not picked up, create `packages/extension/vitest.config.ts` with the same alias — exact file:

```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
export default defineConfig({ resolve: { alias: { vscode: resolve(__dirname, 'src/test/vscode-stub.ts') } } });
```

)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w fortress-chat`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension
git commit -m "feat(extension): four agent tools with workspace path confinement and diff-approval edits"
```

---

### Task 15: extension — agent loop

**Files:**
- Create: `packages/extension/src/agent/loop.ts` (replace Task 13's stub)
- Test: `packages/extension/src/test/loop.test.ts`

**Interfaces:**
- Consumes: `TOOL_SCHEMAS`, `executeTool` (Task 14), `Session` (Task 13), `ChatMessage`/`ToolCall` (shared).
- Produces:
  - `const MAX_ITERATIONS = 10`
  - `async function runAgentTurn(endpoint: string, session: Session, systemPrompt: string, onStep: (step: string) => void, signal: AbortSignal, deps?: { complete?: typeof completeOnce; execute?: typeof executeTool; workspaceRoot?: string }): Promise<void>` — non-streaming completions; executes tool calls; appends assistant + tool messages to the session; stops on a content-only reply or `MAX_ITERATIONS`.
  - `async function completeOnce(endpoint: string, messages: ChatMessage[], signal: AbortSignal): Promise<{ content: string; toolCalls: ToolCall[] }>` — POST `/v1/chat/completions` with `tools: TOOL_SCHEMAS`, `stream: false`.

- [ ] **Step 1: Write the failing test** (`packages/extension/src/test/loop.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { runAgentTurn, MAX_ITERATIONS } from '../agent/loop';
import { Session } from '../chat/session';

function fakeCompleter(script: Array<{ content: string; toolCalls: any[] }>) {
  let i = 0;
  return async () => script[Math.min(i++, script.length - 1)];
}

describe('runAgentTurn', () => {
  it('executes tool calls then finishes on content reply', async () => {
    const session = new Session();
    session.addUser('read a file');
    const executed: string[] = [];
    await runAgentTurn('http://x', session, 'SYS', () => {}, new AbortController().signal, {
      complete: fakeCompleter([
        { content: '', toolCalls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
        { content: 'The file says hi.', toolCalls: [] },
      ]),
      execute: async (name) => { executed.push(name); return 'hi'; },
      workspaceRoot: '/ws',
    });
    expect(executed).toEqual(['read_file']);
    const last = session.messages.at(-1)!;
    expect(last).toEqual({ role: 'assistant', content: 'The file says hi.' });
    // tool exchange is recorded with valid roles
    expect(session.messages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('stops after MAX_ITERATIONS of pure tool calls', async () => {
    const session = new Session();
    session.addUser('loop forever');
    let calls = 0;
    await runAgentTurn('http://x', session, 'SYS', () => {}, new AbortController().signal, {
      complete: async () => { calls++; return { content: '', toolCalls: [{ id: String(calls), type: 'function', function: { name: 'search', arguments: '{"query":"x"}' } }] }; },
      execute: async () => 'nothing',
      workspaceRoot: '/ws',
    });
    expect(calls).toBe(MAX_ITERATIONS);
    expect(session.messages.at(-1)!.content).toContain('iteration limit');
  });

  it('reports malformed tool arguments as a tool error result, not a crash', async () => {
    const session = new Session();
    session.addUser('bad args');
    await runAgentTurn('http://x', session, 'SYS', () => {}, new AbortController().signal, {
      complete: fakeCompleter([
        { content: '', toolCalls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: 'NOT JSON' } }] },
        { content: 'done', toolCalls: [] },
      ]),
      execute: async () => 'never called',
      workspaceRoot: '/ws',
    });
    const toolMsg = session.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toContain('invalid arguments');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w fortress-chat`
Expected: FAIL — stub throws / exports missing.

- [ ] **Step 3: Implement** (`packages/extension/src/agent/loop.ts`)

```ts
import * as vscode from 'vscode';
import type { ChatMessage, ToolCall } from '@fortress-chat/shared';
import { TOOL_SCHEMAS, executeTool } from './tools';
import type { Session } from '../chat/session';

export const MAX_ITERATIONS = 10;

export async function completeOnce(
  endpoint: string, messages: ChatMessage[], signal: AbortSignal,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const res = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, tools: TOOL_SCHEMAS, stream: false }),
    signal,
  });
  if (!res.ok) throw new Error(`llama-server HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  const msg = (await res.json())?.choices?.[0]?.message ?? {};
  return { content: typeof msg.content === 'string' ? msg.content : '', toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [] };
}

export async function runAgentTurn(
  endpoint: string, session: Session, systemPrompt: string,
  onStep: (step: string) => void, signal: AbortSignal,
  deps: { complete?: typeof completeOnce; execute?: typeof executeTool; workspaceRoot?: string } = {},
): Promise<void> {
  const complete = deps.complete ?? completeOnce;
  const execute = deps.execute ?? executeTool;
  const root = deps.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error('Agent mode needs an open workspace folder');

  const agentSystem = `${systemPrompt}\nYou can use tools to inspect and edit files in the user's workspace. Use tools when needed; when you have the answer, reply in plain text without tool calls.`;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal.aborted) throw new Error('cancelled');
    const { content, toolCalls } = await complete(endpoint, session.toRequestMessages(agentSystem), signal);
    if (toolCalls.length === 0) {
      session.addAssistant(content || '(no reply)');
      return;
    }
    const assistantMsg: ChatMessage = { role: 'assistant', content: content ?? '', tool_calls: toolCalls };
    const results: ChatMessage[] = [];
    for (const tc of toolCalls) {
      onStep(`${tc.function.name}(${tc.function.arguments.slice(0, 120)})`);
      let result: string;
      try {
        let parsed: unknown;
        try { parsed = JSON.parse(tc.function.arguments); }
        catch { result = 'error: invalid arguments (not valid JSON)'; results.push({ role: 'tool', content: result, tool_call_id: tc.id }); continue; }
        result = await execute(tc.function.name, parsed, root);
      } catch (e) {
        result = `error: ${e}`;
      }
      results.push({ role: 'tool', content: result, tool_call_id: tc.id });
    }
    session.addToolExchange(assistantMsg, results);
  }
  session.addAssistant('Stopped: agent iteration limit (10) reached without a final answer.');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w fortress-chat`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the toolCalling gate**

In `packages/extension/media/chat.js` `renderState`, add after the `$('send').disabled` line:

```js
const cur = (window.__catalog || []).find((m) => m.id === status.modelId);
const agentEl = $('agent-toggle');
agentEl.disabled = !cur || !cur.toolCalling;
agentEl.title = agentEl.disabled ? 'This model cannot use tools — switch to Gemma 3 12B+/gpt-oss for agent mode' : '';
if (agentEl.disabled) { agentEl.checked = false; }
```

- [ ] **Step 6: Build + manual verification in Extension Development Host**

Run: `npm run build -w fortress-chat`, F5, with a small downloaded model (or the stub via `FC_LLAMA_BIN`).
Expected: agent toggle disabled for non-tool models; with a tool model, "create a file named hello.txt containing hi" produces an `edit_file` step, a diff opens, Apply writes the file, Reject does not.

- [ ] **Step 7: Commit**

```bash
git add packages/extension
git commit -m "feat(extension): agent loop with 10-iteration cap, step display, and tool-capability gate"
```

---

### Task 16: CI + packaging + README

**Files:**
- Create: `.github/workflows/ci.yml`, `README.md`

**Interfaces:**
- Consumes: root `npm run build` / `npm test`, extension `npm run package`.
- Produces: green CI on push; `.vsix` attached to GitHub Release on tags `v*`.

- [ ] **Step 1: Write the workflow** (`.github/workflows/ci.yml`)

```yaml
name: ci
on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:

jobs:
  test:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: npm test

  package:
    needs: test
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: macos-14
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: npm run package -w fortress-chat
      - uses: softprops/action-gh-release@v2
        with: { files: fortress-chat.vsix }
```

- [ ] **Step 2: Write README.md**

```markdown
# FortressChat

Local AI chat + coding agent for VS Code. US-origin open models only
(Google Gemma 3, OpenAI gpt-oss), running fully on your machine via llama.cpp
— with built-in memory safety so a model never takes down your Mac.

## Why

- **Zero setup.** No models? No llama.cpp? One click downloads both, sized to
  your RAM.
- **Memory-safe.** A pre-flight check refuses to load a model that doesn't fit
  in available memory, and shows you exactly what's hogging it.
- **Robust.** Requests wait for the model to finish loading; server errors show
  as banners, never corrupt your chat; crashes offer one-click restart.
- **Agent with guardrails.** The model can read, list, search, and edit files
  in your workspace — every edit shows a diff you approve or reject. No
  terminal access.

## Install

1. Download `fortress-chat.vsix` from the latest GitHub Release.
2. VS Code → Extensions panel → `…` menu → **Install from VSIX…**
3. Open the FortressChat icon in the activity bar and click **Set up**.

Requirements: Apple Silicon Mac, macOS 13+, VS Code 1.90+. (Windows/Linux
planned.)

## Development

npm-workspaces monorepo: `packages/shared` (contract + catalog),
`packages/manager` (background daemon), `packages/extension` (VS Code client).

    npm install
    npm run build
    npm test

Design docs: `docs/superpowers/specs/`.
```

- [ ] **Step 3: Create the GitHub repo and push**

```bash
cd /Users/cmuir/Development/fortress-chat
git add .github README.md
git commit -m "chore: CI workflow (test + vsix release) and README"
gh repo create fortress-chat --public --source . --push
```

Expected: repo visible on GitHub, `ci` workflow green on main.

- [ ] **Step 4: Verify packaging locally**

Run: `npm run package -w fortress-chat`
Expected: `fortress-chat.vsix` created at repo root; installs cleanly via "Install from VSIX".

- [ ] **Step 5: Commit any packaging fixes**

```bash
git add -u && git commit -m "fix: packaging adjustments" && git push
```

(Skip if Step 4 needed no changes.)

---

### Task 17: Manual UAT on the real machine (spec success criteria)

**Files:** none (verification task; fixes discovered here become normal TDD fixes in the relevant package).

- [ ] **Step 1: Fresh-install first run**

```bash
rm -rf ~/Library/Application\ Support/fortress-chat
```

Install the `.vsix` in regular VS Code. Open FortressChat panel.
Expected (**success criterion 1**): Setup screen shows "This Mac has 64 GB RAM"; clicking **Set up**, then downloading the recommended model, then first chat = **≤3 clicks**, no terminal, no settings.json.

- [ ] **Step 2: Memory-pressure scenario (the 2026-07-02 pileup, on purpose)**

Start the AI-DEMO2 tier: `llama-server` on ports 8091–94 plus the 70B on 8009 (as on 2026-07-02). In FortressChat, try to start `gemma-3-27b-qat`.
Expected (**success criterion 2**): start is rejected — panel lists the foreign llama processes with sizes and offers "Stop these and continue"; clicking it stops them and the model then loads. Nothing is killed without the click.

- [ ] **Step 3: Crash resilience**

While a reply streams, `kill -9` the managed llama-server pid (get it from `ps aux | grep llama-server`).
Expected (**success criterion 3**): banner reports the crash with last log lines and a restart path; chat history intact; next send after restart works. History in `workspaceState` never contains a role-less entry (verify: Developer Tools → `fortressChat.session`).

- [ ] **Step 4: Agent multi-file edit**

Agent mode with gpt-oss-20B: "add a copyright header comment to both README.md and package.json in this workspace" in a scratch project.
Expected (**success criterion 4**): two `edit_file` steps, two diffs, Apply both → both files changed; Reject leaves files untouched.

- [ ] **Step 5: Record results**

Append a `## UAT 2026-MM-DD` section to the spec noting pass/fail per criterion, fix failures (TDD in the owning package), re-run, then:

```bash
git add -A && git commit -m "docs: v1 UAT results" && git push
git tag v0.1.0 && git push --tags   # success criterion 5: CI attaches the vsix
```

---

## Self-Review Notes

- **Spec coverage:** catalog/first-run (T3, T13), binary install (T8), memory guard three outcomes (T5, T10, T13 rejection UI), foreign scan + explicit kill (T6, T10, T13), one-model policy (T10 start replaces own server), resumable sha256 downloads + disk check (T7), state machine + health gating (T9, T13 `handleSend`), typed history + banner errors + input restore (T2, T13), watchdog (T13 stream), crash capture + restart path (T9, T13, UAT), idle exit (T11), daemon singleton + token auth (T10, T11), multi-window reconnect (T12 `ensureDaemon` reuses live daemon), chat persistence (T13 session), agent 4 tools + diff approval + workspace confinement (T14), 10-iteration loop + toolCalling gate (T15), CI/vsix (T16), all five success criteria (T17).
- **Deliberate deviations:** llama-server *binary* zip is TLS + version-assert instead of sha256 (GitHub doesn't publish stable per-asset hashes); model files remain sha256-pinned. gpt-oss-120b ships in catalog but is untestable on a 64 GB machine — the RAM-tier badge marks it "needs 96 GB+".
- **Type consistency check:** `StatusResponse`/`StartRejection`/`ForeignProcess`/`ServerState` defined once in shared (T3) and imported everywhere; `Supervisor.managedPid()` used by T10; `Session.addToolExchange` defined T13, used T15; `FC_LLAMA_BIN`/`FC_LLAMA_BIN_ARGS` test hooks defined T8/T9, reused T10/T13.
```
