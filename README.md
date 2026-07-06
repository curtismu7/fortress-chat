# Fortress Code

Local + US-governed AI chat and coding agent for VS Code. Run models fully on
your machine via llama.cpp, or use approved US models through OpenRouter — with
a governance policy that blocks any non-US model.

## Providers

- **Local (private):** Google Gemma 3 and OpenAI gpt-oss via llama.cpp. Nothing
  leaves your machine. A memory guard refuses to load a model that won't fit.
- **OpenRouter (cloud):** a curated set of **US-origin** models, pinned to **US
  inference providers with no fallback** (`data_collection: deny`). Prompts
  transit OpenRouter (a US company) — less private than Local; the UI says so.

## Governance

Only US-origin, US-hosted models are selectable or addable. Enforcement is a
curated allow-list maintained in the app (OpenRouter exposes no reliable
origin/country signal, so this cannot be auto-detected). Pasting a non-US model
is blocked with a plain-language reason. See
`docs/superpowers/specs/2026-07-03-governance-openrouter-design.md`.

## Install

Download `fortress-code.vsix` from the latest Release → VS Code Extensions →
Install from VSIX. Requirements: Apple Silicon Mac, macOS 13+, VS Code 1.90+.

## Development

```bash
npm install
npm run build
npm test          # unit tests (vitest, all packages)
npm run test:e2e  # webview + command smoke tests (@vscode/test-electron)
npm run dev       # esbuild watch (alias for npm run watch)
```

**Full harness guide:** [`docs/DEV-HARNESS.md`](docs/DEV-HARNESS.md) — launch configs, hot reload, fixture sandbox, E2E, troubleshooting.

### Extension Development Host (VS Code or Cursor)

1. Open this repo (any git worktree — `.vscode/launch.json` is committed).
2. Run **`Run Extension (Fixture Workspace)`** from Run and Debug (recommended),  
   or **`Run Extension (watch + Fixture)`** for esbuild watch + fixture workspace.
3. A second window opens with `fixtures/sample-app` — dogfood chat, agent, `@codebase`, and project rules there.

| Launch config | Purpose |
|---------------|---------|
| **Run Extension** | Empty window, extension only |
| **Run Extension (Fixture Workspace)** | Opens the sample app workspace |
| **Run Extension (watch + Fixture)** | Fixture + esbuild watch; reload window after TS changes |
| **Extension Tests (E2E smoke)** | Automated webview wiring tests |

**Hot reload:** edits to `packages/extension/media/*` auto-reload the chat webview in dev. TypeScript changes need esbuild watch + **Developer: Reload Window**. Command: **Fortress Code: Reload Chat Webview**.

The fixture includes a bug in `src/greeter.js`, rules in `.fortress/rules.md`, and docs for `@docs` — see `fixtures/sample-app/AGENT-SANDBOX.md` for scenarios.
