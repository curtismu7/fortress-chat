# FortressChat sample app

Minimal workspace for **Extension Development Host** smoke tests and manual agent/RAG dogfooding.

## What to try

1. Press **F5** → pick **Run Extension (Fixture Workspace)**.
2. Open the FortressChat sidebar and pick a model.
3. Index workspace (**Settings → Project → Index workspace**), then ask with `@codebase`.
4. Enable **Agent** mode and ask it to fix the bug in `src/greeter.js`.
5. See **`AGENT-SANDBOX.md`** for full step-by-step scenarios.

## Intentional bug

`src/greeter.js` — `greet()` drops the name when `loud` is true (for debug-mode testing).

Project rules live in `.fortress/rules.md`. Notes for `@docs` are in `docs/notes.md`.
