# Agent sandbox scenarios

Use these in the **Extension Development Host** with `fixtures/sample-app` open (F5 → **Run Extension (Fixture Workspace)**).

## Setup

1. Open FortressChat sidebar (activity bar icon).
2. Pick any available model (local or OpenRouter). If the daemon is missing, you will see an error banner — some scenarios still work for UI/rules testing.
3. Optional: **Settings (gear) → Index workspace** before `@codebase` tests.

---

## Scenario 1 — Project rules

**Goal:** Confirm `.fortress/rules.md` is injected.

1. Open **Settings (gear) → Project → Open rules file** (or ask in chat).
2. Ask: *“What are the coding rules for this repo?”*
3. **Expected:** Assistant mentions minimal diffs, plain JavaScript, and updating `greeter.test.js` when fixing bugs.

---

## Scenario 2 — Agent fix + undo

**Goal:** Agent edits a file; undo restores checkpoint.

1. Open `src/greeter.js` — note the `loud` branch returns `'HELLO'` without the name.
2. Enable **Agent** mode (composer `+` menu or mode badge).
3. Prompt: *“Fix the bug in greet() when loud is true. Update the test.”*
4. **Expected:** `greet.js` fixed; test updated or passing.
5. Click **Undo last agent run** in settings or the undo control.
6. **Expected:** File reverts to pre-agent snapshot.

---

## Scenario 3 — Debug mode

**Goal:** Debug mode steers toward root-cause analysis.

1. Set mode to **Debug** (composer `+` → Debug).
2. Prompt: *“Why does greet('Ada', { loud: true }) return the wrong string?”*
3. **Expected:** Explanation of the TODO bug without necessarily editing files (unless you ask).

---

## Scenario 4 — @-mentions

**Goal:** File picker and context injection.

1. In the composer, type `@` and pick `greeter.js` or `docs/notes.md`.
2. Ask a question about the attached file.
3. **Expected:** Answer references the selected file content.

---

## Scenario 5 — @codebase (RAG)

**Goal:** Indexed workspace retrieval.

1. **Settings → Project → Index workspace** (wait for completion).
2. Prompt: *“@codebase Where is the intentional bug documented?”*
3. **Expected:** Points to `greeter.js` and/or fixture README.

---

## Scenario 6 — @docs

**Goal:** Document RAG over `docs/`.

1. Index workspace if not already done.
2. Prompt: *“@docs What notes exist in this project?”*
3. **Expected:** Content from `docs/notes.md`.

---

## Scenario 7 — Chat in editor tab

**Goal:** Second webview stays in sync.

1. **Settings → Open chat in editor tab**.
2. Send a message in one view; switch to the other.
3. **Expected:** Both views show the same session (shared provider state).

---

## Scenario 8 — Prompt history

**Goal:** Composer ↑/↓ recalls prior prompts.

1. Send two different messages.
2. Focus the composer, press **↑**.
3. **Expected:** Previous prompt appears; **↓** cycles forward.

---

## Scenario 9 — Hot reload (dev only)

**Goal:** Media edits refresh without full window reload.

1. Run **Run Extension (watch + Fixture)**.
2. Change a visible string in `packages/extension/media/chat.html`.
3. Save.
4. **Expected:** Chat UI updates within ~1s. If not, run **FortressChat: Reload Chat Webview**.

---

## Scenario 10 — E2E parity

**Goal:** Same wiring CI checks.

```bash
npm run test:e2e
```

**Expected:** All assertions pass (webview attach, project rules, editor tab, reload command).
