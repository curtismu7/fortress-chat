# M0 + M1 Release & Mac Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship extension v0.1.10 with updated docs and bring the Mac app to parity for Gemini API key support and shared chat UX.

**Architecture:** Extension README/version bump on `fortress-chat` main; Mac `ChatController` ports `ChatViewProvider` Gemini deltas; renderer synced from vendor submodule pin ≥ `f6ee024`.

**Tech Stack:** TypeScript, vitest, Electron (Mac), VS Code extension esbuild/tsc.

## Global Constraints

- OpenRouter remains disabled; Gemini is the only cloud path.
- Secret id: `fortressChat.googleKey` (same on extension + Mac).
- Dual-track: extension merges first, then Mac vendor bump + controller port.

---

### Task 1: Extension M0 — version + README

**Files:**
- Modify: `packages/extension/package.json`
- Modify: `README.md`

- [x] Bump version to `0.1.10`
- [x] Update README: Local + Gemini, remove OpenRouter-first copy
- [ ] Run `npm run build && npm test`
- [ ] Run `npm run package -w fortress-chat` (no shell comments)

---

### Task 2: Mac M1 — Gemini controller port

**Files:**
- Modify: `src/main/secrets.ts` — add `GOOGLE_KEY_ID`
- Modify: `src/main/controller.ts` — google policy, key handler, cloud-without-daemon
- Modify: `test/controller.test.ts` — googleKeySet tests
- Modify: `package.json` — version `0.3.1`
- Bump: `vendor/fortress-code` submodule → `f6ee024` or later

**Controller changes:**
- Import `googleEntries`
- Policy post includes `google: googleEntries()`
- `googleKeySet` / `setGoogleKey` messages
- `targetDeps().googleKey`
- `sanitizeLocalUsOnly` allows `google` provider
- Init tolerates daemon failure when Google key set
- `cloudFallbackStatus` + pushStatus without client
- `unloadLocalModel` on cloud model select

- [x] Implement controller + secrets
- [x] Add tests
- [ ] `npm run sync && npm run build && npm test` in Mac repo
- [ ] Manual: Gemini key → chat without local binary

---

### Task 3: Release smoke

- [ ] Install VSIX 0.1.10
- [ ] Mac DMG or `npm start` smoke
- [ ] Tag / release notes
