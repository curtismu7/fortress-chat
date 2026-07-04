# Fortress Code — Developer Mode (Fireworks bypass) design

**Status:** Approved (brainstorming session with Curtis, 2026-07-04)
**Builds on:** `2026-07-03-governance-openrouter-design.md` (Local + OpenRouter governed providers).

## 1. What this is — and the honest caveat

Developer Mode is a **deliberate, opt-in bypass of the US-only governance guard**. When on, the user can enter a **Fireworks AI** API key and chat with **any** Fireworks-hosted model — including non-US ones (e.g. GLM/Zhipu, DeepSeek, Qwen) — without the `assertAllowed` policy check.

This intentionally contradicts the product's default "US-governed, fail-closed" guarantee. Because the repo is **public**, the toggle and bypass code are visible to anyone reading the source, so it is not literally secret. To keep the tool from *misrepresenting* itself, Developer Mode is **loud**: a one-time confirm on first enable and a persistent **"⚠ Developer mode — US-only governance is BYPASSED"** banner while active. The normal governed path is never weakened; the bypass is isolated to one clearly-named function so it stays auditable.

Fireworks AI is itself a US company (Redwood City, CA) with an OpenAI-compatible API; Developer Mode uses it as the transport.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Purpose | Escape hatch that **bypasses** US-only governance (not a governed provider) |
| Transport | Fireworks OpenAI-compatible API: `https://api.fireworks.ai/inference/v1/chat/completions` |
| Trigger | Command `fortress-code.toggleDevMode`, keybinding **`ctrl+alt+m`**, palette title "Fortress Code: Toggle Developer Mode" |
| First-enable | One-time modal confirm: "This bypasses the US-only governance. Continue?" |
| Model input | Small preset list **+ free-text** Fireworks slug |
| Key storage | SecretStorage, id `fortressCode.fireworksKey`; never on disk / never sent to the webview / never committed |
| Visibility | Dev section hidden unless on; persistent red bypass banner + "⚠ DEV" marker when on |
| Persistence | `devMode` flag in extension `globalState` |

## 3. Architecture

Extension-only; no daemon change; the `shared` governance layer is untouched.

- **`extension/src/providers/dev.ts`** — the isolated bypass:
  ```ts
  interface DevTarget { url: string; headers: Record<string,string>; bodyExtra: Record<string,unknown>; model: string }
  function resolveDevTarget(slug: string, key: string): DevTarget
  // url = https://api.fireworks.ai/inference/v1/chat/completions
  // headers.authorization = `Bearer ${key}`, content-type json
  // model = slug, bodyExtra = {}   — NO provider pin, NO assertAllowed
  ```
  It shares `streamChat`/`completeOnce` (they already accept any `{url, headers, bodyExtra, model}` target), so streaming + agent mode work unchanged. `resolveDevTarget` is the single, greppable place governance is skipped.
- **`extension/src/secrets.ts`** — add `getFireworksKey` / `setFireworksKey` (mirrors the OpenRouter key helpers).
- **`extension/src/devPresets.ts`** — the preset list (id + Fireworks slug + label):
  - Llama 3.3 70B — `accounts/fireworks/models/llama-v3p3-70b-instruct`
  - DeepSeek V3 — `accounts/fireworks/models/deepseek-v3`
  - Qwen 2.5 72B — `accounts/fireworks/models/qwen2p5-72b-instruct`
  - Mixtral 8x22B — `accounts/fireworks/models/mixtral-8x22b-instruct`
  - **GLM-5.2 — `accounts/fireworks/models/glm-5p2`** (verified live)
  (Slugs are best-effort; the free-text box is the reliable fallback and download/inference errors surface via the existing error path.)
- **`extension/src/extension.ts`** — register `toggleDevMode`: on first enable show the modal confirm; flip `globalState('fortressCode.devMode')`; notify the provider, which posts `{type:'devMode', on}` to the webview.
- **`extension/src/chat/ChatViewProvider.ts`** — hold `devMode`; on toggle, post state + presets + whether a Fireworks key is set; handle `setFireworksKey` and a `devModel` selection (slug). In `handleSend`, if a dev model is selected **and** devMode is on, build the target via `resolveDevTarget` (bypass) instead of `resolveTarget`; otherwise the normal guarded path is used verbatim.
- **`extension/package.json`** — contribute the command + keybinding.
- **`extension/media/chat.*`** — a Dev section (shown only when `devMode`): the red bypass banner, Fireworks key field, preset `<select>` + free-text input, and a "⚠ DEV" marker in the header when a dev model is active.

## 4. Data flow

`Ctrl+Alt+M` → command → (first time) confirm → toggle `globalState.devMode` → provider posts `{type:'devMode', on}` (+ presets + `fireworksKeySet`) → webview shows/hides the Dev section. User saves the Fireworks key (→ SecretStorage) and picks a preset or types a slug. On send with a dev model selected: `resolveDevTarget(slug, key)` → `streamChat`/`runAgentTurn` → Fireworks. The red bypass banner stays visible the whole time. Turning dev mode off hides the section and restores the governed gallery unchanged.

## 5. Governance isolation (the guarantee)

- `resolveTarget` (the guarded builder) still calls `assertAllowed` first and is unchanged; every Local/OpenRouter send goes through it. The `shared` policy/governance code is not touched.
- The bypass lives only in `resolveDevTarget` and is reachable only when `devMode` is true **and** a dev model is explicitly selected. A grep for `resolveDevTarget` shows the entire bypass surface.
- Turning Developer Mode off returns the tool to fully-governed behavior.

## 6. Testing

- **Unit:** `resolveDevTarget` builds the exact Fireworks request (URL, `Authorization: Bearer <key>`, `model` = slug, empty `bodyExtra`, no `provider` pin) and never imports/calls `assertAllowed`. Confirm the guarded `resolveTarget` still calls `assertAllowed` (unchanged).
- **Manual (UAT):** `Ctrl+Alt+M` → confirm dialog → enter Fireworks key → pick GLM-5.2 → chat → reply streams and the "⚠ Developer mode" banner is visible; toggle off → dev section gone, governed gallery restored; a bad slug shows a surfaced error, not silence.

## 7. Success criteria

1. Developer Mode is off by default; enabling it requires the keybinding/command **and** a one-time confirm.
2. While on, the "governance bypassed" banner is always visible; while off, the tool is fully governed and no dev UI shows.
3. A non-US model (e.g. GLM-5.2) can be used **only** through the dev path; the normal gallery still blocks non-US.
4. The Fireworks key lives only in the OS keychain and never reaches the webview, disk, or git.
5. The bypass is contained to `resolveDevTarget` — the governed `resolveTarget`/`assertAllowed` path is provably unchanged.
