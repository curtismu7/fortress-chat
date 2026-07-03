# Fortress Code — Model Governance + OpenRouter (design delta)

**Status:** Approved (brainstorming session with Curtis, 2026-07-03)
**Builds on:** `2026-07-02-fortress-code-design.md` and its implementation plan `../plans/2026-07-02-fortress-code-v1.md` (Tasks 1–12 complete: shared, full manager/daemon backend, extension scaffold).

## 1. Why this delta

The v1 product is fully local (llama.cpp) with a curated US-origin catalog. Two new product requirements change the shape:

1. **Enforced model governance** — users may only add/use **US AI models**; non-US must be blocked, not merely absent.
2. **OpenRouter as a co-equal provider** — a cloud option alongside local, but with non-US models blocked.
3. **A modern UI that is very clear about what each choice requires.**

This delta adds a governance layer and a second provider **on the extension side only**. The manager daemon (Tasks 4–11) is **untouched** and stays local-only.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| OpenRouter positioning | **Two co-equal providers** (Local + OpenRouter). |
| Meaning of "US model" | **US-origin developer AND US inference/hosting.** |
| Control model | **Curated allow-list; users may add, but a US-only check blocks non-US.** |
| OpenRouter enforcement | **Curated model IDs + pin US providers + `allow_fallbacks:false` (fail-closed).** |
| Enforcement site | **Extension enforces; daemon stays local-only.** |
| Allow-list source of truth | **A single governed registry in the `shared` package (code), updated via releases.** |
| OpenRouter privacy UX | **Persistent inline notice** (always-visible amber banner while OpenRouter is active). |
| UI layout | **"One governed gallery"** in the sidebar. |

### 2.1 Honest constraint (must be reflected in UI + docs)

OpenRouter's API exposes **no reliable model-origin or provider-country field**. Therefore "is this model US-origin + US-hosted" **cannot be auto-detected** and is enforced by a **curated allow-list we maintain** (shipped in-app, updated via releases). "Users can add a model" means *enable anything on the curated US-approved list, or request an addition* — pasting an arbitrary non-approved slug is **blocked**. Even when pinned to US providers, prompts transit OpenRouter's infrastructure (a US company) — a genuinely weaker guarantee than local, and the UI must say so.

## 3. Architecture

All new code is in `packages/shared` (policy) and `packages/extension` (providers + UI). No change to `packages/manager`.

### 3.1 `shared` — governed registry + guard

- **`shared/src/policy.ts`** — the single source of truth. It **reuses the existing local `catalog.ts`** (unchanged; the manager still consumes `loadCatalog()`) and adds an OpenRouter-approved list. Exposes `loadPolicy(): PolicyEntry[]` and helpers `localEntries()`, `openRouterEntries()`.

  ```ts
  type Provider = 'local' | 'openrouter';
  interface Origin { org: string; country: 'US'; }        // country is a literal — non-US never constructs
  type Hosting =
    | { kind: 'on-device' }                                 // local
    | { kind: 'openrouter'; usProviders: string[] };        // e.g. ['openai','azure','together','fireworks']
  interface PolicyEntry {
    id: string; displayName: string; provider: Provider; agentCapable: boolean;
    origin: Origin; hosting: Hosting; approved: boolean;
    local?: { catalogId: string };                          // -> existing CatalogModel (memoryBytes, files, ramTier…)
    openrouter?: { slug: string; contextLength: number };
  }
  ```

- **`shared/src/governance.ts`** — pure guard, no I/O:
  ```ts
  class PolicyViolationError extends Error { reason: string }
  function isAllowed(e: PolicyEntry): boolean;
  function assertAllowed(e: PolicyEntry): void;   // throws PolicyViolationError otherwise
  // Rule: e.approved && e.origin.country === 'US'
  //       && (e.provider === 'local' ? e.hosting.kind === 'on-device'
  //                                   : e.hosting.kind === 'openrouter' && e.hosting.usProviders.length > 0)
  ```
  Also `explainBlock(slugOrId): string | null` — returns a plain-language reason for a **known-non-US** slug (e.g. DeepSeek → "China-based developer"), used by the add-model blocked state. Unknown slugs get a generic "not on the US-approved list" message.

### 3.2 `extension` — provider abstraction

- **`extension/src/providers/types.ts`** — a `Provider` interface both implement:
  ```ts
  interface ChatProvider {
    streamChat(entry, messages, onToken, signal): Promise<string>;
    completeOnce(entry, messages, signal): Promise<{content, toolCalls}>;   // agent mode
  }
  ```
- **`extension/src/providers/local.ts`** — refactor of today's `chat/stream.ts` + agent `completeOnce`, targeting the local llama-server endpoint (memory-guarded start unchanged). The existing SSE parse/watchdog logic moves here.
- **`extension/src/providers/openrouter.ts`** — OpenAI-compatible calls to `https://openrouter.ai/api/v1/chat/completions`:
  - `Authorization: Bearer <key>`, `HTTP-Referer`/`X-Title` headers per OpenRouter etiquette.
  - Body includes the fail-closed routing block:
    ```json
    { "model": "<slug>", "messages": [...], "stream": true, "tools": [...],
      "provider": { "only": ["<us providers from entry.hosting.usProviders>"],
                    "allow_fallbacks": false, "data_collection": "deny" } }
    ```
  - Same SSE delta format as local → streaming/watchdog reused.
  - If OpenRouter returns an error (e.g. no pinned US provider can serve) → surfaced as a clear banner (fail closed; we never retry without the pin).
- **`extension/src/providers/index.ts`** — `resolveProvider(entry)` returns the right implementation; every send path calls `assertAllowed(entry)` **before** resolving (defense in depth on top of the UI gate).
- **Key storage:** OpenRouter API key in `context.secrets` (VS Code SecretStorage). Never written to `daemon.json`, workspaceState, or disk in plaintext; only ever sent to `openrouter.ai`.

### 3.3 Enforcement flow (fail-closed)

1. User selects or adds a model → UI calls `assertAllowed(entry)`. A non-approved / non-US entry is **blocked in the UI** with `explainBlock`, and never becomes selectable.
2. On send → `resolveProvider` calls `assertAllowed(entry)` again, then builds the request. Local keeps the existing memory guard; OpenRouter pins US providers with no fallback.
3. Add-model → user picks from the curated OpenRouter-approved list or types a slug; if it is not an `approved` US entry in the registry, **blocked**.

## 4. UI — "one governed gallery" (sidebar webview)

Reworks Task 13's webview. Everything lives in the narrow (~330px) sidebar column.

- **Provider segment toggle** (Local | OpenRouter) at top.
- **Per-provider requirements callout** directly under it:
  - Local: "Runs on this Mac — nothing leaves your machine. Needs RAM + a one-time download."
  - OpenRouter: a **persistent amber banner** (shown whenever OpenRouter is active): *"Cloud — leaves your machine. Prompts & code are sent to OpenRouter (US co.) and pinned to US inference providers only, no fallback. Less private than Local."* Plus an inline API-key field (→ SecretStorage).
- **Model cards** with governance badges: `🇺🇸 US · <vendor>`, `on-device` (local) / `US providers pinned` (OpenRouter), `agent` (if agentCapable), RAM tier (local) or `cloud`. Only `approved` US entries render. Current model marked ✓ ready.
- **"＋ Add model"** always visible → gated form. A blocked add shows: `⛔ Blocked by policy`, a plain-language reason (`explainBlock`), an `✗ non-US origin` badge, the approved US alternatives, and a "request an addition" path.
- **First run** = the same gallery in the local not-installed state (binary install + recommended model per the original §3 first-run), so setup and steady-state share one surface. Success-criterion "≤3 clicks to chatting" from the base spec still holds for the Local path.
- **In-chat**: header shows the active provider + model; for OpenRouter a small persistent `☁️ cloud` indicator remains visible.

Existing chat behaviors from the base spec are unchanged: typed history (errors never appended), banner errors + input restore, streaming watchdog, agent toggle gated on `agentCapable`.

## 5. Security / trust notes

- Governance is enforced by a **curated allow-list**, not runtime detection (see §2.1). The list is the trust anchor; it must be reviewed when models are added.
- **Fail-closed everywhere:** unknown/non-US → blocked; OpenRouter with no serviceable US provider → error, not silent fallback.
- OpenRouter key lives only in the OS keychain. The daemon never sees it.
- Residual trust in OpenRouter (a US company proxying the request) is disclosed in-UI; users who need absolute data residency use Local.

## 6. Impact on the plan

- **Unchanged / done:** Tasks 1–12 (shared catalog, full manager backend, extension scaffold + daemon client). Manager daemon and its tests are not touched.
- **New — shared:** policy registry (`policy.ts`) + governance guard (`governance.ts`) + `explainBlock`, with tests (allow US local, allow approved US OpenRouter, block non-US origin, block unapproved, fail-closed on empty usProviders).
- **New — extension providers:** `types.ts`, `local.ts` (refactor of current stream/complete), `openrouter.ts` (pinning + fail-closed + SSE + tools), `resolveProvider`, SecretStorage key handling; tests for OpenRouter request-shape (correct provider block), 409/error handling, and the governance gate.
- **Reworked — Task 13 webview:** the governed gallery, provider toggle, requirements callouts, persistent OpenRouter banner, model badges, add-model gated flow + blocked state.
- **Generalized — Tasks 14/15:** agent tools unchanged; the agent loop targets the **selected provider** (`resolveProvider`) rather than a hard-coded local endpoint.
- **Task 16:** package/CI unchanged; README documents providers + the governance policy and its honest limits.

## 7. Testing

- **Unit (shared):** `governance` truth table (US local ✓, approved US OpenRouter ✓, non-US origin ✗, unapproved ✗, OpenRouter with empty `usProviders` ✗); `policy` loads and validates; `explainBlock` returns known reasons.
- **Unit (extension):** `openrouter.ts` builds the exact `provider:{only,allow_fallbacks:false,data_collection:'deny'}` block from an entry; auth header set; SSE deltas concatenated; a non-US entry never reaches `fetch` (guard throws first); OpenRouter error → thrown/bannered, no fallback retry.
- **Manual (UAT):** switch providers; enable OpenRouter shows the persistent notice + key prompt; a US OpenRouter model chats; pasting `deepseek/deepseek-chat` is blocked with reason; agent mode works against an OpenRouter tool-capable model.

## 8. Success criteria (additions to the base spec)

1. A non-US model can never be selected or added — the add flow blocks it with a clear, specific reason.
2. Every OpenRouter request carries the US-provider pin with `allow_fallbacks:false`; no request can silently reach a non-US provider.
3. The OpenRouter privacy trade-off is visible whenever OpenRouter is active; the key is stored only in the OS keychain.
4. Local remains the zero-setup, nothing-leaves-the-machine path (base-spec ≤3-clicks criterion intact).
5. Agent mode works identically across both providers for agent-capable models.
